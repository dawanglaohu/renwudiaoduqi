import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import { createHttpServer } from '../../src/http/server.ts';
import { createAppendQueue } from '../../src/logstore/append-queue.ts';
import type { LogFileSystem } from '../../src/logstore/contract.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import type { EventsIndexRepo } from '../../src/repo/events-index-repo.ts';
import type { LogSegmentsRepo } from '../../src/repo/log-segments-repo.ts';
import { createLogstoreService } from '../../src/service/logstore.ts';
import { createSystemService } from '../../src/service/system.ts';

const dummyLockHandle: LockFileHandle = {
	path: '/dummy.lock',
	metadata: {
		pid: process.pid,
		uid: '1000',
		startedAt: new Date().toISOString(),
		port: 7817,
		bind: '127.0.0.1',
	},
	serializedMetadata: '{}',
	released: false,
	release: () => {},
};

const dummyLockAdapter: NativeLockAdapter = {
	platform: 'linux',
	filePath: '/dummy.lock',
	dirPath: '/dummy',
	reclaimPath: '/dummy.reclaim',
	permissionLines: [],
	createExclusive: () => ({ ok: true }),
	read: () => ({ ok: true, contents: '{}' }),
	remove: () => ({ ok: true }),
	verifyPermissions: () => ({ ok: true }),
	createReclaimGuard: () => ({ ok: true }),
	readReclaimGuard: () => ({ ok: true, contents: '{}' }),
	removeReclaimGuard: () => ({ ok: true }),
	inspectPermissions: () => ({ ok: true, contents: '{}' }),
};
describe('disk-full & system HTTP routes integration (M1-T5, E-104)', () => {
	let testDir: string;
	let logRoot: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), 'sched-disk-full-integ-'));
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

	describe('E-104: storage disk write full handling', () => {
		it('immediately halts new dispatches, emits system.disk_warning, and throws typed E_DISK_FULL error', async () => {
			let simulatedDiskFull = false;
			const realFs = createNodeLogFileSystem();

			const controlledFs: LogFileSystem = {
				mkdirSync: (p) => realFs.mkdirSync(p),
				listDirectory: (p) => realFs.listDirectory(p),
				fileLenSync: (p) => realFs.fileLenSync(p),
				readFile: (p) => realFs.readFile(p),
				readRange: (p, s, e) => realFs.readRange(p, s, e),
				appendFile: async (path, data) => {
					if (simulatedDiskFull) {
						const err = new Error('ENOSPC: no space left on device, write');
						Object.assign(err, { code: 'ENOSPC' });
						throw err;
					}
					return realFs.appendFile(path, data);
				},
				deleteFile: (p) => (realFs.deleteFile ? realFs.deleteFile(p) : Promise.resolve()),
				truncateFile: (p, len) =>
					realFs.truncateFile ? realFs.truncateFile(p, len) : Promise.resolve(),
				statfs: (p) =>
					realFs.statfs
						? realFs.statfs(p)
						: Promise.resolve({ bavail: 1000, bsize: 4096, blocks: 2000 }),
			};

			const paths = createLogstorePaths(logRoot);
			const queue = createAppendQueue({
				appendFile: (path, data) => controlledFs.appendFile(path, data),
			});
			const ringBuffer = createRingBuffer();
			const bus = createEventBus({ ringBuffer });
			let eventSeq = 1;
			const envelopeFactory = createEnvelopeFactory({
				clock: { now: () => new Date().toISOString() },
				idAllocator: { allocate: () => eventSeq++ },
			});

			const systemService = createSystemService({
				paths,
				fs: controlledFs,
				bus,
				envelopeFactory,
			});

			const publishedEvents: EventEnvelope[] = [];
			bus.subscribe((event) => {
				publishedEvents.push(event);
			});

			// Dummy unit of work and repos for logstore service
			const dummyDb = {
				transaction: (fn: () => unknown) => ({
					immediate: () => fn(),
					deferred: () => fn(),
					exclusive: () => fn(),
				}),
			};
			const dummyUow = createUnitOfWork(dummyDb as unknown as DatabaseConnection);
			const dummySegmentsRepo = {
				insertSegments: () => {},
				findByRunStream: () => [],
				countSegments: () => 0,
				listRecentRuns: () => [],
			};
			const dummyIndexRepo = {
				insertIndex: () => {},
				lastIndexedEnd: () => null,
				lastIndexedFileSeq: () => null,
			};

			const logstore = createLogstoreService({
				fs: controlledFs,
				paths,
				queue,
				ids: { newId: () => 'id-1' },
				unitOfWork: dummyUow,
				eventsIndexRepo: dummyIndexRepo as unknown as EventsIndexRepo,
				segmentsRepo: dummySegmentsRepo as unknown as LogSegmentsRepo,
				onDiskFull: (failedPath) => {
					systemService.notifyDiskFull(failedPath);
				},
			});

			// 1. Initial write succeeds
			const runId = 'run-e104';
			await logstore.appendRaw(runId, Buffer.from('Hello')); // 5 bytes + 1 newline = 6 bytes
			const rawPath = paths.segmentPath(runId, 'raw', 0);
			const initialLen = controlledFs.fileLenSync(rawPath);
			expect(initialLen).toBe(6);
			expect(systemService.isDispatchHalted()).toBe(false);

			// 2. Trigger ENOSPC (disk full)
			simulatedDiskFull = true;

			await expect(logstore.appendRaw(runId, Buffer.from('World'))).rejects.toMatchObject({
				code: 'E_DISK_FULL',
			});

			// Verify dispatch is halted immediately
			expect(systemService.isDispatchHalted()).toBe(true);

			// Verify system.disk_warning event was emitted
			expect(publishedEvents).toHaveLength(1);
			expect(publishedEvents[0]?.kind).toBe('system.disk_warning');

			// Verify already-written log is NOT damaged or lost
			const preservedLen = controlledFs.fileLenSync(rawPath);
			expect(preservedLen).toBe(initialLen);
			const existingData = await controlledFs.readFile(rawPath);
			expect(Buffer.from(existingData).toString('utf8')).toBe('Hello\n');

			// 3. Disk space recovered (simulated full cleared)
			simulatedDiskFull = false;

			// Append resumes successfully
			await logstore.appendRaw(runId, Buffer.from('World')); // 5 bytes + 1 newline = 6 bytes
			const finalLen = controlledFs.fileLenSync(rawPath);
			expect(finalLen).toBe(12);

			const finalData = await controlledFs.readFile(rawPath);
			expect(Buffer.from(finalData).toString('utf8')).toBe('Hello\nWorld\n');
		});
	});

	describe('GET /api/v1/system/usage HTTP endpoint', () => {
		it('returns 200 with dataDirBytes, byRun, and warnThreshold', async () => {
			const fs = createNodeLogFileSystem();
			const run1Dir = join(logRoot, 'run-1');
			const run2Dir = join(logRoot, 'run-2');
			fs.mkdirSync(run1Dir);
			fs.mkdirSync(run2Dir);
			writeFileSync(join(run1Dir, 'raw.log'), 'x'.repeat(400));
			writeFileSync(join(run2Dir, 'events.ndjson'), 'y'.repeat(600));

			const db = openDatabase(join(testDir, 'app.db'));
			db.exec(`
				CREATE TABLE IF NOT EXISTS event_seq (
					name TEXT PRIMARY KEY,
					watermark INTEGER NOT NULL DEFAULT 0
				);
			`);

			const container = createContainer({
				config: {
					port: 7817,
					bind: '127.0.0.1',
					dataDir: testDir,
					logLevel: 'info',
					dev: false,
				},
				database: db,
				hostInputs: { platform: 'linux', homedir: '/root' },
				lockAdapter: dummyLockAdapter,
				instanceLock: dummyLockHandle,
				clock: { now: () => new Date().toISOString() },
				logstorePaths: createLogstorePaths(logRoot),
			});

			const server = createHttpServer({ container });

			const response = await server.instance.inject({
				method: 'GET',
				url: '/api/v1/system/usage',
			});

			expect(response.statusCode).toBe(200);
			const body = JSON.parse(response.body);

			expect(body.dataDirBytes).toBe(1000);
			expect(body.byRun).toHaveLength(2);
			// Sorted descending by bytes: run-2 (600) then run-1 (400)
			expect(body.byRun[0]?.runId).toBe('run-2');
			expect(body.byRun[0]?.bytes).toBe(600);
			expect(body.byRun[1]?.runId).toBe('run-1');
			expect(body.byRun[1]?.bytes).toBe(400);
			expect(body.warnThreshold).toBeGreaterThan(0);

			await server.close();
		});
	});
});
