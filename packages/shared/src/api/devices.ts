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

export interface RevokeDeviceResponse {
	readonly revokedAt: string;
}
