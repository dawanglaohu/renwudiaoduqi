import type { DatabaseConnection } from '../db/open-database.ts';
import type { EventIndexRecord } from '../logstore/contract.ts';

const INSERT_SQL = `
INSERT INTO events (id, run_id, task_id, seq, ts, scope, kind, actor_device_id, file_seq, byte_offset, byte_len)
VALUES (@id, @runId, @taskId, @seq, @ts, @scope, @kind, @actorDeviceId, @fileSeq, @byteOffset, @byteLen)
`;

const SELECT_LAST_INDEX_SQL = `
SELECT file_seq, byte_offset, byte_len
FROM events
WHERE run_id = ?
ORDER BY seq DESC
LIMIT 1
`;

export interface EventsIndexRepo {
	readonly insertIndex: (record: EventIndexRecord) => void;
	readonly lastIndexedEnd: (runId: string) => number;
	readonly lastIndexedFileSeq: (runId: string) => number | null;
}

export function createEventsIndexRepo(database: DatabaseConnection): EventsIndexRepo {
	const insert = database.prepare(INSERT_SQL);
	const selectLast = database.prepare(SELECT_LAST_INDEX_SQL);

	function lastRow(runId: string) {
		return selectLast.get(runId) as
			| { file_seq: number; byte_offset: number; byte_len: number }
			| undefined;
	}

	return Object.freeze({
		insertIndex(record: EventIndexRecord): void {
			insert.run(record);
		},
		lastIndexedEnd(runId: string): number {
			const row = lastRow(runId);
			return row ? row.byte_offset + row.byte_len : 0;
		},
		lastIndexedFileSeq(runId: string): number | null {
			const row = lastRow(runId);
			return row ? row.file_seq : null;
		},
	});
}
