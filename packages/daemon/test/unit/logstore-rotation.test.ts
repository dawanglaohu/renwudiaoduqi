import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import { createRunWriter } from '../../src/logstore/run-writer.ts';

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Small limit so the same code path runs without allocating hundreds of MB.
const TEST_SEGMENT_LIMIT = 64;

describe('E-149 log segment rotation', () => {
	it('rotates when the segment limit is hit and records byte boundaries per segment', async () => {
		const baseDir = mkdtempSync(join(tmpdir(), 'agent-scheduler-rotate-'));
		tmpDirs.push(baseDir);
		const paths = createLogstorePaths(baseDir);
		const { mkdirSync } = await import('node:fs');
		mkdirSync(paths.runDir('run-rotate'), { recursive: true });

		const rotatedSegments: Array<{
			fileSeq: number;
			path: string;
			byteStart: number;
			byteEnd: number;
		}> = [];
		const fakeSegmentsRepo = {
			insertSegments: (
				s: readonly { fileSeq: number; path: string; byteStart: number; byteEnd: number }[],
			) => rotatedSegments.push(...s),
			findByRunStream: () => [],
		};
		const fakeFs = {
			mkdirSync: () => {},
			listDirectory: () => [],
			appendFile: async () => {},
			createReadStream: () => (async function* () {})(),
			fileLenSync: () => null,
		};
		const fakeIndexRepo = {
			insertIndex: () => {},
			lastIndexedEnd: () => 0,
			lastIndexedFileSeq: () => null,
		};

		const { appendFile } = await import('node:fs/promises');
		const realQueue = { append: appendFile, pendingBytes: 0, drain: async () => {} };

		const writer = createRunWriter({
			runId: 'run-rotate',
			paths,
			queue: realQueue as never,
			ids: { newId: () => 'id-rotate' },
			fs: fakeFs,
			segmentsRepo: fakeSegmentsRepo,
			segmentSizeLimitBytes: TEST_SEGMENT_LIMIT,
		});

		const line = new Uint8Array(30).fill(0x41);
		await writer.appendRawLine(line); // 31 bytes in segment 0
		await writer.appendRawLine(line); // 62 bytes in segment 0
		await writer.appendRawLine(line); // crosses 64 → rotates to segment 1
		await writer.flush();

		const seg0 = paths.segmentPath('run-rotate', 'raw', 0);
		const seg1 = paths.segmentPath('run-rotate', 'raw', 1);
		const size0 = readFileSync(seg0).byteLength;
		const size1 = readFileSync(seg1).byteLength;
		expect(size0).toBe(62);
		expect(size1).toBe(31);
		expect(rotatedSegments).toHaveLength(1);
		expect(rotatedSegments[0]).toMatchObject({ fileSeq: 0, byteEnd: 62 });
	});
});
