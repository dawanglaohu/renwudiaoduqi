import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
	BuiltinModelDto,
	EffortValue,
	EffortVendorMap,
} from '@agent-scheduler/shared/api/agents';
import { isEffortTier } from '../domain/effort-tier.ts';
import {
	type PlatformTarget,
	detectSessionDirOverlaps,
	validateLaunchTemplate,
} from '../domain/launch-template.ts';
import {
	PERMISSION_TIERS,
	type PermissionTier,
	isPermissionTier,
} from '../domain/permission-tier.ts';
import {
	ADAPTER_KINDS,
	type AdapterKind,
	type AgentConfig,
	BUILT_IN_AGENT_DEFAULTS,
	GENERIC_LOGIN_PROBE_DEFAULT,
	GENERIC_MODELS_LIVE_DEFAULT,
	LOGIN_PROBE_PARSERS,
	type LoginProbeParser,
	type ModelsLiveKind,
	type ModelsLiveParser,
	type ResolvedAgentConfig,
	createDefaultTimeouts,
} from './defaults.ts';

export const AGENTS_FILE_NAME = 'agents.json';
export const AGENT_REGISTRY_SCHEMA_VERSION = 1;
export const AGENT_REGISTRY_RELOAD_DEBOUNCE_MS = 300;

const AGENT_CONFIG_FIELDS = [
	'execPath',
	'argsTemplate',
	'maxConcurrency',
	'defaultModel',
	'permissionTier',
	'monogram',
	'adapterKind',
	'timeouts',
	'versionFingerprint',
	'versionRange',
	'loginProbe',
	'modelsLive',
	'builtinModels',
	'defaultEffortTier',
	'effortVendorMap',
] as const;

const TIMEOUT_FIELDS = ['startupTimeoutMs', 'idleTimeoutMs', 'hardWallClockMs'] as const;
const VERSION_FINGERPRINT_FIELDS = ['args', 'expectedPattern'] as const;
const VERSION_RANGE_FIELDS = ['min', 'max'] as const;
const LOGIN_PROBE_FIELDS = [
	'args',
	'parser',
	'loggedInPattern',
	'loggedOutPattern',
	'loginCommandHint',
] as const;
const MODELS_LIVE_FIELDS = ['kind', 'args', 'parser', 'timeoutMs'] as const;
const ROOT_FIELDS = ['schemaVersion', 'defaults', 'overrides'] as const;

export const FORBIDDEN_LOGIN_PROBE_ARG_SUBSTRINGS = Object.freeze([
	'print-api-key',
	'print-bearer-token',
	'--credentials',
] as const);

export const AGENT_CONFIG_FIELD_PATHS = [
	'execPath',
	'argsTemplate',
	'maxConcurrency',
	'defaultModel',
	'permissionTier',
	'monogram',
	'adapterKind',
	'timeouts.startupTimeoutMs',
	'timeouts.idleTimeoutMs',
	'timeouts.hardWallClockMs',
	'versionFingerprint.args',
	'versionFingerprint.expectedPattern',
	'loginProbe.args',
	'loginProbe.parser',
	'loginProbe.loggedInPattern',
	'loginProbe.loggedOutPattern',
	'loginProbe.loginCommandHint',
	'modelsLive.kind',
	'modelsLive.args',
	'modelsLive.parser',
	'modelsLive.timeoutMs',
	'builtinModels',
	'defaultEffortTier',
	'effortVendorMap',
] as const;

export type AgentConfigFieldPath = (typeof AGENT_CONFIG_FIELD_PATHS)[number];

export interface AgentTimeoutOverrides {
	readonly startupTimeoutMs?: number;
	readonly idleTimeoutMs?: number;
	readonly hardWallClockMs?: number;
}

export interface VersionRangeOverrides {
	readonly min?: string;
	readonly max?: string;
}

export interface VersionFingerprintOverrides {
	readonly args?: readonly string[];
	readonly expectedPattern?: string;
}

export interface LoginProbeOverrides {
	readonly args?: readonly string[];
	readonly parser?: LoginProbeParser;
	readonly loggedInPattern?: string | null;
	readonly loggedOutPattern?: string | null;
	readonly loginCommandHint?: string | null;
}

export interface ModelsLiveOverrides {
	readonly kind?: ModelsLiveKind;
	readonly args?: readonly string[];
	readonly parser?: ModelsLiveParser;
	readonly timeoutMs?: number;
}

export interface AgentConfigOverrides {
	readonly execPath?: string;
	readonly argsTemplate?: readonly string[];
	readonly maxConcurrency?: number;
	readonly defaultModel?: string | null;
	readonly permissionTier?: PermissionTier;
	readonly monogram?: string;
	readonly adapterKind?: AdapterKind;
	readonly timeouts?: AgentTimeoutOverrides;
	readonly versionFingerprint?: VersionFingerprintOverrides;
	readonly versionRange?: VersionRangeOverrides;
	readonly loginProbe?: LoginProbeOverrides;
	readonly modelsLive?: ModelsLiveOverrides;
	readonly builtinModels?: readonly BuiltinModelDto[];
	readonly defaultEffortTier?: EffortValue;
	readonly effortVendorMap?: EffortVendorMap;
	readonly clearOverrides?: readonly ('defaultModel' | 'defaultEffortTier')[];
}

export type AgentConfigLayer = Readonly<Record<string, AgentConfigOverrides>>;

export interface AgentsFileConfig {
	readonly schemaVersion?: number;
	readonly defaults?: AgentConfigLayer;
	readonly overrides?: AgentConfigLayer;
}

export type AgentConfigValue =
	| string
	| number
	| null
	| readonly string[]
	| readonly BuiltinModelDto[]
	| EffortValue
	| EffortVendorMap;

export interface AgentDefaultUpdate {
	readonly agentId: string;
	readonly field: AgentConfigFieldPath;
	readonly oldValue: AgentConfigValue;
	readonly newValue: AgentConfigValue;
	readonly userValue: AgentConfigValue;
}

export interface AgentRegistrySnapshot {
	readonly generation: number;
	readonly fingerprint: string | null;
	readonly agents: Readonly<Record<string, ResolvedAgentConfig>>;
	readonly builtInDefaults: Readonly<Record<string, AgentConfig>>;
	readonly storedDefaults: Readonly<Record<string, AgentConfig>>;
	readonly userOverrides: AgentConfigLayer;
	readonly defaultUpdates: readonly AgentDefaultUpdate[];
}

export type AgentRegistryWarningReason =
	| 'invalid-config'
	| 'read-failed'
	| 'unknown-field'
	| 'watch-failed'
	| 'write-failed'
	| 'session-dir-overlap';

export interface AgentRegistryWarning {
	readonly kind: 'agent.availability_changed';
	readonly severity: 'warning';
	readonly reason: AgentRegistryWarningReason;
	readonly message: string;
	readonly configPath: string;
	readonly field?: string;
	readonly agentId?: string;
	readonly peerAgentId?: string;
	readonly argumentIndex?: number;
	readonly startIndex?: number;
	readonly endIndex?: number;
	readonly highlight?: string;
	readonly execPath?: string;
	readonly sessionDir?: string;
}

export type AgentRegistryReloadResult =
	| { readonly status: 'loaded'; readonly snapshot: AgentRegistrySnapshot }
	| { readonly status: 'unchanged'; readonly snapshot: AgentRegistrySnapshot }
	| { readonly status: 'rejected'; readonly snapshot: AgentRegistrySnapshot };

export type AdoptDefaultResult =
	| { readonly ok: true; readonly reload: AgentRegistryReloadResult }
	| { readonly ok: false; readonly reason: 'no-default-update' | 'write-failed' };

export type UpdateOverridesResult =
	| { readonly ok: true; readonly reload: AgentRegistryReloadResult }
	| {
			readonly ok: false;
			readonly reason: 'unknown-agent' | 'read-failed' | 'invalid-config' | 'write-failed';
			readonly message: string;
			readonly details?: Record<string, unknown>;
	  };

export interface AgentRegistryWatcher {
	close(): void;
	on(event: 'error', listener: (cause: Error) => void): AgentRegistryWatcher;
}

export interface AgentRegistryFileSystem {
	readUtf8File(path: string): Promise<string>;
	writeUtf8File(path: string, contents: string): Promise<void>;
	watchDirectory(
		path: string,
		listener: (eventType: string, filename: string | Buffer | null) => void,
	): AgentRegistryWatcher;
}

export interface AgentRegistryTimers {
	setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface CreateAgentRegistryOptions {
	readonly dataDir: string;
	readonly platform: PlatformTarget;
	readonly publishWarning: (warning: AgentRegistryWarning) => void;
	readonly onReload?: (snapshot: AgentRegistrySnapshot) => void;
	readonly builtInDefaults?: Readonly<Record<string, AgentConfig>>;
	readonly fileSystem?: AgentRegistryFileSystem;
	readonly timers?: AgentRegistryTimers;
}

export interface AgentRegistry {
	readonly configPath: string;
	start(): Promise<AgentRegistrySnapshot>;
	stop(): void;
	reload(): Promise<AgentRegistryReloadResult>;
	getSnapshot(): AgentRegistrySnapshot;
	adoptDefault(agentId: string, field: AgentConfigFieldPath): Promise<AdoptDefaultResult>;
	updateOverrides(agentId: string, updates: AgentConfigOverrides): Promise<UpdateOverridesResult>;
	onReload(listener: (snapshot: AgentRegistrySnapshot) => void): () => void;
}

export const AGENTS_JSON_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: 'https://agent-scheduler.local/schemas/agents.json',
	type: 'object',
	additionalProperties: true,
	properties: {
		schemaVersion: { type: 'integer', const: AGENT_REGISTRY_SCHEMA_VERSION },
		defaults: { $ref: '#/$defs/agentLayer' },
		overrides: { $ref: '#/$defs/agentLayer' },
	},
	$defs: {
		agentLayer: {
			type: 'object',
			additionalProperties: { $ref: '#/$defs/agentConfig' },
		},
		agentConfig: {
			type: 'object',
			additionalProperties: true,
			properties: {
				execPath: { type: 'string', minLength: 1 },
				argsTemplate: { type: 'array', items: { type: 'string' } },
				maxConcurrency: { type: 'integer', maximum: 32 },
				defaultModel: { type: ['string', 'null'] },
				permissionTier: { enum: Object.values(PERMISSION_TIERS) },
				monogram: { type: 'string', minLength: 2, maxLength: 2 },
				adapterKind: { enum: Object.values(ADAPTER_KINDS) },
				timeouts: {
					type: 'object',
					additionalProperties: true,
					properties: {
						startupTimeoutMs: { type: 'integer', minimum: 1 },
						idleTimeoutMs: { type: 'integer', minimum: 1 },
						hardWallClockMs: { type: 'integer', minimum: 0 },
					},
				},
				versionRange: {
					type: 'object',
					additionalProperties: true,
					properties: {
						min: { type: 'string' },
						max: { type: 'string' },
					},
				},
				versionFingerprint: {
					type: 'object',
					additionalProperties: true,
					properties: {
						args: { type: 'array', items: { type: 'string' } },
						expectedPattern: { type: 'string', minLength: 1 },
					},
				},
				loginProbe: {
					type: 'object',
					additionalProperties: true,
					properties: {
						args: { type: 'array', items: { type: 'string' } },
						parser: { enum: Object.values(LOGIN_PROBE_PARSERS) },
						loggedInPattern: { type: ['string', 'null'] },
						loggedOutPattern: { type: ['string', 'null'] },
						loginCommandHint: { type: ['string', 'null'], maxLength: 200 },
					},
				},
			},
		},
	},
} as const;

const NODE_FILE_SYSTEM: AgentRegistryFileSystem = Object.freeze({
	readUtf8File(path: string): Promise<string> {
		return readFile(path, 'utf8');
	},
	writeUtf8File(path: string, contents: string): Promise<void> {
		return writeFile(path, contents, 'utf8');
	},
	watchDirectory(
		path: string,
		listener: (eventType: string, filename: string | Buffer | null) => void,
	): AgentRegistryWatcher {
		return watch(path, listener);
	},
});

const NODE_TIMERS: AgentRegistryTimers = Object.freeze({
	setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
		return setTimeout(callback, milliseconds);
	},
	clearTimeout(handle: ReturnType<typeof setTimeout>): void {
		clearTimeout(handle);
	},
});

export function createAgentRegistry(options: CreateAgentRegistryOptions): AgentRegistry {
	const configPath = join(options.dataDir, AGENTS_FILE_NAME);
	const fileSystem = options.fileSystem ?? NODE_FILE_SYSTEM;
	const timers = options.timers ?? NODE_TIMERS;
	const builtInDefaults = freezeAgentConfigRecord(
		options.builtInDefaults ?? BUILT_IN_AGENT_DEFAULTS,
	);
	let current = createSnapshot(0, null, builtInDefaults, {}, {});
	let lastObservedFingerprint: string | null = null;
	let watcher: AgentRegistryWatcher | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	const reloadListeners = new Set<(snapshot: AgentRegistrySnapshot) => void>();
	let reloadQueue = Promise.resolve<AgentRegistryReloadResult>({
		status: 'unchanged',
		snapshot: current,
	});

	function publishWarning(
		reason: AgentRegistryWarningReason,
		message: string,
		context: {
			readonly field?: string;
			readonly agentId?: string;
			readonly peerAgentId?: string;
			readonly argumentIndex?: number;
			readonly startIndex?: number;
			readonly endIndex?: number;
			readonly highlight?: string;
			readonly execPath?: string;
			readonly sessionDir?: string;
		} = {},
	): void {
		options.publishWarning(
			Object.freeze({
				kind: 'agent.availability_changed',
				severity: 'warning',
				reason,
				message,
				configPath,
				...context,
			}),
		);
	}

	async function performReload(): Promise<AgentRegistryReloadResult> {
		let contents: string;
		try {
			contents = await fileSystem.readUtf8File(configPath);
		} catch (cause) {
			if (isFileNotFound(cause)) {
				contents = '{}';
			} else {
				publishWarning(
					'read-failed',
					'Agent registry could not be read; keeping the previous version.',
				);
				return { status: 'rejected', snapshot: current };
			}
		}

		const fingerprint = fingerprintContents(contents);
		if (fingerprint === lastObservedFingerprint) {
			return { status: 'unchanged', snapshot: current };
		}
		lastObservedFingerprint = fingerprint;

		const parsed = parseAgentsFile(contents, builtInDefaults);
		for (const unknownField of parsed.unknownFields) {
			publishWarning('unknown-field', 'Unknown agent registry field was ignored.', unknownField);
		}
		for (const w of parsed.rejectedAgentWarnings ?? []) {
			publishWarning(
				'invalid-config',
				`Agent registry field ${w.field} must be ${w.expected}; rejecting agent '${w.agentId}'.`,
				{ field: w.field, agentId: w.agentId },
			);
		}
		if (!parsed.ok) {
			publishWarning(
				'invalid-config',
				`Agent registry field ${parsed.field} must be ${parsed.expected}; keeping the previous version.`,
				{
					field: parsed.field,
					agentId: parsed.agentId,
					argumentIndex: parsed.argumentIndex,
					startIndex: parsed.startIndex,
					endIndex: parsed.endIndex,
					highlight: parsed.highlight,
				},
			);
			return { status: 'rejected', snapshot: current };
		}

		const storedDefaults = mergeAgentConfigRecord(builtInDefaults, parsed.defaults);
		const resolvedAgents = resolveAgentConfigRecord(builtInDefaults, parsed.overrides);

		for (const [agentId, config] of Object.entries(resolvedAgents)) {
			const validation = validateLaunchTemplate(config.argsTemplate);
			if (!validation.ok) {
				publishWarning(
					'invalid-config',
					`Agent registry field $.agents.${agentId}.argsTemplate must be valid template syntax (${validation.error.reason}); keeping the previous version.`,
					{
						field: `$.agents.${agentId}.argsTemplate`,
						agentId,
						argumentIndex: validation.error.argumentIndex,
						startIndex: validation.error.startIndex,
						endIndex: validation.error.endIndex,
						highlight: validation.error.highlight,
					},
				);
				return { status: 'rejected', snapshot: current };
			}
		}

		const sessionWarnings = detectSessionDirOverlaps(resolvedAgents, {
			platform: options.platform,
		});
		for (const warning of sessionWarnings) {
			publishWarning('session-dir-overlap', warning.message, {
				agentId: warning.agentId,
				peerAgentId: warning.peerAgentId,
				execPath: warning.execPath,
				sessionDir: warning.sessionDir,
			});
		}

		let snapshotFingerprint = fingerprint;
		if (parsed.needsDefaultPersistence) {
			const persistedContents = serializeAgentsFile({
				schemaVersion: AGENT_REGISTRY_SCHEMA_VERSION,
				defaults: storedDefaults,
				overrides: parsed.overrides,
			});
			try {
				await fileSystem.writeUtf8File(configPath, persistedContents);
				snapshotFingerprint = fingerprintContents(persistedContents);
				lastObservedFingerprint = snapshotFingerprint;
			} catch (_cause) {
				publishWarning(
					'write-failed',
					'Initial agent defaults could not be saved; continuing with in-memory defaults.',
				);
			}
		}

		current = createSnapshot(
			current.generation + 1,
			snapshotFingerprint,
			builtInDefaults,
			storedDefaults,
			parsed.overrides,
		);
		options.onReload?.(current);
		for (const listener of reloadListeners) {
			listener(current);
		}
		return { status: 'loaded', snapshot: current };
	}

	function reload(): Promise<AgentRegistryReloadResult> {
		const nextReload = reloadQueue.then(performReload, performReload);
		reloadQueue = nextReload;
		return nextReload;
	}

	function scheduleReload(): void {
		if (debounceTimer !== undefined) timers.clearTimeout(debounceTimer);
		debounceTimer = timers.setTimeout(() => {
			debounceTimer = undefined;
			void reload();
		}, AGENT_REGISTRY_RELOAD_DEBOUNCE_MS);
	}

	function startWatcher(): void {
		if (watcher !== undefined) return;
		try {
			watcher = fileSystem.watchDirectory(dirname(configPath), (_eventType, filename) => {
				if (filename === null || basename(filename.toString()) === AGENTS_FILE_NAME) {
					scheduleReload();
				}
			});
			watcher.on('error', () => {
				publishWarning(
					'watch-failed',
					'Agent registry watch failed; the daemon will keep the last valid version.',
				);
			});
		} catch (_cause) {
			publishWarning(
				'watch-failed',
				'Agent registry watch could not start; the daemon will keep the current version.',
			);
		}
	}

	async function start(): Promise<AgentRegistrySnapshot> {
		startWatcher();
		await reload();
		return current;
	}

	function stop(): void {
		if (debounceTimer !== undefined) {
			timers.clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
		watcher?.close();
		watcher = undefined;
	}

	async function adoptDefault(
		agentId: string,
		field: AgentConfigFieldPath,
	): Promise<AdoptDefaultResult> {
		const update = current.defaultUpdates.find(
			(candidate) => candidate.agentId === agentId && candidate.field === field,
		);
		if (update === undefined) return { ok: false, reason: 'no-default-update' };

		const nextFile = createAdoptedAgentsFile(current, update);
		try {
			await fileSystem.writeUtf8File(configPath, `${JSON.stringify(nextFile, null, 2)}\n`);
		} catch (_cause) {
			publishWarning('write-failed', 'Updated agent defaults could not be saved.', {
				agentId,
				field,
			});
			return { ok: false, reason: 'write-failed' };
		}

		return { ok: true, reload: await reload() };
	}

	async function updateOverrides(
		agentId: string,
		updates: AgentConfigOverrides,
	): Promise<UpdateOverridesResult> {
		if (!Object.hasOwn(builtInDefaults, agentId)) {
			return Object.freeze({
				ok: false,
				reason: 'unknown-agent',
				message: `Agent '${agentId}' is not recognized in built-in registry defaults.`,
				details: { agentId },
			});
		}

		let contents: string;
		try {
			contents = await fileSystem.readUtf8File(configPath);
		} catch (cause) {
			if (isFileNotFound(cause)) {
				contents = '{}';
			} else {
				return Object.freeze({
					ok: false,
					reason: 'read-failed',
					message: 'Agent registry could not be read; keeping the previous version.',
				});
			}
		}

		// R2: File on disk cannot be parsed -> refuse to write and preserve disk text verbatim!
		let rawParsed: unknown;
		try {
			rawParsed = JSON.parse(contents);
		} catch (cause) {
			return Object.freeze({
				ok: false,
				reason: 'invalid-config',
				message: 'Current agents.json file on disk is invalid JSON; refusing to overwrite.',
				details: { cause: String(cause) },
			});
		}
		if (!isRecord(rawParsed)) {
			return Object.freeze({
				ok: false,
				reason: 'invalid-config',
				message:
					'Current agents.json file on disk is not a valid JSON object; refusing to overwrite.',
			});
		}

		const diskParsed = parseAgentsFile(contents, builtInDefaults);
		if (!diskParsed.ok) {
			return Object.freeze({
				ok: false,
				reason: 'invalid-config',
				message: `Current agents.json on disk has invalid field ${diskParsed.field} (${diskParsed.expected}); refusing to overwrite.`,
				details: { field: diskParsed.field, expected: diskParsed.expected },
			});
		}

		// Merge candidate updates into existing overrides for this agent
		const nextOverrides = mutableOverrideRecord(diskParsed.overrides);
		const currentAgentOverrides = nextOverrides[agentId] ?? {};
		const mergedAgentOverrides: MutableAgentConfigOverrides = {
			...currentAgentOverrides,
			...updates,
			timeouts:
				updates.timeouts !== undefined
					? { ...currentAgentOverrides.timeouts, ...updates.timeouts }
					: currentAgentOverrides.timeouts,
			versionFingerprint:
				updates.versionFingerprint !== undefined
					? { ...currentAgentOverrides.versionFingerprint, ...updates.versionFingerprint }
					: currentAgentOverrides.versionFingerprint,
			loginProbe:
				updates.loginProbe !== undefined
					? { ...currentAgentOverrides.loginProbe, ...updates.loginProbe }
					: currentAgentOverrides.loginProbe,
			modelsLive:
				updates.modelsLive !== undefined
					? { ...currentAgentOverrides.modelsLive, ...updates.modelsLive }
					: currentAgentOverrides.modelsLive,
		};

		if (updates.clearOverrides) {
			for (const field of updates.clearOverrides) {
				if (field === 'defaultModel') {
					mergedAgentOverrides.defaultModel = undefined;
					currentAgentOverrides.defaultModel = undefined;
				} else if (field === 'defaultEffortTier') {
					mergedAgentOverrides.defaultEffortTier = undefined;
					currentAgentOverrides.defaultEffortTier = undefined;
				}
			}
		}

		// Pre-validate mergedAgentOverrides against AGENTS_JSON_SCHEMA before writing!
		const dummyUnknown: UnknownField[] = [];
		const validation = parseAgentConfig(
			mergedAgentOverrides,
			`$.overrides.${agentId}`,
			dummyUnknown,
			agentId,
		);
		if (!validation.ok) {
			return Object.freeze({
				ok: false,
				reason: 'invalid-config',
				message: `Agent registry field ${validation.field} must be ${validation.expected}`,
				details: {
					field: validation.field,
					expected: validation.expected,
					agentId,
				},
			});
		}

		if (mergedAgentOverrides.argsTemplate) {
			const templateVal = validateLaunchTemplate(mergedAgentOverrides.argsTemplate);
			if (!templateVal.ok) {
				return Object.freeze({
					ok: false,
					reason: 'invalid-config',
					message: `Invalid template syntax in argsTemplate: ${templateVal.error.reason}`,
					details: {
						field: `$.overrides.${agentId}.argsTemplate`,
						reason: templateVal.error.reason,
					},
				});
			}
		}

		nextOverrides[agentId] = validation.value;

		const nextFile: Required<AgentsFileConfig> = {
			schemaVersion: AGENT_REGISTRY_SCHEMA_VERSION,
			defaults:
				Object.keys(diskParsed.defaults).length > 0 ? diskParsed.defaults : current.storedDefaults,
			overrides: freezeAgentConfigLayer(nextOverrides),
		};

		const serialized = `${JSON.stringify(nextFile, null, 2)}\n`;
		try {
			await fileSystem.writeUtf8File(configPath, serialized);
		} catch (cause) {
			publishWarning('write-failed', 'Updated agent configuration could not be saved.', {
				agentId,
			});
			return Object.freeze({
				ok: false,
				reason: 'write-failed',
				message: 'Failed to write updated agents.json to disk.',
				details: { cause: String(cause) },
			});
		}

		const reloadResult = await reload();
		if (reloadResult.status === 'rejected') {
			return Object.freeze({
				ok: false,
				reason: 'invalid-config',
				message: 'Reload rejected the updated configuration.',
				details: { agentId },
			});
		}

		return Object.freeze({ ok: true, reload: reloadResult });
	}

	function onReload(listener: (snapshot: AgentRegistrySnapshot) => void): () => void {
		reloadListeners.add(listener);
		return () => {
			reloadListeners.delete(listener);
		};
	}

	return Object.freeze({
		configPath,
		start,
		stop,
		reload,
		getSnapshot: () => current,
		adoptDefault,
		updateOverrides,
		onReload,
	});
}

interface UnknownField {
	readonly field: string;
	readonly agentId?: string;
}

type ParseAgentConfigResult =
	| { readonly ok: true; readonly value: AgentConfigOverrides }
	| {
			readonly ok: false;
			readonly field: string;
			readonly expected: string;
			readonly rejectAgentOnly?: boolean;
			readonly argumentIndex?: number;
			readonly startIndex?: number;
			readonly endIndex?: number;
			readonly highlight?: string;
	  };

interface MutableAgentConfigOverrides {
	execPath?: string;
	argsTemplate?: readonly string[];
	maxConcurrency?: number;
	defaultModel?: string | null;
	permissionTier?: PermissionTier;
	monogram?: string;
	adapterKind?: AdapterKind;
	timeouts?: MutableAgentTimeoutOverrides;
	versionFingerprint?: MutableVersionFingerprintOverrides;
	versionRange?: MutableVersionRangeOverrides;
	loginProbe?: MutableLoginProbeOverrides;
	modelsLive?: MutableModelsLiveOverrides;
	builtinModels?: readonly BuiltinModelDto[];
	defaultEffortTier?: EffortValue;
	effortVendorMap?: EffortVendorMap;
}

interface MutableModelsLiveOverrides {
	kind?: ModelsLiveKind;
	args?: readonly string[];
	parser?: ModelsLiveParser;
	timeoutMs?: number;
}

interface MutableAgentTimeoutOverrides {
	startupTimeoutMs?: number;
	idleTimeoutMs?: number;
	hardWallClockMs?: number;
}

interface MutableVersionRangeOverrides {
	min?: string;
	max?: string;
}

interface MutableVersionFingerprintOverrides {
	args?: readonly string[];
	expectedPattern?: string;
}

interface MutableLoginProbeOverrides {
	args?: readonly string[];
	parser?: LoginProbeParser;
	loggedInPattern?: string | null;
	loggedOutPattern?: string | null;
	loginCommandHint?: string | null;
}

export interface RejectedAgentWarning {
	readonly field: string;
	readonly expected: string;
	readonly agentId: string;
}

export type ParseAgentsFileResult =
	| {
			readonly ok: true;
			readonly defaults: AgentConfigLayer;
			readonly overrides: AgentConfigLayer;
			readonly needsDefaultPersistence: boolean;
			readonly unknownFields: readonly UnknownField[];
			readonly rejectedAgentWarnings: readonly RejectedAgentWarning[];
	  }
	| {
			readonly ok: false;
			readonly field: string;
			readonly expected: string;
			readonly unknownFields: readonly UnknownField[];
			readonly rejectedAgentWarnings: readonly RejectedAgentWarning[];
			readonly agentId?: string;
			readonly argumentIndex?: number;
			readonly startIndex?: number;
			readonly endIndex?: number;
			readonly highlight?: string;
	  };

function parseAgentsFile(
	contents: string,
	builtInDefaults: Readonly<Record<string, AgentConfig>>,
): ParseAgentsFileResult {
	let input: unknown;
	try {
		input = JSON.parse(contents);
	} catch (_cause) {
		return {
			ok: false,
			field: '$',
			expected: 'valid JSON',
			unknownFields: [],
			rejectedAgentWarnings: [],
		};
	}
	if (!isRecord(input)) {
		return {
			ok: false,
			field: '$',
			expected: 'an object',
			unknownFields: [],
			rejectedAgentWarnings: [],
		};
	}

	const unknownFields: UnknownField[] = [];
	collectUnknownFields(input, ROOT_FIELDS, '$', unknownFields);
	if (
		Object.hasOwn(input, 'schemaVersion') &&
		input.schemaVersion !== AGENT_REGISTRY_SCHEMA_VERSION
	) {
		return {
			ok: false,
			field: '$.schemaVersion',
			expected: `${AGENT_REGISTRY_SCHEMA_VERSION}`,
			unknownFields,
			rejectedAgentWarnings: [],
		};
	}

	const rejectedAgentWarnings: RejectedAgentWarning[] = [];
	const defaults = parseAgentLayer(
		input.defaults,
		'$.defaults',
		builtInDefaults,
		unknownFields,
		rejectedAgentWarnings,
	);
	if (!defaults.ok) return { ...defaults, unknownFields, rejectedAgentWarnings };
	const overrides = parseAgentLayer(
		input.overrides,
		'$.overrides',
		builtInDefaults,
		unknownFields,
		rejectedAgentWarnings,
	);
	if (!overrides.ok) return { ...overrides, unknownFields, rejectedAgentWarnings };
	return {
		ok: true,
		defaults: defaults.value,
		overrides: overrides.value,
		needsDefaultPersistence: !hasCompleteDefaultBaseline(defaults.value, builtInDefaults),
		unknownFields: Object.freeze(unknownFields),
		rejectedAgentWarnings: Object.freeze(rejectedAgentWarnings),
	};
}

type ParseAgentLayerResult =
	| { readonly ok: true; readonly value: AgentConfigLayer }
	| {
			readonly ok: false;
			readonly field: string;
			readonly expected: string;
			readonly agentId?: string;
			readonly argumentIndex?: number;
			readonly startIndex?: number;
			readonly endIndex?: number;
			readonly highlight?: string;
	  };

function parseAgentLayer(
	input: unknown,
	path: string,
	builtInDefaults: Readonly<Record<string, AgentConfig>>,
	unknownFields: UnknownField[],
	rejectedAgentWarnings: RejectedAgentWarning[],
): ParseAgentLayerResult {
	if (input === undefined) return { ok: true, value: Object.freeze({}) };
	if (!isRecord(input)) return { ok: false, field: path, expected: 'an object' };

	const result: Record<string, AgentConfigOverrides> = {};
	for (const [agentId, value] of Object.entries(input)) {
		if (!Object.hasOwn(builtInDefaults, agentId)) {
			unknownFields.push(Object.freeze({ field: `${path}.${agentId}`, agentId }));
			continue;
		}
		const parsed = parseAgentConfig(value, `${path}.${agentId}`, unknownFields, agentId);
		if (!parsed.ok) {
			if (parsed.rejectAgentOnly) {
				rejectedAgentWarnings.push({
					field: parsed.field,
					expected: parsed.expected,
					agentId,
				});
				continue;
			}
			return { ...parsed, agentId };
		}
		result[agentId] = parsed.value;
	}
	return { ok: true, value: Object.freeze(result) };
}

function parseAgentConfig(
	input: unknown,
	path: string,
	unknownFields: UnknownField[],
	agentId: string,
): ParseAgentConfigResult {
	if (!isRecord(input)) return { ok: false, field: path, expected: 'an object' };
	collectUnknownFields(input, AGENT_CONFIG_FIELDS, path, unknownFields, agentId);
	const result: MutableAgentConfigOverrides = {};

	if (Object.hasOwn(input, 'execPath') && input.execPath !== undefined) {
		if (typeof input.execPath !== 'string' || input.execPath.length === 0) {
			return { ok: false, field: `${path}.execPath`, expected: 'a non-empty string' };
		}
		result.execPath = input.execPath;
	}
	if (Object.hasOwn(input, 'argsTemplate') && input.argsTemplate !== undefined) {
		const args = parseStringArray(input.argsTemplate);
		if (args === undefined) {
			return { ok: false, field: `${path}.argsTemplate`, expected: 'an array of strings' };
		}
		const templateValidation = validateLaunchTemplate(args);
		if (!templateValidation.ok) {
			return {
				ok: false,
				field: `${path}.argsTemplate`,
				expected: `valid template syntax (${templateValidation.error.reason})`,
				argumentIndex: templateValidation.error.argumentIndex,
				startIndex: templateValidation.error.startIndex,
				endIndex: templateValidation.error.endIndex,
				highlight: templateValidation.error.highlight,
			};
		}
		result.argsTemplate = templateValidation.template;
	}
	if (Object.hasOwn(input, 'maxConcurrency') && input.maxConcurrency !== undefined) {
		if (!isSafeInteger(input.maxConcurrency) || input.maxConcurrency > 32) {
			return {
				ok: false,
				field: `${path}.maxConcurrency`,
				expected: 'an integer no greater than 32',
			};
		}
		result.maxConcurrency = input.maxConcurrency;
	}
	if (Object.hasOwn(input, 'defaultModel') && input.defaultModel !== undefined) {
		if (input.defaultModel !== null && typeof input.defaultModel !== 'string') {
			return { ok: false, field: `${path}.defaultModel`, expected: 'a string or null' };
		}
		result.defaultModel = input.defaultModel;
	}
	if (Object.hasOwn(input, 'permissionTier') && input.permissionTier !== undefined) {
		if (!isPermissionTier(input.permissionTier)) {
			return {
				ok: false,
				field: `${path}.permissionTier`,
				expected: "one of 'readOnly', 'workspaceWrite', 'unrestricted'",
			};
		}
		result.permissionTier = input.permissionTier;
	}
	if (Object.hasOwn(input, 'monogram') && input.monogram !== undefined) {
		if (typeof input.monogram !== 'string' || [...input.monogram].length !== 2) {
			return {
				ok: false,
				field: `${path}.monogram`,
				expected: 'a two-character string',
			};
		}
		result.monogram = input.monogram;
	}
	if (Object.hasOwn(input, 'adapterKind') && input.adapterKind !== undefined) {
		if (!isAdapterKind(input.adapterKind)) {
			return {
				ok: false,
				field: `${path}.adapterKind`,
				expected: 'native or generic-acp',
			};
		}
		result.adapterKind = input.adapterKind;
	}
	if (Object.hasOwn(input, 'timeouts') && input.timeouts !== undefined) {
		const parsedTimeouts = parseTimeouts(
			input.timeouts,
			`${path}.timeouts`,
			unknownFields,
			agentId,
		);
		if (!parsedTimeouts.ok) return parsedTimeouts;
		result.timeouts = parsedTimeouts.value;
	}
	if (Object.hasOwn(input, 'versionFingerprint') && input.versionFingerprint !== undefined) {
		const parsedFingerprint = parseVersionFingerprint(
			input.versionFingerprint,
			`${path}.versionFingerprint`,
			unknownFields,
			agentId,
		);
		if (!parsedFingerprint.ok) return parsedFingerprint;
		result.versionFingerprint = parsedFingerprint.value;
	}
	if (Object.hasOwn(input, 'versionRange') && input.versionRange !== undefined) {
		const parsedRange = parseVersionRange(
			input.versionRange,
			`${path}.versionRange`,
			unknownFields,
			agentId,
		);
		if (!parsedRange.ok) return parsedRange;
		result.versionRange = parsedRange.value;
	}
	if (Object.hasOwn(input, 'loginProbe') && input.loginProbe !== undefined) {
		const parsedLoginProbe = parseLoginProbe(
			input.loginProbe,
			`${path}.loginProbe`,
			unknownFields,
			agentId,
		);
		if (!parsedLoginProbe.ok) return parsedLoginProbe;
		result.loginProbe = parsedLoginProbe.value;
	}
	if (Object.hasOwn(input, 'modelsLive') && input.modelsLive !== undefined) {
		const parsedModelsLive = parseModelsLive(
			input.modelsLive,
			`${path}.modelsLive`,
			unknownFields,
			agentId,
		);
		if (!parsedModelsLive.ok) return parsedModelsLive;
		result.modelsLive = parsedModelsLive.value;
	}
	if (Object.hasOwn(input, 'builtinModels') && input.builtinModels !== undefined) {
		const parsedBuiltinModels = parseBuiltinModels(
			input.builtinModels,
			`${path}.builtinModels`,
			unknownFields,
			agentId,
		);
		if (!parsedBuiltinModels.ok) return parsedBuiltinModels;
		result.builtinModels = parsedBuiltinModels.value;
	}
	if (Object.hasOwn(input, 'defaultEffortTier') && input.defaultEffortTier !== undefined) {
		const parsedDefaultEffortTier = parseDefaultEffortTier(
			input.defaultEffortTier,
			`${path}.defaultEffortTier`,
		);
		if (!parsedDefaultEffortTier.ok) return parsedDefaultEffortTier;
		result.defaultEffortTier = parsedDefaultEffortTier.value;
	}
	if (Object.hasOwn(input, 'effortVendorMap') && input.effortVendorMap !== undefined) {
		const parsedEffortVendorMap = parseEffortVendorMap(
			input.effortVendorMap,
			`${path}.effortVendorMap`,
		);
		if (!parsedEffortVendorMap.ok) return parsedEffortVendorMap;
		result.effortVendorMap = parsedEffortVendorMap.value;
	}

	return { ok: true, value: freezeAgentOverrides(result) };
}

function parseTimeouts(
	input: unknown,
	path: string,
	unknownFields: UnknownField[],
	agentId: string,
):
	| { readonly ok: true; readonly value: AgentTimeoutOverrides }
	| { readonly ok: false; readonly field: string; readonly expected: string } {
	if (!isRecord(input)) return { ok: false, field: path, expected: 'an object' };
	collectUnknownFields(input, TIMEOUT_FIELDS, path, unknownFields, agentId);
	const result: MutableAgentTimeoutOverrides = {};

	for (const field of TIMEOUT_FIELDS) {
		if (!Object.hasOwn(input, field)) continue;
		const minimum = field === 'hardWallClockMs' ? 0 : 1;
		if (!isSafeInteger(input[field]) || input[field] < minimum) {
			return {
				ok: false,
				field: `${path}.${field}`,
				expected: `an integer greater than or equal to ${minimum}`,
			};
		}
		result[field] = input[field];
	}

	return { ok: true, value: Object.freeze(result) };
}

function parseVersionRange(
	input: unknown,
	path: string,
	unknownFields: UnknownField[],
	agentId: string,
):
	| { readonly ok: true; readonly value: VersionRangeOverrides }
	| { readonly ok: false; readonly field: string; readonly expected: string } {
	if (!isRecord(input)) return { ok: false, field: path, expected: 'an object' };
	collectUnknownFields(input, VERSION_RANGE_FIELDS, path, unknownFields, agentId);
	const result: MutableVersionRangeOverrides = {};

	if (Object.hasOwn(input, 'min')) {
		if (typeof input.min !== 'string' || input.min.trim().length === 0) {
			return { ok: false, field: `${path}.min`, expected: 'a non-empty string' };
		}
		result.min = input.min.trim();
	}
	if (Object.hasOwn(input, 'max')) {
		if (typeof input.max !== 'string' || input.max.trim().length === 0) {
			return { ok: false, field: `${path}.max`, expected: 'a non-empty string' };
		}
		result.max = input.max.trim();
	}

	return { ok: true, value: Object.freeze(result) };
}

function parseVersionFingerprint(
	input: unknown,
	path: string,
	unknownFields: UnknownField[],
	agentId: string,
):
	| { readonly ok: true; readonly value: VersionFingerprintOverrides }
	| { readonly ok: false; readonly field: string; readonly expected: string } {
	if (!isRecord(input)) return { ok: false, field: path, expected: 'an object' };
	collectUnknownFields(input, VERSION_FINGERPRINT_FIELDS, path, unknownFields, agentId);
	const result: MutableVersionFingerprintOverrides = {};

	if (Object.hasOwn(input, 'args')) {
		const args = parseStringArray(input.args);
		if (args === undefined) {
			return { ok: false, field: `${path}.args`, expected: 'an array of strings' };
		}
		result.args = args;
	}
	if (Object.hasOwn(input, 'expectedPattern')) {
		if (typeof input.expectedPattern !== 'string' || input.expectedPattern.length === 0) {
			return { ok: false, field: `${path}.expectedPattern`, expected: 'a non-empty string' };
		}
		result.expectedPattern = input.expectedPattern;
	}

	return { ok: true, value: Object.freeze(result) };
}

function parseLoginProbe(
	input: unknown,
	path: string,
	unknownFields: UnknownField[],
	agentId: string,
):
	| { readonly ok: true; readonly value: LoginProbeOverrides }
	| { readonly ok: false; readonly field: string; readonly expected: string } {
	if (!isRecord(input)) return { ok: false, field: path, expected: 'an object' };
	collectUnknownFields(input, LOGIN_PROBE_FIELDS, path, unknownFields, agentId);
	const result: MutableLoginProbeOverrides = {};

	let parser: LoginProbeParser | undefined;
	if (Object.hasOwn(input, 'parser') && input.parser !== undefined) {
		if (!isLoginProbeParser(input.parser)) {
			return {
				ok: false,
				field: `${path}.parser`,
				expected:
					"one of 'codex_login_status', 'claude_auth_json', 'grok_models_exit', 'pi_auth_check', 'none'",
			};
		}
		parser = input.parser;
		result.parser = parser;
	}

	if (Object.hasOwn(input, 'args') && input.args !== undefined) {
		const args = parseStringArray(input.args);
		if (args === undefined) {
			return { ok: false, field: `${path}.args`, expected: 'an array of strings' };
		}
		for (const arg of args) {
			for (const forbidden of FORBIDDEN_LOGIN_PROBE_ARG_SUBSTRINGS) {
				if (arg.includes(forbidden)) {
					return {
						ok: false,
						field: `${path}.args`,
						expected: `arguments not containing forbidden credential inspection substring '${forbidden}'`,
					};
				}
			}
			if (
				arg.includes('{provider}') &&
				parser !== 'pi_auth_check' &&
				(parser !== undefined || agentId !== 'pi')
			) {
				return {
					ok: false,
					field: `${path}.args`,
					expected: '{provider} variable is only allowed when parser is pi_auth_check',
				};
			}
		}
		result.args = args;
	}

	if (Object.hasOwn(input, 'loggedInPattern') && input.loggedInPattern !== undefined) {
		if (input.loggedInPattern !== null && typeof input.loggedInPattern !== 'string') {
			return { ok: false, field: `${path}.loggedInPattern`, expected: 'a string or null' };
		}
		result.loggedInPattern = input.loggedInPattern;
	}

	if (Object.hasOwn(input, 'loggedOutPattern') && input.loggedOutPattern !== undefined) {
		if (input.loggedOutPattern !== null && typeof input.loggedOutPattern !== 'string') {
			return { ok: false, field: `${path}.loggedOutPattern`, expected: 'a string or null' };
		}
		result.loggedOutPattern = input.loggedOutPattern;
	}

	if (Object.hasOwn(input, 'loginCommandHint') && input.loginCommandHint !== undefined) {
		if (input.loginCommandHint !== null && typeof input.loginCommandHint !== 'string') {
			return { ok: false, field: `${path}.loginCommandHint`, expected: 'a string or null' };
		}
		if (typeof input.loginCommandHint === 'string') {
			if (
				input.loginCommandHint.length > 200 ||
				// biome-ignore lint/suspicious/noControlCharactersInRegex: Checking for control characters per E-355
				/[\x00-\x1F\x7F]/.test(input.loginCommandHint)
			) {
				unknownFields.push(
					Object.freeze({
						field: `${path}.loginCommandHint`,
						agentId,
					}),
				);
				result.loginCommandHint = null;
			} else {
				result.loginCommandHint = input.loginCommandHint;
			}
		} else {
			result.loginCommandHint = null;
		}
	}

	return { ok: true, value: Object.freeze(result) };
}

function parseModelsLive(
	input: unknown,
	path: string,
	unknownFields: UnknownField[],
	agentId: string,
):
	| { readonly ok: true; readonly value: ModelsLiveOverrides }
	| { readonly ok: false; readonly field: string; readonly expected: string } {
	if (!isRecord(input)) return { ok: false, field: path, expected: 'an object' };
	collectUnknownFields(input, MODELS_LIVE_FIELDS, path, unknownFields, agentId);
	const result: MutableModelsLiveOverrides = {};

	if (Object.hasOwn(input, 'kind') && input.kind !== undefined) {
		if (input.kind !== 'command' && input.kind !== 'codex_app_server' && input.kind !== 'none') {
			return {
				ok: false,
				field: `${path}.kind`,
				expected: "one of 'command', 'codex_app_server', 'none'",
			};
		}
		result.kind = input.kind;
	}

	if (Object.hasOwn(input, 'args') && input.args !== undefined) {
		const args = parseStringArray(input.args);
		if (args === undefined) {
			return { ok: false, field: `${path}.args`, expected: 'an array of strings' };
		}
		result.args = args;
	}

	if (Object.hasOwn(input, 'parser') && input.parser !== undefined) {
		if (
			input.parser !== 'grok_models_text' &&
			input.parser !== 'pi_list_models_table' &&
			input.parser !== 'codex_model_list_jsonrpc' &&
			input.parser !== 'none'
		) {
			return {
				ok: false,
				field: `${path}.parser`,
				expected:
					"one of 'grok_models_text', 'pi_list_models_table', 'codex_model_list_jsonrpc', 'none'",
			};
		}
		result.parser = input.parser;
	}

	if (Object.hasOwn(input, 'timeoutMs') && input.timeoutMs !== undefined) {
		if (!isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 60000) {
			return {
				ok: false,
				field: `${path}.timeoutMs`,
				expected: 'an integer between 1000 and 60000',
			};
		}
		result.timeoutMs = input.timeoutMs;
	}

	return { ok: true, value: Object.freeze(result) };
}

function parseBuiltinModels(
	input: unknown,
	path: string,
	_unknownFields: UnknownField[],
	_agentId: string,
):
	| { readonly ok: true; readonly value: readonly BuiltinModelDto[] }
	| {
			readonly ok: false;
			readonly field: string;
			readonly expected: string;
			readonly rejectAgentOnly?: boolean;
	  } {
	if (!Array.isArray(input)) {
		return { ok: false, field: path, expected: 'an array of models', rejectAgentOnly: false };
	}
	const result: BuiltinModelDto[] = [];
	for (let i = 0; i < input.length; i++) {
		const item = input[i];
		if (!isRecord(item) || typeof item.name !== 'string') {
			return {
				ok: false,
				field: `${path}[${i}]`,
				expected: 'an object with a string name property',
				rejectAgentOnly: false,
			};
		}
		const name = item.name;
		// E-350 / Criterion 5: Items whose name contains whitespace or control characters reject this agent
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Checking for control characters per E-350
		if (name.length === 0 || /\s|[\x00-\x1F\x7F]/.test(name)) {
			return {
				ok: false,
				field: `${path}[${i}].name`,
				expected: 'a non-empty string without whitespace or control characters',
				rejectAgentOnly: true,
			};
		}
		const note = typeof item.note === 'string' ? item.note : undefined;
		result.push(Object.freeze({ name, ...(note !== undefined ? { note } : {}) }));
	}
	return { ok: true, value: Object.freeze(result) };
}

function parseDefaultEffortTier(
	input: unknown,
	path: string,
):
	| { readonly ok: true; readonly value: EffortValue }
	| { readonly ok: false; readonly field: string; readonly expected: string } {
	if (input === null) return { ok: true, value: null };
	if (!isRecord(input)) {
		return {
			ok: false,
			field: path,
			expected: "null, { tier: 'low'|'medium'|'high' }, or { vendor: string }",
		};
	}
	if (Object.hasOwn(input, 'tier')) {
		if (typeof input.tier !== 'string' || !isEffortTier(input.tier)) {
			return {
				ok: false,
				field: `${path}.tier`,
				expected: "one of 'low', 'medium', 'high'",
			};
		}
		return { ok: true, value: Object.freeze({ tier: input.tier }) };
	}
	if (Object.hasOwn(input, 'vendor')) {
		if (typeof input.vendor !== 'string' || input.vendor.trim().length === 0) {
			return {
				ok: false,
				field: `${path}.vendor`,
				expected: 'a non-empty string',
			};
		}
		return { ok: true, value: Object.freeze({ vendor: input.vendor }) };
	}
	return {
		ok: false,
		field: path,
		expected: "an object with 'tier' or 'vendor'",
	};
}

function parseEffortVendorMap(
	input: unknown,
	path: string,
):
	| { readonly ok: true; readonly value: EffortVendorMap }
	| { readonly ok: false; readonly field: string; readonly expected: string } {
	if (input === null) return { ok: true, value: null };
	if (!isRecord(input)) {
		return {
			ok: false,
			field: path,
			expected: 'null or an object with { low, medium, high }',
		};
	}
	for (const tier of ['low', 'medium', 'high'] as const) {
		if (typeof input[tier] !== 'string' || (input[tier] as string).trim().length === 0) {
			return {
				ok: false,
				field: `${path}.${tier}`,
				expected: 'a non-empty string',
			};
		}
	}
	return {
		ok: true,
		value: Object.freeze({
			low: (input.low as string).trim(),
			medium: (input.medium as string).trim(),
			high: (input.high as string).trim(),
		}),
	};
}

function createSnapshot(
	generation: number,
	fingerprint: string | null,
	builtInDefaults: Readonly<Record<string, AgentConfig>>,
	storedDefaultOverrides: AgentConfigLayer,
	userOverrides: AgentConfigLayer,
): AgentRegistrySnapshot {
	const storedDefaults = mergeAgentConfigRecord(builtInDefaults, storedDefaultOverrides);
	const agents = resolveAgentConfigRecord(builtInDefaults, userOverrides);
	return Object.freeze({
		generation,
		fingerprint,
		agents,
		builtInDefaults,
		storedDefaults,
		userOverrides: freezeAgentConfigLayer(userOverrides),
		defaultUpdates: calculateDefaultUpdates(builtInDefaults, storedDefaults, userOverrides),
	});
}

function mergeAgentConfigRecord(
	defaults: Readonly<Record<string, AgentConfig>>,
	overrides: AgentConfigLayer,
): Readonly<Record<string, AgentConfig>> {
	const result: Record<string, AgentConfig> = {};
	for (const [agentId, defaultConfig] of Object.entries(defaults)) {
		result[agentId] = mergeAgentConfig(defaultConfig, overrides[agentId] ?? {});
	}
	return Object.freeze(result);
}

function resolveAgentConfigRecord(
	defaults: Readonly<Record<string, AgentConfig>>,
	overrides: AgentConfigLayer,
): Readonly<Record<string, ResolvedAgentConfig>> {
	const result: Record<string, ResolvedAgentConfig> = {};
	for (const [agentId, defaultConfig] of Object.entries(defaults)) {
		const config = mergeAgentConfig(defaultConfig, overrides[agentId] ?? {});
		result[agentId] = Object.freeze({ ...config, isEnabled: config.maxConcurrency > 0 });
	}
	return Object.freeze(result);
}

function mergeAgentConfig(
	defaultConfig: AgentConfig,
	overrides: AgentConfigOverrides,
): AgentConfig {
	const adapterKind = valueOr(overrides.adapterKind, defaultConfig.adapterKind);
	const adapterTimeouts = createDefaultTimeouts(adapterKind);
	const timeoutOverrides = overrides.timeouts ?? {};
	const versionOverrides = overrides.versionFingerprint ?? {};
	const versionRangeOverrides = overrides.versionRange;
	const startupFallback =
		adapterKind === defaultConfig.adapterKind
			? defaultConfig.timeouts.startupTimeoutMs
			: adapterTimeouts.startupTimeoutMs;

	const defaultLoginProbe = defaultConfig.loginProbe ?? GENERIC_LOGIN_PROBE_DEFAULT;
	const loginOverrides = overrides.loginProbe ?? {};
	const defaultModelsLive = defaultConfig.modelsLive ?? GENERIC_MODELS_LIVE_DEFAULT;
	const modelsLiveOverrides = overrides.modelsLive ?? {};

	return freezeAgentConfig({
		execPath: valueOr(overrides.execPath, defaultConfig.execPath),
		argsTemplate: valueOr(overrides.argsTemplate, defaultConfig.argsTemplate),
		maxConcurrency: valueOr(overrides.maxConcurrency, defaultConfig.maxConcurrency),
		defaultModel: valueOr(overrides.defaultModel, defaultConfig.defaultModel),
		permissionTier: valueOr(overrides.permissionTier, defaultConfig.permissionTier),
		monogram: valueOr(overrides.monogram, defaultConfig.monogram),
		adapterKind,
		timeouts: {
			startupTimeoutMs: valueOr(timeoutOverrides.startupTimeoutMs, startupFallback),
			idleTimeoutMs: valueOr(timeoutOverrides.idleTimeoutMs, defaultConfig.timeouts.idleTimeoutMs),
			hardWallClockMs: valueOr(
				timeoutOverrides.hardWallClockMs,
				defaultConfig.timeouts.hardWallClockMs,
			),
		},
		versionFingerprint: {
			args: valueOr(versionOverrides.args, defaultConfig.versionFingerprint.args),
			expectedPattern: valueOr(
				versionOverrides.expectedPattern,
				defaultConfig.versionFingerprint.expectedPattern,
			),
		},
		versionRange: versionRangeOverrides
			? {
					min: versionRangeOverrides.min ?? defaultConfig.versionRange?.min,
					max: versionRangeOverrides.max ?? defaultConfig.versionRange?.max,
				}
			: defaultConfig.versionRange,
		loginProbe: {
			args: valueOr(loginOverrides.args, defaultLoginProbe.args),
			parser: valueOr(loginOverrides.parser, defaultLoginProbe.parser),
			loggedInPattern: valueOr(loginOverrides.loggedInPattern, defaultLoginProbe.loggedInPattern),
			loggedOutPattern: valueOr(
				loginOverrides.loggedOutPattern,
				defaultLoginProbe.loggedOutPattern,
			),
			loginCommandHint: valueOr(
				loginOverrides.loginCommandHint,
				defaultLoginProbe.loginCommandHint,
			),
		},
		modelsLive: {
			kind: valueOr(modelsLiveOverrides.kind, defaultModelsLive.kind),
			args: valueOr(modelsLiveOverrides.args, defaultModelsLive.args),
			parser: valueOr(modelsLiveOverrides.parser, defaultModelsLive.parser),
			timeoutMs: valueOr(modelsLiveOverrides.timeoutMs, defaultModelsLive.timeoutMs),
		},
		builtinModels: valueOr(overrides.builtinModels, defaultConfig.builtinModels),
		defaultEffortTier: valueOr(overrides.defaultEffortTier, defaultConfig.defaultEffortTier),
		effortVendorMap: valueOr(overrides.effortVendorMap, defaultConfig.effortVendorMap),
	});
}

function calculateDefaultUpdates(
	builtInDefaults: Readonly<Record<string, AgentConfig>>,
	storedDefaults: Readonly<Record<string, AgentConfig>>,
	userOverrides: AgentConfigLayer,
): readonly AgentDefaultUpdate[] {
	const result: AgentDefaultUpdate[] = [];
	for (const [agentId, overrides] of Object.entries(userOverrides)) {
		const currentDefaults = builtInDefaults[agentId];
		const previousDefaults = storedDefaults[agentId];
		if (currentDefaults === undefined || previousDefaults === undefined) continue;

		for (const field of AGENT_CONFIG_FIELD_PATHS) {
			const userValue = getOverrideField(overrides, field);
			if (userValue === undefined) continue;
			const oldValue = getConfigField(previousDefaults, field);
			const newValue = getConfigField(currentDefaults, field);
			if (configValuesEqual(oldValue, newValue)) continue;
			result.push(Object.freeze({ agentId, field, oldValue, newValue, userValue }));
		}
	}
	return Object.freeze(result);
}

function createAdoptedAgentsFile(
	snapshot: AgentRegistrySnapshot,
	update: AgentDefaultUpdate,
): Required<AgentsFileConfig> {
	const defaults = mutableFullConfigRecord(snapshot.storedDefaults);
	const overrides = mutableOverrideRecord(snapshot.userOverrides);
	setConfigField(defaults[update.agentId], update.field, update.newValue);
	deleteOverrideField(overrides[update.agentId], update.field);
	return {
		schemaVersion: AGENT_REGISTRY_SCHEMA_VERSION,
		defaults: freezeAgentConfigLayer(defaults),
		overrides: freezeAgentConfigLayer(overrides),
	};
}

function serializeAgentsFile(config: Required<AgentsFileConfig>): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}

function hasCompleteDefaultBaseline(
	defaults: AgentConfigLayer,
	builtInDefaults: Readonly<Record<string, AgentConfig>>,
): boolean {
	return Object.keys(builtInDefaults).every((agentId) => {
		const storedDefault = defaults[agentId];
		return (
			storedDefault !== undefined &&
			AGENT_CONFIG_FIELD_PATHS.every(
				(field) => getOverrideField(storedDefault, field) !== undefined,
			)
		);
	});
}

function getConfigField(config: AgentConfig, field: AgentConfigFieldPath): AgentConfigValue {
	switch (field) {
		case 'execPath':
		case 'argsTemplate':
		case 'maxConcurrency':
		case 'defaultModel':
		case 'permissionTier':
		case 'monogram':
		case 'adapterKind':
			return config[field];
		case 'timeouts.startupTimeoutMs':
			return config.timeouts.startupTimeoutMs;
		case 'timeouts.idleTimeoutMs':
			return config.timeouts.idleTimeoutMs;
		case 'timeouts.hardWallClockMs':
			return config.timeouts.hardWallClockMs;
		case 'versionFingerprint.args':
			return config.versionFingerprint.args;
		case 'versionFingerprint.expectedPattern':
			return config.versionFingerprint.expectedPattern;
		case 'loginProbe.args':
			return config.loginProbe.args;
		case 'loginProbe.parser':
			return config.loginProbe.parser;
		case 'loginProbe.loggedInPattern':
			return config.loginProbe.loggedInPattern;
		case 'loginProbe.loggedOutPattern':
			return config.loginProbe.loggedOutPattern;
		case 'loginProbe.loginCommandHint':
			return config.loginProbe.loginCommandHint;
		case 'modelsLive.kind':
			return config.modelsLive.kind;
		case 'modelsLive.args':
			return config.modelsLive.args;
		case 'modelsLive.parser':
			return config.modelsLive.parser;
		case 'modelsLive.timeoutMs':
			return config.modelsLive.timeoutMs;
		case 'builtinModels':
			return config.builtinModels;
		case 'defaultEffortTier':
			return config.defaultEffortTier;
		case 'effortVendorMap':
			return config.effortVendorMap;
	}
}

function getOverrideField(
	overrides: AgentConfigOverrides,
	field: AgentConfigFieldPath,
): AgentConfigValue | undefined {
	switch (field) {
		case 'execPath':
		case 'argsTemplate':
		case 'maxConcurrency':
		case 'defaultModel':
		case 'permissionTier':
		case 'monogram':
		case 'adapterKind':
			return Object.hasOwn(overrides, field) ? overrides[field] : undefined;
		case 'timeouts.startupTimeoutMs':
			return ownOptionalValue(overrides.timeouts, 'startupTimeoutMs');
		case 'timeouts.idleTimeoutMs':
			return ownOptionalValue(overrides.timeouts, 'idleTimeoutMs');
		case 'timeouts.hardWallClockMs':
			return ownOptionalValue(overrides.timeouts, 'hardWallClockMs');
		case 'versionFingerprint.args':
			return ownOptionalValue(overrides.versionFingerprint, 'args');
		case 'versionFingerprint.expectedPattern':
			return ownOptionalValue(overrides.versionFingerprint, 'expectedPattern');
		case 'loginProbe.args':
			return ownOptionalValue(overrides.loginProbe, 'args');
		case 'loginProbe.parser':
			return ownOptionalValue(overrides.loginProbe, 'parser');
		case 'loginProbe.loggedInPattern':
			return ownOptionalValue(overrides.loginProbe, 'loggedInPattern');
		case 'loginProbe.loggedOutPattern':
			return ownOptionalValue(overrides.loginProbe, 'loggedOutPattern');
		case 'loginProbe.loginCommandHint':
			return ownOptionalValue(overrides.loginProbe, 'loginCommandHint');
		case 'modelsLive.kind':
			return ownOptionalValue(overrides.modelsLive, 'kind');
		case 'modelsLive.args':
			return ownOptionalValue(overrides.modelsLive, 'args');
		case 'modelsLive.parser':
			return ownOptionalValue(overrides.modelsLive, 'parser');
		case 'modelsLive.timeoutMs':
			return ownOptionalValue(overrides.modelsLive, 'timeoutMs');
		case 'builtinModels':
			return Object.hasOwn(overrides, 'builtinModels') ? overrides.builtinModels : undefined;
		case 'defaultEffortTier':
			return Object.hasOwn(overrides, 'defaultEffortTier')
				? overrides.defaultEffortTier
				: undefined;
		case 'effortVendorMap':
			return Object.hasOwn(overrides, 'effortVendorMap') ? overrides.effortVendorMap : undefined;
	}
}

function setConfigField(
	config: MutableAgentConfigOverrides | undefined,
	field: AgentConfigFieldPath,
	value: AgentConfigValue,
): void {
	if (config === undefined) return;
	switch (field) {
		case 'execPath':
			config.execPath = value as string;
			return;
		case 'argsTemplate':
			config.argsTemplate = value as readonly string[];
			return;
		case 'maxConcurrency':
			config.maxConcurrency = value as number;
			return;
		case 'defaultModel':
			config.defaultModel = value as string | null;
			return;
		case 'permissionTier':
			config.permissionTier = value as PermissionTier;
			return;
		case 'monogram':
			config.monogram = value as string;
			return;
		case 'adapterKind':
			config.adapterKind = value as AdapterKind;
			return;
		case 'timeouts.startupTimeoutMs':
			config.timeouts = { ...config.timeouts, startupTimeoutMs: value as number };
			return;
		case 'timeouts.idleTimeoutMs':
			config.timeouts = { ...config.timeouts, idleTimeoutMs: value as number };
			return;
		case 'timeouts.hardWallClockMs':
			config.timeouts = { ...config.timeouts, hardWallClockMs: value as number };
			return;
		case 'versionFingerprint.args':
			config.versionFingerprint = {
				...config.versionFingerprint,
				args: value as readonly string[],
			};
			return;
		case 'versionFingerprint.expectedPattern':
			config.versionFingerprint = {
				...config.versionFingerprint,
				expectedPattern: value as string,
			};
			return;
		case 'loginProbe.args':
			config.loginProbe = {
				...config.loginProbe,
				args: value as readonly string[],
			};
			return;
		case 'loginProbe.parser':
			config.loginProbe = {
				...config.loginProbe,
				parser: value as LoginProbeParser,
			};
			return;
		case 'loginProbe.loggedInPattern':
			config.loginProbe = {
				...config.loginProbe,
				loggedInPattern: value as string | null,
			};
			return;
		case 'loginProbe.loggedOutPattern':
			config.loginProbe = {
				...config.loginProbe,
				loggedOutPattern: value as string | null,
			};
			return;
		case 'loginProbe.loginCommandHint':
			config.loginProbe = {
				...config.loginProbe,
				loginCommandHint: value as string | null,
			};
			return;
		case 'modelsLive.kind':
			config.modelsLive = {
				...config.modelsLive,
				kind: value as ModelsLiveKind,
			};
			return;
		case 'modelsLive.args':
			config.modelsLive = {
				...config.modelsLive,
				args: value as readonly string[],
			};
			return;
		case 'modelsLive.parser':
			config.modelsLive = {
				...config.modelsLive,
				parser: value as ModelsLiveParser,
			};
			return;
		case 'modelsLive.timeoutMs':
			config.modelsLive = {
				...config.modelsLive,
				timeoutMs: value as number,
			};
			return;
		case 'builtinModels':
			config.builtinModels = value as readonly BuiltinModelDto[];
			return;
		case 'defaultEffortTier':
			config.defaultEffortTier = value as EffortValue;
			return;
		case 'effortVendorMap':
			config.effortVendorMap = value as EffortVendorMap;
			return;
	}
}

function deleteOverrideField(
	overrides: MutableAgentConfigOverrides | undefined,
	field: AgentConfigFieldPath,
): void {
	if (overrides === undefined) return;
	switch (field) {
		case 'execPath':
			overrides.execPath = undefined;
			return;
		case 'argsTemplate':
			overrides.argsTemplate = undefined;
			return;
		case 'maxConcurrency':
			overrides.maxConcurrency = undefined;
			return;
		case 'defaultModel':
			overrides.defaultModel = undefined;
			return;
		case 'permissionTier':
			overrides.permissionTier = undefined;
			return;
		case 'monogram':
			overrides.monogram = undefined;
			return;
		case 'adapterKind':
			overrides.adapterKind = undefined;
			return;
		case 'timeouts.startupTimeoutMs':
			if (overrides.timeouts !== undefined) {
				overrides.timeouts.startupTimeoutMs = undefined;
			}
			break;
		case 'timeouts.idleTimeoutMs':
			if (overrides.timeouts !== undefined) overrides.timeouts.idleTimeoutMs = undefined;
			break;
		case 'timeouts.hardWallClockMs':
			if (overrides.timeouts !== undefined) overrides.timeouts.hardWallClockMs = undefined;
			break;
		case 'versionFingerprint.args':
			if (overrides.versionFingerprint !== undefined) {
				overrides.versionFingerprint.args = undefined;
			}
			break;
		case 'versionFingerprint.expectedPattern':
			if (overrides.versionFingerprint !== undefined) {
				overrides.versionFingerprint.expectedPattern = undefined;
			}
			break;
		case 'loginProbe.args':
			if (overrides.loginProbe !== undefined) overrides.loginProbe.args = undefined;
			break;
		case 'loginProbe.parser':
			if (overrides.loginProbe !== undefined) overrides.loginProbe.parser = undefined;
			break;
		case 'loginProbe.loggedInPattern':
			if (overrides.loginProbe !== undefined) overrides.loginProbe.loggedInPattern = undefined;
			break;
		case 'loginProbe.loggedOutPattern':
			if (overrides.loginProbe !== undefined) overrides.loginProbe.loggedOutPattern = undefined;
			break;
		case 'loginProbe.loginCommandHint':
			if (overrides.loginProbe !== undefined) overrides.loginProbe.loginCommandHint = undefined;
			break;
		case 'modelsLive.kind':
			if (overrides.modelsLive !== undefined) overrides.modelsLive.kind = undefined;
			break;
		case 'modelsLive.args':
			if (overrides.modelsLive !== undefined) overrides.modelsLive.args = undefined;
			break;
		case 'modelsLive.parser':
			if (overrides.modelsLive !== undefined) overrides.modelsLive.parser = undefined;
			break;
		case 'modelsLive.timeoutMs':
			if (overrides.modelsLive !== undefined) overrides.modelsLive.timeoutMs = undefined;
			break;
		case 'builtinModels':
			overrides.builtinModels = undefined;
			return;
		case 'defaultEffortTier':
			overrides.defaultEffortTier = undefined;
			return;
		case 'effortVendorMap':
			overrides.effortVendorMap = undefined;
			return;
	}
	if (overrides.timeouts !== undefined && Object.keys(overrides.timeouts).length === 0) {
		overrides.timeouts = undefined;
	}
	if (
		overrides.versionFingerprint !== undefined &&
		Object.keys(overrides.versionFingerprint).length === 0
	) {
		overrides.versionFingerprint = undefined;
	}
	if (overrides.loginProbe !== undefined && Object.keys(overrides.loginProbe).length === 0) {
		overrides.loginProbe = undefined;
	}
	if (overrides.modelsLive !== undefined && Object.keys(overrides.modelsLive).length === 0) {
		overrides.modelsLive = undefined;
	}
}

function mutableFullConfigRecord(
	configs: Readonly<Record<string, AgentConfig>>,
): Record<string, MutableAgentConfigOverrides> {
	const result: Record<string, MutableAgentConfigOverrides> = {};
	for (const [agentId, config] of Object.entries(configs)) {
		result[agentId] = {
			execPath: config.execPath,
			argsTemplate: [...config.argsTemplate],
			maxConcurrency: config.maxConcurrency,
			defaultModel: config.defaultModel,
			permissionTier: config.permissionTier,
			monogram: config.monogram,
			adapterKind: config.adapterKind,
			timeouts: { ...config.timeouts },
			versionFingerprint: {
				args: [...config.versionFingerprint.args],
				expectedPattern: config.versionFingerprint.expectedPattern,
			},
			loginProbe: {
				args: [...config.loginProbe.args],
				parser: config.loginProbe.parser,
				loggedInPattern: config.loginProbe.loggedInPattern,
				loggedOutPattern: config.loginProbe.loggedOutPattern,
				loginCommandHint: config.loginProbe.loginCommandHint,
			},
			modelsLive: {
				kind: config.modelsLive?.kind ?? 'none',
				args: [...(config.modelsLive?.args ?? [])],
				parser: config.modelsLive?.parser ?? 'none',
				timeoutMs: config.modelsLive?.timeoutMs ?? 5000,
			},
			builtinModels: [...(config.builtinModels ?? [])],
			defaultEffortTier: config.defaultEffortTier ?? null,
			effortVendorMap: config.effortVendorMap ? { ...config.effortVendorMap } : null,
		};
	}
	return result;
}

function mutableOverrideRecord(
	layer: AgentConfigLayer,
): Record<string, MutableAgentConfigOverrides> {
	const result: Record<string, MutableAgentConfigOverrides> = {};
	for (const [agentId, overrides] of Object.entries(layer)) {
		result[agentId] = {
			...overrides,
			argsTemplate: overrides.argsTemplate === undefined ? undefined : [...overrides.argsTemplate],
			timeouts: overrides.timeouts === undefined ? undefined : { ...overrides.timeouts },
			versionFingerprint:
				overrides.versionFingerprint === undefined
					? undefined
					: {
							...overrides.versionFingerprint,
							args:
								overrides.versionFingerprint.args === undefined
									? undefined
									: [...overrides.versionFingerprint.args],
						},
			loginProbe:
				overrides.loginProbe === undefined
					? undefined
					: {
							...overrides.loginProbe,
							args:
								overrides.loginProbe.args === undefined
									? undefined
									: [...overrides.loginProbe.args],
						},
			modelsLive:
				overrides.modelsLive === undefined
					? undefined
					: {
							...overrides.modelsLive,
							args:
								overrides.modelsLive.args === undefined
									? undefined
									: [...overrides.modelsLive.args],
						},
			builtinModels:
				overrides.builtinModels === undefined ? undefined : [...overrides.builtinModels],
			defaultEffortTier: overrides.defaultEffortTier,
			effortVendorMap:
				overrides.effortVendorMap === undefined
					? undefined
					: overrides.effortVendorMap === null
						? null
						: { ...overrides.effortVendorMap },
		};
	}
	return result;
}

function freezeAgentConfigRecord(
	configs: Readonly<Record<string, AgentConfig>>,
): Readonly<Record<string, AgentConfig>> {
	const result: Record<string, AgentConfig> = {};
	for (const [agentId, config] of Object.entries(configs)) {
		result[agentId] = freezeAgentConfig(config);
	}
	return Object.freeze(result);
}

function freezeAgentConfigLayer(layer: AgentConfigLayer): AgentConfigLayer {
	const result: Record<string, AgentConfigOverrides> = {};
	for (const [agentId, overrides] of Object.entries(layer)) {
		result[agentId] = freezeAgentOverrides(overrides);
	}
	return Object.freeze(result);
}

function freezeAgentConfig(config: AgentConfig): AgentConfig {
	const defaultModelsLive = config.modelsLive ?? GENERIC_MODELS_LIVE_DEFAULT;
	const defaultBuiltinModels = config.builtinModels ?? [];
	return Object.freeze({
		...config,
		argsTemplate: Object.freeze([...config.argsTemplate]),
		timeouts: Object.freeze({ ...config.timeouts }),
		versionFingerprint: Object.freeze({
			...config.versionFingerprint,
			args: Object.freeze([...config.versionFingerprint.args]),
		}),
		loginProbe: Object.freeze({
			...(config.loginProbe ?? GENERIC_LOGIN_PROBE_DEFAULT),
			args: Object.freeze([...(config.loginProbe?.args ?? [])]),
		}),
		modelsLive: Object.freeze({
			...defaultModelsLive,
			args: Object.freeze([...(defaultModelsLive.args ?? [])]),
		}),
		builtinModels: Object.freeze(defaultBuiltinModels.map((b) => Object.freeze({ ...b }))),
		defaultEffortTier: config.defaultEffortTier ?? null,
		effortVendorMap: config.effortVendorMap ? Object.freeze({ ...config.effortVendorMap }) : null,
	});
}

function freezeAgentOverrides(overrides: AgentConfigOverrides): AgentConfigOverrides {
	return Object.freeze({
		...overrides,
		argsTemplate:
			overrides.argsTemplate === undefined ? undefined : Object.freeze([...overrides.argsTemplate]),
		timeouts:
			overrides.timeouts === undefined ? undefined : Object.freeze({ ...overrides.timeouts }),
		versionFingerprint:
			overrides.versionFingerprint === undefined
				? undefined
				: Object.freeze({
						...overrides.versionFingerprint,
						args:
							overrides.versionFingerprint.args === undefined
								? undefined
								: Object.freeze([...overrides.versionFingerprint.args]),
					}),
		loginProbe:
			overrides.loginProbe === undefined
				? undefined
				: Object.freeze({
						...overrides.loginProbe,
						args:
							overrides.loginProbe.args === undefined
								? undefined
								: Object.freeze([...overrides.loginProbe.args]),
					}),
		modelsLive:
			overrides.modelsLive === undefined
				? undefined
				: Object.freeze({
						...overrides.modelsLive,
						args:
							overrides.modelsLive.args === undefined
								? undefined
								: Object.freeze([...overrides.modelsLive.args]),
					}),
		builtinModels:
			overrides.builtinModels === undefined
				? undefined
				: Object.freeze(overrides.builtinModels.map((b) => Object.freeze({ ...b }))),
		effortVendorMap:
			overrides.effortVendorMap === undefined
				? undefined
				: overrides.effortVendorMap === null
					? null
					: Object.freeze({ ...overrides.effortVendorMap }),
	});
}

function collectUnknownFields(
	input: Record<string, unknown>,
	allowedFields: readonly string[],
	path: string,
	unknownFields: UnknownField[],
	agentId?: string,
): void {
	for (const field of Object.keys(input)) {
		if (!allowedFields.includes(field)) {
			unknownFields.push(Object.freeze({ field: `${path}.${field}`, agentId }));
		}
	}
}

function isLoginProbeParser(input: unknown): input is LoginProbeParser {
	return Object.values(LOGIN_PROBE_PARSERS).some((parser) => parser === input);
}

function parseStringArray(input: unknown): readonly string[] | undefined {
	if (!Array.isArray(input) || !input.every((value) => typeof value === 'string')) return undefined;
	return Object.freeze([...input]);
}

function isAdapterKind(input: unknown): input is AdapterKind {
	return Object.values(ADAPTER_KINDS).some((adapterKind) => adapterKind === input);
}

function isSafeInteger(input: unknown): input is number {
	return typeof input === 'number' && Number.isSafeInteger(input);
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isFileNotFound(cause: unknown): boolean {
	return isRecord(cause) && cause.code === 'ENOENT';
}

function fingerprintContents(contents: string): string {
	return createHash('sha256').update(contents, 'utf8').digest('hex');
}

function valueOr<T>(value: T | undefined, fallback: T): T {
	return value === undefined ? fallback : value;
}

function ownOptionalValue<T extends object, K extends keyof T>(
	object: T | undefined,
	key: K,
): T[K] | undefined {
	return object !== undefined && Object.hasOwn(object, key) ? object[key] : undefined;
}

function configValuesEqual(left: AgentConfigValue, right: AgentConfigValue): boolean {
	if (left === right) return true;
	if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
		return JSON.stringify(left) === JSON.stringify(right);
	}
	return false;
}
