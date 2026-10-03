import {
	EVENT_DEFINITIONS,
	type EventKind,
	type EventPayloadMap,
	type TypedEventEnvelope,
} from '@agent-scheduler/shared/api/events';
import type { PublicationOrder } from './publication-order.ts';

export interface EnvelopeClock {
	readonly now: () => string;
}

export interface EnvelopeIdAllocator {
	readonly allocate: () => number;
}

export interface EnvelopeFactoryDeps {
	readonly clock: EnvelopeClock;
	readonly idAllocator: EnvelopeIdAllocator;
	readonly publicationOrder?: PublicationOrder;
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
	readonly cancelEnvelope: (envelope: { readonly id: number }) => void;
	readonly createEnvelopeAsync: <K extends EventKind = EventKind>(
		input: CreateEnvelopeInput<K>,
	) => Promise<TypedEventEnvelope<K>>;
}

export function createEnvelopeFactory(deps: EnvelopeFactoryDeps): EnvelopeFactory {
	const runSequenceMap = new Map<string, number>();

	function buildEnvelope<K extends EventKind = EventKind>(
		input: CreateEnvelopeInput<K>,
		id: number,
		ts: string,
	): TypedEventEnvelope<K> {
		const scope = EVENT_DEFINITIONS[input.kind].scope;
		const runId = input.runId ?? null;
		let seq = 0;
		if (runId !== null) {
			const current = runSequenceMap.get(runId) ?? 0;
			seq = current;
			runSequenceMap.set(runId, current + 1);
		}

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
		createEnvelope: <K extends EventKind = EventKind>(input: CreateEnvelopeInput<K>) => {
			const ts = deps.clock.now();
			let envelope: TypedEventEnvelope<K> | undefined;
			const allocate = () => {
				const id = deps.idAllocator.allocate();
				envelope = buildEnvelope(input, id, ts);
				return id;
			};
			if (deps.publicationOrder) deps.publicationOrder.reserve(allocate);
			else allocate();
			return envelope as TypedEventEnvelope<K>;
		},
		createEnvelopeAsync: async <K extends EventKind = EventKind>(input: CreateEnvelopeInput<K>) => {
			const ts = deps.clock.now();
			let envelope: TypedEventEnvelope<K> | undefined;
			const allocate = () => {
				const id = deps.idAllocator.allocate();
				envelope = buildEnvelope(input, id, ts);
				return id;
			};
			if (deps.publicationOrder) await deps.publicationOrder.reserveAsync(allocate);
			else allocate();
			return envelope as TypedEventEnvelope<K>;
		},
		cancelEnvelope: (envelope: { readonly id: number }) =>
			deps.publicationOrder?.cancel(envelope.id),
	});
}
