import { describe, expect, it } from 'vitest';
import { createLogIndexRepairJob } from '../../src/jobs/log-index-repair.ts';
import type { SegmentRow } from '../../src/logstore/contract.ts';

const segments: SegmentRow[] = [
	{
		id: 'seg-1',
		runId: 'run-1',
		stream: 'events',
		fileSeq: 0,
		path: '/logs/run-1/events.ndjson',
		byteStart: 0,
		byteEnd: 0,
		lineCount: 0,
	},
];

describe('log-index-repair', () => {
	it('acceptance 3: indexes rows found between last indexed offset and EOF', async () => {
		const line1 = JSON.stringify({
			ts: '2026-01-01T00:00:00.000Z',
			scope: 'run',
			kind: 'run.started',
			taskId: null,
			actorDeviceId: null,
		});
		const line2 = JSON.stringify({
			ts: '2026-01-01T00:00:01.000Z',
			scope: 'run',
			kind: 'run.exited',
			taskId: null,
			actorDeviceId: null,
		});
		const line1Bytes = Buffer.byteLength(line1, 'utf8') + 1;
		const line2Bytes = Buffer.byteLength(line2, 'utf8') + 1;
		const totalBytes = line1Bytes + line2Bytes;

		const inserted: unknown[] = [];
		const job = createLogIndexRepairJob({
			listRunIds: () => ['run-1'],
			listSegments: () => segments,
			lastIndexedEnd: () => line1Bytes,
			lastIndexedFileSeq: () => 0,
			insertIndex: (record) => inserted.push(record),
			fileLen: () => totalBytes,
			readRange: async (_path, start, end) => {
				const all = `${line1}\n${line2}\n`;
				return all.slice(start, end + 1);
			},
		});

		const reports = await job.runOnce();
		expect(reports[0]?.indexedLines).toBe(1);
		expect(reports[0]?.errors).toEqual([]);
		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toMatchObject({
			runId: 'run-1',
			kind: 'run.exited',
			byteOffset: line1Bytes,
			byteLen: line2Bytes,
		});
	});

	it('acceptance 3 partial: index ahead of file is corruption, not silently repaired', async () => {
		const job = createLogIndexRepairJob({
			listRunIds: () => ['run-1'],
			listSegments: () => segments,
			lastIndexedEnd: () => 100,
			lastIndexedFileSeq: () => 0,
			insertIndex: () => {},
			fileLen: () => 50,
			readRange: async () => '',
		});
		const reports = await job.runOnce();
		expect(reports[0]?.errors.some((e) => e.includes('corrupt:'))).toBe(true);
	});

	it('E-151: deleted log file records missing but does not abort the run', async () => {
		const job = createLogIndexRepairJob({
			listRunIds: () => ['run-1'],
			listSegments: () => segments,
			lastIndexedEnd: () => 0,
			lastIndexedFileSeq: () => null,
			insertIndex: () => {},
			fileLen: () => null,
			readRange: async () => '',
		});
		const reports = await job.runOnce();
		expect(reports[0]?.errors).toEqual(['missing:/logs/run-1/events.ndjson']);
	});
});
