// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpClient } from '../src/api/http-client.ts';
import {
	type UseLogWindowReturn,
	useLogWindow,
} from '../src/features/run-detail/use-log-window.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of mounted.splice(0)) await cleanup();
	vi.restoreAllMocks();
});

describe('batch 11 log correction through the real React hook and shared route', () => {
	it('loads the latest REST lines on first visit and re-anchors after SSE-only segments evict the byte cursor', async () => {
		const callRoute = vi.spyOn(httpClient, 'callRoute');
		callRoute
			.mockResolvedValueOnce({
				lines: ['rest-tail'],
				totalLines: 14001,
				prevCursor: '0:500',
				nextCursor: null,
			})
			.mockResolvedValueOnce({
				lines: ['refetched-tail'],
				totalLines: 28001,
				prevCursor: '0:900',
				nextCursor: null,
			});

		const observed: { current?: UseLogWindowReturn } = {};
		function Probe() {
			observed.current = useLogWindow({ runId: 'run-real-route', autoSubscribeEvents: false });
			return createElement('p', null, observed.current.state.lines.at(-1)?.text ?? 'empty');
		}
		const current = (): UseLogWindowReturn => {
			if (!observed.current) throw new Error('Probe did not render');
			return observed.current;
		};
		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container);
		mounted.push(async () => {
			await act(async () => root.unmount());
			container.remove();
		});

		await act(async () => root.render(createElement(Probe)));
		expect(callRoute).toHaveBeenCalledWith(
			expect.objectContaining({ method: 'GET', path: '/api/v1/runs/:runId/log' }),
			{ params: { runId: 'run-real-route' }, query: { direction: 'backward', limit: 2000 } },
		);
		expect(container.textContent).toContain('rest-tail');

		await act(async () => {
			current().appendLiveLines(Array.from({ length: 14000 }, (_, index) => `live-${index}`));
		});
		expect(current().state.hasOlder).toBe(true);
		await act(async () => current().loadOlder());
		expect(callRoute).toHaveBeenCalledTimes(2);
		expect(callRoute).toHaveBeenLastCalledWith(
			expect.objectContaining({ method: 'GET', path: '/api/v1/runs/:runId/log' }),
			{ params: { runId: 'run-real-route' }, query: { direction: 'backward', limit: 2000 } },
		);
		expect(container.textContent).toContain('refetched-tail');
	});
});
