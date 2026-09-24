import type { LaneStage, LaneView } from '@agent-scheduler/shared/api/lanes';
import type { RunState } from '@agent-scheduler/shared/api/runs';
import { isTerminalRunState } from './run-state-machine.ts';

export interface TaskDescriptor {
	readonly id: string;
	readonly task_key: string;
	readonly doc_id: string;
	readonly batch_id?: string | null;
	readonly manual_state?: string | null;
	readonly layer_no?: number | null;
	readonly deps_json?: string | null;
	readonly lane_no?: number | null;
	readonly is_removed_from_doc?: number | null;
}

export interface RunDescriptor {
	readonly id: string;
	readonly task_id?: string | null;
	readonly batch_id?: string | null;
	readonly kind: string;
	readonly state: string;
	readonly attempt_no?: number | null;
	readonly lane_no?: number | null;
	readonly session_archived_at?: string | null;
	readonly ended_at?: string | null;
	readonly started_at?: string | null;
	readonly last_event_at?: string | null;
}

export interface DeriveLanesInput {
	readonly laneCount: number;
	readonly tasks: readonly TaskDescriptor[];
	readonly runs: readonly RunDescriptor[];
	readonly candidateTaskIds?: readonly string[];
	/**
	 * 前置未落地的未派任务（来自 `computeDispatchCandidates().waitingOnDeps`）。
	 * 传了 `candidateTaskIds` 时一并传它，空闲槽才有确定性的「等前置」回落（E-319）。
	 */
	readonly blockedCandidates?: readonly {
		readonly taskId: string;
		readonly blockedBy: readonly string[];
	}[];
	/**
	 * 只在这些批次里挑候选。**空集合表示没有任何活动批次**，不是"不过滤"。
	 */
	readonly activeBatchIds?: ReadonlySet<string> | readonly string[];
}

function isTaskFinishedOrLanded(
	task: TaskDescriptor,
	runsByTaskId: Map<string, readonly RunDescriptor[]>,
): boolean {
	if (task.manual_state === 'landed') {
		return true;
	}
	const taskRuns = runsByTaskId.get(task.id) ?? [];
	return taskRuns.some((r) => r.state === 'landed');
}

/**
 * Pure function deriving pipeline lane views (AC 1, AC 7, E-317, E-319, E-332):
 * - Does not access DB, clock, or settings.
 * - Deterministic: inputs sorted by id, identical DB reload produces byte-identical JSON.
 * - laneNo is continuous from 1 to max(laneCount, maxOccupiedLaneNo).
 * - overLimit = laneNo > laneCount.
 * - stage strictly draws from LANE_STAGES (7 values including rework).
 * - idle slots take nextTaskId from candidates sorted by (layerNo, taskKey), then blocked tasks with nextBlockedBy.
 * - archivedTaskIds contains at most the single most recently archived task id for this lane.
 * - archivedWrapupRunId contains the single most recently archived wrapup run id for this lane.
 */
export function deriveLanes(input: DeriveLanesInput): readonly LaneView[] {
	// Deterministic sorting of input collections by ID (E-317, E-319)
	const sortedTasks = [...input.tasks].sort((a, b) => a.id.localeCompare(b.id));
	const sortedRuns = [...input.runs].sort((a, b) => a.id.localeCompare(b.id));

	const tasksById = new Map<string, TaskDescriptor>();
	const tasksByLane = new Map<number, TaskDescriptor>();
	const occupiedLanes = new Set<number>();

	for (const t of sortedTasks) {
		tasksById.set(t.id, t);
		if (typeof t.lane_no === 'number' && Number.isInteger(t.lane_no) && t.lane_no >= 1) {
			tasksByLane.set(t.lane_no, t);
			occupiedLanes.add(t.lane_no);
		}
	}

	const runsByTaskId = new Map<string, RunDescriptor[]>();
	const activeWrapupByLane = new Map<number, RunDescriptor>();

	for (const r of sortedRuns) {
		if (r.task_id) {
			const list = runsByTaskId.get(r.task_id) ?? [];
			list.push(r);
			runsByTaskId.set(r.task_id, list);
		}

		if (
			r.kind === 'wrapup' &&
			typeof r.lane_no === 'number' &&
			Number.isInteger(r.lane_no) &&
			r.lane_no >= 1 &&
			!isTerminalRunState(r.state as RunState) &&
			r.state !== 'awaiting_human' &&
			r.state !== 'orphaned'
		) {
			activeWrapupByLane.set(r.lane_no, r);
			occupiedLanes.add(r.lane_no);
		}
	}

	const maxOccupied = occupiedLanes.size > 0 ? Math.max(...occupiedLanes) : 0;
	const totalLanes = Math.max(input.laneCount, maxOccupied);
	if (totalLanes < 1) {
		return Object.freeze([]);
	}

	// Derive candidate and blocked task queues for idle slot suggestions (E-319)
	let candidateQueue: TaskDescriptor[] = [];
	const blockedQueue: Array<{
		readonly task: TaskDescriptor;
		readonly blockedBy: readonly string[];
	}> = [];

	const activeBatchIdSet = input.activeBatchIds
		? input.activeBatchIds instanceof Set
			? input.activeBatchIds
			: new Set(input.activeBatchIds)
		: null;

	if (input.candidateTaskIds) {
		// 可派集合由调用方（`computeDispatchCandidates`）判定，保证与 tick 同一份队列。
		const candidateIdSet = new Set(input.candidateTaskIds);
		candidateQueue = sortedTasks.filter((t) => candidateIdSet.has(t.id));
		for (const item of input.blockedCandidates ?? []) {
			const task = tasksById.get(item.taskId);
			if (!task) continue;
			blockedQueue.push({ task, blockedBy: item.blockedBy });
		}
	} else {
		for (const t of sortedTasks) {
			if (t.is_removed_from_doc === 1) continue;
			if (isTaskFinishedOrLanded(t, runsByTaskId)) continue;
			if (typeof t.lane_no === 'number' && t.lane_no >= 1) continue;
			if (t.manual_state === 'paused' || t.manual_state === 'awaiting_human') continue;

			// If activeBatchIds is specified, only consider tasks in active batches (E-319).
			// 空集合 = 没有活动批次，未来空闲批次里的任务不得被推荐。
			if (activeBatchIdSet && (!t.batch_id || !activeBatchIdSet.has(t.batch_id))) {
				continue;
			}

			// Check if task has any active or parked run (E-326)
			const taskRuns = runsByTaskId.get(t.id) ?? [];
			const hasActiveOrParkedRun = taskRuns.some((r) =>
				[
					'queued',
					'starting',
					'running',
					'awaiting_reply',
					'reviewing',
					'reworking',
					'awaiting_human',
					'orphaned',
				].includes(r.state),
			);
			if (hasActiveOrParkedRun) {
				continue;
			}

			// Check if latest run is terminal failed (E-51: no auto-redispatch after terminal failure unless reworked)
			const latestRun = taskRuns.reduce<RunDescriptor | null>((prev, curr) => {
				if (!prev) return curr;
				const currAttempt = curr.attempt_no ?? 0;
				const prevAttempt = prev.attempt_no ?? 0;
				return currAttempt > prevAttempt ? curr : prev;
			}, null);
			if (
				latestRun &&
				isTerminalRunState(latestRun.state as RunState) &&
				latestRun.state !== 'landed'
			) {
				continue;
			}

			let depKeys: string[] = [];
			if (t.deps_json) {
				try {
					depKeys = JSON.parse(t.deps_json);
				} catch {
					depKeys = [];
				}
			}

			const missingDepKeys: string[] = [];
			for (const depKey of depKeys) {
				const depTask = sortedTasks.find(
					(other) => other.task_key === depKey || other.id === depKey,
				);
				if (!depTask || !isTaskFinishedOrLanded(depTask, runsByTaskId)) {
					missingDepKeys.push(depKey);
				}
			}

			if (missingDepKeys.length === 0) {
				candidateQueue.push(t);
			} else {
				missingDepKeys.sort((a, b) => a.localeCompare(b));
				blockedQueue.push({ task: t, blockedBy: missingDepKeys });
			}
		}
	}

	// Sort queues strictly by (layerNo, taskKey) (AC 1, E-319)
	candidateQueue.sort((a, b) => {
		const layerA = a.layer_no ?? 0;
		const layerB = b.layer_no ?? 0;
		if (layerA !== layerB) return layerA - layerB;
		return a.task_key.localeCompare(b.task_key);
	});

	blockedQueue.sort((a, b) => {
		const layerA = a.task.layer_no ?? 0;
		const layerB = b.task.layer_no ?? 0;
		if (layerA !== layerB) return layerA - layerB;
		return a.task.task_key.localeCompare(b.task.task_key);
	});

	let nextCandidateIdx = 0;
	let nextBlockedIdx = 0;

	// Pre-index archived runs per lane for history lookup (AC 1, E-325)
	const archivedRunsByLane = new Map<number, RunDescriptor[]>();
	for (const r of sortedRuns) {
		if (
			typeof r.lane_no === 'number' &&
			r.lane_no >= 1 &&
			(r.session_archived_at !== null || isTerminalRunState(r.state as RunState))
		) {
			const list = archivedRunsByLane.get(r.lane_no) ?? [];
			list.push(r);
			archivedRunsByLane.set(r.lane_no, list);
		}
	}

	const lanes: LaneView[] = [];

	for (let laneNo = 1; laneNo <= totalLanes; laneNo++) {
		const overLimit = laneNo > input.laneCount;
		const task = tasksByLane.get(laneNo);
		const wrapup = activeWrapupByLane.get(laneNo);

		let taskId: string | null = null;
		let currentRunId: string | null = null;
		let stage: LaneStage = 'idle';
		let nextTaskId: string | null = null;
		let nextBlockedBy: readonly string[] = Object.freeze([]);

		if (task) {
			taskId = task.id;
			const taskRuns = runsByTaskId.get(task.id) ?? [];
			const activeRun = taskRuns.find((r) => !isTerminalRunState(r.state as RunState));
			const latestRun =
				taskRuns.length > 0
					? taskRuns.reduce((prev, curr) =>
							(curr.attempt_no ?? 0) > (prev.attempt_no ?? 0) ? curr : prev,
						)
					: null;

			const targetRun = activeRun ?? latestRun;
			currentRunId = targetRun?.id ?? null;

			// Stage derivation based on active runs or task state (09 节 数据模型 / E-332)
			const bughuntRun = taskRuns.find(
				(r) => r.kind === 'bughunt' && !isTerminalRunState(r.state as RunState),
			);
			const reviewRun = taskRuns.find(
				(r) => r.kind === 'review' && !isTerminalRunState(r.state as RunState),
			);
			const implementRun = taskRuns.find((r) => r.kind === 'implement');

			if (bughuntRun) {
				stage = 'bughunt';
				currentRunId = bughuntRun.id;
			} else if (reviewRun) {
				stage = 'review';
				currentRunId = reviewRun.id;
			} else if (implementRun && implementRun.state === 'reworking') {
				stage = 'rework';
				currentRunId = implementRun.id;
			} else if (implementRun && implementRun.state === 'queued') {
				stage = 'queued';
				currentRunId = implementRun.id;
			} else if (implementRun && implementRun.state === 'reviewing') {
				stage = 'review';
				currentRunId = implementRun.id;
			} else {
				stage = 'implement';
			}
		} else if (wrapup) {
			taskId = null;
			currentRunId = wrapup.id;
			stage = 'wrapup';
		} else {
			// Idle slot: suggest next task (AC 1, E-319)
			stage = 'idle';
			taskId = null;
			currentRunId = null;

			if (nextCandidateIdx < candidateQueue.length) {
				const cand = candidateQueue[nextCandidateIdx];
				if (cand) {
					nextCandidateIdx++;
					nextTaskId = cand.id;
					nextBlockedBy = Object.freeze([]);
				}
			} else if (nextBlockedIdx < blockedQueue.length) {
				const item = blockedQueue[nextBlockedIdx];
				if (item) {
					nextBlockedIdx++;
					nextTaskId = item.task.id;
					nextBlockedBy = Object.freeze([...item.blockedBy]);
				}
			}
		}

		// Archived history lookup (AC 1)
		const laneHistory = archivedRunsByLane.get(laneNo) ?? [];
		// Sort historical runs by timestamp descending to find most recent
		const sortedHistory = [...laneHistory].sort((a, b) => {
			const timeA = a.session_archived_at ?? a.ended_at ?? a.started_at ?? a.last_event_at ?? '';
			const timeB = b.session_archived_at ?? b.ended_at ?? b.started_at ?? b.last_event_at ?? '';
			if (timeA !== timeB) return timeB.localeCompare(timeA);
			return b.id.localeCompare(a.id);
		});

		const recentTaskRun = sortedHistory.find((r) => r.task_id !== null && r.task_id !== undefined);
		const archivedTaskIds =
			recentTaskRun?.task_id !== undefined && recentTaskRun?.task_id !== null
				? Object.freeze([recentTaskRun.task_id])
				: Object.freeze([]);

		const recentWrapupRun = sortedHistory.find((r) => r.kind === 'wrapup');
		const archivedWrapupRunId = recentWrapupRun ? recentWrapupRun.id : null;

		lanes.push(
			Object.freeze({
				laneNo,
				taskId,
				currentRunId,
				stage,
				nextTaskId,
				nextBlockedBy,
				archivedTaskIds,
				archivedWrapupRunId,
				overLimit,
			}),
		);
	}

	return Object.freeze(lanes);
}
