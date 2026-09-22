import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ACP_EVENT_KINDS,
	EVENT_DEFINITIONS,
	EVENT_KINDS,
	type EventEnvelope,
	PRODUCT_EVENT_KINDS,
	assertNever,
	isEventKind,
	isMilestoneEventKind,
	scopeFromEventKind,
} from '@agent-scheduler/shared/api/events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import {
	GLOBAL_EVENT_SEQUENCE_NAME,
	WATERMARK_BATCH_SIZE,
	createIdAllocator,
} from '../../src/events/id-allocator.ts';
import {
	PAYLOAD_MAX_BYTES,
	RING_BUFFER_CAPACITY,
	createRingBuffer,
	replayEventsSinceOrThrow,
} from '../../src/events/ring-buffer.ts';
import { createEventSeqRepo } from '../../src/repo/event-seq-repo.ts';

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

describe('M2-T4 Event Envelope & Single Mapping Derivation', () => {
	it('derives EVENT_KINDS, ACP and product sets from EVENT_DEFINITIONS mapping table', () => {
		expect(Object.keys(EVENT_DEFINITIONS).length).toBe(EVENT_KINDS.length);
		expect(ACP_EVENT_KINDS.length + PRODUCT_EVENT_KINDS.length).toBe(EVENT_KINDS.length);
		for (const kind of EVENT_KINDS) {
			expect(EVENT_DEFINITIONS[kind]).toBeDefined();
			expect(scopeFromEventKind(kind)).toBe(EVENT_DEFINITIONS[kind].scope);
		}
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
				case 'run.rework_dispatched':
					return 'run_rework_dispatched';
				case 'task.gate_waiting':
					return 'task_gate_waiting';
				case 'task.gate_passed':
					return 'task_gate_passed';
				case 'task.review_verdict':
					return 'task_verdict';
				case 'task.landed':
					return 'task_landed';
				case 'task.sessions_archived':
					return 'task_sessions_archived';
				case 'lane.released':
					return 'lane_released';
				case 'batch.advanced':
					return 'batch_advanced';
				case 'batch.wrapup_started':
					return 'batch_wrapup_started';
				case 'batch.wrapup_finished':
					return 'batch_wrapup_finished';
				case 'agent.availability_changed':
					return 'agent_avail';
				case 'settings.gates_changed':
					return 'settings_gates';
				case 'system.disk_warning':
					return 'sys_disk';
				case 'system.docs_changed':
					return 'sys_docs';
				default:
					return assertNever(event);
			}
		}

		const dummyAllocator = { allocate: () => 1 };
		const dummyClock = { now: () => '2026-09-08T12:00:00.000Z' };
		const factory = createEnvelopeFactory({ clock: dummyClock, idAllocator: dummyAllocator });

		const e1 = factory.createEnvelope({
			kind: 'run.state_changed',
			payload: { from: 'pending', to: 'running' },
		});
		expect(describeKind(e1)).toContain('state:pending->running');
	});

	it('a non-exhaustive event switch fails its compile-time assertion', () => {
		function incompleteSwitch(event: EventEnvelope): string {
			switch (event.kind) {
				case 'agent_message_chunk':
					return 'msg';
				case 'agent_thought_chunk':
					return 'thought';
				// Note: Omits other kinds on purpose
				default:
					// @ts-expect-error - Compile-time assertion: unhandled kind cannot be assigned to never
					return assertNever(event);
			}
		}

		expect(incompleteSwitch).toBeDefined();
	});

	it('the factory owns id, timestamp, scope and per-run sequence values', () => {
		let currentId = 10;
		const dummyAllocator = { allocate: () => currentId++ };
		const dummyClock = { now: () => '2026-09-08T12:34:56.789Z' };
		const factory = createEnvelopeFactory({ clock: dummyClock, idAllocator: dummyAllocator });
		function assertFactoryInputContract(): void {
			factory.createEnvelope({
				kind: 'run.started',
				payload: { runId: 'run-1' },
				// @ts-expect-error - IDs are allocated by the factory.
				id: 99,
			});
			factory.createEnvelope({
				kind: 'run.started',
				payload: { runId: 'run-1' },
				// @ts-expect-error - timestamps come from the injected clock.
				ts: '2026-09-08T00:00:00.000Z',
			});
			factory.createEnvelope({
				kind: 'run.started',
				payload: { runId: 'run-1' },
				// @ts-expect-error - scope is derived from kind.
				scope: 'task',
			});
			factory.createEnvelope({
				kind: 'run.started',
				payload: { runId: 'run-1' },
				// @ts-expect-error - per-run sequence values are generated by the factory.
				seq: 99,
			});
			factory.createEnvelope({
				kind: 'run.exited',
				// @ts-expect-error - run.exited requires exitCode.
				payload: {},
			});
		}
		expect(assertFactoryInputContract).toBeDefined();

		// run-1 sequence starts from 0
		const e1 = factory.createEnvelope({
			kind: 'run.started',
			runId: 'run-1',
			payload: { runId: 'run-1' },
		});
		expect(e1.id).toBe(10);
		expect(e1.ts).toBe('2026-09-08T12:34:56.789Z');
		expect(e1.scope).toBe('run');
		expect(e1.seq).toBe(0);

		const e2 = factory.createEnvelope({
			kind: 'run.state_changed',
			runId: 'run-1',
			payload: { from: 'pending', to: 'running' },
		});
		expect(e2.id).toBe(11);
		expect(e2.seq).toBe(1);

		// run-2 sequence independently starts from 0
		const e3 = factory.createEnvelope({
			kind: 'run.started',
			runId: 'run-2',
			payload: { runId: 'run-2' },
		});
		expect(e3.id).toBe(12);
		expect(e3.seq).toBe(0);

		// run-1 continues from 2
		const e4 = factory.createEnvelope({
			kind: 'run.exited',
			runId: 'run-1',
			payload: { exitCode: 0 },
		});
		expect(e4.seq).toBe(2);

		// event without runId defaults to seq 0
		const eSys = factory.createEnvelope({
			kind: 'system.disk_warning',
			payload: { freeBytes: 1000000 },
		});
		expect(eSys.seq).toBe(0);
		expect(eSys.scope).toBe('system');
	});

	it('classifies milestone event kinds consistently with definitions', () => {
		expect(isMilestoneEventKind('run.state_changed')).toBe(true);
		expect(isMilestoneEventKind('task.landed')).toBe(true);
		expect(isMilestoneEventKind('tool_call')).toBe(true);
		expect(isMilestoneEventKind('agent_message_chunk')).toBe(false);
		expect(isEventKind('run.started')).toBe(true);
		expect(isEventKind('unknown.event')).toBe(false);
		expect(isEventKind('toString')).toBe(false);
		expect(isMilestoneEventKind('run.unknown')).toBe(false);
	});
});

describe('M2-T4 Id Allocator & SQLite Watermark', () => {
	it('EventSeqRepo encapsulates all SQL and persists watermarks', () => {
		const { db } = createTemporaryDatabase();
		const repo = createEventSeqRepo(db);

		expect(repo.getWatermark('test-seq')).toBeNull();
		repo.setWatermark('test-seq', 500);
		expect(repo.getWatermark('test-seq')).toBe(500);
		repo.setWatermark('test-seq', 1000);
		expect(repo.getWatermark('test-seq')).toBe(1000);
	});

	it('E-10 fixes the sequence name and batch size and never reuses IDs after restart', () => {
		const { db, path: dbPath } = createTemporaryDatabase();
		const repo1 = createEventSeqRepo(db);
		const allocator1 = createIdAllocator({ store: repo1 });

		// Initial watermark is 1000
		expect(allocator1.currentWatermark()).toBe(WATERMARK_BATCH_SIZE);
		expect(repo1.getWatermark(GLOBAL_EVENT_SEQUENCE_NAME)).toBe(1000);

		// Allocate 150 IDs
		const ids: number[] = [];
		for (let i = 0; i < 150; i++) {
			ids.push(allocator1.allocate());
		}
		expect(ids[0]).toBe(1);
		expect(ids[149]).toBe(150);

		// Watermark is still 1000
		expect(repo1.getWatermark(GLOBAL_EVENT_SEQUENCE_NAME)).toBe(1000);

		db.close();

		// Simulate restart on same DB
		const db2 = openDatabase(dbPath);
		openDatabases.push(db2);
		const repo2 = createEventSeqRepo(db2);
		const allocator2 = createIdAllocator({ store: repo2 });

		// On restart, watermark immediately advances to 2000 (E-10 jump without rollback)
		expect(allocator2.currentWatermark()).toBe(2000);
		expect(repo2.getWatermark(GLOBAL_EVENT_SEQUENCE_NAME)).toBe(2000);

		const restartId = allocator2.allocate();
		expect(restartId).toBe(1001);
		expect(restartId).toBeGreaterThan(ids[ids.length - 1] as number);

		// Allocate through 2000
		for (let i = 1002; i <= 2000; i++) {
			expect(allocator2.allocate()).toBe(i);
		}
		expect(repo2.getWatermark(GLOBAL_EVENT_SEQUENCE_NAME)).toBe(2000);

		// 2001st allocation writes 3000 to DB (1 write per 1000 in steady state)
		const id2001 = allocator2.allocate();
		expect(id2001).toBe(2001);
		expect(repo2.getWatermark(GLOBAL_EVENT_SEQUENCE_NAME)).toBe(3000);
	});
});

describe('M2-T4 Ring Buffer & Replay Window', () => {
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

	it('E-153 expires replay after the 5001st event displaces the oldest event', () => {
		const ring = createRingBuffer();
		expect(ring.capacity).toBe(RING_BUFFER_CAPACITY);
		expect(RING_BUFFER_CAPACITY).toBe(5000);

		// Push exactly 5000 events: IDs 1..5000
		for (let i = 1; i <= 5000; i++) {
			ring.push(makeEnvelope(i));
		}
		expect(ring.size()).toBe(5000);
		expect(ring.oldest()?.id).toBe(1);
		expect(ring.latest()?.id).toBe(5000);

		// Replay from 0 returns all 5000 events
		const replayAll = ring.getEventsSince(0);
		expect(replayAll.ok).toBe(true);
		if (replayAll.ok) {
			expect(replayAll.events.length).toBe(5000);
			expect(replayAll.events[0]?.id).toBe(1);
			expect(replayAll.events[4999]?.id).toBe(5000);
		}

		// Replay from 5000 returns empty
		const replayDone = ring.getEventsSince(5000);
		expect(replayDone.ok).toBe(true);
		if (replayDone.ok) {
			expect(replayDone.events).toEqual([]);
		}

		// Push 5001st event: overwrites event 1
		ring.push(makeEnvelope(5001));
		expect(ring.size()).toBe(5000);
		expect(ring.oldest()?.id).toBe(2);
		expect(ring.latest()?.id).toBe(5001);

		// Replay from 1: needs 2..5001, all are in buffer
		const replaySince1 = ring.getEventsSince(1);
		expect(replaySince1.ok).toBe(true);
		if (replaySince1.ok) {
			expect(replaySince1.events.length).toBe(5000);
			expect(replaySince1.events[0]?.id).toBe(2);
			expect(replaySince1.events[4999]?.id).toBe(5001);
		}

		// Replay from 0: event 1 was evicted, so replay window is expired! (E-153)
		const replayExpired0 = ring.getEventsSince(0);
		expect(replayExpired0.ok).toBe(false);
		if (!replayExpired0.ok) {
			expect(replayExpired0.code).toBe('E_REPLAY_WINDOW_EXPIRED');
			expect(replayExpired0.minId).toBe(2);
			expect(replayExpired0.requestedLastEventId).toBe(0);
		}

		// Throwing variant throws typed AppError
		expect(() => replayEventsSinceOrThrow(ring, 0)).toThrowError(
			/Replay window expired for Last-Event-ID 0/,
		);
	});

	it('rejects a large payload without a durable reference before changing the buffer', () => {
		const ring = createRingBuffer();

		const largeText = 'A'.repeat(PAYLOAD_MAX_BYTES + 50);
		const largeEnv = makeEnvelope(1, { text: largeText });

		// Attempting without ref: must throw before buffer modification
		expect(() => ring.push(largeEnv)).toThrowError(
			/Large event payload exceeding 32768 bytes requires a valid logstore reference/,
		);
		expect(ring.size()).toBe(0);

		// Attempting with null ref: must throw
		// @ts-expect-error - testing prohibited null ref
		expect(() => ring.push(largeEnv, null)).toThrowError(/ref:null is prohibited/);
		expect(ring.size()).toBe(0);

		// With valid ref: succeeds and truncates
		const validRef = { fileSeq: 0, byteOffset: 1024, byteLen: 33000 };
		const stored = ring.push(largeEnv, validRef);
		expect(ring.size()).toBe(1);
		expect(stored.payload).toEqual({
			truncated: true,
			byteLen: expect.any(Number),
			ref: validRef,
		});

		const invalidTruncated = {
			...makeEnvelope(2),
			payload: { truncated: true, byteLen: PAYLOAD_MAX_BYTES + 1, ref: null },
		} as unknown as EventEnvelope;
		expect(() => ring.push(invalidTruncated)).toThrowError(
			/An already-truncated event payload requires a valid byte length and logstore reference/,
		);
		expect(ring.size()).toBe(1);
	});
});

describe('M2-T4 Event Bus and Subscriber Errors', () => {
	function makeEnvelope(id: number): EventEnvelope {
		return Object.freeze({
			id,
			ts: '2026-09-08T12:00:00.000Z',
			runId: 'run-1',
			taskId: null,
			scope: 'run',
			kind: 'run.started',
			seq: 0,
			actorDeviceId: null,
			payload: { runId: 'run-1' },
		}) as EventEnvelope;
	}

	it('reports subscriber failures while continuing delivery and buffering once', () => {
		const ringBuffer = createRingBuffer();
		const bus = createEventBus({ ringBuffer });

		const goodSubscriber1 = vi.fn();
		const badSubscriber = vi.fn(() => {
			throw new Error('Subscriber failure');
		});
		const goodSubscriber2 = vi.fn();

		bus.subscribe(goodSubscriber1);
		bus.subscribe(badSubscriber);
		bus.subscribe(goodSubscriber2);

		const env = makeEnvelope(1);
		const result = bus.publish(env);

		// All good subscribers are still called
		expect(goodSubscriber1).toHaveBeenCalledTimes(1);
		expect(badSubscriber).toHaveBeenCalledTimes(1);
		expect(goodSubscriber2).toHaveBeenCalledTimes(1);

		// The structured result reports the subscriber failure without recursive publication.
		expect(result.event).toBe(env);
		expect(result.subscriberErrors).toHaveLength(1);
		expect(result.subscriberErrors[0]?.subscriber).toBe(badSubscriber);
		expect(result.subscriberErrors[0]?.error).toBeInstanceOf(Error);

		// Ring buffer received the event exactly once
		expect(ringBuffer.size()).toBe(1);
		expect(ringBuffer.totalPushed()).toBe(1);
	});
});
