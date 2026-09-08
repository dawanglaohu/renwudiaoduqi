import {
	type EventEnvelope,
	type EventKind,
	type EventScope,
	scopeFromEventKind,
} from '@agent-scheduler/shared/events';

export interface EnvelopeClock {
	readonly now: () => string;
}

export interface EnvelopeIdAllocator {
	readonly allocate: () => number;
}

export interface EnvelopeFactoryDeps {
	readonly clock: EnvelopeClock;
	readonly idAllocator: EnvelopeIdAllocator;
}

export interface CreateEnvelopeInput<K extends EventKind = EventKind> {
	readonly kind: K;
	readonly payload: unknown;
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly scope?: EventScope;
	readonly seq?: number;
	readonly actorDeviceId?: string | null;
	readonly id?: number;
	readonly ts?: string;
}

export function createEventEnvelope<K extends EventKind = EventKind>(
	deps: EnvelopeFactoryDeps,
	input: CreateEnvelopeInput<K>,
): EventEnvelope {
	const scope = input.scope ?? scopeFromEventKind(input.kind);
	const id = input.id ?? deps.idAllocator.allocate();
	const ts = input.ts ?? deps.clock.now();
	const seq = input.seq ?? 0;
	const runId = input.runId ?? null;
	const taskId = input.taskId ?? null;
	const actorDeviceId = input.actorDeviceId ?? null;

	return Object.freeze({
		id,
		ts,
		runId,
		taskId,
		scope,
		kind: input.kind,
		seq,
		actorDeviceId,
		payload: input.payload,
	}) as EventEnvelope;
}

export interface EnvelopeFactory {
	readonly createEnvelope: <K extends EventKind = EventKind>(
		input: CreateEnvelopeInput<K>,
	) => EventEnvelope;
}

export function createEnvelopeFactory(deps: EnvelopeFactoryDeps): EnvelopeFactory {
	return Object.freeze({
		createEnvelope: <K extends EventKind = EventKind>(input: CreateEnvelopeInput<K>) =>
			createEventEnvelope(deps, input),
	});
}

export function isEventEnvelope(value: unknown): value is EventEnvelope {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === 'number' &&
		typeof candidate.ts === 'string' &&
		typeof candidate.seq === 'number' &&
		typeof candidate.kind === 'string' &&
		typeof candidate.scope === 'string' &&
		'runId' in candidate &&
		'taskId' in candidate &&
		'actorDeviceId' in candidate &&
		'payload' in candidate
	);
}
