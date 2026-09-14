import { describe, expect, it, vi } from 'vitest';
import { MOBILE_TOKEN_STORAGE_KEY, createPreferencesTokenStore } from '../src/preferences-store.ts';

describe('Preferences Token Store (AC 2)', () => {
	it('AC 2: stores token in Capacitor Preferences and strictly never touches localStorage', async () => {
		const mockStorage = new Map<string, string>();
		const mockBackend = {
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

		// Mock global localStorage to verify zero calls (AC 2: 不落 localStorage)
		const mockLocalStorage = {
			getItem: vi.fn(),
			setItem: vi.fn(),
			removeItem: vi.fn(),
			clear: vi.fn(),
		};
		vi.stubGlobal('localStorage', mockLocalStorage);

		const store = createPreferencesTokenStore({ backend: mockBackend });

		// 1. Initial state is null
		const initial = await store.get();
		expect(initial).toBeNull();
		expect(mockBackend.get).toHaveBeenCalledWith({ key: MOBILE_TOKEN_STORAGE_KEY });

		// 2. Set token
		const testToken = 'device_token_secret_12345';
		await store.set(testToken);
		expect(mockBackend.set).toHaveBeenCalledWith({
			key: MOBILE_TOKEN_STORAGE_KEY,
			value: testToken,
		});

		// 3. Get token
		const retrieved = await store.get();
		expect(retrieved).toBe(testToken);

		// 4. Clear token
		await store.clear();
		expect(mockBackend.remove).toHaveBeenCalledWith({ key: MOBILE_TOKEN_STORAGE_KEY });
		const afterClear = await store.get();
		expect(afterClear).toBeNull();

		// Assert that localStorage was NEVER called
		expect(mockLocalStorage.getItem).not.toHaveBeenCalled();
		expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
		expect(mockLocalStorage.removeItem).not.toHaveBeenCalled();

		vi.unstubAllGlobals();
	});

	it('rejects invalid or empty token inputs', async () => {
		const mockBackend = {
			get: vi.fn(async () => ({ value: null })),
			set: vi.fn(async () => {}),
			remove: vi.fn(async () => {}),
		};
		const store = createPreferencesTokenStore({ backend: mockBackend });

		await expect(store.set('')).rejects.toThrow('Device token must be a non-empty string');
		await expect(store.set('   ')).rejects.toThrow('Device token must be a non-empty string');
		expect(mockBackend.set).not.toHaveBeenCalled();
	});
});
