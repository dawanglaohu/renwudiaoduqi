import type { FastifyInstance } from 'fastify';

export interface ClaimPairBody {
	readonly code: string;
	readonly deviceName: string;
}

export const CLAIM_PAIR_BODY_KEYS = [
	'code',
	'deviceName',
] as const satisfies readonly (keyof ClaimPairBody)[];

export const CLAIM_PAIR_BODY_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['code', 'deviceName'],
	properties: {
		code: { type: 'string', minLength: 1 },
		deviceName: { type: 'string', minLength: 1 },
	},
} as const satisfies {
	readonly type: 'object';
	readonly additionalProperties: false;
	readonly required: readonly (keyof ClaimPairBody)[];
	readonly properties: Readonly<Record<keyof ClaimPairBody, unknown>>;
};

export interface ClaimPairResponse {
	readonly deviceId: string;
	readonly token: string;
}

export interface CreatePairCodeResponse {
	readonly code: string;
	readonly expiresAt: string;
}

export function registerPairRoutes(instance: FastifyInstance): void {
	instance.post<{ Body: ClaimPairBody }>(
		'/api/v1/pair/claim',
		{
			schema: {
				body: CLAIM_PAIR_BODY_SCHEMA,
			},
		},
		async (request): Promise<ClaimPairResponse> => {
			const pairingService = request.server.container.services.pairing;
			return await pairingService.claimPairingCode({
				code: request.body.code,
				deviceName: request.body.deviceName,
			});
		},
	);

	instance.post('/api/v1/pair/code', async (request): Promise<CreatePairCodeResponse> => {
		const pairingService = request.server.container.services.pairing;
		const auth = pairingService.authenticateToken(request.headers.authorization);
		request.actorDeviceId = auth.deviceId;

		return pairingService.createPairingCode();
	});
}
