import { RUN_STATES, type RunState } from './runs.ts';

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
