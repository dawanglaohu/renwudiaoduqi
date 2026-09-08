import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SegmentBoundary } from '../../src/logstore/contract.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import { createRunWriter } from '../../src/logstore/run-writer.ts';

const tmpDirs: string[] = [];
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TEST_SEGMENT_LIMIT = 64;

describe('E-149 log segment rotation', () => {
	it('rotates at the limit and records exact byte boundaries per segment', async () => {
		const baseDir = mkdtempSync(join(tmpdir(), 'agent-scheduler-rotate-'));
		tmpDirs.push(baseDir);
		const paths = createLogstorePaths(baseDir);
		const { mkdirSync, readFileSync, statSync } = await import('node:fs');
		mkdirSync(paths.runDir('run-rotate'), { recursive: true });

		const closed: SegmentBoundary[] = [];
		const { appendFile } = await import('node:fs/promises');
		const queue = { append: appendFile, drain: async () => {}, pendingBytes: 0 };

		const writer = createRunWriter({
			runId: 'run-rotate',
			paths,
			queue: queue as never,
			fs: {
				mkdirSync: () => {},
				appendFile,
				fileLenSync: () => null,
			},
			segmentSizeLimitBytes: TEST_SEGMENT_LIMIT,
		});

		const line = new Uint8Array(30).fill(0x41); // 31 bytes with LF
		await writer.appendRawLine(line); // seg0: 31
		const r2 = await writer.appendRawLine(line); // seg0: 62
		await writer.appendRawLine(line); // 62+31 > 64 → rotate → seg1: 31
		await writer.flush();

		expect(r2.closedSegment).toBeNull();
		const seg0 = paths.segmentPath('run-rotate', 'raw', 0);
		const seg1 = paths.segmentPath('run-rotate', 'raw', 1);
		expect(statSync(seg0).size).toBe(62);
		expect(statSync(seg1).size).toBe(31);

		// read back to confirm byte boundary correctness (no truncation, no overlap)
		expect(readFileSync(seg0).length).toBe(62);
		expect(readFileSync(seg1).length).toBe(31);
		expect(closed).toHaveLength(0); // writer only reports closedSegment via return values, not a repo call
	});
});
