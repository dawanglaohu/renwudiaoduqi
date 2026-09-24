// @vitest-environment jsdom

/**
 * M10-T6 AC 1 / AC 5: the connect-failed screen and its 「启动调度服务」 action.
 *
 * The screen is the only production call site of `shellBridge.launchService()`; these tests
 * pin the three properties that matter: the button exists only where the capability does,
 * one click produces exactly one `launch_service` invoke, and the snapshot is retried by the
 * Web UI afterwards (the shell never retries, E-146).
 */

import type { ShellBridge } from '@agent-scheduler/shared/shell/bridge-contract';
import { act, createElement } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/app.tsx';
import { reportFirstScreenFailure, subscribeFirstScreenFailure } from '../src/app/bootstrap.ts';
import {
	ConnectFailedScreen,
	SERVICE_NOT_RUNNING_TITLE,
	useFirstScreenFailure,
} from '../src/app/connect-failed.tsx';
import { LAUNCH_SERVICE_FAILED_MESSAGE } from '../src/i18n/error-messages.ts';
import { shellBridge } from '../src/shell/shell-bridge.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ScreenComponent = typeof ConnectFailedScreen;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(element: ReturnType<typeof createElement>): void {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root?.render(element);
	});
}

async function click(element: Element | null): Promise<void> {
	expect(element, 'element to click').not.toBeNull();
	await act(async () => {
		element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await Promise.resolve();
	});
	await act(async () => {
		await Promise.resolve();
	});
}

function installTauriGlobals(invoke: (command: string) => Promise<unknown>): void {
	(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
	vi.resetModules();
}

function uninstallTauriGlobals(): void {
	(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
	vi.resetModules();
}

/** Loads the screen again while the tauri global is in place, so the capability is frozen true. */
async function importTauriScreen(invoke: (command: string) => Promise<unknown>): Promise<{
	readonly Screen: ScreenComponent;
	readonly bridge: ShellBridge;
}> {
	installTauriGlobals(invoke);
	const bridge = (await import('../src/shell/shell-bridge.ts')).shellBridge;
	const { ConnectFailedScreen: Screen } = await import('../src/app/connect-failed.tsx');
	expect(bridge.capabilities.canLaunchService).toBe(true);
	return { Screen, bridge };
}

afterEach(() => {
	act(() => {
		root?.unmount();
	});
	root = null;
	container?.remove();
	container = null;
	reportFirstScreenFailure(null);
	uninstallTauriGlobals();
});

describe('M10-T6 AC 1: connect-failed screen', () => {
	beforeEach(() => {
		reportFirstScreenFailure(null);
	});

	it('shows the E-04 wording, the resolved address and the requestId', () => {
		render(
			createElement(ConnectFailedScreen, {
				code: 'E_NETWORK',
				requestId: 'req-abc-123',
				baseUrl: 'http://127.0.0.1:7817',
				onRetry: () => {},
			}),
		);

		const screen = document.querySelector('[data-testid="connect-failed-screen"]');
		expect(screen).not.toBeNull();
		// E-04: 「电脑上的调度服务未启动」, never 「连接超时」.
		expect(screen?.textContent).toContain(SERVICE_NOT_RUNNING_TITLE);
		expect(screen?.textContent).not.toContain('连接超时');
		expect(screen?.textContent).toContain('http://127.0.0.1:7817');
		expect(screen?.textContent).toContain('req-abc-123');
		// The message for the code comes from the single i18n source, not from the component.
		expect(screen?.textContent).toContain('网络连接异常，请检查调度服务是否在线');
	});

	it('hides the launch button in browser mode and never calls launchService', async () => {
		const launchService = vi.fn(async () => ({ pid: 1 }));
		render(
			createElement(ConnectFailedScreen, {
				code: 'E_NETWORK',
				requestId: 'req-1',
				baseUrl: 'http://localhost:3000',
				onRetry: () => {},
				launchService,
			}),
		);

		expect(shellBridge.capabilities.canLaunchService).toBe(false);
		expect(document.querySelector('[data-testid="launch-service"]')).toBeNull();
		expect(launchService).not.toHaveBeenCalled();
		// The capability flag is the UI contract; the bridge still refuses the call outright.
		await expect(shellBridge.launchService()).rejects.toMatchObject({
			code: 'E_SHELL_UNAVAILABLE',
		});
	});

	it('launches once, reports the pid and lets the Web UI retry the snapshot', async () => {
		const invoke = vi.fn(async (command: string) => {
			if (command === 'launch_service') {
				return 31337;
			}
			throw new Error(`Unexpected Tauri command: ${command}`);
		});
		const { Screen, bridge } = await importTauriScreen(invoke);

		const onRetry = vi.fn();
		const launchService = vi.fn(() => bridge.launchService());
		render(
			createElement(Screen, {
				code: 'E_NETWORK',
				requestId: 'req-2',
				baseUrl: 'http://127.0.0.1:7817',
				onRetry,
				launchService,
			}),
		);

		const button = document.querySelector('[data-testid="launch-service"]');
		expect(button?.textContent).toContain('启动调度服务');

		await click(button);
		await click(button);

		expect(launchService).toHaveBeenCalledTimes(1);
		expect(invoke.mock.calls.filter(([command]) => command === 'launch_service')).toHaveLength(1);
		expect(document.querySelector('[data-testid="launch-pid"]')?.textContent).toContain('31337');
		// Retrying the first-screen snapshot is the Web UI's job, not the shell's.
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it('keeps retrying the Web snapshot while the spawned daemon starts', async () => {
		const invoke = vi.fn(async (_command: string) => 31338);
		const { Screen, bridge } = await importTauriScreen(invoke);
		const { reportFirstScreenFailure: reportTauriFailure } = await import(
			'../src/app/bootstrap.ts'
		);
		let attempts = 0;
		const onRetry = vi.fn(async () => {
			attempts += 1;
			if (attempts === 3) reportTauriFailure(null);
		});
		reportTauriFailure({
			code: 'E_NETWORK',
			requestId: null,
			baseUrl: 'http://127.0.0.1:7817',
			retry: onRetry,
		});
		render(
			createElement(Screen, {
				code: 'E_NETWORK',
				onRetry,
				launchService: () => bridge.launchService(),
			}),
		);

		await click(document.querySelector('[data-testid="launch-service"]'));
		await vi.waitFor(() => expect(onRetry).toHaveBeenCalledTimes(3), { timeout: 2000 });
		expect(invoke.mock.calls.filter(([command]) => command === 'launch_service')).toHaveLength(1);
	});

	it('surfaces a failed launch inline and does not retry the snapshot', async () => {
		const invoke = vi.fn(async (command: string) => {
			if (command === 'launch_service') {
				throw new Error('spawn failed: ENOENT');
			}
			throw new Error(`Unexpected Tauri command: ${command}`);
		});
		const { Screen } = await importTauriScreen(invoke);
		const onRetry = vi.fn();

		render(
			createElement(Screen, {
				code: 'E_NETWORK',
				requestId: null,
				baseUrl: null,
				onRetry,
			}),
		);

		await click(document.querySelector('[data-testid="launch-service"]'));

		const notice = document.querySelector('[data-testid="launch-error"]');
		expect(notice).not.toBeNull();
		// R2: shows Chinese error text from i18n, never raw Rust/English error
		expect(notice?.textContent).toContain(LAUNCH_SERVICE_FAILED_MESSAGE);
		expect(notice?.textContent).not.toContain('spawn failed: ENOENT');
		expect(document.querySelector('[data-testid="launch-pid"]')).toBeNull();
		expect(onRetry).not.toHaveBeenCalled();
	});

	it('uses runtime baseUrl for the example address in label and placeholder without hardcoded 7817', () => {
		render(
			createElement(ConnectFailedScreen, {
				code: 'E_NETWORK',
				requestId: 'req-dyn',
				baseUrl: 'http://127.0.0.1:7900',
				onRetry: () => {},
			}),
		);
		const editButton = document.querySelector('[data-testid="edit-host"]');
		expect(editButton).not.toBeNull();
		act(() => {
			editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		});

		const label = document.querySelector('label[for="connect-failed-host"]');
		expect(label?.textContent).toContain('http://127.0.0.1:7900');
		expect(label?.textContent).not.toContain('7817');

		const input = document.querySelector('[data-testid="host-input"]') as HTMLInputElement | null;
		expect(input?.placeholder).toBe('http://127.0.0.1:7900');
	});

	it('writes a changed address before retrying', async () => {
		const onRetry = vi.fn();
		render(
			createElement(ConnectFailedScreen, {
				code: 'E_TIMEOUT',
				requestId: null,
				baseUrl: null,
				onRetry,
			}),
		);

		await click(document.querySelector('[data-testid="edit-host"]'));
		const input = document.querySelector('[data-testid="host-input"]') as HTMLInputElement | null;
		expect(input).not.toBeNull();
		await act(async () => {
			if (input) {
				// React tracks the previous value on the node; go through the native setter so
				// the change is not swallowed as a no-op.
				const valueSetter = Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					'value',
				)?.set;
				valueSetter?.call(input, 'http://127.0.0.1:7900');
				input.dispatchEvent(new Event('input', { bubbles: true }));
			}
			await Promise.resolve();
		});
		await click(document.querySelector('[data-testid="submit-host"]'));

		expect(localStorage.getItem('agsched.host')).toBe('http://127.0.0.1:7900');
		expect(onRetry).toHaveBeenCalledTimes(1);
	});
});

describe('M10-T6 AC 1: the failure channel is reachable from the app entry', () => {
	beforeEach(() => {
		reportFirstScreenFailure(null);
	});

	it('notifies subscribers and stops notifying after unsubscribe', () => {
		const listener = vi.fn();
		const unsubscribe = subscribeFirstScreenFailure(listener);

		reportFirstScreenFailure({
			code: 'E_NETWORK',
			requestId: 'req-9',
			baseUrl: 'http://127.0.0.1:7817',
			retry: () => {},
		});
		expect(listener).toHaveBeenCalledTimes(1);

		unsubscribe();
		reportFirstScreenFailure(null);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('replaces the routed view with the single screen while a failure is recorded', () => {
		act(() => {
			reportFirstScreenFailure({
				code: 'E_NETWORK',
				requestId: 'req-11',
				baseUrl: 'http://127.0.0.1:7817',
				retry: () => {},
			});
		});
		render(createElement(App));

		const screen = document.querySelector('[data-testid="connect-failed-screen"]');
		expect(screen).not.toBeNull();
		expect(screen?.textContent).toContain(SERVICE_NOT_RUNNING_TITLE);
	});

	it('exposes the same record through useFirstScreenFailure', () => {
		function Probe(): ReturnType<typeof createElement> {
			const failure = useFirstScreenFailure();
			return createElement('span', { 'data-testid': 'probe' }, failure?.code ?? 'none');
		}

		render(createElement(Probe));
		expect(document.querySelector('[data-testid="probe"]')?.textContent).toBe('none');

		act(() => {
			reportFirstScreenFailure({
				code: 'E_NETWORK',
				requestId: 'req-10',
				baseUrl: 'http://127.0.0.1:7817',
				retry: () => {},
			});
		});
		expect(document.querySelector('[data-testid="probe"]')?.textContent).toBe('E_NETWORK');
	});

	it('R1: real production entry captures snapshot E_NETWORK, shows failure screen, launches via invoke, and recovers cleanly on snapshot retry', async () => {
		const invoke = vi.fn(async (command: string) => {
			if (command === 'launch_service') {
				return 54321;
			}
			if (command === 'get_host_hint') {
				return 'http://127.0.0.1:7817';
			}
			throw new Error(`Unexpected Tauri command: ${command}`);
		});
		installTauriGlobals(invoke);
		const { App: DynamicApp } = await import('../src/app/app.tsx');
		const { setCachedToken } = await import('../src/api/http-client.ts');

		setCachedToken('test-device-token');
		window.location.hash = '#/tasks';

		let failFetch = true;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(input);
			if (urlStr.includes('/api/v1/snapshot')) {
				if (failFetch) {
					throw new TypeError('Failed to fetch');
				}
				// Slight delay so the launched state with pid is visible before snapshot clears failure
				await new Promise((r) => setTimeout(r, 40));
				return new Response(
					JSON.stringify({
						tasks: [
							{
								id: 'task-real-1',
								taskKey: 'M10-T6',
								title: 'Shell smoke wiring',
								batchId: 'batch-real-1',
								state: 'landed',
							},
						],
						batches: [
							{
								id: 'batch-real-1',
								docId: 'doc-1',
								batchNo: 1,
								state: 'done',
								defaultExpanded: true,
							},
						],
						latestEventId: 1,
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					},
				);
			}
			return originalFetch ? originalFetch(input, init) : new Response('{}');
		});

		try {
			render(createElement(DynamicApp));

			// 1. Wait for real snapshot fetcher to fail and ConnectFailedScreen to mount at app root
			await vi.waitFor(
				() => {
					const failureScreen = document.querySelector('[data-testid="connect-failed-screen"]');
					expect(failureScreen).not.toBeNull();
					expect(failureScreen?.textContent).toContain(SERVICE_NOT_RUNNING_TITLE);
				},
				{ timeout: 4000, interval: 50 },
			);

			// 2. Button is rendered under Tauri
			const launchButton = document.querySelector('[data-testid="launch-service"]');
			expect(launchButton).not.toBeNull();
			expect(launchButton?.textContent).toContain('启动调度服务');

			// 3. Next fetch attempt should succeed
			failFetch = false;

			// 4. Click launch button: exactly one invoke call, returns pid
			await click(launchButton);

			expect(invoke.mock.calls.filter(([command]) => command === 'launch_service')).toHaveLength(1);

			// 5. On snapshot retry success, failure screen is cleared and tasks page is restored
			await vi.waitFor(
				() => {
					expect(document.querySelector('[data-testid="connect-failed-screen"]')).toBeNull();
					const tasksContainer = document.querySelector(
						'[data-component="tasks-page"], [data-component="tasks-page-container"]',
					);
					expect(tasksContainer).not.toBeNull();
					expect(tasksContainer?.textContent).toContain('M10-T6');
				},
				{ timeout: 4000, interval: 50 },
			);
		} finally {
			globalThis.fetch = originalFetch;
			setCachedToken(null);
			window.location.hash = '';
		}
	});

	it('recovers a failed deck snapshot after the snapshot owner was unmounted by the failure screen', async () => {
		const { useBatchTree } = await import('../src/features/run-deck/use-batch-tree.ts');
		const { useFirstScreenFailure: useFailure } = await import('../src/app/connect-failed.tsx');
		const { reportFirstScreenFailure: reportFailure } = await import('../src/app/bootstrap.ts');
		const { setCachedToken } = await import('../src/api/http-client.ts');
		const originalFetch = globalThis.fetch;
		let isOffline = true;
		setCachedToken('test-device-token');
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes('/api/v1/snapshot')) {
				if (isOffline) throw new TypeError('Failed to fetch');
				return new Response(JSON.stringify({ tasks: [], batches: [], latestEventId: 1 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			return new Response('{}', { status: 200 });
		});

		function SnapshotOwner() {
			useBatchTree();
			return createElement('div', { 'data-testid': 'deck-snapshot-owner' });
		}

		function FailureGate() {
			const failure = useFailure();
			return failure
				? createElement('button', {
						type: 'button',
						'data-testid': 'deck-retry',
						onClick: failure.retry,
					})
				: createElement(SnapshotOwner);
		}

		try {
			render(createElement(FailureGate));
			await vi.waitFor(
				() => {
					expect(document.querySelector('[data-testid="deck-retry"]')).not.toBeNull();
					expect(document.querySelector('[data-testid="deck-snapshot-owner"]')).toBeNull();
				},
				{ timeout: 4000 },
			);
			isOffline = false;
			await click(document.querySelector('[data-testid="deck-retry"]'));
			await vi.waitFor(
				() => {
					expect(document.querySelector('[data-testid="deck-retry"]')).toBeNull();
					expect(document.querySelector('[data-testid="deck-snapshot-owner"]')).not.toBeNull();
				},
				{ timeout: 4000 },
			);
		} finally {
			globalThis.fetch = originalFetch;
			setCachedToken(null);
			reportFailure(null);
		}
	});
});

describe('M10-T6 AC 5: shared contract surface', () => {
	it('keeps the fourth capability on the bridge and the flag beside it', () => {
		const bridge: ShellBridge = shellBridge;
		expect(typeof bridge.launchService).toBe('function');
		expect(typeof bridge.capabilities.canLaunchService).toBe('boolean');
	});
});
