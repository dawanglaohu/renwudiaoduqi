import type { BatchDto } from './batches.ts';
import type { TaskDto } from './tasks.ts';

export interface DocumentDto {
	readonly id: string;
	readonly docsPath: string;
	readonly projectName: string;
	readonly repoPath: string | null;
	readonly mainBranch: string;
	readonly branchPrefix: string;
	readonly laneCount: number;
	readonly contentFingerprint: string;
	readonly isSourceReadable: boolean;
	readonly isTakeoverNotified: boolean;
	readonly importedAt: string;
	readonly lastSeenAt: string;
}

export interface CreateDocumentBody {
	readonly docsPath: string;
}

export const CREATE_DOCUMENT_BODY_KEYS = [
	'docsPath',
] as const satisfies readonly (keyof CreateDocumentBody)[];

type AssertCreateDocumentBodyExhaustive = [
	Exclude<keyof CreateDocumentBody, (typeof CREATE_DOCUMENT_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertCreateDocumentBody: AssertCreateDocumentBodyExhaustive = true;

export const createDocumentBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['docsPath'],
	properties: {
		docsPath: { type: 'string', minLength: 1, maxLength: 4096, pattern: 'docs-data\\.js$' },
	},
} as const;

export interface CreateDocumentResponse {
	readonly document: DocumentDto;
	readonly taskCount: number;
}

export interface RefreshDocumentResponse {
	readonly changed: boolean;
	readonly flags: {
		readonly hasAcceptChanged: boolean;
		readonly hasPromptChanged: boolean;
		readonly isRemovedFromDoc: boolean;
	};
}

export interface OpenReaderResponse {
	readonly opened: true;
}

export interface UpdateDocumentSettingsBody {
	readonly laneCount: number;
}

export const UPDATE_DOCUMENT_SETTINGS_BODY_KEYS = [
	'laneCount',
] as const satisfies readonly (keyof UpdateDocumentSettingsBody)[];

type AssertUpdateDocumentSettingsBodyExhaustive = [
	Exclude<keyof UpdateDocumentSettingsBody, (typeof UPDATE_DOCUMENT_SETTINGS_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertUpdateDocumentSettingsBody: AssertUpdateDocumentSettingsBodyExhaustive = true;

export const updateDocumentSettingsBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['laneCount'],
	properties: {
		laneCount: { type: 'integer', minimum: 1, maximum: 6 },
	},
} as const;

export interface UpdateDocumentSettingsResponse {
	readonly document: DocumentDto;
}

export interface ListDocumentTasksResponse {
	readonly tasks: readonly TaskDto[];
	readonly nextCursor: string | null;
}

export interface ListDocumentBatchesResponse {
	readonly batches: readonly BatchDto[];
}

export interface ListDocumentsResponse {
	readonly documents: readonly DocumentDto[];
}
