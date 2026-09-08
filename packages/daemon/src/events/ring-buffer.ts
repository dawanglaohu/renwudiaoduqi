import type { EventEnvelope, TruncatedPayloadRef } from '@agent-scheduler/shared/api/events';
import { AppError } from '../errors/app-error.ts';

export const RING_BUFFER_CAPACITY = 5000;
export const PAYLOAD_MAX_BYTES = 32 * 1024; // 32 KiB

export interface EventPayloadLocationRef {
	readonly fileSeq: number;
	readonly byteOffset: number;
	readonly byteLen: number;
}

export type ReplayResult =
	| {
			readonly ok: true;
			readonly events: readonly EventEnvelope[];
	  }
	| {
			readonly ok: false;
			readonly code: 'E_REPLAY_WINDOW_EXPIRED';
			readonly minId: number;
			readonly requestedLastEventId: number;
	  };

export interface RingBuffer {
	readonly capacity: number;
	readonly size: () => number;
	readonly totalPushed: () => number;
	readonly push: (envelope: EventEnvelope, ref?: EventPayloadLocationRef) => EventEnvelope;
	readonly get: (id: number) => EventEnvelope | undefined;
	readonly getAll: () => readonly EventEnvelope[];
	readonly oldest: () => EventEnvelope | undefined;
	readonly latest: () => EventEnvelope | undefined;
	readonly getEventsSince: (lastEventId: number) => ReplayResult;
}

function measurePayloadByteLength(payload: unknown): number {
	if (payload === null || payload === undefined) {
		return 0;
	}
	if (typeof payload === 'string') {
		return Buffer.byteLength(payload, 'utf8');
	}
	if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
		return payload.byteLength;
	}
	try {
		return Buffer.byteLength(JSON.stringify(payload), 'utf8');
	} catch {
		return PAYLOAD_MAX_BYTES + 1;
	}
}

function isTruncatedPayload(payload: unknown): payload is TruncatedPayloadRef {
	return (
		payload !== null &&
		typeof payload === 'object' &&
		'truncated' in payload &&
		(payload as Record<string, unknown>).truncated === true
	);
}

function isValidLocationRef(ref: unknown): ref is EventPayloadLocationRef {
	if (!ref || typeof ref !== 'object') {
		return false;
	}
	const candidate = ref as Record<string, unknown>;
	return (
		typeof candidate.fileSeq === 'number' &&
		typeof candidate.byteOffset === 'number' &&
		typeof candidate.byteLen === 'number' &&
		candidate.fileSeq >= 0 &&
		candidate.byteOffset >= 0 &&
		candidate.byteLen >= 0
	);
}

function sanitizeEnvelopeForBuffer(
	envelope: EventEnvelope,
	ref?: EventPayloadLocationRef,
): EventEnvelope {
	if (isTruncatedPayload(envelope.payload)) {
		return envelope;
	}

	const byteLen = measurePayloadByteLength(envelope.payload);
	if (byteLen > PAYLOAD_MAX_BYTES) {
		if (!isValidLocationRef(ref)) {
			throw new AppError(
				'E_VALIDATION',
				`Large event payload exceeding ${PAYLOAD_MAX_BYTES} bytes requires a valid logstore reference before entering ring buffer. ref:null is prohibited.`,
				{
					details: {
						byteLen,
						maxAllowedBytes: PAYLOAD_MAX_BYTES,
						hasRef: ref !== undefined && ref !== null,
					},
				},
			);
		}

		const truncatedPayload: TruncatedPayloadRef = {
			truncated: true,
			byteLen,
			ref: {
				fileSeq: ref.fileSeq,
				byteOffset: ref.byteOffset,
				byteLen: ref.byteLen,
			},
		};

		return Object.freeze({
			...envelope,
			payload: truncatedPayload,
		}) as EventEnvelope;
	}

	return envelope;
}

export function createRingBuffer(): RingBuffer {
	const capacity = RING_BUFFER_CAPACITY;

	const buffer: Array<EventEnvelope | null> = new Array(capacity).fill(null);
	let head = 0;
	let count = 0;
	let lifetimePushed = 0;

	function size(): number {
		return count;
	}

	function totalPushed(): number {
		return lifetimePushed;
	}

	function push(envelope: EventEnvelope, ref?: EventPayloadLocationRef): EventEnvelope {
		const sanitized = sanitizeEnvelopeForBuffer(envelope, ref);

		if (count < capacity) {
			const index = (head + count) % capacity;
			buffer[index] = sanitized;
			count += 1;
		} else {
			buffer[head] = sanitized;
			head = (head + 1) % capacity;
		}

		lifetimePushed += 1;
		return sanitized;
	}

	function oldest(): EventEnvelope | undefined {
		if (count === 0) return undefined;
		return buffer[head] ?? undefined;
	}

	function latest(): EventEnvelope | undefined {
		if (count === 0) return undefined;
		const index = (head + count - 1) % capacity;
		return buffer[index] ?? undefined;
	}

	function getAll(): readonly EventEnvelope[] {
		const result: EventEnvelope[] = [];
		for (let i = 0; i < count; i++) {
			const index = (head + i) % capacity;
			const item = buffer[index];
			if (item !== null && item !== undefined) {
				result.push(item);
			}
		}
		return result;
	}

	function get(id: number): EventEnvelope | undefined {
		for (let i = 0; i < count; i++) {
			const index = (head + i) % capacity;
			const item = buffer[index];
			if (item !== null && item !== undefined && item.id === id) {
				return item;
			}
		}
		return undefined;
	}

	function getEventsSince(lastEventId: number): ReplayResult {
		if (count === 0) {
			if (lastEventId === 0) {
				return { ok: true, events: [] };
			}
			return {
				ok: false,
				code: 'E_REPLAY_WINDOW_EXPIRED',
				minId: 0,
				requestedLastEventId: lastEventId,
			};
		}

		const oldestItem = buffer[head];
		if (!oldestItem) {
			return { ok: true, events: [] };
		}
		const minId = oldestItem.id;

		const latestIndex = (head + count - 1) % capacity;
		const latestItem = buffer[latestIndex];
		if (!latestItem) {
			return { ok: true, events: [] };
		}
		const maxId = latestItem.id;

		// E-153: If the requested last event id is older than minId - 1, events have been missed
		if (lastEventId < minId - 1) {
			return {
				ok: false,
				code: 'E_REPLAY_WINDOW_EXPIRED',
				minId,
				requestedLastEventId: lastEventId,
			};
		}

		if (lastEventId >= maxId) {
			return { ok: true, events: [] };
		}

		const events: EventEnvelope[] = [];
		for (let i = 0; i < count; i++) {
			const index = (head + i) % capacity;
			const item = buffer[index];
			if (item !== null && item !== undefined && item.id > lastEventId) {
				events.push(item);
			}
		}

		return { ok: true, events };
	}

	return Object.freeze({
		capacity,
		size,
		totalPushed,
		push,
		get,
		getAll,
		oldest,
		latest,
		getEventsSince,
	});
}

export function replayEventsSinceOrThrow(
	ringBuffer: RingBuffer,
	lastEventId: number,
): readonly EventEnvelope[] {
	const result = ringBuffer.getEventsSince(lastEventId);
	if (!result.ok) {
		throw new AppError(
			'E_REPLAY_WINDOW_EXPIRED',
			`Replay window expired for Last-Event-ID ${lastEventId}. Oldest available ID is ${result.minId}.`,
			{
				details: {
					minId: result.minId,
					requestedLastEventId: result.requestedLastEventId,
				},
			},
		);
	}
	return result.events;
}
