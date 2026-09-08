import {
	EVENT_DEFINITIONS,
	type EventEnvelope,
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
	readonly seq?: number;
	readonly actorDeviceId?: string | null;
}

export interface EnvelopeFactory {
	readonly createEnvelope: <K extends EventKind = EventKind>(
		input: CreateEnvelopeInput<K>,
	) => TypedEventEnvelope<K>;
	readonly currentSeqForRun: (runId: string) => number;
}

export function createEnvelopeFactory(deps: EnvelopeFactoryDeps): EnvelopeFactory {
	const runSequenceMap = new Map<string, number>();

	function createEnvelope<K extends EventKind = EventKind>(
		input: CreateEnvelopeInput<K>,
	): TypedEventEnvelope<K> {
		const runId = input.runId ?? null;
		let seq: number;

		if (input.seq !== undefined) {
			seq = input.seq;
			if (runId !== null) {
				runSequenceMap.set(runId, Math.max(runSequenceMap.get(runId) ?? 0, seq + 1));
			}
		} else if (runId !== null) {
			const current = runSequenceMap.get(runId) ?? 0;
			seq = current;
			runSequenceMap.set(runId, current + 1);
		} else {
			seq = 0;
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

	function currentSeqForRun(runId: string): number {
		return runSequenceMap.get(runId) ?? 0;
	}

	return Object.freeze({
		createEnvelope,
		currentSeqForRun,
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
