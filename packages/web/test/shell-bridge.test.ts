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
	createCapacitorShellAdapter,
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
		it('contains exactly 4 capabilities (tokenStore, notify, hostHint, launchService) and 3 read-only flags', () => {
			const expectedKeys = new Set([
				'platform',
				'capabilities',
				'tokenStore',
				'notify',
				'hostHint',
				'launchService',
			]);
			const bridgeKeys = Object.keys(shellBridge);
			for (const key of bridgeKeys) {
				expect(expectedKeys.has(key)).toBe(true);
			}

			// Verify capabilities has exactly the three defined flags
			const capKeys = Object.keys(shellBridge.capabilities);
			expect(capKeys.sort()).toEqual([
				'canLaunchService',
				'hasNativeNotification',
				'hasSecureStorage',
			]);

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
				canLaunchService: true,
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
				canLaunchService: false,
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
				canLaunchService: false,
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
				canLaunchService: false,
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
		it('self-installs the Tauri adapter and never writes sessionStorage', async () => {
			// The platform is frozen at module load, so the shell branch is only reachable by importing
			// the module again with the shell global already in place.
			sessionStorage.setItem(SESSION_STORAGE_TOKEN_KEY, 'stale-browser-copy');
			let nativeToken: string | null = 'native-keychain-token';
			const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
				switch (command) {
					case 'get_token':
						return nativeToken;
					case 'set_token':
						nativeToken = String(args?.token ?? '');
						return null;
					case 'clear_token':
						nativeToken = null;
						return null;
					case 'get_host_hint':
						return 'http://127.0.0.1:7817';
					default:
						throw new Error(`Unexpected Tauri command: ${command}`);
				}
			});
			(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
				invoke,
			};
			vi.resetModules();
			const nativeShell = await import('../src/shell/shell-bridge.ts');
			expect(nativeShell.shellBridge.platform).toBe('tauri');
			expect(nativeShell.shellBridge.capabilities.hasSecureStorage).toBe(true);
			// E-227: startup in the shell drops the stale browser copy instead of dual-writing.
			expect(sessionStorage.getItem(SESSION_STORAGE_TOKEN_KEY)).toBeNull();

			expect(await nativeShell.shellBridge.tokenStore.get()).toBe('native-keychain-token');
			await nativeShell.shellBridge.tokenStore.set('rotated-token');
			expect(invoke).toHaveBeenCalledWith('set_token', { token: 'rotated-token' });
			expect(invoke.mock.calls.filter(([command]) => command === 'set_token')).toHaveLength(1);
			expect(await nativeShell.shellBridge.tokenStore.get()).toBe('rotated-token');
			await nativeShell.shellBridge.tokenStore.clear();
			expect(invoke).toHaveBeenCalledWith('clear_token');
			expect(await nativeShell.shellBridge.hostHint()).toBe('http://127.0.0.1:7817');
			expect(invoke).toHaveBeenCalledWith('get_host_hint');
			expect(sessionStorage.setItem).not.toHaveBeenCalledWith(
				SESSION_STORAGE_TOKEN_KEY,
				'rotated-token',
			);

			(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
			vi.resetModules();
		});

		it('uses Capacitor Preferences for the token and host without a session copy', async () => {
			const values = new Map<string, string>([
				['agsched.token', 'mobile-native-token'],
				['agsched.host', ' https://daemon.example.test/ '],
			]);
			const preferences = {
				get: vi.fn(async ({ key }: { key: string }) => ({ value: values.get(key) ?? null })),
				set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
					values.set(key, value);
				}),
				remove: vi.fn(async ({ key }: { key: string }) => {
					values.delete(key);
				}),
			};
			const adapter = createCapacitorShellAdapter(preferences);

			expect(await adapter.tokenStore?.get?.()).toBe('mobile-native-token');
			await adapter.tokenStore?.set?.('mobile-rotated-token');
			expect(preferences.set).toHaveBeenCalledWith({
				key: 'agsched.token',
				value: 'mobile-rotated-token',
			});
			expect(await adapter.hostHint?.()).toBe('https://daemon.example.test/');
			await adapter.tokenStore?.clear?.();
			expect(preferences.remove).toHaveBeenCalledWith({ key: 'agsched.token' });
			expect(sessionStorage.setItem).not.toHaveBeenCalledWith(
				SESSION_STORAGE_TOKEN_KEY,
				'mobile-rotated-token',
			);
		});
	});

	describe('M10-T6 AC 5: launchService only on tauri, E_SHELL_UNAVAILABLE everywhere else', () => {
		it('reports canLaunchService=false and throws E_SHELL_UNAVAILABLE in browser mode', async () => {
			expect(shellBridge.platform).toBe('browser');
			expect(shellBridge.capabilities.canLaunchService).toBe(false);

			await expect(shellBridge.launchService()).rejects.toMatchObject({
				code: 'E_SHELL_UNAVAILABLE',
			});
		});

		it('reports canLaunchService=false and throws E_SHELL_UNAVAILABLE on capacitor', async () => {
			(window as unknown as { Capacitor?: unknown }).Capacitor = {
				isNativePlatform: () => true,
				Plugins: {
					Preferences: {
						get: vi.fn(async () => ({ value: null })),
						set: vi.fn(async () => undefined),
						remove: vi.fn(async () => undefined),
					},
				},
			};
			vi.resetModules();
			const mobileShell = await import('../src/shell/shell-bridge.ts');

			expect(mobileShell.shellBridge.platform).toBe('capacitor');
			expect(mobileShell.shellBridge.capabilities.canLaunchService).toBe(false);
			await expect(mobileShell.shellBridge.launchService()).rejects.toMatchObject({
				code: 'E_SHELL_UNAVAILABLE',
			});

			(window as unknown as { Capacitor?: unknown }).Capacitor = undefined;
			vi.resetModules();
		});

		it('invokes launch_service exactly once and returns the pid on tauri', async () => {
			const invoke = vi.fn(async (command: string) => {
				if (command === 'launch_service') {
					return 4242;
				}
				throw new Error(`Unexpected Tauri command: ${command}`);
			});
			(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
			vi.resetModules();
			const nativeShell = await import('../src/shell/shell-bridge.ts');

			expect(nativeShell.shellBridge.capabilities.canLaunchService).toBe(true);
			expect(await nativeShell.shellBridge.launchService()).toEqual({ pid: 4242 });
			expect(invoke.mock.calls.filter(([command]) => command === 'launch_service')).toHaveLength(1);

			(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
			vi.resetModules();
		});

		it('rejects a launch_service answer that is not a usable pid', async () => {
			const invoke = vi.fn(async () => 'not-a-pid');
			(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
			vi.resetModules();
			const nativeShell = await import('../src/shell/shell-bridge.ts');

			await expect(nativeShell.shellBridge.launchService()).rejects.toThrow(/unusable pid/);

			(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
			vi.resetModules();
		});
	});
});
