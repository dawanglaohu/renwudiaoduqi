import { ROUTES } from '@agent-scheduler/shared/api/routes';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
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

	const customRegisteredPaths = new Set<string>([
		'GET /api/v1/health',
		'GET /api/v1/version',
		'GET /api/v1/events',
		'GET /api/v1/system/usage',
		'POST /api/v1/runs/:runId/abort',
		'POST /api/v1/runs/:id/abort',
		'POST /api/v1/runs/:runId/messages',
		'POST /api/v1/runs/:id/messages',
		'GET /api/v1/runs/:runId/log',
		'GET /api/v1/runs/:runId/search',
		'GET /api/v1/runs/:id/search',
		'DELETE /api/v1/runs/:runId/logs',
		'DELETE /api/v1/runs/:id/logs',
		'POST /api/v1/runs',
		'POST /api/v1/runs/:runId/rerun',
		'GET /api/v1/runs',
		'GET /api/v1/runs/:runId',
		'POST /api/v1/batches/:batchId/start',
		'POST /api/v1/batches/:batchId/pause',
		'POST /api/v1/batches/:batchId/wrapup',
		'GET /api/v1/batches/:batchId/wrapups',
		'GET /api/v1/batches/:batchId/assignments',
		'POST /api/v1/batches/:batchId/assignments',
		'GET /api/v1/snapshot',
		'POST /api/v1/pair/claim',
		'POST /api/v1/pair/code',
		'GET /api/v1/devices',
		'DELETE /api/v1/devices/:deviceId',
		'GET /api/v1/documents',
		'POST /api/v1/documents',
		'POST /api/v1/documents/:docId/open-reader',
		'PATCH /api/v1/documents/:docId/settings',
		'GET /api/v1/agents',
		'PATCH /api/v1/agents/:agentId',
		'POST /api/v1/agents/:agentId/probe',
		'GET /api/v1/agents/:agentId/models',
		'GET /api/v1/tasks/:taskId/landing',
		'POST /api/v1/tasks/:taskId/worktree/cleanup',
		'GET /api/v1/gates',
		'POST /api/v1/gates/:gateId/decide',
		'PATCH /api/v1/settings/gates',
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
