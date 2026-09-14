import type { FastifyInstance, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
import type { LandingService } from '../../service/landing.ts';

export interface TaskRouteParams {
	readonly taskId: string;
}

export const TASK_ROUTE_PARAMS_PROPERTIES = [
	'taskId',
] as const satisfies readonly (keyof TaskRouteParams)[];

export const taskRouteParamsSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['taskId'],
	properties: {
		taskId: { type: 'string', minLength: 1 },
	},
} as const;

export interface RegisterTasksRoutesOptions {
	readonly landingService?: LandingService;
}

interface ContainerWithLandingService {
	readonly services?: {
		readonly landing?: LandingService;
	};
}

function resolveLandingService(
	request: FastifyRequest,
	instance: FastifyInstance,
	options?: RegisterTasksRoutesOptions,
): LandingService {
	if (options?.landingService) {
		return options.landingService;
	}

	const container =
		(request.server as unknown as { container?: ContainerWithLandingService })?.container ??
		(instance as unknown as { container?: ContainerWithLandingService })?.container;

	const service = container?.services?.landing;
	if (!service) {
		throw new AppError('E_INTERNAL', 'Landing service is not registered in the container');
	}
	return service;
}

function readTaskId(request: FastifyRequest): string {
	const params = request.params as TaskRouteParams | undefined;
	if (!params || typeof params.taskId !== 'string' || params.taskId.trim().length === 0) {
		throw new AppError('E_VALIDATION', 'taskId is required and must be non-empty');
	}
	return params.taskId.trim();
}

/**
 * Registers task routes:
 * - `GET /api/v1/tasks/:taskId/landing`: read-only landing checklist with diff and copyable commands (AC 1, AC 3, E-74)
 * - `POST /api/v1/tasks/:taskId/worktree/cleanup`: explicit worktree reclamation (AC 2, E-73)
 */
export function registerTasksRoutes(
	instance: FastifyInstance,
	options?: RegisterTasksRoutesOptions,
): void {
	const getLandingHandler: RouteHandlerMethod = async (request) => {
		const taskId = readTaskId(request);
		const service = resolveLandingService(request, instance, options);
		return service.getLanding({ taskId });
	};

	const cleanupWorktreeHandler: RouteHandlerMethod = async (request) => {
		const taskId = readTaskId(request);
		const service = resolveLandingService(request, instance, options);
		return service.cleanupWorktree({ taskId });
	};

	instance.get(
		'/api/v1/tasks/:taskId/landing',
		{
			schema: {
				params: taskRouteParamsSchema,
			},
		},
		getLandingHandler,
	);

	instance.post(
		'/api/v1/tasks/:taskId/worktree/cleanup',
		{
			schema: {
				params: taskRouteParamsSchema,
			},
		},
		cleanupWorktreeHandler,
	);
}
