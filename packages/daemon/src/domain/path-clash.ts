import { AppError } from '../errors/app-error.ts';
import { RUN_STATES, type RunState, TERMINAL_RUN_STATES } from './run-state-machine.ts';

/**
 * Prefix for run.queued_reason when blocked by path clash (E-46).
 */
export const PATH_CONFLICT_REASON_PREFIX = 'path_conflict:';

/**
 * Prefix for run.queued_reason when serialized by wrapup fix (M8-T7, E-280).
 */
export const WRAPUP_FIX_SERIAL_PREFIX = 'wrapup-fix-serial:';

/**
 * Task/run states that still occupy a path lock (AC 1, E-46).
 *
 * Projection of the run state machine (09 数据模型): a lock is released only by a
 * terminal state — 'landed' proves the change is on the trunk, and a terminal
 * failure means the change can never land. 'exited' IS a holding state because
 * process exit (exit code 0) does NOT equal landing
 * ("等前者到达「已落地」（不是「已退出」）才起"); review and landing gates must pass
 * before the lock is released.
 */
export const ACTIVE_PATH_HOLDING_STATES: readonly RunState[] = Object.freeze(
	RUN_STATES.filter((state) => !(TERMINAL_RUN_STATES as readonly string[]).includes(state)),
);

export type ActivePathHoldingState = Exclude<RunState, (typeof TERMINAL_RUN_STATES)[number]>;

/**
 * Checks whether a task or run state represents "已落地" (landed).
 * Per AC 1 & E-46: Only 'landed' releases the path lock; 'exited' is NOT landed.
 */
export function isTaskLanded(state: string | null | undefined): boolean {
	return state === 'landed';
}

/**
 * Checks whether a task or run state is holding a path lock.
 *
 * AC 1 & E-46 requirement:
 * The prior task holds the lock until it reaches 'landed', NOT merely 'exited'.
 * Once it transitions to 'landed', the lock is released.
 * Terminal failure states (failed, aborted, interrupted) do not hold path locks
 * for unblocking independent tasks (M8-T3 AC 3).
 */
export function isTaskPathHolding(state: string | null | undefined): boolean {
	// Release only on evidence that the change can no longer land: 'landed' itself,
	// or a terminal failure. A missing or unrecognised state must NOT fail open —
	// reading it as "released" would put two tasks on the same files and recreate the
	// conflict at landing time (E-46). Only reachable states hold by default.
	if (!state) {
		return true;
	}
	return !(TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

/**
 * Pair of paths that clash with each other.
 */
export interface PathClashPair {
	readonly pathA: string;
	readonly pathB: string;
	readonly normalizedA: string;
	readonly normalizedB: string;
}

/**
 * Task path descriptor used for path clash detection and queue scheduling.
 */
export interface TaskPathDescriptor {
	readonly taskId: string;
	readonly taskKey?: string;
	readonly taskPaths: readonly string[];
	/**
	 * Current state of the task or its latest run.
	 */
	readonly state?: string;
	/**
	 * Run ID if associated with a specific run.
	 */
	readonly runId?: string;
	/**
	 * Optional worktree path.
	 *
	 * CRITICAL ARCHITECTURAL CONSTRAINT (AC 2):
	 * Worktree isolation is NOT a reason for clearance.
	 * Code MUST NOT contain any branch like "if (worktree) grant clearance".
	 * Tasks sharing taskPaths must queue regardless of whether they execute
	 * in isolated worktrees (E-46).
	 */
	readonly worktreePath?: string | null;
	/**
	 * Optional batch ID.
	 */
	readonly batchId?: string | null;
}

/**
 * Result of checking path clash between two tasks.
 */
export interface TaskClashResult {
	readonly hasClash: boolean;
	readonly conflictingPaths: readonly PathClashPair[];
	readonly blockerTaskId?: string;
	readonly blockerTaskKey?: string;
	readonly blockerRunId?: string;
	readonly queuedReason?: string;
}

/**
 * Information about a candidate task blocked in queue.
 */
export interface BlockedTaskInfo {
	readonly task: TaskPathDescriptor;
	readonly blockedByTaskId: string;
	readonly blockedByTaskKey?: string;
	readonly blockedByRunId?: string;
	readonly queuedReason: string;
	readonly conflictingPaths: readonly PathClashPair[];
}

/**
 * Input for evaluating candidate tasks against path clashes in a batch.
 */
export interface PathClashQueueEvaluationInput {
	/**
	 * Currently active / dispatched tasks holding paths.
	 */
	readonly activeTasks?: readonly TaskPathDescriptor[];

	/**
	 * Candidate tasks awaiting dispatch in priority / schedule order.
	 */
	readonly candidates: readonly TaskPathDescriptor[];

	/**
	 * Optional batch ID filter. When set with sameBatchOnly (default true),
	 * tasks in differing batches do not conflict per E-46 same-batch scope.
	 */
	readonly batchId?: string | null;

	/**
	 * Whether to restrict conflict detection strictly to tasks within the same batch.
	 * Defaults to true per AC 1 ("同批内两任务 taskPaths 有交集时").
	 * Can be set to false for cross-batch fix runs (M8-T7, E-280).
	 */
	readonly sameBatchOnly?: boolean;

	/**
	 * Optional case-insensitive comparison (default false).
	 */
	readonly caseInsensitive?: boolean;
}

/**
 * Result of evaluating candidate tasks against path clashes.
 */
export interface PathClashQueueEvaluationResult {
	/**
	 * Candidate tasks that have no path clashes and may be dispatched immediately
	 * (subject to concurrency window / lane limits).
	 */
	readonly dispatchable: readonly TaskPathDescriptor[];

	/**
	 * Candidate tasks that must wait in queue because an active or earlier candidate task
	 * touches conflicting paths.
	 */
	readonly blocked: readonly BlockedTaskInfo[];

	/**
	 * Effective concurrent task limit allowed by path non-interference.
	 * Feeds directly into M8-T1 calculateConcurrencyLimit as pathConflictLimit.
	 */
	readonly pathConflictLimit: number;
}

/**
 * Normalizes a file or directory path into a canonical relative POSIX representation.
 * - Converts backslashes to slashes.
 * - Collapses repeated slashes.
 * - Resolves '.' and '..' segments.
 * - Strips leading and trailing slashes.
 */
export function normalizePath(rawPath: string): string {
	if (!rawPath || typeof rawPath !== 'string') {
		return '';
	}
	const p = rawPath.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
	const parts = p.split('/');
	const stack: string[] = [];

	for (const part of parts) {
		if (part === '' || part === '.') {
			continue;
		}
		if (part === '..') {
			if (stack.length > 0 && stack[stack.length - 1] !== '..') {
				stack.pop();
			} else {
				stack.push('..');
			}
		} else {
			stack.push(part);
		}
	}

	return stack.join('/');
}

/**
 * Decomposes a path into normalized, non-empty path segments (AC 3).
 *
 * AC 3: Path comparison is performed strictly segment by segment.
 * For example:
 * 'model/order' splits into ['model', 'order']
 * 'model/orderitem' splits into ['model', 'orderitem']
 * At segment index 1, 'order' !== 'orderitem', ensuring 'model/order' does NOT match 'model/orderitem'.
 */
export function getPathSegments(rawPath: string): readonly string[] {
	const normalized = normalizePath(rawPath);
	if (!normalized) {
		return Object.freeze([]);
	}
	return Object.freeze(normalized.split('/'));
}

/**
 * Determines whether two paths clash using segment-by-segment comparison (AC 3).
 *
 * Rules:
 * 1. If either path has 0 segments, returns false (empty paths do not clash).
 * 2. Compares segment by segment up to min(segA.length, segB.length).
 * 3. If any segment differs (e.g. 'order' vs 'orderitem'), returns false immediately.
 * 4. If all segments match up to min length:
 *    - Same length: identical path (file or directory) -> CLASH.
 *    - Differing length: one is ancestor directory containing the other -> CLASH.
 */
export function isPathClash(
	pathA: string,
	pathB: string,
	options?: { readonly caseInsensitive?: boolean },
): boolean {
	const segA = getPathSegments(pathA);
	const segB = getPathSegments(pathB);

	if (segA.length === 0 || segB.length === 0) {
		return false;
	}

	const caseInsensitive = options?.caseInsensitive ?? false;
	const minLen = Math.min(segA.length, segB.length);

	for (let i = 0; i < minLen; i++) {
		const sA = segA[i];
		const sB = segB[i];
		if (sA === undefined || sB === undefined) {
			return false;
		}
		if (caseInsensitive) {
			if (sA.toLowerCase() !== sB.toLowerCase()) {
				return false;
			}
		} else {
			if (sA !== sB) {
				return false;
			}
		}
	}

	return true;
}

/**
 * Checks whether any path in set A clashes with any path in set B.
 */
export function doPathSetsClash(
	pathsA: readonly string[],
	pathsB: readonly string[],
	options?: { readonly caseInsensitive?: boolean },
): boolean {
	for (const a of pathsA) {
		for (const b of pathsB) {
			if (isPathClash(a, b, options)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Finds all conflicting path pairs between two sets of paths.
 */
export function findPathClashes(
	pathsA: readonly string[],
	pathsB: readonly string[],
	options?: { readonly caseInsensitive?: boolean },
): readonly PathClashPair[] {
	const clashes: PathClashPair[] = [];
	for (const a of pathsA) {
		for (const b of pathsB) {
			if (isPathClash(a, b, options)) {
				clashes.push({
					pathA: a,
					pathB: b,
					normalizedA: normalizePath(a),
					normalizedB: normalizePath(b),
				});
			}
		}
	}
	return Object.freeze(clashes);
}

/**
 * Parses and normalizes task paths from JSON string, array, or null/undefined.
 */
export function parseTaskPaths(
	input: string | readonly string[] | null | undefined,
): readonly string[] {
	if (!input) {
		return Object.freeze([]);
	}
	if (Array.isArray(input)) {
		return Object.freeze(
			input
				.filter((item): item is string => typeof item === 'string')
				.map((p) => normalizePath(p))
				.filter(Boolean),
		);
	}
	if (typeof input === 'string') {
		const trimmed = input.trim();
		if (!trimmed || trimmed === '[]') {
			return Object.freeze([]);
		}
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return Object.freeze(
					parsed
						.filter((item): item is string => typeof item === 'string')
						.map((p) => normalizePath(p))
						.filter(Boolean),
				);
			}
		} catch {
			return Object.freeze(
				trimmed
					.split(/[\r\n,]+/)
					.map((s) => normalizePath(s))
					.filter(Boolean),
			);
		}
	}
	return Object.freeze([]);
}

/**
 * Constructs a structured queued_reason string when blocked by path clash (E-46).
 */
export function buildPathConflictReason(
	blockerTaskId: string,
	options?: {
		readonly taskKey?: string;
		readonly runId?: string;
	},
): string {
	if (!blockerTaskId) {
		throw new AppError('E_VALIDATION', 'blockerTaskId must not be empty');
	}
	const identity = options?.taskKey ? `${options.taskKey}:${blockerTaskId}` : blockerTaskId;
	if (options?.runId) {
		return `${PATH_CONFLICT_REASON_PREFIX}${identity}:${options.runId}`;
	}
	return `${PATH_CONFLICT_REASON_PREFIX}${identity}`;
}

/**
 * Checks whether a queued_reason string indicates a path conflict block.
 */
export function isPathConflictReason(reason: string | null | undefined): boolean {
	return typeof reason === 'string' && reason.startsWith(PATH_CONFLICT_REASON_PREFIX);
}

/**
 * Parses a path conflict queued_reason into component identifiers.
 */
export function parsePathConflictReason(reason: string | null | undefined): {
	readonly blockerTaskId: string;
	readonly taskKey?: string;
	readonly runId?: string;
} | null {
	if (!isPathConflictReason(reason)) {
		return null;
	}
	const payload = (reason as string).slice(PATH_CONFLICT_REASON_PREFIX.length);
	const parts = payload.split(':');
	const part0 = parts[0] ?? '';
	const part1 = parts[1] ?? '';
	const part2 = parts[2];

	if (parts.length === 1) {
		return { blockerTaskId: part0 };
	}
	if (parts.length === 2) {
		return { taskKey: part0, blockerTaskId: part1 };
	}
	return {
		taskKey: part0,
		blockerTaskId: part1,
		runId: part2,
	};
}

/**
 * Constructs a wrapup-fix serialization queued_reason string (M8-T7, E-280).
 */
export function buildWrapupFixSerialReason(runId: string): string {
	if (!runId) {
		throw new AppError('E_VALIDATION', 'runId must not be empty');
	}
	return `${WRAPUP_FIX_SERIAL_PREFIX}${runId}`;
}

/**
 * Checks whether a queued_reason indicates wrapup-fix serialization (M8-T7).
 */
export function isWrapupFixSerialReason(reason: string | null | undefined): boolean {
	return typeof reason === 'string' && reason.startsWith(WRAPUP_FIX_SERIAL_PREFIX);
}

/**
 * Parses a wrapup-fix serialization queued_reason string.
 */
export function parseWrapupFixSerialReason(
	reason: string | null | undefined,
): { readonly runId: string } | null {
	if (!isWrapupFixSerialReason(reason)) {
		return null;
	}
	const runId = (reason as string).slice(WRAPUP_FIX_SERIAL_PREFIX.length);
	return { runId };
}

/**
 * Wrapup-fix candidate descriptor for serial queue evaluation (M8-T7, E-280).
 */
export interface WrapupFixQueueCandidate {
	readonly runId: string;
	readonly taskId: string;
	readonly taskKey?: string;
	readonly taskPaths: readonly string[];
	readonly spawnedByRunId: string;
	readonly batchId?: string | null;
}

export interface WrapupFixQueueActiveRun {
	readonly runId: string;
	readonly taskId?: string | null;
	readonly spawnedByRunId?: string | null;
	readonly state?: string;
}

export interface SerializedWrapupFixRun {
	readonly candidate: WrapupFixQueueCandidate;
	readonly queuedReason: string;
	readonly waitingForRunId: string;
}

export interface EvaluateWrapupFixSerialResult {
	/**
	 * Fix runs that are not serialized behind another fix run from the same wrapup.
	 * (They may still face path conflict against unrelated active tasks).
	 */
	readonly runnable: readonly WrapupFixQueueCandidate[];
	/**
	 * Fix runs serialized behind earlier fix runs from the same wrapup run.
	 */
	readonly serialized: readonly SerializedWrapupFixRun[];
}

/**
 * Evaluates wrapup-fix runs for mutual serialization (AC 2, E-280).
 *
 * Rules:
 * 1. All fix runs dispatched from the SAME wrapup run (sharing spawned_by_run_id / worktree)
 *    must execute serially.
 * 2. If an existing active fix run from the same wrapup is still in-flight (not landed, not terminal),
 *    all candidates from that wrapup are serialized behind it (queued_reason = wrapup-fix-serial:<activeRunId>).
 * 3. Among new candidates from the same wrapup run:
 *    - The first candidate is runnable (free of serial block).
 *    - Subsequent candidates serialize behind the preceding candidate
 *      (queued_reason = wrapup-fix-serial:<priorCandidateRunId>).
 * 4. Fix runs from differing wrapup runs do not serialize against each other
 *    (though they still observe normal E-46 path conflicts).
 */
export function evaluateWrapupFixSerialization(
	candidates: readonly WrapupFixQueueCandidate[],
	activeRuns?: readonly WrapupFixQueueActiveRun[],
): EvaluateWrapupFixSerialResult {
	if (!candidates || candidates.length === 0) {
		return Object.freeze({ runnable: Object.freeze([]), serialized: Object.freeze([]) });
	}

	// Group active in-flight runs by spawnedByRunId
	const activeByWrapup = new Map<string, string>();
	if (activeRuns) {
		for (const r of activeRuns) {
			if (r.spawnedByRunId && isTaskPathHolding(r.state)) {
				if (!activeByWrapup.has(r.spawnedByRunId)) {
					activeByWrapup.set(r.spawnedByRunId, r.runId);
				}
			}
		}
	}

	const runnable: WrapupFixQueueCandidate[] = [];
	const serialized: SerializedWrapupFixRun[] = [];
	const lastRunIdByWrapup = new Map<string, string>();

	for (const candidate of candidates) {
		const wrapupId = candidate.spawnedByRunId;

		// Check if an existing in-flight run from the same wrapup is holding
		const activeRunId = activeByWrapup.get(wrapupId);
		if (activeRunId) {
			const waitingForRunId = lastRunIdByWrapup.get(wrapupId) ?? activeRunId;
			const queuedReason = buildWrapupFixSerialReason(waitingForRunId);
			serialized.push({
				candidate,
				queuedReason,
				waitingForRunId,
			});
			lastRunIdByWrapup.set(wrapupId, candidate.runId);
			continue;
		}

		// Check if an earlier candidate from the same wrapup was already made runnable
		const priorCandidateRunId = lastRunIdByWrapup.get(wrapupId);
		if (priorCandidateRunId) {
			const queuedReason = buildWrapupFixSerialReason(priorCandidateRunId);
			serialized.push({
				candidate,
				queuedReason,
				waitingForRunId: priorCandidateRunId,
			});
			lastRunIdByWrapup.set(wrapupId, candidate.runId);
		} else {
			// First candidate for this wrapup run is runnable!
			runnable.push(candidate);
			lastRunIdByWrapup.set(wrapupId, candidate.runId);
		}
	}

	return Object.freeze({
		runnable: Object.freeze(runnable),
		serialized: Object.freeze(serialized),
	});
}

/**
 * Checks path conflict between two specific tasks (AC 1, AC 2, AC 3, E-46).
 *
 * - AC 1: Evaluates path overlap.
 * - AC 2: Worktree isolation is NOT a reason for clearance. The presence of worktreePath
 *   on either or both tasks does NOT alter conflict outcome.
 * - AC 3: Segment-based path matching.
 */
export function checkTaskPathClash(
	taskA: TaskPathDescriptor,
	taskB: TaskPathDescriptor,
	options?: {
		readonly sameBatchOnly?: boolean;
		readonly caseInsensitive?: boolean;
	},
): TaskClashResult {
	if (!taskA || !taskB) {
		throw new AppError('E_VALIDATION', 'Both taskA and taskB must be provided');
	}

	if (taskA.taskId === taskB.taskId) {
		return {
			hasClash: false,
			conflictingPaths: Object.freeze([]),
		};
	}

	const sameBatchOnly = options?.sameBatchOnly ?? true;
	if (sameBatchOnly && taskA.batchId && taskB.batchId && taskA.batchId !== taskB.batchId) {
		return {
			hasClash: false,
			conflictingPaths: Object.freeze([]),
		};
	}

	const clashes = findPathClashes(taskA.taskPaths, taskB.taskPaths, {
		caseInsensitive: options?.caseInsensitive,
	});

	if (clashes.length === 0) {
		return {
			hasClash: false,
			conflictingPaths: Object.freeze([]),
		};
	}

	const queuedReason = buildPathConflictReason(taskA.taskId, {
		taskKey: taskA.taskKey,
		runId: taskA.runId,
	});

	return {
		hasClash: true,
		conflictingPaths: clashes,
		blockerTaskId: taskA.taskId,
		blockerTaskKey: taskA.taskKey,
		blockerRunId: taskA.runId,
		queuedReason,
	};
}

/**
 * Evaluates candidate tasks against active tasks and earlier candidate tasks in a batch (AC 1, AC 2, AC 3, E-46).
 *
 * Rules:
 * 1. Active tasks that have reached 'landed' DO NOT block any candidate (lock released).
 * 2. Active tasks in 'exited' or other non-landed states (reviewing, awaiting_human, running, etc.)
 *    CONTINUE to block candidate tasks sharing taskPaths ("等前者到达「已落地」（不是「已退出」）才起").
 * 3. Candidate tasks are evaluated in priority order. If candidate B clashes with candidate A
 *    (which was placed earlier in dispatchable), candidate B is blocked and queues behind candidate A.
 * 4. Worktree isolation does NOT grant clearance (AC 2).
 * 5. Returns dispatchable tasks, blocked tasks with queuedReason, and the pathConflictLimit.
 */
export function evaluatePathClashQueue(
	input: PathClashQueueEvaluationInput,
): PathClashQueueEvaluationResult {
	if (!input || !Array.isArray(input.candidates)) {
		throw new AppError('E_VALIDATION', 'candidates array must be provided');
	}

	const sameBatchOnly = input.sameBatchOnly ?? true;
	const activeTasks = (input.activeTasks ?? []).filter((t) => {
		// Only consider active tasks that hold path locks (non-landed)
		if (!isTaskPathHolding(t.state)) {
			return false;
		}
		if (sameBatchOnly && input.batchId && t.batchId && t.batchId !== input.batchId) {
			return false;
		}
		return true;
	});

	const dispatchable: TaskPathDescriptor[] = [];
	const blocked: BlockedTaskInfo[] = [];

	for (const candidate of input.candidates) {
		if (
			sameBatchOnly &&
			input.batchId &&
			candidate.batchId &&
			candidate.batchId !== input.batchId
		) {
			// Outside target batch; leave untouched or skip
			continue;
		}

		// 1. Check against active in-flight tasks
		let isBlocked = false;
		for (const active of activeTasks) {
			const clash = checkTaskPathClash(active, candidate, {
				sameBatchOnly,
				caseInsensitive: input.caseInsensitive,
			});

			if (clash.hasClash) {
				const queuedReason = buildPathConflictReason(active.taskId, {
					taskKey: active.taskKey,
					runId: active.runId,
				});
				blocked.push({
					task: candidate,
					blockedByTaskId: active.taskId,
					blockedByTaskKey: active.taskKey,
					blockedByRunId: active.runId,
					queuedReason,
					conflictingPaths: clash.conflictingPaths,
				});
				isBlocked = true;
				break;
			}
		}

		if (isBlocked) {
			continue;
		}

		// 2. Check against candidate tasks already selected for dispatch in this batch
		for (const accepted of dispatchable) {
			const clash = checkTaskPathClash(accepted, candidate, {
				sameBatchOnly,
				caseInsensitive: input.caseInsensitive,
			});

			if (clash.hasClash) {
				const queuedReason = buildPathConflictReason(accepted.taskId, {
					taskKey: accepted.taskKey,
					runId: accepted.runId,
				});
				blocked.push({
					task: candidate,
					blockedByTaskId: accepted.taskId,
					blockedByTaskKey: accepted.taskKey,
					blockedByRunId: accepted.runId,
					queuedReason,
					conflictingPaths: clash.conflictingPaths,
				});
				isBlocked = true;
				break;
			}
		}

		if (!isBlocked) {
			dispatchable.push(candidate);
		}
	}

	return {
		dispatchable: Object.freeze(dispatchable),
		blocked: Object.freeze(blocked),
		pathConflictLimit: dispatchable.length,
	};
}
