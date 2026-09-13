import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
import { handleSseStream } from '../sse.ts';

export function registerEventsRoutes(instance: FastifyInstance): void {
	instance.get('/api/v1/events', async (request: FastifyRequest, reply) => {
		reply.hijack();

		const container = request.server.container;
		if (!container) {
			throw new AppError('E_INTERNAL', 'Container is not initialized.');
		}

		handleSseStream({
			request,
			rawRequest: request.raw,
			rawResponse: reply.raw,
			container,
		});
	});
}
