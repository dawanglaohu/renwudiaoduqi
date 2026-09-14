import type {
	AgentEntryDto,
	ListAgentModelsResponse,
	UpdateAgentBody,
} from '@agent-scheduler/shared/api/agents';
import { readClaudeModels } from '../adapters/claude/read-models.ts';
import { readCodexModels } from '../adapters/codex/read-models.ts';
import { readDshModels } from '../adapters/dsh/read-models.ts';
import { runDshSmokeTest } from '../adapters/dsh/smoke.ts';
import { readGrokModels } from '../adapters/grok/read-models.ts';
import { readPiModels } from '../adapters/pi/read-models.ts';
import {
	type CommandRunnerParams,
	type CommandRunnerResult,
	type FingerprintCache,
	type ProbeAgentResult,
	type ProbeStatus,
	createFingerprintCache,
	probeAgent,
} from '../adapters/probe.ts';
import { BUILT_IN_AGENT_IDS, type ResolvedAgentConfig } from '../config/defaults.ts';
import type { AgentRegistry, AgentRegistryFileSystem } from '../config/registry.ts';
import { isPermissionTier } from '../domain/permission-tier.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { ExecutableFileSystem, PlatformHostInputs } from '../platform/contract.ts';
import type { spawnManaged } from '../proc/spawn.ts';

export type AgentAvailabilityStatus = ProbeStatus | 'disabled';

export interface AgentAvailabilityState {
	readonly agentId: string;
	readonly isAvailable: boolean;
	readonly canDispatch: boolean;
	readonly status: AgentAvailabilityStatus;
	readonly versionString: string;
	readonly resolvedPath?: string;
	readonly unavailableReason?: string;
	readonly unavailableCode?: string;
	readonly missingRequirements?: readonly string[];
	readonly errorDetails?: {
		readonly code: string;
		readonly observed?: string;
		readonly expected?: string;
		readonly execPath?: string;
		readonly checkedPaths?: readonly string[];
		readonly reason?: string;
		readonly originalPath?: string;
		readonly resolvedPath?: string;
	};
	readonly warningBanner?: {
		readonly code: string;
		readonly message: string;
		readonly details?: unknown;
	};
	readonly probedAt: string;
	readonly generation: number;
}

export interface AgentServiceDeps {
	readonly registry: AgentRegistry;
	readonly hostInputs: PlatformHostInputs;
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly fileSystem?: ExecutableFileSystem & Partial<AgentRegistryFileSystem>;
	readonly cache?: FingerprintCache;
	readonly commandRunner?: (params: CommandRunnerParams) => Promise<CommandRunnerResult>;
	readonly spawnManagedFn?: typeof spawnManaged;
	readonly clock?: { readonly now: () => string };
	readonly env?: Record<string, string>;
	readonly hasInFlightRuns?: (agentId: string) => boolean | Promise<boolean>;
}

export interface AgentService {
	readonly registry: AgentRegistry;
	start(): Promise<void>;
	stop(): void;
	listAgents(): Promise<readonly AgentEntryDto[]>;
	getAgent(agentId: string): Promise<AgentEntryDto | undefined>;
	updateAgent(agentId: string, updates: UpdateAgentBody): Promise<AgentEntryDto>;
	probeAgent(
		agentId: string,
		options?: { readonly force?: boolean; readonly userConfirmedCandidate?: string },
	): Promise<ProbeAgentResult>;
	probeAll(options?: { readonly force?: boolean }): Promise<
		Readonly<Record<string, AgentAvailabilityState>>
	>;
	listAgentModels(
		agentId: string,
		options?: { readonly refresh?: boolean },
	): Promise<ListAgentModelsResponse>;
	assertCanDispatch(agentId: string): Promise<void>;
	getAvailability(agentId: string): AgentAvailabilityState | undefined;
}

const AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
	[BUILT_IN_AGENT_IDS.CODEX]: 'Codex',
	[BUILT_IN_AGENT_IDS.CLAUDE]: 'Claude Code',
	[BUILT_IN_AGENT_IDS.PI]: 'Pi Agent',
	[BUILT_IN_AGENT_IDS.GROK]: 'Grok CLI',
	[BUILT_IN_AGENT_IDS.DSH]: 'DeepSeek Harness',
});

function getAgentDisplayName(agentId: string): string {
	return AGENT_DISPLAY_NAMES[agentId] ?? agentId;
}

export function createAgentService(deps: AgentServiceDeps): AgentService {
	const clock = deps.clock ?? Object.freeze({ now: () => new Date().toISOString() });
	const cache = deps.cache ?? createFingerprintCache();
	const availabilityMap = new Map<string, AgentAvailabilityState>();

	if (typeof deps.registry.onReload === 'function') {
		deps.registry.onReload(() => {
			void probeAll({ force: true });
		});
	}

	let initializationPromise: Promise<Readonly<Record<string, AgentAvailabilityState>>> | null =
		null;

	function toAgentEntryDto(
		agentId: string,
		config: ResolvedAgentConfig,
		state?: AgentAvailabilityState,
	): AgentEntryDto {
		const isAvailable = state?.isAvailable ?? false;
		return Object.freeze({
			id: agentId,
			name: getAgentDisplayName(agentId),
			monogram: config.monogram,
			isAvailable,
			defaultModel: config.defaultModel ?? null,
			maxConcurrency: config.maxConcurrency,
			permissionTier: config.permissionTier,
			execPath: config.execPath.length > 0 ? config.execPath : null,
			unavailableReason: isAvailable ? null : (state?.unavailableReason ?? 'Not detected'),
			unavailableCode: isAvailable ? null : (state?.unavailableCode ?? 'E_AGENT_UNAVAILABLE'),
			missingRequirements: state?.missingRequirements ?? Object.freeze([]),
			errorDetails: state?.errorDetails,
			warningBanner: state?.warningBanner,
		});
	}

	async function probeSingleAgent(
		agentId: string,
		config: ResolvedAgentConfig,
		options: {
			readonly force?: boolean;
			readonly userConfirmedCandidate?: string;
		} = {},
	): Promise<{ readonly probeResult: ProbeAgentResult; readonly state: AgentAvailabilityState }> {
		const now = clock.now();
		const generation = deps.registry.getSnapshot().generation;

		// Check if disabled by concurrency (E-91)
		if (config.maxConcurrency <= 0) {
			const state: AgentAvailabilityState = Object.freeze({
				agentId,
				isAvailable: false,
				canDispatch: false,
				status: 'disabled',
				versionString: '',
				unavailableReason: 'Agent is disabled (maxConcurrency <= 0)',
				unavailableCode: 'E_AGENT_UNAVAILABLE',
				missingRequirements: Object.freeze(['Concurrency greater than 0']),
				probedAt: now,
				generation,
			});
			const probeResult: ProbeAgentResult = Object.freeze({
				ok: false,
				status: 'not-found',
				agentId,
				canDispatch: false,
				matched: false,
				versionString: '',
				isCustomPath: false,
				errorDetails: Object.freeze({
					code: 'E_AGENT_UNAVAILABLE',
					reason: 'disabled',
				}),
			});
			return { probeResult, state };
		}

		if (options.force && cache && config.execPath) {
			cache.delete(config.execPath);
		}

		let probeResult: ProbeAgentResult;
		try {
			probeResult = await probeAgent({
				agentId,
				config,
				hostInputs: deps.hostInputs,
				fileSystem: deps.fileSystem,
				cache: options.force ? undefined : cache,
				commandRunner: deps.commandRunner,
				spawnManagedFn: deps.spawnManagedFn,
				nowIso: now,
				env: deps.env,
				userConfirmedCandidate: options.userConfirmedCandidate,
				versionRange: config.versionRange,
			});
		} catch (error) {
			// Probe failure must never crash or block other agents (E-88)
			const err =
				error instanceof AppError ? error : new AppError('E_AGENT_UNAVAILABLE', String(error));
			probeResult = Object.freeze({
				ok: false,
				status: 'not-found',
				agentId,
				canDispatch: false,
				matched: false,
				versionString: '',
				isCustomPath: false,
				errorDetails: Object.freeze({
					code: err.code,
					reason: err.message,
				}),
			});
		}

		// R3 & E-191 & E-28: dsh smoke test verification before enablement
		const smokeCommandRunner = deps.commandRunner;
		if (
			agentId === BUILT_IN_AGENT_IDS.DSH &&
			probeResult.canDispatch &&
			smokeCommandRunner !== undefined
		) {
			const runCommand: NonNullable<typeof smokeCommandRunner> = smokeCommandRunner;
			const runner = async (params: {
				file: string;
				args: readonly string[];
				cwd: string;
				timeoutMs?: number;
				env?: Readonly<Record<string, string | undefined>>;
			}) => {
				const cleanEnv: Record<string, string> = {};
				if (params.env) {
					for (const [k, v] of Object.entries(params.env)) {
						if (v !== undefined) cleanEnv[k] = v;
					}
				}
				const res = await runCommand({
					file: params.file,
					args: params.args,
					cwd: params.cwd,
					timeoutMs: params.timeoutMs ?? 10_000,
					env: Object.keys(cleanEnv).length > 0 ? cleanEnv : undefined,
				});
				return {
					ok: res.ok,
					exitCode: res.exitCode,
					stdout: res.stdout,
					stderr: res.stderr,
					timedOut: res.timedOut,
				};
			};

			const smokeResult = await runDshSmokeTest({
				execPath: probeResult.resolvedPath ?? config.execPath,
				cwd: deps.hostInputs.homedir,
				runner,
			});

			if (!smokeResult.ok) {
				probeResult = Object.freeze({
					...probeResult,
					ok: false,
					status: 'warning',
					canDispatch: false,
					matched: false,
					errorDetails: Object.freeze({
						code: 'E_AGENT_UNAVAILABLE',
						reason: smokeResult.reason ?? 'dsh smoke test failed',
						execPath: probeResult.resolvedPath ?? config.execPath,
					}),
					warningBanner: Object.freeze({
						code: 'E_AGENT_UNAVAILABLE',
						message: smokeResult.reason ?? 'dsh smoke test failed',
					}),
				});
			}
		}

		// Map ProbeAgentResult to AgentAvailabilityState
		let isAvailable = false;
		let canDispatch = false;
		let unavailableReason: string | undefined;
		let unavailableCode: string | undefined;
		const missingRequirements: string[] = [];

		if (probeResult.status === 'matched') {
			isAvailable = true;
			canDispatch = true;
		} else if (probeResult.status === 'warning') {
			// Custom user-entered path with warning banner (E-199 / E-88)
			const code =
				probeResult.warningBanner?.code ?? probeResult.errorDetails?.code ?? 'E_AGENT_UNAVAILABLE';
			unavailableCode = code;
			unavailableReason =
				probeResult.warningBanner?.message ??
				probeResult.errorDetails?.reason ??
				'Configured executable path is not usable.';

			if (code === 'E_AGENT_EXEC_NOT_EXECUTABLE') {
				isAvailable = false;
				canDispatch = false;
				missingRequirements.push('Execute permission on executable file (X_OK)');
			} else if (code === 'E_AGENT_EXEC_INVALID_TARGET') {
				isAvailable = false;
				canDispatch = false;
				missingRequirements.push('Valid regular file target');
			} else if (code === 'E_AGENT_EXEC_NOT_FOUND') {
				isAvailable = false;
				canDispatch = false;
				missingRequirements.push('Valid executable path');
			} else if (code === 'E_AGENT_VERSION_UNRECOGNIZED') {
				if (probeResult.matched) {
					// Version recognized by pattern but outside expected range (E-194): allow enablement with warning banner
					isAvailable = true;
					canDispatch = true;
					unavailableCode = undefined;
					unavailableReason = undefined;
				} else {
					// Version mismatch on custom binary
					isAvailable = false;
					canDispatch = false;
					missingRequirements.push(
						`Compatible version matching pattern "${config.versionFingerprint.expectedPattern}"`,
					);
				}
			} else if (code === 'E_AGENT_UNAVAILABLE') {
				// dsh smoke test contract failure (E-191): the executable resolves, the run contract does not
				isAvailable = false;
				canDispatch = false;
				missingRequirements.push('Passing the dsh headless smoke test contract');
			} else {
				isAvailable = false;
				canDispatch = false;
				missingRequirements.push('Valid executable file');
			}
		} else if (probeResult.status === 'not-found') {
			isAvailable = false;
			canDispatch = false;
			const code = probeResult.errorDetails?.code ?? 'E_AGENT_EXEC_NOT_FOUND';
			unavailableCode = code;
			if (code === 'E_AGENT_EXEC_NOT_EXECUTABLE') {
				unavailableReason = 'The executable file does not have execute permission (X_OK).';
				missingRequirements.push('Execute permission on executable file (X_OK)');
			} else if (code === 'E_AGENT_EXEC_INVALID_TARGET') {
				unavailableReason =
					'The executable path does not resolve to a regular file (invalid symlink target).';
				missingRequirements.push('Valid regular file target');
			} else {
				unavailableReason =
					'Agent executable was not found in PATH or platform candidate locations.';
				missingRequirements.push('Executable file on PATH or configured path');
			}
		} else if (probeResult.status === 'unrecognized') {
			isAvailable = false;
			canDispatch = false;
			unavailableCode = 'E_AGENT_VERSION_UNRECOGNIZED';
			unavailableReason =
				'Agent version output did not match expected fingerprint; manual path configuration required.';
			missingRequirements.push(
				`Compatible version matching pattern "${config.versionFingerprint.expectedPattern}"`,
			);
		} else if (probeResult.status === 'requires-confirmation') {
			isAvailable = false;
			canDispatch = false;
			unavailableCode = 'E_VALIDATION';
			unavailableReason =
				'Multiple candidate executables were found on PATH; manual confirmation is required.';
			missingRequirements.push('User selection among multiple candidates');
		} else if (probeResult.status === 'invalid-platform-path') {
			isAvailable = false;
			canDispatch = false;
			unavailableCode = 'E_AGENT_EXEC_INVALID_TARGET';
			unavailableReason =
				'Configured executable path format is invalid for current operating system.';
			missingRequirements.push('Native path format for current platform');
		}

		const state: AgentAvailabilityState = Object.freeze({
			agentId,
			isAvailable,
			canDispatch,
			status: probeResult.status,
			versionString: probeResult.versionString,
			resolvedPath: probeResult.resolvedPath,
			unavailableReason,
			unavailableCode,
			missingRequirements: Object.freeze(missingRequirements),
			errorDetails: probeResult.errorDetails
				? Object.freeze({
						code: probeResult.errorDetails.code,
						observed: probeResult.errorDetails.observed,
						expected: probeResult.errorDetails.expected,
						execPath: probeResult.errorDetails.execPath ?? probeResult.resolvedPath,
						checkedPaths: probeResult.errorDetails.checkedPaths,
						reason: probeResult.errorDetails.reason,
						originalPath: probeResult.errorDetails.originalPath,
						resolvedPath: probeResult.errorDetails.resolvedPath ?? probeResult.resolvedPath,
					})
				: undefined,
			warningBanner: probeResult.warningBanner
				? Object.freeze({
						code: probeResult.warningBanner.code,
						message: probeResult.warningBanner.message,
						details: probeResult.warningBanner.details,
					})
				: undefined,
			probedAt: now,
			generation,
		});

		return { probeResult, state };
	}

	function recordAndPublishAvailability(agentId: string, state: AgentAvailabilityState): void {
		const prev = availabilityMap.get(agentId);
		availabilityMap.set(agentId, state);

		const prevAvailable = prev?.isAvailable;
		const prevCode = prev?.unavailableCode;
		const isFirst = prev === undefined;
		const changed =
			isFirst || prevAvailable !== state.isAvailable || prevCode !== state.unavailableCode;

		if (changed && deps.bus && deps.envelopeFactory) {
			const envelope = deps.envelopeFactory.createEnvelope({
				kind: 'agent.availability_changed',
				payload: {
					agentId,
					available: state.isAvailable,
					reason: state.unavailableReason ?? state.status,
					vendor: {
						status: state.status,
						code: state.unavailableCode,
						execPath: state.resolvedPath,
						versionString: state.versionString,
					},
				},
			});
			deps.bus.publish(envelope);
		}
	}

	async function probeAll(
		options: { readonly force?: boolean } = {},
	): Promise<Readonly<Record<string, AgentAvailabilityState>>> {
		const snapshot = deps.registry.getSnapshot();
		const entries = Object.entries(snapshot.agents);

		const results = await Promise.allSettled(
			entries.map(async ([agentId, config]) => {
				const { state } = await probeSingleAgent(agentId, config, options);
				recordAndPublishAvailability(agentId, state);
				return [agentId, state] as const;
			}),
		);

		const resultMap: Record<string, AgentAvailabilityState> = {};
		for (const res of results) {
			if (res.status === 'fulfilled') {
				const [agentId, state] = res.value;
				resultMap[agentId] = state;
			}
		}
		return Object.freeze(resultMap);
	}

	async function ensureInitialized(): Promise<void> {
		if (!initializationPromise) {
			initializationPromise = probeAll();
		}
		await initializationPromise;
	}

	async function start(): Promise<void> {
		await deps.registry.start();
		if (!initializationPromise) {
			initializationPromise = probeAll();
		}
		await initializationPromise;
	}

	function stop(): void {
		deps.registry.stop();
		initializationPromise = null;
		cache.clear();
	}

	async function listAgents(): Promise<readonly AgentEntryDto[]> {
		await ensureInitialized();
		const snapshot = deps.registry.getSnapshot();
		for (const [agentId, config] of Object.entries(snapshot.agents)) {
			const state = availabilityMap.get(agentId);
			if (!state || state.generation !== snapshot.generation) {
				const { state: refreshedState } = await probeSingleAgent(agentId, config, { force: true });
				recordAndPublishAvailability(agentId, refreshedState);
			}
		}
		const result: AgentEntryDto[] = [];
		for (const [agentId, config] of Object.entries(snapshot.agents)) {
			const state = availabilityMap.get(agentId);
			result.push(toAgentEntryDto(agentId, config, state));
		}
		return Object.freeze(result);
	}

	async function getAgent(agentId: string): Promise<AgentEntryDto | undefined> {
		await ensureInitialized();
		const snapshot = deps.registry.getSnapshot();
		const config = snapshot.agents[agentId];
		if (!config) return undefined;
		let state = availabilityMap.get(agentId);
		if (!state || state.generation !== snapshot.generation) {
			const { state: refreshedState } = await probeSingleAgent(agentId, config, { force: true });
			recordAndPublishAvailability(agentId, refreshedState);
			state = refreshedState;
		}
		return toAgentEntryDto(agentId, config, state);
	}

	async function probeAgentMethod(
		agentId: string,
		options: { readonly force?: boolean; readonly userConfirmedCandidate?: string } = {},
	): Promise<ProbeAgentResult> {
		await ensureInitialized();
		const snapshot = deps.registry.getSnapshot();
		const config = snapshot.agents[agentId];
		if (!config) {
			throw new AppError('E_NOT_FOUND', `Agent '${agentId}' is not registered in agent registry.`);
		}

		const { probeResult, state } = await probeSingleAgent(agentId, config, options);
		recordAndPublishAvailability(agentId, state);
		return probeResult;
	}

	async function updateAgent(agentId: string, updates: UpdateAgentBody): Promise<AgentEntryDto> {
		await ensureInitialized();
		const snapshot = deps.registry.getSnapshot();
		const config = snapshot.agents[agentId];
		if (!config) {
			throw new AppError('E_NOT_FOUND', `Agent '${agentId}' is not registered.`);
		}

		// Validate monogram uniqueness (E-183)
		if (updates.monogram !== undefined) {
			const targetMonogram = updates.monogram.toLowerCase();
			for (const [otherId, otherConfig] of Object.entries(snapshot.agents)) {
				if (otherId !== agentId && otherConfig.monogram.toLowerCase() === targetMonogram) {
					throw new AppError(
						'E_VALIDATION',
						`Monogram '${updates.monogram}' is already in use by agent '${otherId}'.`,
						{
							details: {
								agentId,
								field: 'monogram',
								monogram: updates.monogram,
								peerAgentId: otherId,
							},
						},
					);
				}
			}
		}

		// Validate permission tier
		if (updates.permissionTier !== undefined && !isPermissionTier(updates.permissionTier)) {
			throw new AppError(
				'E_VALIDATION',
				`Invalid permission tier: '${updates.permissionTier}'. Must be one of 'readOnly', 'workspaceWrite', 'unrestricted'.`,
				{ details: { agentId, field: 'permissionTier', permissionTier: updates.permissionTier } },
			);
		}

		// Validate adapterKind switch requires no in-flight runs (AC 8, E-189)
		const candidateAdapterKind = (updates as { adapterKind?: unknown }).adapterKind;
		if (candidateAdapterKind !== undefined && candidateAdapterKind !== config.adapterKind) {
			if (deps.hasInFlightRuns) {
				const inFlight = await deps.hasInFlightRuns(agentId);
				if (inFlight) {
					throw new AppError(
						'E_VALIDATION',
						`Cannot switch adapterKind for agent '${agentId}' while runs are in flight.`,
						{ details: { agentId, field: 'adapterKind' } },
					);
				}
			}
		}

		// Update overrides via registry (R2)
		const updateResult = await deps.registry.updateOverrides(agentId, updates);
		if (!updateResult.ok) {
			throw new AppError('E_VALIDATION', updateResult.message, {
				details: updateResult.details ?? { agentId },
			});
		}
		if (updateResult.reload.status === 'rejected') {
			throw new AppError('E_VALIDATION', 'Agent configuration update was rejected by registry.', {
				details: { agentId },
			});
		}

		// Re-probe agent (force bypass cache)
		await probeAgentMethod(agentId, { force: true });

		const updatedAgent = await getAgent(agentId);
		if (!updatedAgent) {
			throw new AppError('E_INTERNAL', `Failed to retrieve updated agent '${agentId}'.`);
		}
		return updatedAgent;
	}

	async function listAgentModels(
		agentId: string,
		_options: { readonly refresh?: boolean } = {},
	): Promise<ListAgentModelsResponse> {
		await ensureInitialized();
		const snapshot = deps.registry.getSnapshot();
		const config = snapshot.agents[agentId];
		if (!config) {
			throw new AppError('E_NOT_FOUND', `Agent '${agentId}' is not registered in agent registry.`);
		}
		const state = availabilityMap.get(agentId);
		if (!state || !state.isAvailable) {
			throw new AppError(
				'E_AGENT_UNAVAILABLE',
				`Agent '${agentId}' is unavailable (${state?.unavailableReason ?? 'not detected'}).`,
				{ details: { agentId, code: state?.unavailableCode } },
			);
		}

		const homedir = deps.hostInputs.homedir;
		let modelNames: readonly string[] = [];
		let isComplete = true;
		let source = 'local-config';

		switch (agentId) {
			case BUILT_IN_AGENT_IDS.CODEX: {
				const res = await readCodexModels({
					hostInputs: deps.hostInputs,
					homedir,
				});
				modelNames = res.models.map((m) => m.id);
				isComplete = !res.isPartial;
				break;
			}
			case BUILT_IN_AGENT_IDS.CLAUDE: {
				const res = await readClaudeModels({
					hostInputs: deps.hostInputs,
					homedir,
				});
				modelNames = res.models.map((m) => m.id);
				isComplete = !res.isPartial;
				break;
			}
			case BUILT_IN_AGENT_IDS.GROK: {
				const res = await readGrokModels({
					hostInputs: deps.hostInputs,
					homedir,
				});
				modelNames = res.models.map((m) => m.id);
				isComplete = !res.isPartial;
				break;
			}
			case BUILT_IN_AGENT_IDS.PI: {
				const res = await readPiModels({
					hostInputs: deps.hostInputs,
					homedir,
				});
				modelNames = res.models.map((m) => m.id);
				isComplete = !res.isPartial;
				break;
			}
			case BUILT_IN_AGENT_IDS.DSH: {
				const res = await readDshModels({
					hostInputs: deps.hostInputs,
					homedir,
				});
				modelNames = res.models.map((m) => m.id);
				isComplete = !res.isPartial;
				break;
			}
			default: {
				source = 'fallback';
				modelNames = [];
				isComplete = true;
				break;
			}
		}

		return Object.freeze({
			models: Object.freeze(modelNames),
			source,
			isComplete,
		});
	}

	async function assertCanDispatch(agentId: string): Promise<void> {
		await ensureInitialized();
		const currentSnapshot = deps.registry.getSnapshot();
		const config = currentSnapshot.agents[agentId];
		if (!config) {
			throw new AppError('E_NOT_FOUND', `Agent '${agentId}' is not registered in agent registry.`);
		}
		if (config.maxConcurrency <= 0) {
			throw new AppError(
				'E_AGENT_UNAVAILABLE',
				`Agent '${agentId}' is disabled (maxConcurrency <= 0).`,
				{ details: { agentId, reason: 'disabled' } },
			);
		}
		let state = availabilityMap.get(agentId);
		if (!state || state.generation !== currentSnapshot.generation) {
			const { state: refreshedState } = await probeSingleAgent(agentId, config, { force: true });
			recordAndPublishAvailability(agentId, refreshedState);
			state = refreshedState;
		}
		if (!state.canDispatch) {
			if (state.unavailableCode === 'E_AGENT_VERSION_UNRECOGNIZED') {
				throw new AppError(
					'E_AGENT_VERSION_UNRECOGNIZED',
					`Agent '${agentId}' version fingerprint mismatch; cannot dispatch.`,
					{ details: { agentId, ...state.errorDetails } },
				);
			}
			throw new AppError(
				'E_AGENT_UNAVAILABLE',
				`Agent '${agentId}' is unavailable: ${state.unavailableReason ?? 'cannot dispatch'}.`,
				{
					details: {
						agentId,
						code: state.unavailableCode ?? 'E_AGENT_UNAVAILABLE',
						reason: state.unavailableReason,
						...state.errorDetails,
					},
				},
			);
		}
	}

	function getAvailability(agentId: string): AgentAvailabilityState | undefined {
		const state = availabilityMap.get(agentId);
		const currentSnapshot = deps.registry.getSnapshot();
		if (state && state.generation !== currentSnapshot.generation) {
			return undefined;
		}
		return state;
	}

	return Object.freeze({
		registry: deps.registry,
		start,
		stop,
		listAgents,
		getAgent,
		updateAgent,
		probeAgent: probeAgentMethod,
		probeAll,
		listAgentModels,
		assertCanDispatch,
		getAvailability,
	});
}
