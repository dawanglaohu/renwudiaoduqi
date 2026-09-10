export interface DeviceDto {
	readonly id: string;
	readonly name: string;
	readonly pairedAt: string;
	readonly lastSeenAt: string | null;
	readonly revokedAt: string | null;
}

export interface ListDevicesResponse {
	readonly devices: readonly DeviceDto[];
}

export type DevicesListResponse = ListDevicesResponse;

export interface RevokeDeviceResponse {
	readonly revokedAt: string;
}

export type DeviceRevokeResponse = RevokeDeviceResponse;

export interface DeviceParams {
	readonly deviceId: string;
}

export const DEVICE_PARAMS_KEYS = ['deviceId'] as const satisfies readonly (keyof DeviceParams)[];
