import type { ShellTokenStore } from '@agent-scheduler/shared/shell/bridge-contract';
import { Preferences } from '@capacitor/preferences';

/**
 * Key used to store device authorization token in Capacitor Preferences.
 * Stored natively in Android SharedPreferences, strictly bypassing localStorage (AC 2, E-227).
 */
export const MOBILE_TOKEN_STORAGE_KEY = 'agsched.token' as const;

export interface StorageBackend {
	get(options: { key: string }): Promise<{ value: string | null }>;
	set(options: { key: string; value: string }): Promise<void>;
	remove(options: { key: string }): Promise<void>;
}

export interface PreferencesTokenStoreOptions {
	readonly backend?: StorageBackend;
	readonly storageKey?: string;
}

/**
 * Creates a token store backed strictly by Capacitor Preferences.
 * Guarantees zero writes or reads to browser localStorage (AC 2).
 */
export function createPreferencesTokenStore(
	options: PreferencesTokenStoreOptions = {},
): ShellTokenStore {
	const backend: StorageBackend = options.backend ?? Preferences;
	const key = options.storageKey ?? MOBILE_TOKEN_STORAGE_KEY;

	return {
		async get(): Promise<string | null> {
			const { value } = await backend.get({ key });
			return value;
		},

		async set(token: string): Promise<void> {
			if (!token || typeof token !== 'string' || token.trim().length === 0) {
				throw new Error('Device token must be a non-empty string');
			}
			await backend.set({ key, value: token });
		},

		async clear(): Promise<void> {
			await backend.remove({ key });
		},
	};
}
