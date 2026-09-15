import {
	type PauseBatchResponse,
	type StartBatchBody,
	type StartBatchResponse,
	startBatchBodySchema,
} from '@agent-scheduler/shared/api/batches';
import type { FastifyInstance, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
import type { DispatchService } from '../../service/dispatch.ts';

export interface BatchRouteParams {
	readonly batchId: string;
}

export const BATCH_ROUTE_PARAMS_PROPERTIES = [
	'batchId',
] as const satisfies readonly (keyof BatchRouteParams)[];

export const batchRouteParamsSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['batchId'],
	properties: {
		batchId: { type: 'string', minLength: 1 },
	},
} as const;

export interface RegisterBatchesRoutesOptions {
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
	options?: RegisterBatchesRoutesOptions,
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

function readBatchId(request: FastifyRequest): string {
	const params = request.params as BatchRouteParams | undefined;
	if (!params || typeof params.batchId !== 'string' || params.batchId.trim().length === 0) {
		throw new AppError('E_VALIDATION', 'batchId is required and must be non-empty');
	}
	return params.batchId.trim();
}

/**
 * Registers batch management routes (M8-T3, AC 3, E-49, E-281):
 * - `POST /api/v1/batches/:batchId/start`: starts a batch if previous batch is done
 * - `POST /api/v1/batches/:batchId/pause`: pauses a batch
 */
export function registerBatchesRoutes(
	instance: FastifyInstance,
	options?: RegisterBatchesRoutesOptions,
): void {
	const startBatchHandler: RouteHandlerMethod = async (request): Promise<StartBatchResponse> => {
		const batchId = readBatchId(request);
		const body = (request.body ?? {}) as StartBatchBody;
		const service = resolveDispatchService(request, instance, options);
		const actorDeviceId = (request as unknown as { actorDeviceId?: string }).actorDeviceId ?? null;

		return await service.startBatch({
			batchId,
			gateOverrides: body.gateOverrides,
			actorDeviceId,
		});
	};

	const pauseBatchHandler: RouteHandlerMethod = async (request): Promise<PauseBatchResponse> => {
		const batchId = readBatchId(request);
		const service = resolveDispatchService(request, instance, options);
		const actorDeviceId = (request as unknown as { actorDeviceId?: string }).actorDeviceId ?? null;

		return await service.pauseBatch({
			batchId,
			actorDeviceId,
		});
	};

	instance.post<{
		Params: BatchRouteParams;
		Body: StartBatchBody;
	}>(
		'/api/v1/batches/:batchId/start',
		{
			schema: {
				params: batchRouteParamsSchema,
				body: startBatchBodySchema,
			},
		},
		startBatchHandler,
	);

	instance.post<{
		Params: BatchRouteParams;
	}>(
		'/api/v1/batches/:batchId/pause',
		{
			schema: {
				params: batchRouteParamsSchema,
			},
		},
		pauseBatchHandler,
	);
}
