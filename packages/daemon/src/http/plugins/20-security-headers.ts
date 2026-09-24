import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export function isAllowedShellOrigin(origin: string | undefined): boolean {
	if (!origin) return false;
	return (
		origin === 'tauri://localhost' ||
		origin === 'http://tauri.localhost' ||
		origin === 'https://tauri.localhost' ||
		origin === 'https://localhost'
	);
}

export const securityHeadersPlugin: FastifyPluginAsync = async (
	instance: FastifyInstance,
): Promise<void> => {
	instance.addHook('onRequest', async (request, reply) => {
		const origin = request.headers.origin;
		if (isAllowedShellOrigin(origin)) {
			if (request.method === 'OPTIONS') {
				const reqHeaders = request.headers['access-control-request-headers'];
				return reply
					.header('access-control-allow-origin', origin)
					.header('access-control-allow-credentials', 'true')
					.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, PUT, OPTIONS')
					.header(
						'access-control-allow-headers',
						reqHeaders ??
							'Authorization, Content-Type, X-Agsched-Client, X-Idempotency-Key, X-Request-Id, Last-Event-ID, Cache-Control, Accept',
					)
					.header('access-control-max-age', '86400')
					.send();
			}
		}
	});

	instance.addHook('onSend', async (request, reply, payload) => {
		void reply.header('x-content-type-options', 'nosniff');
		void reply.header('x-frame-options', 'DENY');
		void reply.header('referrer-policy', 'no-referrer');
		void reply.header('cross-origin-opener-policy', 'same-origin');
		const origin = request.headers.origin;
		if (isAllowedShellOrigin(origin)) {
			void reply.header('access-control-allow-origin', origin);
			void reply.header('access-control-allow-credentials', 'true');
			void reply.header('access-control-expose-headers', 'X-Request-Id, X-Idempotency-Key');
			void reply.header('cross-origin-resource-policy', 'cross-origin');
		} else {
			void reply.header('cross-origin-resource-policy', 'same-origin');
		}
		void reply.header('content-security-policy', "default-src 'self'");
		return payload;
	});
};

Object.defineProperty(securityHeadersPlugin, Symbol.for('skip-override'), {
	value: true,
	configurable: true,
});
