export interface AgentEntryDto {
	readonly id: string;
	readonly name: string;
	readonly monogram: string;
	readonly isAvailable: boolean;
	readonly defaultModel: string | null;
	readonly maxConcurrency: number;
	readonly permissionTier: 'readOnly' | 'workspaceWrite' | 'unrestricted';
	readonly execPath: string | null;
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
	readonly defaultModel?: string;
	readonly maxConcurrency?: number;
	readonly permissionTier?: 'readOnly' | 'workspaceWrite' | 'unrestricted';
	readonly execPath?: string;
	readonly monogram?: string;
}

export const UPDATE_AGENT_BODY_KEYS = [
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
		defaultModel: { type: 'string', maxLength: 256 },
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
	readonly models: readonly string[];
	readonly source: string;
	readonly isComplete: boolean;
}

export interface ListAgentsResponse {
	readonly agents: readonly AgentEntryDto[];
}
