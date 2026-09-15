import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { type UnitOfWork, createUnitOfWork } from '../../src/db/unit-of-work.ts';
import {
	RUN_TRANSITION_REASONS,
	countsTowardAgentConcurrency,
} from '../../src/domain/run-state-machine.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createIdAllocator } from '../../src/events/id-allocator.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import { createAppendQueue } from '../../src/logstore/append-queue.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import type { ReadLine } from '../../src/proc/line-reader.ts';
import type { ManagedProcess, ProcessExitResult } from '../../src/proc/spawn.ts';
import { createEventSeqRepo } from '../../src/repo/event-seq-repo.ts';
import { createEventsIndexRepo } from '../../src/repo/events-index-repo.ts';
import { createLogSegmentsRepo } from '../../src/repo/log-segments-repo.ts';
import { createLogstoreService } from '../../src/service/logstore.ts';
import { type RunRecord, type RunsRepo, createRunService } from '../../src/service/run.ts';

const tmpDirs: string[] = [];
const openDatabases: DatabaseConnection[] = [];

afterEach(() => {
	for (const db of openDatabases.splice(0)) {
		try {
			db.close();
		} catch {
			// ignore
		}
	}
	for (const dir of tmpDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
});

function setupTestEnvironment() {
	const baseDir = mkdtempSync(join(tmpdir(), 'ags-run-service-test-'));
	tmpDirs.push(baseDir);

	const db = openDatabase(':memory:');
	openDatabases.push(db);
	db.pragma('foreign_keys = OFF');

	const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
	const runner = createMigrationRunner({
		clock: { now: () => '2026-09-12T00:00:00.000Z' },
		database: db,
		fileSystem: {
			readDirectory: () => ['0001_init.sql'],
			readFile: () => readFileSync(join(migrationsDir, '0001_init.sql'), 'utf8'),
		},
	});
	runner.run(migrationsDir);

	const fs = createNodeLogFileSystem();
	const paths = createLogstorePaths(baseDir);
	const queue = createAppendQueue({
		appendFile: (p, d) => fs.appendFile(p, d),
	});

	let idCounter = 1;
	const ids = { newId: () => `id-${idCounter++}` };
	const clock = { now: () => '2026-09-12T00:00:00.000Z' };

	const unitOfWork = createUnitOfWork(db);
	const eventsIndexRepo = createEventsIndexRepo(db);
	const segmentsRepo = createLogSegmentsRepo(db);
	const eventSeqRepo = createEventSeqRepo(db);

	const logstore = createLogstoreService({
		fs,
		paths,
		queue,
		ids,
		unitOfWork,
		eventsIndexRepo,
		segmentsRepo,
	});

	const ringBuffer = createRingBuffer();
	const bus = createEventBus({ ringBuffer });
	const idAllocator = createIdAllocator({
		store: eventSeqRepo,
	});
	const envelopeFactory = createEnvelopeFactory({
		clock,
		idAllocator,
	});

	// In-memory RunsRepo mock with SQLite table fallback
	const inMemoryRuns = new Map<string, RunRecord>();

	const runsRepo: RunsRepo = {
		findById(id: string) {
			return inMemoryRuns.get(id) ?? null;
		},
		updateState(input) {
			const existing = inMemoryRuns.get(input.id);
			if (existing) {
				inMemoryRuns.set(input.id, {
					...existing,
					state: input.toState,
					endedAt: input.endedAt ?? existing.endedAt,
					exitCode: input.exitCode !== undefined ? input.exitCode : existing.exitCode,
					exitSignal: input.exitSignal !== undefined ? input.exitSignal : existing.exitSignal,
				});
			}
		},
		updateLastEventAt(id: string, lastEventAt: string) {
			const existing = inMemoryRuns.get(id);
			if (existing) {
				inMemoryRuns.set(id, {
					...existing,
					lastEventAt,
				});
			}
		},
		incrementUnmappedEventCount(id: string) {
			const existing = inMemoryRuns.get(id);
			if (existing) {
				inMemoryRuns.set(id, {
					...existing,
					unmappedEventCount: (existing.unmappedEventCount ?? 0) + 1,
				});
			}
		},
		findInFlight() {
			return Array.from(inMemoryRuns.values()).filter(
				(r) =>
					r.state === 'running' ||
					r.state === 'starting' ||
					r.state === 'queued' ||
					r.state === 'awaiting_reply',
			);
		},
	};

	function createRun(record: RunRecord) {
		inMemoryRuns.set(record.id, record);
	}

	return {
		baseDir,
		db,
		fs,
		paths,
		logstore,
		bus,
		envelopeFactory,
		unitOfWork,
		runsRepo,
		createRun,
		clock,
		ids,
		ringBuffer,
		idAllocator,
	};
}

describe('M6-T2 RunService: Stream Orchestration and Disk Wiring', () => {
	it('AC 1: Writes every raw output line to raw.log and every normalized event to events.ndjson', async () => {
		const env = setupTestEnvironment();
		const service = createRunService({
			logstore: env.logstore,
			bus: env.bus,
			envelopeFactory: env.envelopeFactory,
			unitOfWork: env.unitOfWork,
			runsRepo: env.runsRepo,
			clock: env.clock,
		});

		const runId = 'run-ac1-001';
		env.createRun({
			id: runId,
			taskId: 'task-1',
			state: 'running',
			pid: 1234,
		});

		// 1. Ingest raw output lines
		await service.ingestRaw(runId, 'raw stdout line 1\n');
		await service.ingestRaw(runId, 'raw stdout line 2 without newline');

		const rawContent = await env.fs.readFile(env.paths.segmentPath(runId, 'raw', 0));
		const rawText = Buffer.from(rawContent).toString('utf8');
		expect(rawText).toBe('raw stdout line 1\nraw stdout line 2 without newline\n');

		// 2. Ingest normalized events (full original text never truncated)
		const longPayload = 'A'.repeat(50 * 1024); // 50 KiB payload (> 32 KiB)
		const event1 = env.envelopeFactory.createEnvelope({
			kind: 'tool_call',
			runId,
			taskId: 'task-1',
			payload: { tool: 'bash', input: longPayload },
		});
		const event2 = env.envelopeFactory.createEnvelope({
			kind: 'agent_message_chunk',
			runId,
			taskId: 'task-1',
			payload: { chunk: 'chunk 1' },
		});

		await service.ingestEvent(runId, event1);
		await service.ingestEvent(runId, event2);

		const eventsContent = await env.fs.readFile(env.paths.segmentPath(runId, 'events', 0));
		const eventsText = Buffer.from(eventsContent).toString('utf8');
		const lines = eventsText.trim().split('\n');
		expect(lines).toHaveLength(2);

		const line1 = lines[0];
		const line2 = lines[1];
		expect(line1).toBeDefined();
		expect(line2).toBeDefined();
		const parsedEvent1 = JSON.parse(line1 ?? '{}');
		expect(parsedEvent1.kind).toBe('tool_call');
		expect(parsedEvent1.payload.input).toBe(longPayload);

		const parsedEvent2 = JSON.parse(line2 ?? '{}');
		expect(parsedEvent2.kind).toBe('agent_message_chunk');
		expect(parsedEvent2.payload.chunk).toBe('chunk 1');
	});

	it('AC 2: events index table only receives milestone events; high-frequency *_chunk does not enter table', async () => {
		const env = setupTestEnvironment();
		const service = createRunService({
			logstore: env.logstore,
			bus: env.bus,
			envelopeFactory: env.envelopeFactory,
			unitOfWork: env.unitOfWork,
			runsRepo: env.runsRepo,
			clock: env.clock,
		});

		const runId = 'run-ac2-001';
		env.createRun({
			id: runId,
			taskId: 'task-ac2',
			state: 'running',
			pid: 2222,
		});

		// Send 1 milestone event (tool_call)
		const milestoneEvent = env.envelopeFactory.createEnvelope({
			kind: 'tool_call',
			runId,
			taskId: 'task-ac2',
			payload: { tool: 'edit' },
		});
		await service.ingestEvent(runId, milestoneEvent);

		// Send 3 high-frequency chunks
		const chunk1 = env.envelopeFactory.createEnvelope({
			kind: 'agent_message_chunk',
			runId,
			taskId: 'task-ac2',
			payload: { chunk: 'a' },
		});
		const chunk2 = env.envelopeFactory.createEnvelope({
			kind: 'agent_thought_chunk',
			runId,
			taskId: 'task-ac2',
			payload: { chunk: 'thinking' },
		});
		const chunk3 = env.envelopeFactory.createEnvelope({
			kind: 'available_commands_update',
			runId,
			taskId: 'task-ac2',
			payload: { commands: [] },
		});

		await service.ingestEvent(runId, chunk1);
		await service.ingestEvent(runId, chunk2);
		await service.ingestEvent(runId, chunk3);

		// Send another milestone event
		const milestoneEvent2 = env.envelopeFactory.createEnvelope({
			kind: 'plan',
			runId,
			taskId: 'task-ac2',
			payload: { steps: ['step1'] },
		});
		await service.ingestEvent(runId, milestoneEvent2);

		// Query the events index table directly in SQLite
		const rows = env.db.prepare('SELECT kind, seq FROM events ORDER BY seq').all() as Array<{
			kind: string;
			seq: number;
		}>;

		// Only tool_call and plan are indexed! All 3 *_chunk events are omitted from SQLite
		expect(rows).toHaveLength(2);
		expect(rows[0]?.kind).toBe('tool_call');
		expect(rows[1]?.kind).toBe('plan');

		// But in events.ndjson, all 5 events exist verbatim
		const eventsContent = await env.fs.readFile(env.paths.segmentPath(runId, 'events', 0));
		const eventLines = Buffer.from(eventsContent).toString('utf8').trim().split('\n');
		expect(eventLines).toHaveLength(5);
	});

	it('AC 3: No await or async side effects in transaction callback; events published strictly after transaction returns', async () => {
		const env = setupTestEnvironment();

		const executionOrder: string[] = [];
		const instrumentedUow: UnitOfWork = {
			run<T>(fn: () => T): T {
				executionOrder.push('tx-begin');
				const result = env.unitOfWork.run(() => {
					executionOrder.push('tx-inside');
					return fn();
				});
				executionOrder.push('tx-committed');
				return result;
			},
		};

		// Subscribe to EventBus to check when event arrives
		env.bus.subscribe((envelope) => {
			executionOrder.push(`bus-published:${envelope.kind}`);
		});

		const service = createRunService({
			logstore: env.logstore,
			bus: env.bus,
			envelopeFactory: env.envelopeFactory,
			unitOfWork: instrumentedUow,
			runsRepo: env.runsRepo,
			clock: env.clock,
		});

		const runId = 'run-ac3-001';
		env.createRun({
			id: runId,
			taskId: 'task-ac3',
			state: 'running',
			pid: 3333,
		});

		// Transition state from running to exited
		await service.transitionState({
			runId,
			targetState: 'exited',
			reason: 'process_exited',
			exitCode: 0,
		});

		// Verification:
		// 1. tx-begin -> tx-inside -> tx-committed -> bus-published
		// The event must be published strictly AFTER tx-committed!
		const txCommitIndex = executionOrder.indexOf('tx-committed');
		const busPublishIndex = executionOrder.findIndex((s) => s.startsWith('bus-published'));
		expect(txCommitIndex).toBeGreaterThan(-1);
		expect(busPublishIndex).toBeGreaterThan(txCommitIndex);

		// Run state updated
		const updated = env.runsRepo.findById(runId);
		expect(updated?.state).toBe('exited');
		expect(updated?.exitCode).toBe(0);
	});

	it('E-142: Daemon long-running memory bounds - memory holds only RingBuffer, history reads from disk', async () => {
		const env = setupTestEnvironment();
		const service = createRunService({
			logstore: env.logstore,
			bus: env.bus,
			envelopeFactory: env.envelopeFactory,
			unitOfWork: env.unitOfWork,
			runsRepo: env.runsRepo,
			clock: env.clock,
		});

		const runId = 'run-e142-001';
		env.createRun({
			id: runId,
			taskId: 'task-e142',
			state: 'running',
			pid: 4444,
		});

		// Ingest 50 events
		for (let i = 0; i < 50; i++) {
			const envItem = env.envelopeFactory.createEnvelope({
				kind: 'agent_message_chunk',
				runId,
				taskId: 'task-e142',
				payload: { chunk: `token-${i}` },
			});
			await service.ingestEvent(runId, envItem);
		}

		// Ring buffer size reflects events
		expect(env.ringBuffer.size()).toBe(50);

		// Historical read is performed via logstore paged cursor without keeping in RunService memory
		const page1 = await env.logstore.readEventsPage(runId, undefined);
		expect(page1.ok).toBe(true);
		if (page1.ok) {
			expect(page1.data.byteLength).toBeGreaterThan(0);
		}

		// Close run stream to clean up writer handles
		await service.closeRunStream(runId);
	});

	it('Line processing (ingestLine): separates raw output and normalized events, handles non-JSON (E-140) and unmapped events (E-202)', async () => {
		const env = setupTestEnvironment();

		// Custom event mapper for vendor events
		const customMapper = (vendorLine: unknown): readonly EventEnvelope[] => {
			if (!vendorLine || typeof vendorLine !== 'object') return [];
			const obj = vendorLine as Record<string, unknown>;
			if (obj.type === 'message') {
				return [
					env.envelopeFactory.createEnvelope({
						kind: 'agent_message_chunk',
						runId: 'run-line-001',
						taskId: 'task-line',
						payload: { chunk: String(obj.content) },
					}),
				];
			}
			return []; // unmapped
		};

		const service = createRunService({
			logstore: env.logstore,
			bus: env.bus,
			envelopeFactory: env.envelopeFactory,
			unitOfWork: env.unitOfWork,
			runsRepo: env.runsRepo,
			eventMapper: customMapper,
			clock: env.clock,
		});

		const runId = 'run-line-001';
		env.createRun({
			id: runId,
			taskId: 'task-line',
			state: 'running',
			pid: 5555,
		});

		// 1. Plain text line (E-140): appended to raw.log, no events produced, does NOT interrupt stream
		const res1 = await service.ingestLine(runId, 'Compiling project files...\n');
		expect(res1.rawAppended).toBe(true);
		expect(res1.eventsAppended).toBe(0);

		// 2. Mapped JSON line: appended to raw.log AND normalized into events.ndjson
		const res2 = await service.ingestLine(
			runId,
			JSON.stringify({ type: 'message', content: 'Hello World' }),
		);
		expect(res2.rawAppended).toBe(true);
		expect(res2.eventsAppended).toBe(1);

		// 3. Unmapped JSON line (E-202): appended to raw.log, unmappedDiscarded is true, incrementUnmappedEventCount called
		const res3 = await service.ingestLine(
			runId,
			JSON.stringify({ type: 'some_unknown_vendor_event', foo: 'bar' }),
		);
		expect(res3.rawAppended).toBe(true);
		expect(res3.eventsAppended).toBe(0);
		expect(res3.unmappedDiscarded).toBe(true);

		const run = env.runsRepo.findById(runId);
		expect(run?.unmappedEventCount).toBe(1);

		// Check raw.log has all 3 lines
		const rawContent = await env.fs.readFile(env.paths.segmentPath(runId, 'raw', 0));
		const rawLines = Buffer.from(rawContent).toString('utf8').trim().split('\n');
		expect(rawLines).toHaveLength(3);
	});

	it('attachProcess: wires stdout/stderr to raw.log and events.ndjson, and settles state on exit', async () => {
		const env = setupTestEnvironment();
		const service = createRunService({
			logstore: env.logstore,
			bus: env.bus,
			envelopeFactory: env.envelopeFactory,
			unitOfWork: env.unitOfWork,
			runsRepo: env.runsRepo,
			clock: env.clock,
		});

		const runId = 'run-attach-001';
		env.createRun({
			id: runId,
			taskId: 'task-attach',
			state: 'running',
			pid: 6666,
		});

		// Mock ManagedProcess
		let rawCb: ((line: ReadLine) => void) | undefined;
		let jsonCb: ((parsed: { value: unknown }) => void) | undefined;
		let exitCb: ((result: ProcessExitResult) => void) | undefined;

		const mockProcess = {
			runId,
			pid: 6666,
			onRaw: (cb: (line: ReadLine) => void) => {
				rawCb = cb;
				return () => {
					rawCb = undefined;
				};
			},
			onJson: (cb: (parsed: { value: unknown }) => void) => {
				jsonCb = cb;
				return () => {
					jsonCb = undefined;
				};
			},
			onExit: (cb: (result: ProcessExitResult) => void) => {
				exitCb = cb;
				return () => {
					exitCb = undefined;
				};
			},
		} as unknown as ManagedProcess;

		const controller = service.attachProcess(runId, mockProcess);

		// Emit raw line
		rawCb?.({ text: 'process raw line 1', truncated: false, rawByteLen: 18 });

		// Emit normalized envelope via json
		const envelope = env.envelopeFactory.createEnvelope({
			kind: 'tool_call',
			runId,
			taskId: 'task-attach',
			payload: { tool: 'diff' },
		});
		jsonCb?.({ value: envelope });

		// Allow async fire-and-forget to settle
		await new Promise((resolve) => setTimeout(resolve, 150));

		// Verify raw.log and events.ndjson
		const rawContent = await env.fs.readFile(env.paths.segmentPath(runId, 'raw', 0));
		expect(Buffer.from(rawContent).toString('utf8')).toContain('process raw line 1\n');

		const eventsContent = await env.fs.readFile(env.paths.segmentPath(runId, 'events', 0));
		expect(Buffer.from(eventsContent).toString('utf8')).toContain('tool_call');

		// Process exits
		exitCb?.({
			runId,
			pid: 6666,
			exitCode: 0,
			signal: null,
			reason: 'exited',
		});

		await controller.waitForCompletion();

		// Run transitioned to 'exited'
		const updatedRun = env.runsRepo.findById(runId);
		expect(updatedRun?.state).toBe('exited');
		expect(updatedRun?.exitCode).toBe(0);

		controller.detach();
	});

	it('Reconcile runs service integration (findInFlightRuns, markInterrupted, markOrphaned)', async () => {
		const env = setupTestEnvironment();
		const service = createRunService({
			logstore: env.logstore,
			bus: env.bus,
			envelopeFactory: env.envelopeFactory,
			unitOfWork: env.unitOfWork,
			runsRepo: env.runsRepo,
			clock: env.clock,
		});

		env.createRun({
			id: 'run-rec-1',
			taskId: 'task-1',
			state: 'running',
			pid: 1001,
		});
		env.createRun({
			id: 'run-rec-2',
			taskId: 'task-2',
			state: 'running',
			pid: 1002,
		});

		const inFlight = await service.findInFlightRuns();
		expect(inFlight).toHaveLength(2);

		// Mark interrupted
		await service.markInterrupted('run-rec-1', {
			reason: 'daemon_restart_process_not_found',
			endedAt: '2026-09-12T00:01:00.000Z',
			actorDeviceId: null,
		});
		expect(env.runsRepo.findById('run-rec-1')?.state).toBe('interrupted');

		// Mark orphaned
		await service.markOrphaned('run-rec-2', {
			reason: 'daemon_restart_unreconnectable',
			actorDeviceId: null,
		});
		expect(env.runsRepo.findById('run-rec-2')?.state).toBe('orphaned');
	});

	it('R1: Asserts that envelopes strictly use the injected envelopeFactory and clock, never fabricating id/seq or local Date', async () => {
		const env = setupTestEnvironment();
		const testClockTime = '2026-09-12T08:30:00.000Z';
		const customClock = { now: () => testClockTime };
		const customEnvelopeFactory = createEnvelopeFactory({
			clock: customClock,
			idAllocator: env.idAllocator,
		});

		const publishedEnvelopes: EventEnvelope[] = [];
		env.bus.subscribe((envelope) => {
			publishedEnvelopes.push(envelope);
		});

		const service = createRunService({
			logstore: env.logstore,
			bus: env.bus,
			envelopeFactory: customEnvelopeFactory,
			unitOfWork: env.unitOfWork,
			runsRepo: env.runsRepo,
			clock: customClock,
		});

		const runId = 'run-r1-verify';
		env.createRun({
			id: runId,
			taskId: 'task-r1',
			state: 'running',
			pid: 7777,
		});

		// Transition state
		await service.transitionState({
			runId,
			targetState: 'exited',
			reason: 'process_exited',
		});

		expect(publishedEnvelopes.length).toBeGreaterThan(0);
		const stateChanged = publishedEnvelopes.find((e) => e.kind === 'run.state_changed');
		expect(stateChanged).toBeDefined();

		// ID must be positive allocated ID from the allocator, NOT a fabricated 1
		expect(stateChanged?.id).toBeGreaterThan(0);
		// ts must strictly match the injected customClock, not host new Date()
		expect(stateChanged?.ts).toBe(testClockTime);
		// scope must be 'run'
		expect(stateChanged?.scope).toBe('run');

		// Database endedAt must also strictly equal injected clock.now(), never local Date
		const runInDb = env.runsRepo.findById(runId);
		expect(runInDb?.endedAt).toBe(testClockTime);
	});

	it('R2: Reports failures to logFailure without silent swallowing or unhandled rejections', async () => {
		const env = setupTestEnvironment();
		const reportedFailures: unknown[] = [];
		const logFailure = (error: unknown) => {
			reportedFailures.push(error);
		};

		// Create a failing logstore that throws E_LOG_FILE_MISSING
		const failingLogstore = {
			...env.logstore,
			appendRaw: async () => {
				throw new AppError('E_LOG_FILE_MISSING', 'Simulated missing log file on raw append');
			},
			appendEvent: async () => {
				throw new AppError('E_LOG_FILE_MISSING', 'Simulated missing log file on event append');
			},
		};

		const service = createRunService({
			logstore: failingLogstore,
			bus: env.bus,
			envelopeFactory: env.envelopeFactory,
			unitOfWork: env.unitOfWork,
			runsRepo: env.runsRepo,
			clock: env.clock,
			logFailure,
		});

		const runId = 'run-r2-failure';
		env.createRun({
			id: runId,
			taskId: 'task-r2',
			state: 'running',
			pid: 8888,
		});

		let rawCb: ((line: ReadLine) => void) | undefined;
		let exitCb: ((result: ProcessExitResult) => void) | undefined;

		const mockProcess = {
			runId,
			pid: 8888,
			onRaw: (cb: (line: ReadLine) => void) => {
				rawCb = cb;
				return () => {
					rawCb = undefined;
				};
			},
			onJson: () => () => undefined,
			onExit: (cb: (result: ProcessExitResult) => void) => {
				exitCb = cb;
				return () => {
					exitCb = undefined;
				};
			},
		} as unknown as ManagedProcess;

		const controller = service.attachProcess(runId, mockProcess);

		// Trigger raw line -> should be caught and passed to logFailure, no unhandled rejection
		rawCb?.({ text: 'failing line', truncated: false, rawByteLen: 12 });

		await new Promise((resolve) => setTimeout(resolve, 50));

		// Expect failure reported
		expect(reportedFailures.length).toBeGreaterThan(0);
		const firstError = reportedFailures[0];
		expect(firstError).toBeInstanceOf(AppError);
		expect((firstError as AppError).code).toBe('E_LOG_FILE_MISSING');

		// Process exit
		exitCb?.({
			runId,
			pid: 8888,
			exitCode: 0,
			signal: null,
			reason: 'exited',
		});

		await controller.waitForCompletion();
		controller.detach();
	});

	describe('M6-T7: 自动模式下的提问处置 (AC 1-3, E-115, E-133, E-134)', () => {
		it('AC 1 & E-115: 自动模式下 agent 提问时调度器一律不代答，任务转 awaiting_reply 并继续占用 agent 并发额度', async () => {
			const env = setupTestEnvironment();
			const publishedEnvelopes: EventEnvelope[] = [];
			env.bus.subscribe((envelope) => {
				publishedEnvelopes.push(envelope);
			});

			const service = createRunService({
				logstore: env.logstore,
				bus: env.bus,
				envelopeFactory: env.envelopeFactory,
				unitOfWork: env.unitOfWork,
				runsRepo: env.runsRepo,
				clock: env.clock,
			});

			const runId = 'run-e115-test';
			env.createRun({
				id: runId,
				taskId: 'task-e115',
				state: 'starting',
				pid: 5501,
				laneNo: 2,
			});

			// 1. 收到第一条可解析事件，starting -> running
			const startEvent = env.envelopeFactory.createEnvelope({
				kind: 'agent_message_chunk',
				runId,
				taskId: 'task-e115',
				payload: { chunk: 'Starting analysis...' },
			});
			await service.ingestEvent(runId, startEvent);
			expect(env.runsRepo.findById(runId)?.state).toBe('running');

			// 2. agent 抛出开放提问 (tool: ask_user)
			const questionEvent = env.envelopeFactory.createEnvelope({
				kind: 'tool_call',
				runId,
				taskId: 'task-e115',
				payload: {
					tool: 'ask_user',
					input: { question: 'Should we proceed with schema migration?' },
				},
			});
			await service.ingestEvent(runId, questionEvent);

			// 调度器一律不代答，任务转「等待人回话」
			const updatedRun = env.runsRepo.findById(runId);
			expect(updatedRun?.state).toBe('awaiting_reply');
			expect(await service.isAwaitingReply(runId)).toBe(true);

			// awaiting_reply 状态继续占用 agent 并发额度 (E-115)
			expect(countsTowardAgentConcurrency('awaiting_reply')).toBe(true);

			// awaiting_reply 不释放泳道、不置空 lane_no (E-326)
			expect(updatedRun?.laneNo).toBe(2);

			// 状态变更事件已发布且原因标注为 agent_question
			const stateChanged = publishedEnvelopes.find(
				(e) =>
					e.kind === 'run.state_changed' && (e.payload as { to?: string })?.to === 'awaiting_reply',
			);
			expect(stateChanged).toBeDefined();
			expect((stateChanged?.payload as { reason?: string })?.reason).toBe(
				RUN_TRANSITION_REASONS.AGENT_QUESTION,
			);

			// markAwaitingReply 幂等性：已处于 awaiting_reply 时再次调用不报错
			await service.markAwaitingReply(runId);
			expect(env.runsRepo.findById(runId)?.state).toBe('awaiting_reply');
		});

		it('AC 2 & E-134: agent 需要联网装依赖时默认拦下并转回话通路由人决策，不提供自动放行网络开关', async () => {
			const env = setupTestEnvironment();
			const publishedEnvelopes: EventEnvelope[] = [];
			env.bus.subscribe((envelope) => {
				publishedEnvelopes.push(envelope);
			});

			const service = createRunService({
				logstore: env.logstore,
				bus: env.bus,
				envelopeFactory: env.envelopeFactory,
				unitOfWork: env.unitOfWork,
				runsRepo: env.runsRepo,
				clock: env.clock,
			});

			const runId = 'run-e134-test';
			env.createRun({
				id: runId,
				taskId: 'task-e134',
				state: 'running',
				pid: 5502,
			});

			// agent 尝试通过 bash 执行 npm install
			const npmEvent = env.envelopeFactory.createEnvelope({
				kind: 'tool_call',
				runId,
				taskId: 'task-e134',
				payload: {
					tool: 'bash',
					input: { command: 'npm install --save-dev lodash' },
				},
			});

			await service.ingestEvent(runId, npmEvent);

			// 默认拦下并转 awaiting_reply
			expect(env.runsRepo.findById(runId)?.state).toBe('awaiting_reply');
			expect(await service.isAwaitingReply(runId)).toBe(true);

			// 必须产生并发布 run.permission_blocked 事件，且在原因中体现装依赖阻断
			const permBlocked = publishedEnvelopes.find((e) => e.kind === 'run.permission_blocked');
			expect(permBlocked).toBeDefined();
			expect((permBlocked?.payload as { reason?: string })?.reason).toContain('E-134');
		});

		it('AC 3 & E-133: 沙箱拦下越界写入时记「权限受阻」在时间线高亮，不判失败；提供「仅本次运行临时提升」开关', async () => {
			const env = setupTestEnvironment();
			const publishedEnvelopes: EventEnvelope[] = [];
			env.bus.subscribe((envelope) => {
				publishedEnvelopes.push(envelope);
			});

			const service = createRunService({
				logstore: env.logstore,
				bus: env.bus,
				envelopeFactory: env.envelopeFactory,
				unitOfWork: env.unitOfWork,
				runsRepo: env.runsRepo,
				clock: env.clock,
			});

			const runId = 'run-e133-test';
			env.createRun({
				id: runId,
				taskId: 'task-e133',
				state: 'running',
				pid: 5503,
				permissionTier: 'workspaceWrite',
			});

			// 沙箱拦下 worktree 之外的写入，产出 run.permission_blocked 事件
			const permEvent = env.envelopeFactory.createEnvelope({
				kind: 'run.permission_blocked',
				runId,
				taskId: 'task-e133',
				payload: {
					tool: 'file_edit',
					reason: 'Sandbox blocked write outside worktree: /etc/hosts',
				},
			});

			await service.ingestEvent(runId, permEvent);

			// 1. 记「权限受阻」事件并在时间线高亮 (milestone=true 写入 events 表与 events.ndjson)
			const eventsIndexed = env.db
				.prepare("SELECT * FROM events WHERE run_id = ? AND kind = 'run.permission_blocked'")
				.all(runId);
			expect(eventsIndexed).toHaveLength(1);

			// 2. 不判失败：绝不进入 failed，而是转为 awaiting_reply 等待人决策
			const runInDb = env.runsRepo.findById(runId);
			expect(runInDb?.state).toBe('awaiting_reply');
			expect(runInDb?.state).not.toBe('failed');

			// 3. 提供「仅本次运行临时提升」开关 (elevateRunOnce)
			await service.elevateRunOnce(runId);

			// 运行转回 running 继续执行
			expect(env.runsRepo.findById(runId)?.state).toBe('running');

			// 绝不改写默认档位 (permissionTier 保持 workspaceWrite)
			expect(env.runsRepo.findById(runId)?.permissionTier).toBe('workspaceWrite');

			// 非 awaiting_reply 状态下调用 elevateRunOnce 抛出 E_INVALID_STATE_TRANSITION
			await expect(service.elevateRunOnce(runId)).rejects.toThrowError(AppError);
			await expect(service.elevateRunOnce(runId)).rejects.toMatchObject({
				code: 'E_INVALID_STATE_TRANSITION',
			});
		});

		it('Lifecycle: awaiting_reply 出边支持进程自然退出 (exited) 与手动中止 (aborted)', async () => {
			const env = setupTestEnvironment();
			const service = createRunService({
				logstore: env.logstore,
				bus: env.bus,
				envelopeFactory: env.envelopeFactory,
				unitOfWork: env.unitOfWork,
				runsRepo: env.runsRepo,
				clock: env.clock,
			});

			// Case 1: 带着提问结束回合，进程自然退出 -> exited
			const runId1 = 'run-exit-from-reply';
			env.createRun({
				id: runId1,
				taskId: 'task-1',
				state: 'awaiting_reply',
				pid: 6601,
			});

			let exitCb: ((result: ProcessExitResult) => void) | undefined;
			const mockProcess = {
				runId: runId1,
				pid: 6601,
				onRaw: () => () => {},
				onJson: () => () => {},
				onExit: (cb: (result: ProcessExitResult) => void) => {
					exitCb = cb;
					return () => {
						exitCb = undefined;
					};
				},
			} as unknown as ManagedProcess;

			const controller = service.attachProcess(runId1, mockProcess);
			exitCb?.({
				runId: runId1,
				pid: 6601,
				exitCode: 0,
				signal: null,
				reason: 'exited',
			});
			await controller.waitForCompletion();
			controller.detach();

			expect(env.runsRepo.findById(runId1)?.state).toBe('exited');

			// Case 2: 人在 awaiting_reply 时手动中止 -> aborted
			const runId2 = 'run-abort-from-reply';
			env.createRun({
				id: runId2,
				taskId: 'task-2',
				state: 'awaiting_reply',
				pid: 6602,
			});

			await service.transitionState({
				runId: runId2,
				targetState: 'aborted',
				reason: 'manual_abort',
			});
			expect(env.runsRepo.findById(runId2)?.state).toBe('aborted');
		});
	});
});
