import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import { createRunLogWriter } from '../../src/logstore/run-writer.ts';

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('RunLogWriter ordering', () => {
	it('acceptance 1: file append resolves before the index insert is invoked', async () => {
		const baseDir = mkdtempSync(join(tmpdir(), 'agent-scheduler-logwriter-'));
		tmpDirs.push(baseDir);
		const paths = createLogstorePaths(baseDir);

		// Capture the exact order of side-effect calls.
		const calls: string[] = [];
		const fakeQueue = {
			append: async () => {
				calls.push('append');
			},
			pendingBytes: 0,
			drain: async () => {},
		};
		const inserted: unknown[] = [];
		const fakeIndexRepo = {
			insertIndex: (record: unknown) => inserted.push(record),
			lastIndexedEnd: () => 0,
			lastIndexedFileSeq: () => null,
		};
		const fakeSegmentsRepo = {
			insertSegments: () => {},
			findByRunStream: () => [],
			findGcCandidates: () => [],
		};

		const writer = createRunLogWriter({
			runId: 'run-1',
			paths,
			queue: fakeQueue,
			ids: { newId: () => 'id-1' },
			segmentsRepo: fakeSegmentsRepo as never,
			eventsIndexRepo: fakeIndexRepo as never,
		});

		await writer.appendEventLine({
			bytes: new Uint8Array([65]),
			taskId: null,
			seq: 0,
			ts: '2026-01-01T00:00:00.000Z',
			scope: 'run',
			kind: 'run.started',
			actorDeviceId: null,
		});

		expect(calls).toEqual(['append', 'append']);
		expect(inserted.length).toBe(1);
	});
});
