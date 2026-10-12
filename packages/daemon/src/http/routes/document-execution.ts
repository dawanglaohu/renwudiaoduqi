import {
	type PauseDocumentExecutionBody,
	type ResumeDocumentExecutionBody,
	type StartDocumentExecutionBody,
	pauseDocumentExecutionBodySchema,
	resumeDocumentExecutionBodySchema,
	startDocumentExecutionBodySchema,
} from '@agent-scheduler/shared/api/document-execution';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
import type { DocumentExecutionService } from '../../service/document-execution.ts';

const paramsSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['docId'],
	properties: { docId: { type: 'string', minLength: 1 } },
} as const;

function resolveService(request: FastifyRequest): DocumentExecutionService {
	const container = (
		request.server as unknown as {
			container?: { services?: { documentExecution?: DocumentExecutionService } };
		}
	).container;
	const service = container?.services?.documentExecution;
	if (!service) throw new AppError('E_INTERNAL', 'Document execution service is not available.');
	return service;
}

export function registerDocumentExecutionRoutes(instance: FastifyInstance): void {
	instance.get<{ Params: { docId: string } }>(
		'/api/v1/documents/:docId/execution',
		{ schema: { params: paramsSchema } },
		(request) => resolveService(request).get(request.params.docId),
	);
	instance.post<{ Params: { docId: string }; Body: StartDocumentExecutionBody }>(
		'/api/v1/documents/:docId/execution/start',
		{ schema: { params: paramsSchema, body: startDocumentExecutionBodySchema } },
		(request) => resolveService(request).start(request.params.docId, request.body),
	);
	instance.post<{ Params: { docId: string }; Body: PauseDocumentExecutionBody }>(
		'/api/v1/documents/:docId/execution/pause',
		{ schema: { params: paramsSchema, body: pauseDocumentExecutionBodySchema } },
		(request) => resolveService(request).pause(request.params.docId, request.body),
	);
	instance.post<{ Params: { docId: string }; Body: ResumeDocumentExecutionBody }>(
		'/api/v1/documents/:docId/execution/resume',
		{ schema: { params: paramsSchema, body: resumeDocumentExecutionBodySchema } },
		(request) => resolveService(request).resume(request.params.docId, request.body),
	);
}
