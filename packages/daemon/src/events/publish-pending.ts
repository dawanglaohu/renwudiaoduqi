import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { EventBus } from './bus.ts';
import type { EnvelopeFactory } from './envelope.ts';

/** The caller owns this committed batch until publication accepts each reservation. */
export function publishPendingEvents(
	events: readonly (EventEnvelope | null | undefined)[],
	deps: {
		readonly bus?: Pick<EventBus, 'publish'>;
		readonly envelopeFactory?: Pick<EnvelopeFactory, 'cancelEnvelope'>;
	},
): void {
	try {
		for (const event of events) {
			if (event) deps.bus?.publish(event);
		}
	} finally {
		for (const event of events) {
			if (event) deps.envelopeFactory?.cancelEnvelope(event);
		}
	}
}
