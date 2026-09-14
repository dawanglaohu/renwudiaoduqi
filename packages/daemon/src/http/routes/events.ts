import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
import { handleSseStream, resolveReplayEvents } from '../sse.ts';

export function registerEventsRoutes(instance: FastifyInstance): void {
	instance.get('/api/v1/events', async (request: FastifyRequest, reply) => {
		const container = request.server.container;
		if (!container) {
			throw new AppError('E_INTERNAL', 'Container is not initialized.');
		}

		const actorDeviceId = request.actorDeviceId;
		if (!actorDeviceId) {
			throw new AppError('E_UNAUTHORIZED', 'Authentication required for SSE event stream.');
		}

		// R2: Resolve and validate replay cursor before hijacking the reply.
		// If the replay window is expired, AppError('E_REPLAY_WINDOW_EXPIRED') is thrown here
		// and handled uniformly by 90-error-handler as HTTP 409 with standard error envelope.
		const { parsedLastEventId, replayEvents } = resolveReplayEvents(
			container.events.ringBuffer,
			request.headers['last-event-id'],
		);

		// AC 5: Hijack response only after all pre-flight assertions pass
		reply.hijack();

		handleSseStream({
			rawRequest: request.raw,
			rawResponse: reply.raw,
			requestId: request.id,
			actorDeviceId,
			bus: container.events.bus,
			pairingService: container.services.pairing,
			parsedLastEventId,
			replayEvents,
		});
	});
}
