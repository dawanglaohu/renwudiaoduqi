import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export const securityHeadersPlugin: FastifyPluginAsync = async (
	instance: FastifyInstance,
): Promise<void> => {
	instance.addHook('onSend', async (_request, reply, payload) => {
		void reply.header('x-content-type-options', 'nosniff');
		void reply.header('x-frame-options', 'DENY');
		void reply.header('referrer-policy', 'no-referrer');
		void reply.header('cross-origin-opener-policy', 'same-origin');
		void reply.header('cross-origin-resource-policy', 'same-origin');
		void reply.header('content-security-policy', "default-src 'self'");
		return payload;
	});
};

Object.defineProperty(securityHeadersPlugin, Symbol.for('skip-override'), {
	value: true,
	configurable: true,
});
