import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SegmentInsert } from '../../src/logstore/contract.ts';
import { createRunWriter } from '../../src/logstore/run-writer.ts';

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDeps(runId: string, segmentLimit: number) {
	const baseDir = mkdtempSync(join(tmpdir(), 'ags-logstore-'));
	tmpDirs.push(baseDir);
	const runDir = join(baseDir, runId);
	const paths = {
		runDir: () => runDir,
		segmentPath: (_runId: string, stream: 'raw' | 'events', fileSeq: number) =>
			join(runDir, `${stream}-${fileSeq}.log`),
	};
	const segments: SegmentInsert[] = [];
	const segmentsRepo = {
		insertSegments: (rows: readonly SegmentInsert[]) => segments.push(...rows),
		findByRunStream: () => [],
		listAll: () => [],
	};
	const eventsIndexRepo = {
		lastIndexedEnd: () => 0,
		lastIndexedFileSeq: () => null,
		insertIndex: () => {},
	};
	const deps = {
		runId,
		paths,
		queue: { append: async () => {}, drain: async () => {}, pendingBytes: 0 },
		ids: { newId: () => 'seg-1' },
		segmentsRepo,
		eventsIndexRepo,
		fs: {
			mkdirSync: () => {},
			listDirectory: () => [],
			appendFile: async () => {},
			createReadStream: () => (async function* () {})(),
			fileLenSync: () => null,
		},
		segmentSizeLimitBytes: segmentLimit,
	};
	return { segments, deps };
}

const TEST_SEGMENT_LIMIT = 1024;

describe('log-writer (E-149)', () => {
	it('rotates to the next segment file when the limit is hit and records segment boundaries', async () => {
		const { deps, segments } = makeDeps('run-1', TEST_SEGMENT_LIMIT);
		const writer = createRunWriter(deps);

		const line = new Uint8Array(400).fill(65);
		await writer.appendRawLine(line);
		await writer.appendRawLine(line);
		await writer.appendRawLine(line);
		await writer.flush();

		expect(segments).toHaveLength(2);
		expect(segments[0]).toMatchObject({
			runId: 'run-1',
			stream: 'raw',
			fileSeq: 0,
			byteStart: 0,
			byteEnd: 802,
			lineCount: 2,
		});
		expect(segments[1]).toMatchObject({
			runId: 'run-1',
			stream: 'raw',
			fileSeq: 1,
			byteStart: 0,
			byteEnd: 401,
			lineCount: 1,
		});
	});
});
