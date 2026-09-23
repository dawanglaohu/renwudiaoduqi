import type {
	LaunchServiceResult,
	ShellBridge,
	ShellCapabilities,
	ShellNotificationOptions,
	ShellPlatform,
	ShellTokenStore,
} from '@agent-scheduler/shared/shell/bridge-contract';
import { ApiError, generateIdempotencyKey } from '../api/http-client.ts';
import { SHELL } from './detect-shell.ts';

export const SESSION_STORAGE_TOKEN_KEY = 'agsched.token' as const;

/**
 * 本会话所用设备的 deviceId（`POST /api/v1/pair/claim` 返回，10-接口约定），非凭证。
 * 仅用于设备列表标出「当前设备」与自吊销时立刻回 #/pair（E-127）。
 */
export const CURRENT_DEVICE_ID_STORAGE_KEY = 'agsched.current_device_id' as const;

/**
 * Tauri command names the web adapter invokes (07-前端架构 §注入点).
 * `packages/shell-desktop/test/tauri-commands.test.ts` asserts every name here is registered in
 * `lib.rs` `generate_handler!`; a name missing on either side fails that test.
 */
const TAURI_COMMANDS = {
	getToken: 'get_token',
	setToken: 'set_token',
	clearToken: 'clear_token',
	getHostHint: 'get_host_hint',
	launchService: 'launch_service',
} as const;

/**
 * Client-side error raised when a host without the capability is asked to start the local
 * service (E-146, E-200). Carries `code` so the UI keeps branching on error codes only.
 */
export function createShellUnavailableError(action: string): ApiError {
	return new ApiError({
		code: 'E_SHELL_UNAVAILABLE',
		message: `${action} requires the desktop shell container`,
		requestId: generateIdempotencyKey(),
	});
}

/**
 * Capacitor Preferences keys. They mirror `packages/shell-mobile/src/preferences-store.ts`
 * (`MOBILE_TOKEN_STORAGE_KEY`) and `mobile-bridge.ts` (`hostStorageKey` default): the same web
 * bundle runs inside the Android shell, so both sides must read the same native entries.
 */
const CAPACITOR_TOKEN_KEY = 'agsched.token' as const;
const CAPACITOR_HOST_KEY = 'agsched.host' as const;

export interface NativeShellAdapter {
	readonly tokenStore?: Partial<ShellTokenStore>;
	notify?(options: ShellNotificationOptions): Promise<void> | void;
	hostHint?(): Promise<string | null> | string | null;
	/** Only the tauri adapter supplies it; the bridge throws without it (E-146, E-200). */
	launchService?(): Promise<LaunchServiceResult>;
}

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

interface CapacitorPreferencesPlugin {
	get(options: { key: string }): Promise<{ value: string | null }>;
	set(options: { key: string; value: string }): Promise<void>;
	remove(options: { key: string }): Promise<void>;
}

/**
 * The two shell globals this module may read (07-前端架构: only `src/shell/` touches them).
 */
interface ShellGlobals {
	__TAURI_INTERNALS__?: { invoke?: TauriInvoke };
	Capacitor?: { Plugins?: { Preferences?: CapacitorPreferencesPlugin } };
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
 * Fourth capability (E-146, E-200, 决策 135): start the local scheduler service.
 *
 * Only the tauri adapter answers it. Every other host throws `E_SHELL_UNAVAILABLE`, so a
 * button that should have been hidden by `capabilities.canLaunchService` can never turn
 * into an action that silently does nothing. The shell spawns once and returns the pid;
 * retrying the first-screen snapshot stays the Web UI's job.
 */
async function launchService(): Promise<LaunchServiceResult> {
	if (SHELL.platform !== 'browser' && nativeAdapter?.launchService) {
		return nativeAdapter.launchService();
	}
	throw createShellUnavailableError('launchService');
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
 * Tauri v2 adapter: token store and host hint go through `window.__TAURI_INTERNALS__.invoke`
 * to the commands `lib.rs` registers (E-227: the OS credential store is the only token copy).
 * A failed read degrades to "no token" (the UI then asks to pair); failed writes propagate so
 * a token that never reached the credential store is not silently treated as saved.
 */
export function createTauriShellAdapter(invoke: TauriInvoke): NativeShellAdapter {
	return {
		tokenStore: {
			async get(): Promise<string | null> {
				try {
					const token = await invoke(TAURI_COMMANDS.getToken);
					return typeof token === 'string' && token.length > 0 ? token : null;
				} catch {
					return null;
				}
			},
			async set(token: string): Promise<void> {
				await invoke(TAURI_COMMANDS.setToken, { token });
			},
			async clear(): Promise<void> {
				await invoke(TAURI_COMMANDS.clearToken);
			},
		},
		async hostHint(): Promise<string | null> {
			try {
				const hint = await invoke(TAURI_COMMANDS.getHostHint);
				return typeof hint === 'string' && hint.trim().length > 0 ? hint.trim() : null;
			} catch {
				return null;
			}
		},
		async launchService(): Promise<LaunchServiceResult> {
			// The shell spawns once and reports the pid; a failed spawn must reach the UI
			// instead of being swallowed as "launched" (E-146).
			const pid = await invoke(TAURI_COMMANDS.launchService);
			if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
				throw new Error(`launch_service returned an unusable pid: ${String(pid)}`);
			}
			return Object.freeze({ pid });
		},
	};
}

/**
 * Capacitor adapter: token store and host hint go through `window.Capacitor.Plugins.Preferences`
 * (Android SharedPreferences), the same entries `packages/shell-mobile` writes.
 */
export function createCapacitorShellAdapter(
	preferences: CapacitorPreferencesPlugin,
): NativeShellAdapter {
	return {
		tokenStore: {
			async get(): Promise<string | null> {
				try {
					const { value } = await preferences.get({ key: CAPACITOR_TOKEN_KEY });
					return value && value.length > 0 ? value : null;
				} catch {
					return null;
				}
			},
			async set(token: string): Promise<void> {
				await preferences.set({ key: CAPACITOR_TOKEN_KEY, value: token });
			},
			async clear(): Promise<void> {
				await preferences.remove({ key: CAPACITOR_TOKEN_KEY });
			},
		},
		async hostHint(): Promise<string | null> {
			try {
				const { value } = await preferences.get({ key: CAPACITOR_HOST_KEY });
				return value && value.trim().length > 0 ? value.trim() : null;
			} catch {
				return null;
			}
		},
	};
}

/**
 * Pick the adapter for the detected platform from the shell globals, or null in browser mode
 * and when the shell global lacks the entry point the adapter needs (then shell mode simply has
 * no token, which is the honest answer — the browser fallback must not be used inside a shell).
 */
export function createPlatformShellAdapter(
	platform: ShellPlatform,
	globals: ShellGlobals | undefined,
): NativeShellAdapter | null {
	if (platform === 'tauri') {
		const invoke = globals?.__TAURI_INTERNALS__?.invoke;
		return typeof invoke === 'function' ? createTauriShellAdapter(invoke) : null;
	}
	if (platform === 'capacitor') {
		const preferences = globals?.Capacitor?.Plugins?.Preferences;
		return preferences ? createCapacitorShellAdapter(preferences) : null;
	}
	return null;
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
	launchService,
};

/**
 * 注入点（07-前端架构 §注入点，M9-T26）：同一份 web 产物在 daemon 的 `/`、`tauri://localhost`、
 * `https://localhost` 三处加载，壳包无法把适配器 import 进来，所以按 `SHELL.platform` 在模块加载期自装。
 */
const platformAdapter = createPlatformShellAdapter(
	SHELL.platform,
	typeof window !== 'undefined' ? (window as unknown as ShellGlobals) : undefined,
);
if (platformAdapter) {
	registerNativeShellAdapter(platformAdapter);
}
