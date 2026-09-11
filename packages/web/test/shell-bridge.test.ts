import type {
	ShellBridge,
	ShellCapabilities,
	ShellNotificationOptions,
	ShellPlatform,
	ShellTokenStore,
} from '@agent-scheduler/shared/shell/bridge-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL, detectShell } from '../src/shell/detect-shell.ts';
import {
	SESSION_STORAGE_TOKEN_KEY,
	getBrowserUnreadNotificationCount,
	onNotificationFallback,
	registerNativeShellAdapter,
	resetBrowserNotificationBadge,
	shellBridge,
} from '../src/shell/shell-bridge.ts';

describe('M10-T1 Shell Bridge & Capability Detection', () => {
	const originalWindow = globalThis.window;
	const originalDocument = globalThis.document;
	const originalSessionStorage = globalThis.sessionStorage;
	const originalLocalStorage = globalThis.localStorage;
	const originalNotification = (globalThis as unknown as { Notification?: unknown }).Notification;

	let mockSessionStore: Record<string, string> = {};
	let mockLocalStore: Record<string, string> = {};
	let docTitle = 'Agent Scheduler';

	beforeEach(() => {
		mockSessionStore = {};
		mockLocalStore = {};
		docTitle = 'Agent Scheduler';
		resetBrowserNotificationBadge();
		registerNativeShellAdapter(null);

		const fakeSessionStorage = {
			getItem: vi.fn((key: string) => mockSessionStore[key] ?? null),
			setItem: vi.fn((key: string, val: string) => {
				mockSessionStore[key] = String(val);
			}),
			removeItem: vi.fn((key: string) => {
				delete mockSessionStore[key];
			}),
			clear: vi.fn(() => {
				mockSessionStore = {};
			}),
			key: vi.fn(),
			length: 0,
		};

		const fakeLocalStorage = {
			getItem: vi.fn((key: string) => mockLocalStore[key] ?? null),
			setItem: vi.fn((key: string, val: string) => {
				mockLocalStore[key] = String(val);
			}),
			removeItem: vi.fn((key: string) => {
				delete mockLocalStore[key];
			}),
			clear: vi.fn(() => {
				mockLocalStore = {};
			}),
			key: vi.fn(),
			length: 0,
		};

		const fakeWindow = {
			location: {
				origin: 'http://localhost:7817',
				hash: '',
			},
			focus: vi.fn(),
			alert: vi.fn(),
		};

		const fakeDocument = {
			get title() {
				return docTitle;
			},
			set title(val: string) {
				docTitle = val;
			},
		};

		Object.defineProperty(globalThis, 'window', {
			value: fakeWindow,
			writable: true,
			configurable: true,
		});

		Object.defineProperty(globalThis, 'document', {
			value: fakeDocument,
			writable: true,
			configurable: true,
		});

		Object.defineProperty(globalThis, 'sessionStorage', {
			value: fakeSessionStorage,
			writable: true,
			configurable: true,
		});

		Object.defineProperty(globalThis, 'localStorage', {
			value: fakeLocalStorage,
			writable: true,
			configurable: true,
		});
	});

	afterEach(() => {
		registerNativeShellAdapter(null);
		resetBrowserNotificationBadge();
		Object.defineProperty(globalThis, 'window', {
			value: originalWindow,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(globalThis, 'document', {
			value: originalDocument,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(globalThis, 'sessionStorage', {
			value: originalSessionStorage,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(globalThis, 'localStorage', {
			value: originalLocalStorage,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(globalThis, 'Notification', {
			value: originalNotification,
			writable: true,
			configurable: true,
		});
	});

	describe('AC 1: Capabilities count & Bridge Contract types', () => {
		it('contains exactly 3 capabilities (tokenStore, notify, hostHint) and 2 read-only flags', () => {
			const expectedKeys = new Set([
				'platform',
				'capabilities',
				'tokenStore',
				'notify',
				'hostHint',
			]);
			const bridgeKeys = Object.keys(shellBridge);
			for (const key of bridgeKeys) {
				expect(expectedKeys.has(key)).toBe(true);
			}

			// Verify capabilities only has the two defined flags
			const capKeys = Object.keys(shellBridge.capabilities);
			expect(capKeys.sort()).toEqual(['hasNativeNotification', 'hasSecureStorage']);

			// Verify tokenStore only has get, set, clear
			const tokenStoreKeys = Object.keys(shellBridge.tokenStore);
			expect(tokenStoreKeys.sort()).toEqual(['clear', 'get', 'set']);
		});

		it('enforces static type constraints via TypeScript interfaces', () => {
			// Compile-time interface check
			const typedBridge: ShellBridge = shellBridge;
			expect(typedBridge).toBeDefined();

			const platform: ShellPlatform = typedBridge.platform;
			expect(['browser', 'tauri', 'capacitor']).toContain(platform);

			const capabilities: ShellCapabilities = typedBridge.capabilities;
			expect(typeof capabilities.hasSecureStorage).toBe('boolean');
			expect(typeof capabilities.hasNativeNotification).toBe('boolean');

			const store: ShellTokenStore = typedBridge.tokenStore;
			expect(typeof store.get).toBe('function');
			expect(typeof store.set).toBe('function');
			expect(typeof store.clear).toBe('function');
		});
	});

	describe('AC 2: Synchronous detection without userAgent, try/catch, or re-probing', () => {
		it('detects tauri synchronously when __TAURI_INTERNALS__ is present', () => {
			const mockWin = {
				__TAURI_INTERNALS__: {},
			};
			const result = detectShell(mockWin);
			expect(result.platform).toBe('tauri');
			expect(result.capabilities).toEqual({
				hasSecureStorage: true,
				hasNativeNotification: true,
			});
			expect(Object.isFrozen(result)).toBe(true);
			expect(Object.isFrozen(result.capabilities)).toBe(true);
		});

		it('detects capacitor synchronously when Capacitor.isNativePlatform() is true', () => {
			const mockWin = {
				Capacitor: {
					isNativePlatform: () => true,
				},
			};
			const result = detectShell(mockWin);
			expect(result.platform).toBe('capacitor');
			expect(result.capabilities).toEqual({
				hasSecureStorage: true,
				hasNativeNotification: true,
			});
			expect(Object.isFrozen(result)).toBe(true);
			expect(Object.isFrozen(result.capabilities)).toBe(true);
		});

		it('falls back to browser when neither global is present or isNativePlatform returns false', () => {
			const emptyWin = {};
			const result1 = detectShell(emptyWin);
			expect(result1.platform).toBe('browser');
			expect(result1.capabilities).toEqual({
				hasSecureStorage: false,
				hasNativeNotification: false,
			});

			const webCapacitorWin = {
				Capacitor: {
					isNativePlatform: () => false,
				},
			};
			const result2 = detectShell(webCapacitorWin);
			expect(result2.platform).toBe('browser');
			expect(result2.capabilities).toEqual({
				hasSecureStorage: false,
				hasNativeNotification: false,
			});
		});

		it('exports SHELL frozen at module load time', () => {
			expect(Object.isFrozen(SHELL)).toBe(true);
			expect(Object.isFrozen(SHELL.capabilities)).toBe(true);
		});
	});

	describe('AC 4 & E-200: Fallback implementations in browser mode', () => {
		it('tokenStore falls back to sessionStorage (key agsched.token) and never touches localStorage', async () => {
			await shellBridge.tokenStore.set('test-jwt-token-12345');
			expect(sessionStorage.setItem).toHaveBeenCalledWith(
				SESSION_STORAGE_TOKEN_KEY,
				'test-jwt-token-12345',
			);
			expect(localStorage.setItem).not.toHaveBeenCalled();

			const retrieved = await shellBridge.tokenStore.get();
			expect(retrieved).toBe('test-jwt-token-12345');

			await shellBridge.tokenStore.clear();
			expect(sessionStorage.removeItem).toHaveBeenCalledWith(SESSION_STORAGE_TOKEN_KEY);
			expect(await shellBridge.tokenStore.get()).toBeNull();
		});

		it('hostHint returns window.location.origin in browser mode for baseUrl discovery (E-200)', async () => {
			const hint = await shellBridge.hostHint();
			expect(hint).toBe('http://localhost:7817');
		});

		it('notify uses Notification API when permission is granted and wires deepLink click', async () => {
			let createdBody = '';
			let createdTitle = '';

			class MockNotification {
				static permission: NotificationPermission = 'granted';
				static requestPermission = vi.fn().mockResolvedValue('granted');
				title: string;
				options?: { body?: string };
				onclick: (() => void) | null = null;
				constructor(title: string, options?: { body?: string }) {
					this.title = title;
					this.options = options;
					createdTitle = title;
					createdBody = options?.body ?? '';
				}
			}

			Object.defineProperty(window, 'Notification', {
				value: MockNotification,
				writable: true,
				configurable: true,
			});

			await shellBridge.notify({
				title: 'Task Assigned',
				body: 'Agent completed step 1',
				deepLink: '#/run/run-101',
			});

			expect(createdTitle).toBe('Task Assigned');
			expect(createdBody).toBe('Agent completed step 1');
		});

		it('notify falls back to document.title (N) prefix and emits fallback event when permission denied', async () => {
			const mockDeniedNotification = {
				permission: 'denied' as NotificationPermission,
				requestPermission: vi.fn().mockResolvedValue('denied'),
			};

			Object.defineProperty(window, 'Notification', {
				value: mockDeniedNotification,
				writable: true,
				configurable: true,
			});

			const fallbackReceived: ShellNotificationOptions[] = [];
			const unsubscribe = onNotificationFallback((opt) => {
				fallbackReceived.push(opt);
			});

			await shellBridge.notify({
				title: 'Review Required',
				body: 'Approval gate waiting',
			});

			expect(getBrowserUnreadNotificationCount()).toBe(1);
			expect(document.title).toBe('(1) Agent Scheduler');
			expect(fallbackReceived).toHaveLength(1);
			expect(fallbackReceived[0]?.title).toBe('Review Required');

			await shellBridge.notify({
				title: 'Second Alert',
			});
			expect(getBrowserUnreadNotificationCount()).toBe(2);
			expect(document.title).toBe('(2) Agent Scheduler');

			resetBrowserNotificationBadge();
			expect(getBrowserUnreadNotificationCount()).toBe(0);
			expect(document.title).toBe('Agent Scheduler');

			unsubscribe();
		});

		it('prohibits alert() and never pretends to have native notification in browser mode', async () => {
			const alertSpy = vi.fn();
			(window as unknown as { alert: unknown }).alert = alertSpy;

			await shellBridge.notify({
				title: 'Silent notification',
			});

			expect(alertSpy).not.toHaveBeenCalled();
			expect(shellBridge.capabilities.hasNativeNotification).toBe(false);
		});
	});

	describe('E-227: Sole source of truth when native shell adapter is present', () => {
		it('delegates all three capabilities to the native adapter and never writes sessionStorage', async () => {
			// The platform is frozen at module load, so the shell branch is only reachable by importing
			// the module again with the shell global already in place.
			sessionStorage.setItem(SESSION_STORAGE_TOKEN_KEY, 'stale-browser-copy');
			(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
			vi.resetModules();
			const nativeShell = await import('../src/shell/shell-bridge.ts');
			expect(nativeShell.shellBridge.platform).toBe('tauri');
			// E-227: startup in the shell drops the stale browser copy instead of dual-writing.
			expect(sessionStorage.getItem(SESSION_STORAGE_TOKEN_KEY)).toBeNull();

			let nativeToken: string | null = 'native-keychain-token';
			const nativeStore = {
				get: vi.fn(async () => nativeToken),
				set: vi.fn(async (next: string) => {
					nativeToken = next;
				}),
				clear: vi.fn(async () => {
					nativeToken = null;
				}),
			};
			const nativeNotify = vi.fn(async (_options: ShellNotificationOptions) => {});
			const nativeHostHint = vi.fn(async () => 'http://127.0.0.1:7817');
			nativeShell.registerNativeShellAdapter({
				tokenStore: nativeStore,
				notify: nativeNotify,
				hostHint: nativeHostHint,
			});

			expect(await nativeShell.shellBridge.tokenStore.get()).toBe('native-keychain-token');
			await nativeShell.shellBridge.tokenStore.set('rotated-token');
			expect(nativeStore.set).toHaveBeenCalledWith('rotated-token');
			expect(await nativeShell.shellBridge.tokenStore.get()).toBe('rotated-token');
			await nativeShell.shellBridge.tokenStore.clear();
			expect(nativeStore.clear).toHaveBeenCalled();
			await nativeShell.shellBridge.notify({ title: 'Native Notification' });
			expect(nativeNotify).toHaveBeenCalledWith({ title: 'Native Notification' });
			expect(await nativeShell.shellBridge.hostHint()).toBe('http://127.0.0.1:7817');
			expect(sessionStorage.setItem).not.toHaveBeenCalledWith(
				SESSION_STORAGE_TOKEN_KEY,
				'rotated-token',
			);

			(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
			vi.resetModules();
		});
	});
});
