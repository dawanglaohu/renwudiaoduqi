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

export interface PipelineSettings {
	readonly bughunt: 0 | 1;
	readonly wrapupMode: 'auto' | 'manual';
}

export interface UpdatePipelineSettingsBody {
	readonly bughunt: 0 | 1;
	readonly wrapupMode: 'auto' | 'manual';
}

export const UPDATE_PIPELINE_SETTINGS_BODY_KEYS = [
	'bughunt',
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
	required: ['bughunt', 'wrapupMode'],
	properties: {
		bughunt: { type: 'integer', enum: [0, 1] },
		wrapupMode: { type: 'string', enum: ['auto', 'manual'] },
	},
} as const;

export interface GetPipelineSettingsResponse {
	readonly pipeline: PipelineSettings;
}

export interface UpdatePipelineSettingsResponse {
	readonly pipeline: PipelineSettings;
}
