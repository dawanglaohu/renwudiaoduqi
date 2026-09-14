import type {
	ShellBridge,
	ShellCapabilities,
	ShellNotificationOptions,
	ShellPlatform,
	ShellTokenStore,
} from '@agent-scheduler/shared/shell/bridge-contract';
import { SHELL } from './detect-shell.ts';

export const SESSION_STORAGE_TOKEN_KEY = 'agsched.token' as const;

/**
 * 本会话所用设备的 deviceId（`POST /api/v1/pair/claim` 返回，10-接口约定），非凭证。
 * 仅用于设备列表标出「当前设备」与自吊销时立刻回 #/pair（E-127）。
 */
export const CURRENT_DEVICE_ID_STORAGE_KEY = 'agsched.current_device_id' as const;

export interface NativeShellAdapter {
	readonly tokenStore?: Partial<ShellTokenStore>;
	notify?(options: ShellNotificationOptions): Promise<void> | void;
	hostHint?(): Promise<string | null> | string | null;
}

type NotificationFallbackListener = (options: ShellNotificationOptions) => void;

let nativeAdapter: NativeShellAdapter | null = null;
let hasRequestedNotificationPermission = false;
let browserUnreadNotificationCount = 0;
const fallbackListeners = new Set<NotificationFallbackListener>();

/**
 * Register a native shell adapter (called by Tauri / Capacitor native container wiring).
 */
export function registerNativeShellAdapter(adapter: NativeShellAdapter | null): void {
	nativeAdapter = adapter;
	if (SHELL.platform !== 'browser' && typeof sessionStorage !== 'undefined') {
		sessionStorage.removeItem(SESSION_STORAGE_TOKEN_KEY);
		sessionStorage.removeItem(CURRENT_DEVICE_ID_STORAGE_KEY);
	}
}

/**
 * Subscribe to browser notification fallbacks (for notice-store unread badges).
 */
export function onNotificationFallback(listener: NotificationFallbackListener): () => void {
	fallbackListeners.add(listener);
	return () => {
		fallbackListeners.delete(listener);
	};
}

/**
 * Get the current browser notification unread count reflected in document.title.
 */
export function getBrowserUnreadNotificationCount(): number {
	return browserUnreadNotificationCount;
}

/**
 * Reset the browser notification badge and remove the (N) prefix from document.title.
 */
export function resetBrowserNotificationBadge(): void {
	browserUnreadNotificationCount = 0;
	if (typeof document !== 'undefined') {
		document.title = document.title.replace(/^\(\d+\)\s*/, '');
	}
}

/**
 * Internal: update document.title with '(N) <original title>'.
 */
function incrementBrowserBadge(options: ShellNotificationOptions): void {
	browserUnreadNotificationCount += 1;
	if (typeof document !== 'undefined') {
		const baseTitle = document.title.replace(/^\(\d+\)\s*/, '');
		document.title = `(${browserUnreadNotificationCount}) ${baseTitle}`;
	}
	for (const listener of fallbackListeners) {
		listener(options);
	}
}

/**
 * E-227: When running in a native shell, the shell's secure storage is the sole source of truth.
 * Clear any stale sessionStorage copy immediately upon startup to prevent dual-writes.
 */
if (SHELL.platform !== 'browser' && typeof sessionStorage !== 'undefined') {
	sessionStorage.removeItem(SESSION_STORAGE_TOKEN_KEY);
	sessionStorage.removeItem(CURRENT_DEVICE_ID_STORAGE_KEY);
}

/**
 * Token storage capability implementation with browser sessionStorage fallback (07-前端架构 / AC 4).
 * E-227: When running in a native shell, the shell's secure storage is the sole source of truth.
 * Under no circumstances may sessionStorage be read, written, or dual-written in shell mode.
 */
const tokenStore: ShellTokenStore = {
	async get(): Promise<string | null> {
		if (SHELL.platform !== 'browser') {
			if (nativeAdapter?.tokenStore?.get) {
				return nativeAdapter.tokenStore.get();
			}
			return null;
		}
		if (typeof sessionStorage === 'undefined') {
			return null;
		}
		return sessionStorage.getItem(SESSION_STORAGE_TOKEN_KEY);
	},

	async set(token: string): Promise<void> {
		if (SHELL.platform !== 'browser') {
			if (nativeAdapter?.tokenStore?.set) {
				await nativeAdapter.tokenStore.set(token);
			}
			return;
		}
		if (typeof sessionStorage !== 'undefined') {
			sessionStorage.setItem(SESSION_STORAGE_TOKEN_KEY, token);
		}
	},

	async clear(): Promise<void> {
		if (SHELL.platform !== 'browser') {
			if (nativeAdapter?.tokenStore?.clear) {
				await nativeAdapter.tokenStore.clear();
			}
			return;
		}
		if (typeof sessionStorage !== 'undefined') {
			sessionStorage.removeItem(SESSION_STORAGE_TOKEN_KEY);
		}
	},
};

/**
 * Notification capability implementation with browser Notification API / document.title fallback (07-前端架构 / AC 4).
 * Prohibits alert(), prohibits pretending to have native notification in browser mode.
 */
async function notify(options: ShellNotificationOptions): Promise<void> {
	if (SHELL.platform !== 'browser' && nativeAdapter?.notify) {
		await nativeAdapter.notify(options);
		return;
	}

	if (typeof window === 'undefined') {
		return;
	}

	const NotificationApi = (window as unknown as { Notification?: typeof Notification })
		.Notification;

	if (NotificationApi) {
		if (NotificationApi.permission === 'granted') {
			const notification = new NotificationApi(options.title, {
				body: options.body,
			});
			if (options.deepLink) {
				notification.onclick = () => {
					window.focus();
					if (options.deepLink) {
						window.location.hash = options.deepLink;
					}
				};
			}
			return;
		}

		if (NotificationApi.permission === 'default' && !hasRequestedNotificationPermission) {
			hasRequestedNotificationPermission = true;
			const permission = await NotificationApi.requestPermission();
			if (permission === 'granted') {
				const notification = new NotificationApi(options.title, {
					body: options.body,
				});
				if (options.deepLink) {
					notification.onclick = () => {
						window.focus();
						if (options.deepLink) {
							window.location.hash = options.deepLink;
						}
					};
				}
				return;
			}
		}
	}

	// Fallback when ungranted, denied, or Notification API is unavailable:
	// updates document.title (N) prefix and notifies fallback listeners (notice-store).
	incrementBrowserBadge(options);
}

/**
 * Host hint capability implementation (07-前端架构 / AC 4).
 * Returns location.origin in browser mode for runtime baseURL discovery (E-200).
 */
async function hostHint(): Promise<string | null> {
	if (SHELL.platform !== 'browser' && nativeAdapter?.hostHint) {
		return nativeAdapter.hostHint();
	}
	if (typeof window !== 'undefined' && window.location?.origin) {
		return window.location.origin;
	}
	return null;
}

/**
 * Check if the application is running in un-shelled browser mode (E-229).
 */
export function isBrowserMode(): boolean {
	return SHELL.platform === 'browser';
}

/**
 * Remember the deviceId this session authenticated as, so the device list can
 * mark 「当前设备」 and revoking it drops the session immediately (E-127).
 */
export function rememberCurrentDeviceId(deviceId: string): void {
	if (typeof sessionStorage === 'undefined') {
		return;
	}
	sessionStorage.setItem(CURRENT_DEVICE_ID_STORAGE_KEY, deviceId);
}

/**
 * Read the deviceId remembered by `rememberCurrentDeviceId`, or null when unknown.
 */
export function readCurrentDeviceId(): string | null {
	if (typeof sessionStorage === 'undefined') {
		return null;
	}
	return sessionStorage.getItem(CURRENT_DEVICE_ID_STORAGE_KEY);
}

/**
 * The unified shell bridge instance.
 */
export const shellBridge: ShellBridge = {
	get platform(): ShellPlatform {
		return SHELL.platform;
	},
	get capabilities(): ShellCapabilities {
		return SHELL.capabilities;
	},
	tokenStore,
	notify,
	hostHint,
};
