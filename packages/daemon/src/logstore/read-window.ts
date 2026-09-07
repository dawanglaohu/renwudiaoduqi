import { AppError } from '../errors/app-error.ts';
import type { ReadSegmentResult, SegmentRow } from './contract.ts';
import { READ_CHUNK_LIMIT_BYTES } from './contract.ts';

export interface ReadSegmentDeps {
	readonly stream: AsyncIterable<Uint8Array>;
	readonly limit?: number;
}

/**
 * Reads bytes from a Node fs.ReadStream, joining chunks into one string.
 * The stream is opened with explicit start/end byte offsets by the caller, so
 * this never loads a whole file: pages are capped at READ_CHUNK_LIMIT_BYTES (E-24).
 */
export async function collectByteRange(
	stream: AsyncIterable<Uint8Array>,
	limit: number = READ_CHUNK_LIMIT_BYTES,
): Promise<string> {
	let collected = '';
	let read = 0;
	for await (const chunk of stream) {
		const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
		read += buf.byteLength;
		if (read > limit) {
			throw new AppError('E_INTERNAL', 'Read stream exceeded the configured byte limit.');
		}
		collected += buf.toString('utf8');
	}
	return collected;
}

/**
 * Cursor format: `<fileSeq>:<byteOffset>`. Invalid input is a typed validation
 * failure, not an exception, because the cursor travels over the API.
 */
export function parseCursor(
	cursor: string | undefined,
): { ok: true; fileSeq: number; byteOffset: number } | { ok: false } {
	if (cursor === undefined) return { ok: true, fileSeq: 0, byteOffset: 0 };
	const match = /^(\d+):(\d+)$/.exec(cursor);
	if (match === null) return { ok: false };
	const fileSeq = Number.parseInt(match[1] ?? '', 10);
	const byteOffset = Number.parseInt(match[2] ?? '', 10);
	if (!Number.isSafeInteger(fileSeq) || !Number.isSafeInteger(byteOffset)) return { ok: false };
	return { ok: true, fileSeq, byteOffset };
}

export function formatCursor(fileSeq: number, byteOffset: number): string {
	return `${fileSeq}:${byteOffset}`;
}

/**
 * Reads one page from a run's segment list (E-149: UI pages through segments,
 * never loads the whole file; E-151: missing file becomes a typed result).
 */
export async function readSegmentPage(
	segments: readonly SegmentRow[],
	cursor: string | undefined,
	createStream: (
		path: string,
		options: { start: number; end: number },
	) => AsyncIterable<Uint8Array>,
	fileLen: (path: string) => number | null,
): Promise<ReadSegmentResult> {
	const parsed = parseCursor(cursor);
	if (!parsed.ok) return { ok: false, code: 'E_VALIDATION' };

	const segment = segments.find((s) => s.fileSeq === parsed.fileSeq);
	if (segment === undefined) {
		if (segments.length === 0) return { ok: false, code: 'E_LOG_FILE_MISSING' };
		// Cursor points at a segment we don't know about: treat as tail.
		const last = segments.at(-1);
		if (last === undefined) return { ok: false, code: 'E_LOG_FILE_MISSING' };
		return {
			ok: true,
			data: '',
			nextCursor: formatCursor(last.fileSeq, last.byteEnd),
			hasMore: false,
			tailReached: true,
		};
	}

	if (fileLen(segment.path) === null) {
		return { ok: false, code: 'E_LOG_FILE_MISSING' };
	}

	const start = parsed.byteOffset;
	if (start > segment.byteEnd) {
		return { ok: false, code: 'E_VALIDATION' };
	}
	if (start === segment.byteEnd) {
		return {
			ok: true,
			data: '',
			nextCursor: cursor ?? formatCursor(0, 0),
			hasMore: false,
			tailReached: true,
		};
	}

	const end = Math.min(segment.byteEnd, start + READ_CHUNK_LIMIT_BYTES) - 1;
	const data = await collectByteRange(createStream(segment.path, { start, end }));
	return {
		ok: true,
		data,
		nextCursor: formatCursor(segment.fileSeq, end + 1),
		hasMore: end + 1 < segment.byteEnd,
		tailReached: end + 1 >= segment.byteEnd,
	};
}
