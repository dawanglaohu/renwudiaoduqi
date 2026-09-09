import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { registerDeviceRoutes } from '../routes/devices.ts';
import { registerHealthRoute } from '../routes/health.ts';
import { registerPairRoutes } from '../routes/pair.ts';
import { registerRunsRoutes } from '../routes/runs.ts';
import { registerSystemRoutes } from '../routes/system.ts';

function normalizePath(url: string): string {
	if (url === '/api/v1' || url === '/api/v1/') return '/';
	if (url.startsWith('/api/v1/')) return url.slice('/api/v1'.length);
	return url;
}

export function createRouteTarget(instance: FastifyInstance): FastifyInstance {
	const methods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all'] as const;
	return new Proxy(instance, {
		get(target, prop, receiver) {
			if (typeof prop === 'string' && methods.includes(prop as (typeof methods)[number])) {
				const originalMethod = (target as unknown as Record<string, unknown>)[prop];
				if (typeof originalMethod === 'function') {
					return (path: string, ...rest: unknown[]) => {
						const normalized = normalizePath(path);
						return originalMethod.call(target, normalized, ...rest);
					};
				}
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

export const routesPlugin: FastifyPluginAsync = async (
	instance: FastifyInstance,
): Promise<void> => {
	const target = createRouteTarget(instance);
	registerHealthRoute(target);
	registerSystemRoutes(target);
	registerRunsRoutes(target);
	registerPairRoutes(target);
	registerDeviceRoutes(target);
};
