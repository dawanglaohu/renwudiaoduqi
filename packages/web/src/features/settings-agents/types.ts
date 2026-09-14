import type { AgentEntryDto } from '../../../../shared/src/api/agents.ts';

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

export interface FieldErrorInfo {
	readonly message: string;
	readonly technical?: string;
	readonly requestId?: string;
}

export interface AgentEntryWithLayers extends AgentEntryDto {
	readonly layers?: Readonly<
		Record<
			string,
			{
				readonly builtin?: unknown;
				readonly override?: unknown;
				readonly effective?: unknown;
				readonly hasOverride?: boolean;
				readonly defaultUpdate?: {
					readonly oldValue?: unknown;
					readonly newValue?: unknown;
				} | null;
			}
		>
	>;
}

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
