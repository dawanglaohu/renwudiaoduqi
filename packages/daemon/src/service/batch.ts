import type { BatchDto, BatchState } from '@agent-scheduler/shared/api/batches';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { summarizeBatchLanding } from '../domain/batch-landing.ts';
import { assertCanTransitionBatch } from '../domain/batch-state-machine.ts';
import { deriveTaskState } from '../domain/task-state.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { BatchRow, BatchesRepo } from '../repo/batches.ts';
import type { RunRow, RunsRepo } from '../repo/runs.ts';
import type { TaskRow, TasksRepo } from '../repo/tasks.ts';

export interface BatchServiceDeps {
	readonly batchesRepo: BatchesRepo;
	readonly tasksRepo: TasksRepo;
	readonly runsRepo: RunsRepo;
	readonly unitOfWork: UnitOfWork;
	readonly clock: { readonly now: () => string };
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
}

export interface TransitionBatchInput {
	readonly batchId: string;
	readonly toState: BatchState;
	readonly reason: string;
}

export interface TransitionBatchInTxResult {
	readonly updatedBatch: BatchRow;
	readonly envelope: EventEnvelope;
	readonly fromState: BatchState;
	readonly toState: BatchState;
}

export interface BatchDtoExtra {
	readonly canWrapup?: boolean;
	readonly notInHeadCount?: number;
	readonly taskCount?: number;
	readonly landedCount?: number;
	readonly runningCount?: number;
	readonly waitingCount?: number;
	readonly defaultExpanded?: boolean;
}

export function isBatchDefaultExpanded(state: BatchState): boolean {
	return (
		state === 'running' ||
		state === 'wrapping' ||
		state === 'awaiting_landing' ||
		state === 'needs_attention'
	);
}

export interface BatchTaskSummary {
	readonly taskCount: number;
	readonly landedCount: number;
	readonly runningCount: number;
	readonly waitingCount: number;
	readonly defaultExpanded: boolean;
}

export function computeBatchSummary(
	batchState: BatchState,
	tasks: readonly TaskRow[],
	runsOrRunsByTaskId: readonly RunRow[] | ReadonlyMap<string, readonly RunRow[]>,
): BatchTaskSummary {
	let runsByTaskId: ReadonlyMap<string, readonly RunRow[]>;
	if (runsOrRunsByTaskId instanceof Map) {
		runsByTaskId = runsOrRunsByTaskId;
	} else {
		const map = new Map<string, RunRow[]>();
		for (const r of runsOrRunsByTaskId as readonly RunRow[]) {
			if (!r.task_id) continue;
			const list = map.get(r.task_id) ?? [];
			list.push(r);
			map.set(r.task_id, list);
		}
		runsByTaskId = map;
	}

	let landedCount = 0;
	let runningCount = 0;
	let waitingCount = 0;

	for (const task of tasks) {
		const taskRuns = runsByTaskId.get(task.id) ?? [];
		const state = deriveTaskState(
			{
				manualState: task.manual_state,
				runs: taskRuns,
			},
			undefined,
			{ ignoreWrapupFix: true },
		);

		if (state === 'landed') {
			landedCount += 1;
		} else if (
			state === 'starting' ||
			state === 'running' ||
			state === 'reviewing' ||
			state === 'reworking'
		) {
			runningCount += 1;
		} else if (state === 'awaiting_human' || state === 'awaiting_reply' || state === 'orphaned') {
			waitingCount += 1;
		}
	}

	return {
		taskCount: tasks.length,
		landedCount,
		runningCount,
		waitingCount,
		defaultExpanded: isBatchDefaultExpanded(batchState),
	};
}

export interface BatchService {
	readonly transitionBatch: (batchId: string, toState: BatchState, reason: string) => BatchRow;
	readonly transitionBatchInTx: (
		batchId: string,
		toState: BatchState,
		reason: string,
	) => TransitionBatchInTxResult;
	readonly getBatch: (batchId: string) => Promise<BatchDto>;
	readonly listBatches: (docId: string) => Promise<readonly BatchDto[]>;
	readonly toDto: (row: BatchRow, extra?: BatchDtoExtra) => BatchDto;
}

export function toBatchDto(row: BatchRow, extra?: BatchDtoExtra): BatchDto {
	return Object.freeze({
		id: row.id,
		docId: row.doc_id,
		batchNo: row.batch_no,
		state: row.state,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		canWrapup: extra?.canWrapup,
		notInHeadCount: extra?.notInHeadCount,
		taskCount: extra?.taskCount ?? 0,
		landedCount: extra?.landedCount ?? 0,
		runningCount: extra?.runningCount ?? 0,
		waitingCount: extra?.waitingCount ?? 0,
		defaultExpanded: extra?.defaultExpanded ?? isBatchDefaultExpanded(row.state),
	});
}

export function createBatchService(deps: BatchServiceDeps): BatchService {
	function transitionBatchInTx(
		batchId: string,
		toState: BatchState,
		reason: string,
	): TransitionBatchInTxResult {
		const current = deps.batchesRepo.findById(batchId);
		if (!current) {
			throw new AppError('E_NOT_FOUND', `Batch not found: ${batchId}`);
		}

		assertCanTransitionBatch(current.state, toState);

		const now = deps.clock.now();
		const startedAt = toState === 'running' && !current.started_at ? now : current.started_at;
		const finishedAt = toState === 'done' ? (current.finished_at ?? now) : null;

		deps.batchesRepo.updateState({
			id: batchId,
			state: toState,
			started_at: startedAt,
			finished_at: finishedAt,
		});

		const updated = deps.batchesRepo.findById(batchId);
		if (!updated) {
			throw new AppError('E_INTERNAL', `Failed to retrieve updated batch: ${batchId}`);
		}

		const envelope = deps.envelopeFactory
			? deps.envelopeFactory.createEnvelope({
					kind: 'batch.advanced',
					payload: {
						batchId,
						batchNo: current.batch_no,
						from: current.state,
						to: toState,
						reason,
					},
				})
			: ({
					id: 0,
					ts: now,
					runId: null,
					taskId: null,
					scope: 'batch',
					kind: 'batch.advanced',
					seq: 1,
					actorDeviceId: null,
					payload: {
						batchId,
						batchNo: current.batch_no,
						from: current.state,
						to: toState,
						reason,
					},
				} as EventEnvelope);

		return {
			updatedBatch: updated,
			envelope,
			fromState: current.state,
			toState,
		};
	}

	return Object.freeze({
		toDto: toBatchDto,

		transitionBatchInTx,

		transitionBatch(batchId: string, toState: BatchState, reason: string): BatchRow {
			let result: TransitionBatchInTxResult | null = null;

			// All mutations must occur within a single UnitOfWork transaction, no await/bus.publish inside tx (08 节, AC 1, AC 7)
			deps.unitOfWork.run(() => {
				result = transitionBatchInTx(batchId, toState, reason);
			});

			if (result && deps.bus) {
				deps.bus.publish((result as TransitionBatchInTxResult).envelope);
			}

			if (!result) {
				throw new AppError('E_INTERNAL', `Failed to retrieve updated batch: ${batchId}`);
			}
			return (result as TransitionBatchInTxResult).updatedBatch;
		},

		async getBatch(batchId: string): Promise<BatchDto> {
			const batch = deps.batchesRepo.findById(batchId);
			if (!batch) {
				throw new AppError('E_NOT_FOUND', `Batch not found: ${batchId}`);
			}

			const tasks = deps.tasksRepo.listByBatchId(batchId);
			const runs = deps.runsRepo.listAll();
			// 与 tick / triggerWrapup 同一判定（domain/batch-landing.ts）
			const landing = summarizeBatchLanding(tasks, runs);
			const activeWrapup = deps.runsRepo.findActiveWrapupByBatchId?.(batchId);
			const canWrapup =
				landing.allInHead && !activeWrapup && batch.state !== 'done' && batch.state !== 'wrapping';
			const summary = computeBatchSummary(batch.state, tasks, runs);

			return toBatchDto(batch, {
				canWrapup,
				notInHeadCount: landing.notInHeadCount,
				...summary,
			});
		},

		async listBatches(docId: string): Promise<readonly BatchDto[]> {
			const batches = deps.batchesRepo.listByDocId(docId);
			const result: BatchDto[] = [];
			const runs = deps.runsRepo.listAll();
			const runsByTaskId = new Map<string, RunRow[]>();
			for (const r of runs) {
				if (!r.task_id) continue;
				const list = runsByTaskId.get(r.task_id) ?? [];
				list.push(r);
				runsByTaskId.set(r.task_id, list);
			}

			for (const b of batches) {
				const tasks = deps.tasksRepo.listByBatchId(b.id);
				const landing = summarizeBatchLanding(tasks, runs);
				const allInHead = landing.allInHead;
				const notInHeadCount = landing.notInHeadCount;
				const activeWrapup = deps.runsRepo.findActiveWrapupByBatchId?.(b.id);
				const canWrapup =
					allInHead && !activeWrapup && b.state !== 'done' && b.state !== 'wrapping';
				const summary = computeBatchSummary(b.state, tasks, runsByTaskId);

				result.push(
					toBatchDto(b, {
						canWrapup,
						notInHeadCount,
						...summary,
					}),
				);
			}
			return Object.freeze(result);
		},
	});
}
