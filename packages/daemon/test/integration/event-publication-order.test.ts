import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createIdAllocator } from '../../src/events/id-allocator.ts';
import { createPublicationOrder } from '../../src/events/publication-order.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import { handleSseStream } from '../../src/http/sse.ts';
import { createAppendQueue } from '../../src/logstore/append-queue.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import { spawnManaged } from '../../src/proc/spawn.ts';
import { createBatchesRepo } from '../../src/repo/batches.ts';
import { createDocumentsRepo } from '../../src/repo/documents.ts';
import { createEventSeqRepo } from '../../src/repo/event-seq-repo.ts';
import { createEventsIndexRepo } from '../../src/repo/events-index-repo.ts';
import { createLogSegmentsRepo } from '../../src/repo/log-segments-repo.ts';
import { createRunsRepo } from '../../src/repo/runs.ts';
import { createTasksRepo } from '../../src/repo/tasks.ts';
import { createBatchService } from '../../src/service/batch.ts';
import { createLogstoreService } from '../../src/service/logstore.ts';
import { createReviewContextService } from '../../src/service/review-context.ts';
import { createRunService } from '../../src/service/run.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
	const directory = mkdtempSync(join(tmpdir(), 'ags-event-order-'));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const db = openDatabase(':memory:');
	cleanups.push(() => db.close());
	const clock = { now: () => '2026-10-02T00:00:00.000Z' };
	createMigrationRunner({
		database: db,
		clock,
		fileSystem: { readDirectory: readdirSync, readFile: (path) => readFileSync(path, 'utf8') },
	}).run(resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations'));
	const publicationOrder = createPublicationOrder();
	const unitOfWork = createUnitOfWork(db, publicationOrder);
	const ringBuffer = createRingBuffer();
	const bus = createEventBus({ ringBuffer, publicationOrder });
	const envelopeFactory = createEnvelopeFactory({
		clock,
		publicationOrder,
		idAllocator: createIdAllocator({ store: createEventSeqRepo(db) }),
	});
	const batchesRepo = createBatchesRepo(db);
	const documentsRepo = createDocumentsRepo(db);
	const tasksRepo = createTasksRepo(db);
	const runsRepo = createRunsRepo(db);
	const batchService = createBatchService({
		batchesRepo,
		tasksRepo,
		runsRepo,
		unitOfWork,
		clock,
		bus,
		envelopeFactory,
	});
	const reviewContext = createReviewContextService({
		db,
		documentsRepo,
		batchesRepo,
		tasksRepo,
		batchService,
		bus,
		clock,
	});
	cleanups.push(() => reviewContext.dispose());
	return {
		directory,
		db,
		clock,
		unitOfWork,
		publicationOrder,
		ringBuffer,
		bus,
		envelopeFactory,
		batchesRepo,
		documentsRepo,
	};
}

function connectSse(bus: ReturnType<typeof createEventBus>) {
	const request = Object.assign(new EventEmitter(), { headers: {} });
	const chunks: string[] = [];
	const response = Object.assign(new EventEmitter(), {
		setHeader: () => undefined,
		flushHeaders: () => undefined,
		write: (chunk: string) => {
			chunks.push(chunk);
			return true;
		},
		end: () => response.emit('close'),
	});
	handleSseStream({
		rawRequest: request as unknown as IncomingMessage,
		rawResponse: response as unknown as ServerResponse,
		requestId: 'event-order',
		actorDeviceId: 'device',
		bus,
		pairingService: { registerConnection: () => () => undefined },
	});
	cleanups.push(() => response.emit('close'));
	return {
		events: () =>
			chunks.flatMap((chunk) =>
				chunk
					.split('\n')
					.filter((line) => line.startsWith('data: '))
					.map((line) => JSON.parse(line.slice(6)) as EventEnvelope),
			),
	};
}

describe('production event publishers preserve the SSE cursor order', () => {
	it('persists 5001 small events while a slow disk fills the reservation window', async () => {
		const env = setup();
		const realFs = createNodeLogFileSystem();
		let releaseWrite: () => void = () => undefined;
		const blocked = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const fs = {
			...realFs,
			appendFile: async (path: string, bytes: Uint8Array) => {
				await blocked;
				await realFs.appendFile(path, bytes);
			},
		};
		const queue = createAppendQueue({ appendFile: fs.appendFile });
		const paths = createLogstorePaths(env.directory);
		const logstore = createLogstoreService({
			fs,
			paths,
			queue,
			unitOfWork: env.unitOfWork,
			ids: { newId: () => 'segment' },
			eventsIndexRepo: createEventsIndexRepo(env.db),
			segmentsRepo: createLogSegmentsRepo(env.db),
		});
		const failures: unknown[] = [];
		const service = createRunService({
			logstore,
			clock: env.clock,
			envelopeFactory: env.envelopeFactory,
			bus: env.bus,
			logFailure: (error) => failures.push(error),
		});
		const child = spawnManaged(
			{
				runId: 'pressure',
				file: process.execPath,
				args: ['-e', 'process.stdout.write((JSON.stringify({type:"chunk"})+"\\n").repeat(5001))'],
				cwd: env.directory,
			},
			{
				platform: process.platform === 'win32' ? 'win32' : 'linux',
				appendQueue: queue,
				outputBackpressure: env.publicationOrder,
			},
		);
		const attached = service.attachProcess('pressure', child, {
			eventMapper: () => [{ kind: 'agent_message_chunk', payload: { chunk: 'x' } }],
		});
		try {
			await vi.waitFor(() => expect(env.publicationOrder.isPaused).toBe(true));
			expect(queue.pendingBytes).toBeLessThan(queue.highWatermarkBytes);
			expect(env.publicationOrder.pendingCount()).toBe(5000);
			expect(child.child.stdout?.isPaused()).toBe(true);
			releaseWrite();
			await attached.waitForCompletion();
			const events = Buffer.from(await fs.readFile(paths.segmentPath('pressure', 'events', 0)))
				.toString('utf8')
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line) as EventEnvelope);
			expect(events.filter((event) => event.kind === 'agent_message_chunk')).toHaveLength(5001);
			expect(failures).toEqual([]);
			expect(env.publicationOrder.pendingCount()).toBe(0);
		} finally {
			releaseWrite();
			await child.finalize();
			attached.detach();
		}
	}, 30000);
	it('cancels SQLite rollback reservations without cancelling an earlier disk owner', () => {
		const env = setup();
		const earlier = env.envelopeFactory.createEnvelope({
			kind: 'agent_message_chunk',
			payload: { chunk: 'before' },
		});
		expect(() =>
			env.unitOfWork.run(() => {
				env.envelopeFactory.createEnvelope({
					kind: 'agent_message_chunk',
					payload: { chunk: 'rollback' },
				});
				throw new Error('rollback');
			}),
		).toThrow();
		const later = env.envelopeFactory.createEnvelope({
			kind: 'agent_message_chunk',
			payload: { chunk: 'after' },
		});
		env.bus.publish(later);
		expect(env.ringBuffer.size()).toBe(0);
		env.bus.publish(earlier);
		expect(env.ringBuffer.getAll().map((event) => event.id)).toEqual([1, 3]);
		expect(env.publicationOrder.pendingCount()).toBe(0);
	});

	it('cancels all mapped reservations after a run log append rejects', async () => {
		const env = setup();
		const realFs = createNodeLogFileSystem();
		const fs = {
			...realFs,
			appendFile: async (path: string, bytes: Uint8Array) => {
				if (path.endsWith('events.ndjson')) throw new Error('event disk unavailable');
				await realFs.appendFile(path, bytes);
			},
		};
		const logstore = createLogstoreService({
			fs,
			paths: createLogstorePaths(env.directory),
			queue: createAppendQueue({ appendFile: fs.appendFile }),
			unitOfWork: env.unitOfWork,
			ids: { newId: () => 'segment' },
			eventsIndexRepo: createEventsIndexRepo(env.db),
			segmentsRepo: createLogSegmentsRepo(env.db),
		});
		const service = createRunService({
			logstore,
			clock: env.clock,
			envelopeFactory: env.envelopeFactory,
			bus: env.bus,
		});
		await expect(
			service.ingestLine('run', '{"type":"output"}', {
				eventMapper: () =>
					['first', 'second'].map((chunk) =>
						env.envelopeFactory.createEnvelope({
							runId: 'run',
							kind: 'agent_message_chunk',
							payload: { chunk },
						}),
					),
			}),
		).rejects.toThrow('event disk unavailable');
		const later = env.envelopeFactory.createEnvelope({
			kind: 'document.settings_changed',
			payload: { docId: 'doc', laneCount: 3 },
		});
		env.bus.publish(later);
		expect(env.ringBuffer.getAll()).toEqual([later]);
		expect(later.id).toBe(3);
		expect(env.publicationOrder.pendingCount()).toBe(0);
	});
	it('delivers docs change before the batch pause emitted by its review-context subscriber', () => {
		const env = setup();
		env.documentsRepo.insert({
			id: 'doc',
			docs_path: '/docs/docs-data.js',
			project_name: 'Events',
			repo_path: null,
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: 'before',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: env.clock.now(),
			last_seen_at: env.clock.now(),
		});
		env.batchesRepo.insert({ id: 'batch', doc_id: 'doc', batch_no: 1, state: 'running' });
		const stream = connectSse(env.bus);
		env.bus.publish(
			env.envelopeFactory.createEnvelope({
				kind: 'system.docs_changed',
				payload: { docsPath: '/docs/docs-data.js', fingerprint: 'after' },
			}),
		);

		expect(env.batchesRepo.findById('batch')?.state).toBe('paused');
		expect(stream.events().map((event) => event.kind)).toEqual([
			'system.docs_changed',
			'batch.advanced',
		]);
		expect(stream.events().map((event) => event.id)).toEqual([1, 2]);
	});

	it('retains a disk-pending run event when an immediate settings event is published', async () => {
		const env = setup();
		const realFs = createNodeLogFileSystem();
		const paths = createLogstorePaths(env.directory);
		let releaseWrite: () => void = () => undefined;
		let observeWrite: () => void = () => undefined;
		const writeStarted = new Promise<void>((resolve) => {
			observeWrite = resolve;
		});
		const writeAllowed = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const fs = {
			...realFs,
			appendFile: async (path, data) => {
				observeWrite();
				await writeAllowed;
				await realFs.appendFile(path, data);
			},
		} satisfies ReturnType<typeof createNodeLogFileSystem>;
		const queue = createAppendQueue({ appendFile: fs.appendFile });
		const logstore = createLogstoreService({
			fs,
			paths,
			queue,
			unitOfWork: env.unitOfWork,
			ids: { newId: () => 'segment' },
			eventsIndexRepo: createEventsIndexRepo(env.db),
			segmentsRepo: createLogSegmentsRepo(env.db),
		});
		const service = createRunService({
			logstore,
			clock: env.clock,
			envelopeFactory: env.envelopeFactory,
			bus: env.bus,
		});
		const stream = connectSse(env.bus);
		const ingesting = service.ingestEvent(
			'run',
			env.envelopeFactory.createEnvelope({
				runId: 'run',
				kind: 'agent_message_chunk',
				payload: { chunk: 'Must survive' },
			}),
		);
		await writeStarted;
		env.bus.publish(
			env.envelopeFactory.createEnvelope({
				kind: 'document.settings_changed',
				payload: { docId: 'doc', laneCount: 3 },
			}),
		);
		releaseWrite();
		await ingesting;

		const persisted = JSON.parse(
			Buffer.from(await fs.readFile(paths.segmentPath('run', 'events', 0))).toString('utf8'),
		) as EventEnvelope;
		expect(persisted.payload).toEqual({ chunk: 'Must survive' });
		expect(stream.events().map((event) => event.kind)).toEqual([
			'agent_message_chunk',
			'document.settings_changed',
		]);
		expect(stream.events().map((event) => event.id)).toEqual([1, 2]);
		expect(env.ringBuffer.latest()?.id).toBe(2);
	});
});
