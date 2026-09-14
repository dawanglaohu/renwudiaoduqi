import type {
	ShellBridge,
	ShellCapabilities,
	ShellNotificationOptions,
	ShellPlatform,
	ShellTokenStore,
} from '@agent-scheduler/shared/shell/bridge-contract';
import { Preferences } from '@capacitor/preferences';
import { skipMobileAutostartRegistration } from './autostart.ts';
import { type BackButtonHandler, createBackButtonHandler } from './back-button.ts';
import {
	type LocalNotificationBackend,
	createMobileNotificationNotifier,
} from './notification-adapter.ts';
import { type StorageBackend, createPreferencesTokenStore } from './preferences-store.ts';

import { type MobileVersionCheckResult, checkMobileApiVersion } from './version-check.ts';

export interface MobileBridgeOptions {
	readonly storageBackend?: StorageBackend;
	readonly notificationBackend?: LocalNotificationBackend;
	readonly onDeepLink?: (deepLink: string) => void;
	readonly hostStorageKey?: string;
}

export interface MobileShellAdapter {
	readonly tokenStore: ShellTokenStore;
	notify(options: ShellNotificationOptions): Promise<void>;
	hostHint(): Promise<string | null>;
}

export interface InitializedMobileShell {
	readonly bridge: ShellBridge;
	readonly adapter: MobileShellAdapter;
	readonly backButtonHandler: BackButtonHandler;
	readonly verifyVersion: (baseUrl?: string) => Promise<MobileVersionCheckResult>;
	readonly destroy: () => void;
}

const MOBILE_CAPABILITIES: ShellCapabilities = Object.freeze({
	hasSecureStorage: true,
	hasNativeNotification: true,
});

/**
 * Creates the unified ShellBridge implementation for the Capacitor Android shell (M10-T3).
 */
export function createMobileShellBridge(options: MobileBridgeOptions = {}): ShellBridge {
	const tokenStore = createPreferencesTokenStore({ backend: options.storageBackend });
	const notify = createMobileNotificationNotifier({
		backend: options.notificationBackend,
		onDeepLink: options.onDeepLink,
	});
	const hostKey = options.hostStorageKey ?? 'agsched.host';
	const backend: StorageBackend = options.storageBackend ?? Preferences;

	async function hostHint(): Promise<string | null> {
		try {
			const { value } = await backend.get({ key: hostKey });
			return value ?? null;
		} catch {
			return null;
		}
	}

	return Object.freeze({
		platform: 'capacitor' as ShellPlatform,
		capabilities: MOBILE_CAPABILITIES,
		tokenStore,
		notify,
		hostHint,
	});
}

/**
 * Creates the NativeShellAdapter for registration with web's registerNativeShellAdapter.
 */
export function createMobileShellAdapter(options: MobileBridgeOptions = {}): MobileShellAdapter {
	const bridge = createMobileShellBridge(options);
	return {
		tokenStore: bridge.tokenStore,
		notify: bridge.notify.bind(bridge),
		hostHint: bridge.hostHint.bind(bridge),
	};
}

/**
 * Initializes the mobile shell runtime in the Android Capacitor container:
 * 1. Configures native token storage via Preferences (AC 2)
 * 2. Wires hardware back button to history.back() and prevents instant exit (AC 3, E-225)
 * 3. Suppresses autostart registration with zero warnings/UI (AC 5, E-211)
 * 4. Enables local notifications and deep linking (E-11)
 */
export function initializeMobileShell(options: MobileBridgeOptions = {}): InitializedMobileShell {
	// 1. Mobile autostart suppression (E-211: zero warnings/UI)
	skipMobileAutostartRegistration();

	// 2. Hardware back button mapping (E-225)
	const backButtonHandler = createBackButtonHandler();

	// 3. Create bridge and adapter
	const bridge = createMobileShellBridge(options);
	const adapter = createMobileShellAdapter(options);

	return Object.freeze({
		bridge,
		adapter,
		backButtonHandler,
		async verifyVersion(customBaseUrl?: string): Promise<MobileVersionCheckResult> {
			const resolvedBaseUrl = customBaseUrl ?? (await bridge.hostHint()) ?? 'http://127.0.0.1:7817';
			return checkMobileApiVersion({ baseUrl: resolvedBaseUrl });
		},
		destroy(): void {
			backButtonHandler.destroy();
		},
	});
}

export {
	checkMobileApiVersion,
	generateMobileUpgradeNotice,
	isMobileApiVersionCompatible,
} from './version-check.ts';
