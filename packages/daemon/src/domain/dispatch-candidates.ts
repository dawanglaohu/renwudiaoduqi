import { isTerminalRunState } from './run-state-machine.ts';

/**
 * 派发候选队列的唯一实现（M8-T8 AC 2 / E-319 / E-326 / E-327）。
 *
 * tick 第 ③ 步与 `GET /snapshot` 的泳道空闲槽提示必须吃同一份队列：只在这里判一次，
 * 两边都调它，避免「预览说可派、tick 说不行」或「未来批次的停靠任务被当成下一个可派」。
 *
 * 纯函数：不读 db、不读 clock、不读 settings，输入相同则输出逐字节相同。
 */

export interface DispatchCandidateTask {
	readonly id: string;
	readonly task_key: string;
	readonly batch_id?: string | null;
	readonly deps_json?: string | null;
	readonly is_contract_ready?: number | null;
	readonly has_accept_changed?: number | null;
	readonly has_prompt_changed?: number | null;
	readonly is_removed_from_doc?: number | null;
	readonly manual_state?: string | null;
	readonly lane_no?: number | null;
	readonly layer_no?: number | null;
}

export interface DispatchCandidateRun {
	readonly id: string;
	readonly task_id?: string | null;
	readonly state: string;
	readonly attempt_no?: number | null;
}

export interface DispatchCandidateInput {
	readonly tasks: readonly DispatchCandidateTask[];
	readonly runs: readonly DispatchCandidateRun[];
	/**
	 * 只在这些批次里挑候选。**空集合表示「当前没有任何活动批次」**，
	 * 不是「不过滤」——传 undefined 才会退化成不过滤（仅用于无批次概念的老路径）。
	 */
	readonly activeBatchIds?: ReadonlySet<string> | readonly string[] | undefined;
	/** 已经在别的路径上排队的任务（如打回返工），不再重复进候选。 */
	readonly excludeTaskIds?: readonly string[] | undefined;
}

export interface DispatchCandidateResult {
	/** 按 (layerNo, taskKey) 排好序的可派任务 id。 */
	readonly eligibleTaskIds: readonly string[];
	/** 可派但被契约/文档变更挡下的任务，附原因。 */
	readonly blocked: readonly { readonly taskId: string; readonly reason: string }[];
	/** 前置未落地的未派任务，附未落地前置的 taskKey（升序）。 */
	readonly waitingOnDeps: readonly {
		readonly taskId: string;
		readonly blockedBy: readonly string[];
	}[];
}

function isLandedTask(
	task: DispatchCandidateTask,
	runsByTaskId: Map<string, readonly DispatchCandidateRun[]>,
): boolean {
	if (task.manual_state === 'landed') return true;
	const taskRuns = runsByTaskId.get(task.id) ?? [];
	return taskRuns.some((r) => r.state === 'landed');
}

export function computeDispatchCandidates(input: DispatchCandidateInput): DispatchCandidateResult {
	const sortedTasks = [...input.tasks].sort((a, b) => a.id.localeCompare(b.id));

	const activeBatchIdSet =
		input.activeBatchIds === undefined
			? null
			: input.activeBatchIds instanceof Set
				? input.activeBatchIds
				: new Set(input.activeBatchIds);
	const exclude = new Set(input.excludeTaskIds ?? []);

	const tasksById = new Map<string, DispatchCandidateTask>();
	const tasksByKey = new Map<string, DispatchCandidateTask>();
	for (const t of sortedTasks) {
		tasksById.set(t.id, t);
		tasksByKey.set(t.task_key, t);
	}

	const runsByTaskId = new Map<string, DispatchCandidateRun[]>();
	const latestRunByTaskId = new Map<string, DispatchCandidateRun>();
	const activeTaskIds = new Set<string>();
	for (const r of input.runs) {
		if (!r.task_id) continue;
		const list = runsByTaskId.get(r.task_id) ?? [];
		list.push(r);
		runsByTaskId.set(r.task_id, list);

		const existing = latestRunByTaskId.get(r.task_id);
		if (!existing || (r.attempt_no ?? 0) > (existing.attempt_no ?? 0)) {
			latestRunByTaskId.set(r.task_id, r);
		}
		if (!isTerminalRunState(r.state as never)) {
			activeTaskIds.add(r.task_id);
		}
	}

	const eligible: DispatchCandidateTask[] = [];
	const blocked: Array<{ readonly taskId: string; readonly reason: string }> = [];
	const waitingOnDeps: Array<{ readonly taskId: string; readonly blockedBy: readonly string[] }> =
		[];

	for (const t of sortedTasks) {
		if (exclude.has(t.id)) continue;
		if (t.is_removed_from_doc === 1) continue;
		// 停靠在人工闸门的任务不在甲板上（E-326），不参与补位也不当"下一个任务"推荐
		if (t.manual_state === 'awaiting_human' || t.manual_state === 'paused') continue;
		// 批次作用域：未来空闲批次里的任务不算可派（E-319）
		if (activeBatchIdSet && (!t.batch_id || !activeBatchIdSet.has(t.batch_id))) continue;
		if (isLandedTask(t, runsByTaskId)) continue;
		if (activeTaskIds.has(t.id)) continue;

		const latestRun = latestRunByTaskId.get(t.id);
		if (latestRun && isTerminalRunState(latestRun.state as never) && latestRun.state !== 'landed') {
			// E-51：终态失败/中断/孤儿/中止后不自动重派
			continue;
		}

		let depKeys: string[] = [];
		if (t.deps_json) {
			try {
				const parsed = JSON.parse(t.deps_json) as unknown;
				if (Array.isArray(parsed)) {
					depKeys = parsed.filter((k): k is string => typeof k === 'string');
				}
			} catch {
				depKeys = [];
			}
		}

		const missingDepKeys: string[] = [];
		for (const depKey of depKeys) {
			const depTask = tasksByKey.get(depKey) ?? tasksById.get(depKey);
			if (!depTask || !isLandedTask(depTask, runsByTaskId)) {
				missingDepKeys.push(depKey);
			}
		}
		if (missingDepKeys.length > 0) {
			missingDepKeys.sort((a, b) => a.localeCompare(b));
			waitingOnDeps.push({ taskId: t.id, blockedBy: Object.freeze(missingDepKeys) });
			continue;
		}

		if (t.is_contract_ready !== 1) {
			blocked.push({ taskId: t.id, reason: 'contract_not_ready' });
			continue;
		}
		if (t.has_accept_changed === 1 || t.has_prompt_changed === 1) {
			blocked.push({ taskId: t.id, reason: 'doc_changed_pending_confirmation' });
			continue;
		}

		eligible.push(t);
	}

	eligible.sort((a, b) => {
		const layerA = a.layer_no ?? 0;
		const layerB = b.layer_no ?? 0;
		if (layerA !== layerB) return layerA - layerB;
		return a.task_key.localeCompare(b.task_key);
	});

	waitingOnDeps.sort((a, b) => a.taskId.localeCompare(b.taskId));

	return Object.freeze({
		eligibleTaskIds: Object.freeze(eligible.map((t) => t.id)),
		blocked: Object.freeze(blocked),
		waitingOnDeps: Object.freeze(waitingOnDeps),
	});
}
