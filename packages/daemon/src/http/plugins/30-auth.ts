import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/app-error.ts';

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
	const normalized =
		pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

	if (AUTH_WHITELIST_PATHS.some((whitelisted) => normalized === whitelisted)) {
		return true;
	}
	const relativePath =
		prefix && normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
	return AUTH_WHITELIST.some((whitelisted) => relativePath === whitelisted);
}

export const authPlugin: FastifyPluginAsync = async (instance: FastifyInstance): Promise<void> => {
	instance.decorateRequest('actorDeviceId', null);

	instance.addHook('onRequest', async (request) => {
		request.actorDeviceId = null;

		if (request.is404 || isAuthWhitelisted(request.url, '/api/v1')) {
			return;
		}

		// E-08: All non-whitelisted routes require authentication. Zero IP-based bypass branches.
		const pairingService = request.server.container?.services?.pairing;
		if (!pairingService) {
			// Missing wiring is a server fault: an auth-denied status would tell a paired
			// client its token is bad.
			throw new AppError('E_INTERNAL', 'PairingService is not available in container.');
		}

		const auth = pairingService.authenticateToken(request.headers.authorization);
		request.actorDeviceId = auth.deviceId;
	});
};

Object.defineProperty(authPlugin, Symbol.for('skip-override'), {
	value: true,
	configurable: true,
});
