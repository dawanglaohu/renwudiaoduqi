/**
 * 文档执行计划的只读与控制请求（M9-T30）。
 * 路径只从共享 ROUTES 表取出。调用方传入的请求体原样发送，传输层不改 expectedVersion。
 */

import type {
	DocumentExecutionResponse,
	PauseDocumentExecutionBody,
	ResumeDocumentExecutionBody,
	StartDocumentExecutionBody,
} from '@agent-scheduler/shared/api/document-execution';
import type {
	ListDocumentsResponse,
	RefreshDocumentResponse,
} from '@agent-scheduler/shared/api/documents';
import { ROUTES, type RouteDefinition } from '@agent-scheduler/shared/api/routes';
import { httpClient } from './http-client.ts';

function findRoute(method: 'GET' | 'POST', path: string): RouteDefinition {
	const route = ROUTES.find((entry) => entry.method === method && entry.path === path);
	if (!route) {
		throw new Error(`${method} ${path} is missing from the shared ROUTES table`);
	}
	return route;
}

const GET_EXECUTION_ROUTE = findRoute('GET', '/api/v1/documents/:docId/execution');
const START_EXECUTION_ROUTE = findRoute('POST', '/api/v1/documents/:docId/execution/start');
const PAUSE_EXECUTION_ROUTE = findRoute('POST', '/api/v1/documents/:docId/execution/pause');
const RESUME_EXECUTION_ROUTE = findRoute('POST', '/api/v1/documents/:docId/execution/resume');
const LIST_DOCUMENTS_ROUTE = findRoute('GET', '/api/v1/documents');
const REFRESH_DOCUMENT_ROUTE = findRoute('POST', '/api/v1/documents/:docId/refresh');

export function getDocumentExecution(docId: string): Promise<DocumentExecutionResponse> {
	return httpClient.callRoute<DocumentExecutionResponse>(GET_EXECUTION_ROUTE, {
		params: { docId },
	});
}

export function startDocumentExecution(
	docId: string,
	body: StartDocumentExecutionBody,
): Promise<DocumentExecutionResponse> {
	return httpClient.callRoute<DocumentExecutionResponse, StartDocumentExecutionBody>(
		START_EXECUTION_ROUTE,
		{ params: { docId }, body },
	);
}

export function pauseDocumentExecution(
	docId: string,
	body: PauseDocumentExecutionBody,
): Promise<DocumentExecutionResponse> {
	return httpClient.callRoute<DocumentExecutionResponse, PauseDocumentExecutionBody>(
		PAUSE_EXECUTION_ROUTE,
		{ params: { docId }, body },
	);
}

export function resumeDocumentExecution(
	docId: string,
	body: ResumeDocumentExecutionBody,
): Promise<DocumentExecutionResponse> {
	return httpClient.callRoute<DocumentExecutionResponse, ResumeDocumentExecutionBody>(
		RESUME_EXECUTION_ROUTE,
		{ params: { docId }, body },
	);
}

export function listExecutionDocuments(): Promise<ListDocumentsResponse> {
	return httpClient.callRoute<ListDocumentsResponse>(LIST_DOCUMENTS_ROUTE);
}

export function refreshExecutionDocument(docId: string): Promise<RefreshDocumentResponse> {
	return httpClient.callRoute<RefreshDocumentResponse>(REFRESH_DOCUMENT_ROUTE, {
		params: { docId },
		body: {},
	});
}
