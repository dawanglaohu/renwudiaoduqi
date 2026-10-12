import type { EffortValue } from './agents.ts';

export type DocumentExecutionState = 'idle' | 'running' | 'paused' | 'completed';

export type DocumentExecutionBlockerCode =
	| 'gate_waiting'
	| 'awaiting_landing'
	| 'wrapup_manual'
	| 'wrapup_attention'
	| 'task_failed'
	| 'source_unreadable'
	| 'doc_changed'
	| 'contract_pending'
	| 'agent_unavailable'
	| 'agent_capacity'
	| 'path_conflict'
	| 'legacy_batches_active'
	| 'source_runs_pending';

export interface DocumentDefaultAssignment {
	readonly agentId: string;
	readonly modelName: string | null;
	readonly effort: EffortValue;
}

export interface DocumentExecutionBlocker {
	readonly code: DocumentExecutionBlockerCode;
	readonly batchId: string | null;
	readonly taskIds: readonly string[];
}

export interface DocumentExecutionDto {
	readonly docId: string;
	readonly state: DocumentExecutionState;
	readonly version: number;
	readonly contentFingerprint: string | null;
	readonly defaultAssignment: DocumentDefaultAssignment | null;
	readonly currentBatchId: string | null;
	readonly currentBatchNo: number | null;
	readonly completedBatchCount: number;
	readonly totalBatchCount: number;
	readonly pauseReason: string | null;
	readonly blockers: readonly DocumentExecutionBlocker[];
	readonly canStart: boolean;
	readonly canPause: boolean;
	readonly canResume: boolean;
	readonly updatedAt: string | null;
	readonly wrapupProgress: {
		readonly generationId: number;
		readonly validRounds: number;
		readonly physicalAttempts: number;
	} | null;
}

export interface DocumentExecutionResponse {
	readonly execution: DocumentExecutionDto;
}

export interface StartDocumentExecutionBody {
	readonly expectedVersion: number;
	readonly expectedFingerprint: string;
	readonly defaultAssignment: DocumentDefaultAssignment;
}

export interface PauseDocumentExecutionBody {
	readonly expectedVersion: number;
}

export interface ResumeDocumentExecutionBody extends PauseDocumentExecutionBody {
	readonly expectedFingerprint: string;
}

export const START_DOCUMENT_EXECUTION_BODY_KEYS = [
	'defaultAssignment',
	'expectedFingerprint',
	'expectedVersion',
] as const satisfies readonly (keyof StartDocumentExecutionBody)[];
export const PAUSE_DOCUMENT_EXECUTION_BODY_KEYS = [
	'expectedVersion',
] as const satisfies readonly (keyof PauseDocumentExecutionBody)[];
export const RESUME_DOCUMENT_EXECUTION_BODY_KEYS = [
	'expectedFingerprint',
	'expectedVersion',
] as const satisfies readonly (keyof ResumeDocumentExecutionBody)[];

const expectedVersion = { type: 'integer', minimum: 0 } as const;
const expectedFingerprint = { type: 'string', minLength: 1 } as const;
const effort = {
	anyOf: [
		{ type: 'null' },
		{
			type: 'object',
			additionalProperties: false,
			required: ['tier'],
			properties: { tier: { type: 'string', enum: ['low', 'medium', 'high'] } },
		},
		{
			type: 'object',
			additionalProperties: false,
			required: ['vendor'],
			properties: { vendor: { type: 'string', minLength: 1, maxLength: 64 } },
		},
	],
} as const;

export const startDocumentExecutionBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['expectedVersion', 'expectedFingerprint', 'defaultAssignment'],
	properties: {
		expectedVersion,
		expectedFingerprint,
		defaultAssignment: {
			type: 'object',
			additionalProperties: false,
			required: ['agentId', 'modelName', 'effort'],
			properties: {
				agentId: { type: 'string', minLength: 1, maxLength: 64 },
				modelName: { type: ['string', 'null'], minLength: 1, maxLength: 256 },
				effort,
			},
		},
	},
} as const;

export const pauseDocumentExecutionBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['expectedVersion'],
	properties: { expectedVersion },
} as const;

export const resumeDocumentExecutionBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['expectedVersion', 'expectedFingerprint'],
	properties: { expectedVersion, expectedFingerprint },
} as const;
