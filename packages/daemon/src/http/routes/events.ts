import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
import { handleSseStream, resolveReplayEvents } from '../sse.ts';

export function registerEventsRoutes(instance: FastifyInstance): void {
	instance.get('/api/v1/events', async (request: FastifyRequest, reply: FastifyReply) => {
		const container = request.server.container;
		if (!container) {
			throw new AppError('E_INTERNAL', 'Container is not initialized.');
		}

		const actorDeviceId = request.actorDeviceId;
		if (!actorDeviceId) {
			throw new AppError('E_UNAUTHORIZED', 'Authentication required for SSE event stream.');
		}

		// The replay cursor is validated before the reply is hijacked: once hijacked, Fastify no longer
		// owns the response, so an expired window could not be reported as 409 E_REPLAY_WINDOW_EXPIRED.
		const { parsedLastEventId, replayEvents } = resolveReplayEvents(
			container.events.ringBuffer,
			request.headers['last-event-id'],
		);

		// Hijack only after every pre-flight assertion passed; the stream itself never calls reply.send.
		// `void` marks it as a deliberately fire-and-forget statement: the source-contracts
		// architecture test rejects bare thenable call statements (M1-T1, E-213).
		void reply.hijack();

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
