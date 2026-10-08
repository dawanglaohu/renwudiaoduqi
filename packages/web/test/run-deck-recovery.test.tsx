// @vitest-environment jsdom
import type { LaneView } from '@agent-scheduler/shared/api/lanes';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { eventBus } from '../src/api/event-bus.ts';
import { httpClient } from '../src/api/http-client.ts';
import { RunDeckContainer, buildDeckLanes } from '../src/features/run-deck/run-deck-container.tsx';
import { RunDeckView, type RunDeckViewProps } from '../src/features/run-deck/run-deck-view.tsx';
import { triggerResync } from '../src/store/connection-store.ts';
import { useSelectionStore } from '../src/store/selection-store.ts';

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

it('loads lanes for the selected project and discards the previous project response after switching', async () => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
	useSelectionStore.getState().setSelectedDocId('project-a');
	const finishOldSnapshots: (() => void)[] = [];
	let delayOldProject = false;
	let showOwnWrapupGate = false;
	const wrapupRun: RunDto = {
		id: 'wrapup-b',
		taskId: null,
		batchId: 'batch-b',
		attemptNo: 1,
		kind: 'wrapup',
		parentRunId: null,
		state: 'awaiting_human',
		reviewVerdict: null,
		agentId: 'codex',
		modelName: null,
		reportedModel: null,
		effortTier: null,
		reportedEffort: null,
		permissionTier: 'readOnly',
		worktreePath: null,
		branchName: null,
		pid: null,
		exitCode: 0,
		exitSignal: null,
		changedFileCount: 0,
		tokenUsage: null,
		isStallSuspected: false,
		reworkCount: 0,
		queuedReason: null,
		idempotencyKey: 'wrapup-b',
		actorDeviceId: null,
		startedAt: null,
		lastEventAt: null,
		endedAt: null,
	};
	const requests: (string | undefined)[] = [];
	vi.spyOn(httpClient, 'callRoute').mockImplementation(async (route, options) => {
		if (route.path === '/api/v1/snapshot') {
			const docId = options?.query?.docId as string | undefined;
			requests.push(docId);
			const response = {
				documents: [],
				batches: [
					{
						id: 'batch-b',
						docId: 'project-b',
						batchNo: 1,
						state: 'idle',
						startedAt: null,
						finishedAt: null,
					},
				],
				tasks: [
					{
						id: 'task-a',
						docId: 'project-a',
						taskKey: 'A-T1',
						title: 'Project A task',
						moduleKey: 'A',
						deps: [],
						estDays: null,
						batchId: null,
						state: 'never_dispatched',
					},
				],
				runs: [],
				gates: [],
				agents: [],
				lanes: docId === 'project-b' ? [idleLane(1), idleLane(2)] : [idleLane(1)],
				latestEventId: 100,
			} satisfies SnapshotResponse;
			if (docId === 'project-a' && delayOldProject) {
				return new Promise((resolve) => {
					finishOldSnapshots.push(() => resolve(response));
				});
			}
			return response;
		}
		if (route.path === '/api/v1/runs') return { runs: showOwnWrapupGate ? [wrapupRun] : [] };
		if (route.path === '/api/v1/gates')
			return {
				gates: [
					{
						id: 'gate-a',
						taskId: showOwnWrapupGate ? null : 'task-a',
						runId: showOwnWrapupGate ? wrapupRun.id : null,
						kind: 'dispatch',
						state: 'waiting',
						decision: null,
						comment: null,
						decidedByDeviceId: null,
						createdAt: '2026-10-08T00:00:00.000Z',
						decidedAt: null,
					},
				],
			};
		if (route.path === '/api/v1/documents') return { documents: [] };
		if (route.path === '/api/v1/agents') return { agents: [] };
		if (route.path === '/api/v1/documents/:docId/batches') return { batches: [] };
		if (route.path === '/api/v1/batches/:batchId/wrapups') return { wrapups: [] };
		throw new Error(`Unexpected request: ${route.path}`);
	});
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(createElement(RunDeckContainer, { lanes: [], densityTier: 'full' })),
		);
		expect(requests).toContain('project-a');
		expect(container.querySelectorAll('[data-stream-column="true"]')).toHaveLength(1);
		expect(container.querySelector('[data-testid="empty-onboarding-console"]')).toBeNull();
		delayOldProject = true;
		const staleRead = triggerResync();
		await act(async () => {
			await Promise.resolve();
		});
		await act(async () => useSelectionStore.getState().setSelectedDocId('project-b'));
		expect(requests).toContain('project-b');
		expect(container.querySelectorAll('[data-stream-column="true"]')).toHaveLength(2);
		expect(container.querySelector('[data-testid="empty-onboarding-console"]')).not.toBeNull();
		await act(async () => {
			for (const finish of finishOldSnapshots) finish();
			await staleRead;
		});
		expect(container.querySelectorAll('[data-stream-column="true"]')).toHaveLength(2);
		showOwnWrapupGate = true;
		await act(async () => triggerResync());
		expect(container.querySelector('[data-testid="empty-onboarding-console"]')).toBeNull();
	} finally {
		await act(async () => root.unmount());
		container.remove();
		useSelectionStore.getState().reset();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});

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

it('keeps onboarding drafts and steps when a snapshot moves the console between the main area and rail', async () => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
	vi.spyOn(httpClient, 'callRoute').mockImplementation(async (route) => {
		if (route.path === '/api/v1/documents') return { documents: [] };
		if (route.path === '/api/v1/agents') return { agents: [] };
		throw new Error(`Unexpected request: ${route.path}`);
	});
	const props: RunDeckViewProps = {
		lanes: [],
		rawLanes: [],
		batches: [],
		tier: 'full',
		isTouch: false,
		width: 1200,
		expandedLaneNo: null,
		toggleExpandLane: vi.fn(),
		stoppingLanes: new Set<number>(),
		handleStopLane: vi.fn(),
		userPreference: 'auto',
		togglePreference: vi.fn(),
		scrollContainerRef: { current: null },
		offScreenWaiting: { left: 0, right: 0 },
		scrollToLane: vi.fn(),
	};
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	try {
		await act(async () => root.render(createElement(RunDeckView, props)));
		const onboarding = container.querySelector('[data-testid="empty-onboarding-console"]');
		const pathInput = container.querySelector(
			'[data-testid="import-doc-path"]',
		) as HTMLInputElement;
		const pathDraft = '/tmp/task-drafts/docs-data.js';
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
				pathInput,
				pathDraft,
			);
			pathInput.dispatchEvent(new Event('input', { bubbles: true }));
		});
		await act(async () => root.render(createElement(RunDeckView, props)));
		expect(pathInput.value).toBe(pathDraft);
		const lanes = [idleLane(1)];
		const hydratedProps = { ...props, rawLanes: lanes, lanes: buildDeckLanes({ lanes }) };
		await act(async () => root.render(createElement(RunDeckView, hydratedProps)));
		expect(
			(container.querySelector('[data-testid="import-doc-path"]') as HTMLInputElement).value,
		).toBe(pathDraft);
		expect(container.querySelector('[data-testid="empty-onboarding-console"]')).toBe(onboarding);
		await act(async () => root.render(createElement(RunDeckView, props)));
		expect(container.querySelector('[data-testid="import-doc-path"]')).toBe(pathInput);
		expect(pathInput.value).toBe(pathDraft);
		await act(async () => {
			(container.querySelector('[data-action="next-step-1"]') as HTMLButtonElement).click();
		});
		expect(
			container.querySelector('[data-step-active="true"]')?.getAttribute('data-step-index'),
		).toBe('1');
		await act(async () => {
			root.render(createElement(RunDeckView, hydratedProps));
		});
		expect(
			container.querySelector('[data-step-active="true"]')?.getAttribute('data-step-index'),
		).toBe('1');
		await act(async () => {
			(container.querySelector('[data-action="next-step-2"]') as HTMLButtonElement).click();
		});
		const assignmentList = container.querySelector('[data-testid="task-assignment-list"]');
		expect(assignmentList).not.toBeNull();
		await act(async () => root.render(createElement(RunDeckView, props)));
		expect(container.querySelector('[data-testid="task-assignment-list"]')).toBe(assignmentList);
		expect(
			container.querySelector('[data-step-active="true"]')?.getAttribute('data-step-index'),
		).toBe('2');
	} finally {
		await act(async () => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});
