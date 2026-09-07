import type { EventsIndexRepo } from '../repo/events-index-repo.ts';
import type { LogSegmentsRepo } from '../repo/log-segments-repo.ts';
import type { AppendQueue } from './append-queue.ts';
import type { LogstoreIds } from './contract.ts';
import type { LogstorePaths } from './paths.ts';
import { type RunLogWriter, createRunLogWriter } from './run-writer.ts';

export interface LogstoreDeps {
	readonly paths: LogstorePaths;
	readonly queue: AppendQueue;
	readonly ids: LogstoreIds;
	readonly segmentsRepo: LogSegmentsRepo;
	readonly eventsIndexRepo: EventsIndexRepo;
}

export interface Logstore {
	readonly queue: AppendQueue;
	readonly createWriter: (runId: string) => RunLogWriter;
}

export function createLogstore(deps: LogstoreDeps): Logstore {
	return {
		queue: deps.queue,
		createWriter(runId: string) {
			return createRunLogWriter({
				runId,
				paths: deps.paths,
				queue: deps.queue,
				ids: deps.ids,
				segmentsRepo: deps.segmentsRepo,
				eventsIndexRepo: deps.eventsIndexRepo,
			});
		},
	};
}
