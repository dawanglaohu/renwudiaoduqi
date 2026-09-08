import { AppError } from '../errors/app-error.ts';
import type {
	LogFileSystem,
	ReadSegmentResult,
	ScanWindow,
	ScannedEventLine,
	SegmentRowLike,
} from './contract.ts';
import { isEnoent } from './fs-errors.ts';

export interface ByteCursor {
	readonly fileSeq: number;
	readonly byteOffset: number;
}

export function formatCursor(fileSeq: number, byteOffset: number): string {
	return `${fileSeq}:${byteOffset}`;
}

export function parseCursor(cursor: string): ByteCursor | null {
	const match = /^(\d+):(\d+)$/.exec(cursor);
	if (match === null) return null;
	const fileSeq = Number.parseInt(match[1] ?? '', 10);
	const byteOffset = Number.parseInt(match[2] ?? '', 10);
	if (!Number.isSafeInteger(fileSeq) || !Number.isSafeInteger(byteOffset)) return null;
	return { fileSeq, byteOffset };
}

/**
 * Split raw bytes into lines at LF boundaries (R3). `complete` marks lines
 * terminated by an LF; the final chunk without LF yields an incomplete line.
 */
export interface LineSlice {
	readonly bytes: Uint8Array;
	readonly lenWithLf: number;
	readonly complete: boolean;
}

export function splitLines(buf: Uint8Array): readonly LineSlice[] {
	const lines: LineSlice[] = [];
	let start = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 0x0a) {
			lines.push({ bytes: buf.subarray(start, i), lenWithLf: i + 1 - start, complete: true });
			start = i + 1;
		}
	}
	if (start < buf.length) {
		lines.push({
			bytes: buf.subarray(start, buf.length),
			lenWithLf: buf.length - start,
			complete: false,
		});
	}
	return lines;
}

/** Parse an NDJSON event envelope; returns null for garbage or non-envelope JSON. */
export function parseEnvelopeLine(lineBytes: Uint8Array): {
	id: number | null;
	seq: number | null;
	ts: string | null;
	scope: string | null;
	kind: string | null;
	taskId: string | null;
	actorDeviceId: string | null;
} | null {
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes);
		const value = JSON.parse(text) as Record<string, unknown>;
		if (
			typeof value.ts !== 'string' ||
			typeof value.scope !== 'string' ||
			typeof value.kind !== 'string'
		) {
			return null;
		}
		return {
			id: typeof value.id === 'number' && Number.isSafeInteger(value.id) ? value.id : null,
			seq: typeof value.seq === 'number' && Number.isSafeInteger(value.seq) ? value.seq : null,
			ts: value.ts,
			scope: value.scope,
			kind: value.kind,
			taskId: typeof value.taskId === 'string' ? value.taskId : null,
			actorDeviceId: typeof value.actorDeviceId === 'string' ? value.actorDeviceId : null,
		};
	} catch {
		return null;
	}
}

/**
 * Scan a bounded window of one events segment (R2). Handles LF and CRLF, blank
 * lines, and a truncated tail line without LF. Returns the scan stop so repeated
 * repairs are idempotent and never rescan settled bytes.
 */
export function scanEventLines(window: ScanWindow, buf: Uint8Array): readonly ScannedEventLine[] {
	const lines: ScannedEventLine[] = [];
	let offset = window.start;
	for (const slice of splitLines(buf)) {
		const lineBytes = slice.bytes;
		const envelope = parseEnvelopeLine(lineBytes);
		lines.push({
			line: lineBytes,
			lineLen: slice.lenWithLf,
			envelope: envelope ?? {
				id: null,
				seq: null,
				ts: null,
				scope: null,
				kind: null,
				taskId: null,
				actorDeviceId: null,
			},
			complete: slice.complete,
		});
		offset += slice.lenWithLf;
	}
	return lines;
}

const READ_CHUNK_LIMIT_BYTES = 1024 * 1024;

/**
 * Paged read across consecutive segments (R3): when the requested cursor reaches
 * a segment end the cursor advances into the next segment, so feeding the returned
 * cursor back drains the whole stream — never a 0:3 → 0:3 stall.
 */
export async function readSegmentPage(
	segments: readonly SegmentRowLike[],
	cursor: string,
	fs: Pick<LogFileSystem, 'readRange' | 'fileLenSync'>,
	chunkLimit = READ_CHUNK_LIMIT_BYTES,
): Promise<ReadSegmentResult> {
	const parsed = parseCursor(cursor);
	if (parsed === null) {
		return { ok: false, code: 'E_VALIDATION' };
	}
	const { fileSeq, byteOffset } = parsed;

	// Find the segment containing the cursor; segments with empty span are skipped.
	let segment: SegmentRowLike | undefined;
	for (const candidate of segments) {
		if (candidate.fileSeq < fileSeq) continue;
		if (candidate.fileSeq === fileSeq && byteOffset <= candidate.byteEnd) {
			segment = candidate;
			break;
		}
		// cursor beyond this segment's end: it can still hold data if byteOffset < byteEnd
		if (candidate.fileSeq === fileSeq && byteOffset < candidate.byteEnd) {
			segment = candidate;
			break;
		}
		if (candidate.fileSeq > fileSeq) {
			segment = candidate;
			break;
		}
	}

	if (segment === undefined) {
		return { ok: false, code: 'E_LOG_FILE_MISSING' };
	}

	const start = segment.fileSeq === fileSeq ? byteOffset : segment.byteStart;
	const end = Math.min(segment.byteEnd, start + chunkLimit);
	if (start > segment.byteEnd) {
		return { ok: false, code: 'E_VALIDATION' };
	}
	if (start === segment.byteEnd) {
		// Cursor at the end of this segment: jump to the next one (R3).
		const nextSegment = segments.find((s) => s.fileSeq === segment.fileSeq + 1);
		if (nextSegment === undefined) {
			return {
				ok: true,
				data: new Uint8Array(0),
				nextCursor: formatCursor(segment.fileSeq, segment.byteEnd),
				hasMore: false,
				tailReached: true,
			};
		}
		return readSegmentPage(
			segments,
			formatCursor(nextSegment.fileSeq, nextSegment.byteStart),
			fs,
			chunkLimit,
		);
	}

	const fileLen = fs.fileLenSync(segment.path);
	if (fileLen === null) {
		return { ok: false, code: 'E_LOG_FILE_MISSING' };
	}

	const readEnd = Math.min(end, fileLen) - 1;
	if (readEnd < start) {
		return {
			ok: true,
			data: new Uint8Array(0),
			nextCursor: formatCursor(segment.fileSeq, start),
			hasMore: true,
			tailReached: false,
		};
	}

	let data: Uint8Array;
	try {
		data = await fs.readRange(segment.path, start, readEnd);
	} catch (cause) {
		if (isEnoent(cause) || (cause instanceof AppError && cause.code === 'E_LOG_FILE_MISSING')) {
			return { ok: false, code: 'E_LOG_FILE_MISSING' };
		}
		throw cause;
	}
	const nextCursor = formatCursor(segment.fileSeq, readEnd + 1);
	const nextSegment = segments.find((s) => s.fileSeq === segment.fileSeq + 1);
	const atSegmentEnd = readEnd + 1 >= segment.byteEnd;
	const hasMore = !atSegmentEnd || nextSegment !== undefined;
	const tailReached = atSegmentEnd && nextSegment === undefined;
	return { ok: true, data, nextCursor, hasMore, tailReached };
}
