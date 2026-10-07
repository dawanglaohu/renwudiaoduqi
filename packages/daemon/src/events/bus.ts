import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { type PublicationOrder, createPublicationOrder } from './publication-order.ts';
import {
	type EventPayloadLocationRef,
	type ReplayResult,
	type RingBuffer,
	sanitizeEnvelopeForBuffer,
} from './ring-buffer.ts';

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
	readonly publicationOrder?: PublicationOrder;
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
	readonly dispose: () => void;
	readonly ringBuffer: RingBuffer;
}

export function createEventBus(deps: EventBusDeps): EventBus {
	const { ringBuffer } = deps;
	const subscribers = new Set<EventSubscriber>();
	const publicationOrder = deps.publicationOrder ?? createPublicationOrder();
	let publicationSequence = 0;

	function publish(envelope: EventEnvelope, ref?: EventPayloadLocationRef): EventPublishResult {
		const reservationId = deps.publicationOrder
			? envelope.id
			: publicationOrder.reserve(() => ++publicationSequence);
		let stored: EventEnvelope;
		try {
			stored = sanitizeEnvelopeForBuffer(envelope, ref);
		} catch (error) {
			publicationOrder.cancel(reservationId);
			throw error;
		}
		const subscriberErrors: EventSubscriberError[] = [];
		publicationOrder.ready(reservationId, () => {
			ringBuffer.push(stored);
			const currentSubscribers = Array.from(subscribers);
			for (const subscriber of currentSubscribers) {
				try {
					subscriber(stored);
				} catch (error) {
					subscriberErrors.push(Object.freeze({ error, subscriber }));
				}
			}
		});

		return Object.freeze({
			event: stored,
			// Queued publications acquire their subscriber results when the earlier IDs finish.
			get subscriberErrors() {
				return Object.freeze([...subscriberErrors]);
			},
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
		dispose: () => {
			publicationOrder.dispose();
			subscribers.clear();
		},
		ringBuffer,
	});
}
