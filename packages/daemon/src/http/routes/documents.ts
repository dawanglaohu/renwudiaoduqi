import {
	type CreateDocumentBody,
	type CreateDocumentResponse,
	type DocumentDto,
	type ListDocumentsResponse,
	type OpenReaderResponse,
	type UpdateDocumentSettingsBody,
	type UpdateDocumentSettingsResponse,
	createDocumentBodySchema,
	updateDocumentSettingsBodySchema,
} from '@agent-scheduler/shared/api/documents';
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { AppError } from '../../errors/app-error.ts';
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

export interface RegisterDocumentRoutesOptions {
	readonly docsService?: DocsService;
	readonly openBrowser?: (targetPath: string) => Promise<void> | void;
}

interface ContainerWithDocs {
	readonly services?: {
		readonly docs?: DocsService;
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
}
