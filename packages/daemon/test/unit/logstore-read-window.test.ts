import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { SegmentRowLike } from '../../src/logstore/contract.ts';
import { formatCursor, parseCursor, readSegmentPage } from '../../src/logstore/read-window.ts';

const tmpDirs: string[] = [];
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFs(files: Map<string, Uint8Array>) {
	return {
		fileLenSync: (path: string) => {
			const buf = files.get(path);
			return buf === undefined ? null : buf.byteLength;
		},
		readRange: async (path: string, start: number, end: number) => {
			const buf = files.get(path);
			if (buf === undefined) {
				const err = new Error('ENOENT') as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				err.path = path;
				throw err;
			}
			return buf.subarray(start, Math.min(end + 1, buf.byteLength));
		},
	};
}

function enc(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

describe('readSegmentPage (R3)', () => {
	it('R3: at a segment boundary the cursor advances into the next segment, never 0:3 → 0:3', async () => {
		const seg0Path = '/l/r/events.ndjson';
		const seg1Path = '/l/r/events-1.ndjson';
		const data0 = enc('{"a":1}\n{"b":2}\n');
		const data1 = enc('{"c":3}\n');
		const files = new Map<string, Uint8Array>([
			[seg0Path, data0],
			[seg1Path, data1],
		]);
		const segments: SegmentRowLike[] = [
			{
				id: 's0',
				runId: 'r',
				stream: 'events',
				fileSeq: 0,
				path: seg0Path,
				byteStart: 0,
				byteEnd: data0.length,
				lineCount: 2,
			},
			{
				id: 's1',
				runId: 'r',
				stream: 'events',
				fileSeq: 1,
				path: seg1Path,
				byteStart: 0,
				byteEnd: data1.length,
				lineCount: 1,
			},
		];
		const fs = makeFs(files);

		// Read from the very end of segment 0.
		const atEnd = `0:${data0.length}`;
		const first = await readSegmentPage(segments, atEnd, fs);
		expect(first.ok).toBe(true);
		if (first.ok) {
			// The cursor must jump to segment 1, not stay at 0:{len}.
			expect(first.nextCursor).toBe(formatCursor(1, data1.length));
			expect(first.tailReached).toBe(true);
		}

		// Feeding the returned cursor back terminates cleanly.
		const second = await readSegmentPage(segments, first.ok ? first.nextCursor : '0:0', fs);
		expect(second.ok).toBe(true);
		if (second.ok) {
			expect(second.tailReached).toBe(true);
			expect(second.nextCursor).toBe(first.ok ? first.nextCursor : '');
		}
	});

	it('R3: read the FIRST page, keep feeding nextCursor, reach segment 1 without stalling', async () => {
		const seg0Path = '/l/r/events.ndjson';
		const seg1Path = '/l/r/events-1.ndjson';
		const data0 = enc('AA\n');
		const data1 = enc('B\n');
		const files = new Map<string, Uint8Array>([
			[seg0Path, data0],
			[seg1Path, data1],
		]);
		const segments: SegmentRowLike[] = [
			{
				id: 's0',
				runId: 'r',
				stream: 'events',
				fileSeq: 0,
				path: seg0Path,
				byteStart: 0,
				byteEnd: data0.length,
				lineCount: 1,
			},
			{
				id: 's1',
				runId: 'r',
				stream: 'events',
				fileSeq: 1,
				path: seg1Path,
				byteStart: 0,
				byteEnd: data1.length,
				lineCount: 1,
			},
		];
		const fs = makeFs(files);

		const page0 = await readSegmentPage(segments, '0:0', fs);
		expect(page0.ok).toBe(true);
		if (page0.ok) {
			expect(new TextDecoder().decode(page0.data)).toBe('AA\n');
			expect(page0.nextCursor).toBe(`0:${data0.length}`);
			expect(page0.hasMore).toBe(true);
			expect(page0.tailReached).toBe(false);
		}

		// Feed the cursor back: must move to segment 1 and read its data.
		const page1 = await readSegmentPage(segments, page0.ok ? page0.nextCursor : '0:0', fs);
		expect(page1.ok).toBe(true);
		if (page1.ok) {
			expect(new TextDecoder().decode(page1.data)).toBe('B\n');
			expect(page1.tailReached).toBe(true);
			expect(page1.nextCursor).toBe(`1:${data1.length}`);
		}
	});

	it('R3: in-segment paging splits a larger segment into pages and advances monotonically', async () => {
		const seg0Path = '/l/r/events.ndjson';
		const data0 = enc('1234567890'); // 10 bytes, no newline
		const files = new Map<string, Uint8Array>([[seg0Path, data0]]);
		const segments: SegmentRowLike[] = [
			{
				id: 's0',
				runId: 'r',
				stream: 'events',
				fileSeq: 0,
				path: seg0Path,
				byteStart: 0,
				byteEnd: data0.length,
				lineCount: 0,
			},
		];
		const fs = makeFs(files);
		const CHUNK = 4;

		const p0 = await readSegmentPage(segments, '0:0', fs, CHUNK);
		const p1 = await readSegmentPage(segments, p0.ok ? p0.nextCursor : '0:0', fs, CHUNK);
		const p2 = await readSegmentPage(segments, p1.ok ? p1.nextCursor : '0:0', fs, CHUNK);
		expect(p0.ok && p1.ok && p2.ok).toBe(true);
		if (p0.ok && p1.ok && p2.ok) {
			expect(p0.nextCursor).toBe('0:4');
			expect(p1.nextCursor).toBe('0:8');
			expect(p2.nextCursor).toBe('0:10');
			expect(p2.tailReached).toBe(true);
			const joined = [p0.data, p1.data, p2.data].map((d) => new TextDecoder().decode(d)).join('');
			expect(joined).toBe('1234567890');
		}
	});

	it('R3: UTF-8 multi-byte chars split across the read chunk are re-assembled correctly', async () => {
		const seg0Path = '/l/r/events.ndjson';
		const text = 'ab中文cd'; // 中文 is 3 bytes each in UTF-8
		const data0 = enc(text);
		const files = new Map<string, Uint8Array>([[seg0Path, data0]]);
		const segments: SegmentRowLike[] = [
			{
				id: 's0',
				runId: 'r',
				stream: 'events',
				fileSeq: 0,
				path: seg0Path,
				byteStart: 0,
				byteEnd: data0.length,
				lineCount: 1,
			},
		];
		const fs = makeFs(files);
		// chunk limit 4 forces a split inside a 3-byte UTF-8 char.
		const p0 = await readSegmentPage(segments, '0:0', fs, 4);
		const p1 = await readSegmentPage(segments, p0.ok ? p0.nextCursor : '0:0', fs, 4);
		const p2 = await readSegmentPage(segments, p1.ok ? p1.nextCursor : '0:0', fs, 4);
		const joined = [p0, p1, p2]
			.filter((p): p is Extract<typeof p, { ok: true }> => p.ok)
			.map((p) => p.data)
			.reduce((a, b) => {
				const out = new Uint8Array(a.length + b.length);
				out.set(a, 0);
				out.set(b, a.length);
				return out;
			});
		expect(new TextDecoder('utf-8').decode(joined)).toBe(text);
	});

	it('R3: cursor beyond the last segment reports tailReached without reading', async () => {
		const seg0Path = '/l/r/events.ndjson';
		const data0 = enc('x\n');
		const files = new Map<string, Uint8Array>([[seg0Path, data0]]);
		const segments: SegmentRowLike[] = [
			{
				id: 's0',
				runId: 'r',
				stream: 'events',
				fileSeq: 0,
				path: seg0Path,
				byteStart: 0,
				byteEnd: data0.length,
				lineCount: 1,
			},
		];
		const fs = makeFs(files);
		const result = await readSegmentPage(segments, '0:2', fs);
		// 0:2 == byteEnd of seg0 with no next segment → tail reached, empty data.
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.tailReached).toBe(true);
	});
});

describe('cursor helpers', () => {
	it('parseCursor / formatCursor round-trip', () => {
		expect(formatCursor(2, 5)).toBe('2:5');
		expect(parseCursor('1:100')).toEqual({ fileSeq: 1, byteOffset: 100 });
		expect(parseCursor('bad')).toBeNull();
		expect(parseCursor('1:-2')).toBeNull();
	});
});
