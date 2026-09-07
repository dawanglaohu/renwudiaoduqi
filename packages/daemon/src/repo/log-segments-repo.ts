import type { DatabaseConnection } from '../db/open-database.ts';
import type { SegmentInsert, SegmentRow } from '../logstore/contract.ts';

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

export interface LogSegmentRowFilters {
	readonly runId: string;
	readonly stream: string;
}

export interface LogSegmentsRepo {
	readonly insertSegments: (segments: readonly SegmentInsert[]) => void;
	readonly findByRunStream: (filters: LogSegmentRowFilters) => readonly SegmentRow[];
	readonly findGcCandidates: (runIds: readonly string[]) => readonly SegmentRow[];
}

const INSERT_SQL = `
INSERT INTO log_segments (id, run_id, stream, file_seq, path, byte_start, byte_end, line_count)
VALUES (@id, @runId, @stream, @fileSeq, @path, @byteStart, @byteEnd, @lineCount)
`;

const SELECT_BY_RUN_STREAM_SQL = `
SELECT id, run_id, stream, file_seq, path, byte_start, byte_end, line_count
FROM log_segments
WHERE run_id = ? AND stream = ?
ORDER BY file_seq ASC
`;

function buildGcSql(placeholders: string): string {
	return `SELECT id, run_id, stream, file_seq, path, byte_start, byte_end, line_count FROM log_segments WHERE run_id IN (${placeholders})`;
}

export function createLogSegmentsRepo(database: DatabaseConnection): LogSegmentsRepo {
	const statementFiles = {
		insert: database.prepare(INSERT_SQL),
		selectByRunStream: database.prepare(SELECT_BY_RUN_STREAM_SQL),
	};

	function insertSegments(segments: readonly SegmentInsert[]): void {
		if (segments.length === 0) return;
		for (const segment of segments) {
			statementFiles.insert.run({
				id: segment.id,
				runId: segment.runId,
				stream: segment.stream,
				fileSeq: segment.fileSeq,
				path: segment.path,
				byteStart: segment.byteStart,
				byteEnd: segment.byteEnd,
				lineCount: segment.lineCount,
			});
		}
	}

	function findByRunStream(filters: LogSegmentRowFilters): readonly SegmentRow[] {
		const rows = statementFiles.selectByRunStream.all(filters.runId, filters.stream) as
			| SegmentDataRow[]
			| undefined;
		return (rows ?? []).map(mapSegmentRow);
	}

	function findGcCandidates(runIds: readonly string[]): readonly SegmentRow[] {
		if (runIds.length === 0) return [];
		const placeholders = runIds.map(() => '?').join(',');
		const rows = database.prepare(buildGcSql(placeholders)).all(...runIds) as
			| SegmentDataRow[]
			| undefined;
		return (rows ?? []).map(mapSegmentRow);
	}

	return Object.freeze({ insertSegments, findByRunStream, findGcCandidates });
}

function mapSegmentRow(row: SegmentDataRow): SegmentRow {
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
