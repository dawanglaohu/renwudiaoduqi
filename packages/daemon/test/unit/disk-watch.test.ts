import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import { createDiskWatchJob } from '../../src/jobs/disk-watch.ts';
import type { LogFileSystem, VolumeStats } from '../../src/logstore/contract.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import { createSystemService } from '../../src/service/system.ts';

const PLENTY_OF_SPACE: VolumeStats = { bavail: 1_000_000, bsize: 4096, blocks: 2_000_000 };
const NO_SPACE: VolumeStats = { bavail: 0, bsize: 4096, blocks: 2_000_000 };

type ServiceDouble = Parameters<typeof createDiskWatchJob>[0]['service'];

describe('disk-watch job & SystemService (M1-T5)', () => {
	let testDir: string;
	let logRoot: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), 'sched-disk-watch-'));
		logRoot = join(testDir, 'runs');
		createNodeLogFileSystem().mkdirSync(logRoot);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	/** Free space is stubbed so the thresholds under test never depend on the CI volume. */
	function setupSystem(warnThresholdBytes = 1000, volume: VolumeStats = PLENTY_OF_SPACE) {
		const fs: LogFileSystem = { ...createNodeLogFileSystem(), statfs: async () => volume };
		const ringBuffer = createRingBuffer();
		const bus = createEventBus({ ringBuffer });
		let eventSeq = 1;
		const envelopeFactory = createEnvelopeFactory({
			clock: { now: () => new Date().toISOString() },
			idAllocator: { allocate: () => eventSeq++ },
		});
		const service = createSystemService({
			paths: createLogstorePaths(logRoot),
			fs,
			bus,
			envelopeFactory,
			warnThresholdBytes,
		});
		const publishedEvents: EventEnvelope[] = [];
		bus.subscribe((event) => {
			publishedEvents.push(event);
		});
		return { fs, service, publishedEvents };
	}

	describe('E-103: usage exceeds the warning threshold', () => {
		it('publishes system.disk_warning and halts new dispatches', async () => {
			const { fs, service, publishedEvents } = setupSystem(100);
			fs.mkdirSync(join(logRoot, 'run-1'));
			writeFileSync(join(logRoot, 'run-1', 'events.ndjson'), 'z'.repeat(150));
			expect(service.isDispatchHalted()).toBe(false);

			const res = await createDiskWatchJob({ service, intervalMs: 1000 }).runOnce();

			expect(res?.warningIssued).toBe(true);
			expect(res?.dispatchHalted).toBe(true);
			expect(service.getDispatchHalt()?.cause).toBe('disk_threshold');
			expect(publishedEvents).toHaveLength(1);
			const warning = publishedEvents[0];
			expect(warning?.kind).toBe('system.disk_warning');
			expect(warning?.scope).toBe('system');
			expect(warning?.payload).toMatchObject({
				path: logRoot,
				message: expect.stringContaining('exceeded warning threshold'),
			});
		});

		it('stays quiet while usage is below the threshold', async () => {
			const { fs, service, publishedEvents } = setupSystem(10_000);
			fs.mkdirSync(join(logRoot, 'run-small'));
			writeFileSync(join(logRoot, 'run-small', 'raw.log'), 'hello');

			const res = await createDiskWatchJob({ service }).runOnce();

			expect(res?.warningIssued).toBe(false);
			expect(res?.dispatchHalted).toBe(false);
			expect(service.isDispatchHalted()).toBe(false);
			expect(publishedEvents).toHaveLength(0);
		});

		it('treats a volume with zero available blocks as full (E-104 seen by the watcher)', async () => {
			const { service, publishedEvents } = setupSystem(10_000, NO_SPACE);

			const res = await createDiskWatchJob({ service }).runOnce();

			expect(res?.usage.isDiskFull).toBe(true);
			expect(service.getDispatchHalt()?.cause).toBe('disk_full');
			expect(publishedEvents[0]?.payload).toMatchObject({
				message: expect.stringContaining('full'),
			});
		});
	});

	describe('E-205: M1 never deletes any log file on warning or full', () => {
		it('preserves every log file even when the threshold is severely exceeded', async () => {
			const { fs, service } = setupSystem(50);
			fs.mkdirSync(join(logRoot, 'run-precious'));
			const logFile = join(logRoot, 'run-precious', 'events.ndjson');
			const content = 'vital historical agent logs that must never be deleted by M1';
			writeFileSync(logFile, content);

			await createDiskWatchJob({ service }).runOnce();

			expect(service.isDispatchHalted()).toBe(true);
			expect(fs.fileLenSync(logFile)).toBe(Buffer.byteLength(content));
		});

		it('preserves every log file when notifyDiskFull fires', () => {
			const { fs, service, publishedEvents } = setupSystem(10_000);
			fs.mkdirSync(join(logRoot, 'run-full'));
			const logFile = join(logRoot, 'run-full', 'raw.log');
			writeFileSync(logFile, 'data before disk full');

			service.notifyDiskFull(join(logRoot, 'run-full'));

			expect(service.isDispatchHalted()).toBe(true);
			expect(publishedEvents).toHaveLength(1);
			expect(publishedEvents[0]?.kind).toBe('system.disk_warning');
			expect(fs.fileLenSync(logFile)).toBeGreaterThan(0);
		});
	});

	describe('E-104: halt lifts once a later check finds the volume healthy again', () => {
		it('notifyDiskFull publishes once per outage and the next check resumes dispatch', async () => {
			const { service, publishedEvents } = setupSystem(10_000);
			const runDir = join(logRoot, 'run-1');

			service.notifyDiskFull(runDir);
			service.notifyDiskFull(runDir);
			expect(service.getDispatchHalt()).toEqual({
				cause: 'disk_full',
				message: expect.any(String),
			});
			expect(publishedEvents).toHaveLength(1);

			const res = await createDiskWatchJob({ service }).runOnce();

			expect(res?.dispatchHalted).toBe(false);
			expect(service.getDispatchHalt()).toBeNull();
			expect(publishedEvents).toHaveLength(1);
		});

		it('resumeDispatch clears the flag by hand', () => {
			const { service } = setupSystem(10_000);
			service.notifyDiskFull(join(logRoot, 'run-1'));
			service.resumeDispatch();
			expect(service.isDispatchHalted()).toBe(false);
		});
	});

	describe('disk-watch job lifecycle & error handling', () => {
		it('starts, can be stopped cleanly, and stops the periodic timer', async () => {
			const { service } = setupSystem(10_000);
			const job = createDiskWatchJob({ service, intervalMs: 50 });

			job.start();
			job.start();
			await new Promise((resolve) => setTimeout(resolve, 80));
			await job.stop();
			await job.stop();
		});

		it('hands a failing pass to logFailure instead of rejecting', async () => {
			const errors: unknown[] = [];
			const brokenService = {
				checkDiskWatch: async () => {
					throw new Error('Simulated filesystem I/O error during disk watch');
				},
			} as unknown as ServiceDouble;

			const res = await createDiskWatchJob({
				service: brokenService,
				logFailure: (err) => errors.push(err),
			}).runOnce();

			expect(res).toBeNull();
			expect(errors).toHaveLength(1);
			expect((errors[0] as Error).message).toContain('Simulated filesystem I/O error');
		});

		it('is non-reentrant: a concurrent runOnce joins the in-flight pass', async () => {
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
			} as unknown as ServiceDouble;

			const job = createDiskWatchJob({ service: delayedService });
			const [res1, res2] = await Promise.all([job.runOnce(), job.runOnce()]);

			expect(checkCount).toBe(1);
			expect(res1).toEqual(res2);
		});
	});
});
