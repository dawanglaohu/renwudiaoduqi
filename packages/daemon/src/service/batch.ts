import type { BatchDto, BatchState } from '@agent-scheduler/shared/api/batches';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { summarizeBatchLanding } from '../domain/batch-landing.ts';
import { assertCanTransitionBatch } from '../domain/batch-state-machine.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { BatchRow, BatchesRepo } from '../repo/batches.ts';
import type { RunsRepo } from '../repo/runs.ts';
import type { TasksRepo } from '../repo/tasks.ts';

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

export interface BatchService {
	readonly transitionBatch: (batchId: string, toState: BatchState, reason: string) => BatchRow;
	readonly transitionBatchInTx: (
		batchId: string,
		toState: BatchState,
		reason: string,
	) => TransitionBatchInTxResult;
	readonly getBatch: (batchId: string) => Promise<BatchDto>;
	readonly listBatches: (docId: string) => Promise<readonly BatchDto[]>;
	readonly toDto: (
		row: BatchRow,
		extra?: { readonly canWrapup?: boolean; readonly notInHeadCount?: number },
	) => BatchDto;
}

export function toBatchDto(
	row: BatchRow,
	extra?: { readonly canWrapup?: boolean; readonly notInHeadCount?: number },
): BatchDto {
	return Object.freeze({
		id: row.id,
		docId: row.doc_id,
		batchNo: row.batch_no,
		state: row.state,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		canWrapup: extra?.canWrapup,
		notInHeadCount: extra?.notInHeadCount,
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
			// 与 tick / triggerWrapup 同一判定（domain/batch-landing.ts）
			const landing = summarizeBatchLanding(tasks, deps.runsRepo.listAll());
			const activeWrapup = deps.runsRepo.findActiveWrapupByBatchId?.(batchId);
			const canWrapup =
				landing.allInHead && !activeWrapup && batch.state !== 'done' && batch.state !== 'wrapping';

			return toBatchDto(batch, { canWrapup, notInHeadCount: landing.notInHeadCount });
		},

		async listBatches(docId: string): Promise<readonly BatchDto[]> {
			const batches = deps.batchesRepo.listByDocId(docId);
			const result: BatchDto[] = [];
			const runs = deps.runsRepo.listAll();
			for (const b of batches) {
				const tasks = deps.tasksRepo.listByBatchId(b.id);
				const landing = summarizeBatchLanding(tasks, runs);
				const allInHead = landing.allInHead;
				const notInHeadCount = landing.notInHeadCount;
				const activeWrapup = deps.runsRepo.findActiveWrapupByBatchId?.(b.id);
				const canWrapup =
					allInHead && !activeWrapup && b.state !== 'done' && b.state !== 'wrapping';

				result.push(toBatchDto(b, { canWrapup, notInHeadCount }));
			}
			return Object.freeze(result);
		},
	});
}
