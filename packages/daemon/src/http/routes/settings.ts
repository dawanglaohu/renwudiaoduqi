import {
	type GetPipelineSettingsResponse,
	type UpdatePipelineSettingsBody,
	type UpdatePipelineSettingsResponse,
	updatePipelineSettingsBodySchema,
} from '@agent-scheduler/shared/api/settings';
import type { FastifyInstance, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
import type { SettingsService } from '../../service/settings.ts';

export interface RegisterSettingsRoutesOptions {
	readonly settingsService?: SettingsService;
}

interface ContainerWithSettingsService {
	readonly services?: {
		readonly settings?: SettingsService;
	};
}

function resolveSettingsService(
	request: FastifyRequest,
	instance: FastifyInstance,
	options?: RegisterSettingsRoutesOptions,
): SettingsService {
	if (options?.settingsService) {
		return options.settingsService;
	}

	const container =
		(request.server as unknown as { container?: ContainerWithSettingsService })?.container ??
		(instance as unknown as { container?: ContainerWithSettingsService })?.container;

	const service = container?.services?.settings;
	if (!service) {
		throw new AppError('E_INTERNAL', 'SettingsService is not available in container');
	}
	return service;
}

/**
 * Registers pipeline settings routes (M8-T8, AC 5, E-318):
 * - `GET /api/v1/settings/pipeline`: returns current pipeline settings (bughunt, wrapupMode)
 * - `PATCH /api/v1/settings/pipeline`: updates pipeline settings, emits event and nudges tick
 */
export function registerSettingsRoutes(
	instance: FastifyInstance,
	options?: RegisterSettingsRoutesOptions,
): void {
	const getPipelineHandler: RouteHandlerMethod = async (
		request,
	): Promise<GetPipelineSettingsResponse> => {
		const service = resolveSettingsService(request, instance, options);
		const pipeline = service.getPipeline();
		return { pipeline };
	};

	const updatePipelineHandler: RouteHandlerMethod = async (
		request,
	): Promise<UpdatePipelineSettingsResponse> => {
		const body = request.body as UpdatePipelineSettingsBody;
		const service = resolveSettingsService(request, instance, options);
		const actorDeviceId = (request as unknown as { actorDeviceId?: string }).actorDeviceId ?? null;

		const pipeline = service.updatePipeline(body, actorDeviceId);
		return { pipeline };
	};

	instance.get('/api/v1/settings/pipeline', getPipelineHandler);

	instance.patch<{
		Body: UpdatePipelineSettingsBody;
	}>(
		'/api/v1/settings/pipeline',
		{
			schema: {
				body: updatePipelineSettingsBodySchema,
			},
		},
		updatePipelineHandler,
	);
}
