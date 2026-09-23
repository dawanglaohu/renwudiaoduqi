import { CURRENT_API_VERSION } from '@agent-scheduler/shared/api/system';
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

import {
	type MobileUpgradeNotice,
	type MobileVersionCheckOptions,
	type MobileVersionCheckResult,
	checkMobileApiVersion,
	generateMobileUpgradeNotice,
} from './version-check.ts';

export interface MobileBridgeOptions {
	readonly storageBackend?: StorageBackend;
	readonly notificationBackend?: LocalNotificationBackend;
	readonly onDeepLink?: (deepLink: string) => void;
	readonly hostStorageKey?: string;
	readonly hostHint?: () => Promise<string | null> | string | null;
	readonly versionFetcher?: MobileVersionCheckOptions['fetcher'];
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
	readonly versionCheckPromise: Promise<MobileVersionCheckResult>;
	readonly upgradeNotice: MobileUpgradeNotice | null;
	readonly destroy: () => void;
}

// Android has no local scheduler service to start: the phone talks to the desktop daemon,
// so the fourth capability is permanently false here (E-146, E-200).
const MOBILE_CAPABILITIES: ShellCapabilities = Object.freeze({
	hasSecureStorage: true,
	hasNativeNotification: true,
	canLaunchService: false,
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

	/**
	 * Fourth capability (M10-T6, E-146, E-200): Android has no local scheduler service to
	 * start - the phone talks to the daemon running on the desktop. The bridge still answers
	 * the call, with the same client error shape the web side uses, so a caller that ignores
	 * `capabilities.canLaunchService` gets a code it can branch on instead of a silent no-op.
	 */
	async function launchService(): Promise<never> {
		const error = new Error('launchService requires the desktop shell container') as Error & {
			code: string;
			requestId: string;
		};
		error.name = 'ApiError';
		error.code = 'E_SHELL_UNAVAILABLE';
		error.requestId = 'shell-unavailable';
		throw error;
	}

	return Object.freeze({
		platform: 'capacitor' as ShellPlatform,
		capabilities: MOBILE_CAPABILITIES,
		tokenStore,
		notify,
		hostHint,
		launchService,
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

	let upgradeNotice: MobileUpgradeNotice | null = null;
	const versionCheckPromise = Promise.resolve()
		.then(async () => {
			const hinted = options.hostHint ? await options.hostHint() : await bridge.hostHint();
			return checkMobileApiVersion({
				baseUrl: hinted,
				fetcher: options.versionFetcher,
			});
		})
		.then((result) => {
			if (!result.compatible && result.reason === 'incompatible') {
				upgradeNotice = generateMobileUpgradeNotice({
					apiVersion: result.apiVersion,
					expectedVersion: result.expectedVersion,
				});
			}
			return result;
		})
		.catch((error: unknown): MobileVersionCheckResult => {
			const message = error instanceof Error ? error.message : String(error);
			return {
				compatible: false,
				reason: 'unreachable',
				expectedVersion: CURRENT_API_VERSION,
				message,
				upgradePrompt: '电脑上的调度服务未启动。请在电脑上启动调度服务后再打开手机应用。',
			};
		});

	return Object.freeze({
		bridge,
		adapter,
		backButtonHandler,
		versionCheckPromise,
		get upgradeNotice() {
			return upgradeNotice;
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
