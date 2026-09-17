import type { RunDto } from './runs.ts';

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

export interface BatchWrapupLandingDto {
	readonly worktreePath: string | null;
	readonly branchName: string | null;
	readonly diffStat: string | null;
}

export interface BatchWrapupDto {
	readonly id: string;
	readonly batchId: string;
	readonly batchNo: number;
	readonly tasks: readonly string[];
	readonly round: number;
	readonly runId: string;
	readonly verdict: 'clean' | 'fixed' | 'open';
	readonly declaredVerdict: 'clean' | 'fixed' | 'open' | null;
	readonly isHumanVerdict: boolean;
	readonly promptSource: 'docs' | 'builtin';
	readonly tests: {
		readonly status: 'pass' | 'fail' | 'skipped' | 'unknown';
		readonly items: readonly string[];
	};
	readonly summaryText: string;
	readonly findings: readonly unknown[];
	readonly unassigned: readonly string[];
	readonly fixRunIds: readonly string[];
	readonly reportText: string;
	readonly createdAt: string;
	readonly landing?: BatchWrapupLandingDto | null;
}

export interface WrapupBatchBody {
	readonly idempotencyKey: string;
	readonly agentId?: string;
	readonly model?: string | null;
	readonly effortTier?: 'low' | 'medium' | 'high' | null;
}

export const WRAPUP_BATCH_BODY_KEYS = [
	'agentId',
	'effortTier',
	'idempotencyKey',
	'model',
] as const satisfies readonly (keyof WrapupBatchBody)[];

type AssertWrapupBatchBodyExhaustive = [
	Exclude<keyof WrapupBatchBody, (typeof WRAPUP_BATCH_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertWrapupBatchBody: AssertWrapupBatchBodyExhaustive = true;

export const wrapupBatchBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['idempotencyKey'],
	properties: {
		idempotencyKey: {
			type: 'string',
			minLength: 8,
			maxLength: 128,
			pattern: '^[A-Za-z0-9_-]+$',
		},
		agentId: { type: 'string', minLength: 1, maxLength: 64 },
		model: { type: ['string', 'null'], maxLength: 256 },
		effortTier: {
			type: ['string', 'null'],
			enum: ['low', 'medium', 'high', null],
		},
	},
} as const;

export interface WrapupBatchResponse {
	readonly run: RunDto;
	readonly batch: BatchDto;
}

export interface GetBatchWrapupsResponse {
	readonly wrapups: readonly BatchWrapupDto[];
}
