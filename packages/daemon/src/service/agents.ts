import { join } from 'node:path';
import type {
	AgentEntryDto,
	AgentLayersDto,
	EffortValue,
	ListAgentModelsResponse,
	LoginState,
	UpdateAgentBody,
} from '@agent-scheduler/shared/api/agents';
import {
	normalizeHistoryModelName as normalizeClaudeHistoryModelName,
	readClaudeModels,
} from '../adapters/claude/read-models.ts';
import {
	normalizeHistoryModelName as normalizeCodexHistoryModelName,
	readCodexModels,
} from '../adapters/codex/read-models.ts';
import { runDshSmokeTest } from '../adapters/dsh/smoke.ts';
import {
	normalizeHistoryModelName as normalizeGrokHistoryModelName,
	readGrokModels,
} from '../adapters/grok/read-models.ts';
import { probeLogin } from '../adapters/login-probe.ts';
import { type LiveModelCatalogResult, readModelsLive } from '../adapters/models-live.ts';
import {
	normalizeHistoryModelName as normalizePiHistoryModelName,
	readPiModels,
} from '../adapters/pi/read-models.ts';
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
import type { DatabaseConnection } from '../db/open-database.ts';
import { assertVendorEffortInDomain } from '../domain/effort-value.ts';
import { mergeModelSources } from '../domain/model-catalog.ts';
import { isPermissionTier } from '../domain/permission-tier.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { ExecutableFileSystem, PlatformHostInputs } from '../platform/contract.ts';
import type { spawnManaged } from '../proc/spawn.ts';
import { type RunsRepo, createRunsRepo } from '../repo/runs.ts';

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
	readonly runsRepo?: RunsRepo;
	readonly database?: DatabaseConnection;
	readonly listSucceededModelNames?: (params: {
		readonly agentId: string;
		readonly limit?: number;
	}) => readonly string[];
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
	getLogin(agentId: string): LoginState | null;
	refreshLogin(
		agentId: string,
		options?: {
			readonly force?: boolean;
			readonly trigger?:
				| 'exited_before_output'
				| 'probe'
				| 'models_refresh'
				| 'availability_changed';
			readonly providers?: readonly string[];
			readonly defaultProvider?: string | null;
		},
	): Promise<LoginState | null>;
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

function getAdapterHistoryNormalizer(agentId: string): (name: string) => string {
	switch (agentId) {
		case BUILT_IN_AGENT_IDS.CODEX:
			return normalizeCodexHistoryModelName;
		case BUILT_IN_AGENT_IDS.CLAUDE:
			return normalizeClaudeHistoryModelName;
		case BUILT_IN_AGENT_IDS.GROK:
			return normalizeGrokHistoryModelName;
		case BUILT_IN_AGENT_IDS.PI:
			return normalizePiHistoryModelName;
		default:
			return (name: string) => name;
	}
}

interface LiveCacheEntry {
	readonly result: LiveModelCatalogResult;
	readonly cachedAt: string;
}

interface AgentConfigFileData {
	readonly currentConfigModel: string | null;
	readonly currentConfigEffort: EffortValue | null;
	readonly configPath: string;
	readonly configError?: string;
	readonly currentConfigProvider?: string | null;
	readonly providers?: readonly string[];
}

export function createAgentService(deps: AgentServiceDeps): AgentService {
	const clock = deps.clock ?? Object.freeze({ now: () => new Date().toISOString() });
	const cache = deps.cache ?? createFingerprintCache();
	const availabilityMap = new Map<string, AgentAvailabilityState>();
	const loginCache = new Map<string, LoginState>();
	const inflightLogin = new Map<string, Promise<LoginState | null>>();
	const liveCache = new Map<string, LiveCacheEntry>();
	const inflightModels = new Map<string, Promise<LiveModelCatalogResult>>();
	const configCache = new Map<string, AgentConfigFileData>();

	const runsRepo: RunsRepo | undefined =
		deps.runsRepo ?? (deps.database ? createRunsRepo(deps.database) : undefined);

	async function readAgentConfig(agentId: string): Promise<AgentConfigFileData> {
		const cached = configCache.get(agentId);
		if (cached) return cached;

		const homedir = deps.hostInputs.homedir;
		let data: AgentConfigFileData;

		switch (agentId) {
			case BUILT_IN_AGENT_IDS.CODEX: {
				const res = await readCodexModels({
					hostInputs: deps.hostInputs,
					homedir,
				});
				data = Object.freeze({
					currentConfigModel: res.currentConfigModel,
					currentConfigEffort: res.currentConfigEffort ?? null,
					configPath: res.configError?.path ?? join(homedir, '.codex', 'config.toml'),
					configError: res.configError?.error,
				});
				break;
			}
			case BUILT_IN_AGENT_IDS.CLAUDE: {
				const res = await readClaudeModels({
					hostInputs: deps.hostInputs,
					homedir,
				});
				data = Object.freeze({
					currentConfigModel: res.currentConfigModel,
					currentConfigEffort: null,
					configPath: res.configError?.path ?? join(homedir, '.claude', 'settings.json'),
					configError: res.configError?.error,
				});
				break;
			}
			case BUILT_IN_AGENT_IDS.GROK: {
				const res = await readGrokModels({
					hostInputs: deps.hostInputs,
					homedir,
				});
				data = Object.freeze({
					currentConfigModel: res.currentConfigModel,
					currentConfigEffort: null,
					configPath: res.configError?.path ?? join(homedir, '.grok', 'config.toml'),
					configError: res.configError?.error,
				});
				break;
			}
			case BUILT_IN_AGENT_IDS.PI: {
				const res = await readPiModels({
					hostInputs: deps.hostInputs,
					homedir,
				});
				data = Object.freeze({
					currentConfigModel: res.currentConfigModel,
					currentConfigEffort: res.currentConfigEffort ?? null,
					currentConfigProvider: res.currentConfigProvider ?? null,
					providers: res.providers ?? [],
					configPath: res.configError?.path ?? join(homedir, '.pi', 'agent', 'settings.json'),
					configError: res.configError?.error,
				});
				break;
			}
			default: {
				data = Object.freeze({
					currentConfigModel: null,
					currentConfigEffort: null,
					configPath: '',
				});
				break;
			}
		}

		configCache.set(agentId, data);
		return data;
	}

	function triggerLiveProbe(
		agentId: string,
		config: ResolvedAgentConfig,
	): Promise<LiveModelCatalogResult> {
		const existing = inflightModels.get(agentId);
		if (existing) return existing;

		const state = availabilityMap.get(agentId);
		const resolvedPath = state?.resolvedPath ?? (config.execPath ? config.execPath : null);

		const promise = (async () => {
			try {
				const result = await readModelsLive({
					agentId,
					config,
					resolvedPath,
					platform: deps.hostInputs.platform,
					commandRunner: deps.commandRunner,
					spawnManagedFn: deps.spawnManagedFn,
				});
				liveCache.set(agentId, { result, cachedAt: clock.now() });
				return result;
			} finally {
				inflightModels.delete(agentId);
			}
		})();

		inflightModels.set(agentId, promise);
		return promise;
	}

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
		const snapshot = deps.registry.getSnapshot();
		const storedDefault = snapshot.storedDefaults[agentId] ?? config;
		const userOverrides = snapshot.userOverrides[agentId];

		const modelBuiltin = storedDefault.defaultModel ?? null;
		const effortBuiltin = storedDefault.defaultEffortTier ?? null;

		const cachedConfig = configCache.get(agentId);
		const modelConfig = cachedConfig ? cachedConfig.currentConfigModel : null;
		const effortConfig = cachedConfig ? cachedConfig.currentConfigEffort : null;

		const hasModelOverride =
			userOverrides !== undefined && Object.hasOwn(userOverrides, 'defaultModel');
		const modelOverride = hasModelOverride ? (userOverrides.defaultModel ?? null) : null;

		const hasEffortOverride =
			userOverrides !== undefined && Object.hasOwn(userOverrides, 'defaultEffortTier');
		const effortOverride = hasEffortOverride ? (userOverrides.defaultEffortTier ?? null) : null;

		// E-358: 生效值 = 覆盖 ?? 配置 ?? 内置
		// hasOverride: true, override: null -> 生效值 null
		const effectiveModel = hasModelOverride ? modelOverride : (modelConfig ?? modelBuiltin);
		const effectiveEffort = hasEffortOverride ? effortOverride : (effortConfig ?? effortBuiltin);

		const layers: AgentLayersDto = Object.freeze({
			defaultModel: Object.freeze({
				builtin: modelBuiltin,
				config: modelConfig,
				override: modelOverride,
				hasOverride: hasModelOverride,
			}),
			defaultEffortTier: Object.freeze({
				builtin: effortBuiltin,
				config: effortConfig,
				override: effortOverride,
				hasOverride: hasEffortOverride,
			}),
		});

		return Object.freeze({
			id: agentId,
			name: getAgentDisplayName(agentId),
			monogram: config.monogram,
			isAvailable,
			defaultModel: effectiveModel,
			defaultEffortTier: effectiveEffort,
			layers,
			effortVendorMap: config.effortVendorMap,
			builtinModels: config.builtinModels,
			maxConcurrency: config.maxConcurrency,
			permissionTier: config.permissionTier,
			execPath: config.execPath.length > 0 ? config.execPath : null,
			login: getLogin(agentId),
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

		// Invalidation point 3: availability flip (AC 5)
		if (prev !== undefined && prev.isAvailable !== state.isAvailable) {
			loginCache.delete(`login:${agentId}`);
			void refreshLogin(agentId, { force: true, trigger: 'availability_changed' });
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
		loginCache.clear();
		inflightLogin.clear();
		liveCache.clear();
		inflightModels.clear();
		configCache.clear();
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
		// Preload config cache for all agents
		await Promise.all(Object.keys(snapshot.agents).map((id) => readAgentConfig(id)));

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
		await readAgentConfig(agentId);
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

		// Invalidation point 1: POST /agents/:id/probe runs fingerprint probe then login probe (AC 5)
		await refreshLogin(agentId, { force: true, trigger: 'probe' });

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

		// Validate clearOverrides (Criterion 7, E-358)
		if (updates.clearOverrides !== undefined) {
			if (!Array.isArray(updates.clearOverrides)) {
				throw new AppError('E_VALIDATION', 'clearOverrides must be an array', {
					details: { field: 'clearOverrides' },
				});
			}
			if (updates.clearOverrides.length > 0) {
				const allowedClearFields = ['defaultModel', 'defaultEffortTier'] as const;
				const seen = new Set<string>();
				for (const field of updates.clearOverrides) {
					if (!allowedClearFields.includes(field as (typeof allowedClearFields)[number])) {
						throw new AppError('E_VALIDATION', `Unknown field in clearOverrides: '${field}'`, {
							details: { field: 'clearOverrides', unknownField: field },
						});
					}
					if (seen.has(field)) {
						throw new AppError('E_VALIDATION', `Duplicate field in clearOverrides: '${field}'`, {
							details: { field: 'clearOverrides', duplicateField: field },
						});
					}
					seen.add(field);
				}

				if (updates.clearOverrides.includes('defaultModel') && updates.defaultModel !== undefined) {
					throw new AppError(
						'E_VALIDATION',
						"Cannot specify both 'defaultModel' and clearOverrides containing 'defaultModel'",
						{ details: { field: 'defaultModel' } },
					);
				}
				if (
					updates.clearOverrides.includes('defaultEffortTier') &&
					updates.defaultEffortTier !== undefined
				) {
					throw new AppError(
						'E_VALIDATION',
						"Cannot specify both 'defaultEffortTier' and clearOverrides containing 'defaultEffortTier'",
						{ details: { field: 'defaultEffortTier' } },
					);
				}
			}
		}

		// Validate effortVendorMap is null (Criterion 7: effort unsupported agent like dsh)
		if (
			config.effortVendorMap === null &&
			updates.defaultEffortTier !== undefined &&
			updates.defaultEffortTier !== null
		) {
			throw new AppError('E_VALIDATION', `Agent '${agentId}' does not support reasoning effort.`, {
				details: { reason: 'effort_unsupported', agentId, field: 'defaultEffortTier' },
			});
		}

		// Validate vendor effort in domain (Criterion 7, E-351)
		if (
			updates.defaultEffortTier !== undefined &&
			updates.defaultEffortTier !== null &&
			'vendor' in updates.defaultEffortTier
		) {
			const vendor = updates.defaultEffortTier.vendor;
			const configData = await readAgentConfig(agentId);
			const allowed = new Set<string>();
			if (configData.currentConfigEffort && 'vendor' in configData.currentConfigEffort) {
				allowed.add(configData.currentConfigEffort.vendor);
			}
			const liveEntry = liveCache.get(agentId);
			if (liveEntry?.result.models) {
				for (const m of liveEntry.result.models) {
					if (m.effortOptions) {
						for (const opt of m.effortOptions) allowed.add(opt);
					}
				}
			}
			if (allowed.size === 0) {
				const liveRes = await triggerLiveProbe(agentId, config);
				for (const m of liveRes.models) {
					if (m.effortOptions) {
						for (const opt of m.effortOptions) allowed.add(opt);
					}
				}
			}

			assertVendorEffortInDomain(vendor, Array.from(allowed));
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
		configCache.delete(agentId);
		await probeAgentMethod(agentId, { force: true });

		const updatedAgent = await getAgent(agentId);
		if (!updatedAgent) {
			throw new AppError('E_INTERNAL', `Failed to retrieve updated agent '${agentId}'.`);
		}
		return updatedAgent;
	}

	async function listAgentModels(
		agentId: string,
		options: { readonly refresh?: boolean } = {},
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

		if (options.refresh) {
			configCache.delete(agentId);
		}
		const configData = await readAgentConfig(agentId);
		const currentConfigModel = configData.currentConfigModel;
		const currentConfigEffort = configData.currentConfigEffort;

		let liveResult: LiveModelCatalogResult;
		let refreshedAt: string;
		let isRefreshing = false;

		if (options.refresh) {
			liveCache.delete(agentId);
			loginCache.delete(agentId);

			const livePromise = triggerLiveProbe(agentId, config);

			// For Pi: providers comes from live table first column DISTINCT, defaultProvider from currentConfigProvider
			let loginPromise: Promise<LoginState | null>;
			if (agentId === BUILT_IN_AGENT_IDS.PI) {
				loginPromise = livePromise.then((res) => {
					const providers = res.ok
						? Array.from(
								new Set(res.models.map((m) => m.provider).filter((p): p is string => Boolean(p))),
							)
						: configData.currentConfigProvider
							? [configData.currentConfigProvider]
							: [];
					return refreshLogin(agentId, {
						force: true,
						trigger: 'models_refresh',
						providers: providers.length > 0 ? providers : undefined,
						defaultProvider: configData.currentConfigProvider,
					});
				});
			} else {
				loginPromise = refreshLogin(agentId, { force: true, trigger: 'models_refresh' });
			}

			const [liveSettled] = await Promise.allSettled([livePromise, loginPromise]);
			if (liveSettled.status === 'fulfilled') {
				liveResult = liveSettled.value;
			} else {
				liveResult = Object.freeze({
					ok: false,
					models: Object.freeze([]),
					failure: Object.freeze({
						reason: 'spawn_failed',
						message: String(liveSettled.reason),
					}),
					warnings: Object.freeze([]),
				});
			}
			refreshedAt = clock.now();
			isRefreshing = false;
		} else {
			const cached = liveCache.get(agentId);
			if (cached) {
				liveResult = cached.result;
				refreshedAt = cached.cachedAt;
				isRefreshing = inflightModels.has(agentId);
			} else if (inflightModels.has(agentId)) {
				// AC 3 & E-339: Uncached and in-flight -> DO NOT WAIT, return empty live immediately with isRefreshing: true
				liveResult = Object.freeze({
					ok: false,
					models: Object.freeze([]),
					failure: null,
					warnings: Object.freeze([]),
				});
				refreshedAt = clock.now();
				isRefreshing = true;
			} else {
				const livePromise = triggerLiveProbe(agentId, config);
				liveResult = await livePromise;
				refreshedAt = clock.now();
				isRefreshing = false;
			}
		}

		// Check effortRecognized for currentConfig
		let effortRecognized = true;
		if (currentConfigEffort !== null && 'vendor' in currentConfigEffort) {
			const vendor = currentConfigEffort.vendor;
			const inVendorMap =
				config.effortVendorMap !== null && Object.values(config.effortVendorMap).includes(vendor);
			const inLiveOptions = liveResult.models.some((m) => m.effortOptions?.includes(vendor));
			effortRecognized = inVendorMap || inLiveOptions;
		}

		// Get history models (Criterion 4, E-340)
		let historyModels: readonly string[] = [];
		const listHistoryFn =
			deps.listSucceededModelNames ??
			(runsRepo
				? (p: { readonly agentId: string; readonly limit?: number }) =>
						runsRepo.listSucceededModelNames(p)
				: undefined);
		if (listHistoryFn) {
			const rawHistory = listHistoryFn({ agentId, limit: 40 });
			const normalizedMap = new Set<string>();
			const historyList: string[] = [];
			const normalizeFn = getAdapterHistoryNormalizer(agentId);
			for (const rawName of rawHistory) {
				const normalized = normalizeFn(rawName);
				if (normalized && !normalizedMap.has(normalized)) {
					normalizedMap.add(normalized);
					historyList.push(normalized);
					if (historyList.length >= 20) break;
				}
			}
			historyModels = Object.freeze(historyList);
		}

		// Merge model sources (Criterion 1, E-338, E-350)
		const mergedModels = mergeModelSources({
			live: liveResult,
			currentConfigModel,
			builtinModels: config.builtinModels,
			historyModels,
		});

		return Object.freeze({
			models: mergedModels,
			isComplete: liveResult.ok,
			refreshedAt,
			liveFailure: liveResult.ok ? null : (liveResult.failure ?? null),
			currentConfig: Object.freeze({
				model: currentConfigModel,
				effort: currentConfigEffort,
				configPath: configData.configPath,
				...(configData.configError ? { configError: configData.configError } : {}),
				effortRecognized,
			}),
			isRefreshing,
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

	function getLogin(agentId: string): LoginState | null {
		const snapshot = deps.registry.getSnapshot();
		const config = snapshot.agents[agentId];
		if (!config || config.loginProbe.parser === 'none') {
			return null;
		}

		const cacheKey = `login:${agentId}`;
		const cached = loginCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		// Initial state before probe (AC 7, E-355, Decision 133)
		return Object.freeze({
			state: 'unknown',
			reason: 'not_probed',
			checkedAt: null,
			loginCommand: config.loginProbe.loginCommandHint ?? null,
			warningCode: null,
		});
	}

	async function refreshLogin(
		agentId: string,
		options: {
			readonly force?: boolean;
			readonly trigger?:
				| 'exited_before_output'
				| 'probe'
				| 'models_refresh'
				| 'availability_changed';
			readonly providers?: readonly string[];
			readonly defaultProvider?: string | null;
		} = {},
	): Promise<LoginState | null> {
		await ensureInitialized();
		const snapshot = deps.registry.getSnapshot();
		const config = snapshot.agents[agentId];
		if (!config) {
			throw new AppError('E_NOT_FOUND', `Agent '${agentId}' is not registered in agent registry.`);
		}

		// AC 3: parser='none' (dsh) does not start process, does not write cache, DTO login is null
		if (config.loginProbe.parser === 'none') {
			return null;
		}

		// In-flight deduplication (AC 5)
		const existingInflight = inflightLogin.get(agentId);
		if (existingInflight) {
			return existingInflight;
		}

		const cacheKey = `login:${agentId}`;
		loginCache.delete(cacheKey);

		const probePromise = (async () => {
			try {
				let state = availabilityMap.get(agentId);
				if (!state || state.generation !== snapshot.generation) {
					const { state: refreshedState } = await probeSingleAgent(agentId, config, {
						force: options.force,
					});
					recordAndPublishAvailability(agentId, refreshedState);
					state = refreshedState;
				}

				const result = await probeLogin({
					agentId,
					config,
					resolvedPath: state?.resolvedPath,
					homedir: deps.hostInputs.homedir,
					platform: deps.hostInputs.platform,
					providers: options.providers,
					defaultProvider: options.defaultProvider,
					commandRunner: deps.commandRunner,
					spawnManagedFn: deps.spawnManagedFn,
					nowIso: clock.now(),
				});

				if (result) {
					loginCache.set(cacheKey, result);
				}

				// AC 5: 每次 refreshLogin() 结束（成功、超时、unparsable、exec_missing）都发
				// agent.availability_changed{reason:'login_changed', login}
				if (deps.bus && deps.envelopeFactory) {
					const currentAvail = availabilityMap.get(agentId)?.isAvailable ?? false;
					const envelope = deps.envelopeFactory.createEnvelope({
						kind: 'agent.availability_changed',
						payload: {
							agentId,
							available: currentAvail,
							reason: 'login_changed',
							login: result,
							vendor: {
								trigger: options.trigger,
							},
						},
					});
					deps.bus.publish(envelope);
				}

				return result;
			} finally {
				inflightLogin.delete(agentId);
			}
		})();

		inflightLogin.set(agentId, probePromise);
		return probePromise;
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
		getLogin,
		refreshLogin,
	});
}
