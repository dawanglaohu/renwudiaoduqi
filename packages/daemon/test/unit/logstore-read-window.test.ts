import { describe, expect, it } from 'vitest';
import type { SegmentRow } from '../../src/logstore/contract.ts';
import { formatCursor, parseCursor, readSegmentPage } from '../../src/logstore/read-window.ts';

const segments: SegmentRow[] = [
	{
		id: '1',
		runId: 'r1',
		stream: 'raw',
		fileSeq: 0,
		path: '/log/r1/raw.log',
		byteStart: 0,
		byteEnd: 10,
		lineCount: 1,
	},
	{
		id: '2',
		runId: 'r1',
		stream: 'raw',
		fileSeq: 1,
		path: '/log/r1/raw-1.log',
		byteStart: 0,
		byteEnd: 5,
		lineCount: 1,
	},
];

describe('readSegmentPage', () => {
	it('E-151: missing segment file returns typed E_LOG_FILE_MISSING instead of throwing', async () => {
		const result = await readSegmentPage(
			segments,
			'0:0',
			() =>
				(async function* () {
					yield new Uint8Array([65]);
				})(),
			() => null, // file gone
		);
		expect(result.ok).toBe(false);
		expect((result as { ok: false; code: string }).code).toBe('E_LOG_FILE_MISSING');
	});

	it('returns E_LOG_FILE_MISSING when no segments exist at all', async () => {
		const result = await readSegmentPage(
			[],
			undefined,
			() => {
				throw new Error('unused');
			},
			() => 0,
		);
		expect(result.ok).toBe(false);
		expect((result as { ok: false; code: string }).code).toBe('E_LOG_FILE_MISSING');
	});

	it('parses cursor format fileSeq:byteOffset', () => {
		expect(parseCursor('1:100')).toEqual({ ok: true, fileSeq: 1, byteOffset: 100 });
		expect(parseCursor('bad')).toEqual({ ok: false });
		expect(formatCursor(2, 5)).toBe('2:5');
	});

	it('cursor past known segments yields tailReached with empty data', async () => {
		const result = await readSegmentPage(
			segments,
			'99:0',
			() => {
				throw new Error('unused');
			},
			() => 10,
		);
		expect(result.ok).toBe(true);
		expect((result as { ok: true; tailReached: boolean }).tailReached).toBe(true);
	});
});
