import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { EventPayloadLocationRef, ReplayResult, RingBuffer } from './ring-buffer.ts';

export type EventSubscriber = (event: EventEnvelope) => void;

export interface EventSubscriberError {
	readonly error: unknown;
	readonly subscriber: EventSubscriber;
}

export interface EventPublishResult {
	readonly event: EventEnvelope;
	readonly subscriberErrors: readonly EventSubscriberError[];
}

export interface EventBusDeps {
	readonly ringBuffer: RingBuffer;
}

export interface EventBus {
	readonly publish: (envelope: EventEnvelope, ref?: EventPayloadLocationRef) => EventPublishResult;
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
	const { ringBuffer } = deps;
	const subscribers = new Set<EventSubscriber>();

	function publish(envelope: EventEnvelope, ref?: EventPayloadLocationRef): EventPublishResult {
		const stored = ringBuffer.push(envelope, ref);
		const currentSubscribers = Array.from(subscribers);
		const subscriberErrors: EventSubscriberError[] = [];

		for (const subscriber of currentSubscribers) {
			try {
				subscriber(stored);
			} catch (error) {
				subscriberErrors.push(Object.freeze({ error, subscriber }));
			}
		}

		return Object.freeze({
			event: stored,
			subscriberErrors: Object.freeze(subscriberErrors),
		});
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
