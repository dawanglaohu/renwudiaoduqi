import type { EffortTier, EffortValue, EffortVendorMap } from '@agent-scheduler/shared/api/agents';
import type { AssignmentResolutionSource } from '@agent-scheduler/shared/api/runs';
import type { ReviewOverride, WrapupAssignment } from '@agent-scheduler/shared/api/settings';
import { remapEffortAcrossAgents } from './effort-tier.ts';

export type PipelineStage = 'implement' | 'review' | 'rework' | 'bughunt' | 'wrapup' | 'wrapup-fix';

export interface TaskAssignmentValue {
	readonly agentId: string;
	readonly modelName: string | null;
	readonly effortTier: EffortTier | null;
	readonly effortVendor?: string | null;
	readonly source?: AssignmentResolutionSource;
	readonly followedTaskId?: string | null;
	readonly capturedAt?: string;
}

export interface AgentDefaultInfo {
	readonly agentId: string;
	readonly defaultModel?: string | null;
	readonly defaultEffortTier?: EffortValue | null;
	readonly effortVendorMap?: EffortVendorMap | null;
}

export type AgentDefaultsLookup = (agentId: string) => AgentDefaultInfo | null | undefined;

export interface ImplementBodyInput {
	readonly agentId?: string;
	readonly model?: string | null;
	readonly modelName?: string | null;
	readonly effort?: EffortValue | null;
	readonly effortTier?: EffortTier | null;
}

export interface WrapupManualBodyInput {
	readonly agentId?: string;
	readonly model?: string | null;
	readonly modelName?: string | null;
	readonly effort?: EffortValue | null;
	readonly effortTier?: EffortTier | null;
}

export interface FollowAssignmentInfo {
	readonly taskId: string;
	readonly assignment: {
		readonly agentId: string;
		readonly modelName: string | null;
		readonly effortTier: EffortTier | null;
		readonly effortVendor?: string | null;
	};
}

export interface ResolveAssignmentInput {
	readonly stage: PipelineStage;
	readonly body?: ImplementBodyInput | WrapupManualBodyInput | null;
	readonly taskAssignment?: TaskAssignmentValue | null;
	readonly reviewOverride?: ReviewOverride | null;
	readonly wrapupSettings?: WrapupAssignment | null;
	readonly followAssignment?: FollowAssignmentInfo | null;
	readonly agentDefaults?: AgentDefaultsLookup;
	readonly stageOverride?: unknown;
	readonly manualOverride?: unknown;
}

export type AssignmentWarning = 'model_dropped_cross_family' | 'effort_unmappable';

export interface ResolvedAssignment {
	readonly success?: boolean;
	readonly agentId: string;
	readonly modelName: string | null;
	readonly effortTier: EffortTier | null;
	readonly effortVendor?: string | null;
	readonly source: AssignmentResolutionSource;
	readonly followedTaskId?: string | null;
	readonly warnings?: readonly AssignmentWarning[];
	readonly failureReason?: 'follow_source_missing' | null;
}

/**
 * Pure function resolving task assignment across all pipeline stages (AC 1, E-341, E-342, E-344).
 *
 * Rules:
 * 1. Zero dependencies: only imports ./effort-tier.ts and shared contracts.
 * 2. Does not access settings, database, or clock.
 * 3. Covers all six stages exhaustively:
 *    - implement: body -> agent defaults (source: 'task' or 'agent_default' if both model and effort fell back)
 *    - review: reviewOverride -> taskAssignment; cross-family drops model to null ('model_dropped_cross_family')
 *      and remaps effort via remapEffortAcrossAgents (or null + 'effort_unmappable')
 *    - rework / bughunt / wrapup-fix: verbatim taskAssignment (output === input), ignores overrides
 *    - wrapup: manual body -> fixed -> follow; follow_source_missing if follow source missing
 */
export function resolveAssignment(input: ResolveAssignmentInput): ResolvedAssignment {
	const { stage } = input;

	switch (stage) {
		case 'rework':
		case 'bughunt':
		case 'wrapup-fix': {
			// AC 1, AC 3: Verbatim task assignment, zero fallback, ignores stageOverride and manualOverride.
			// Output strictly identity (===) input when taskAssignment is provided.
			if (input.taskAssignment) {
				return input.taskAssignment as unknown as ResolvedAssignment;
			}
			return Object.freeze({
				success: false,
				agentId: '',
				modelName: null,
				effortTier: null,
				effortVendor: null,
				source: 'task',
				followedTaskId: null,
				warnings: Object.freeze([]),
				failureReason: null,
			});
		}

		case 'implement': {
			const body = input.body;
			const agentId = body?.agentId?.trim() ?? '';
			const defaults = agentId && input.agentDefaults ? input.agentDefaults(agentId) : null;

			let modelName: string | null = null;
			let modelDidFallback = false;
			const rawModel =
				body?.model !== undefined
					? body.model
					: body?.modelName !== undefined
						? body.modelName
						: undefined;
			if (rawModel !== undefined && rawModel !== null) {
				modelName = rawModel;
			} else if (defaults?.defaultModel !== undefined && defaults.defaultModel !== null) {
				modelName = defaults.defaultModel;
				modelDidFallback = true;
			} else {
				modelDidFallback = true;
			}

			let effortTier: EffortTier | null = null;
			let effortVendor: string | null = null;
			let effortDidFallback = false;

			const rawEffort =
				body?.effort !== undefined
					? body.effort
					: body?.effortTier !== undefined
						? body.effortTier
							? { tier: body.effortTier }
							: null
						: undefined;
			if (rawEffort !== undefined && rawEffort !== null) {
				if ('tier' in rawEffort && rawEffort.tier) {
					effortTier = rawEffort.tier;
				} else if ('vendor' in rawEffort && rawEffort.vendor) {
					effortVendor = rawEffort.vendor;
				}
			} else if (defaults?.defaultEffortTier !== undefined && defaults.defaultEffortTier !== null) {
				effortDidFallback = true;
				const def = defaults.defaultEffortTier;
				if ('tier' in def && def.tier) {
					effortTier = def.tier;
				} else if ('vendor' in def && def.vendor) {
					effortVendor = def.vendor;
				}
			} else {
				effortDidFallback = true;
			}

			// Decision 124, Decision 129, E-357:
			// Backend returns 'agent_default' only when BOTH model and effort fell back to defaults.
			const source: AssignmentResolutionSource =
				modelDidFallback && effortDidFallback ? 'agent_default' : 'task';

			return Object.freeze({
				success: true,
				agentId,
				modelName,
				effortTier,
				effortVendor,
				source,
				followedTaskId: null,
				warnings: Object.freeze([]),
			});
		}

		case 'review': {
			const taskAssignment = input.taskAssignment;
			const override = input.reviewOverride;

			if (!taskAssignment) {
				return Object.freeze({
					success: false,
					agentId: '',
					modelName: null,
					effortTier: null,
					effortVendor: null,
					source: 'task',
					followedTaskId: null,
					warnings: Object.freeze([]),
					failureReason: null,
				});
			}

			if (!override || !override.agentId || override.agentId.trim().length === 0) {
				// AC 1: No review override -> verbatim task assignment with source: 'task'
				return Object.freeze({
					success: true,
					agentId: taskAssignment.agentId,
					modelName: taskAssignment.modelName,
					effortTier: taskAssignment.effortTier,
					effortVendor: taskAssignment.effortVendor ?? null,
					source: 'task',
					followedTaskId: taskAssignment.followedTaskId ?? null,
					warnings: Object.freeze([]),
				});
			}

			const targetAgentId = override.agentId.trim();
			const sourceAgentId = taskAssignment.agentId.trim();
			const isSameFamily = targetAgentId.toLowerCase() === sourceAgentId.toLowerCase();
			const warnings: AssignmentWarning[] = [];

			let modelName: string | null = null;
			let effortTier: EffortTier | null = null;
			let effortVendor: string | null = null;

			if (isSameFamily) {
				// Same family: inherit task's model and effort unless explicitly overridden
				modelName =
					override.modelName !== undefined ? override.modelName : taskAssignment.modelName;
				if (override.effortTier !== undefined) {
					effortTier = override.effortTier;
					effortVendor = null;
				} else {
					effortTier = taskAssignment.effortTier;
					effortVendor = taskAssignment.effortVendor ?? null;
				}
			} else {
				// Cross family:
				// Model: if explicitly specified in override, use it; otherwise null and warn model_dropped_cross_family (E-342)
				if (
					override.modelName !== undefined &&
					override.modelName !== null &&
					override.modelName.trim().length > 0
				) {
					modelName = override.modelName;
				} else {
					modelName = null;
					warnings.push('model_dropped_cross_family');
				}

				// Effort: if explicitly specified in override, use it
				if (override.effortTier !== undefined) {
					effortTier = override.effortTier;
					effortVendor = null;
				} else {
					// Remap from task assignment using remapEffortAcrossAgents (E-342)
					const taskEffort: EffortValue = taskAssignment.effortTier
						? { tier: taskAssignment.effortTier }
						: taskAssignment.effortVendor
							? { vendor: taskAssignment.effortVendor }
							: null;

					const sourceDefaults = input.agentDefaults?.(sourceAgentId);
					const targetDefaults = input.agentDefaults?.(targetAgentId);

					const remapped = remapEffortAcrossAgents(
						taskEffort,
						sourceAgentId,
						targetAgentId,
						sourceDefaults?.effortVendorMap ?? null,
						targetDefaults?.effortVendorMap ?? null,
					);

					if (remapped.warning === 'effort_unmappable') {
						warnings.push('effort_unmappable');
					}

					if (remapped.effort) {
						if ('tier' in remapped.effort && remapped.effort.tier) {
							effortTier = remapped.effort.tier;
						} else if ('vendor' in remapped.effort && remapped.effort.vendor) {
							effortVendor = remapped.effort.vendor;
						}
					}
				}
			}

			return Object.freeze({
				success: true,
				agentId: targetAgentId,
				modelName,
				effortTier,
				effortVendor,
				source: 'review_override',
				followedTaskId: taskAssignment.followedTaskId ?? null,
				warnings: Object.freeze(warnings),
			});
		}

		case 'wrapup': {
			const manualBody = input.body;
			const wrapupSettings = input.wrapupSettings;
			const follow = input.followAssignment;

			// 1. Manual body override has highest priority
			if (manualBody?.agentId && manualBody.agentId.trim().length > 0) {
				const agentId = manualBody.agentId.trim();
				const modelName = manualBody.model ?? manualBody.modelName ?? null;
				let effortTier: EffortTier | null = null;
				let effortVendor: string | null = null;
				if (manualBody.effortTier !== undefined) {
					effortTier = manualBody.effortTier;
				} else if (manualBody.effort) {
					if ('tier' in manualBody.effort && manualBody.effort.tier) {
						effortTier = manualBody.effort.tier;
					} else if ('vendor' in manualBody.effort && manualBody.effort.vendor) {
						effortVendor = manualBody.effort.vendor;
					}
				}

				return Object.freeze({
					success: true,
					agentId,
					modelName,
					effortTier,
					effortVendor,
					source: 'wrapup_settings',
					followedTaskId: null,
					warnings: Object.freeze([]),
				});
			}

			// 2. Fixed mode from wrapupSettings
			if (wrapupSettings?.mode === 'fixed') {
				const fixedAgentId = wrapupSettings.agentId.trim();
				let modelName =
					wrapupSettings.modelName !== undefined ? wrapupSettings.modelName : undefined;
				let effortTier =
					wrapupSettings.effortTier !== undefined ? wrapupSettings.effortTier : undefined;
				let effortVendor: string | null = null;
				const warnings: AssignmentWarning[] = [];

				// If model or effort is omitted, fall back to follow assignment (E-344)
				if (
					(modelName === undefined ||
						modelName === null ||
						effortTier === undefined ||
						effortTier === null) &&
					follow
				) {
					const isSameFamily =
						fixedAgentId.toLowerCase() === follow.assignment.agentId.trim().toLowerCase();
					if (modelName === undefined || modelName === null) {
						if (isSameFamily) {
							modelName = follow.assignment.modelName;
						} else {
							modelName = null;
							warnings.push('model_dropped_cross_family');
						}
					}
					if (effortTier === undefined || effortTier === null) {
						const followEffort: EffortValue = follow.assignment.effortTier
							? { tier: follow.assignment.effortTier }
							: follow.assignment.effortVendor
								? { vendor: follow.assignment.effortVendor }
								: null;

						const sourceDefaults = input.agentDefaults?.(follow.assignment.agentId);
						const targetDefaults = input.agentDefaults?.(fixedAgentId);

						const remapped = remapEffortAcrossAgents(
							followEffort,
							follow.assignment.agentId,
							fixedAgentId,
							sourceDefaults?.effortVendorMap ?? null,
							targetDefaults?.effortVendorMap ?? null,
						);

						if (remapped.warning === 'effort_unmappable') {
							warnings.push('effort_unmappable');
						}

						if (remapped.effort) {
							if ('tier' in remapped.effort && remapped.effort.tier) {
								effortTier = remapped.effort.tier;
							} else if ('vendor' in remapped.effort && remapped.effort.vendor) {
								effortVendor = remapped.effort.vendor;
							}
						}
					}
				}

				return Object.freeze({
					success: true,
					agentId: fixedAgentId,
					modelName: modelName ?? null,
					effortTier: effortTier ?? null,
					effortVendor,
					source: 'wrapup_settings',
					followedTaskId: follow?.taskId ?? null,
					warnings: Object.freeze(warnings),
				});
			}

			// 3. Follow mode
			if (!follow) {
				return Object.freeze({
					success: false,
					agentId: '',
					modelName: null,
					effortTier: null,
					effortVendor: null,
					source: 'wrapup_settings',
					followedTaskId: null,
					warnings: Object.freeze([]),
					failureReason: 'follow_source_missing',
				});
			}

			return Object.freeze({
				success: true,
				agentId: follow.assignment.agentId,
				modelName: follow.assignment.modelName,
				effortTier: follow.assignment.effortTier,
				effortVendor: follow.assignment.effortVendor ?? null,
				source: 'wrapup_settings',
				followedTaskId: follow.taskId,
				warnings: Object.freeze([]),
			});
		}

		default: {
			const _exhaustive: never = stage;
			throw new Error(`Unhandled pipeline stage: ${_exhaustive}`);
		}
	}
}
