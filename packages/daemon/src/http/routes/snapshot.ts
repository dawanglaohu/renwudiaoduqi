import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import type { FastifyInstance, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
import type { DispatchService } from '../../service/dispatch.ts';
import { registerSettingsRoutes } from './settings.ts';

export interface RegisterSnapshotRouteOptions {
	readonly dispatchService?: DispatchService;
}

interface ContainerWithDispatchService {
	readonly services?: {
		readonly dispatch?: DispatchService;
	};
}

function resolveDispatchService(
	request: FastifyRequest,
	instance: FastifyInstance,
	options?: RegisterSnapshotRouteOptions,
): DispatchService {
	if (options?.dispatchService) {
		return options.dispatchService;
	}

	const container =
		(request.server as unknown as { container?: ContainerWithDispatchService })?.container ??
		(instance as unknown as { container?: ContainerWithDispatchService })?.container;

	const service = container?.services?.dispatch;
	if (!service) {
		throw new AppError('E_INTERNAL', 'DispatchService is not available in container');
	}
	return service;
}

/**
 * Registers global snapshot route (M8-T3):
 * - `GET /api/v1/snapshot`: returns global state snapshot including documents, batches, tasks, runs, gates, agents
 */
export function registerSnapshotRoute(
	instance: FastifyInstance,
	options?: RegisterSnapshotRouteOptions,
): void {
	// Register settings routes alongside snapshot routes (adjudicate: S7 implementer decision)
	registerSettingsRoutes(instance);

	const getSnapshotHandler: RouteHandlerMethod = async (request): Promise<SnapshotResponse> => {
		const service = resolveDispatchService(request, instance, options);
		const query = request.query as { docId?: string } | undefined;
		return await service.getSnapshot(query?.docId);
	};

	instance.get('/api/v1/snapshot', getSnapshotHandler);
}
