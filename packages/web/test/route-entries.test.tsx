// @vitest-environment jsdom

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GetRunResponse } from '@agent-scheduler/shared/api/runs';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getManualHost, resolveBaseUrl } from '../src/api/base-url.ts';
import { ApiError, clearCachedToken, httpClient, setCachedToken } from '../src/api/http-client.ts';
import { App } from '../src/app/app.tsx';
import { ROUTE_PATHS, matchRoute, navigateTo } from '../src/app/routes.tsx';
import { mapSnapshotBatches } from '../src/features/run-deck/mobile-batch-list.tsx';
import type { RunFetcher } from '../src/features/run-detail/run-detail-container.tsx';
import { RunDetailPage } from '../src/pages/run-detail-page.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanupFns: Array<() => Promise<void>> = [];
const scratchDirs: string[] = [];

async function preloadLazyPages(): Promise<void> {
	await Promise.all([
		import('../src/pages/landing-page.tsx'),
		import('../src/pages/settings-agents-page.tsx'),
		import('../src/pages/settings-devices-page.tsx'),
	]);
}

async function flushReact(turns = 8): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
	await act(async () => {
		setter?.call(input, value);
		input.dispatchEvent(new Event('input', { bubbles: true }));
	});
}

function snapshotFixture(): SnapshotResponse {
	return {
		documents: [],
		batches: [
			{
				id: 'batch-13',
				docId: 'doc-1',
				batchNo: 13,
				state: 'running',
				startedAt: null,
				finishedAt: null,
			},
		],
		tasks: [
			{
				id: 'task-m9-t25',
				docId: 'doc-1',
				taskKey: 'M9-T25',
				title: '七条路由挂进装配件并可导航',
				moduleKey: 'M9',
				deps: [],
				estDays: 1.5,
				batchId: 'batch-13',
				state: 'running',
			},
		],
		runs: [],
		gates: [],
		agents: [],
		latestEventId: 10,
	};
}

beforeEach(() => {
	document.body.innerHTML = '<div id="root"></div>';
	localStorage.clear();
	sessionStorage.clear();
	navigateTo('#/');
	setCachedToken('route-entry-token');
	vi.spyOn(httpClient, 'callRoute').mockImplementation(async (route, options) => {
		switch (route.path) {
			case '/api/v1/snapshot':
				return snapshotFixture();
			case '/api/v1/runs/:runId':
				if (options?.params?.runId === 'missing-run') {
					throw new ApiError({
						code: 'E_NOT_FOUND',
						message: 'Run not found',
						requestId: 'req-run-missing',
					});
				}
				return {
					run: { id: options?.params?.runId, state: 'running' },
					progress: null,
				};
			case '/api/v1/runs/:runId/log':
				return { lines: [], totalLines: 0, prevCursor: null, nextCursor: null };
			case '/api/v1/documents':
				return { documents: [] };
			case '/api/v1/agents':
				return { agents: [] };
			case '/api/v1/tasks/:taskId/landing':
				return {
					worktreePath: 'D:/worktree/task-m9-t25',
					branchName: 'task/M9-T25',
					diffStat: { filesChanged: 1, insertions: 2, deletions: 0 },
					commands: ['gh stack push'],
				};
			default:
				return {};
		}
	});
	vi.spyOn(httpClient, 'get').mockImplementation(async (path) => {
		if (path === '/api/v1/devices') return { devices: [] };
		return {};
	});
});

afterEach(async () => {
	for (const cleanup of cleanupFns.splice(0)) await cleanup();
	clearCachedToken();
	vi.restoreAllMocks();
});

afterAll(() => {
	for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('M9-T25 seven route entries', () => {
	it('navigates all seven hashes to real page/container components', async () => {
		await preloadLazyPages();
		const root = createRoot(document.getElementById('root') as HTMLElement);
		cleanupFns.push(async () => act(async () => root.unmount()));
		await act(async () => {
			root.render(createElement(App));
			await flushReact();
		});

		const routes: ReadonlyArray<readonly [string, string]> = [
			[ROUTE_PATHS.deck, '[data-component="run-deck-container"]'],
			[ROUTE_PATHS.tasks, '[data-component="mobile-batch-list"]'],
			['#/run/run-existing', '[data-component="run-detail-container"]'],
			['#/landing/task-m9-t25', '[data-component="landing-page"]'],
			[ROUTE_PATHS.settingsAgents, '[data-component="settings-agents-container"]'],
			[ROUTE_PATHS.settingsDevices, '[data-component="settings-devices-container"]'],
			[ROUTE_PATHS.pair, '[data-component="pairing-container"]'],
		];
		for (const [hash, selector] of routes) {
			await act(async () => {
				navigateTo(hash);
				await flushReact();
			});
			expect(document.querySelector(selector), `${hash} -> ${selector}`).not.toBeNull();
		}
	});

	it('keeps pair public, accepts a manual host and posts the real claim body', async () => {
		await preloadLazyPages();
		clearCachedToken();
		const post = vi.spyOn(httpClient, 'post').mockResolvedValue({
			deviceId: 'device-route-test',
			token: 'paired-route-token',
		});
		navigateTo('#/pair');
		const root = createRoot(document.getElementById('root') as HTMLElement);
		cleanupFns.push(async () => act(async () => root.unmount()));
		await act(async () => {
			root.render(createElement(App));
			await flushReact();
		});

		const toggle = Array.from(document.querySelectorAll('button')).find((button) =>
			button.textContent?.includes('手填地址兜底'),
		);
		expect(toggle).toBeDefined();
		await act(async () => {
			toggle?.click();
			await flushReact();
		});
		const hostInput = document.querySelector(
			'[data-testid="manual-host-input"]',
		) as HTMLInputElement | null;
		if (!hostInput) throw new Error('manual host input did not render');
		await setInput(hostInput, '192.168.1.50:7817');
		await act(async () =>
			(
				document.querySelector('[data-testid="save-manual-host-button"]') as HTMLButtonElement
			).click(),
		);

		expect(getManualHost()).toBe('192.168.1.50:7817');
		expect(await resolveBaseUrl({ manualHost: '192.168.1.50:7817' })).toBe(
			'http://192.168.1.50:7817',
		);

		await setInput(
			document.querySelector('[data-testid="pairing-code-input"]') as HTMLInputElement,
			'123456',
		);
		await setInput(
			document.querySelector('[data-testid="device-name-input"]') as HTMLInputElement,
			'Route Test Browser',
		);
		await act(async () => {
			(
				document.querySelector('[data-testid="pairing-submit-button"]') as HTMLButtonElement
			).click();
			await flushReact();
		});
		expect(post).toHaveBeenCalledWith(
			'/api/v1/pair/claim',
			{ code: '123456', deviceName: 'Route Test Browser' },
			{ auth: 'none' },
		);
	});

	it('projects only snapshot fields on the tasks page and renders missing counts as dashes', async () => {
		const mapped = mapSnapshotBatches(snapshotFixture());
		expect(mapped).toEqual([
			expect.objectContaining({
				id: 'batch-13',
				taskCount: null,
				landedCount: null,
				runningCount: null,
				waitingCount: null,
				tasks: [expect.objectContaining({ taskKey: 'M9-T25', status: 'running' })],
			}),
		]);

		await preloadLazyPages();
		navigateTo(ROUTE_PATHS.tasks);
		const root = createRoot(document.getElementById('root') as HTMLElement);
		cleanupFns.push(async () => act(async () => root.unmount()));
		await act(async () => {
			root.render(createElement(App));
			await flushReact();
		});

		const batchList = document.querySelector('[data-component="mobile-batch-list"]');
		expect(batchList).not.toBeNull();
		expect(batchList?.textContent).toContain('—/—');
	});

	it('R2 / E-223: avoids race condition where delayed response from run A overwrites run B', async () => {
		await preloadLazyPages();

		let rejectRunA!: (error: unknown) => void;
		const delayedRunAPromise = new Promise<never>((_, reject) => {
			rejectRunA = reject;
		});

		const runFetcher = vi.fn<RunFetcher>(async (runId: string) => {
			if (runId === 'run-a') {
				return delayedRunAPromise;
			}
			if (runId === 'run-b') {
				return {
					run: { id: 'run-b', state: 'running' } as unknown as GetRunResponse['run'],
					progress: null,
				};
			}
			throw new ApiError({
				code: 'E_NOT_FOUND',
				message: 'Run not found',
				requestId: 'req-missing',
			});
		});

		const root = createRoot(document.getElementById('root') as HTMLElement);
		cleanupFns.push(async () => act(async () => root.unmount()));

		// Start on run-a
		await act(async () => {
			root.render(
				createElement(RunDetailPage, {
					match: {
						...matchRoute('#/run/run-a'),
						id: 'runDetail',
						isUnknown: false,
						auth: true,
						lazy: false,
						path: '#/run/run-a',
					},
					params: { runId: 'run-a' },
					query: {},
					runFetcher,
				}),
			);
			await flushReact();
		});

		expect(document.querySelector('[data-run-missing="true"]')).toBeNull();

		// Switch to run-b
		await act(async () => {
			root.render(
				createElement(RunDetailPage, {
					match: {
						...matchRoute('#/run/run-b'),
						id: 'runDetail',
						isUnknown: false,
						auth: true,
						lazy: false,
						path: '#/run/run-b',
					},
					params: { runId: 'run-b' },
					query: {},
					runFetcher,
				}),
			);
			await flushReact();
		});

		// run-b loaded successfully, shows run-detail-container
		expect(document.querySelector('[data-component="run-detail-container"]')).not.toBeNull();
		expect(document.querySelector('[data-run-missing="true"]')).toBeNull();

		// Now delayed run-a finally responds with E_NOT_FOUND
		await act(async () => {
			rejectRunA(
				new ApiError({
					code: 'E_NOT_FOUND',
					message: 'Run A not found or purged',
					requestId: 'req-run-a-purged',
				}),
			);
			await flushReact();
		});

		// Run B must NOT be overwritten by run A delayed response!
		expect(document.querySelector('[data-component="run-detail-container"]')).not.toBeNull();
		expect(document.querySelector('[data-run-missing="true"]')).toBeNull();
	});

	it('lets the run page, not the router, render a purged run as missing (E-223)', async () => {
		await preloadLazyPages();
		navigateTo('#/run/missing-run');
		const root = createRoot(document.getElementById('root') as HTMLElement);
		cleanupFns.push(async () => act(async () => root.unmount()));
		await act(async () => {
			root.render(createElement(App));
			await flushReact();
		});
		const missing = document.querySelector('[data-run-missing="true"]');
		if (!missing) throw new Error('missing-run state did not render');
		expect(missing.textContent).toContain('该运行不存在或已被清理');
		expect(document.querySelector('[data-testid="unknown-route-page"]')).toBeNull();
		expect(document.querySelector('header')).not.toBeNull();
	});

	it('renders unknown route fallback with topbar for unrecognized hash or missing param (E-222)', async () => {
		await preloadLazyPages();
		const root = createRoot(document.getElementById('root') as HTMLElement);
		cleanupFns.push(async () => act(async () => root.unmount()));
		await act(async () => {
			root.render(createElement(App));
			await flushReact();
		});

		// 1. Unregistered hash
		await act(async () => {
			navigateTo('#/unknown-route');
			await flushReact();
		});
		const unknown = document.querySelector('[data-testid="unknown-route-page"]');
		expect(unknown).not.toBeNull();
		expect(unknown?.textContent).toContain('未知路径');
		expect(unknown?.textContent).toContain('回到运行甲板');
		expect(document.querySelector('header')).not.toBeNull();

		// 2. Missing runId parameter (#/run/)
		await act(async () => {
			navigateTo('#/run/');
			await flushReact();
		});
		const unknownRun = document.querySelector('[data-testid="unknown-route-page"]');
		expect(unknownRun).not.toBeNull();
	});
});

describe('M9-T25 Vite route chunks', () => {
	it('keeps deck/tasks/run detail in the main chunk and lazy-loads only settings and landing', () => {
		const require = createRequire(import.meta.url);
		const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
		const outDir = mkdtempSync(join(tmpdir(), 'agsched-route-entries-'));
		scratchDirs.push(outDir);
		const viteBin = resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
		execFileSync(
			process.execPath,
			[viteBin, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'],
			{ cwd: webDir, shell: false, stdio: 'pipe', windowsHide: true },
		);
		const assets = readdirSync(join(outDir, 'assets'));
		const mainName = assets.find((name) => /^index-[\w-]+\.js$/.test(name));
		expect(mainName).toBeDefined();
		const main = readFileSync(join(outDir, 'assets', mainName as string), 'utf8');
		expect(main).toContain('并行流数');
		expect(main).toContain('在整个会话中查找');
		expect(assets.some((name) => /^landing-page-[\w-]+\.js$/.test(name))).toBe(true);
		expect(assets.some((name) => /^settings-agents-page-[\w-]+\.js$/.test(name))).toBe(true);
		expect(assets.some((name) => /^settings-devices-page-[\w-]+\.js$/.test(name))).toBe(true);
		expect(assets.some((name) => /^(?:deck|tasks|run-detail)-page-[\w-]+\.js$/.test(name))).toBe(
			false,
		);
	}, 300_000);
});
