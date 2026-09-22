import {
	type CreateDocumentBody,
	type CreateDocumentResponse,
	type DocumentDto,
	type ListDocumentBatchesResponse,
	type ListDocumentTasksResponse,
	type ListDocumentsResponse,
	type OpenReaderResponse,
	type RefreshDocumentResponse,
	type UpdateDocumentSettingsBody,
	type UpdateDocumentSettingsResponse,
	createDocumentBodySchema,
	updateDocumentSettingsBodySchema,
} from '@agent-scheduler/shared/api/documents';
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { TASK_STATES } from '../../domain/task-state.ts';
import { AppError } from '../../errors/app-error.ts';
import type { BatchService } from '../../service/batch.ts';
import type { DocsService, DocumentRecord } from '../../service/docs.ts';

export interface DocumentParams {
	readonly docId: string;
}

export const DOCUMENT_PARAMS_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['docId'],
	properties: {
		docId: { type: 'string', minLength: 1 },
	},
} as const;

export interface UpdateDocumentSettingsQuery {
	readonly dismissBanner?: string;
	readonly takeoverNotified?: string;
	readonly isTakeoverNotified?: string;
}

export const UPDATE_DOCUMENT_SETTINGS_QUERY_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		dismissBanner: { type: 'string' },
		takeoverNotified: { type: 'string' },
		isTakeoverNotified: { type: 'string' },
	},
} as const;

export interface ListDocumentTasksQuery {
	readonly batchId?: string;
	readonly state?: string;
	readonly cursor?: string;
	readonly limit?: number;
}

export const LIST_DOCUMENT_TASKS_QUERY_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		batchId: { type: 'string' },
		state: {
			type: 'string',
			enum: TASK_STATES,
		},
		cursor: { type: 'string' },
		limit: { type: 'integer', minimum: 1, maximum: 200 },
	},
} as const;

export interface RegisterDocumentRoutesOptions {
	readonly docsService?: DocsService;
	readonly batchService?: BatchService;
	readonly openBrowser?: (targetPath: string) => Promise<void> | void;
}

interface ContainerWithDocs {
	readonly services?: {
		readonly docs?: DocsService;
		readonly batch?: BatchService;
		readonly pairing?: {
			readonly authenticateToken: (authHeader?: string) => { readonly deviceId: string };
		};
	};
}

function resolveDocsService(
	instance: FastifyInstance,
	options?: RegisterDocumentRoutesOptions,
): DocsService {
	const container = instance.server?.listening
		? (instance.container as ContainerWithDocs | undefined)
		: undefined;
	const service = options?.docsService ?? container?.services?.docs;
	if (service) {
		return service;
	}
	// Fallback to container from fastify instance if decorated
	const decorated = (instance as unknown as { container?: ContainerWithDocs }).container;
	const docsFromDecorated = decorated?.services?.docs;
	if (docsFromDecorated) {
		return docsFromDecorated;
	}
	throw new AppError('E_INTERNAL', 'DocsService is not available in container');
}

function resolveBatchService(
	instance: FastifyInstance,
	options?: RegisterDocumentRoutesOptions,
): BatchService {
	const container = instance.server?.listening
		? (instance.container as ContainerWithDocs | undefined)
		: undefined;
	const service = options?.batchService ?? container?.services?.batch;
	if (service) {
		return service;
	}
	const decorated = (instance as unknown as { container?: ContainerWithDocs }).container;
	const batchFromDecorated = decorated?.services?.batch;
	if (batchFromDecorated) {
		return batchFromDecorated;
	}
	throw new AppError('E_INTERNAL', 'BatchService is not available in container');
}

function authenticateDevice(request: Parameters<RouteHandlerMethod>[0]): string {
	const container = request.server.container as ContainerWithDocs | undefined;
	const pairingService = container?.services?.pairing;
	if (!pairingService) {
		throw new AppError('E_INTERNAL', 'PairingService is not available in container');
	}
	const auth = pairingService.authenticateToken(request.headers.authorization);
	request.actorDeviceId = auth.deviceId;
	return auth.deviceId;
}

function toDocumentDto(doc: DocumentRecord): DocumentDto {
	return {
		id: doc.id,
		docsPath: doc.docsPath,
		projectName: doc.projectName,
		repoPath: doc.repoPath,
		mainBranch: doc.mainBranch,
		branchPrefix: doc.branchPrefix,
		laneCount: doc.laneCount,
		contentFingerprint: doc.contentFingerprint,
		isSourceReadable: doc.isSourceReadable,
		isTakeoverNotified: doc.isTakeoverNotified,
		importedAt: doc.importedAt,
		lastSeenAt: doc.lastSeenAt,
	};
}

export function registerDocumentRoutes(
	instance: FastifyInstance,
	options?: RegisterDocumentRoutesOptions,
): void {
	// GET /api/v1/documents
	instance.get('/api/v1/documents', async (request): Promise<ListDocumentsResponse> => {
		authenticateDevice(request);
		const docsService = options?.docsService ?? resolveDocsService(instance, options);
		const documents = docsService.listDocuments().map(toDocumentDto);
		return { documents };
	});

	// POST /api/v1/documents
	instance.post<{ Body: CreateDocumentBody }>(
		'/api/v1/documents',
		{
			schema: {
				body: createDocumentBodySchema,
			},
		},
		async (request): Promise<CreateDocumentResponse> => {
			authenticateDevice(request);
			const docsService = options?.docsService ?? resolveDocsService(instance, options);
			const result = await docsService.importDocument(request.body.docsPath);
			return {
				document: toDocumentDto(result.document),
				taskCount: result.parsed.tasks.length,
			};
		},
	);

	// POST /api/v1/documents/:docId/open-reader
	instance.post<{ Params: DocumentParams }>(
		'/api/v1/documents/:docId/open-reader',
		{
			schema: {
				params: DOCUMENT_PARAMS_SCHEMA,
			},
		},
		async (request): Promise<OpenReaderResponse> => {
			authenticateDevice(request);
			const docsService = options?.docsService ?? resolveDocsService(instance, options);
			await docsService.openReader(request.params.docId);
			return { opened: true };
		},
	);

	// PATCH /api/v1/documents/:docId/settings
	instance.patch<{
		Params: DocumentParams;
		Body: UpdateDocumentSettingsBody;
		Querystring: UpdateDocumentSettingsQuery;
	}>(
		'/api/v1/documents/:docId/settings',
		{
			schema: {
				params: DOCUMENT_PARAMS_SCHEMA,
				body: updateDocumentSettingsBodySchema,
				querystring: UPDATE_DOCUMENT_SETTINGS_QUERY_SCHEMA,
			},
		},
		async (request): Promise<UpdateDocumentSettingsResponse> => {
			authenticateDevice(request);
			const docsService = options?.docsService ?? resolveDocsService(instance, options);
			const docId = request.params.docId;
			const existing = docsService.getDocumentById(docId);
			if (!existing) {
				throw new AppError('E_NOT_FOUND', `Document not found: ${docId}`, {
					details: { docId },
				});
			}

			docsService.updateLaneCount(docId, request.body.laneCount);

			const query = request.query;
			if (
				query.dismissBanner === 'true' ||
				query.takeoverNotified === 'true' ||
				query.isTakeoverNotified === 'true'
			) {
				docsService.setTakeoverNotified(docId, true);
			}

			const updated = docsService.getDocumentById(docId);
			if (!updated) {
				throw new AppError('E_INTERNAL', `Failed to reload updated document ${docId}`);
			}

			return { document: toDocumentDto(updated) };
		},
	);

	// POST /api/v1/documents/:docId/refresh
	instance.post<{ Params: DocumentParams }>(
		'/api/v1/documents/:docId/refresh',
		{
			schema: {
				params: DOCUMENT_PARAMS_SCHEMA,
			},
		},
		async (request): Promise<RefreshDocumentResponse> => {
			authenticateDevice(request);
			const docsService = options?.docsService ?? resolveDocsService(instance, options);
			return docsService.refreshDocument(request.params.docId);
		},
	);

	// GET /api/v1/documents/:docId/tasks
	instance.get<{
		Params: DocumentParams;
		Querystring: ListDocumentTasksQuery;
	}>(
		'/api/v1/documents/:docId/tasks',
		{
			schema: {
				params: DOCUMENT_PARAMS_SCHEMA,
				querystring: LIST_DOCUMENT_TASKS_QUERY_SCHEMA,
			},
		},
		async (request): Promise<ListDocumentTasksResponse> => {
			authenticateDevice(request);
			const docsService = options?.docsService ?? resolveDocsService(instance, options);
			return docsService.listTasks(request.params.docId, request.query);
		},
	);

	// GET /api/v1/documents/:docId/batches
	instance.get<{ Params: DocumentParams }>(
		'/api/v1/documents/:docId/batches',
		{
			schema: {
				params: DOCUMENT_PARAMS_SCHEMA,
			},
		},
		async (request): Promise<ListDocumentBatchesResponse> => {
			authenticateDevice(request);
			const docsService = options?.docsService ?? resolveDocsService(instance, options);
			const doc = docsService.getDocumentById(request.params.docId);
			if (!doc) {
				throw new AppError('E_NOT_FOUND', `Document not found: ${request.params.docId}`, {
					details: { docId: request.params.docId },
				});
			}
			const batchService = options?.batchService ?? resolveBatchService(instance, options);
			const batches = await batchService.listBatches(request.params.docId);
			return { batches };
		},
	);
}
