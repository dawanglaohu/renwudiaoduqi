import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

declare module 'fastify' {
	interface FastifyRequest {
		actorDeviceId: string | null;
	}
}

export const AUTH_WHITELIST = Object.freeze(['/health', '/pair/claim', '/version'] as const);

export const AUTH_WHITELIST_PATHS = Object.freeze([
	'/api/v1/health',
	'/api/v1/pair/claim',
	'/api/v1/version',
] as const);

export function isAuthWhitelisted(url: string, prefix = ''): boolean {
	const pathname = url.split('?')[0] ?? '';
	if (AUTH_WHITELIST_PATHS.some((whitelisted) => pathname === whitelisted)) {
		return true;
	}
	const relativePath =
		prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
	return AUTH_WHITELIST.some((whitelisted) => relativePath === whitelisted);
}

export const authPlugin: FastifyPluginAsync = async (instance: FastifyInstance): Promise<void> => {
	instance.decorateRequest('actorDeviceId', null);

	instance.addHook('onRequest', async (request) => {
		request.actorDeviceId = null;
		// Authentication verification and token revocation checks are owned by M2-T3.
	});
};
