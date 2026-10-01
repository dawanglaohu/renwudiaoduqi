/**
 * packages/web/test/use-agent-models.test.tsx
 *
 * use-agent-models Hook 单元测试（AC 4, E-338, E-339）
 */

// @vitest-environment jsdom

import type { ListAgentModelsResponse } from '@agent-scheduler/shared/api/agents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentsApi from '../src/api/agents.ts';
import { clearResourceCache, refetchAll } from '../src/api/resource-cache.ts';
import { useAgentModels } from '../src/features/settings-agents/use-agent-models.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('use-agent-models (AC 4, E-338, E-339)', () => {
	let container: HTMLDivElement;

	const mockCatalog1: ListAgentModelsResponse = {
		models: [
			{ name: 'model-a', source: 'live', isCurrentConfig: true },
			{ name: 'model-b', source: 'config', isCurrentConfig: false },
		],
		isComplete: true,
		refreshedAt: '2026-09-30T00:00:00.000Z',
		liveFailure: null,
		currentConfig: {
			model: 'model-a',
			effort: null,
			configPath: '/path/to/config',
			effortRecognized: true,
		},
		isRefreshing: false,
	};

	const mockCatalog2: ListAgentModelsResponse = {
		models: [
			{ name: 'model-a', source: 'live', isCurrentConfig: true },
			{ name: 'model-c', source: 'live', isCurrentConfig: false },
		],
		isComplete: true,
		refreshedAt: '2026-09-30T00:01:00.000Z',
		liveFailure: null,
		currentConfig: {
			model: 'model-a',
			effort: null,
			configPath: '/path/to/config',
			effortRecognized: true,
		},
		isRefreshing: false,
	};

	beforeEach(() => {
		clearResourceCache();
		container = document.createElement('div');
		document.body.appendChild(container);
		vi.restoreAllMocks();
	});

	afterEach(() => {
		container.remove();
		clearResourceCache();
		vi.restoreAllMocks();
	});

	it('initial fetch uses normal fetcher without refresh query (AC 4)', async () => {
		const listModelsSpy = vi.spyOn(agentsApi, 'listModels').mockResolvedValueOnce(mockCatalog1);

		let hookResult: ReturnType<typeof useAgentModels> | undefined;

		function TestComponent() {
			hookResult = useAgentModels('claude');
			return createElement('div', null, hookResult.models.map((m) => m.name).join(','));
		}

		const root = createRoot(container);
		await act(async () => {
			root.render(createElement(TestComponent));
		});

		expect(listModelsSpy).toHaveBeenCalledWith('claude');
		expect(hookResult?.catalog?.models).toHaveLength(2);
		expect(hookResult?.models.map((m) => m.name)).toEqual(['model-a', 'model-b']);
		expect(hookResult?.isRefreshing).toBe(false);

		act(() => {
			root.unmount();
		});
	});

	it('refresh() sends ?refresh=1 and shares refreshPending across multiple consumers (AC 4, E-339)', async () => {
		let resolveRefresh: ((val: ListAgentModelsResponse) => void) | undefined;
		const refreshPromise = new Promise<ListAgentModelsResponse>((resolve) => {
			resolveRefresh = resolve;
		});

		vi.spyOn(agentsApi, 'listModels')
			.mockResolvedValueOnce(mockCatalog1) // component 1 mount
			.mockImplementation(async (_id, opts) => {
				if (opts?.refresh) {
					return refreshPromise;
				}
				return mockCatalog2;
			});

		let hookResult1: ReturnType<typeof useAgentModels> | undefined;
		let hookResult2: ReturnType<typeof useAgentModels> | undefined;

		function Panel1() {
			hookResult1 = useAgentModels('claude');
			return createElement('div', { 'data-testid': 'panel-1' });
		}

		function Panel2() {
			hookResult2 = useAgentModels('claude');
			return createElement('div', { 'data-testid': 'panel-2' });
		}

		const root = createRoot(container);
		await act(async () => {
			root.render(createElement('div', null, createElement(Panel1), createElement(Panel2)));
		});

		// Trigger refresh on Panel 1
		let refreshOp: Promise<void> | undefined;
		act(() => {
			refreshOp = hookResult1?.refresh();
		});

		// Both consumers should see isRefreshing = true
		expect(hookResult1?.isRefreshing).toBe(true);
		expect(hookResult2?.isRefreshing).toBe(true);

		// Resolve the refresh promise
		await act(async () => {
			resolveRefresh?.(mockCatalog2);
			await refreshOp;
		});

		// Both settle to the new list and isRefreshing = false
		expect(hookResult1?.isRefreshing).toBe(false);
		expect(hookResult2?.isRefreshing).toBe(false);
		expect(hookResult1?.models.map((m) => m.name)).toEqual(['model-a', 'model-c']);
		expect(hookResult2?.catalog).toEqual(mockCatalog2);

		act(() => {
			root.unmount();
		});
	});

	it('switches back to normal fetcher upon settle so refetchAll does not trigger child processes (AC 4)', async () => {
		const calls: { id: string; opts?: agentsApi.ListModelsOptions }[] = [];
		vi.spyOn(agentsApi, 'listModels').mockImplementation(async (id, opts) => {
			calls.push({ id, opts });
			return mockCatalog1;
		});

		let hookResult: ReturnType<typeof useAgentModels> | undefined;

		function TestComponent() {
			hookResult = useAgentModels('claude');
			return null;
		}

		const root = createRoot(container);
		await act(async () => {
			root.render(createElement(TestComponent));
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.opts).toBeUndefined();

		await act(async () => {
			await hookResult?.refresh();
		});

		// Called with refresh: true, then switched back with normal fetcher
		const refreshCall = calls.find((c) => c.opts?.refresh === true);
		expect(refreshCall).toBeDefined();

		// Now trigger refetchAll (e.g. SSE reconnect)
		calls.length = 0;
		await act(async () => {
			await refetchAll();
		});

		// refetchAll MUST NOT have refresh: true
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.opts?.refresh).toBeUndefined();
		}

		act(() => {
			root.unmount();
		});
	});
});
