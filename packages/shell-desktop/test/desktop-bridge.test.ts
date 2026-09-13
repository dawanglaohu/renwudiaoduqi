import { describe, expect, it, vi } from 'vitest';
import { MemorySecureStorageBackend, createDesktopShellAdapter } from '../src/desktop-bridge.ts';

describe('desktop desktop-bridge (AC 1, M10-T1)', () => {
	it('provides tokenStore get, set, clear using secure storage backend', async () => {
		const storage = new MemorySecureStorageBackend();
		const adapter = createDesktopShellAdapter({ storageBackend: storage });

		expect(await adapter.tokenStore.get()).toBeNull();

		await adapter.tokenStore.set('secret-token-123');
		expect(await adapter.tokenStore.get()).toBe('secret-token-123');

		await adapter.tokenStore.clear();
		expect(await adapter.tokenStore.get()).toBeNull();
	});

	it('dispatches notification to backend and delivers deepLink', async () => {
		const sendMock = vi.fn();
		const adapter = createDesktopShellAdapter({
			notificationBackend: { send: sendMock },
		});

		await adapter.notify({
			title: 'Alert',
			body: 'Something happened',
			deepLink: '#/item/42',
		});

		expect(sendMock).toHaveBeenCalledWith({
			title: 'Alert',
			body: 'Something happened',
			deepLink: '#/item/42',
		});
	});

	it('provides hostHint pointing to default local daemon or injected provider', async () => {
		const defaultAdapter = createDesktopShellAdapter();
		expect(await defaultAdapter.hostHint()).toBe('http://127.0.0.1:7817');

		const customAdapter = createDesktopShellAdapter({
			hostHintProvider: () => 'http://localhost:9000',
		});
		expect(await customAdapter.hostHint()).toBe('http://localhost:9000');
	});
});
