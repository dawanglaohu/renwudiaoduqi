import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import { createDiskWatchJob } from '../../src/jobs/disk-watch.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import { createSystemService } from '../../src/service/system.ts';

describe('disk-watch job & SystemService (M1-T5)', () => {
	let testDir: string;
	let logRoot: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), 'sched-disk-watch-'));
		logRoot = join(testDir, 'runs');
		const fs = createNodeLogFileSystem();
		fs.mkdirSync(logRoot);
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup
		}
	});

	function setupSystem(warnThresholdBytes = 1000) {
		const fs = createNodeLogFileSystem();
		const paths = createLogstorePaths(logRoot);
		const ringBuffer = createRingBuffer();
		const bus = createEventBus({ ringBuffer });
		let eventSeq = 1;
		const envelopeFactory = createEnvelopeFactory({
			clock: { now: () => new Date().toISOString() },
			idAllocator: { allocate: () => eventSeq++ },
		});

		const service = createSystemService({
			paths,
			fs,
			bus,
			envelopeFactory,
			warnThresholdBytes,
		});

		const publishedEvents: EventEnvelope[] = [];
		bus.subscribe((event) => {
			publishedEvents.push(event);
		});

		return { fs, paths, bus, envelopeFactory, service, publishedEvents };
	}

	describe('E-103: usage exceeds warning threshold', () => {
		it('issues system.disk_warning event and sets dispatch halted flag', async () => {
			const { fs, service, publishedEvents } = setupSystem(100);

			// Populate files exceeding 100 bytes
			const runDir = join(logRoot, 'run-1');
			fs.mkdirSync(runDir);
			writeFileSync(join(runDir, 'events.ndjson'), 'z'.repeat(150));

			expect(service.isDispatchHalted()).toBe(false);

			const job = createDiskWatchJob({
				service,
				intervalMs: 1000,
			});

			const res = await job.runOnce();

			expect(res?.warningIssued).toBe(true);
			expect(res?.dispatchHalted).toBe(true);
			expect(service.isDispatchHalted()).toBe(true);

			// E-103: system.disk_warning event was published
			expect(publishedEvents).toHaveLength(1);
			const warningEvent = publishedEvents[0];
			expect(warningEvent?.kind).toBe('system.disk_warning');
			expect(warningEvent?.scope).toBe('system');
			expect(warningEvent?.payload).toMatchObject({
				path: logRoot,
			});
			if (warningEvent && 'message' in warningEvent.payload) {
				expect(String(warningEvent.payload.message)).toContain('exceeded warning threshold');
			}
		});

		it('does NOT issue warning when usage is below threshold', async () => {
			const { fs, service, publishedEvents } = setupSystem(10000);

			const runDir = join(logRoot, 'run-small');
			fs.mkdirSync(runDir);
			writeFileSync(join(runDir, 'raw.log'), 'hello');

			const job = createDiskWatchJob({ service });
			const res = await job.runOnce();

			expect(res?.warningIssued).toBe(false);
			expect(res?.dispatchHalted).toBe(false);
			expect(service.isDispatchHalted()).toBe(false);
			expect(publishedEvents).toHaveLength(0);
		});
	});

	describe('E-205: M1 NEVER deletes any text files automatically on disk warning or full', () => {
		it('preserves all log files on disk even when threshold is severely exceeded', async () => {
			const { fs, service } = setupSystem(50);

			const runDir = join(logRoot, 'run-precious');
			fs.mkdirSync(runDir);
			const logFile = join(runDir, 'events.ndjson');
			const content = 'vital historical agent logs that must never be deleted by M1';
			writeFileSync(logFile, content);

			const job = createDiskWatchJob({ service });
			await job.runOnce();

			// M1 halted dispatches
			expect(service.isDispatchHalted()).toBe(true);

			// But the file MUST still be intact and undamaged!
			expect(fs.fileLenSync(logFile)).toBe(Buffer.byteLength(content));
		});

		it('preserves all log files when notifyDiskFull is triggered', () => {
			const { fs, service, publishedEvents } = setupSystem(10000);

			const runDir = join(logRoot, 'run-full');
			fs.mkdirSync(runDir);
			const logFile = join(runDir, 'raw.log');
			writeFileSync(logFile, 'data before disk full');

			service.notifyDiskFull(logFile);

			expect(service.isDispatchHalted()).toBe(true);
			expect(publishedEvents).toHaveLength(1);
			expect(publishedEvents[0]?.kind).toBe('system.disk_warning');

			// File on disk was NOT deleted
			expect(fs.fileLenSync(logFile)).toBeGreaterThan(0);
		});
	});

	describe('disk-watch job lifecycle & error handling', () => {
		it('starts, can be stopped cleanly, and stops the periodic timer', async () => {
			const { service } = setupSystem(10000);
			const job = createDiskWatchJob({
				service,
				intervalMs: 50,
			});

			job.start();
			// Starting twice is a no-op
			job.start();

			await new Promise((resolve) => setTimeout(resolve, 80));

			await job.stop();
			// Stopping twice is safe
			await job.stop();
		});

		it('catches and isolates errors during runOnce without bubbling to unhandledRejection', async () => {
			const errors: unknown[] = [];
			const brokenService = {
				checkDiskWatch: async () => {
					throw new Error('Simulated filesystem I/O error during disk watch');
				},
			} as unknown as Parameters<typeof createDiskWatchJob>[0]['service'];

			const job = createDiskWatchJob({
				service: brokenService,
				logFailure: (err) => errors.push(err),
			});

			const res = await job.runOnce();
			expect(res).toBeNull();
			expect(errors).toHaveLength(1);
			expect((errors[0] as Error).message).toContain('Simulated filesystem I/O error');
		});

		it('is non-reentrant: subsequent concurrent runOnce calls await in-flight task', async () => {
			let checkCount = 0;
			const delayedService = {
				checkDiskWatch: async () => {
					checkCount++;
					await new Promise((resolve) => setTimeout(resolve, 50));
					return {
						warningIssued: false,
						dispatchHalted: false,
						usage: {
							dataDirBytes: 0,
							byRun: [],
							warnThreshold: 1000,
							isWarnThresholdExceeded: false,
							isDiskFull: false,
						},
					};
				},
			} as unknown as Parameters<typeof createDiskWatchJob>[0]['service'];

			const job = createDiskWatchJob({ service: delayedService });

			const [res1, res2] = await Promise.all([job.runOnce(), job.runOnce()]);

			expect(checkCount).toBe(1);
			expect(res1).toEqual(res2);
		});
	});
});
