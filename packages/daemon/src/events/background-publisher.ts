import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from './bus.ts';
import type { CreateEnvelopeInput, EnvelopeFactory } from './envelope.ts';

/** Owns notifications from synchronous callbacks, which must release their caller before waiting. */
export function createBackgroundPublisher(deps: {
	readonly bus: EventBus;
	readonly envelopeFactory: EnvelopeFactory;
	readonly onError?: (error: unknown) => void;
}) {
	const pending = new Set<Promise<void>>();
	let stopped = false;
	return {
		publish(input: CreateEnvelopeInput): void {
			if (stopped) return;
			try {
				deps.bus.publish(deps.envelopeFactory.createEnvelope(input) as EventEnvelope);
				return;
			} catch (error) {
				if (!(error instanceof AppError) || error.code !== 'E_RATE_LIMITED') {
					deps.onError?.(error);
					return;
				}
			}
			const completion = deps.envelopeFactory
				.createEnvelopeAsync(input)
				.then((envelope) => {
					try {
						if (!stopped) deps.bus.publish(envelope as EventEnvelope);
					} finally {
						deps.envelopeFactory.cancelEnvelope(envelope);
					}
				})
				.catch((error: unknown) => {
					if (!stopped) deps.onError?.(error);
				})
				.finally(() => pending.delete(completion));
			pending.add(completion);
		},
		async stop(): Promise<void> {
			stopped = true;
			await Promise.all(pending);
		},
	};
}
