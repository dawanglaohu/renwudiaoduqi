import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { registerAgentRoutes } from '../routes/agents.ts';
import { registerBatchesRoutes } from '../routes/batches.ts';
import { registerDeviceRoutes } from '../routes/devices.ts';
import { registerDocumentRoutes } from '../routes/documents.ts';
import { registerEventsRoutes } from '../routes/events.ts';
import { registerGateRoutes } from '../routes/gates.ts';
import { registerHealthRoute } from '../routes/health.ts';
import { registerPairRoutes } from '../routes/pair.ts';
import { registerRunsRoutes } from '../routes/runs.ts';
import { registerSnapshotRoute } from '../routes/snapshot.ts';
import { registerSystemRoutes } from '../routes/system.ts';
import { registerTasksRoutes } from '../routes/tasks.ts';
import { registerVersionRoute } from '../routes/version.ts';
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
	registerVersionRoute(target);
	registerSystemRoutes(target);
	registerRunsRoutes(target);
	registerBatchesRoutes(target);
	registerSnapshotRoute(target);
	registerPairRoutes(target);
	registerDeviceRoutes(target);
	registerDocumentRoutes(target);
	registerAgentRoutes(target);
	registerEventsRoutes(target);
	registerTasksRoutes(target);
	registerGateRoutes(target);
};
