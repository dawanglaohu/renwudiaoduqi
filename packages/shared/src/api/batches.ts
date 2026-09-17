export type BatchState =
	| 'idle'
	| 'running'
	| 'paused'
	| 'awaiting_landing'
	| 'wrapping'
	| 'needs_attention'
	| 'done';

export const BATCH_STATES = [
	'idle',
	'running',
	'paused',
	'awaiting_landing',
	'wrapping',
	'needs_attention',
	'done',
] as const satisfies readonly BatchState[];

export interface BatchDto {
	readonly id: string;
	readonly docId: string;
	readonly batchNo: number;
	readonly state: BatchState;
	readonly startedAt: string | null;
	readonly finishedAt: string | null;
	readonly canWrapup?: boolean;
	readonly notInHeadCount?: number;
	readonly taskCount?: number;
	readonly landedCount?: number;
	readonly runningCount?: number;
	readonly waitingCount?: number;
	readonly defaultExpanded?: boolean;
	readonly hasCrossBatchFix?: boolean;
}

export interface BatchGateOverrides {
	readonly dispatch?: 'auto' | 'manual';
	readonly review?: 'auto' | 'manual';
	readonly landing?: 'auto' | 'manual';
}

export const BATCH_GATE_OVERRIDES_KEYS = [
	'dispatch',
	'landing',
	'review',
] as const satisfies readonly (keyof BatchGateOverrides)[];

type AssertBatchGateOverridesExhaustive = [
	Exclude<keyof BatchGateOverrides, (typeof BATCH_GATE_OVERRIDES_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertBatchGateOverrides: AssertBatchGateOverridesExhaustive = true;

export interface StartBatchBody {
	readonly gateOverrides?: BatchGateOverrides;
}

export const START_BATCH_BODY_KEYS = [
	'gateOverrides',
] as const satisfies readonly (keyof StartBatchBody)[];

type AssertStartBatchBodyExhaustive = [
	Exclude<keyof StartBatchBody, (typeof START_BATCH_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertStartBatchBody: AssertStartBatchBodyExhaustive = true;

export const startBatchBodySchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		gateOverrides: {
			type: 'object',
			additionalProperties: false,
			properties: {
				dispatch: { type: 'string', enum: ['auto', 'manual'] },
				review: { type: 'string', enum: ['auto', 'manual'] },
				landing: { type: 'string', enum: ['auto', 'manual'] },
			},
		},
	},
} as const;

export interface StartBatchResponse {
	readonly accepted: boolean;
	readonly queued: number;
}

export interface PauseBatchResponse {
	readonly paused: true;
}
