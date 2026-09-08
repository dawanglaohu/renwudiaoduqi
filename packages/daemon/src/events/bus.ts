import type { EventEnvelope } from '@agent-scheduler/shared/events';
import { AppError } from '../errors/app-error.ts';
import type { EventPayloadLocationRef, ReplayResult, RingBuffer } from './ring-buffer.ts';

export type EventSubscriber = (event: EventEnvelope) => void;

export interface EventBusDeps {
	readonly ringBuffer: RingBuffer;
	readonly isInsideTransaction?: () => boolean;
}

export interface EventBus {
	readonly publish: (envelope: EventEnvelope, ref?: EventPayloadLocationRef) => EventEnvelope;
	readonly subscribe: (listener: EventSubscriber) => () => void;
	readonly subscribeWithFilter: (
		filter: (event: EventEnvelope) => boolean,
		listener: EventSubscriber,
	) => () => void;
	readonly getEventsSince: (lastEventId: number) => ReplayResult;
	readonly listenerCount: () => number;
	readonly ringBuffer: RingBuffer;
}

export function createEventBus(deps: EventBusDeps): EventBus {
	const { ringBuffer, isInsideTransaction } = deps;
	const subscribers = new Set<EventSubscriber>();

	function publish(envelope: EventEnvelope, ref?: EventPayloadLocationRef): EventEnvelope {
		if (isInsideTransaction?.() === true) {
			throw new AppError(
				'E_TX_NESTED',
				'bus.publish must not be called inside a database transaction. Collect events and publish after the transaction commits.',
			);
		}

		const stored = ringBuffer.push(envelope, ref);
		const currentSubscribers = Array.from(subscribers);

		for (const subscriber of currentSubscribers) {
			try {
				subscriber(stored);
			} catch {
				// Prevent one subscriber's synchronous failure from dropping others
			}
		}

		return stored;
	}

	function subscribe(listener: EventSubscriber): () => void {
		subscribers.add(listener);
		return () => {
			subscribers.delete(listener);
		};
	}

	function subscribeWithFilter(
		filter: (event: EventEnvelope) => boolean,
		listener: EventSubscriber,
	): () => void {
		const wrapped: EventSubscriber = (event) => {
			if (filter(event)) {
				listener(event);
			}
		};
		return subscribe(wrapped);
	}

	function getEventsSince(lastEventId: number): ReplayResult {
		return ringBuffer.getEventsSince(lastEventId);
	}

	function listenerCount(): number {
		return subscribers.size;
	}

	return Object.freeze({
		publish,
		subscribe,
		subscribeWithFilter,
		getEventsSince,
		listenerCount,
		ringBuffer,
	});
}
