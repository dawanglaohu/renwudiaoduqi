// @vitest-environment jsdom
import type { LaneView } from '@agent-scheduler/shared/api/lanes';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { eventBus } from '../src/api/event-bus.ts';
import { httpClient } from '../src/api/http-client.ts';
import { RunDeckContainer } from '../src/features/run-deck/run-deck-container.tsx';
import { triggerResync } from '../src/store/connection-store.ts';

function idleLane(laneNo: number): LaneView {
	return {
		laneNo,
		taskId: null,
		currentRunId: null,
		stage: 'idle',
		nextTaskId: null,
		nextBlockedBy: [],
		archivedTaskIds: [],
		archivedWrapupRunId: null,
		overLimit: false,
	};
}

it('M9-T21 reloads authoritative deck lanes after connection recovery without a new event', async () => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
	let lanes = [idleLane(1)];
	let readRuns: () => Promise<{ runs: never[] }> = async () => ({ runs: [] });
	const callRoute = vi.spyOn(httpClient, 'callRoute').mockImplementation(async (route) => {
		switch (route.path) {
			case '/api/v1/snapshot':
				return {
					documents: [],
					batches: [],
					tasks: [],
					runs: [],
					gates: [],
					agents: [],
					lanes,
					latestEventId: 100,
				} satisfies SnapshotResponse;
			case '/api/v1/runs':
				return readRuns();
			case '/api/v1/gates':
				return { gates: [] };
			case '/api/v1/documents':
				return { documents: [] };
			case '/api/v1/agents':
				return { agents: [] };
			default:
				throw new Error(`Unexpected request: ${route.path}`);
		}
	});
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(createElement(RunDeckContainer, { lanes: [], densityTier: 'full' }));
		});
		expect(container.querySelectorAll('[data-stream-column="true"]')).toHaveLength(1);
		const before = callRoute.mock.calls.filter(
			([route]) => route.path === '/api/v1/snapshot',
		).length;
		lanes = [idleLane(1), idleLane(2)];
		await act(async () => triggerResync());
		expect(container.querySelectorAll('[data-stream-column="true"]')).toHaveLength(2);
		expect(
			callRoute.mock.calls.filter(([route]) => route.path === '/api/v1/snapshot').length,
		).toBeGreaterThan(before);

		let finishStaleRead: () => void = () => {};
		let finishFreshRead: () => void = () => {};
		let readCount = 0;
		readRuns = () =>
			new Promise((resolve) => {
				readCount += 1;
				if (readCount === 1) finishStaleRead = () => resolve({ runs: [] });
				else finishFreshRead = () => resolve({ runs: [] });
			});
		lanes = [idleLane(1), idleLane(2), idleLane(3)];
		await act(async () => {
			eventBus.push({
				id: 102,
				ts: '2026-10-02T00:00:00.000Z',
				scope: 'system',
				kind: 'system.docs_changed',
				runId: null,
				taskId: null,
				actorDeviceId: null,
				seq: 1,
				payload: {},
			});
		});
		expect(readCount).toBe(1);
		lanes = [idleLane(1), idleLane(2), idleLane(3), idleLane(4)];
		const recovery = triggerResync();
		await act(async () => finishStaleRead());
		expect(readCount).toBe(2);
		// A stale three-lane response must stay unpublished while its replacement is pending.
		expect(container.querySelectorAll('[data-stream-column="true"]')).toHaveLength(2);
		await act(async () => {
			finishFreshRead();
			await recovery;
		});
		expect(container.querySelectorAll('[data-stream-column="true"]')).toHaveLength(4);
	} finally {
		await act(async () => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});
