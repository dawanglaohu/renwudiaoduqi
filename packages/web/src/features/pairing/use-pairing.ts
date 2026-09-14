import { useCallback, useState } from 'react';
import type {
	ClaimPairingCodeBody,
	ClaimPairingCodeResponse,
} from '../../../../shared/src/api/pair.ts';
import { getManualHost, resolveBaseUrl, setManualHost } from '../../api/base-url.ts';
import { isApiError, setCachedToken } from '../../api/http-client.ts';
import { httpClient } from '../../api/http-client.ts';
import { ROUTE_PATHS, navigateTo } from '../../app/routes.tsx';
import { isBrowserMode, shellBridge } from '../../shell/shell-bridge.ts';

export interface PairingErrorState {
	readonly stage: 'network' | 'code' | 'ratelimit' | 'validation' | 'general';
	readonly message: string;
	readonly hostPort?: string;
	readonly code?: string;
}

export interface UsePairingOptions {
	readonly onSuccess?: (response: ClaimPairingCodeResponse) => void;
	readonly defaultHost?: string;
}

export interface UsePairingResult {
	readonly pairingCode: string;
	readonly setPairingCode: (code: string) => void;
	readonly deviceName: string;
	readonly setDeviceName: (name: string) => void;
	readonly manualHost: string;
	readonly setManualHostInput: (host: string) => void;
	readonly showManualHost: boolean;
	readonly setShowManualHost: (show: boolean) => void;
	readonly isSubmitting: boolean;
	readonly error: PairingErrorState | null;
	readonly clearError: () => void;
	readonly isSuccess: boolean;
	readonly isBrowser: boolean;
	readonly submitPairing: () => Promise<boolean>;
	readonly saveManualAddress: (host: string) => void;
}

/**
 * Format current date & time as "MM-DD HH:mm" for default browser device naming (E-228).
 */
export function formatBrowserDeviceTimestamp(date: Date = new Date()): string {
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	return `${month}-${day} ${hours}:${minutes}`;
}

/**
 * Generate default device name based on platform and timestamp (AC 7 / E-228).
 * In browser mode: defaults to "浏览器 · MM-DD HH:mm".
 * In native shells: defaults to "桌面端" or "手机端".
 */
export function generateDefaultDeviceName(isBrowser: boolean, now: Date = new Date()): string {
	if (isBrowser) {
		return `浏览器 · ${formatBrowserDeviceTimestamp(now)}`;
	}
	if (shellBridge.platform === 'capacitor') {
		return '手机端';
	}
	return '桌面端';
}

/**
 * Extract `host:port` string from a baseUrl for readable error reporting (E-06).
 */
export function extractHostPort(urlStr: string): string {
	if (!urlStr || !urlStr.trim()) {
		return '';
	}
	try {
		const withProtocol = /^https?:\/\//i.test(urlStr) ? urlStr : `http://${urlStr}`;
		const parsed = new URL(withProtocol);
		return parsed.host || urlStr;
	} catch {
		return urlStr.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
	}
}

/**
 * Pairing hook managing device claim lifecycle and connection fallbacks (M9-T15 / E-06 / E-09 / E-228 / E-229).
 */
export function usePairing(options?: UsePairingOptions): UsePairingResult {
	const isBrowser = isBrowserMode();
	const [pairingCode, setPairingCode] = useState<string>('');
	const [deviceName, setDeviceName] = useState<string>(() => generateDefaultDeviceName(isBrowser));
	const [manualHost, setManualHostInput] = useState<string>(
		() => options?.defaultHost ?? getManualHost() ?? '',
	);
	const [showManualHost, setShowManualHost] = useState<boolean>(false);
	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
	const [error, setError] = useState<PairingErrorState | null>(null);
	const [isSuccess, setIsSuccess] = useState<boolean>(false);

	const clearError = useCallback(() => {
		setError(null);
	}, []);

	const saveManualAddress = useCallback((host: string) => {
		const trimmed = host.trim();
		setManualHost(trimmed);
		setManualHostInput(trimmed);
	}, []);

	const submitPairing = useCallback(async (): Promise<boolean> => {
		const code = pairingCode.trim();
		const name = deviceName.trim();

		if (!code) {
			setError({
				stage: 'validation',
				message: '请输入配对码',
				code: 'E_VALIDATION',
			});
			return false;
		}

		if (!name) {
			setError({
				stage: 'validation',
				message: '请输入设备名称',
				code: 'E_VALIDATION',
			});
			return false;
		}

		setIsSubmitting(true);
		setError(null);

		// Resolve current target baseUrl and hostPort for diagnostic reporting (E-06)
		const targetBaseUrl = await resolveBaseUrl();
		const targetHostPort = extractHostPort(targetBaseUrl);

		try {
			const body: ClaimPairingCodeBody = {
				code,
				deviceName: name,
			};

			const response = await httpClient.post<ClaimPairingCodeResponse, ClaimPairingCodeBody>(
				'/api/v1/pair/claim',
				body,
				{ auth: 'none' },
			);

			// Save token to shell tokenStore (sessionStorage in browser mode, native storage in shell, E-227 / E-229)
			await shellBridge.tokenStore.set(response.token);
			setCachedToken(response.token);

			// Persist manual host if the user specified one (E-09)
			if (manualHost.trim()) {
				saveManualAddress(manualHost);
			}

			setIsSuccess(true);
			setIsSubmitting(false);

			if (options?.onSuccess) {
				options.onSuccess(response);
			} else {
				navigateTo(ROUTE_PATHS.deck);
			}

			return true;
		} catch (err: unknown) {
			setIsSubmitting(false);

			if (isApiError(err)) {
				if (err.code === 'E_NETWORK' || err.code === 'E_TIMEOUT') {
					// AC 1 & E-06: Report exact stage: "扫到码但连不上 host:port"
					const displayedHostPort = targetHostPort || manualHost || '调度服务';
					setError({
						stage: 'network',
						message: `扫到码但连不上 ${displayedHostPort}`,
						hostPort: displayedHostPort,
						code: err.code,
					});
					setShowManualHost(true);
					return false;
				}

				if (err.code === 'E_PAIRING_CODE_INVALID') {
					setError({
						stage: 'code',
						message: '配对码无效或已过期（配对码一次性有效且 TTL ≤ 60 秒）',
						code: err.code,
					});
					return false;
				}

				if (err.code === 'E_RATE_LIMITED') {
					setError({
						stage: 'ratelimit',
						message: '配对尝试过于频繁，当前配对码已被作废，请在桌面端重新生成',
						code: err.code,
					});
					return false;
				}

				if (err.code === 'E_VALIDATION') {
					setError({
						stage: 'validation',
						message: err.message || '入参校验失败，请检查配对码或设备名称',
						code: err.code,
					});
					return false;
				}

				setError({
					stage: 'general',
					message: err.message || '配对请求失败',
					code: err.code,
				});
				return false;
			}

			// Unknown or unexpected client exception
			setError({
				stage: 'general',
				message: err instanceof Error ? err.message : '配对发生未知异常',
			});
			return false;
		}
	}, [pairingCode, deviceName, manualHost, options, saveManualAddress]);

	return {
		pairingCode,
		setPairingCode,
		deviceName,
		setDeviceName,
		manualHost,
		setManualHostInput,
		showManualHost,
		setShowManualHost,
		isSubmitting,
		error,
		clearError,
		isSuccess,
		isBrowser,
		submitPairing,
		saveManualAddress,
	};
}
