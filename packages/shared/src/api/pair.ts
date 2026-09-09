export interface ClaimPairingCodeBody {
	readonly code: string;
	readonly deviceName: string;
}

export const CLAIM_PAIRING_CODE_BODY_KEYS = [
	'code',
	'deviceName',
] as const satisfies readonly (keyof ClaimPairingCodeBody)[];

type AssertClaimPairingCodeBodyExhaustive = [
	Exclude<keyof ClaimPairingCodeBody, (typeof CLAIM_PAIRING_CODE_BODY_KEYS)[number]>,
] extends [never]
	? true
	: never;
const _assertClaimPairingCodeBody: AssertClaimPairingCodeBodyExhaustive = true;

export const claimPairingCodeBodySchema = {
	type: 'object',
	additionalProperties: false,
	required: ['code', 'deviceName'],
	properties: {
		code: { type: 'string', minLength: 1, maxLength: 64 },
		deviceName: { type: 'string', minLength: 1, maxLength: 128 },
	},
} as const;

export interface ClaimPairingCodeResponse {
	readonly deviceId: string;
	readonly token: string;
}

export interface CreatePairingCodeResponse {
	readonly code: string;
	readonly expiresAt: string;
}
