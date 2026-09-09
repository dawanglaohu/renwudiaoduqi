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
import { toDiskFullError } from '../../src/logstore/fs-errors.ts';
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
		createNodeLogFileSystem().mkdirSync(logRoot);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe('E-104: storage disk write full handling', () => {
		it('halts new dispatches at once, publishes system.disk_warning, rejects with E_DISK_FULL, then resumes appending', async () => {
			let simulatedDiskFull = false;
			const realFs = createNodeLogFileSystem();
			// Only appendFile is intercepted; it fails exactly the way createNodeLogFileSystem reports ENOSPC.
			const controlledFs: LogFileSystem = {
				...realFs,
				appendFile: async (path, data) => {
					if (simulatedDiskFull) {
						const native = Object.assign(new Error('ENOSPC: no space left on device, write'), {
							code: 'ENOSPC',
						});
						throw toDiskFullError(native, path);
					}
					return realFs.appendFile(path, data);
				},
			};

			const paths = createLogstorePaths(logRoot);
			const queue = createAppendQueue({
				appendFile: (path, data) => controlledFs.appendFile(path, data),
			});
			const bus = createEventBus({ ringBuffer: createRingBuffer() });
			let eventSeq = 1;
			const envelopeFactory = createEnvelopeFactory({
				clock: { now: () => new Date().toISOString() },
				idAllocator: { allocate: () => eventSeq++ },
			});
			const systemService = createSystemService({ paths, fs: controlledFs, bus, envelopeFactory });
			const publishedEvents: EventEnvelope[] = [];
			bus.subscribe((event) => {
				publishedEvents.push(event);
			});

			// The index side is irrelevant here: appendRaw never touches the repos.
			const dummyDb = {
				transaction: (fn: () => unknown) => ({
					immediate: () => fn(),
					deferred: () => fn(),
					exclusive: () => fn(),
				}),
			};
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
				unitOfWork: createUnitOfWork(dummyDb as unknown as DatabaseConnection),
				eventsIndexRepo: dummyIndexRepo as unknown as EventsIndexRepo,
				segmentsRepo: dummySegmentsRepo as unknown as LogSegmentsRepo,
				onDiskFull: systemService.notifyDiskFull,
			});

			const runId = 'run-e104';
			await logstore.appendRaw(runId, Buffer.from('Hello'));
			const rawPath = paths.segmentPath(runId, 'raw', 0);
			expect(controlledFs.fileLenSync(rawPath)).toBe(6);
			expect(systemService.isDispatchHalted()).toBe(false);

			simulatedDiskFull = true;
			await expect(logstore.appendRaw(runId, Buffer.from('World'))).rejects.toMatchObject({
				code: 'E_DISK_FULL',
			});
			await expect(logstore.appendRaw(runId, Buffer.from('Again'))).rejects.toMatchObject({
				code: 'E_DISK_FULL',
			});

			expect(systemService.getDispatchHalt()?.cause).toBe('disk_full');
			// Two failed appends, one warning: the flag flips once per outage.
			expect(publishedEvents).toHaveLength(1);
			expect(publishedEvents[0]?.kind).toBe('system.disk_warning');
			expect(controlledFs.fileLenSync(rawPath)).toBe(6);
			expect(Buffer.from(await controlledFs.readFile(rawPath)).toString('utf8')).toBe('Hello\n');

			simulatedDiskFull = false;
			const resumed = await logstore.appendRaw(runId, Buffer.from('World'));
			expect(resumed.byteOffset).toBe(6);
			expect(controlledFs.fileLenSync(rawPath)).toBe(12);
			expect(Buffer.from(await controlledFs.readFile(rawPath)).toString('utf8')).toBe(
				'Hello\nWorld\n',
			);
		});
	});

	describe('GET /api/v1/system/usage HTTP endpoint', () => {
		it('returns 200 with the documented {dataDirBytes, byRun[], warnThreshold} shape', async () => {
			const fs = createNodeLogFileSystem();
			fs.mkdirSync(join(logRoot, 'run-1'));
			fs.mkdirSync(join(logRoot, 'run-2'));
			writeFileSync(join(logRoot, 'run-1', 'raw.log'), 'x'.repeat(400));
			writeFileSync(join(logRoot, 'run-2', 'events.ndjson'), 'y'.repeat(600));

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

			const response = await server.instance.inject({ method: 'GET', url: '/api/v1/system/usage' });

			expect(response.statusCode).toBe(200);
			const body = JSON.parse(response.body);
			expect(Object.keys(body).sort()).toEqual(['byRun', 'dataDirBytes', 'warnThreshold']);
			expect(body.dataDirBytes).toBe(1000);
			expect(body.byRun).toEqual([
				{ runId: 'run-2', bytes: 600 },
				{ runId: 'run-1', bytes: 400 },
			]);
			expect(body.warnThreshold).toBeGreaterThan(0);

			await server.close();
			db.close();
		});
	});
});
