import type { EffortValue } from './agents.ts';

export interface RunBaseRef {
	readonly kind: 'head' | 'upstreamBranch';
	readonly taskKey?: string;
}

export interface CreateRunBody {
	readonly taskId: string;
	readonly agentId: string;
	readonly model?: string | null;
	readonly effort?: EffortValue;
	readonly permissionTier?: 'readOnly' | 'workspaceWrite' | 'unrestricted';
	readonly baseRef?: RunBaseRef;
	readonly worktreeMode?: 'fresh' | 'reuse';
	readonly idempotencyKey: string;
}

export const CREATE_RUN_BODY_KEYS = [
	'agentId',
	'baseRef',
	'effort',
	'idempotencyKey',
	'model',
	'permissionTier',
	'taskId',
	'worktreeMode',
] as const satisfies readonly (keyof CreateRunBody)[];

type AssertCreateRunBodyExhaustive = [
	Exclude<keyof CreateRunBody, (typeof CREATE_RUN_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertCreateRunBody: AssertCreateRunBodyExhaustive = true;

export const createRunBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['taskId', 'agentId', 'idempotencyKey'],
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
		permissionTier: { type: 'string', enum: ['readOnly', 'workspaceWrite', 'unrestricted'] },
		baseRef: {
			type: 'object',
			additionalProperties: false,
			required: ['kind'],
			properties: {
				kind: { type: 'string', enum: ['head', 'upstreamBranch'] },
				taskKey: { type: 'string' },
			},
		},
		worktreeMode: { type: 'string', enum: ['fresh', 'reuse'] },
		idempotencyKey: {
			type: 'string',
			minLength: 8,
			maxLength: 128,
			pattern: '^[A-Za-z0-9_-]+$',
		},
	},
} as const;

export interface AbortRunBody {
	readonly reason?: string;
}

export const ABORT_RUN_BODY_KEYS = ['reason'] as const satisfies readonly (keyof AbortRunBody)[];

type AssertAbortRunBodyExhaustive = [
	Exclude<keyof AbortRunBody, (typeof ABORT_RUN_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertAbortRunBody: AssertAbortRunBodyExhaustive = true;

export const abortRunBodySchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		reason: { type: 'string', maxLength: 2048 },
	},
} as const;

export interface RerunRunBody {
	readonly idempotencyKey: string;
}

export const RERUN_RUN_BODY_KEYS = [
	'idempotencyKey',
] as const satisfies readonly (keyof RerunRunBody)[];

type AssertRerunRunBodyExhaustive = [
	Exclude<keyof RerunRunBody, (typeof RERUN_RUN_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertRerunRunBody: AssertRerunRunBodyExhaustive = true;

export const rerunRunBodySchema = {
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
	},
} as const;

export interface CreateRunMessageBody {
	readonly text: string;
	readonly kind: 'reply' | 'approve' | 'deny';
}

export const CREATE_RUN_MESSAGE_BODY_KEYS = [
	'kind',
	'text',
] as const satisfies readonly (keyof CreateRunMessageBody)[];

type AssertCreateRunMessageBodyExhaustive = [
	Exclude<keyof CreateRunMessageBody, (typeof CREATE_RUN_MESSAGE_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertCreateRunMessageBody: AssertCreateRunMessageBodyExhaustive = true;

export const createRunMessageBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['text', 'kind'],
	properties: {
		text: { type: 'string', minLength: 1, maxLength: 32768 },
		kind: { type: 'string', enum: ['reply', 'approve', 'deny'] },
	},
} as const;

export interface RunDto {
	readonly id: string;
	readonly taskId: string;
	readonly attemptNo: number;
	readonly kind: 'implement' | 'review';
	readonly parentRunId: string | null;
	readonly state: string;
	readonly reviewVerdict: 'pass' | 'rework' | 'doc_issue' | 'incomplete' | null;
	readonly agentId: string;
	readonly modelName: string | null;
	readonly reportedModel: string | null;
	readonly effortTier: 'low' | 'medium' | 'high' | null;
	readonly effortVendor?: string | null;
	readonly effort?: EffortValue;
	readonly reportedEffort: string | null;
	readonly permissionTier: 'readOnly' | 'workspaceWrite' | 'unrestricted';
	readonly worktreePath: string | null;
	readonly branchName: string | null;
	readonly pid: number | null;
	readonly exitCode: number | null;
	readonly exitSignal: string | null;
	readonly changedFileCount: number | null;
	readonly tokenUsage: Record<string, unknown> | null;
	readonly isStallSuspected: boolean;
	readonly reworkCount: number;
	readonly queuedReason: string | null;
	readonly idempotencyKey: string;
	readonly actorDeviceId: string | null;
	readonly startedAt: string | null;
	readonly lastEventAt: string | null;
	readonly endedAt: string | null;
	readonly laneNo?: number | null;
	readonly sessionArchivedAt?: string | null;
}

export interface CreateRunResponse {
	readonly run: RunDto;
}

export interface ListRunsResponse {
	readonly runs: readonly RunDto[];
	readonly nextCursor: string | null;
}

export interface GetRunResponse {
	readonly run: RunDto;
	readonly progress: unknown;
}

export interface AbortRunResponse {
	readonly accepted: true;
}

export interface RerunRunResponse {
	readonly run: RunDto;
}

export interface CreateRunMessageResponse {
	readonly delivered: boolean;
	readonly messageId: string;
}

export interface GetRunLogResponse {
	readonly lines: readonly string[];
	readonly totalLines: number;
	readonly prevCursor: string | null;
	readonly nextCursor: string | null;
}

export interface SearchRunLogResponse {
	readonly hits: readonly unknown[];
	readonly truncated: boolean;
	readonly scannedUntilSeq: number;
	readonly canceled: boolean;
}

export interface PurgeRunLogsResponse {
	readonly purgedBytes: number;
}
