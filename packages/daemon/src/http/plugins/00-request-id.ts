import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export function generateRequestId(): string {
	return `req_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export const requestIdPlugin: FastifyPluginAsync = async (
	instance: FastifyInstance,
): Promise<void> => {
	instance.addHook('onRequest', async (request) => {
		const incomingId = request.headers['x-request-id'];
		if (typeof incomingId === 'string' && incomingId.trim().length > 0) {
			request.id = incomingId.trim();
		} else if (!request.id || !request.id.startsWith('req_')) {
			request.id = generateRequestId();
		}
	});

	instance.addHook('onSend', async (request, reply, payload) => {
		void reply.header('x-request-id', request.id);
		return payload;
	});
};

Object.defineProperty(requestIdPlugin, Symbol.for('skip-override'), {
	value: true,
	configurable: true,
});
