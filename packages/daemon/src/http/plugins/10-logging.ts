import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export const LOG_REDACT_PATHS = Object.freeze([
	'authorization',
	'*.token',
	'*.pairingCode',
	'*.deviceToken',
	'req.headers.authorization',
	'headers.authorization',
] as const);

export const loggingPlugin: FastifyPluginAsync = async (
	instance: FastifyInstance,
): Promise<void> => {
	instance.addHook('onResponse', async (request, reply) => {
		request.log.info({
			reqId: request.id,
			method: request.method,
			url: request.url,
			responseTimeMs: reply.elapsedTime,
		});
	});
};
