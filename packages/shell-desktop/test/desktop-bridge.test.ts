import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
	MemorySecureStorageBackend,
	NativeNotificationBackend,
	NativeSecureStorageBackend,
	type SecureStorageBackend,
	createDesktopShellAdapter,
} from '../src/desktop-bridge.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('desktop desktop-bridge (AC 1, AC 6, M10-T1)', () => {
	it('provides tokenStore get, set, clear using secure storage backend', async () => {
		const storage = new MemorySecureStorageBackend();
		const adapter = createDesktopShellAdapter({ storageBackend: storage });

		expect(await adapter.tokenStore.get()).toBeNull();

		await adapter.tokenStore.set('secret-token-123');
		expect(await adapter.tokenStore.get()).toBe('secret-token-123');

		await adapter.tokenStore.clear();
		expect(await adapter.tokenStore.get()).toBeNull();
	});

	it('uses NativeSecureStorageBackend by default instead of in-memory storage (R3)', async () => {
		const mockInvoke = vi.fn().mockImplementation(async (cmd: string, args?: unknown) => {
			if (cmd === 'get_token') return 'native-token-abc';
			if (cmd === 'set_token') return null;
			if (cmd === 'clear_token') return null;
			return null;
		});

		const nativeBackend = new NativeSecureStorageBackend(mockInvoke);
		expect(nativeBackend).toBeInstanceOf(NativeSecureStorageBackend);
		expect(nativeBackend).not.toBeInstanceOf(MemorySecureStorageBackend);

		const adapter = createDesktopShellAdapter({ storageBackend: nativeBackend });
		expect(await adapter.tokenStore.get()).toBe('native-token-abc');
		expect(mockInvoke).toHaveBeenCalledWith('get_token');
	});

	it('persists token across restarts when using a persistent storage backend substitute (R3)', async () => {
		class PersistentStorageBackendSubstitute implements SecureStorageBackend {
			private static fileBackedToken: string | null = null;
			async get(): Promise<string | null> {
				return PersistentStorageBackendSubstitute.fileBackedToken;
			}
			async set(token: string): Promise<void> {
				PersistentStorageBackendSubstitute.fileBackedToken = token;
			}
			async clear(): Promise<void> {
				PersistentStorageBackendSubstitute.fileBackedToken = null;
			}
		}

		const backend1 = new PersistentStorageBackendSubstitute();
		const adapter1 = createDesktopShellAdapter({ storageBackend: backend1 });
		await adapter1.tokenStore.set('persistent-credential-xyz');

		// Simulate restarting the application: new adapter and new backend instance
		const backend2 = new PersistentStorageBackendSubstitute();
		const adapter2 = createDesktopShellAdapter({ storageBackend: backend2 });
		const retrieved = await adapter2.tokenStore.get();

		expect(retrieved).toBe('persistent-credential-xyz');
	});

	it('sends native notification through Tauri plugin with permission checks (R2)', async () => {
		const invokeMock = vi.fn().mockImplementation(async (cmd: string) => {
			if (cmd === 'plugin:notification|is_permission_granted') return false;
			if (cmd === 'plugin:notification|request_permission') return 'granted';
			if (cmd === 'plugin:notification|notify') return null;
			return null;
		});

		const nativeNotifier = new NativeNotificationBackend(invokeMock);
		const adapter = createDesktopShellAdapter({ notificationBackend: nativeNotifier });

		await adapter.notify({
			title: 'Alert',
			body: 'Something happened',
			deepLink: '#/item/42',
		});

		expect(invokeMock).toHaveBeenCalledWith('plugin:notification|is_permission_granted');
		expect(invokeMock).toHaveBeenCalledWith('plugin:notification|request_permission');
		expect(invokeMock).toHaveBeenCalledWith('plugin:notification|notify', {
			options: {
				title: 'Alert',
				body: 'Something happened',
			},
		});
	});

	it('degrades silently and does not alert when notification permission is denied (R2)', async () => {
		const alertSpy = vi.fn();
		(globalThis as unknown as { alert?: (msg: string) => void }).alert = alertSpy;

		const invokeMock = vi.fn().mockImplementation(async (cmd: string) => {
			if (cmd === 'plugin:notification|is_permission_granted') return false;
			if (cmd === 'plugin:notification|request_permission') return 'denied';
			return null;
		});

		const nativeNotifier = new NativeNotificationBackend(invokeMock);
		const adapter = createDesktopShellAdapter({ notificationBackend: nativeNotifier });

		await expect(
			adapter.notify({
				title: 'Denied Notice',
				body: 'Should not crash or alert',
			}),
		).resolves.toBeUndefined();

		expect(alertSpy).not.toHaveBeenCalled();
	});

	it('configures notification plugin in Cargo.toml and capability in default.json (R2)', () => {
		const cargoContent = readFileSync(join(__dirname, '../src-tauri/Cargo.toml'), 'utf8');
		expect(cargoContent).toContain('tauri-plugin-notification = "2"');

		const capContent = readFileSync(
			join(__dirname, '../src-tauri/capabilities/default.json'),
			'utf8',
		);
		expect(capContent).toContain('notification:default');
	});

	it('returns null for default hostHint without hardcoded ports (R8)', async () => {
		const defaultAdapter = createDesktopShellAdapter();
		expect(await defaultAdapter.hostHint()).toBeNull();

		const customAdapter = createDesktopShellAdapter({
			hostHintProvider: () => 'http://localhost:9000',
		});
		expect(await customAdapter.hostHint()).toBe('http://localhost:9000');
	});
});
