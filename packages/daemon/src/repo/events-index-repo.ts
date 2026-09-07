import type { DatabaseConnection } from '../db/open-database.ts';

export interface EventIndexRecord {
	readonly id: number;
	readonly runId: string;
	readonly taskId: string | null;
	readonly seq: number;
	readonly ts: string;
	readonly scope: string;
	readonly kind: string;
	readonly actorDeviceId: string | null;
	readonly fileSeq: number;
	readonly byteOffset: number;
	readonly byteLen: number;
}

export interface LastIndexRow {
	readonly fileSeq: number;
	readonly byteOffset: number;
	readonly byteLen: number;
}

const INSERT_SQL = `
INSERT INTO events (id, run_id, task_id, seq, ts, scope, kind, actor_device_id, file_seq, byte_offset, byte_len)
VALUES (@id, @runId, @taskId, @seq, @ts, @scope, @kind, @actorDeviceId, @fileSeq, @byteOffset, @byteLen)
`;

const SELECT_LAST_INDEX_SQL = `
SELECT file_seq AS fileSeq, byte_offset AS byteOffset, byte_len AS byteLen
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

	function lastRow(runId: string): LastIndexRow | undefined {
		return selectLast.get(runId) as LastIndexRow | undefined;
	}

	return Object.freeze({
		insertIndex(record: EventIndexRecord): void {
			insert.run(record);
		},
		lastIndexedEnd(runId: string): number {
			const row = lastRow(runId);
			return row ? row.byteOffset + row.byteLen : 0;
		},
		lastIndexedFileSeq(runId: string): number | null {
			const row = lastRow(runId);
			return row ? row.fileSeq : null;
		},
	});
}
