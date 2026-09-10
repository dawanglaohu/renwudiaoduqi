import type {
	DeviceParams,
	DeviceRevokeResponse,
	DevicesListResponse,
} from '@agent-scheduler/shared/api/devices';
import type { FastifyInstance } from 'fastify';

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
