export const LOGIN_UNKNOWN_REASONS = [
	'timeout',
	'exec_missing',
	'spawn_failed',
	'unparsable',
	'exit_nonzero',
	'not_supported',
	'no_provider',
	'not_probed',
] as const;

export type LoginUnknownReason = (typeof LOGIN_UNKNOWN_REASONS)[number];

export type LoginStatusState = 'logged_in' | 'logged_out' | 'unknown';

export type EffortTier = 'low' | 'medium' | 'high';

export type EffortValue = { readonly tier: EffortTier } | { readonly vendor: string } | null;

export type EffortVendorMap = {
	readonly low: string;
	readonly medium: string;
	readonly high: string;
} | null;

export const MODEL_SOURCES = ['live', 'config', 'builtin', 'history', 'manual'] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

type ExpectedModelSourcesOrder = readonly ['live', 'config', 'builtin', 'history', 'manual'];
type AssertModelSourcesOrder = [typeof MODEL_SOURCES] extends [ExpectedModelSourcesOrder]
	? [ExpectedModelSourcesOrder] extends [typeof MODEL_SOURCES]
		? true
		: never
	: never;
const _assertModelSourcesOrder: AssertModelSourcesOrder = true;

export interface AgentModelItem {
	readonly name: string;
	readonly source: ModelSource;
	readonly provider?: string;
	readonly effortOptions?: readonly string[];
	readonly isCurrentConfig: boolean;
	readonly isDefault?: boolean;
	readonly note?: string;
}

export interface AgentCurrentConfigDto {
	readonly model: string | null;
	readonly effort: EffortValue;
	readonly configPath: string;
	readonly configError?: string;
	readonly effortRecognized: boolean;
}

export interface LiveFailureDto {
	readonly reason: string;
	readonly timeoutMs?: number;
	readonly message?: string;
	readonly details?: unknown;
}

export interface AgentLayerFieldDto<T> {
	readonly builtin: T;
	readonly config: T;
	readonly override: T;
	readonly hasOverride: boolean;
}

export interface AgentLayersDto {
	readonly defaultModel: AgentLayerFieldDto<string | null>;
	readonly defaultEffortTier: AgentLayerFieldDto<EffortValue>;
}

export interface BuiltinModelDto {
	readonly name: string;
	readonly note?: string;
}

export interface ProviderLoginState {
	readonly state: LoginStatusState;
	readonly reason: LoginUnknownReason | null;
}

export interface LoginState {
	readonly state: LoginStatusState;
	readonly reason: LoginUnknownReason | null;
	readonly checkedAt: string | null;
	readonly loginCommand: string | null;
	readonly warningCode: 'E_AGENT_LOGIN_PROBE_FAILED' | null;
	readonly providers?: Readonly<Record<string, ProviderLoginState>>;
	readonly vendor?: string;
}

export interface AgentEntryDto {
	readonly id: string;
	readonly name: string;
	readonly monogram: string;
	readonly isAvailable: boolean;
	readonly defaultModel: string | null;
	readonly defaultEffortTier?: EffortValue;
	readonly maxConcurrency: number;
	readonly permissionTier: 'readOnly' | 'workspaceWrite' | 'unrestricted';
	readonly execPath: string | null;
	readonly login?: LoginState | null;
	readonly layers?: AgentLayersDto;
	readonly effortVendorMap?: EffortVendorMap;
	readonly builtinModels?: readonly BuiltinModelDto[];
	readonly unavailableReason?: string | null;
	readonly unavailableCode?: string | null;
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
}

export interface AgentParams {
	readonly agentId: string;
}

export interface ListAgentModelsQuery {
	readonly refresh?: string;
}

export interface UpdateAgentBody {
	readonly defaultModel?: string | null;
	readonly defaultEffortTier?: EffortValue;
	readonly clearOverrides?: readonly ('defaultModel' | 'defaultEffortTier')[];
	readonly maxConcurrency?: number;
	readonly permissionTier?: 'readOnly' | 'workspaceWrite' | 'unrestricted';
	readonly execPath?: string;
	readonly monogram?: string;
}

export const UPDATE_AGENT_BODY_KEYS = [
	'clearOverrides',
	'defaultEffortTier',
	'defaultModel',
	'execPath',
	'maxConcurrency',
	'monogram',
	'permissionTier',
] as const satisfies readonly (keyof UpdateAgentBody)[];

type AssertUpdateAgentBodyExhaustive = [
	Exclude<keyof UpdateAgentBody, (typeof UPDATE_AGENT_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertUpdateAgentBody: AssertUpdateAgentBodyExhaustive = true;

export const updateAgentBodySchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		defaultModel: { type: ['string', 'null'], maxLength: 256 },
		defaultEffortTier: {
			anyOf: [
				{ type: 'null' },
				{
					type: 'object',
					additionalProperties: false,
					required: ['tier'],
					properties: {
						tier: { type: 'string', enum: ['low', 'medium', 'high'] },
					},
				},
				{
					type: 'object',
					additionalProperties: false,
					required: ['vendor'],
					properties: {
						vendor: { type: 'string', minLength: 1, maxLength: 256 },
					},
				},
			],
		},
		clearOverrides: {
			type: 'array',
			items: { type: 'string', enum: ['defaultModel', 'defaultEffortTier'] },
		},
		maxConcurrency: { type: 'integer', maximum: 32 },
		permissionTier: { type: 'string', enum: ['readOnly', 'workspaceWrite', 'unrestricted'] },
		execPath: { type: 'string', maxLength: 4096 },
		monogram: { type: 'string', minLength: 2, maxLength: 2 },
	},
} as const;

export interface UpdateAgentResponse {
	readonly agent: AgentEntryDto;
}

export interface ProbeAgentResponse {
	readonly status: string;
	readonly versionString: string;
	readonly matched: boolean;
	readonly login?: LoginState | null;
	readonly canDispatch?: boolean;
	readonly errorDetails?: {
		readonly code: string;
		readonly observed?: string;
		readonly expected?: string;
		readonly execPath?: string;
		readonly checkedPaths?: readonly string[];
		readonly reason?: string;
	};
	readonly warningBanner?: {
		readonly code: string;
		readonly message: string;
	};
}

export interface ListAgentModelsResponse {
	readonly models: readonly AgentModelItem[];
	readonly isComplete: boolean;
	readonly refreshedAt: string;
	readonly liveFailure: LiveFailureDto | null;
	readonly currentConfig: AgentCurrentConfigDto;
	readonly isRefreshing: boolean;
}

export interface ListAgentsResponse {
	readonly agents: readonly AgentEntryDto[];
}
