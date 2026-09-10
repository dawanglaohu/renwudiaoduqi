export interface BatchDto {
	readonly id: string;
	readonly docId: string;
	readonly batchNo: number;
	readonly state: 'idle' | 'running' | 'paused' | 'done';
	readonly startedAt: string | null;
	readonly finishedAt: string | null;
}

export interface BatchGateOverrides {
	readonly dispatch?: 'auto' | 'manual';
	readonly review?: 'auto' | 'manual';
}

export interface StartBatchBody {
	readonly gateOverrides?: BatchGateOverrides;
}

export const START_BATCH_BODY_KEYS = [
	'gateOverrides',
] as const satisfies readonly (keyof StartBatchBody)[];

type AssertStartBatchBodyExhaustive = [
	Exclude<keyof StartBatchBody, (typeof START_BATCH_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertStartBatchBody: AssertStartBatchBodyExhaustive = true;

export const startBatchBodySchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		gateOverrides: {
			type: 'object',
			additionalProperties: false,
			properties: {
				dispatch: { type: 'string', enum: ['auto', 'manual'] },
				review: { type: 'string', enum: ['auto', 'manual'] },
			},
		},
	},
} as const;

export interface StartBatchResponse {
	readonly accepted: boolean;
	readonly queued: number;
}

export interface PauseBatchResponse {
	readonly paused: true;
}
