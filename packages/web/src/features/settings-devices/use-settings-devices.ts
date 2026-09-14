import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	DeviceDto,
	ListDevicesResponse,
	RevokeDeviceResponse,
} from '../../../../shared/src/api/devices.ts';
import type { CreatePairingCodeResponse } from '../../../../shared/src/api/pair.ts';
import {
	clearManualHost,
	getManualHost,
	resolveBaseUrl,
	setManualHost,
} from '../../api/base-url.ts';
import { clearCachedToken, isApiError } from '../../api/http-client.ts';
import { httpClient } from '../../api/http-client.ts';
import { ROUTE_PATHS, navigateTo } from '../../app/routes.tsx';
import { isBrowserMode, shellBridge } from '../../shell/shell-bridge.ts';

export const CURRENT_DEVICE_ID_STORAGE_KEY = 'agsched.current_device_id' as const;

export interface UseSettingsDevicesResult {
	readonly devices: readonly DeviceDto[];
	readonly isLoading: boolean;
	readonly error: string | null;
	readonly clearError: () => void;
	readonly refreshDevices: () => Promise<void>;
	readonly newPairingCode: CreatePairingCodeResponse | null;
	readonly codeCountdownSec: number;
	readonly isGeneratingCode: boolean;
	readonly generatePairingCode: () => Promise<void>;
	readonly dismissPairingCode: () => void;
	readonly revokingDevice: DeviceDto | null;
	readonly isRevoking: boolean;
	readonly openRevokeDialog: (device: DeviceDto) => void;
	readonly closeRevokeDialog: () => void;
	readonly confirmRevoke: () => Promise<boolean>;
	readonly currentBaseUrl: string;
	readonly manualHost: string;
	readonly setManualHostInput: (host: string) => void;
	readonly saveManualHostAddress: (host: string) => Promise<void>;
	readonly resetManualHostAddress: () => Promise<void>;
	readonly isBrowser: boolean;
	readonly currentDeviceId: string | null;
}

/**
 * Format ISO8601 date string to readable YYYY-MM-DD HH:mm:ss format.
 */
export function formatIsoDateTime(isoStr?: string | null): string {
	if (!isoStr || !isoStr.trim()) {
		return '—';
	}
	try {
		const date = new Date(isoStr);
		if (Number.isNaN(date.getTime())) {
			return isoStr;
		}
		const y = date.getFullYear();
		const m = String(date.getMonth() + 1).padStart(2, '0');
		const d = String(date.getDate()).padStart(2, '0');
		const h = String(date.getHours()).padStart(2, '0');
		const min = String(date.getMinutes()).padStart(2, '0');
		const s = String(date.getSeconds()).padStart(2, '0');
		return `${y}-${m}-${d} ${h}:${min}:${s}`;
	} catch {
		return isoStr;
	}
}

/**
 * Hook managing devices list, ephemeral pairing code generation, and individual device revocation
 * (M9-T15 / E-09 / E-125 / E-127 / E-228 / E-229).
 */
export function useSettingsDevices(): UseSettingsDevicesResult {
	const isBrowser = isBrowserMode();
	const [devices, setDevices] = useState<readonly DeviceDto[]>([]);
	const [isLoading, setIsLoading] = useState<boolean>(true);
	const [error, setError] = useState<string | null>(null);

	const [newPairingCode, setNewPairingCode] = useState<CreatePairingCodeResponse | null>(null);
	const [codeCountdownSec, setCodeCountdownSec] = useState<number>(0);
	const [isGeneratingCode, setIsGeneratingCode] = useState<boolean>(false);

	const [revokingDevice, setRevokingDevice] = useState<DeviceDto | null>(null);
	const [isRevoking, setIsRevoking] = useState<boolean>(false);

	const [currentBaseUrl, setCurrentBaseUrl] = useState<string>('');
	const [manualHost, setManualHostInput] = useState<string>(() => getManualHost() ?? '');
	const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(() => {
		if (typeof sessionStorage !== 'undefined') {
			return sessionStorage.getItem(CURRENT_DEVICE_ID_STORAGE_KEY);
		}
		return null;
	});

	const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const clearError = useCallback(() => {
		setError(null);
	}, []);

	// Refresh devices list from GET /api/v1/devices (AC 2 & E-127)
	const refreshDevices = useCallback(async () => {
		setIsLoading(true);
		try {
			const res = await httpClient.get<ListDevicesResponse>('/api/v1/devices');
			setDevices(res.devices ?? []);
			setError(null);
		} catch (err: unknown) {
			if (isApiError(err)) {
				setError(err.message || `获取设备列表失败 (${err.code})`);
			} else {
				setError(err instanceof Error ? err.message : '获取设备列表失败');
			}
		} finally {
			setIsLoading(false);
		}
	}, []);

	// Resolve current baseUrl
	const refreshBaseUrl = useCallback(async () => {
		const url = await resolveBaseUrl();
		setCurrentBaseUrl(url);
	}, []);

	useEffect(() => {
		void refreshDevices();
		void refreshBaseUrl();
	}, [refreshDevices, refreshBaseUrl]);

	// Ephemeral pairing code generation for adding other devices (AC 4 / E-125)
	const generatePairingCode = useCallback(async () => {
		setIsGeneratingCode(true);
		setError(null);
		try {
			const res = await httpClient.post<CreatePairingCodeResponse>('/api/v1/pair/code');
			setNewPairingCode(res);

			// Calculate remaining countdown seconds (TTL <= 60s)
			const expiresAtMs = new Date(res.expiresAt).getTime();
			const remainingSec = Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
			setCodeCountdownSec(remainingSec);
		} catch (err: unknown) {
			if (isApiError(err)) {
				setError(err.message || `生成配对码失败 (${err.code})`);
			} else {
				setError(err instanceof Error ? err.message : '生成配对码失败');
			}
		} finally {
			setIsGeneratingCode(false);
		}
	}, []);

	const dismissPairingCode = useCallback(() => {
		setNewPairingCode(null);
		setCodeCountdownSec(0);
		if (countdownTimerRef.current) {
			clearInterval(countdownTimerRef.current);
			countdownTimerRef.current = null;
		}
	}, []);

	// Countdown effect for active pairing code
	useEffect(() => {
		if (!newPairingCode) {
			return;
		}

		if (countdownTimerRef.current) {
			clearInterval(countdownTimerRef.current);
		}

		countdownTimerRef.current = setInterval(() => {
			const expiresAtMs = new Date(newPairingCode.expiresAt).getTime();
			const remainingSec = Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
			setCodeCountdownSec(remainingSec);

			if (remainingSec <= 0) {
				if (countdownTimerRef.current) {
					clearInterval(countdownTimerRef.current);
					countdownTimerRef.current = null;
				}
				setNewPairingCode(null);
			}
		}, 1000);

		return () => {
			if (countdownTimerRef.current) {
				clearInterval(countdownTimerRef.current);
				countdownTimerRef.current = null;
			}
		};
	}, [newPairingCode]);

	// Open/close revocation dialog (dialog whitelist: 吊销设备)
	const openRevokeDialog = useCallback((device: DeviceDto) => {
		setRevokingDevice(device);
	}, []);

	const closeRevokeDialog = useCallback(() => {
		setRevokingDevice(null);
	}, []);

	// Confirm device revocation (AC 2 & E-127)
	const confirmRevoke = useCallback(async (): Promise<boolean> => {
		if (!revokingDevice) {
			return false;
		}

		setIsRevoking(true);
		const deviceIdToRevoke = revokingDevice.id;

		try {
			await httpClient.delete<RevokeDeviceResponse>(`/api/v1/devices/${deviceIdToRevoke}`, {
				params: { deviceId: deviceIdToRevoke },
			});

			setRevokingDevice(null);
			setIsRevoking(false);

			// If current device revoked itself, immediately drop token and redirect to pair (E-127)
			if (currentDeviceId && currentDeviceId === deviceIdToRevoke) {
				await shellBridge.tokenStore.clear();
				clearCachedToken();
				navigateTo(ROUTE_PATHS.pair);
				return true;
			}

			// Refresh list to show revoked status
			await refreshDevices();
			return true;
		} catch (err: unknown) {
			setIsRevoking(false);
			if (isApiError(err)) {
				setError(err.message || `吊销设备失败 (${err.code})`);
			} else {
				setError(err instanceof Error ? err.message : '吊销设备失败');
			}
			return false;
		}
	}, [revokingDevice, currentDeviceId, refreshDevices]);

	// Update manual host fallback (E-09 / E-06)
	const saveManualHostAddress = useCallback(
		async (host: string) => {
			const trimmed = host.trim();
			setManualHost(trimmed);
			setManualHostInput(trimmed);
			await refreshBaseUrl();
		},
		[refreshBaseUrl],
	);

	const resetManualHostAddress = useCallback(async () => {
		clearManualHost();
		setManualHostInput('');
		await refreshBaseUrl();
	}, [refreshBaseUrl]);

	return {
		devices,
		isLoading,
		error,
		clearError,
		refreshDevices,
		newPairingCode,
		codeCountdownSec,
		isGeneratingCode,
		generatePairingCode,
		dismissPairingCode,
		revokingDevice,
		isRevoking,
		openRevokeDialog,
		closeRevokeDialog,
		confirmRevoke,
		currentBaseUrl,
		manualHost,
		setManualHostInput,
		saveManualHostAddress,
		resetManualHostAddress,
		isBrowser,
		currentDeviceId,
	};
}
