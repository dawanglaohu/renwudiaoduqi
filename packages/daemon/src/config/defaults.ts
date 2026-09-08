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
	});
}
