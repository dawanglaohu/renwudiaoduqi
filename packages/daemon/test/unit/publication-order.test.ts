import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createPublicationOrder } from '../../src/events/publication-order.ts';
import { publishPendingEvents } from '../../src/events/publish-pending.ts';
import { PAYLOAD_MAX_BYTES, createRingBuffer } from '../../src/events/ring-buffer.ts';

function setup(capacity?: number) {
	const publicationOrder = createPublicationOrder(capacity);
	let nextId = 1;
	const allocate = vi.fn(() => nextId++);
	const factory = createEnvelopeFactory({
		clock: { now: () => '2026-10-03T00:00:00.000Z' },
		idAllocator: { allocate },
		publicationOrder,
	});
	const ringBuffer = createRingBuffer();
	const bus = createEventBus({ ringBuffer, publicationOrder });
	const create = (chunk = 'hello') =>
		factory.createEnvelope({
			kind: 'agent_message_chunk',
			runId: 'run',
			payload: { chunk },
		});
	return { publicationOrder, allocate, factory, ringBuffer, bus, create };
}

describe('event publication reservations', () => {
	it('admits waiting stream events without allocating IDs early and resumes at the low watermark', async () => {
		const env = setup(4);
		const pause = vi.fn();
		const resume = vi.fn();
		env.publicationOrder.onPause(pause);
		env.publicationOrder.onResume(resume);
		const reserved = [env.create(), env.create(), env.create(), env.create()] as const;
		const waiting = env.factory.createEnvelopeAsync({
			runId: 'run',
			kind: 'agent_message_chunk',
			payload: { chunk: 'tail' },
		});
		expect(env.allocate).toHaveBeenCalledTimes(4);
		expect(pause).toHaveBeenCalledTimes(1);
		env.factory.cancelEnvelope(reserved[0]);
		const admitted = await waiting;
		expect(admitted.id).toBe(5);
		expect(admitted.seq).toBe(4);
		expect(env.publicationOrder.isPaused).toBe(true);
		env.factory.cancelEnvelope(reserved[1]);
		expect(resume).not.toHaveBeenCalled();
		env.factory.cancelEnvelope(reserved[2]);
		expect(resume).toHaveBeenCalledTimes(1);
	});

	it('rejects waiting stream events on disposal', async () => {
		const env = setup(1);
		env.create();
		const waiting = env.factory.createEnvelopeAsync({
			kind: 'agent_message_chunk',
			payload: { chunk: 'tail' },
		});
		env.bus.dispose();
		await expect(waiting).rejects.toThrow(/disposed/);
		expect(env.allocate).toHaveBeenCalledTimes(1);
	});
	it('cancels the remainder of a committed batch if its first publication fails', () => {
		const env = setup();
		const batch = [env.create('x'.repeat(PAYLOAD_MAX_BYTES + 1)), env.create()];
		expect(() => publishPendingEvents(batch, { ...env, envelopeFactory: env.factory })).toThrow();
		env.bus.publish(env.create());
		expect(env.ringBuffer.getAll().map((event) => event.id)).toEqual([3]);
		expect(env.publicationOrder.pendingCount()).toBe(0);
	});

	it('cancels a committed batch when the optional bus is absent', () => {
		const env = setup();
		publishPendingEvents([env.create(), null, env.create()], { envelopeFactory: env.factory });
		expect(env.publicationOrder.pendingCount()).toBe(0);
	});
	it('holds a preallocated second event ahead of a nested third publication', () => {
		const env = setup();
		const first = env.create();
		const second = env.create();
		const observed: number[] = [];
		env.bus.subscribe((event) => {
			if (event.id === first.id) env.bus.publish(env.create());
		});
		env.bus.subscribe((event) => observed.push(event.id));
		env.bus.publish(first);
		expect(observed).toEqual([1]);
		env.bus.publish(second);
		expect(observed).toEqual([1, 2, 3]);
		expect(env.bus.getEventsSince(1)).toMatchObject({ ok: true, events: [{ id: 2 }, { id: 3 }] });
	});

	it('cancels a failed payload without losing already accepted later publications', () => {
		const env = setup();
		const invalid = env.create('x'.repeat(PAYLOAD_MAX_BYTES + 1));
		const later = env.create();
		env.bus.publish(later);
		env.factory.cancelEnvelope(later);
		expect(() => env.bus.publish(invalid)).toThrow(/requires a valid logstore reference/);
		expect(env.ringBuffer.getAll()).toEqual([later]);
		expect(env.publicationOrder.pendingCount()).toBe(0);
	});

	it('truncates durable large payloads before retaining them in the pending queue', () => {
		const env = setup();
		const blocker = env.create();
		const large = env.create('x'.repeat(PAYLOAD_MAX_BYTES + 1));
		const result = env.bus.publish(large, { fileSeq: 0, byteOffset: 0, byteLen: 40000 });
		expect(result.event.payload).toMatchObject({ truncated: true, ref: { byteLen: 40000 } });
		expect(env.ringBuffer.size()).toBe(0);
		env.factory.cancelEnvelope(blocker);
		expect(env.ringBuffer.latest()).toBe(result.event);
	});

	it('rejects excess reservations before allocating IDs and recovers after cancellation', () => {
		const env = setup(2);
		const blocker = env.create();
		env.bus.publish(env.create());
		expect(() => env.create()).toThrow(/waiting for earlier events/);
		expect(env.allocate).toHaveBeenCalledTimes(2);
		expect(env.publicationOrder.pendingCount()).toBe(2);
		env.factory.cancelEnvelope(blocker);
		expect(env.create().id).toBe(3);
	});

	it('rolls back only IDs allocated inside the transaction checkpoint', () => {
		const env = setup();
		const outside = env.create();
		const scope = env.publicationOrder.begin();
		const abandoned = env.create();
		expect(() => env.publicationOrder.begin()).toThrow(/already active/);
		scope.rollback();
		env.bus.publish(env.create());
		expect(env.ringBuffer.size()).toBe(0);
		env.bus.publish(outside);
		expect(env.ringBuffer.getAll().map((event) => event.id)).toEqual([1, 3]);
		expect(() => env.bus.publish(abandoned)).toThrow(/outstanding reservation/);
	});

	it('records subscriber errors when a delayed publication is finally delivered', () => {
		const env = setup();
		const blocker = env.create();
		env.bus.subscribe(() => {
			throw new Error('subscriber failed');
		});
		const result = env.bus.publish(env.create());
		expect(result.subscriberErrors).toEqual([]);
		env.factory.cancelEnvelope(blocker);
		expect(result.subscriberErrors).toHaveLength(1);
		expect(Object.isFrozen(result.subscriberErrors)).toBe(true);
	});

	it('disposes pending work without delivering it and rejects late writers', () => {
		const env = setup();
		const blocker = env.create();
		env.bus.publish(env.create());
		env.bus.subscribe(() => undefined);
		env.bus.dispose();
		env.factory.cancelEnvelope(blocker);
		expect(env.publicationOrder.pendingCount()).toBe(0);
		expect(env.ringBuffer.size()).toBe(0);
		expect(env.bus.listenerCount()).toBe(0);
		expect(() => env.create()).toThrow(/disposed/);
		expect(() => env.bus.publish(blocker)).toThrow(/disposed/);
	});

	it('does not share pending state between containers', () => {
		const blocked = setup();
		blocked.create();
		const active = setup();
		active.bus.publish(active.create());
		expect(active.ringBuffer.latest()?.id).toBe(1);
		expect(blocked.ringBuffer.size()).toBe(0);
	});
});
