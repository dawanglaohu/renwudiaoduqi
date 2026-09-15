import React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '../../shared/src/api/events.ts';
import {
	FLUSH_INTERVAL_MS,
	type LocalIntent,
	RunStreamBuffer,
	STREAM_BUFFER_MAX,
	attachSseClient,
	clearLocalIntent,
	createEventBus,
	eventBus,
	getLocalIntent,
	localIntents,
	setLocalIntent,
	useRunStreamBuffer,
	useRunStreamSlice,
	useRunStreamVersion,
} from '../src/api/event-bus.ts';
import { createSseClient } from '../src/api/sse-client.ts';

interface MockEnvelopeOptions {
	readonly id?: number;
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly seq?: number;
	readonly kind?: 'run.started' | 'run.exited' | 'run.state_changed' | 'agent_message_chunk';
	readonly payload?: Record<string, unknown>;
}

function createMockEnvelope(overrides: MockEnvelopeOptions = {}): EventEnvelope {
	const kind = overrides.kind ?? 'run.started';
	const id = overrides.id ?? 1;
	const runId = overrides.runId !== undefined ? overrides.runId : 'run-1';
	const taskId = overrides.taskId !== undefined ? overrides.taskId : 'task-1';
	const seq = overrides.seq ?? 0;

	if (kind === 'agent_message_chunk') {
		return {
			id,
			ts: '2026-09-15T08:00:00.000Z',
			runId,
			taskId,
			scope: 'run',
			kind: 'agent_message_chunk',
			seq,
			actorDeviceId: 'dev-001',
			payload: { chunk: 'chunk-data', ...overrides.payload },
		};
	}

	if (kind === 'run.exited') {
		return {
			id,
			ts: '2026-09-15T08:00:00.000Z',
			runId,
			taskId,
			scope: 'run',
			kind: 'run.exited',
			seq,
			actorDeviceId: 'dev-001',
			payload: { exitCode: 0, ...overrides.payload },
		};
	}

	if (kind === 'run.state_changed') {
		return {
			id,
			ts: '2026-09-15T08:00:00.000Z',
			runId,
			taskId,
			scope: 'run',
			kind: 'run.state_changed',
			seq,
			actorDeviceId: 'dev-001',
			payload: { from: 'running', to: 'stopped', ...overrides.payload },
		};
	}

	return {
		id,
		ts: '2026-09-15T08:00:00.000Z',
		runId,
		taskId,
		scope: 'run',
		kind: 'run.started',
		seq,
		actorDeviceId: 'dev-001',
		payload: { runId: runId ?? 'run-1', ...overrides.payload },
	};
}

describe('M9-T6 Event Buffer and Frame-Rate Rendering (event-bus.ts)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		localIntents.clear();
		eventBus.destroy();
	});

	afterEach(() => {
		vi.useRealTimers();
		localIntents.clear();
		eventBus.destroy();
	});

	describe('AC 4 & E-142, E-143: RunStreamBuffer Ring Buffer', () => {
		it('exports STREAM_BUFFER_MAX=600 and FLUSH_INTERVAL_MS=80', () => {
			expect(STREAM_BUFFER_MAX).toBe(600);
			expect(FLUSH_INTERVAL_MS).toBe(80);
		});

		it('enforces positive integer capacity and starts empty with version 0', () => {
			const buf = new RunStreamBuffer('run-test', 10);
			expect(buf.runId).toBe('run-test');
			expect(buf.capacity).toBe(10);
			expect(buf.length).toBe(0);
			expect(buf.version).toBe(0);
			expect(buf.isDirty).toBe(false);
			expect(buf.droppedCount).toBe(0);
			expect(buf.lastEventId).toBeNull();
			expect(buf.getItems()).toEqual([]);
			expect(buf.first()).toBeUndefined();
			expect(buf.last()).toBeUndefined();

			expect(() => new RunStreamBuffer('invalid', 0)).toThrow();
			expect(() => new RunStreamBuffer('invalid', -5)).toThrow();
		});

		it('pushes items in FIFO order and marks buffer dirty', () => {
			const buf = new RunStreamBuffer('run-1', 5);
			const e1 = createMockEnvelope({ id: 101, seq: 1 });
			const e2 = createMockEnvelope({ id: 102, seq: 2 });

			buf.push(e1);
			expect(buf.length).toBe(1);
			expect(buf.isDirty).toBe(true);
			expect(buf.lastEventId).toBe(101);
			expect(buf.first()?.id).toBe(101);
			expect(buf.last()?.id).toBe(101);

			buf.push(e2);
			expect(buf.length).toBe(2);
			expect(buf.lastEventId).toBe(102);
			expect(buf.getItems()).toEqual([e1, e2]);
			expect(buf.first()?.id).toBe(101);
			expect(buf.last()?.id).toBe(102);
		});

		it('evicts oldest elements from head when capacity is exceeded in O(1) without memory growth (AC 4, E-142, E-143)', () => {
			const capacity = 3;
			const buf = new RunStreamBuffer('run-overflow', capacity);

			const e1 = createMockEnvelope({ id: 1 });
			const e2 = createMockEnvelope({ id: 2 });
			const e3 = createMockEnvelope({ id: 3 });
			const e4 = createMockEnvelope({ id: 4 });
			const e5 = createMockEnvelope({ id: 5 });

			buf.push(e1);
			buf.push(e2);
			buf.push(e3);
			expect(buf.length).toBe(3);
			expect(buf.droppedCount).toBe(0);
			expect(buf.getItems().map((e) => e.id)).toEqual([1, 2, 3]);

			// 4th event: exceeds capacity 3, e1 should be dropped from head
			buf.push(e4);
			expect(buf.length).toBe(3);
			expect(buf.droppedCount).toBe(1);
			expect(buf.getItems().map((e) => e.id)).toEqual([2, 3, 4]);
			expect(buf.first()?.id).toBe(2);
			expect(buf.last()?.id).toBe(4);

			// 5th event: e2 dropped
			buf.push(e5);
			expect(buf.length).toBe(3);
			expect(buf.droppedCount).toBe(2);
			expect(buf.getItems().map((e) => e.id)).toEqual([3, 4, 5]);
			expect(buf.first()?.id).toBe(3);
			expect(buf.last()?.id).toBe(5);
		});

		it('supports default capacity of STREAM_BUFFER_MAX=600 and drops head on 601st element', () => {
			const buf = new RunStreamBuffer('run-600');
			expect(buf.capacity).toBe(600);

			for (let i = 1; i <= 600; i++) {
				buf.push(createMockEnvelope({ id: i }));
			}
			expect(buf.length).toBe(600);
			expect(buf.droppedCount).toBe(0);
			expect(buf.first()?.id).toBe(1);
			expect(buf.last()?.id).toBe(600);

			// Push 601st element
			buf.push(createMockEnvelope({ id: 601 }));
			expect(buf.length).toBe(600);
			expect(buf.droppedCount).toBe(1);
			expect(buf.first()?.id).toBe(2);
			expect(buf.last()?.id).toBe(601);
		});

		it('provides safe indexing via at() and slicing via getSlice()', () => {
			const buf = new RunStreamBuffer('run-slice', 4);
			for (let i = 1; i <= 6; i++) {
				buf.push(createMockEnvelope({ id: i }));
			}
			// Buffer holds [3, 4, 5, 6]
			expect(buf.at(0)?.id).toBe(3);
			expect(buf.at(1)?.id).toBe(4);
			expect(buf.at(2)?.id).toBe(5);
			expect(buf.at(3)?.id).toBe(6);
			expect(buf.at(-1)?.id).toBe(6);
			expect(buf.at(-2)?.id).toBe(5);
			expect(buf.at(10)).toBeUndefined();
			expect(buf.at(-10)).toBeUndefined();

			// Slices
			expect(buf.getSlice().map((e) => e.id)).toEqual([3, 4, 5, 6]);
			expect(buf.getSlice(1, 3).map((e) => e.id)).toEqual([4, 5]);
			expect(buf.getSlice(-2).map((e) => e.id)).toEqual([5, 6]);
			expect(buf.getSlice(2, 1)).toEqual([]);
		});

		it('clears buffer cleanly and marks dirty', () => {
			const buf = new RunStreamBuffer('run-clear', 5);
			buf.push(createMockEnvelope({ id: 1 }));
			buf.commitFlush();
			expect(buf.version).toBe(1);
			expect(buf.isDirty).toBe(false);

			buf.clear();
			expect(buf.length).toBe(0);
			expect(buf.isDirty).toBe(true);
			expect(buf.getItems()).toEqual([]);
		});

		it('commitFlush bumps version by exactly 1 only when dirty', () => {
			const buf = new RunStreamBuffer('run-commit', 5);
			expect(buf.commitFlush()).toBe(false);
			expect(buf.version).toBe(0);

			buf.push(createMockEnvelope({ id: 1 }));
			expect(buf.isDirty).toBe(true);
			expect(buf.commitFlush()).toBe(true);
			expect(buf.version).toBe(1);
			expect(buf.isDirty).toBe(false);

			// Second commitFlush without new push returns false
			expect(buf.commitFlush()).toBe(false);
			expect(buf.version).toBe(1);
		});
	});

	describe('AC 1 & AC 2: Event Ingestion, No React setState, and Throttled Flush (E-144)', () => {
		it('pushing an event buffers it into the run without triggering React setState (AC 1)', () => {
			const bus = createEventBus();
			const event = createMockEnvelope({ runId: 'run-alpha', id: 201 });

			bus.push(event);

			// Immediately after push: buffer exists, has the item, but version is still 0 (not flushed)
			const buffer = bus.getBuffer('run-alpha');
			expect(buffer).toBeDefined();
			expect(buffer?.length).toBe(1);
			expect(buffer?.isDirty).toBe(true);
			expect(bus.versionOf('run-alpha')).toBe(0);
			expect(bus.isFlushPending()).toBe(true);
		});

		it('multiple events in a burst bump version by EXACTLY 1 per flush (AC 2, E-144)', () => {
			const bus = createEventBus();
			const listener = vi.fn();
			bus.subscribe('run-burst', listener);

			// Ingest 100 events in rapid succession (simulating an event surge)
			for (let i = 1; i <= 100; i++) {
				bus.push(
					createMockEnvelope({
						runId: 'run-burst',
						id: i,
						kind: 'agent_message_chunk',
						payload: { chunk: `chunk-${i}` },
					}),
				);
			}

			// Before flush, listener not called, version still 0
			expect(listener).toHaveBeenCalledTimes(0);
			expect(bus.versionOf('run-burst')).toBe(0);

			// Fast-forward fake timers past the flush window (FLUSH_INTERVAL_MS + rAF)
			vi.advanceTimersByTime(FLUSH_INTERVAL_MS + 20);

			// Exactly ONE version bump and ONE notification
			expect(bus.versionOf('run-burst')).toBe(1);
			expect(listener).toHaveBeenCalledTimes(1);

			// All 100 events are in the buffer
			expect(bus.getBuffer('run-burst')?.length).toBe(100);
		});

		it('enforces minimum interval of 80ms between flushes (AC 2, E-144)', () => {
			const bus = createEventBus();
			const listener = vi.fn();
			bus.subscribe('run-interval', listener);

			// First event at t=0
			bus.push(createMockEnvelope({ runId: 'run-interval', id: 1 }));
			// Advance time for first flush (say 16ms for rAF)
			vi.advanceTimersByTime(20);
			expect(bus.versionOf('run-interval')).toBe(1);
			expect(listener).toHaveBeenCalledTimes(1);

			// Second event at t=25ms (elapsed = 5ms < 80ms)
			bus.push(createMockEnvelope({ runId: 'run-interval', id: 2 }));

			// Advance by 30ms (total time ~55ms, elapsed ~35ms < 80ms) -> flush must NOT have occurred
			vi.advanceTimersByTime(30);
			expect(bus.versionOf('run-interval')).toBe(1);
			expect(listener).toHaveBeenCalledTimes(1);

			// Advance past the 80ms throttle window + rAF frame
			vi.advanceTimersByTime(70);
			expect(bus.versionOf('run-interval')).toBe(2);
			expect(listener).toHaveBeenCalledTimes(2);
		});

		it('only dirty streams bump version and notify subscribers (AC 2)', () => {
			const bus = createEventBus();
			const listenerA = vi.fn();
			const listenerB = vi.fn();

			bus.subscribe('run-A', listenerA);
			bus.subscribe('run-B', listenerB);

			// Only push events for run-A
			bus.push(createMockEnvelope({ runId: 'run-A', id: 1 }));
			bus.push(createMockEnvelope({ runId: 'run-A', id: 2 }));

			vi.advanceTimersByTime(FLUSH_INTERVAL_MS + 20);

			expect(bus.versionOf('run-A')).toBe(1);
			expect(listenerA).toHaveBeenCalledTimes(1);

			expect(bus.versionOf('run-B')).toBe(0);
			expect(listenerB).toHaveBeenCalledTimes(0);
		});

		it('manual flush() commits pending flushes immediately', () => {
			const bus = createEventBus();
			const listener = vi.fn();
			bus.subscribe('run-manual', listener);

			bus.push(createMockEnvelope({ runId: 'run-manual', id: 1 }));
			expect(bus.versionOf('run-manual')).toBe(0);
			expect(listener).toHaveBeenCalledTimes(0);

			bus.flush();
			expect(bus.versionOf('run-manual')).toBe(1);
			expect(listener).toHaveBeenCalledTimes(1);
			expect(bus.isFlushPending()).toBe(false);
		});

		it('handles subscriber errors gracefully without breaking other subscribers', () => {
			const bus = createEventBus();
			const badListener = vi.fn(() => {
				throw new Error('Explosion in subscriber');
			});
			const goodListener = vi.fn();

			bus.subscribe('run-err', badListener);
			bus.subscribe('run-err', goodListener);

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			bus.push(createMockEnvelope({ runId: 'run-err', id: 1 }));
			bus.flush();

			expect(badListener).toHaveBeenCalledTimes(1);
			expect(goodListener).toHaveBeenCalledTimes(1);
			expect(bus.versionOf('run-err')).toBe(1);

			consoleSpy.mockRestore();
		});
	});

	describe('AC 3: getSnapshot and useSyncExternalStore Contract', () => {
		it('getSnapshot strictly returns an integer version number and NEVER an array or object (AC 3)', () => {
			const bus = createEventBus();

			// For a non-existent run: returns 0
			const snap0 = bus.getSnapshot('run-nonexistent');
			expect(typeof snap0).toBe('number');
			expect(snap0).toBe(0);

			// After events and flush: returns integer version
			bus.push(createMockEnvelope({ runId: 'run-snap', id: 10 }));
			bus.flush();

			const snap1 = bus.getSnapshot('run-snap');
			expect(typeof snap1).toBe('number');
			expect(snap1).toBe(1);
			expect(Number.isInteger(snap1)).toBe(true);

			// Second flush
			bus.push(createMockEnvelope({ runId: 'run-snap', id: 11 }));
			bus.flush();
			const snap2 = bus.getSnapshot('run-snap');
			expect(snap2).toBe(2);

			// createSnapshotGetter returns a function returning the number
			const getter = bus.createSnapshotGetter('run-snap');
			expect(typeof getter()).toBe('number');
			expect(getter()).toBe(2);
		});

		it('subscribe supports both 2-argument form and 1-argument curried form for useSyncExternalStore', () => {
			const bus = createEventBus();
			const listener = vi.fn();

			// 2-argument form
			const unsub1 = bus.subscribe('run-1', listener);
			expect(typeof unsub1).toBe('function');
			unsub1();

			// 1-argument curried form (direct pass to useSyncExternalStore)
			const curriedSubscribe = bus.subscribe('run-2');
			expect(typeof curriedSubscribe).toBe('function');

			const unsub2 = curriedSubscribe(listener);
			expect(typeof unsub2).toBe('function');

			bus.push(createMockEnvelope({ runId: 'run-2', id: 1 }));
			bus.flush();
			expect(listener).toHaveBeenCalledTimes(1);

			unsub2();
			bus.push(createMockEnvelope({ runId: 'run-2', id: 2 }));
			bus.flush();
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it('React hooks useRunStreamVersion, useRunStreamBuffer, and useRunStreamSlice render properly', () => {
			const bus = createEventBus();
			bus.push(createMockEnvelope({ runId: 'run-react', id: 101 }));
			bus.push(createMockEnvelope({ runId: 'run-react', id: 102 }));
			bus.flush();

			function VersionComponent() {
				const version = useRunStreamVersion('run-react', bus);
				return React.createElement('div', { 'data-version': version }, `Version: ${version}`);
			}

			function BufferComponent() {
				const { version, items } = useRunStreamBuffer('run-react', bus);
				return React.createElement(
					'div',
					{ 'data-count': items.length, 'data-version': version },
					items.map((it) => it.id).join(','),
				);
			}

			function SliceComponent() {
				const { items } = useRunStreamSlice('run-react', 0, 1, bus);
				return React.createElement('div', { 'data-slice-count': items.length }, items[0]?.id ?? '');
			}

			const htmlVersion = renderToString(React.createElement(VersionComponent));
			expect(htmlVersion).toContain('Version: 1');

			const htmlBuffer = renderToString(React.createElement(BufferComponent));
			expect(htmlBuffer).toContain('101,102');

			const htmlSlice = renderToString(React.createElement(SliceComponent));
			expect(htmlSlice).toContain('101');
		});
	});

	describe('Milestone, Task, and Global Event Routing', () => {
		it('dispatches milestone events immediately to subscribeMilestone listeners', () => {
			const bus = createEventBus();
			const milestoneListener = vi.fn();
			const unsub = bus.subscribeMilestone(milestoneListener);

			// Milestone event: run.started
			const milestoneEvent = createMockEnvelope({
				kind: 'run.started',
				runId: 'run-m',
			});
			bus.push(milestoneEvent);
			expect(milestoneListener).toHaveBeenCalledWith(milestoneEvent);

			// Non-milestone event: agent_message_chunk
			const chunkEvent = createMockEnvelope({
				kind: 'agent_message_chunk',
				runId: 'run-m',
			});
			bus.push(chunkEvent);
			expect(milestoneListener).toHaveBeenCalledTimes(1);

			unsub();
			bus.push(createMockEnvelope({ kind: 'run.exited', runId: 'run-m' }));
			expect(milestoneListener).toHaveBeenCalledTimes(1);
		});

		it('dispatches task-scoped and all-scoped events', () => {
			const bus = createEventBus();
			const taskListener = vi.fn();
			const allListener = vi.fn();

			bus.subscribeTask('task-42', taskListener);
			bus.subscribeAll(allListener);

			const event = createMockEnvelope({
				taskId: 'task-42',
				runId: 'run-x',
				id: 99,
			});
			bus.push(event);

			expect(taskListener).toHaveBeenCalledWith(event);
			expect(allListener).toHaveBeenCalledWith(event);
		});
	});

	describe('Optimistic Stop Presentation (localIntents Map)', () => {
		it('allows setting, reading, and clearing local-intent in mutable map', () => {
			const intent: LocalIntent = {
				runId: 'run-stop-1',
				kind: 'stopping',
				atStep: 3,
				timestamp: Date.now(),
			};

			setLocalIntent(intent);
			expect(getLocalIntent('run-stop-1')).toEqual(intent);
			expect(localIntents.has('run-stop-1')).toBe(true);

			clearLocalIntent('run-stop-1');
			expect(getLocalIntent('run-stop-1')).toBeUndefined();
		});

		it('automatically clears local-intent when terminal server event arrives (07-前端架构)', () => {
			const bus = createEventBus();
			setLocalIntent({ runId: 'run-stop-2', kind: 'stopping' });
			expect(localIntents.has('run-stop-2')).toBe(true);

			// Non-terminal chunk does not clear intent
			bus.push(
				createMockEnvelope({
					runId: 'run-stop-2',
					kind: 'agent_message_chunk',
				}),
			);
			expect(localIntents.has('run-stop-2')).toBe(true);

			// run.state_changed clears intent
			bus.push(
				createMockEnvelope({
					runId: 'run-stop-2',
					kind: 'run.state_changed',
					payload: { from: 'running', to: 'stopped' },
				}),
			);
			expect(localIntents.has('run-stop-2')).toBe(false);
		});
	});

	describe('attachSseClient & Buffer Reset (E-153)', () => {
		it('delivers real SSE frames into the ring, then empties it on the replay-window signal', async () => {
			vi.useRealTimers();
			const bus = createEventBus();
			const received: EventEnvelope[] = [];
			bus.subscribeAll((event) => received.push(event));

			const encoder = new TextEncoder();
			const streamOf = (chunk: string) =>
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(chunk));
						controller.close();
					},
				});
			const replayExpired =
				'event: error\ndata: {"error":{"code":"E_REPLAY_WINDOW_EXPIRED","message":"Replay expired"}}\n\n';
			const firstEvent = createMockEnvelope({ runId: 'run-1', id: 7 });
			let attempt = 0;
			const mockFetch: typeof fetch = async () => {
				attempt += 1;
				const body =
					attempt === 1
						? `id: 7\nevent: run.started\ndata: ${JSON.stringify(firstEvent)}\n\n`
						: replayExpired;
				return new Response(streamOf(body), {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' },
				});
			};

			const sse = createSseClient({
				getBaseUrl: () => 'http://localhost:7817',
				fetchFn: mockFetch,
				fetchSnapshot: async () => null,
				backoffDelays: [10],
				randomJitter: () => 0.5,
			});
			const detach = attachSseClient(sse, bus);
			sse.connect();

			const started = Date.now();
			while (
				Date.now() - started < 2000 &&
				!(received.length > 0 && bus.getBuffer('run-1')?.length === 0)
			) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			sse.disconnect();
			detach();

			expect(received.map((event) => event.id)).toContain(7);
			expect(bus.getBuffer('run-1')?.length).toBe(0);
			expect(bus.versionOf('run-1')).toBeGreaterThan(0);
		});

		it('clearRun empties run buffer and schedules flush', () => {
			const bus = createEventBus();
			const listener = vi.fn();
			bus.subscribe('run-to-clear', listener);

			bus.push(createMockEnvelope({ runId: 'run-to-clear', id: 1 }));
			bus.flush();
			expect(bus.versionOf('run-to-clear')).toBe(1);

			bus.clearRun('run-to-clear');
			expect(bus.getBuffer('run-to-clear')?.length).toBe(0);

			bus.flush();
			expect(bus.versionOf('run-to-clear')).toBe(2);
			expect(listener).toHaveBeenCalledTimes(2);
		});

		it('deleteRun removes buffer and notifies subscribers', () => {
			const bus = createEventBus();
			const listener = vi.fn();
			bus.subscribe('run-del', listener);

			bus.push(createMockEnvelope({ runId: 'run-del', id: 1 }));
			bus.flush();
			expect(bus.getBuffer('run-del')).toBeDefined();

			bus.deleteRun('run-del');
			expect(bus.getBuffer('run-del')).toBeUndefined();
			expect(bus.versionOf('run-del')).toBe(0);
			expect(listener).toHaveBeenCalledTimes(2);
		});
	});
});
