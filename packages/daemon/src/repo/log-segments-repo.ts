import type { DatabaseConnection } from '../db/open-database.ts';

export type SegmentStream = 'raw' | 'events';

export interface SegmentInsert {
	readonly id: string;
	readonly runId: string;
	readonly stream: SegmentStream;
	readonly fileSeq: number;
	readonly path: string;
	readonly byteStart: number;
	readonly byteEnd: number;
	readonly lineCount: number;
}

export interface SegmentRow {
	readonly id: string;
	readonly runId: string;
	readonly stream: SegmentStream;
	readonly fileSeq: number;
	readonly path: string;
	readonly byteStart: number;
	readonly byteEnd: number;
	readonly lineCount: number;
}

interface SegmentDataRow {
	id: string;
	run_id: string;
	stream: string;
	file_seq: number;
	path: string;
	byte_start: number;
	byte_end: number;
	line_count: number;
}

const INSERT_SQL = `
INSERT OR IGNORE INTO log_segments (id, run_id, stream, file_seq, path, byte_start, byte_end, line_count)
VALUES (@id, @runId, @stream, @fileSeq, @path, @byteStart, @byteEnd, @lineCount)
`;

const SELECT_BY_RUN_STREAM_SQL = `
SELECT id, run_id, stream, file_seq, path, byte_start, byte_end, line_count
FROM log_segments
WHERE run_id = ? AND stream = ?
ORDER BY file_seq ASC
`;

const SELECT_ALL_SQL = `
SELECT id, run_id, stream, file_seq, path, byte_start, byte_end, line_count
FROM log_segments
ORDER BY run_id, stream, file_seq
`;

export interface LogSegmentsRepo {
	readonly insertSegments: (segments: readonly SegmentInsert[]) => void;
	readonly findByRunStream: (runId: string, stream: SegmentStream) => readonly SegmentRow[];
	readonly listAll: () => readonly SegmentRow[];
}

export function createLogSegmentsRepo(db: DatabaseConnection): LogSegmentsRepo {
	const insert = db.prepare(INSERT_SQL);
	const selectByRunStream = db.prepare(SELECT_BY_RUN_STREAM_SQL);
	const selectAll = db.prepare(SELECT_ALL_SQL);

	return Object.freeze({
		insertSegments(segments: readonly SegmentInsert[]) {
			for (const s of segments) {
				insert.run({
					id: s.id,
					runId: s.runId,
					stream: s.stream,
					fileSeq: s.fileSeq,
					path: s.path,
					byteStart: s.byteStart,
					byteEnd: s.byteEnd,
					lineCount: s.lineCount,
				});
			}
		},
		findByRunStream(runId: string, stream: SegmentStream) {
			return (selectByRunStream.all(runId, stream) as SegmentDataRow[]).map(mapRow);
		},
		listAll() {
			return (selectAll.all() as SegmentDataRow[]).map(mapRow);
		},
	});
}

function mapRow(row: SegmentDataRow): SegmentRow {
	return Object.freeze({
		id: row.id,
		runId: row.run_id,
		stream: row.stream === 'events' ? 'events' : 'raw',
		fileSeq: row.file_seq,
		path: row.path,
		byteStart: row.byte_start,
		byteEnd: row.byte_end,
		lineCount: row.line_count,
	});
}
