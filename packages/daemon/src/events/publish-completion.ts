import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { EventBus } from './bus.ts';
import type { CreateEnvelopeInput, EnvelopeFactory } from './envelope.ts';

/**
 * Publishes the result of an irreversible operation without rejecting it for
 * temporary queue pressure. Capture inputs with the committed result and call
 * this after the transaction and resource cleanup. No reservation may be held
 * by the caller while waiting for these publications.
 */
export async function publishCompletionEvents(
	inputs: readonly (CreateEnvelopeInput | null | undefined)[],
	deps: { readonly bus?: EventBus; readonly envelopeFactory?: EnvelopeFactory },
): Promise<void> {
	if (!deps.bus || !deps.envelopeFactory) return;
	for (const input of inputs) {
		if (!input) continue;
		const envelope = await deps.envelopeFactory.createEnvelopeAsync(input);
		try {
			deps.bus.publish(envelope as EventEnvelope);
		} finally {
			deps.envelopeFactory.cancelEnvelope(envelope);
		}
	}
}
