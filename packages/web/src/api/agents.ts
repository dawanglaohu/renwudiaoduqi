/**
 * packages/web/src/api/agents.ts
 *
 * Agent 注册表与模型清单 API 客户端（M9-T23 / AC 4, E-338, E-339 / 07 节前端架构）
 *
 * 规范依据：
 * - 唯一 fetch 出口是 src/api/http-client.ts，禁止 URL 字面量
 * - 路径与鉴权一律取自 shared ROUTES 表
 * - listModels(agentId, { refresh }) 当 refresh 为 true 时 query 精确为 ?refresh=1
 */

import type {
	AgentParams,
	ListAgentModelsQuery,
	ListAgentModelsResponse,
	ListAgentsResponse,
	ProbeAgentResponse,
	UpdateAgentBody,
	UpdateAgentResponse,
} from '@agent-scheduler/shared/api/agents';
import { ROUTES, type RouteDefinition } from '@agent-scheduler/shared/api/routes';
import { httpClient } from './http-client.ts';

function findAgentRoute(method: 'GET' | 'POST' | 'PATCH', path: string): RouteDefinition {
	const route = ROUTES.find((entry) => entry.method === method && entry.path === path);
	if (!route) {
		throw new Error(`${method} ${path} is missing from the shared ROUTES table`);
	}
	return route;
}

const LIST_AGENTS_ROUTE = findAgentRoute('GET', '/api/v1/agents');
const LIST_MODELS_ROUTE = findAgentRoute('GET', '/api/v1/agents/:agentId/models');
const UPDATE_AGENT_ROUTE = findAgentRoute('PATCH', '/api/v1/agents/:agentId');
const PROBE_AGENT_ROUTE = findAgentRoute('POST', '/api/v1/agents/:agentId/probe');

export interface ListModelsOptions {
	readonly refresh?: boolean;
}

/**
 * 拉取指定 Agent 的模型清单。
 * refresh 为 true 时 query 精确为 refresh=1。
 */
export function listModels(
	agentId: string,
	options?: ListModelsOptions,
): Promise<ListAgentModelsResponse> {
	const query: ListAgentModelsQuery | undefined = options?.refresh
		? { refresh: '1' }
		: undefined;

	return httpClient.callRoute<ListAgentModelsResponse, void, AgentParams, ListAgentModelsQuery>(
		LIST_MODELS_ROUTE,
		{
			params: { agentId },
			query,
		},
	);
}

/**
 * 拉取全量 Agent 注册表清单。
 */
export function listAgents(): Promise<ListAgentsResponse> {
	return httpClient.callRoute<ListAgentsResponse>(LIST_AGENTS_ROUTE);
}

/**
 * 更新指定 Agent 的设置覆盖（包含 clearOverrides 清除覆盖）。
 */
export function updateAgent(
	agentId: string,
	body: UpdateAgentBody,
): Promise<UpdateAgentResponse> {
	return httpClient.callRoute<UpdateAgentResponse, UpdateAgentBody, AgentParams>(
		UPDATE_AGENT_ROUTE,
		{
			params: { agentId },
			body,
		},
	);
}

/**
 * 重新探测指定 Agent。
 */
export function probeAgent(agentId: string): Promise<ProbeAgentResponse> {
	return httpClient.callRoute<ProbeAgentResponse, void, AgentParams>(PROBE_AGENT_ROUTE, {
		params: { agentId },
	});
}
