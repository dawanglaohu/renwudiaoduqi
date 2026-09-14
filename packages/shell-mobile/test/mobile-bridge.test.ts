import { describe, expect, it, vi } from 'vitest';
import {
	createMobileShellAdapter,
	createMobileShellBridge,
	initializeMobileShell,
} from '../src/mobile-bridge.ts';

describe('Mobile Shell Bridge Integration', () => {
	it('implements ShellBridge contract strictly matching platform capacitor and capabilities', async () => {
		const mockStorage = new Map<string, string>([['agsched.host', '192.168.1.50:7817']]);
		const mockStorageBackend = {
			get: vi.fn(async ({ key }: { key: string }) => ({
				value: mockStorage.get(key) ?? null,
			})),
			set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
				mockStorage.set(key, value);
			}),
			remove: vi.fn(async ({ key }: { key: string }) => {
				mockStorage.delete(key);
			}),
		};

		const mockNotificationBackend = {
			checkPermissions: vi.fn(async () => ({ display: 'granted' as const })),
			requestPermissions: vi.fn(async () => ({ display: 'granted' as const })),
			schedule: vi.fn(async () => ({ notifications: [{ id: 1 }] })),
		};

		const bridge = createMobileShellBridge({
			storageBackend: mockStorageBackend,
			notificationBackend: mockNotificationBackend,
		});

		// 1. Platform and capabilities
		expect(bridge.platform).toBe('capacitor');
		expect(bridge.capabilities.hasSecureStorage).toBe(true);
		expect(bridge.capabilities.hasNativeNotification).toBe(true);

		// 2. Token store works
		await bridge.tokenStore.set('token_xyz');
		const stored = await bridge.tokenStore.get();
		expect(stored).toBe('token_xyz');

		// 3. Host hint returns stored LAN host
		const host = await bridge.hostHint();
		expect(host).toBe('192.168.1.50:7817');

		// 4. Notification schedules native notification
		await bridge.notify({
			title: 'Run completed',
			body: 'Task M10-T3 succeeded',
			deepLink: '#/run/run-99',
		});
		expect(mockNotificationBackend.schedule).toHaveBeenCalledWith({
			notifications: [
				expect.objectContaining({
					title: 'Run completed',
					body: 'Task M10-T3 succeeded',
					extra: { deepLink: '#/run/run-99' },
				}),
			],
		});
	});

	it('createMobileShellAdapter provides tokenStore, notify, and hostHint for web adapter registration', async () => {
		const mockStorage = new Map<string, string>();
		const mockStorageBackend = {
			get: vi.fn(async ({ key }: { key: string }) => ({
				value: mockStorage.get(key) ?? null,
			})),
			set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
				mockStorage.set(key, value);
			}),
			remove: vi.fn(async ({ key }: { key: string }) => {
				mockStorage.delete(key);
			}),
		};

		const adapter = createMobileShellAdapter({ storageBackend: mockStorageBackend });
		expect(typeof adapter.tokenStore.get).toBe('function');
		expect(typeof adapter.tokenStore.set).toBe('function');
		expect(typeof adapter.tokenStore.clear).toBe('function');
		expect(typeof adapter.notify).toBe('function');
		expect(typeof adapter.hostHint).toBe('function');
	});

	it('initializeMobileShell initializes back button, bridge, and adapter without error', () => {
		const mockStorageBackend = {
			get: vi.fn(async () => ({ value: null })),
			set: vi.fn(async () => {}),
			remove: vi.fn(async () => {}),
		};

		const mobileRuntime = initializeMobileShell({ storageBackend: mockStorageBackend });
		expect(mobileRuntime.bridge.platform).toBe('capacitor');
		expect(mobileRuntime.backButtonHandler.getStackDepth()).toBe(0);

		mobileRuntime.destroy();
	});
});
