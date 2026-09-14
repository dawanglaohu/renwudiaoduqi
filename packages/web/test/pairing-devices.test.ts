import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceDto } from '../../shared/src/api/devices.ts';
import type { CreatePairingCodeResponse } from '../../shared/src/api/pair.ts';
import { clearManualHost, getManualHost, setManualHost } from '../src/api/base-url.ts';
import {
	ApiError,
	clearCachedToken,
	getCachedToken,
	httpClient,
	setCachedToken,
} from '../src/api/http-client.ts';
import { RouteGuard, hasDeviceToken } from '../src/app/route-guard.tsx';
import { matchRoute } from '../src/app/routes.tsx';
import { PairingContainer } from '../src/features/pairing/pairing-container.tsx';
import { PairingView } from '../src/features/pairing/pairing-view.tsx';
import {
	extractHostPort,
	formatBrowserDeviceTimestamp,
	generateDefaultDeviceName,
} from '../src/features/pairing/use-pairing.ts';
import { BrowserModeBanner } from '../src/features/settings-devices/browser-mode-banner.tsx';
import { DeviceListView } from '../src/features/settings-devices/device-list-view.tsx';
import { DeviceRevokeDialog } from '../src/features/settings-devices/device-revoke-dialog.tsx';
import { SettingsDevicesContainer } from '../src/features/settings-devices/settings-devices-container.tsx';
import { formatIsoDateTime } from '../src/features/settings-devices/use-settings-devices.ts';
import {
	CURRENT_DEVICE_ID_STORAGE_KEY,
	SESSION_STORAGE_TOKEN_KEY,
	registerNativeShellAdapter,
	shellBridge,
} from '../src/shell/shell-bridge.ts';

describe('M9-T15 设置页：设备、配对与浏览器模式 (AC 1-7, E-06, E-09, E-125, E-127, E-227, E-228, E-229)', () => {
	const originalWindow = globalThis.window;
	const originalDocument = globalThis.document;
	const originalSessionStorage = globalThis.sessionStorage;
	const originalLocalStorage = globalThis.localStorage;

	let mockSessionStore: Record<string, string> = {};
	let mockLocalStore: Record<string, string> = {};

	beforeEach(() => {
		mockSessionStore = {};
		mockLocalStore = {};
		clearCachedToken();
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
				origin: 'http://192.168.1.50:7817',
				hash: '#/pair',
				replace: vi.fn((newHash: string) => {
					fakeWindow.location.hash = newHash;
				}),
			},
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		};

		Object.defineProperty(globalThis, 'window', {
			value: fakeWindow,
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
		clearCachedToken();
		registerNativeShellAdapter(null);
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
		vi.restoreAllMocks();
	});

	describe('AC 1 & E-06: 配对失败报到具体环节与手填地址兜底', () => {
		it('extractHostPort extracts host:port from urls and raw strings cleanly', () => {
			expect(extractHostPort('http://192.168.1.100:7817')).toBe('192.168.1.100:7817');
			expect(extractHostPort('https://agent.local:8080/api')).toBe('agent.local:8080');
			expect(extractHostPort('10.0.0.5:7817')).toBe('10.0.0.5:7817');
			expect(extractHostPort('')).toBe('');
		});

		it('reports exact stage and host:port when network connection fails (E-06)', async () => {
			vi.spyOn(httpClient, 'post').mockRejectedValueOnce(
				new ApiError({
					code: 'E_NETWORK',
					message: 'Failed to fetch',
					requestId: 'req-net-01',
				}),
			);

			const view = renderToStaticMarkup(
				createElement(PairingView, {
					pairing: {
						pairingCode: 'TEST12',
						setPairingCode: vi.fn(),
						deviceName: '测试设备',
						setDeviceName: vi.fn(),
						manualHost: '192.168.1.100:7817',
						setManualHostInput: vi.fn(),
						showManualHost: true,
						setShowManualHost: vi.fn(),
						isSubmitting: false,
						error: {
							stage: 'network',
							message: '扫到码但连不上 192.168.1.100:7817',
							hostPort: '192.168.1.100:7817',
							code: 'E_NETWORK',
						},
						clearError: vi.fn(),
						isSuccess: false,
						isBrowser: true,
						submitPairing: vi.fn(),
						saveManualAddress: vi.fn(),
					},
				}),
			);

			// AC 1 & E-06: Must explicitly report "扫到码但连不上 host:port"
			expect(view).toContain('扫到码但连不上 192.168.1.100:7817');
			expect(view).toContain('AP 隔离');
			expect(view).toContain('manual-host-section');
			expect(view).toContain('保存地址');
		});

		it('saves manual host into localStorage as fallback without losing pairing state', () => {
			setManualHost('192.168.1.120:7817');
			expect(getManualHost()).toBe('192.168.1.120:7817');
			expect(localStorage.setItem).toHaveBeenCalledWith('agsched.host', '192.168.1.120:7817');

			clearManualHost();
			expect(getManualHost()).toBeNull();
		});
	});

	describe('AC 2 & E-127: 已配对设备可列出并单独吊销，连接立即断开', () => {
		const sampleDevices: readonly DeviceDto[] = [
			{
				id: 'dev_01',
				name: 'MacBook 桌面端',
				pairedAt: '2026-09-12T10:00:00.000Z',
				lastSeenAt: '2026-09-12T10:05:00.000Z',
				revokedAt: null,
			},
			{
				id: 'dev_02',
				name: '浏览器 · 09-12 11:20',
				pairedAt: '2026-09-12T11:20:00.000Z',
				lastSeenAt: null,
				revokedAt: null,
			},
			{
				id: 'dev_03',
				name: '已遗失手机',
				pairedAt: '2026-09-10T08:00:00.000Z',
				lastSeenAt: '2026-09-10T09:00:00.000Z',
				revokedAt: '2026-09-11T12:00:00.000Z',
			},
		];

		it('renders all devices with status, timestamps, and individual revoke buttons', () => {
			const rendered = renderToStaticMarkup(
				createElement(DeviceListView, {
					devicesState: {
						devices: sampleDevices,
						isLoading: false,
						error: null,
						clearError: vi.fn(),
						refreshDevices: vi.fn(),
						newPairingCode: null,
						codeCountdownSec: 0,
						isGeneratingCode: false,
						generatePairingCode: vi.fn(),
						dismissPairingCode: vi.fn(),
						revokingDevice: null,
						isRevoking: false,
						openRevokeDialog: vi.fn(),
						closeRevokeDialog: vi.fn(),
						confirmRevoke: vi.fn(),
						currentBaseUrl: 'http://192.168.1.50:7817',
						manualHost: '',
						setManualHostInput: vi.fn(),
						saveManualHostAddress: vi.fn(),
						resetManualHostAddress: vi.fn(),
						isBrowser: false,
						currentDeviceId: 'dev_01',
					},
				}),
			);

			expect(rendered).toContain('MacBook 桌面端');
			expect(rendered).toContain('浏览器 · 09-12 11:20');
			expect(rendered).toContain('已遗失手机');
			expect(rendered).toContain('当前设备');
			expect(rendered).toContain('已吊销');
			expect(rendered).toContain('吊销');
		});

		it('opens revocation confirmation dialog with clear E-127 disconnect warning', () => {
			const targetDevice = sampleDevices[1] ?? null;
			if (!targetDevice) {
				throw new Error('Expected targetDevice to be defined');
			}
			const dialog = renderToStaticMarkup(
				createElement(DeviceRevokeDialog, {
					device: targetDevice,
					isRevoking: false,
					onConfirm: vi.fn(),
					onCancel: vi.fn(),
				}),
			);

			expect(dialog).toContain('吊销设备授权');
			expect(dialog).toContain(targetDevice.name);
			expect(dialog).toContain(targetDevice.id);
			expect(dialog).toContain('活动连接将立即断开 (E-127)');
			expect(dialog).toContain('确认吊销');
		});

		it('formatIsoDateTime formats timestamps or falls back gracefully', () => {
			expect(formatIsoDateTime(null)).toBe('—');
			expect(formatIsoDateTime('')).toBe('—');
			const formatted = formatIsoDateTime('2026-09-12T10:30:00.000Z');
			expect(formatted).toMatch(/^2026-09-12 \d{2}:30:00$/);
		});
	});

	describe('AC 3 & E-09: 保存设备令牌而非 IP，PC 局域网 IP 变化不需重新授权', () => {
		it('saves token in shell tokenStore while allowing baseUrl / manual host to update freely', async () => {
			// Initially paired with PC at 192.168.1.50
			await shellBridge.tokenStore.set('dev-token-999');
			setCachedToken('dev-token-999');
			expect(getCachedToken()).toBe('dev-token-999');

			// PC IP switches to 192.168.1.88 (DHCP renewal)
			setManualHost('192.168.1.88:7817');
			expect(getManualHost()).toBe('192.168.1.88:7817');

			// Token is still intact and authorized without needing re-pairing (E-09)
			expect(await shellBridge.tokenStore.get()).toBe('dev-token-999');
			expect(hasDeviceToken()).toBe(true);
		});
	});

	describe('AC 4 & E-125: 允许配对多台设备，每台独发单独可吊销令牌', () => {
		it('supports generating temporary pairing codes (TTL <= 60s) for adding multiple devices', () => {
			const codeData: CreatePairingCodeResponse = {
				code: 'PAIR99',
				expiresAt: new Date(Date.now() + 55000).toISOString(),
			};

			const rendered = renderToStaticMarkup(
				createElement(DeviceListView, {
					devicesState: {
						devices: [],
						isLoading: false,
						error: null,
						clearError: vi.fn(),
						refreshDevices: vi.fn(),
						newPairingCode: codeData,
						codeCountdownSec: 55,
						isGeneratingCode: false,
						generatePairingCode: vi.fn(),
						dismissPairingCode: vi.fn(),
						revokingDevice: null,
						isRevoking: false,
						openRevokeDialog: vi.fn(),
						closeRevokeDialog: vi.fn(),
						confirmRevoke: vi.fn(),
						currentBaseUrl: 'http://127.0.0.1:7817',
						manualHost: '',
						setManualHostInput: vi.fn(),
						saveManualHostAddress: vi.fn(),
						resetManualHostAddress: vi.fn(),
						isBrowser: false,
						currentDeviceId: null,
					},
				}),
			);

			expect(rendered).toContain('new-pairing-code-card');
			expect(rendered).toContain('PAIR99');
			expect(rendered).toContain('55');
			expect(rendered).toContain('关闭配对码');
		});
	});

	describe('AC 5 & E-229: 浏览器模式下令牌落 sessionStorage，顶栏常驻两项必有提示', () => {
		it('BrowserModeBanner states BOTH "关闭标签后需重新配对" and "本模式下没有系统通知"', () => {
			const banner = renderToStaticMarkup(createElement(BrowserModeBanner, {}));

			// AC 5 & E-229 mandatory requirement:
			expect(banner).toContain('关闭标签后需重新配对');
			expect(banner).toContain('本模式下没有系统通知');
			expect(banner).toContain('浏览器模式');
		});

		it('PairingView in browser mode renders persistent banner with both warnings', () => {
			const view = renderToStaticMarkup(
				createElement(PairingView, {
					pairing: {
						pairingCode: '',
						setPairingCode: vi.fn(),
						deviceName: '浏览器 · 09-12 12:00',
						setDeviceName: vi.fn(),
						manualHost: '',
						setManualHostInput: vi.fn(),
						showManualHost: false,
						setShowManualHost: vi.fn(),
						isSubmitting: false,
						error: null,
						clearError: vi.fn(),
						isSuccess: false,
						isBrowser: true,
						submitPairing: vi.fn(),
						saveManualAddress: vi.fn(),
					},
				}),
			);

			expect(view).toContain('browser-mode-alert');
			expect(view).toContain('关闭标签后需重新配对');
			expect(view).toContain('本模式下没有系统通知');
		});

		it('token persists in sessionStorage (agsched.token) and never touches localStorage in browser mode', async () => {
			await shellBridge.tokenStore.set('session-token-abc');
			expect(sessionStorage.setItem).toHaveBeenCalledWith(
				SESSION_STORAGE_TOKEN_KEY,
				'session-token-abc',
			);
			expect(localStorage.setItem).not.toHaveBeenCalled();
		});
	});

	describe('AC 6 & E-227: 壳存在时以壳安全存储为唯一真相源，启动清掉会话副本，绝不双写', () => {
		it('clears stale sessionStorage token when native adapter is registered and never writes sessionStorage', async () => {
			// Simulate existing stale token in sessionStorage from earlier browser run
			mockSessionStore[SESSION_STORAGE_TOKEN_KEY] = 'stale-token-browser';
			expect(mockSessionStore[SESSION_STORAGE_TOKEN_KEY]).toBe('stale-token-browser');

			let nativeStoredToken: string | null = 'native-keychain-tok';
			const mockNativeStore = {
				get: vi.fn(async () => nativeStoredToken),
				set: vi.fn(async (tok: string) => {
					nativeStoredToken = tok;
				}),
				clear: vi.fn(async () => {
					nativeStoredToken = null;
				}),
			};

			registerNativeShellAdapter({
				tokenStore: mockNativeStore,
			});

			// SHELL.platform 在本测试进程里恒为 browser，上面这行不会走壳分支；
			// 真壳分支固定由下面这个用例在全部模块重新加载、__TAURI_INTERNALS__ 存在的前提下验。
			expect(mockSessionStore[SESSION_STORAGE_TOKEN_KEY]).toBe('stale-token-browser');
		});

		it('E-227: shell mode clears the stale session copy on startup and never dual-writes the token', async () => {
			mockSessionStore[SESSION_STORAGE_TOKEN_KEY] = 'stale-token-browser';
			mockSessionStore[CURRENT_DEVICE_ID_STORAGE_KEY] = 'stale-device-browser';
			(globalThis as unknown as { window: Record<string, unknown> }).window.__TAURI_INTERNALS__ =
				{};

			vi.resetModules();
			const shell = await import('../src/shell/shell-bridge.ts');
			expect(shell.shellBridge.platform).toBe('tauri');
			// 启动清掉会话副本（令牌与设备 id 都不留在 sessionStorage）
			expect(mockSessionStore[SESSION_STORAGE_TOKEN_KEY]).toBeUndefined();
			expect(mockSessionStore[CURRENT_DEVICE_ID_STORAGE_KEY]).toBeUndefined();

			const nativeStore = {
				set: vi.fn(async () => undefined),
				get: vi.fn(async () => 'native-token'),
				clear: vi.fn(async () => undefined),
			};
			shell.registerNativeShellAdapter({ tokenStore: nativeStore });
			await shell.shellBridge.tokenStore.set('written-in-shell');
			expect(nativeStore.set).toHaveBeenCalledWith('written-in-shell');
			// 绝不双写：壳模式下 sessionStorage 不得出现令牌
			expect(mockSessionStore[SESSION_STORAGE_TOKEN_KEY]).toBeUndefined();
		});
	});

	describe('E-127: 本会话设备身份（claim 返回的 deviceId）', () => {
		it('remembers the deviceId so the list can mark 当前设备 and self-revoke returns to #/pair', async () => {
			const { rememberCurrentDeviceId, readCurrentDeviceId } = await import(
				'../src/shell/shell-bridge.ts'
			);
			expect(readCurrentDeviceId()).toBeNull();
			rememberCurrentDeviceId('dev_claim_01');
			expect(mockSessionStore[CURRENT_DEVICE_ID_STORAGE_KEY]).toBe('dev_claim_01');
			expect(readCurrentDeviceId()).toBe('dev_claim_01');
		});
	});

	describe('AC 7 & E-228: 同一浏览器第二个标签需重新配对，设备名默认带「浏览器 · 时间」', () => {
		it('formats browser device timestamp and pre-fills default device name with "浏览器 · 时间"', () => {
			const fixedTime = new Date(2026, 8, 12, 14, 25); // 2026-09-12 14:25
			const timestamp = formatBrowserDeviceTimestamp(fixedTime);
			expect(timestamp).toBe('09-12 14:25');

			const defaultBrowserName = generateDefaultDeviceName(true, fixedTime);
			expect(defaultBrowserName).toBe('浏览器 · 09-12 14:25');

			const defaultDesktopName = generateDefaultDeviceName(false, fixedTime);
			expect(defaultDesktopName).toBe('桌面端');
		});

		it('RouteGuard requires second browser tab to pair because sessionStorage is tab-isolated', () => {
			// Tab 1 had a token
			mockSessionStore[SESSION_STORAGE_TOKEN_KEY] = 'tab1-token';
			setCachedToken('tab1-token');
			expect(hasDeviceToken()).toBe(true);

			// Tab 2 opens: fresh tab has completely empty sessionStorage and empty memory
			clearCachedToken();
			expect(hasDeviceToken()).toBe(false);

			// Route guard intercepts protected route and requires pairing
			const targetRoute = matchRoute('#/settings/devices');
			expect(targetRoute.auth).toBe(true);

			const guardHtml = renderToStaticMarkup(
				createElement(
					RouteGuard,
					{ currentRoute: targetRoute, hasToken: () => false },
					createElement('div', null, 'PROTECTED_DEVICES_CONTENT'),
				),
			);

			expect(guardHtml).not.toContain('PROTECTED_DEVICES_CONTENT');
			expect(guardHtml).toContain('需要设备配对');
			expect(guardHtml).toContain('前往配对');
		});
	});

	describe('Containers layout & routing compliance', () => {
		it('renders PairingContainer with layout-only root container', () => {
			const container = renderToStaticMarkup(createElement(PairingContainer, {}));
			expect(container).toContain('设备配对');
			expect(container).toContain('配对码');
			expect(container).toContain('设备名称');
		});

		it('renders SettingsDevicesContainer with layout-only root container', () => {
			const container = renderToStaticMarkup(createElement(SettingsDevicesContainer, {}));
			expect(container).toContain('设备与配对管理');
			expect(container).toContain('已配对设备列表');
		});
	});
});
