import type { AgentEntryDto } from '../../../../shared/src/api/agents.ts';

export type BuiltInAgentId = 'codex' | 'claude' | 'pi' | 'grok' | 'dsh';

export type AgentFieldKey =
	| 'monogram'
	| 'execPath'
	| 'defaultModel'
	| 'maxConcurrency'
	| 'permissionTier';

export interface FieldLayerValues {
	readonly key: AgentFieldKey;
	readonly label: string;
	readonly builtIn: string;
	readonly override: string | null;
	readonly effective: string;
	readonly updateNotice?: {
		readonly oldValue: string;
		readonly newValue: string;
	} | null;
}

export interface AgentDefaultUpdateNotice {
	readonly agentId: string;
	readonly field: AgentFieldKey;
	readonly oldValue: string;
	readonly newValue: string;
}

export interface AgentWarningItem {
	readonly reason: string;
	readonly message?: string;
	readonly agentId?: string;
	readonly peerAgentId?: string;
}

export interface RegisteredAgentItem extends AgentEntryDto {
	readonly overrides?: Partial<Record<AgentFieldKey, string | number>>;
	readonly defaultUpdates?: readonly AgentDefaultUpdateNotice[];
	readonly warnings?: readonly AgentWarningItem[];
}

export const BUILT_IN_AGENT_CONFIGS: Readonly<
	Record<
		BuiltInAgentId,
		{
			readonly name: string;
			readonly monogram: string;
			readonly execPath: string;
			readonly defaultModel: string | null;
			readonly maxConcurrency: number;
			readonly permissionTier: 'readOnly' | 'workspaceWrite' | 'unrestricted';
		}
	>
> = Object.freeze({
	codex: Object.freeze({
		name: 'Codex',
		monogram: 'CX',
		execPath: 'codex',
		defaultModel: null,
		maxConcurrency: 1,
		permissionTier: 'workspaceWrite',
	}),
	claude: Object.freeze({
		name: 'Claude Code',
		monogram: 'CL',
		execPath: 'claude',
		defaultModel: null,
		maxConcurrency: 1,
		permissionTier: 'workspaceWrite',
	}),
	pi: Object.freeze({
		name: 'Pi Agent',
		monogram: 'PI',
		execPath: 'pi',
		defaultModel: null,
		maxConcurrency: 1,
		permissionTier: 'workspaceWrite',
	}),
	grok: Object.freeze({
		name: 'Grok CLI',
		monogram: 'GK',
		execPath: 'grok',
		defaultModel: null,
		maxConcurrency: 1,
		permissionTier: 'workspaceWrite',
	}),
	dsh: Object.freeze({
		name: 'DeepSeek Harness',
		monogram: 'DS',
		execPath: 'dsh',
		defaultModel: null,
		maxConcurrency: 1,
		permissionTier: 'workspaceWrite',
	}),
});

export const FIELD_LABELS: Readonly<Record<AgentFieldKey, string>> = Object.freeze({
	monogram: '两字符短码',
	execPath: '可执行路径',
	defaultModel: '默认模型',
	maxConcurrency: '最大并发数',
	permissionTier: '权限档',
});

export const DEFAULT_LANE_COUNT = 2;
export const MIN_LANE_COUNT = 1;
export const MAX_LANE_COUNT = 6;
