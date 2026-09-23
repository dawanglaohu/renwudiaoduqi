import { TASK_STATES, type TaskState } from '@agent-scheduler/shared/api/tasks';

export { TASK_STATES, type TaskState };

export function isTaskState(state: unknown): state is TaskState {
	return typeof state === 'string' && (TASK_STATES as readonly string[]).includes(state);
}

export interface TaskStateRunInfo {
	readonly state: string;
	readonly attempt_no: number;
	readonly origin?: string | null;
	readonly kind?: string | null;
	readonly batch_id?: string | null;
}

export interface TaskStateDerivationInput {
	readonly manualState?: string | null;
	readonly latestRunState?: string | null;
	readonly latestRunOrigin?: string | null;
	readonly latestNonFixRunState?: string | null;
	readonly runs?: readonly TaskStateRunInfo[];
}

export interface DeriveTaskStateOptions {
	/**
	 * 批次级计数口径（E-275）：
	 * 若为 true，按最近一次「非修复」运行计，origin='wrapup-fix' 的在途运行不影响已落地状态。
	 */
	readonly ignoreWrapupFix?: boolean;
}

/**
 * 09 节数据模型与 M8-T7：
 * manual_state 非空 → 用它；
 * 若 options?.ignoreWrapupFix 为 true（批次级计数口径，E-275）：
 *   取最近一次「非修复」运行（origin !== 'wrapup-fix'）；
 * 否则取该任务 attempt_no 最大的那次 runs.state；
 * 一次都没派过 → never_dispatched。
 */
export function deriveTaskState(
	inputOrManualState?: TaskStateDerivationInput | string | null,
	latestRunState?: string | null,
	options?: DeriveTaskStateOptions,
): TaskState {
	let manualState: string | null | undefined;
	let runState: string | null | undefined;
	const ignoreFix = options?.ignoreWrapupFix ?? false;

	if (typeof inputOrManualState === 'object' && inputOrManualState !== null) {
		manualState = inputOrManualState.manualState;
		if (inputOrManualState.runs && inputOrManualState.runs.length > 0) {
			const candidateRuns = ignoreFix
				? inputOrManualState.runs.filter((r) => r.origin !== 'wrapup-fix')
				: inputOrManualState.runs;
			if (candidateRuns.length > 0) {
				const latest = candidateRuns.reduce((max, r) => (r.attempt_no > max.attempt_no ? r : max));
				runState = latest.state;
			} else {
				runState = null;
			}
		} else if (ignoreFix && inputOrManualState.latestRunOrigin === 'wrapup-fix') {
			runState = inputOrManualState.latestNonFixRunState ?? null;
		} else {
			runState = inputOrManualState.latestRunState;
		}
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

export interface TaskInHeadInput {
	readonly manualState?: string | null;
	readonly latestImplementationRun?: {
		readonly state?: string | null;
		readonly is_in_head?: number | null;
	} | null;
}

/**
 * 任务行的「进 HEAD」标记三态计算（E-298、AC 6）：
 * - true: 任务已验收 (landed) 且 runs.is_in_head === 1
 * - false: 任务已验收 (landed) 但 runs.is_in_head !== 1
 * - null: 任务未验收或从未派发
 */
export function deriveTaskInHead(
	inputOrRun?:
		| TaskInHeadInput
		| { readonly state?: string | null; readonly is_in_head?: number | null }
		| null,
	manualState?: string | null,
): boolean | null {
	let latestRun:
		| { readonly state?: string | null; readonly is_in_head?: number | null }
		| null
		| undefined;
	let manual: string | null | undefined;

	if (
		inputOrRun &&
		typeof inputOrRun === 'object' &&
		('latestImplementationRun' in inputOrRun || 'manualState' in inputOrRun)
	) {
		const typed = inputOrRun as TaskInHeadInput;
		latestRun = typed.latestImplementationRun;
		manual = typed.manualState;
	} else {
		latestRun = inputOrRun as
			| { readonly state?: string | null; readonly is_in_head?: number | null }
			| null
			| undefined;
		manual = manualState;
	}

	const isLanded = latestRun?.state === 'landed' || manual === 'landed';
	if (!isLanded) {
		return null;
	}

	if (latestRun) {
		return latestRun.is_in_head === 1;
	}

	// 从未派过运行的人工 landed 任务没有分支，视作已进 HEAD
	return true;
}

export interface TaskCrossBatchFixInput {
	readonly taskBatchId?: string | null;
	readonly runs?: readonly {
		readonly state: string;
		readonly origin?: string | null;
		readonly batch_id?: string | null;
	}[];
}

/**
 * 判定任务当前是否处于跨批修复中（E-275）。
 * 当且仅当该任务存在在途修复运行 (origin='wrapup-fix')，且归属批次与任务原批次不同。
 */
export function deriveTaskCrossBatchFix(input: TaskCrossBatchFixInput): boolean {
	const { taskBatchId, runs } = input;
	if (!taskBatchId || !runs || runs.length === 0) {
		return false;
	}

	const terminalStates = ['failed', 'aborted', 'interrupted'];

	return runs.some((r) => {
		const isFix = r.origin === 'wrapup-fix';
		const isInFlight = !terminalStates.includes(r.state) && r.state !== 'landed';
		const isCrossBatch =
			r.batch_id !== null && r.batch_id !== undefined && r.batch_id !== taskBatchId;
		return isFix && isInFlight && isCrossBatch;
	});
}
