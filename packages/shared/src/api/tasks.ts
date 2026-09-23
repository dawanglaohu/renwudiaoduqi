import { RUN_STATES, type RunDto, type RunState } from './runs.ts';

export type TaskState = RunState | 'never_dispatched';

export const TASK_STATES = [
	'never_dispatched',
	...RUN_STATES,
] as const satisfies readonly TaskState[];

export interface TaskDto {
	readonly id: string;
	readonly docId: string;
	readonly taskKey: string;
	readonly title: string;
	readonly moduleKey: string;
	readonly deps: readonly string[];
	readonly estDays: number | null;
	readonly batchId: string | null;
	readonly state: TaskState;
	readonly hasAcceptChanged?: boolean;
	readonly hasPromptChanged?: boolean;
	readonly isRemovedFromDoc?: boolean;
	readonly inHead?: boolean | null;
	readonly crossBatchFix?: boolean;
}

export interface GetTaskLandingResponse {
	readonly worktreePath: string;
	readonly branchName: string;
	readonly diffStat: {
		readonly filesChanged: number;
		readonly insertions: number;
		readonly deletions: number;
	};
	readonly commands: readonly string[];
}

export interface CleanupTaskWorktreeResponse {
	readonly removed: true;
}

export interface RecallTaskBody {
	readonly comment: string;
	readonly idempotencyKey: string;
}

export const RECALL_TASK_BODY_KEYS = [
	'comment',
	'idempotencyKey',
] as const satisfies readonly (keyof RecallTaskBody)[];

type AssertRecallTaskBodyExhaustive = [
	Exclude<keyof RecallTaskBody, (typeof RECALL_TASK_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertRecallTaskBody: AssertRecallTaskBodyExhaustive = true;

export const recallTaskBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['comment', 'idempotencyKey'],
	properties: {
		comment: {
			type: 'string',
			minLength: 1,
		},
		idempotencyKey: {
			type: 'string',
			minLength: 1,
			maxLength: 128,
		},
	},
} as const;

export interface RecallTaskResponse {
	readonly run: RunDto;
}
