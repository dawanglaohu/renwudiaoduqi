import type {
	ShellNotificationOptions,
	ShellTokenStore,
} from '../../shared/src/shell/bridge-contract.ts';
import { deliverNotificationDeepLink } from './notification-handler.ts';

export interface SecureStorageBackend {
	get(): Promise<string | null> | string | null;
	set(token: string): Promise<void> | void;
	clear(): Promise<void> | void;
}

export interface NotificationBackend {
	send(options: ShellNotificationOptions): Promise<void> | void;
}

export interface DesktopBridgeOptions {
	readonly storageBackend?: SecureStorageBackend;
	readonly notificationBackend?: NotificationBackend;
	readonly hostHintProvider?: () => Promise<string | null> | string | null;
}

export interface NativeDesktopAdapter {
	readonly tokenStore: ShellTokenStore;
	notify(options: ShellNotificationOptions): Promise<void>;
	hostHint(): Promise<string | null>;
}

/**
 * In-memory fallback secure storage backend for testing or environments where
 * native OS keychain is being mocked.
 */
export class MemorySecureStorageBackend implements SecureStorageBackend {
	private currentToken: string | null = null;

	async get(): Promise<string | null> {
		return this.currentToken;
	}

	async set(token: string): Promise<void> {
		this.currentToken = token;
	}

	async clear(): Promise<void> {
		this.currentToken = null;
	}
}

/**
 * Creates the native desktop shell adapter for Tauri v2 (AC 1, M10-T1).
 *
 * Implements exactly the three capabilities:
 *   1. tokenStore (secure storage)
 *   2. notify (system notification with deepLink delivery)
 *   3. hostHint
 *
 * Contains zero business concepts.
 */
export function createDesktopShellAdapter(options?: DesktopBridgeOptions): NativeDesktopAdapter {
	const storage = options?.storageBackend ?? new MemorySecureStorageBackend();

	const tokenStore: ShellTokenStore = {
		async get(): Promise<string | null> {
			return storage.get();
		},
		async set(token: string): Promise<void> {
			await storage.set(token);
		},
		async clear(): Promise<void> {
			await storage.clear();
		},
	};

	async function notify(notificationOptions: ShellNotificationOptions): Promise<void> {
		if (options?.notificationBackend) {
			await options.notificationBackend.send(notificationOptions);
		}

		if (notificationOptions.deepLink) {
			deliverNotificationDeepLink(notificationOptions.deepLink);
		}
	}

	async function hostHint(): Promise<string | null> {
		if (options?.hostHintProvider) {
			return options.hostHintProvider();
		}
		return 'http://127.0.0.1:7817';
	}

	return Object.freeze({
		tokenStore,
		notify,
		hostHint,
	});
}
