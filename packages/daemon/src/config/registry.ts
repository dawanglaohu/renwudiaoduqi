import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
	type PlatformTarget,
	detectSessionDirOverlaps,
	validateLaunchTemplate,
} from '../domain/launch-template.ts';
import {
	ADAPTER_KINDS,
	type AdapterKind,
	type AgentConfig,
	BUILT_IN_AGENT_DEFAULTS,
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
	'monogram',
	'adapterKind',
	'timeouts',
	'versionFingerprint',
] as const;

const TIMEOUT_FIELDS = ['startupTimeoutMs', 'idleTimeoutMs', 'hardWallClockMs'] as const;
const VERSION_FINGERPRINT_FIELDS = ['args', 'expectedPattern'] as const;
const ROOT_FIELDS = ['schemaVersion', 'defaults', 'overrides'] as const;

export const AGENT_CONFIG_FIELD_PATHS = [
	'execPath',
	'argsTemplate',
	'maxConcurrency',
	'defaultModel',
	'monogram',
	'adapterKind',
	'timeouts.startupTimeoutMs',
	'timeouts.idleTimeoutMs',
	'timeouts.hardWallClockMs',
	'versionFingerprint.args',
	'versionFingerprint.expectedPattern',
] as const;

export type AgentConfigFieldPath = (typeof AGENT_CONFIG_FIELD_PATHS)[number];

export interface AgentTimeoutOverrides {
	readonly startupTimeoutMs?: number;
	readonly idleTimeoutMs?: number;
	readonly hardWallClockMs?: number;
}

export interface VersionFingerprintOverrides {
	readonly args?: readonly string[];
	readonly expectedPattern?: string;
}

export interface AgentConfigOverrides {
	readonly execPath?: string;
	readonly argsTemplate?: readonly string[];
	readonly maxConcurrency?: number;
	readonly defaultModel?: string | null;
	readonly monogram?: string;
	readonly adapterKind?: AdapterKind;
	readonly timeouts?: AgentTimeoutOverrides;
	readonly versionFingerprint?: VersionFingerprintOverrides;
}

export type AgentConfigLayer = Readonly<Record<string, AgentConfigOverrides>>;

export interface AgentsFileConfig {
	readonly schemaVersion?: number;
	readonly defaults?: AgentConfigLayer;
	readonly overrides?: AgentConfigLayer;
}

export type AgentConfigValue = string | number | null | readonly string[];

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
	readonly publishWarning: (warning: AgentRegistryWarning) => void;
	readonly onReload?: (snapshot: AgentRegistrySnapshot) => void;
	readonly builtInDefaults?: Readonly<Record<string, AgentConfig>>;
	readonly fileSystem?: AgentRegistryFileSystem;
	readonly timers?: AgentRegistryTimers;
	readonly platform?: PlatformTarget;
}

export interface AgentRegistry {
	readonly configPath: string;
	start(): Promise<AgentRegistrySnapshot>;
	stop(): void;
	reload(): Promise<AgentRegistryReloadResult>;
	getSnapshot(): AgentRegistrySnapshot;
	adoptDefault(agentId: string, field: AgentConfigFieldPath): Promise<AdoptDefaultResult>;
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
				versionFingerprint: {
					type: 'object',
					additionalProperties: true,
					properties: {
						args: { type: 'array', items: { type: 'string' } },
						expectedPattern: { type: 'string', minLength: 1 },
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

	return Object.freeze({
		configPath,
		start,
		stop,
		reload,
		getSnapshot: () => current,
		adoptDefault,
	});
}

interface UnknownField {
	readonly field: string;
	readonly agentId?: string;
}

type ParseAgentsFileResult =
	| {
			readonly ok: true;
			readonly defaults: AgentConfigLayer;
			readonly overrides: AgentConfigLayer;
			readonly needsDefaultPersistence: boolean;
			readonly unknownFields: readonly UnknownField[];
	  }
	| {
			readonly ok: false;
			readonly field: string;
			readonly expected: string;
			readonly agentId?: string;
			readonly argumentIndex?: number;
			readonly startIndex?: number;
			readonly endIndex?: number;
			readonly highlight?: string;
			readonly unknownFields: readonly UnknownField[];
	  };

type ParseAgentConfigResult =
	| { readonly ok: true; readonly value: AgentConfigOverrides }
	| {
			readonly ok: false;
			readonly field: string;
			readonly expected: string;
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
	monogram?: string;
	adapterKind?: AdapterKind;
	timeouts?: MutableAgentTimeoutOverrides;
	versionFingerprint?: MutableVersionFingerprintOverrides;
}

interface MutableAgentTimeoutOverrides {
	startupTimeoutMs?: number;
	idleTimeoutMs?: number;
	hardWallClockMs?: number;
}

interface MutableVersionFingerprintOverrides {
	args?: readonly string[];
	expectedPattern?: string;
}

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
		};
	}
	if (!isRecord(input)) {
		return { ok: false, field: '$', expected: 'an object', unknownFields: [] };
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
		};
	}

	const defaults = parseAgentLayer(input.defaults, '$.defaults', builtInDefaults, unknownFields);
	if (!defaults.ok) return { ...defaults, unknownFields };
	const overrides = parseAgentLayer(input.overrides, '$.overrides', builtInDefaults, unknownFields);
	if (!overrides.ok) return { ...overrides, unknownFields };
	return {
		ok: true,
		defaults: defaults.value,
		overrides: overrides.value,
		needsDefaultPersistence: !hasCompleteDefaultBaseline(defaults.value, builtInDefaults),
		unknownFields: Object.freeze(unknownFields),
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
		if (!parsed.ok) return { ...parsed, agentId };
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

	if (Object.hasOwn(input, 'execPath')) {
		if (typeof input.execPath !== 'string' || input.execPath.length === 0) {
			return { ok: false, field: `${path}.execPath`, expected: 'a non-empty string' };
		}
		result.execPath = input.execPath;
	}
	if (Object.hasOwn(input, 'argsTemplate')) {
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
	if (Object.hasOwn(input, 'maxConcurrency')) {
		if (!isSafeInteger(input.maxConcurrency) || input.maxConcurrency > 32) {
			return {
				ok: false,
				field: `${path}.maxConcurrency`,
				expected: 'an integer no greater than 32',
			};
		}
		result.maxConcurrency = input.maxConcurrency;
	}
	if (Object.hasOwn(input, 'defaultModel')) {
		if (input.defaultModel !== null && typeof input.defaultModel !== 'string') {
			return { ok: false, field: `${path}.defaultModel`, expected: 'a string or null' };
		}
		result.defaultModel = input.defaultModel;
	}
	if (Object.hasOwn(input, 'monogram')) {
		if (typeof input.monogram !== 'string' || [...input.monogram].length !== 2) {
			return {
				ok: false,
				field: `${path}.monogram`,
				expected: 'a two-character string',
			};
		}
		result.monogram = input.monogram;
	}
	if (Object.hasOwn(input, 'adapterKind')) {
		if (!isAdapterKind(input.adapterKind)) {
			return {
				ok: false,
				field: `${path}.adapterKind`,
				expected: 'native or generic-acp',
			};
		}
		result.adapterKind = input.adapterKind;
	}
	if (Object.hasOwn(input, 'timeouts')) {
		const parsedTimeouts = parseTimeouts(
			input.timeouts,
			`${path}.timeouts`,
			unknownFields,
			agentId,
		);
		if (!parsedTimeouts.ok) return parsedTimeouts;
		result.timeouts = parsedTimeouts.value;
	}
	if (Object.hasOwn(input, 'versionFingerprint')) {
		const parsedFingerprint = parseVersionFingerprint(
			input.versionFingerprint,
			`${path}.versionFingerprint`,
			unknownFields,
			agentId,
		);
		if (!parsedFingerprint.ok) return parsedFingerprint;
		result.versionFingerprint = parsedFingerprint.value;
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
	const startupFallback =
		adapterKind === defaultConfig.adapterKind
			? defaultConfig.timeouts.startupTimeoutMs
			: adapterTimeouts.startupTimeoutMs;

	return freezeAgentConfig({
		execPath: valueOr(overrides.execPath, defaultConfig.execPath),
		argsTemplate: valueOr(overrides.argsTemplate, defaultConfig.argsTemplate),
		maxConcurrency: valueOr(overrides.maxConcurrency, defaultConfig.maxConcurrency),
		defaultModel: valueOr(overrides.defaultModel, defaultConfig.defaultModel),
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
			monogram: config.monogram,
			adapterKind: config.adapterKind,
			timeouts: { ...config.timeouts },
			versionFingerprint: {
				args: [...config.versionFingerprint.args],
				expectedPattern: config.versionFingerprint.expectedPattern,
			},
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
	return Object.freeze({
		...config,
		argsTemplate: Object.freeze([...config.argsTemplate]),
		timeouts: Object.freeze({ ...config.timeouts }),
		versionFingerprint: Object.freeze({
			...config.versionFingerprint,
			args: Object.freeze([...config.versionFingerprint.args]),
		}),
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
	if (!Array.isArray(left) || !Array.isArray(right)) return left === right;
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
