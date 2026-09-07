import { AppError } from '../errors/app-error.ts';
import type { ReadSegmentResult, SegmentRow } from './contract.ts';
import { READ_CHUNK_LIMIT_BYTES } from './contract.ts';

export async function readRange(
	stream: AsyncIterable<Uint8Array>,
	limit: number = READ_CHUNK_LIMIT_BYTES,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of stream) {
		const buf = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
		total += buf.byteLength;
		if (total > limit) {
			throw new AppError('E_INTERNAL', 'Read stream exceeded the configured byte limit.');
		}
		chunks.push(buf);
	}
	return Buffer.concat(chunks, total);
}

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
		const last = segments.at(-1);
		if (last === undefined) return { ok: false, code: 'E_LOG_FILE_MISSING' };
		return {
			ok: true,
			data: new Uint8Array(0),
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
			data: new Uint8Array(0),
			nextCursor: cursor ?? '0:0',
			hasMore: false,
			tailReached: true,
		};
	}

	const end = Math.min(segment.byteEnd, start + READ_CHUNK_LIMIT_BYTES) - 1;
	const stream = createStream(segment.path, { start, end });
	const data = await readRange(stream, READ_CHUNK_LIMIT_BYTES);
	const nextCursor = formatCursor(segment.fileSeq, end + 1);
	const nextSegment = segments.find((s) => s.fileSeq === segment.fileSeq + 1);
	return {
		ok: true,
		data,
		nextCursor,
		hasMore: nextSegment !== undefined,
		tailReached: end + 1 >= segment.byteEnd && nextSegment === undefined,
	};
}
