import type { FastifyInstance } from 'fastify';
import type { DeviceDto } from '../../service/pairing.ts';

export interface DeviceParams {
	readonly deviceId: string;
}

export const DEVICE_PARAMS_KEYS = ['deviceId'] as const satisfies readonly (keyof DeviceParams)[];

export const DEVICE_PARAMS_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['deviceId'],
	properties: {
		deviceId: { type: 'string', minLength: 1 },
	},
} as const satisfies {
	readonly type: 'object';
	readonly additionalProperties: false;
	readonly required: readonly (keyof DeviceParams)[];
	readonly properties: Readonly<Record<keyof DeviceParams, unknown>>;
};

export interface DevicesListResponse {
	readonly devices: readonly DeviceDto[];
}

export interface DeviceRevokeResponse {
	readonly revokedAt: string;
}

export function registerDeviceRoutes(instance: FastifyInstance): void {
	instance.get('/api/v1/devices', async (request): Promise<DevicesListResponse> => {
		const pairingService = request.server.container.services.pairing;
		const auth = pairingService.authenticateToken(request.headers.authorization);
		request.actorDeviceId = auth.deviceId;

		const devices = pairingService.listDevices();
		return { devices };
	});

	instance.delete<{ Params: DeviceParams }>(
		'/api/v1/devices/:deviceId',
		{
			schema: {
				params: DEVICE_PARAMS_SCHEMA,
			},
		},
		async (request): Promise<DeviceRevokeResponse> => {
			const pairingService = request.server.container.services.pairing;
			const auth = pairingService.authenticateToken(request.headers.authorization);
			request.actorDeviceId = auth.deviceId;

			return pairingService.revokeDevice(request.params.deviceId);
		},
	);
}
