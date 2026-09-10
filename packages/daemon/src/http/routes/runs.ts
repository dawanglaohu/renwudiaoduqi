import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
import type { RunAbortService } from '../../service/run-abort.ts';

export interface AbortRunParams {
	readonly id?: string;
	readonly runId?: string;
}

export const ABORT_RUN_PARAMS_PROPERTIES = [
	'id',
	'runId',
] as const satisfies readonly (keyof AbortRunParams)[];

export const abortRunParamsSchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		id: { type: 'string', minLength: 1 },
		runId: { type: 'string', minLength: 1 },
	},
} as const;

export interface AbortRunBody {
	readonly reason?: string;
}

export const ABORT_RUN_BODY_PROPERTIES = [
	'reason',
] as const satisfies readonly (keyof AbortRunBody)[];

export const abortRunBodySchema = {
	type: 'object',
	nullable: true,
	additionalProperties: false,
	properties: {
		reason: { type: 'string' },
	},
} as const;

export interface RegisterRunsRoutesOptions {
	readonly runAbortService?: RunAbortService;
}

interface ContainerWithRunAbort {
	readonly services?: {
		readonly runAbort?: RunAbortService;
	};
}

/**
 * Registers run management routes:
 * - `POST /api/v1/runs/:id/abort` (10-接口约定 端点总表)
 */
export function registerRunsRoutes(
	instance: FastifyInstance,
	options?: RegisterRunsRoutesOptions,
): void {
	const abortHandler: RouteHandlerMethod = async (request) => {
		const params = request.params as AbortRunParams;
		const body = (request.body ?? {}) as AbortRunBody;

		const container = request.server.container as ContainerWithRunAbort | undefined;
		const service = options?.runAbortService ?? container?.services?.runAbort;

		if (!service) {
			throw new AppError('E_INTERNAL', 'RunAbortService is not available in container');
		}

		const actorDeviceId = (request as unknown as { actorDeviceId?: string }).actorDeviceId ?? null;

		const result = await service.abortRun({
			runId: params.runId ?? params.id ?? '',
			reason: body.reason,
			actorDeviceId,
		});

		return { accepted: result.accepted };
	};

	instance.post<{
		Params: AbortRunParams;
		Body: AbortRunBody;
	}>(
		'/api/v1/runs/:runId/abort',
		{
			schema: {
				params: abortRunParamsSchema,
				body: abortRunBodySchema,
			},
		},
		abortHandler,
	);
}
