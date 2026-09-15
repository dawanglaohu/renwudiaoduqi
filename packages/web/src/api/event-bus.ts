import { useCallback, useSyncExternalStore } from 'react';
import type { EventEnvelope } from '../../../shared/src/api/events.ts';
import { isMilestoneEventKind } from '../../../shared/src/api/events.ts';
import { type SseClient, sseClient } from './sse-client.ts';

/**
 * Maximum capacity of fixed-length ring buffer per run stream (AC 4, E-142, E-143).
 * When capacity is exceeded, oldest events at the head are discarded.
 */
export const STREAM_BUFFER_MAX = 600;

/**
 * Minimum throttle interval for rAF flush batching (AC 2, E-144).
 * Sits in the 50–100ms throttle corridor.
 */
export const FLUSH_INTERVAL_MS = 80;

/**
 * Local intent for optimistic stop presentation (07-前端架构).
 * Stored in mutable Map beside event-bus, cleared as soon as server event arrives.
 */
export interface LocalIntent {
	readonly runId: string;
	readonly kind: 'stopping';
	readonly atStep?: number;
	readonly timestamp?: number;
}

/**
 * Mutable non-reactive map storing in-flight optimistic user intents.
 */
export const localIntents = new Map<string, LocalIntent>();

export function setLocalIntent(intent: LocalIntent): void {
	localIntents.set(intent.runId, intent);
}

export function getLocalIntent(runId: string): LocalIntent | undefined {
	return localIntents.get(runId);
}

export function clearLocalIntent(runId: string): void {
	localIntents.delete(runId);
}

/**
 * Fixed-capacity circular ring buffer for a single run stream (AC 1, AC 4, E-142, E-143).
 * Exceeding capacity drops elements from head in O(1) time without array reallocation.
 */
export class RunStreamBuffer {
	readonly runId: string;
	readonly capacity: number;
	private buffer: (EventEnvelope | undefined)[];
	private head = 0;
	private count = 0;
	private _version = 0;
	private _isDirty = false;
	private _droppedCount = 0;
	private _lastEventId: number | null = null;

	constructor(runId: string, capacity: number = STREAM_BUFFER_MAX) {
		if (capacity <= 0 || !Number.isSafeInteger(capacity)) {
			throw new Error(`RunStreamBuffer capacity must be a positive integer, got ${capacity}`);
		}
		this.runId = runId;
		this.capacity = capacity;
		this.buffer = new Array<EventEnvelope | undefined>(capacity);
	}

	get length(): number {
		return this.count;
	}

	get version(): number {
		return this._version;
	}

	get isDirty(): boolean {
		return this._isDirty;
	}

	get droppedCount(): number {
		return this._droppedCount;
	}

	get lastEventId(): number | null {
		return this._lastEventId;
	}

	/**
	 * Pushes an event into the ring buffer (AC 1, AC 4).
	 * If full, overwrites the oldest element at head and increments droppedCount.
	 * Marks the buffer dirty without triggering React setState.
	 */
	push(event: EventEnvelope): void {
		if (this.count < this.capacity) {
			const slot = (this.head + this.count) % this.capacity;
			this.buffer[slot] = event;
			this.count += 1;
		} else {
			this.buffer[this.head] = event;
			this.head = (this.head + 1) % this.capacity;
			this._droppedCount += 1;
		}
		this._isDirty = true;
		if (typeof event.id === 'number') {
			this._lastEventId = event.id;
		}
	}

	/**
	 * Commits flush for this buffer (AC 2):
	 * if dirty, bumps version by exactly 1 and clears dirty flag.
	 */
	commitFlush(): boolean {
		if (!this._isDirty) {
			return false;
		}
		this._version += 1;
		this._isDirty = false;
		return true;
	}

	markDirty(): void {
		this._isDirty = true;
	}

	/**
	 * Returns items in chronological order (oldest to newest).
	 */
	getItems(): readonly EventEnvelope[] {
		const items: EventEnvelope[] = [];
		for (let i = 0; i < this.count; i++) {
			const item = this.buffer[(this.head + i) % this.capacity];
			if (item !== undefined) {
				items.push(item);
			}
		}
		return items;
	}

	/**
	 * Returns a chronological slice of items (oldest to newest).
	 */
	getSlice(start = 0, end = this.count): readonly EventEnvelope[] {
		const s = start < 0 ? Math.max(0, this.count + start) : Math.min(start, this.count);
		const e = end < 0 ? Math.max(0, this.count + end) : Math.min(end, this.count);
		if (s >= e) {
			return [];
		}
		const slice: EventEnvelope[] = [];
		for (let i = s; i < e; i++) {
			const item = this.buffer[(this.head + i) % this.capacity];
			if (item !== undefined) {
				slice.push(item);
			}
		}
		return slice;
	}

	/**
	 * Returns element at logical index (0 is oldest, -1 is newest).
	 */
	at(index: number): EventEnvelope | undefined {
		let idx = index;
		if (idx < 0) {
			idx = this.count + idx;
		}
		if (idx < 0 || idx >= this.count) {
			return undefined;
		}
		return this.buffer[(this.head + idx) % this.capacity];
	}

	first(): EventEnvelope | undefined {
		if (this.count === 0) {
			return undefined;
		}
		return this.buffer[this.head];
	}

	last(): EventEnvelope | undefined {
		if (this.count === 0) {
			return undefined;
		}
		return this.buffer[(this.head + this.count - 1) % this.capacity];
	}

	/**
	 * Clears buffer elements and marks dirty for the next flush.
	 */
	clear(): void {
		this.buffer = new Array<EventEnvelope | undefined>(this.capacity);
		this.head = 0;
		this.count = 0;
		this._isDirty = true;
	}

	/**
	 * Resets version and dirty state (used in tests or session reset).
	 */
	resetVersion(version = 0): void {
		this._version = version;
		this._isDirty = false;
	}
}

export type EventBusListener = () => void;
export type EnvelopeListener = (event: EventEnvelope) => void;
export type FlushListener = (flushedRunIds: readonly string[]) => void;

export interface EventBusOptions {
	readonly bufferMax?: number;
	readonly flushIntervalMs?: number;
	readonly scheduleRaf?: (callback: (time: number) => void) => number;
	readonly cancelRaf?: (id: number) => void;
	readonly now?: () => number;
}

const defaultScheduleRaf = (cb: (time: number) => void): number => {
	if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
		return window.requestAnimationFrame(cb);
	}
	if (typeof requestAnimationFrame === 'function') {
		return requestAnimationFrame(cb);
	}
	return setTimeout(() => cb(Date.now()), 16) as unknown as number;
};

const defaultCancelRaf = (id: number): void => {
	if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
		window.cancelAnimationFrame(id);
		return;
	}
	if (typeof cancelAnimationFrame === 'function') {
		cancelAnimationFrame(id);
		return;
	}
	clearTimeout(id);
};

const defaultNow = (): number => Date.now();

export interface EventBus {
	readonly bufferMax: number;
	readonly flushIntervalMs: number;

	push(event: EventEnvelope): void;
	getBuffer(runId: string): RunStreamBuffer | undefined;
	getOrCreateBuffer(runId: string): RunStreamBuffer;
	versionOf(runId: string): number;
	getSnapshot(runId: string): number;
	createSnapshotGetter(runId: string): () => number;

	subscribe(runId: string): (listener: EventBusListener) => () => void;
	subscribe(runId: string, listener: EventBusListener): () => void;

	subscribeMilestone(listener: EnvelopeListener): () => void;
	subscribeAll(listener: EnvelopeListener): () => void;
	subscribeTask(taskId: string, listener: EnvelopeListener): () => void;
	onFlush(listener: FlushListener): () => void;

	flush(): void;
	clearRun(runId: string): void;
	clearAll(): void;
	deleteRun(runId: string): void;
	isFlushPending(): boolean;
	getLastFlushTime(): number;
	destroy(): void;
}

class EventBusImpl implements EventBus {
	readonly bufferMax: number;
	readonly flushIntervalMs: number;

	private readonly scheduleRafFn: (callback: (time: number) => void) => number;
	private readonly cancelRafFn: (id: number) => void;
	private readonly nowFn: () => number;

	private readonly buffers = new Map<string, RunStreamBuffer>();
	private readonly dirtyRunIds = new Set<string>();
	private readonly runSubscribers = new Map<string, Set<EventBusListener>>();
	private readonly milestoneSubscribers = new Set<EnvelopeListener>();
	private readonly allSubscribers = new Set<EnvelopeListener>();
	private readonly taskSubscribers = new Map<string, Set<EnvelopeListener>>();
	private readonly flushListeners = new Set<FlushListener>();

	private lastFlushTimestamp = 0;
	private flushPending = false;
	private timerId: ReturnType<typeof setTimeout> | null = null;
	private rafId: number | null = null;

	constructor(options: EventBusOptions = {}) {
		this.bufferMax = options.bufferMax ?? STREAM_BUFFER_MAX;
		this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
		this.scheduleRafFn = options.scheduleRaf ?? defaultScheduleRaf;
		this.cancelRafFn = options.cancelRaf ?? defaultCancelRaf;
		this.nowFn = options.now ?? defaultNow;
	}

	getBuffer(runId: string): RunStreamBuffer | undefined {
		return this.buffers.get(runId);
	}

	getOrCreateBuffer(runId: string): RunStreamBuffer {
		let buffer = this.buffers.get(runId);
		if (!buffer) {
			buffer = new RunStreamBuffer(runId, this.bufferMax);
			this.buffers.set(runId, buffer);
		}
		return buffer;
	}

	/**
	 * Returns current integer version for runId (AC 3).
	 * If no buffer exists yet, returns 0.
	 */
	versionOf(runId: string): number {
		return this.buffers.get(runId)?.version ?? 0;
	}

	/**
	 * Snapshot getter for useSyncExternalStore (AC 3).
	 * Strictly returns ONLY a primitive integer version number, never an array or object.
	 */
	getSnapshot(runId: string): number {
		return this.versionOf(runId);
	}

	createSnapshotGetter(runId: string): () => number {
		return () => this.versionOf(runId);
	}

	/**
	 * Subscribes to stream version updates for runId (AC 1, AC 2).
	 * Supports both 2-argument form `subscribe(runId, listener)` and
	 * 1-argument curried form `useSyncExternalStore(eventBus.subscribe(runId), ...)`
	 */
	subscribe(runId: string): (listener: EventBusListener) => () => void;
	subscribe(runId: string, listener: EventBusListener): () => void;
	subscribe(
		runId: string,
		listener?: EventBusListener,
	): (() => void) | ((listener: EventBusListener) => () => void) {
		if (listener !== undefined) {
			return this.addRunSubscriber(runId, listener);
		}
		return (cb: EventBusListener) => this.addRunSubscriber(runId, cb);
	}

	private addRunSubscriber(runId: string, listener: EventBusListener): () => void {
		let listeners = this.runSubscribers.get(runId);
		if (!listeners) {
			listeners = new Set();
			this.runSubscribers.set(runId, listeners);
		}
		listeners.add(listener);

		return () => {
			const set = this.runSubscribers.get(runId);
			if (set) {
				set.delete(listener);
				if (set.size === 0) {
					this.runSubscribers.delete(runId);
				}
			}
		};
	}

	subscribeMilestone(listener: EnvelopeListener): () => void {
		this.milestoneSubscribers.add(listener);
		return () => {
			this.milestoneSubscribers.delete(listener);
		};
	}

	subscribeAll(listener: EnvelopeListener): () => void {
		this.allSubscribers.add(listener);
		return () => {
			this.allSubscribers.delete(listener);
		};
	}

	subscribeTask(taskId: string, listener: EnvelopeListener): () => void {
		let listeners = this.taskSubscribers.get(taskId);
		if (!listeners) {
			listeners = new Set();
			this.taskSubscribers.set(taskId, listeners);
		}
		listeners.add(listener);

		return () => {
			const set = this.taskSubscribers.get(taskId);
			if (set) {
				set.delete(listener);
				if (set.size === 0) {
					this.taskSubscribers.delete(taskId);
				}
			}
		};
	}

	onFlush(listener: FlushListener): () => void {
		this.flushListeners.add(listener);
		return () => {
			this.flushListeners.delete(listener);
		};
	}

	/**
	 * Ingests incoming SSE event (AC 1):
	 * does ONLY "push into ring buffer + mark dirty", absolutely NO React setState or zustand.
	 * Schedules throttled rAF flush.
	 */
	push(event: EventEnvelope): void {
		const rawRunId = typeof event.runId === 'string' ? event.runId.trim() : null;
		if (rawRunId && rawRunId.length > 0) {
			// Optimistic stop clear: server event confirmation clears local intent (07-前端架构)
			if (
				event.kind === 'run.state_changed' ||
				event.kind === 'run.exited' ||
				event.kind === 'run.aborted'
			) {
				localIntents.delete(rawRunId);
			}

			const buffer = this.getOrCreateBuffer(rawRunId);
			buffer.push(event);
			this.dirtyRunIds.add(rawRunId);
			this.scheduleFlush();
		}

		// Immediate delivery for milestone lifecycle transitions
		if (isMilestoneEventKind(event.kind)) {
			for (const listener of Array.from(this.milestoneSubscribers)) {
				try {
					listener(event);
				} catch (err) {
					console.error('Error in milestone subscriber:', err);
				}
			}
		}

		// Task-scoped subscribers
		const rawTaskId = typeof event.taskId === 'string' ? event.taskId.trim() : null;
		if (rawTaskId && rawTaskId.length > 0) {
			const taskSubs = this.taskSubscribers.get(rawTaskId);
			if (taskSubs) {
				for (const listener of Array.from(taskSubs)) {
					try {
						listener(event);
					} catch (err) {
						console.error(`Error in task subscriber for taskId ${rawTaskId}:`, err);
					}
				}
			}
		}

		// Global subscribers
		if (this.allSubscribers.size > 0) {
			for (const listener of Array.from(this.allSubscribers)) {
				try {
					listener(event);
				} catch (err) {
					console.error('Error in allSubscribers listener:', err);
				}
			}
		}
	}

	private scheduleFlush(): void {
		if (this.flushPending) {
			return;
		}
		this.flushPending = true;

		const now = this.nowFn();
		const elapsed = now - this.lastFlushTimestamp;
		const remainingDelay = Math.max(0, this.flushIntervalMs - elapsed);

		if (remainingDelay === 0) {
			this.rafId = this.scheduleRafFn(() => {
				this.rafId = null;
				this.performFlush();
			});
		} else {
			this.timerId = setTimeout(() => {
				this.timerId = null;
				this.rafId = this.scheduleRafFn(() => {
					this.rafId = null;
					this.performFlush();
				});
			}, remainingDelay);
		}
	}

	private performFlush(): void {
		this.flushPending = false;
		this.lastFlushTimestamp = this.nowFn();

		if (this.dirtyRunIds.size === 0) {
			return;
		}

		const dirtyList = Array.from(this.dirtyRunIds);
		this.dirtyRunIds.clear();

		for (const runId of dirtyList) {
			const buffer = this.buffers.get(runId);
			if (buffer?.commitFlush()) {
				const listeners = this.runSubscribers.get(runId);
				if (listeners) {
					for (const listener of Array.from(listeners)) {
						try {
							listener();
						} catch (err) {
							console.error(`Error in subscriber callback for runId ${runId}:`, err);
						}
					}
				}
			}
		}

		if (this.flushListeners.size > 0) {
			for (const listener of Array.from(this.flushListeners)) {
				try {
					listener(dirtyList);
				} catch (err) {
					console.error('Error in flush listener:', err);
				}
			}
		}
	}

	/**
	 * Manually executes any pending flush immediately.
	 */
	flush(): void {
		if (this.timerId !== null) {
			clearTimeout(this.timerId);
			this.timerId = null;
		}
		if (this.rafId !== null) {
			this.cancelRafFn(this.rafId);
			this.rafId = null;
		}
		this.performFlush();
	}

	clearRun(runId: string): void {
		const buffer = this.buffers.get(runId);
		if (buffer) {
			buffer.clear();
			this.dirtyRunIds.add(runId);
			this.scheduleFlush();
		}
	}

	clearAll(): void {
		for (const [runId, buffer] of this.buffers.entries()) {
			buffer.clear();
			this.dirtyRunIds.add(runId);
		}
		localIntents.clear();
		if (this.dirtyRunIds.size > 0) {
			this.scheduleFlush();
		}
	}

	deleteRun(runId: string): void {
		this.buffers.delete(runId);
		this.dirtyRunIds.delete(runId);
		localIntents.delete(runId);
		const listeners = this.runSubscribers.get(runId);
		if (listeners) {
			for (const listener of Array.from(listeners)) {
				try {
					listener();
				} catch (err) {
					console.error(`Error notifying deletion subscriber for ${runId}:`, err);
				}
			}
		}
	}

	isFlushPending(): boolean {
		return this.flushPending;
	}

	getLastFlushTime(): number {
		return this.lastFlushTimestamp;
	}

	destroy(): void {
		if (this.timerId !== null) {
			clearTimeout(this.timerId);
			this.timerId = null;
		}
		if (this.rafId !== null) {
			this.cancelRafFn(this.rafId);
			this.rafId = null;
		}
		this.flushPending = false;
		this.buffers.clear();
		this.dirtyRunIds.clear();
		this.runSubscribers.clear();
		this.milestoneSubscribers.clear();
		this.allSubscribers.clear();
		this.taskSubscribers.clear();
		this.flushListeners.clear();
		localIntents.clear();
	}
}

export function createEventBus(options?: EventBusOptions): EventBus {
	return new EventBusImpl(options);
}

/**
 * Singleton default EventBus instance for the entire web client.
 */
export const eventBus: EventBus = createEventBus();

/**
 * Attaches an EventBus instance to an SseClient instance.
 * Automatically wires event ingestion and buffer clearing (E-153).
 */
export function attachSseClient(
	client: SseClient = sseClient,
	bus: EventBus = eventBus,
): () => void {
	const unsubEvent = client.subscribe((event) => {
		bus.push(event);
	});
	const unsubClear = client.onClearBuffer(() => {
		bus.clearAll();
	});

	return () => {
		unsubEvent();
		unsubClear();
	};
}

// Auto-wire default singleton eventBus to default sseClient
attachSseClient(sseClient, eventBus);

/**
 * React hook subscribing to a run stream buffer's integer version number (AC 1, AC 2, AC 3).
 * getSnapshot strictly returns only an integer, never an array or object.
 */
export function useRunStreamVersion(runId: string, bus: EventBus = eventBus): number {
	const subscribe = useCallback(
		(onStoreChange: () => void) => bus.subscribe(runId, onStoreChange),
		[bus, runId],
	);
	const getSnapshot = useCallback(() => bus.versionOf(runId), [bus, runId]);
	const getServerSnapshot = useCallback(() => bus.versionOf(runId), [bus, runId]);

	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * React hook returning the current version and stream buffer for a run stream (AC 3).
 * Internally uses useRunStreamVersion so useSyncExternalStore still returns only a number.
 * Buffer items are read from the buffer during rendering.
 */
export function useRunStreamBuffer(
	runId: string,
	bus: EventBus = eventBus,
): {
	readonly version: number;
	readonly buffer: RunStreamBuffer | undefined;
	readonly items: readonly EventEnvelope[];
} {
	const version = useRunStreamVersion(runId, bus);
	const buffer = bus.getBuffer(runId);
	return {
		version,
		buffer,
		items: buffer ? buffer.getItems() : [],
	};
}

/**
 * React hook returning a slice of events from a run stream buffer (AC 3, E-143).
 */
export function useRunStreamSlice(
	runId: string,
	start?: number,
	end?: number,
	bus: EventBus = eventBus,
): {
	readonly version: number;
	readonly items: readonly EventEnvelope[];
} {
	const version = useRunStreamVersion(runId, bus);
	const buffer = bus.getBuffer(runId);
	return {
		version,
		items: buffer ? buffer.getSlice(start, end) : [],
	};
}
