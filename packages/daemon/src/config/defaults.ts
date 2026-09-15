import type {
	BuiltinModelDto,
	EffortValue,
	EffortVendorMap,
} from '@agent-scheduler/shared/api/agents';
import { DEFAULT_PERMISSION_TIER, type PermissionTier } from '../domain/permission-tier.ts';

export const ADAPTER_KINDS = {
	NATIVE: 'native',
	GENERIC_ACP: 'generic-acp',
} as const;

export type AdapterKind = (typeof ADAPTER_KINDS)[keyof typeof ADAPTER_KINDS];

export const BUILT_IN_AGENT_IDS = {
	CODEX: 'codex',
	CLAUDE: 'claude',
	PI: 'pi',
	GROK: 'grok',
	DSH: 'dsh',
} as const;

export type BuiltInAgentId = (typeof BUILT_IN_AGENT_IDS)[keyof typeof BUILT_IN_AGENT_IDS];

export const DEFAULT_STARTUP_TIMEOUT_MS = {
	[ADAPTER_KINDS.NATIVE]: 60_000,
	[ADAPTER_KINDS.GENERIC_ACP]: 180_000,
} as const satisfies Record<AdapterKind, number>;

export const DEFAULT_IDLE_TIMEOUT_MS = 900_000;
export const DEFAULT_HARD_WALL_CLOCK_MS = 0;

export interface AgentTimeouts {
	readonly startupTimeoutMs: number;
	readonly idleTimeoutMs: number;
	readonly hardWallClockMs: number;
}

export interface VersionFingerprint {
	readonly args: readonly string[];
	readonly expectedPattern: string;
}

export interface VersionRange {
	readonly min?: string;
	readonly max?: string;
}

export const LOGIN_PROBE_PARSERS = {
	CODEX_LOGIN_STATUS: 'codex_login_status',
	CLAUDE_AUTH_JSON: 'claude_auth_json',
	GROK_MODELS_EXIT: 'grok_models_exit',
	PI_AUTH_CHECK: 'pi_auth_check',
	NONE: 'none',
} as const;

export type LoginProbeParser = (typeof LOGIN_PROBE_PARSERS)[keyof typeof LOGIN_PROBE_PARSERS];

export interface LoginProbeConfig {
	readonly args: readonly string[];
	readonly parser: LoginProbeParser;
	readonly loggedInPattern: string | null;
	readonly loggedOutPattern: string | null;
	readonly loginCommandHint: string | null;
}

export const GENERIC_LOGIN_PROBE_DEFAULT: LoginProbeConfig = Object.freeze({
	args: Object.freeze([]),
	parser: LOGIN_PROBE_PARSERS.NONE,
	loggedInPattern: null,
	loggedOutPattern: null,
	loginCommandHint: null,
});

export const MODELS_LIVE_KINDS = {
	COMMAND: 'command',
	CODEX_APP_SERVER: 'codex_app_server',
	NONE: 'none',
} as const;

export type ModelsLiveKind = (typeof MODELS_LIVE_KINDS)[keyof typeof MODELS_LIVE_KINDS];

export const MODELS_LIVE_PARSERS = {
	GROK_MODELS_TEXT: 'grok_models_text',
	PI_LIST_MODELS_TABLE: 'pi_list_models_table',
	CODEX_MODEL_LIST_JSONRPC: 'codex_model_list_jsonrpc',
	NONE: 'none',
} as const;

export type ModelsLiveParser = (typeof MODELS_LIVE_PARSERS)[keyof typeof MODELS_LIVE_PARSERS];

export interface ModelsLiveConfig {
	readonly kind: ModelsLiveKind;
	readonly args: readonly string[];
	readonly parser: ModelsLiveParser;
	readonly timeoutMs: number;
}

export const GENERIC_MODELS_LIVE_DEFAULT: ModelsLiveConfig = Object.freeze({
	kind: MODELS_LIVE_KINDS.NONE,
	args: Object.freeze([]),
	parser: MODELS_LIVE_PARSERS.NONE,
	timeoutMs: 5000,
});

export interface AgentConfig {
	readonly execPath: string;
	readonly argsTemplate: readonly string[];
	readonly maxConcurrency: number;
	readonly defaultModel: string | null;
	readonly permissionTier: PermissionTier;
	readonly monogram: string;
	readonly adapterKind: AdapterKind;
	readonly timeouts: AgentTimeouts;
	readonly versionFingerprint: VersionFingerprint;
	readonly versionRange?: VersionRange;
	readonly loginProbe: LoginProbeConfig;
	readonly modelsLive: ModelsLiveConfig;
	readonly builtinModels: readonly BuiltinModelDto[];
	readonly defaultEffortTier: EffortValue;
	readonly effortVendorMap: EffortVendorMap;
}

export interface ResolvedAgentConfig extends AgentConfig {
	readonly isEnabled: boolean;
}

const NATIVE_TIMEOUTS = Object.freeze({
	startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS[ADAPTER_KINDS.NATIVE],
	idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
	hardWallClockMs: DEFAULT_HARD_WALL_CLOCK_MS,
});

export const BUILT_IN_AGENT_DEFAULTS: Readonly<Record<BuiltInAgentId, AgentConfig>> = Object.freeze(
	{
		[BUILT_IN_AGENT_IDS.CODEX]: freezeAgentConfig({
			execPath: 'codex',
			argsTemplate: ['exec', '--json', '--model', '{model}'],
			maxConcurrency: 1,
			defaultModel: null,
			permissionTier: DEFAULT_PERMISSION_TIER,
			monogram: 'CX',
			adapterKind: ADAPTER_KINDS.NATIVE,
			timeouts: NATIVE_TIMEOUTS,
			versionFingerprint: {
				args: ['--version'],
				expectedPattern: '\\bcodex\\b',
			},
			loginProbe: {
				args: ['login', 'status'],
				parser: LOGIN_PROBE_PARSERS.CODEX_LOGIN_STATUS,
				loggedInPattern: '^Logged in',
				loggedOutPattern: 'not logged in',
				loginCommandHint: 'codex login',
			},
			modelsLive: {
				kind: MODELS_LIVE_KINDS.CODEX_APP_SERVER,
				args: ['app-server'],
				parser: MODELS_LIVE_PARSERS.CODEX_MODEL_LIST_JSONRPC,
				timeoutMs: 10000,
			},
			builtinModels: [],
			defaultEffortTier: null,
			effortVendorMap: { low: 'low', medium: 'medium', high: 'high' },
		}),
		[BUILT_IN_AGENT_IDS.CLAUDE]: freezeAgentConfig({
			execPath: 'claude',
			argsTemplate: ['--print', '--output-format', 'stream-json', '--model', '{model}'],
			maxConcurrency: 1,
			defaultModel: null,
			permissionTier: DEFAULT_PERMISSION_TIER,
			monogram: 'CL',
			adapterKind: ADAPTER_KINDS.NATIVE,
			timeouts: NATIVE_TIMEOUTS,
			versionFingerprint: {
				args: ['--version'],
				expectedPattern: '\\bClaude Code\\b',
			},
			loginProbe: {
				args: ['auth', 'status'],
				parser: LOGIN_PROBE_PARSERS.CLAUDE_AUTH_JSON,
				loggedInPattern: null,
				loggedOutPattern: null,
				loginCommandHint: 'claude auth login',
			},
			modelsLive: {
				kind: MODELS_LIVE_KINDS.NONE,
				args: [],
				parser: MODELS_LIVE_PARSERS.NONE,
				timeoutMs: 5000,
			},
			builtinModels: [
				{ name: 'opus', note: '别名，实际可用由登录账号决定' },
				{ name: 'sonnet', note: '别名，实际可用由登录账号决定' },
				{ name: 'haiku', note: '别名，实际可用由登录账号决定' },
				{ name: 'opus[1m]', note: '别名，实际可用由登录账号决定' },
			],
			defaultEffortTier: null,
			effortVendorMap: { low: '2048', medium: '8192', high: '32768' },
		}),
		[BUILT_IN_AGENT_IDS.PI]: freezeAgentConfig({
			execPath: 'pi',
			argsTemplate: [
				'--print',
				'--mode',
				'rpc',
				'--model',
				'{model}',
				'--session-dir',
				'{session_dir}',
			],
			maxConcurrency: 1,
			defaultModel: null,
			permissionTier: DEFAULT_PERMISSION_TIER,
			monogram: 'PI',
			adapterKind: ADAPTER_KINDS.NATIVE,
			timeouts: NATIVE_TIMEOUTS,
			versionFingerprint: {
				args: ['--version'],
				expectedPattern: '\\bpi\\b',
			},
			loginProbe: {
				args: ['auth', 'check', '--provider', '{provider}', '--json'],
				parser: LOGIN_PROBE_PARSERS.PI_AUTH_CHECK,
				loggedInPattern: null,
				loggedOutPattern: null,
				loginCommandHint: null,
			},
			modelsLive: {
				kind: MODELS_LIVE_KINDS.COMMAND,
				args: ['--list-models'],
				parser: MODELS_LIVE_PARSERS.PI_LIST_MODELS_TABLE,
				timeoutMs: 5000,
			},
			builtinModels: [],
			defaultEffortTier: null,
			effortVendorMap: { low: 'low', medium: 'medium', high: 'high' },
		}),
		[BUILT_IN_AGENT_IDS.GROK]: freezeAgentConfig({
			execPath: 'grok',
			argsTemplate: ['--single', '--output-format', 'streaming-json', '--model', '{model}'],
			maxConcurrency: 1,
			defaultModel: null,
			permissionTier: DEFAULT_PERMISSION_TIER,
			monogram: 'GK',
			adapterKind: ADAPTER_KINDS.NATIVE,
			timeouts: NATIVE_TIMEOUTS,
			versionFingerprint: {
				args: ['--version'],
				expectedPattern: '\\bgrok\\b',
			},
			loginProbe: {
				args: ['models'],
				parser: LOGIN_PROBE_PARSERS.GROK_MODELS_EXIT,
				loggedInPattern: null,
				loggedOutPattern: null,
				loginCommandHint: 'grok login',
			},
			modelsLive: {
				kind: MODELS_LIVE_KINDS.COMMAND,
				args: ['models'],
				parser: MODELS_LIVE_PARSERS.GROK_MODELS_TEXT,
				timeoutMs: 5000,
			},
			builtinModels: [],
			defaultEffortTier: null,
			effortVendorMap: { low: 'low', medium: 'medium', high: 'high' },
		}),
		[BUILT_IN_AGENT_IDS.DSH]: freezeAgentConfig({
			execPath: 'resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js',
			argsTemplate: ['--profile', 'headless', '--model', '{model}'],
			maxConcurrency: 1,
			defaultModel: 'deepseek-chat',
			permissionTier: DEFAULT_PERMISSION_TIER,
			monogram: 'DS',
			adapterKind: ADAPTER_KINDS.NATIVE,
			timeouts: NATIVE_TIMEOUTS,
			versionFingerprint: {
				args: ['--version'],
				expectedPattern: '\\bdsh\\b',
			},
			versionRange: {
				min: '0.1.0',
				max: '0.1.2',
			},
			loginProbe: GENERIC_LOGIN_PROBE_DEFAULT,
			modelsLive: GENERIC_MODELS_LIVE_DEFAULT,
			builtinModels: [],
			defaultEffortTier: null,
			effortVendorMap: null,
		}),
	},
);

export function createDefaultTimeouts(adapterKind: AdapterKind): AgentTimeouts {
	return Object.freeze({
		startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS[adapterKind],
		idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
		hardWallClockMs: DEFAULT_HARD_WALL_CLOCK_MS,
	});
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
		versionRange: config.versionRange ? Object.freeze({ ...config.versionRange }) : undefined,
		loginProbe: Object.freeze({
			...config.loginProbe,
			args: Object.freeze([...config.loginProbe.args]),
		}),
		modelsLive: Object.freeze({
			...config.modelsLive,
			args: Object.freeze([...config.modelsLive.args]),
		}),
		builtinModels: Object.freeze(config.builtinModels.map((b) => Object.freeze({ ...b }))),
		effortVendorMap: config.effortVendorMap ? Object.freeze({ ...config.effortVendorMap }) : null,
	});
}
