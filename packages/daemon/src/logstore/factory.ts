import { appendFile } from 'node:fs/promises';
import type { DatabaseConnection } from '../db/open-database.ts';
import { createEventsIndexRepo } from '../repo/events-index-repo.ts';
import { createLogSegmentsRepo } from '../repo/log-segments-repo.ts';
import { createAppendQueue } from './append-queue.ts';
import type { LogFileSystem, LogstoreIds } from './contract.ts';
import { createLogstore } from './logstore.ts';
import { createLogstorePaths } from './paths.ts';

export function createDefaultLogstore(
	baseDir: string,
	database: DatabaseConnection,
	_fs: LogFileSystem,
	ids: LogstoreIds,
) {
	return createLogstore({
		paths: createLogstorePaths(baseDir),
		queue: createAppendQueue({ appendFile }),
		ids,
		segmentsRepo: createLogSegmentsRepo(database),
		eventsIndexRepo: createEventsIndexRepo(database),
	});
}
