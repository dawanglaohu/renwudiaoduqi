import type { RunRow } from '../repo/runs.ts';
import type { TaskRow } from '../repo/tasks.ts';

/**
 * 批次落地判定（M8-T6 AC 1、E-272）。
 *
 * 「任务已验收」在库里有两种表示：闸门 pass 写 `tasks.manual_state='landed'`，自动审查通过或 M7-T9
 * 接线后把实施运行行迁到 `runs.state='landed'`。tick、`triggerWrapup()` 与 `getBatch()` 三处必须用同一把尺子，
 * 否则 tick 认为可收口而 triggerWrapup 拒绝，批次永远停在 running。
 *
 * 规则：
 * - 只看 `kind='implement'` 里 `attempt_no` 最大的一次运行。审查、查 bug 运行与实施运行共用 task_id
 *   且 attempt_no 递增，若不按 kind 过滤，「最新一条」永远是停在 exited 的审查行。
 * - landed = 该实施运行 `state='landed'`，或任务 `manual_state='landed'`（人工裁定）。
 * - 进 HEAD 只对 landed 的任务判：有实施运行时看它的 `is_in_head`；从未派过运行的人工 landed 任务没有分支，
 *   视作已进 HEAD（没有东西需要合并）。
 */
export interface BatchLandingSummary {
	readonly landedCount: number;
	readonly notInHeadCount: number;
	readonly allLanded: boolean;
	readonly allInHead: boolean;
	readonly notLandedTaskKeys: readonly string[];
	readonly notInHeadTaskKeys: readonly string[];
}

export type LandingTask = Pick<TaskRow, 'id' | 'task_key' | 'manual_state'>;
export type LandingRun = Pick<RunRow, 'task_id' | 'kind' | 'attempt_no' | 'state' | 'is_in_head'>;

/**
 * 每个任务 `kind='implement'` 且 `attempt_no` 最大的运行行。
 */
export function latestImplementationRunByTaskId<R extends LandingRun>(
	runs: readonly R[],
): ReadonlyMap<string, R> {
	const latest = new Map<string, R>();
	for (const run of runs) {
		if (!run.task_id || run.kind !== 'implement') continue;
		const existing = latest.get(run.task_id);
		if (!existing || run.attempt_no > existing.attempt_no) {
			latest.set(run.task_id, run);
		}
	}
	return latest;
}

export function isTaskLandedForBatch(
	task: LandingTask,
	latestRun: LandingRun | undefined,
): boolean {
	return latestRun?.state === 'landed' || task.manual_state === 'landed';
}

export function summarizeBatchLanding(
	tasks: readonly LandingTask[],
	runs: readonly LandingRun[],
): BatchLandingSummary {
	const latestByTask = latestImplementationRunByTaskId(runs);
	const notLandedTaskKeys: string[] = [];
	const notInHeadTaskKeys: string[] = [];
	let landedCount = 0;
	let notInHeadCount = 0;

	for (const task of tasks) {
		const run = latestByTask.get(task.id);
		if (!isTaskLandedForBatch(task, run)) {
			notLandedTaskKeys.push(task.task_key);
			continue;
		}
		landedCount += 1;
		if (run && (run.is_in_head ?? 0) === 0) {
			notInHeadCount += 1;
			notInHeadTaskKeys.push(task.task_key);
		}
	}

	const allLanded = tasks.length > 0 && landedCount === tasks.length;
	return Object.freeze({
		landedCount,
		notInHeadCount,
		allLanded,
		allInHead: allLanded && notInHeadCount === 0,
		notLandedTaskKeys: Object.freeze(notLandedTaskKeys),
		notInHeadTaskKeys: Object.freeze(notInHeadTaskKeys),
	});
}
