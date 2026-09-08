import {
	EVENT_DEFINITIONS,
	type EventKind,
	type EventPayloadMap,
	type TypedEventEnvelope,
} from '@agent-scheduler/shared/api/events';

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
	readonly payload: EventPayloadMap[K];
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
}

export interface EnvelopeFactory {
	readonly createEnvelope: <K extends EventKind = EventKind>(
		input: CreateEnvelopeInput<K>,
	) => TypedEventEnvelope<K>;
}

export function createEnvelopeFactory(deps: EnvelopeFactoryDeps): EnvelopeFactory {
	const runSequenceMap = new Map<string, number>();

	function createEnvelope<K extends EventKind = EventKind>(
		input: CreateEnvelopeInput<K>,
	): TypedEventEnvelope<K> {
		const runId = input.runId ?? null;
		let seq = 0;
		if (runId !== null) {
			const current = runSequenceMap.get(runId) ?? 0;
			seq = current;
			runSequenceMap.set(runId, current + 1);
		}

		const id = deps.idAllocator.allocate();
		const ts = deps.clock.now();
		const scope = EVENT_DEFINITIONS[input.kind].scope;
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
		}) as TypedEventEnvelope<K>;
	}

	return Object.freeze({
		createEnvelope,
	});
}
