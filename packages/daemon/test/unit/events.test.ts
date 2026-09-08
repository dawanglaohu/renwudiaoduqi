import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ACP_EVENT_KINDS,
	EVENT_KINDS,
	type EventEnvelope,
	PRODUCT_EVENT_KINDS,
	assertNever,
	isEventKind,
	isMilestoneEventKind,
	scopeFromEventKind,
} from '@agent-scheduler/shared/events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createEventBus } from '../../src/events/bus.ts';
import {
	createEnvelopeFactory,
	createEventEnvelope,
	isEventEnvelope,
} from '../../src/events/envelope.ts';
import {
	DEFAULT_EVENT_SEQ_NAME,
	WATERMARK_BATCH_SIZE,
	createIdAllocator,
} from '../../src/events/id-allocator.ts';
import {
	PAYLOAD_MAX_BYTES,
	RING_BUFFER_CAPACITY,
	createRingBuffer,
	replayEventsSinceOrThrow,
} from '../../src/events/ring-buffer.ts';

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseConnection[] = [];

afterEach(() => {
	for (const database of openDatabases.splice(0)) {
		if (database.open) database.close();
	}
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function createTemporaryDatabase(): { db: DatabaseConnection; path: string } {
	const dir = mkdtempSync(join(tmpdir(), 'agent-scheduler-events-test-'));
	temporaryDirectories.push(dir);
	const dbPath = join(dir, 'test.db');
	const db = openDatabase(dbPath);
	openDatabases.push(db);

	db.exec(`
		CREATE TABLE event_seq (
			name TEXT PRIMARY KEY,
			watermark INTEGER NOT NULL CHECK (watermark >= 0)
		);
	`);

	return { db, path: dbPath };
}

describe('M2-T4 Event Envelope & Discriminated Union (Acceptance Criterion 4)', () => {
	it('defines all required ACP and product event kinds in EVENT_KINDS', () => {
		expect(ACP_EVENT_KINDS).toEqual([
			'agent_message_chunk',
			'agent_thought_chunk',
			'tool_call',
			'tool_call_update',
			'plan',
			'available_commands_update',
		]);

		expect(PRODUCT_EVENT_KINDS).toContain('run.state_changed');
		expect(PRODUCT_EVENT_KINDS).toContain('run.started');
		expect(PRODUCT_EVENT_KINDS).toContain('run.exited');
		expect(PRODUCT_EVENT_KINDS).toContain('run.aborted');
		expect(PRODUCT_EVENT_KINDS).toContain('task.gate_waiting');
		expect(PRODUCT_EVENT_KINDS).toContain('task.gate_passed');
		expect(PRODUCT_EVENT_KINDS).toContain('task.landed');
		expect(PRODUCT_EVENT_KINDS).toContain('system.disk_warning');
		expect(PRODUCT_EVENT_KINDS).toContain('system.docs_changed');

		expect(EVENT_KINDS.length).toBe(ACP_EVENT_KINDS.length + PRODUCT_EVENT_KINDS.length);
	});

	it('provides exhaustive switch coverage across every kind in EVENT_KINDS with assertNever', () => {
		function describeKind(event: EventEnvelope): string {
			switch (event.kind) {
				case 'agent_message_chunk':
					return `msg:${'chunk' in event.payload ? event.payload.chunk : ''}`;
				case 'agent_thought_chunk':
					return `thought:${'chunk' in event.payload ? event.payload.chunk : ''}`;
				case 'tool_call':
					return `tool:${'tool' in event.payload ? event.payload.tool : ''}`;
				case 'tool_call_update':
					return `tool_up:${'callId' in event.payload ? event.payload.callId : ''}`;
				case 'plan':
					return 'plan';
				case 'available_commands_update':
					return 'cmds';
				case 'run.state_changed':
					return `state:${'from' in event.payload ? event.payload.from : ''}->${'to' in event.payload ? event.payload.to : ''}`;
				case 'run.started':
					return 'run_started';
				case 'run.exited':
					return `exit:${'exitCode' in event.payload ? event.payload.exitCode : ''}`;
				case 'run.aborted':
					return 'run_aborted';
				case 'run.stalled_suspected':
					return 'run_stalled';
				case 'run.stderr_line':
					return 'run_stderr';
				case 'run.permission_blocked':
					return 'run_perm_blocked';
				case 'run.remote_push_detected':
					return 'run_remote_push';
				case 'run.message_delivered':
					return 'run_msg_delivered';
				case 'run.message_undelivered':
					return 'run_msg_undelivered';
				case 'task.gate_waiting':
					return 'task_gate_waiting';
				case 'task.gate_passed':
					return 'task_gate_passed';
				case 'task.review_verdict':
					return 'task_verdict';
				case 'task.landed':
					return 'task_landed';
				case 'batch.advanced':
					return 'batch_advanced';
				case 'agent.availability_changed':
					return 'agent_avail';
				case 'system.disk_warning':
					return 'sys_disk';
				case 'system.docs_changed':
					return 'sys_docs';
				default:
					return assertNever(event);
			}
		}

		for (const kind of EVENT_KINDS) {
			const envelope = createEventEnvelope(
				{
					clock: { now: () => '2026-09-08T12:00:00.000Z' },
					idAllocator: { allocate: () => 1 },
				},
				{
					kind,
					payload: { from: 'pending', to: 'running', chunk: 'hi' },
				},
			);
			const desc = describeKind(envelope);
			expect(typeof desc).toBe('string');
			expect(desc.length).toBeGreaterThan(0);
		}
	});

	it('maps scopes from kinds correctly', () => {
		expect(scopeFromEventKind('agent_message_chunk')).toBe('run');
		expect(scopeFromEventKind('tool_call')).toBe('run');
		expect(scopeFromEventKind('run.started')).toBe('run');
		expect(scopeFromEventKind('run.state_changed')).toBe('run');
		expect(scopeFromEventKind('task.gate_waiting')).toBe('task');
		expect(scopeFromEventKind('task.landed')).toBe('task');
		expect(scopeFromEventKind('batch.advanced')).toBe('batch');
		expect(scopeFromEventKind('agent.availability_changed')).toBe('agent');
		expect(scopeFromEventKind('system.disk_warning')).toBe('system');
		expect(scopeFromEventKind('system.docs_changed')).toBe('system');
	});

	it('creates event envelope with defaults and validates structure', () => {
		const deps = {
			clock: { now: () => '2026-09-08T12:34:56.789Z' },
			idAllocator: { allocate: () => 42 },
		};

		const env = createEventEnvelope(deps, {
			kind: 'run.state_changed',
			payload: { from: 'pending', to: 'running', reason: 'dispatched' },
		});

		expect(env.id).toBe(42);
		expect(env.ts).toBe('2026-09-08T12:34:56.789Z');
		expect(env.scope).toBe('run');
		expect(env.kind).toBe('run.state_changed');
		expect(env.runId).toBeNull();
		expect(env.taskId).toBeNull();
		expect(env.actorDeviceId).toBeNull();
		expect(env.seq).toBe(0);
		expect(isEventEnvelope(env)).toBe(true);

		const factory = createEnvelopeFactory(deps);
		const env2 = factory.createEnvelope({
			kind: 'task.landed',
			runId: 'run-1',
			taskId: 'task-1',
			actorDeviceId: 'dev-1',
			seq: 5,
			payload: { branch: 'task/M2-T4' },
		});
		expect(env2.runId).toBe('run-1');
		expect(env2.taskId).toBe('task-1');
		expect(env2.actorDeviceId).toBe('dev-1');
		expect(env2.seq).toBe(5);
		expect(env2.scope).toBe('task');
	});

	it('classifies milestone event kinds consistently with logstore', () => {
		expect(isMilestoneEventKind('run.state_changed')).toBe(true);
		expect(isMilestoneEventKind('task.landed')).toBe(true);
		expect(isMilestoneEventKind('system.disk_warning')).toBe(true);
		expect(isMilestoneEventKind('tool_call')).toBe(true);
		expect(isMilestoneEventKind('tool_call_update')).toBe(true);
		expect(isMilestoneEventKind('plan')).toBe(true);

		expect(isMilestoneEventKind('agent_message_chunk')).toBe(false);
		expect(isMilestoneEventKind('agent_thought_chunk')).toBe(false);
	});

	it('identifies valid event kinds', () => {
		expect(isEventKind('run.started')).toBe(true);
		expect(isEventKind('agent_message_chunk')).toBe(true);
		expect(isEventKind('unknown.event')).toBe(false);
		expect(isEventKind(123)).toBe(false);
	});
});

describe('M2-T4 Id Allocator & SQLite Watermark (Acceptance Criterion 1 & E-10)', () => {
	it('pre-allocates SQLite watermark and writes every 1000 allocations in steady state', () => {
		const { db } = createTemporaryDatabase();
		const allocator = createIdAllocator({ database: db });

		// Initial watermark is 1000
		expect(allocator.currentWatermark()).toBe(WATERMARK_BATCH_SIZE);
		const row1 = db
			.prepare<[string], { watermark: number }>('SELECT watermark FROM event_seq WHERE name = ?')
			.get(DEFAULT_EVENT_SEQ_NAME);
		expect(row1?.watermark).toBe(1000);

		// Allocate 1000 items: IDs 1..1000
		for (let i = 1; i <= 1000; i++) {
			const id = allocator.allocate();
			expect(id).toBe(i);
		}

		// Watermark in DB is still 1000
		const rowAfter1000 = db
			.prepare<[string], { watermark: number }>('SELECT watermark FROM event_seq WHERE name = ?')
			.get(DEFAULT_EVENT_SEQ_NAME);
		expect(rowAfter1000?.watermark).toBe(1000);

		// 1001st allocation triggers the next watermark batch write (2000)
		const id1001 = allocator.allocate();
		expect(id1001).toBe(1001);

		const rowAfter1001 = db
			.prepare<[string], { watermark: number }>('SELECT watermark FROM event_seq WHERE name = ?')
			.get(DEFAULT_EVENT_SEQ_NAME);
		expect(rowAfter1001?.watermark).toBe(2000);
		expect(allocator.currentWatermark()).toBe(2000);
	});

	it('E-10: on daemon restart, resumes from watermark and jumps without ever rolling back', () => {
		const { db, path: dbPath } = createTemporaryDatabase();

		// Run 1: Start allocator, allocate 150 IDs
		const allocator1 = createIdAllocator({ database: db });
		const run1Ids: number[] = [];
		for (let i = 0; i < 150; i++) {
			run1Ids.push(allocator1.allocate());
		}
		expect(run1Ids[0]).toBe(1);
		expect(run1Ids[run1Ids.length - 1]).toBe(150);

		// DB watermark in Run 1 is 1000
		db.close();

		// Run 2 (Simulating daemon restart after mobile offline):
		const db2 = openDatabase(dbPath);
		openDatabases.push(db2);

		const allocator2 = createIdAllocator({ database: db2 });

		// On restart, DB watermark advances to 2000 immediately to protect the batch
		const rowRun2 = db2
			.prepare<[string], { watermark: number }>('SELECT watermark FROM event_seq WHERE name = ?')
			.get(DEFAULT_EVENT_SEQ_NAME);
		expect(rowRun2?.watermark).toBe(2000);
		expect(allocator2.currentWatermark()).toBe(2000);

		// First ID allocated in Run 2 must be strictly greater than any ID in Run 1
		const run2FirstId = allocator2.allocate();
		expect(run2FirstId).toBe(1001);
		const lastRun1Id = run1Ids[run1Ids.length - 1];
		expect(lastRun1Id !== undefined && run2FirstId > lastRun1Id).toBe(true);

		// Allocate more IDs in Run 2
		for (let i = 1002; i <= 2000; i++) {
			const id = allocator2.allocate();
			expect(id).toBe(i);
		}

		// At 2001, watermark advances to 3000
		const id2001 = allocator2.allocate();
		expect(id2001).toBe(2001);

		const rowRun2Later = db2
			.prepare<[string], { watermark: number }>('SELECT watermark FROM event_seq WHERE name = ?')
			.get(DEFAULT_EVENT_SEQ_NAME);
		expect(rowRun2Later?.watermark).toBe(3000);
	});

	it('supports custom batch sizes', () => {
		const { db } = createTemporaryDatabase();
		const allocator = createIdAllocator({ database: db, batchSize: 5 });

		expect(allocator.currentWatermark()).toBe(5);
		for (let i = 1; i <= 5; i++) {
			expect(allocator.allocate()).toBe(i);
		}
		expect(allocator.allocate()).toBe(6);
		expect(allocator.currentWatermark()).toBe(10);
	});

	it('works with a memory store adapter', () => {
		let watermark: number | null = null;
		const memoryStore = {
			getWatermark: () => watermark,
			saveWatermark: (_name: string, w: number) => {
				watermark = w;
			},
		};

		const allocator = createIdAllocator({ store: memoryStore, batchSize: 10 });
		expect(allocator.allocate()).toBe(1);
		expect(watermark).toBe(10);
	});
});

describe('M2-T4 Ring Buffer & Replay Window (Acceptance Criterion 2 & E-153)', () => {
	function makeEnvelope(id: number, payload: unknown = { ok: true }): EventEnvelope {
		return Object.freeze({
			id,
			ts: '2026-09-08T12:00:00.000Z',
			runId: 'run-1',
			taskId: null,
			scope: 'run',
			kind: 'run.state_changed',
			seq: id,
			actorDeviceId: null,
			payload,
		}) as EventEnvelope;
	}

	it('has fixed default capacity of 5000 and evicts oldest on overflow (FIFO)', () => {
		const ring = createRingBuffer();
		expect(ring.capacity).toBe(RING_BUFFER_CAPACITY);
		expect(ring.size()).toBe(0);

		for (let i = 1; i <= 5000; i++) {
			ring.push(makeEnvelope(i));
		}
		expect(ring.size()).toBe(5000);
		expect(ring.oldest()?.id).toBe(1);
		expect(ring.latest()?.id).toBe(5000);

		// Push 5001st event: overwrites event 1
		ring.push(makeEnvelope(5001));
		expect(ring.size()).toBe(5000);
		expect(ring.oldest()?.id).toBe(2);
		expect(ring.latest()?.id).toBe(5001);
		expect(ring.totalPushed()).toBe(5001);
	});

	it('E-142: truncates payloads > 32 KiB and replaces with reference', () => {
		const ring = createRingBuffer({ capacity: 10 });

		// Small payload stays intact
		const small = makeEnvelope(1, { text: 'small' });
		const storedSmall = ring.push(small);
		expect(storedSmall.payload).toEqual({ text: 'small' });

		// Large payload > 32 KiB
		const largeString = 'X'.repeat(PAYLOAD_MAX_BYTES + 100);
		const large = makeEnvelope(2, { text: largeString });
		const ref = { fileSeq: 1, byteOffset: 4096, byteLen: 33000 };
		const storedLarge = ring.push(large, ref);

		expect(storedLarge.payload).toEqual({
			truncated: true,
			byteLen: expect.any(Number),
			ref,
		});
		expect((storedLarge.payload as { byteLen: number }).byteLen).toBeGreaterThan(PAYLOAD_MAX_BYTES);

		// Already truncated payloads are not double-truncated
		const alreadyTruncated = makeEnvelope(3, {
			truncated: true,
			byteLen: 50000,
			ref: null,
		});
		const storedAlready = ring.push(alreadyTruncated);
		expect(storedAlready.payload).toEqual({
			truncated: true,
			byteLen: 50000,
			ref: null,
		});
	});

	it('E-153: provides replay for within-window Last-Event-ID and reports E_REPLAY_WINDOW_EXPIRED when expired', () => {
		const ring = createRingBuffer({ capacity: 10 });

		// Push 10 events: IDs 1..10
		for (let i = 1; i <= 10; i++) {
			ring.push(makeEnvelope(i));
		}

		// Replay from 0: returns all 1..10
		const replay0 = ring.getEventsSince(0);
		expect(replay0.ok).toBe(true);
		if (replay0.ok) {
			expect(replay0.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		}

		// Replay from 5: returns 6..10
		const replay5 = ring.getEventsSince(5);
		expect(replay5.ok).toBe(true);
		if (replay5.ok) {
			expect(replay5.events.map((e) => e.id)).toEqual([6, 7, 8, 9, 10]);
		}

		// Replay from 10: up to date
		const replay10 = ring.getEventsSince(10);
		expect(replay10.ok).toBe(true);
		if (replay10.ok) {
			expect(replay10.events).toEqual([]);
		}

		// Push 5 more events: now buffer holds 6..15 (events 1..5 evicted)
		for (let i = 11; i <= 15; i++) {
			ring.push(makeEnvelope(i));
		}
		expect(ring.oldest()?.id).toBe(6);
		expect(ring.latest()?.id).toBe(15);

		// Client at ID 5 (oldest - 1): needs 6..15, all are in buffer
		const replay5After = ring.getEventsSince(5);
		expect(replay5After.ok).toBe(true);
		if (replay5After.ok) {
			expect(replay5After.events.map((e) => e.id)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
		}

		// Client at ID 4 (expired, missed event 5)
		const replay4 = ring.getEventsSince(4);
		expect(replay4.ok).toBe(false);
		if (!replay4.ok) {
			expect(replay4.code).toBe('E_REPLAY_WINDOW_EXPIRED');
			expect(replay4.minId).toBe(6);
			expect(replay4.requestedLastEventId).toBe(4);
		}

		// Client at ID 0: expired
		const replayExpired0 = ring.getEventsSince(0);
		expect(replayExpired0.ok).toBe(false);
		if (!replayExpired0.ok) {
			expect(replayExpired0.code).toBe('E_REPLAY_WINDOW_EXPIRED');
		}

		// replayEventsSinceOrThrow throws AppError
		expect(() => replayEventsSinceOrThrow(ring, 2)).toThrowError(
			/Replay window expired for Last-Event-ID 2/,
		);
		expect(() => replayEventsSinceOrThrow(ring, 10)).not.toThrow();
	});
});

describe('M2-T4 Event Bus & Transaction Boundary Guard', () => {
	function makeEnvelope(id: number): EventEnvelope {
		return Object.freeze({
			id,
			ts: '2026-09-08T12:00:00.000Z',
			runId: 'run-test',
			taskId: null,
			scope: 'run',
			kind: 'run.started',
			seq: 0,
			actorDeviceId: null,
			payload: { runId: 'run-test' },
		}) as EventEnvelope;
	}

	it('subscribes, publishes, and unsubscribes listeners', () => {
		const ringBuffer = createRingBuffer();
		const bus = createEventBus({ ringBuffer });

		const received: EventEnvelope[] = [];
		const unsubscribe = bus.subscribe((event) => {
			received.push(event);
		});

		expect(bus.listenerCount()).toBe(1);

		const env1 = makeEnvelope(1);
		bus.publish(env1);

		expect(received).toHaveLength(1);
		expect(received[0]?.id).toBe(1);
		expect(ringBuffer.size()).toBe(1);

		unsubscribe();
		expect(bus.listenerCount()).toBe(0);

		bus.publish(makeEnvelope(2));
		expect(received).toHaveLength(1); // not called after unsubscribe
		expect(ringBuffer.size()).toBe(2);
	});

	it('supports filtered subscriptions', () => {
		const ringBuffer = createRingBuffer();
		const bus = createEventBus({ ringBuffer });

		const filtered: EventEnvelope[] = [];
		bus.subscribeWithFilter(
			(event) => event.id % 2 === 0,
			(event) => filtered.push(event),
		);

		bus.publish(makeEnvelope(1));
		bus.publish(makeEnvelope(2));
		bus.publish(makeEnvelope(3));
		bus.publish(makeEnvelope(4));

		expect(filtered.map((e) => e.id)).toEqual([2, 4]);
	});

	it('safeguards against listener errors so other listeners still execute', () => {
		const ringBuffer = createRingBuffer();
		const bus = createEventBus({ ringBuffer });

		const goodListener = vi.fn();
		const badListener = vi.fn(() => {
			throw new Error('Subscriber error');
		});

		bus.subscribe(badListener);
		bus.subscribe(goodListener);

		expect(() => bus.publish(makeEnvelope(1))).not.toThrow();
		expect(badListener).toHaveBeenCalledTimes(1);
		expect(goodListener).toHaveBeenCalledTimes(1);
	});

	it('rejects bus.publish when inside an active database transaction', () => {
		let inTx = false;
		const ringBuffer = createRingBuffer();
		const bus = createEventBus({
			ringBuffer,
			isInsideTransaction: () => inTx,
		});

		// Outside tx: succeeds
		expect(() => bus.publish(makeEnvelope(1))).not.toThrow();

		// Inside tx: throws E_TX_NESTED
		inTx = true;
		expect(() => bus.publish(makeEnvelope(2))).toThrowError(
			/bus\.publish must not be called inside a database transaction/,
		);
	});
});
