import type { EffortVendorMap } from '@agent-scheduler/shared/api/agents';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { GateSettings, PipelineSettings } from '@agent-scheduler/shared/api/settings';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { vendorEffortDomain } from '../domain/agent-effort-options.ts';
import { assertVendorEffortInDomain } from '../domain/effort-value.ts';
import { DEFAULT_GATE_SETTINGS, isValidGateSettings } from '../domain/gates.ts';
import { isValidPipelineSettings, parsePipelineSettings } from '../domain/pipeline-settings.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import { publishPendingEvents } from '../events/publish-pending.ts';
import type { SettingsRepo } from '../repo/settings.ts';

export interface GateUpdateEffects {
	readonly events: readonly EventEnvelope[];
	readonly afterCommit?: () => Promise<void>;
}

export interface SettingsServiceDeps {
	readonly settingsRepo: SettingsRepo;
	readonly clock: { readonly now: () => string };
	readonly bus: EventBus;
	readonly envelopeFactory: EnvelopeFactory;
	readonly unitOfWork: UnitOfWork;
	readonly warn?: (message: string, ...args: unknown[]) => void;
	readonly nudgeTick?: () => void;
	readonly getVendorEffortDomain?: (agentId: string) => readonly string[];
	readonly modelEffortOptions?: (
		agentId: string,
		modelName: string | null,
	) => readonly string[] | undefined;
	readonly agentRegistry?: {
		readonly getSnapshot: () => {
			readonly agents: Readonly<
				Record<
					string,
					{ readonly effortVendorMap?: EffortVendorMap | null; readonly adapterKind?: string }
				>
			>;
		};
	};
	/**
	 * Runs inside the same `unitOfWork.run` as the settings write (08 节：一个 HTTP 请求最多开一次
	 * 事务，跨 service 的复合写必须聚进同一个 run)。Must not open a transaction of its own and
	 * must not publish; returns events and optional cleanup for the caller to await after commit.
	 */
	readonly onGatesUpdated?: (
		newGates: GateSettings,
		previousGates: GateSettings,
		actorDeviceId: string | null,
	) => GateUpdateEffects;
}

export type PipelineSettingsSummary = PipelineSettings;

export interface SettingsService {
	readonly getGates: () => GateSettings;
	readonly updateGates: (input: unknown, actorDeviceId: string | null) => Promise<GateSettings>;
	readonly getPipeline: () => PipelineSettings;
	readonly updatePipeline: (input: unknown, actorDeviceId: string | null) => PipelineSettings;
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
	const logWarn =
		deps.warn ??
		((message: string, ...args: unknown[]) => {
			console.warn(`[settings] ${message}`, ...args);
		});

	return Object.freeze({
		/**
		 * Retrieves gate settings (E-292):
		 * - If row missing: returns built-in default `{dispatch: 'auto', review: 'manual', landing: 'manual'}` without inserting.
		 * - If value_json is invalid/corrupted: logs warning and falls back to default without overwriting corrupted row.
		 */
		getGates(): GateSettings {
			const row = deps.settingsRepo.get('gates');
			if (!row) {
				return DEFAULT_GATE_SETTINGS;
			}

			try {
				const parsed = JSON.parse(row.value_json);
				if (isValidGateSettings(parsed)) {
					return Object.freeze({
						dispatch: parsed.dispatch,
						review: parsed.review,
						landing: parsed.landing,
					});
				}
				logWarn(
					`Settings row for key='gates' contains invalid fields: ${row.value_json}. Falling back to default.`,
				);
				return DEFAULT_GATE_SETTINGS;
			} catch (cause) {
				logWarn(
					`Settings row for key='gates' has corrupted JSON: ${row.value_json}. Falling back to default.`,
					cause,
				);
				return DEFAULT_GATE_SETTINGS;
			}
		},

		/**
		 * Updates gate settings (E-292, AC 1, AC 2, E-56):
		 * - Requires all three fields ('dispatch', 'review', 'landing') present and strictly 'auto' | 'manual'.
		 * - Rejects missing fields or invalid values with E_VALIDATION.
		 * - Persists atomically in a transaction.
		 * - Emits `settings.gates_changed` event after transaction commits.
		 * - Triggers re-evaluation of waiting gates for changed kinds without restarting batches (E-56).
		 */
		async updateGates(input: unknown, actorDeviceId: string | null): Promise<GateSettings> {
			if (!isValidGateSettings(input)) {
				throw new AppError(
					'E_VALIDATION',
					'Invalid gate settings: all three fields (dispatch, review, landing) must be provided with value "auto" or "manual".',
				);
			}

			const previous = this.getGates();
			const updated: GateSettings = Object.freeze({
				dispatch: input.dispatch,
				review: input.review,
				landing: input.landing,
			});

			const valueJson = JSON.stringify(updated);
			const now = deps.clock.now();
			const pendingEvents: EventEnvelope[] = [];
			let effects: GateUpdateEffects | undefined;

			// Strictly respect transaction boundary: DB writes inside one transaction, every event
			// published only after it returns. The gate re-evaluation (R2, E-56) shares this run.
			deps.unitOfWork.run(() => {
				deps.settingsRepo.set('gates', valueJson, now);
				effects = deps.onGatesUpdated?.(updated, previous, actorDeviceId);
				pendingEvents.push(...(effects?.events ?? []));
				pendingEvents.push(
					deps.envelopeFactory.createEnvelope({
						kind: 'settings.gates_changed',
						actorDeviceId,
						payload: {
							gates: updated,
						},
					}),
				);
			});

			try {
				publishPendingEvents(pendingEvents, deps);
			} finally {
				await effects?.afterCommit?.();
			}

			return updated;
		},

		/**
		 * Safe reader for pipeline settings (M7-T8, M8-T8, E-318, E-356):
		 * - Returns built-in default `{bughunt: 0, wrapupMode: 'auto'}` when row is absent or invalid without inserting.
		 * - Warns on corrupted/invalid values without overwriting the row.
		 */
		getPipeline(): PipelineSettings {
			const row = deps.settingsRepo.get('pipeline');
			return parsePipelineSettings(row?.value_json, logWarn);
		},

		/**
		 * Updates pipeline settings (AC 5, E-318, E-356):
		 * - Rejects missing fields or invalid values or additional properties with E_VALIDATION.
		 * - Validates reviewOverride.agentId and wrapupAssignment.agentId against agent registry snapshot without spawning.
		 * - Validates effortTier against agent's effort support (reason: 'effort_unsupported' if unsupported).
		 * - Atomically persists in single transaction.
		 * - Emits `settings.pipeline_changed` event with full 4 keys after transaction.
		 * - Triggers nudgeTick after transaction.
		 */
		updatePipeline(input: unknown, actorDeviceId: string | null): PipelineSettings {
			if (!isValidPipelineSettings(input)) {
				throw new AppError(
					'E_VALIDATION',
					'Invalid pipeline settings: all fields (bughunt, wrapupMode, reviewOverride, wrapupAssignment) must be provided with no additional properties.',
				);
			}

			if (deps.agentRegistry) {
				const snapshot = deps.agentRegistry.getSnapshot();

				if (input.reviewOverride) {
					const agent = snapshot.agents[input.reviewOverride.agentId];
					if (!agent) {
						throw new AppError(
							'E_VALIDATION',
							`Agent '${input.reviewOverride.agentId}' does not exist in registry.`,
							{
								details: { field: 'reviewOverride.agentId' },
							},
						);
					}
					if (
						input.reviewOverride.effortTier != null ||
						input.reviewOverride.effortVendor != null
					) {
						if (agent.effortVendorMap === null) {
							throw new AppError(
								'E_VALIDATION',
								`Agent '${input.reviewOverride.agentId}' does not support reasoning effort.`,
								{
									details: { field: 'reviewOverride.effortTier', reason: 'effort_unsupported' },
								},
							);
						}
					}
					if (input.reviewOverride.effortVendor) {
						assertVendorEffortInDomain(
							input.reviewOverride.effortVendor,
							deps.getVendorEffortDomain?.(input.reviewOverride.agentId) ??
								vendorEffortDomain(input.reviewOverride.agentId, agent),
							'reviewOverride.effortVendor',
						);
					}
				}

				if (input.wrapupAssignment.mode === 'fixed') {
					const agent = snapshot.agents[input.wrapupAssignment.agentId];
					if (!agent) {
						throw new AppError(
							'E_VALIDATION',
							`Agent '${input.wrapupAssignment.agentId}' does not exist in registry.`,
							{
								details: { field: 'wrapupAssignment.agentId' },
							},
						);
					}
					if (
						input.wrapupAssignment.effortTier != null ||
						input.wrapupAssignment.effortVendor != null
					) {
						if (agent.effortVendorMap === null) {
							throw new AppError(
								'E_VALIDATION',
								`Agent '${input.wrapupAssignment.agentId}' does not support reasoning effort.`,
								{
									details: { field: 'wrapupAssignment.effortTier', reason: 'effort_unsupported' },
								},
							);
						}
					}
					if (input.wrapupAssignment.effortVendor) {
						assertVendorEffortInDomain(
							input.wrapupAssignment.effortVendor,
							deps.getVendorEffortDomain?.(input.wrapupAssignment.agentId) ??
								vendorEffortDomain(input.wrapupAssignment.agentId, agent),
							'wrapupAssignment.effortVendor',
						);
					}
				}
			}

			const updated: PipelineSettings = Object.freeze({
				bughunt: input.bughunt,
				wrapupMode: input.wrapupMode,
				reviewOverride: input.reviewOverride
					? Object.freeze({
							...input.reviewOverride,
							...(deps.modelEffortOptions?.(
								input.reviewOverride.agentId,
								input.reviewOverride.modelName ?? null,
							)?.length === 0
								? { effortTier: null, effortVendor: null }
								: {}),
						})
					: null,
				wrapupAssignment: Object.freeze({
					...input.wrapupAssignment,
					...(input.wrapupAssignment.mode === 'fixed' &&
					deps.modelEffortOptions?.(
						input.wrapupAssignment.agentId,
						input.wrapupAssignment.modelName ?? null,
					)?.length === 0
						? { effortTier: null, effortVendor: null }
						: {}),
				}),
			});

			const valueJson = JSON.stringify(updated);
			const now = deps.clock.now();

			const envelope = deps.unitOfWork.run(() => {
				deps.settingsRepo.set('pipeline', valueJson, now);
				return deps.envelopeFactory.createEnvelope({
					kind: 'settings.pipeline_changed',
					actorDeviceId,
					payload: {
						pipeline: updated,
					},
				});
			});

			deps.bus.publish(envelope);
			deps.nudgeTick?.();

			return updated;
		},
	});
}
