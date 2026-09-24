import type { LaneView } from '@agent-scheduler/shared/api/lanes';
import { computeDispatchCandidates } from '../domain/dispatch-candidates.ts';
import { deriveLanes } from '../domain/lanes.ts';
import type { BatchesRepo } from '../repo/batches.ts';
import type { DocumentsRepo } from '../repo/documents.ts';
import type { RunsRepo } from '../repo/runs.ts';
import type { TasksRepo } from '../repo/tasks.ts';

export interface LanesServiceDeps {
	readonly documentsRepo: DocumentsRepo;
	readonly tasksRepo: TasksRepo;
	readonly runsRepo: RunsRepo;
	readonly batchesRepo?: BatchesRepo;
}

export interface LanesService {
	readonly getLanes: (docId?: string) => readonly LaneView[];
}

/**
 * Service calculating live pipeline lanes snapshot (AC 1, AC 7, E-317):
 * - Always computed on demand (no caching).
 * - Never opens a database transaction.
 * - Never executes git operations.
 */
export function createLanesService(deps: LanesServiceDeps): LanesService {
	return Object.freeze({
		getLanes(docId?: string): readonly LaneView[] {
			const allDocs = deps.documentsRepo.listAll();
			let targetDoc = docId ? deps.documentsRepo.findById(docId) : null;
			if (!targetDoc) {
				targetDoc = allDocs.find((d) => d.is_source_readable === 1) ?? allDocs[0] ?? null;
			}

			const laneCount = targetDoc?.lane_count ?? 2;
			const tasks = targetDoc
				? deps.tasksRepo.listByDocId(targetDoc.id)
				: allDocs.flatMap((d) => deps.tasksRepo.listByDocId(d.id));
			const docTaskIds = new Set(tasks.map((t) => t.id));

			const docBatches =
				targetDoc && deps.batchesRepo ? deps.batchesRepo.listByDocId(targetDoc.id) : [];
			const docBatchIds = new Set(docBatches.map((b) => b.id));
			const activeBatchIds = new Set(
				docBatches
					.filter((b) => b.state === 'running' || b.state === 'awaiting_landing')
					.map((b) => b.id),
			);

			const allRuns = deps.runsRepo.listAll();
			// 运行历史必须按文档作用域裁：别的文档的活动收口运行不得占本文档的泳道（E-317）
			const runs = allRuns.filter(
				(r) =>
					(r.task_id && docTaskIds.has(r.task_id)) || (r.batch_id && docBatchIds.has(r.batch_id)),
			);

			// 与 tick 同一份可派队列：契约未就绪、文档待确认、停靠/未来批次、前置未落地都在这里判掉
			const candidates = computeDispatchCandidates({
				tasks,
				runs,
				activeBatchIds,
			});

			return deriveLanes({
				laneCount,
				tasks,
				runs,
				// 空集合也要传：它表示"当前没有活动批次"，而不是"不过滤"
				activeBatchIds,
				candidateTaskIds: candidates.eligibleTaskIds,
				blockedCandidates: candidates.waitingOnDeps,
			});
		},
	});
}
