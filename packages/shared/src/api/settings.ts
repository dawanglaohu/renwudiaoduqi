import type { EffortTier } from './agents.ts';

export interface GateSettings {
	readonly dispatch: 'auto' | 'manual';
	readonly review: 'auto' | 'manual';
	readonly landing: 'auto' | 'manual';
}

export interface UpdateGateSettingsBody {
	readonly dispatch: 'auto' | 'manual';
	readonly review: 'auto' | 'manual';
	readonly landing: 'auto' | 'manual';
}

export const UPDATE_GATE_SETTINGS_BODY_KEYS = [
	'dispatch',
	'landing',
	'review',
] as const satisfies readonly (keyof UpdateGateSettingsBody)[];

type AssertUpdateGateSettingsBodyExhaustive = [
	Exclude<keyof UpdateGateSettingsBody, (typeof UPDATE_GATE_SETTINGS_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertUpdateGateSettingsBody: AssertUpdateGateSettingsBodyExhaustive = true;

export const updateGateSettingsBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['dispatch', 'review', 'landing'],
	properties: {
		dispatch: { type: 'string', enum: ['auto', 'manual'] },
		review: { type: 'string', enum: ['auto', 'manual'] },
		landing: { type: 'string', enum: ['auto', 'manual'] },
	},
} as const;

export interface UpdateGateSettingsResponse {
	readonly gates: GateSettings;
}

export interface ReviewOverride {
	readonly agentId: string;
	readonly modelName?: string | null;
	readonly effortTier?: EffortTier | null;
}

export interface WrapupAssignmentFollow {
	readonly mode: 'follow';
}

export interface WrapupAssignmentFixed {
	readonly mode: 'fixed';
	readonly agentId: string;
	readonly modelName?: string | null;
	readonly effortTier?: EffortTier | null;
}

export type WrapupAssignment = WrapupAssignmentFollow | WrapupAssignmentFixed;

export interface PipelineSettings {
	readonly bughunt: 0 | 1;
	readonly wrapupMode: 'auto' | 'manual';
	readonly reviewOverride: ReviewOverride | null;
	readonly wrapupAssignment: WrapupAssignment;
}

export interface UpdatePipelineSettingsBody {
	readonly bughunt: 0 | 1;
	readonly wrapupMode: 'auto' | 'manual';
	readonly reviewOverride: ReviewOverride | null;
	readonly wrapupAssignment: WrapupAssignment;
}

export const UPDATE_PIPELINE_SETTINGS_BODY_KEYS = [
	'bughunt',
	'reviewOverride',
	'wrapupAssignment',
	'wrapupMode',
] as const satisfies readonly (keyof UpdatePipelineSettingsBody)[];

type AssertUpdatePipelineSettingsBodyExhaustive = [
	Exclude<keyof UpdatePipelineSettingsBody, (typeof UPDATE_PIPELINE_SETTINGS_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertUpdatePipelineSettingsBody: AssertUpdatePipelineSettingsBodyExhaustive = true;

export const updatePipelineSettingsBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['bughunt', 'wrapupMode', 'reviewOverride', 'wrapupAssignment'],
	properties: {
		bughunt: { type: 'integer', enum: [0, 1] },
		wrapupMode: { type: 'string', enum: ['auto', 'manual'] },
		reviewOverride: {
			anyOf: [
				{ type: 'null' },
				{
					type: 'object',
					additionalProperties: false,
					required: ['agentId'],
					properties: {
						agentId: { type: 'string', minLength: 1, maxLength: 64 },
						modelName: { type: ['string', 'null'], maxLength: 256 },
						effortTier: {
							type: ['string', 'null'],
							enum: ['low', 'medium', 'high', null],
						},
					},
				},
			],
		},
		wrapupAssignment: {
			anyOf: [
				{
					type: 'object',
					additionalProperties: false,
					required: ['mode'],
					properties: {
						mode: { type: 'string', const: 'follow' },
					},
				},
				{
					type: 'object',
					additionalProperties: false,
					required: ['mode', 'agentId'],
					properties: {
						mode: { type: 'string', const: 'fixed' },
						agentId: { type: 'string', minLength: 1, maxLength: 64 },
						modelName: { type: ['string', 'null'], maxLength: 256 },
						effortTier: {
							type: ['string', 'null'],
							enum: ['low', 'medium', 'high', null],
						},
					},
				},
			],
		},
	},
} as const;

export interface GetPipelineSettingsResponse {
	readonly pipeline: PipelineSettings;
}

export interface UpdatePipelineSettingsResponse {
	readonly pipeline: PipelineSettings;
}
