import { ROUTES } from '@agent-scheduler/shared/api/routes';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
import { registerDeviceRoutes } from '../routes/devices.ts';
import { registerHealthRoute } from '../routes/health.ts';
import { registerPairRoutes } from '../routes/pair.ts';
import { registerRunsRoutes } from '../routes/runs.ts';
import { registerSystemRoutes } from '../routes/system.ts';
import { errorHandlerPlugin } from './90-error-handler.ts';

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
	await errorHandlerPlugin(instance, {});
	const target = createRouteTarget(instance);
	registerHealthRoute(target);
	registerSystemRoutes(target);
	registerRunsRoutes(target);
	registerPairRoutes(target);
	registerDeviceRoutes(target);

	const customRegisteredPaths = new Set<string>([
		'GET /api/v1/health',
		'GET /api/v1/system/usage',
		'POST /api/v1/runs/:runId/abort',
		'POST /api/v1/runs/:id/abort',
		'POST /api/v1/pair/claim',
		'POST /api/v1/pair/code',
		'GET /api/v1/devices',
		'DELETE /api/v1/devices/:deviceId',
	]);

	for (const route of ROUTES) {
		const key = `${route.method} ${route.path}`;
		if (customRegisteredPaths.has(key)) {
			continue;
		}

		const method = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete';
		const opts = route.bodySchema
			? {
					schema: {
						body: route.bodySchema,
					},
				}
			: {};

		target[method](route.path, opts, async (request) => {
			throw new AppError(
				'E_INTERNAL',
				`Route ${request.method} ${request.url} handler is not implemented yet.`,
			);
		});
	}
};

