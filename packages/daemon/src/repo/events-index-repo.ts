import type { DatabaseConnection } from '../db/open-database.ts';
import type { EventIndexRecord } from '../logstore/contract.ts';

interface EventDataRow {
	id: number;
	run_id: string;
	task_id: string | null;
	seq: number;
	ts: string;
	scope: string;
	kind: string;
	actor_device_id: string | null;
	file_seq: number;
	byte_offset: number;
	byte_len: number;
}

const INSERT_SQL = `
INSERT INTO events (run_id, task_id, seq, ts, scope, kind, actor_device_id, file_seq, byte_offset, byte_len)
VALUES (@runId, @taskId, @seq, @ts, @scope, @kind, @actorDeviceId, @fileSeq, @byteOffset, @byteLen)
`;

const SELECT_LAST_INDEX_SQL = `
SELECT file_seq, byte_offset, byte_len
FROM events
WHERE run_id = ?
ORDER BY seq DESC
LIMIT 1
`;

export interface EventsIndexRepo {
	/** Append-only: one index row per indexed event line. */
	readonly insertIndex: (record: EventIndexRecord) => void;
	/** Byte offset right after the last indexed event line; 0 when nothing indexed. */
	readonly lastIndexedEnd: (runId: string) => number;
	/** The file_seq of the last indexed line; null when nothing indexed. */
	readonly lastIndexedFileSeq: (runId: string) => number | null;
}

export function createEventsIndexRepo(database: DatabaseConnection): EventsIndexRepo {
	const insert = database.prepare(INSERT_SQL);
	const selectLast = database.prepare(SELECT_LAST_INDEX_SQL);

	function lastRow(
		runId: string,
	): { file_seq: number; byte_offset: number; byte_len: number } | null {
		const row = selectLast.get(runId) as
			| { file_seq: number; byte_offset: number; byte_len: number }
			| undefined;
		return row ?? null;
	}

	return Object.freeze({
		insertIndex(record: EventIndexRecord): void {
			insert.run({
				runId: record.runId,
				taskId: record.taskId,
				seq: record.seq,
				ts: record.ts,
				scope: record.scope,
				kind: record.kind,
				actorDeviceId: record.actorDeviceId,
				fileSeq: record.fileSeq,
				byteOffset: record.byteOffset,
				byteLen: record.byteLen,
			});
		},
		lastIndexedEnd(runId: string): number {
			const row = lastRow(runId);
			if (row === null) return 0;
			return row.byte_offset + row.byte_len;
		},
		lastIndexedFileSeq(runId: string): number | null {
			return lastRow(runId)?.file_seq ?? null;
		},
	});
}
