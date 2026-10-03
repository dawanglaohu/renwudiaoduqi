import { AppError } from '../errors/app-error.ts';

export const MAX_PENDING_EVENT_RESERVATIONS = 5000;

export interface PublicationOrder {
	readonly reserve: (allocate: () => number) => number;
	readonly reserveAsync: (allocate: () => number) => Promise<number>;
	readonly isPaused: boolean;
	readonly onPause: (listener: () => void) => () => void;
	readonly onResume: (listener: () => void) => () => void;
	readonly ready: (id: number, deliver: () => void) => void;
	/** Cancels an abandoned reservation; accepted publications remain queued. */
	readonly cancel: (id: number) => void;
	readonly begin: () => { readonly commit: () => void; readonly rollback: () => void };
	readonly pendingCount: () => number;
	readonly dispose: () => void;
}

export function createPublicationOrder(
	capacity = MAX_PENDING_EVENT_RESERVATIONS,
): PublicationOrder {
	if (!Number.isSafeInteger(capacity) || capacity < 1) {
		throw new AppError('E_VALIDATION', 'Event reservation capacity must be a positive integer.');
	}
	const pending = new Map<number, (() => void) | null>();
	let lastReserved = 0;
	let draining = false;
	let transactionActive = false;
	let disposed = false;
	let paused = false;
	const pauseListeners = new Set<() => void>();
	const resumeListeners = new Set<() => void>();
	const waiting: Array<{
		allocate: () => number;
		resolve: (id: number) => void;
		reject: (error: unknown) => void;
	}> = [];
	const lowWatermark = Math.floor(capacity / 2);

	function updatePressure(): void {
		const next =
			pending.size >= capacity || (paused && (pending.size > lowWatermark || waiting.length > 0));
		if (next === paused) return;
		paused = next;
		for (const listener of next ? pauseListeners : resumeListeners) {
			try {
				listener();
			} catch {
				/* A closed output stream cannot block event publication. */
			}
		}
	}

	function admitWaiting(): void {
		if (transactionActive || disposed) return;
		while (pending.size < capacity && waiting.length > 0) {
			const waiter = waiting.shift();
			if (!waiter) break;
			try {
				waiter.resolve(reserve(waiter.allocate));
			} catch (error) {
				waiter.reject(error);
			}
		}
		updatePressure();
	}

	function assertActive(): void {
		if (disposed) throw new AppError('E_INTERNAL', 'Event publication has been disposed.');
	}

	function drain(): void {
		if (draining || transactionActive || disposed) return;
		draining = true;
		try {
			while (pending.size > 0 && !disposed) {
				const first = pending.entries().next().value;
				if (!first || first[1] === null) break;
				pending.delete(first[0]);
				first[1]();
			}
		} finally {
			draining = false;
			admitWaiting();
		}
	}

	function reserve(allocate: () => number): number {
		assertActive();
		if (pending.size >= capacity) {
			throw new AppError('E_RATE_LIMITED', 'Event publication is waiting for earlier events.', {
				details: { capacity },
			});
		}
		const id = allocate();
		if (!Number.isSafeInteger(id) || id <= lastReserved) {
			throw new AppError('E_VALIDATION', 'Event IDs must be reserved in increasing order.');
		}
		lastReserved = id;
		pending.set(id, null);
		updatePressure();
		return id;
	}

	function reserveAsync(allocate: () => number): Promise<number> {
		if (disposed)
			return Promise.reject(new AppError('E_INTERNAL', 'Event publication has been disposed.'));
		if (pending.size < capacity && waiting.length === 0) {
			try {
				return Promise.resolve(reserve(allocate));
			} catch (error) {
				return Promise.reject(error);
			}
		}
		// Upstream readers pause at capacity; only the already-read chunk tails wait here.
		return new Promise((resolve, reject) => waiting.push({ allocate, resolve, reject }));
	}

	function ready(id: number, deliver: () => void): void {
		assertActive();
		if (pending.get(id) !== null) {
			throw new AppError('E_VALIDATION', 'Event publication requires an outstanding reservation.');
		}
		pending.set(id, deliver);
		drain();
	}

	function cancel(id: number): void {
		if (pending.get(id) !== null) return;
		pending.delete(id);
		drain();
	}

	function begin() {
		assertActive();
		if (transactionActive)
			throw new AppError('E_TX_NESTED', 'Event transaction is already active.');
		const checkpoint = lastReserved;
		transactionActive = true;
		let completed = false;
		const finish = (rollback: boolean) => {
			if (completed) return;
			completed = true;
			if (rollback) {
				for (const id of pending.keys()) {
					if (id > checkpoint) pending.delete(id);
				}
			}
			transactionActive = false;
			drain();
		};
		return { commit: () => finish(false), rollback: () => finish(true) };
	}

	return Object.freeze({
		reserve,
		reserveAsync,
		get isPaused() {
			return paused;
		},
		onPause: (listener: () => void) => {
			pauseListeners.add(listener);
			return () => pauseListeners.delete(listener);
		},
		onResume: (listener: () => void) => {
			resumeListeners.add(listener);
			return () => resumeListeners.delete(listener);
		},
		ready,
		cancel,
		begin,
		pendingCount: () => pending.size,
		dispose: () => {
			disposed = true;
			pending.clear();
			for (const waiter of waiting.splice(0))
				waiter.reject(new AppError('E_INTERNAL', 'Event publication has been disposed.'));
			pauseListeners.clear();
			resumeListeners.clear();
		},
	});
}
