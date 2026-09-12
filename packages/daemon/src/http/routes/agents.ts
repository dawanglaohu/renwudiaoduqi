import {
	type AgentParams,
	type ListAgentModelsQuery,
	type ListAgentModelsResponse,
	type ListAgentsResponse,
	type ProbeAgentResponse,
	type UpdateAgentBody,
	type UpdateAgentResponse,
	updateAgentBodySchema,
} from '@agent-scheduler/shared/api/agents';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
import type { AgentService } from '../../service/agents.ts';

export const AGENT_PARAMS_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['agentId'],
	properties: {
		agentId: { type: 'string', minLength: 1, maxLength: 64 },
	},
} as const satisfies {
	readonly type: 'object';
	readonly additionalProperties: false;
	readonly required: readonly (keyof AgentParams)[];
	readonly properties: Readonly<Record<keyof AgentParams, unknown>>;
};

export const LIST_AGENT_MODELS_QUERY_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		refresh: { type: 'string' },
	},
} as const;

export interface RegisterAgentRoutesOptions {
	readonly agentService?: AgentService;
}

interface ContainerWithAgents {
	readonly services?: {
		readonly agents?: AgentService;
		readonly pairing?: {
			authenticateToken(authHeader: string | undefined): { deviceId: string; deviceName: string };
		};
	};
}

function getAgentService(
	request: FastifyRequest,
	options?: RegisterAgentRoutesOptions,
): AgentService {
	const container = request.server.container as ContainerWithAgents | undefined;
	const service = options?.agentService ?? container?.services?.agents;
	if (!service) {
		throw new AppError('E_INTERNAL', 'AgentService is not available in container');
	}
	return service;
}

function requireAuth(request: FastifyRequest): string {
	const container = request.server.container as ContainerWithAgents | undefined;
	const pairingService = container?.services?.pairing;
	if (pairingService) {
		const auth = pairingService.authenticateToken(request.headers.authorization);
		request.actorDeviceId = auth.deviceId;
		return auth.deviceId;
	}
	return 'anonymous';
}

export function registerAgentRoutes(
	instance: FastifyInstance,
	options?: RegisterAgentRoutesOptions,
): void {
	// 1. GET /api/v1/agents
	instance.get('/api/v1/agents', async (request): Promise<ListAgentsResponse> => {
		requireAuth(request);
		const agentService = getAgentService(request, options);
		const agents = await agentService.listAgents();
		return { agents };
	});

	// 2. PATCH /api/v1/agents/:agentId
	instance.patch<{
		Params: AgentParams;
		Body: UpdateAgentBody;
	}>(
		'/api/v1/agents/:agentId',
		{
			schema: {
				params: AGENT_PARAMS_SCHEMA,
				body: updateAgentBodySchema,
			},
		},
		async (request): Promise<UpdateAgentResponse> => {
			requireAuth(request);
			const agentService = getAgentService(request, options);
			const agent = await agentService.updateAgent(request.params.agentId, request.body);
			return { agent };
		},
	);

	// 3. POST /api/v1/agents/:agentId/probe
	instance.post<{
		Params: AgentParams;
	}>(
		'/api/v1/agents/:agentId/probe',
		{
			schema: {
				params: AGENT_PARAMS_SCHEMA,
			},
		},
		async (request): Promise<ProbeAgentResponse> => {
			requireAuth(request);
			const agentService = getAgentService(request, options);
			const result = await agentService.probeAgent(request.params.agentId, { force: true });
			if (!result.canDispatch && !result.matched) {
				if (
					result.status === 'unrecognized' ||
					result.errorDetails?.code === 'E_AGENT_VERSION_UNRECOGNIZED'
				) {
					throw new AppError(
						'E_AGENT_VERSION_UNRECOGNIZED',
						`Probe output did not match any known fingerprint for agent '${request.params.agentId}'.`,
						{ details: result.errorDetails ? { ...result.errorDetails } : undefined },
					);
				}
				throw new AppError(
					'E_AGENT_UNAVAILABLE',
					`Agent '${request.params.agentId}' is unavailable: ${result.errorDetails?.code ?? result.status}.`,
					{ details: result.errorDetails ? { ...result.errorDetails } : undefined },
				);
			}
			return {
				status: result.status,
				versionString: result.versionString,
				matched: result.matched,
			};
		},
	);

	// 4. GET /api/v1/agents/:agentId/models
	instance.get<{
		Params: AgentParams;
		Querystring: ListAgentModelsQuery;
	}>(
		'/api/v1/agents/:agentId/models',
		{
			schema: {
				params: AGENT_PARAMS_SCHEMA,
				querystring: LIST_AGENT_MODELS_QUERY_SCHEMA,
			},
		},
		async (request): Promise<ListAgentModelsResponse> => {
			requireAuth(request);
			const agentService = getAgentService(request, options);
			const refresh = request.query?.refresh === 'true';
			return agentService.listAgentModels(request.params.agentId, { refresh });
		},
	);
}
