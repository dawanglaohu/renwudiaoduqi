import type {
	ShellNotificationOptions,
	ShellTokenStore,
} from '@agent-scheduler/shared/shell/bridge-contract';
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

type TauriInvoker = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getTauriInvoker(): TauriInvoker | null {
	if (typeof window !== 'undefined') {
		const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: TauriInvoker } })
			.__TAURI_INTERNALS__;
		if (internals && typeof internals.invoke === 'function') {
			return internals.invoke;
		}
	}
	return null;
}

/**
 * Native OS secure storage backend utilizing platform credential stores (AC 1).
 * Delegates to Tauri commands backed by the native OS keychain / Windows Credential Manager.
 */
export class NativeSecureStorageBackend implements SecureStorageBackend {
	private readonly invokeFn: TauriInvoker | null;

	constructor(customInvoker?: TauriInvoker) {
		this.invokeFn = customInvoker ?? getTauriInvoker();
	}

	async get(): Promise<string | null> {
		if (!this.invokeFn) {
			return null;
		}
		try {
			const token = await this.invokeFn('get_token');
			return typeof token === 'string' ? token : null;
		} catch {
			return null;
		}
	}

	async set(token: string): Promise<void> {
		if (!this.invokeFn) {
			return;
		}
		await this.invokeFn('set_token', { token });
	}

	async clear(): Promise<void> {
		if (!this.invokeFn) {
			return;
		}
		await this.invokeFn('clear_token');
	}
}

/**
 * In-memory fallback secure storage backend retained for testing purposes (AC 1).
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
 * Native system notification backend via Tauri notification plugin (AC 1, AC 6).
 * Degrades silently when permissions are not granted; never calls alert().
 */
export class NativeNotificationBackend implements NotificationBackend {
	private readonly invokeFn: TauriInvoker | null;

	constructor(customInvoker?: TauriInvoker) {
		this.invokeFn = customInvoker ?? getTauriInvoker();
	}

	async send(options: ShellNotificationOptions): Promise<void> {
		if (!this.invokeFn) {
			return;
		}
		try {
			let granted = await this.invokeFn('plugin:notification|is_permission_granted');
			if (!granted) {
				const requested = await this.invokeFn('plugin:notification|request_permission');
				granted = requested === 'granted';
			}
			if (granted) {
				await this.invokeFn('plugin:notification|notify', {
					options: {
						title: options.title,
						body: options.body,
					},
				});
			}
		} catch {
			// Silent degradation when notification cannot be sent: prohibited to alert()
		}
	}
}

/**
 * Creates the native desktop shell adapter for Tauri v2 (AC 1, M10-T1).
 *
 * Implements exactly the three capabilities:
 *   1. tokenStore (native secure storage)
 *   2. notify (system notification with deepLink delivery)
 *   3. hostHint (runtime discovery)
 *
 * Contains zero business concepts.
 */
export function createDesktopShellAdapter(options?: DesktopBridgeOptions): NativeDesktopAdapter {
	const storage = options?.storageBackend ?? new NativeSecureStorageBackend();
	const notificationBackend = options?.notificationBackend ?? new NativeNotificationBackend();

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
		await notificationBackend.send(notificationOptions);

		if (notificationOptions.deepLink) {
			deliverNotificationDeepLink(notificationOptions.deepLink);
		}
	}

	async function hostHint(): Promise<string | null> {
		if (options?.hostHintProvider) {
			return options.hostHintProvider();
		}
		const invoker = getTauriInvoker();
		if (invoker) {
			try {
				const hint = await invoker('get_host_hint');
				if (typeof hint === 'string' && hint.trim().length > 0) {
					return hint.trim();
				}
			} catch {
				// fallback to null
			}
		}
		return null;
	}

	return Object.freeze({
		tokenStore,
		notify,
		hostHint,
	});
}
