import type {
	ClaimPairBody,
	ClaimPairResponse,
	CreatePairCodeResponse,
} from '@agent-scheduler/shared/api/pair';
import type { FastifyInstance } from 'fastify';

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
