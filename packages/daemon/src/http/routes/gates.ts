import {
	type DecideGateBody,
	type DecideGateResponse,
	type ListGatesResponse,
	decideGateBodySchema,
} from '@agent-scheduler/shared/api/gates';
import {
	type UpdateGateSettingsBody,
	type UpdateGateSettingsResponse,
	updateGateSettingsBodySchema,
} from '@agent-scheduler/shared/api/settings';
import type { FastifyInstance, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
import type { AgentService } from '../../service/agents.ts';
import type { GateService } from '../../service/gates.ts';
import type { SettingsService } from '../../service/settings.ts';

export interface GateRouteParams {
	readonly gateId: string;
}

export const GATE_ROUTE_PARAMS_PROPERTIES = [
	'gateId',
] as const satisfies readonly (keyof GateRouteParams)[];

export const gateRouteParamsSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['gateId'],
	properties: {
		gateId: { type: 'string', minLength: 1 },
	},
} as const;

export interface ListGatesQuery {
	readonly pending?: boolean | string;
}

export const listGatesQuerySchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		pending: { type: 'string' },
	},
} as const;

export interface RegisterGateRoutesOptions {
	readonly settingsService?: SettingsService;
	readonly gateService?: GateService;
}

interface ContainerWithGateServices {
	readonly services?: {
		readonly settings?: SettingsService;
		readonly gates?: GateService;
		readonly agents?: AgentService;
	};
}

function resolveSettingsService(
	request: FastifyRequest,
	instance: FastifyInstance,
	options?: RegisterGateRoutesOptions,
): SettingsService {
	if (options?.settingsService) {
		return options.settingsService;
	}

	const container =
		(request.server as unknown as { container?: ContainerWithGateServices })?.container ??
		(instance as unknown as { container?: ContainerWithGateServices })?.container;

	const service = container?.services?.settings;
	if (!service) {
		throw new AppError('E_INTERNAL', 'SettingsService is not available in container');
	}
	return service;
}

function resolveGateService(
	request: FastifyRequest,
	instance: FastifyInstance,
	options?: RegisterGateRoutesOptions,
): GateService {
	if (options?.gateService) {
		return options.gateService;
	}

	const container =
		(request.server as unknown as { container?: ContainerWithGateServices })?.container ??
		(instance as unknown as { container?: ContainerWithGateServices })?.container;

	const service = container?.services?.gates;
	if (!service) {
		throw new AppError('E_INTERNAL', 'GateService is not available in container');
	}
	return service;
}

function readGateId(request: FastifyRequest): string {
	const params = request.params as GateRouteParams | undefined;
	if (!params || typeof params.gateId !== 'string' || params.gateId.trim().length === 0) {
		throw new AppError('E_VALIDATION', 'gateId is required and must be non-empty');
	}
	return params.gateId.trim();
}

/**
 * Registers gate and gate settings routes (M8-T4, AC 1, AC 2, AC 5, E-53, E-57, E-292):
 * - `PATCH /api/v1/settings/gates`: updates gate settings (dispatch, review, landing)
 * - `POST /api/v1/gates/:gateId/decide`: decides a waiting gate (pass/reject, idempotent)
 * - `GET /api/v1/gates`: lists all or pending gates
 */
export function registerGateRoutes(
	instance: FastifyInstance,
	options?: RegisterGateRoutesOptions,
): void {
	const getGateSettingsHandler: RouteHandlerMethod = async (
		request,
	): Promise<UpdateGateSettingsResponse> => {
		const service = resolveSettingsService(request, instance, options);
		const gates = service.getGates();
		return { gates };
	};

	const updateGateSettingsHandler: RouteHandlerMethod = async (
		request,
	): Promise<UpdateGateSettingsResponse> => {
		const body = (request.body ?? {}) as UpdateGateSettingsBody;
		const service = resolveSettingsService(request, instance, options);
		const actorDeviceId = (request as unknown as { actorDeviceId?: string }).actorDeviceId ?? null;

		const gates = service.updateGates(body, actorDeviceId);
		return { gates };
	};

	const decideGateHandler: RouteHandlerMethod = async (request): Promise<DecideGateResponse> => {
		const gateId = readGateId(request);
		const body = (request.body ?? {}) as DecideGateBody;
		const service = resolveGateService(request, instance, options);
		const actorDeviceId = (request as unknown as { actorDeviceId?: string }).actorDeviceId ?? null;

		return await service.decideGate({
			gateId,
			decision: body.decision,
			comment: body.comment,
			actorDeviceId,
		});
	};

	const listGatesHandler: RouteHandlerMethod = async (request): Promise<ListGatesResponse> => {
		const service = resolveGateService(request, instance, options);
		const container =
			(request.server as unknown as { container?: ContainerWithGateServices })?.container ??
			(instance as unknown as { container?: ContainerWithGateServices })?.container;
		const query = (request.query ?? {}) as ListGatesQuery;
		const pendingOnly = query.pending === true || query.pending === 'true' || query.pending === '1';

		return await service.listGates({ pendingOnly, agentService: container?.services?.agents });
	};

	instance.get('/api/v1/settings/gates', getGateSettingsHandler);

	instance.patch<{
		Body: UpdateGateSettingsBody;
	}>(
		'/api/v1/settings/gates',
		{
			schema: {
				body: updateGateSettingsBodySchema,
			},
		},
		updateGateSettingsHandler,
	);

	instance.post<{
		Params: GateRouteParams;
		Body: DecideGateBody;
	}>(
		'/api/v1/gates/:gateId/decide',
		{
			schema: {
				params: gateRouteParamsSchema,
				body: decideGateBodySchema,
			},
		},
		decideGateHandler,
	);

	instance.get<{
		Querystring: ListGatesQuery;
	}>(
		'/api/v1/gates',
		{
			schema: {
				querystring: listGatesQuerySchema,
			},
		},
		listGatesHandler,
	);
}
