import type { EffortValue } from './agents.ts';
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
	readonly taskCount?: number;
	readonly landedCount?: number;
	readonly runningCount?: number;
	readonly waitingCount?: number;
	readonly defaultExpanded?: boolean;
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

export type FindingKind = 'bug' | 'not_fixed' | 'test_failure';

export interface WrapupFindingDto {
	readonly id: string;
	readonly kind: FindingKind;
	readonly severity: string | null;
	readonly taskKey: string | null;
	readonly crossBatch: boolean;
	readonly isFixed: boolean;
	readonly isWellFormed: boolean;
	readonly raw: string;
	readonly symptom?: string;
	readonly reproduction?: string;
	readonly rootCause?: string;
	readonly location?: string;
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
	readonly findings: readonly WrapupFindingDto[];
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

/**
 * Per-task assignment draft written by `POST /api/v1/batches/:batchId/assignments` (M8-T11).
 * `taskId` must belong to the batch and must not have been dispatched yet; `agentId` must exist in
 * the registry (a `logged_out` agent is accepted, E-336).
 */
export interface TaskAssignmentDraft {
	readonly taskId: string;
	readonly agentId: string;
	readonly model?: string | null;
	readonly effort?: EffortValue;
}

export const TASK_ASSIGNMENT_DRAFT_KEYS = [
	'agentId',
	'effort',
	'model',
	'taskId',
] as const satisfies readonly (keyof TaskAssignmentDraft)[];

type AssertTaskAssignmentDraftExhaustive = [
	Exclude<keyof TaskAssignmentDraft, (typeof TASK_ASSIGNMENT_DRAFT_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertTaskAssignmentDraft: AssertTaskAssignmentDraftExhaustive = true;

export interface PutAssignmentsBody {
	readonly assignments: readonly TaskAssignmentDraft[];
}

export const PUT_ASSIGNMENTS_BODY_KEYS = [
	'assignments',
] as const satisfies readonly (keyof PutAssignmentsBody)[];

type AssertPutAssignmentsBodyExhaustive = [
	Exclude<keyof PutAssignmentsBody, (typeof PUT_ASSIGNMENTS_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertPutAssignmentsBody: AssertPutAssignmentsBodyExhaustive = true;

export const putAssignmentsBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['assignments'],
	properties: {
		assignments: {
			type: 'array',
			maxItems: 500,
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['taskId', 'agentId'],
				properties: {
					taskId: { type: 'string', minLength: 1, maxLength: 64 },
					agentId: { type: 'string', minLength: 1, maxLength: 64 },
					model: { type: ['string', 'null'], maxLength: 256 },
					effort: {
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
				},
			},
		},
	},
} as const;

/**
 * Draft as read back: `sessionNo` is the agent's concurrency-occupying run count plus the draft's
 * rank among the same agent's drafts in taskKey order (from 1), i.e. which session of that agent
 * the task will become once dispatched (E-31). Tasks without a draft are not listed.
 */
export interface TaskAssignmentDto {
	readonly taskId: string;
	readonly taskKey: string;
	readonly agentId: string;
	readonly model: string | null;
	readonly effort: EffortValue;
	readonly sessionNo: number;
	readonly draftedAt: string;
}

export const CONCURRENCY_PREVIEW_BOTTLENECKS = [
	'window_count',
	'agent_limit',
	'user_setting',
] as const;

export type ConcurrencyPreviewBottleneck = (typeof CONCURRENCY_PREVIEW_BOTTLENECKS)[number];

export interface AgentCapacityPreview {
	readonly agentId: string;
	/** Runs of this agent that currently occupy a concurrency slot. */
	readonly active: number;
	/** Registry `maxConcurrency`. */
	readonly limit: number;
	/** Pending drafts pointing at this agent. */
	readonly drafted: number;
	/** `active + drafted >= limit` (E-47). */
	readonly isFull: boolean;
}

/**
 * Concurrency preview computed by the daemon from `calculateBatchConcurrency()`; the web displays
 * it and never recomputes (E-52, E-245).
 */
export interface ConcurrencyPreview {
	/** Tasks of this batch that can be released right now (M8-T1 `windowCount` semantics). */
	readonly windowCount: number;
	/** `documents.lane_count`, never rewritten by the runtime (E-245). */
	readonly userSetting: number;
	readonly agentCapacities: readonly AgentCapacityPreview[];
	readonly effectiveConcurrency: number;
	readonly bottleneck: ConcurrencyPreviewBottleneck;
	readonly exceedsWindowCount: boolean;
}

export interface BatchAssignmentsResponse {
	readonly drafts: readonly TaskAssignmentDto[];
	readonly preview: ConcurrencyPreview;
}
