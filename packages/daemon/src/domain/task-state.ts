import { TASK_STATES, type TaskState } from '@agent-scheduler/shared/api/tasks';

export { TASK_STATES, type TaskState };

export function isTaskState(state: unknown): state is TaskState {
	return typeof state === 'string' && (TASK_STATES as readonly string[]).includes(state);
}

export interface TaskStateDerivationInput {
	readonly manualState?: string | null;
	readonly latestRunState?: string | null;
}

/**
 * 最小版 deriveTaskState()（09 节数据模型）：
 * manual_state 非空 → 用它；
 * 否则取该任务 attempt_no 最大的那次 runs.state；
 * 一次都没派过 → never_dispatched。
 *
 * 注：M8-T7 落地时在此文件扩展 origin 分支与 deriveTaskInHead()，不另建文件。
 */
export function deriveTaskState(
	inputOrManualState?: TaskStateDerivationInput | string | null,
	latestRunState?: string | null,
): TaskState {
	let manualState: string | null | undefined;
	let runState: string | null | undefined;

	if (typeof inputOrManualState === 'object' && inputOrManualState !== null) {
		manualState = inputOrManualState.manualState;
		runState = inputOrManualState.latestRunState;
	} else {
		manualState = inputOrManualState;
		runState = latestRunState;
	}

	if (manualState && manualState.trim().length > 0) {
		return manualState as TaskState;
	}

	if (runState && runState.trim().length > 0) {
		return runState as TaskState;
	}

	return 'never_dispatched';
}
