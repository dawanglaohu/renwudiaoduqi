import type { LaneView } from '@agent-scheduler/shared/api/lanes';
import { deriveLanes } from '../domain/lanes.ts';
import type { DocumentsRepo } from '../repo/documents.ts';
import type { RunsRepo } from '../repo/runs.ts';
import type { TasksRepo } from '../repo/tasks.ts';

export interface LanesServiceDeps {
	readonly documentsRepo: DocumentsRepo;
	readonly tasksRepo: TasksRepo;
	readonly runsRepo: RunsRepo;
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
			const runs = deps.runsRepo.listAll();

			return deriveLanes({
				laneCount,
				tasks,
				runs,
			});
		},
	});
}
