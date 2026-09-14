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
	});
}
