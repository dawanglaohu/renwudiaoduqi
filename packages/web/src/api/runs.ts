/**
 * packages/web/src/api/runs.ts
 *
 * 运行 API 客户端（M9-T23 / AC 6, E-348 / 07 节前端架构）
 *
 * 规范依据：
 * - 唯一 fetch 出口是 src/api/http-client.ts，禁止 URL 字面量
 * - 路径与鉴权一律取自 shared ROUTES 表
 * - rerunRun 发送 POST /api/v1/runs/:runId/rerun
 */

import { ROUTES, type RouteDefinition } from '@agent-scheduler/shared/api/routes';
import type {
	CreateRunResponse,
	GetRunResponse,
	ListRunsResponse,
	RerunRunBody,
} from '@agent-scheduler/shared/api/runs';
import { httpClient } from './http-client.ts';

function findRunRoute(method: 'GET' | 'POST', path: string): RouteDefinition {
	const route = ROUTES.find((entry) => entry.method === method && entry.path === path);
	if (!route) {
		throw new Error(`${method} ${path} is missing from the shared ROUTES table`);
	}
	return route;
}

const RERUN_ROUTE = findRunRoute('POST', '/api/v1/runs/:runId/rerun');
const GET_RUN_ROUTE = findRunRoute('GET', '/api/v1/runs/:runId');
const LIST_RUNS_ROUTE = findRunRoute('GET', '/api/v1/runs');

function generateIdempotencyKey(): string {
	return `rerun_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 重新运行指定 Run（POST /runs/:runId/rerun，E-348）。
 */
export function rerunRun(runId: string, idempotencyKey?: string): Promise<CreateRunResponse> {
	const key = idempotencyKey ?? generateIdempotencyKey();
	return httpClient.callRoute<CreateRunResponse, RerunRunBody>(RERUN_ROUTE, {
		params: { runId },
		body: { idempotencyKey: key },
	});
}

/**
 * 获取单个运行详情。
 */
export function getRun(runId: string): Promise<GetRunResponse> {
	return httpClient.callRoute<GetRunResponse>(GET_RUN_ROUTE, {
		params: { runId },
	});
}

/**
 * 列出运行列表。
 */
export function listRuns(): Promise<ListRunsResponse> {
	return httpClient.callRoute<ListRunsResponse>(LIST_RUNS_ROUTE);
}
