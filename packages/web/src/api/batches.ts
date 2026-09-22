/**
 * packages/web/src/api/batches.ts
 *
 * 批次逐任务指派 API 客户端（M9-T18 / 决策 136, AC 5, E-31, E-47, E-52 / 07 节前端架构）
 *
 * 规范依据：
 * - 唯一 fetch 出口是 src/api/http-client.ts，本文件只做资源封装，不自己拼 URL
 * - 路径与鉴权一律取自 `@agent-scheduler/shared/api/routes` 的 ROUTES 表，禁止 URL 字面量
 * - `readAssignments()` 读 daemon 现算的草稿与并发预览；`putAssignments()` 整批覆写并返回同一响应型
 * - 会话序号、agent 占用与满额、有效并发、瓶颈来源全部来自这两个响应，前端只呈现不重算
 */

import type {
	BatchAssignmentsResponse,
	PutAssignmentsBody,
	TaskAssignmentDraft,
} from '@agent-scheduler/shared/api/batches';
import { ROUTES, type RouteDefinition } from '@agent-scheduler/shared/api/routes';
import { httpClient } from './http-client.ts';

/**
 * 批次指派端点（M8-T11，10 节）。两条方法共用同一路径，只有 method 不同。
 */
export const ASSIGNMENTS_PATH = '/api/v1/batches/:batchId/assignments' as const;

function findAssignmentsRoute(method: 'GET' | 'POST'): RouteDefinition {
	const route = ROUTES.find((entry) => entry.method === method && entry.path === ASSIGNMENTS_PATH);
	if (!route) {
		// 契约表缺失时立刻暴露，而不是退回硬编码 URL（07 节：禁止 URL 字面量）
		throw new Error(`${method} ${ASSIGNMENTS_PATH} is missing from the shared ROUTES table`);
	}
	return route;
}

const GET_ASSIGNMENTS_ROUTE = findAssignmentsRoute('GET');
const PUT_ASSIGNMENTS_ROUTE = findAssignmentsRoute('POST');

/**
 * 读取批次逐任务指派草稿与 daemon 现算的并发预览（GET 10 节）。
 */
export function readAssignments(batchId: string): Promise<BatchAssignmentsResponse> {
	return httpClient.callRoute<BatchAssignmentsResponse>(GET_ASSIGNMENTS_ROUTE, {
		params: { batchId },
	});
}

/**
 * 整批覆写本批次的逐任务指派草稿（POST 10 节）。未列出的待派任务由 daemon 置空，
 * 返回值即最新草稿与预览，调用方必须用返回值刷新界面而不是本地推断。
 */
export function putAssignments(
	batchId: string,
	assignments: readonly TaskAssignmentDraft[],
): Promise<BatchAssignmentsResponse> {
	const body: PutAssignmentsBody = { assignments };
	return httpClient.callRoute<BatchAssignmentsResponse, PutAssignmentsBody>(PUT_ASSIGNMENTS_ROUTE, {
		params: { batchId },
		body,
	});
}
