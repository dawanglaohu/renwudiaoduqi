// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DocumentExecutionDto } from '@agent-scheduler/shared/api/document-execution';
import type { LaneView } from '@agent-scheduler/shared/api/lanes';
import postcss from 'postcss';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventBus } from '../src/api/event-bus.ts';
import { httpClient } from '../src/api/http-client.ts';
import { clearResourceCache } from '../src/api/resource-cache.ts';
import { RunDeckContainer } from '../src/features/run-deck/run-deck-container.tsx';
import { useConnectionStore } from '../src/store/connection-store.ts';
import { useSelectionStore } from '../src/store/selection-store.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function lane(laneNo: number, currentRunId: string | null): LaneView {
	return {
		laneNo,
		taskId: currentRunId ? 'task-a' : null,
		currentRunId,
		stage: currentRunId ? 'implement' : 'idle',
		nextTaskId: null,
		nextBlockedBy: [],
		archivedTaskIds: [],
		archivedWrapupRunId: null,
		overLimit: false,
	};
}

function execution(docId: string): DocumentExecutionDto {
	return {
		docId,
		state: 'idle',
		version: 0,
		contentFingerprint: docId === 'doc-2' ? 'fp-2' : 'fp-1',
		defaultAssignment: null,
		currentBatchId: null,
		currentBatchNo: null,
		completedBatchCount: 0,
		totalBatchCount: 2,
		pauseReason: null,
		blockers: [],
		canStart: true,
		canPause: false,
		canResume: false,
		updatedAt: '2026-10-15T00:00:00.000Z',
		wrapupProgress: null,
	};
}

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe('M9-T30 selected document lanes', () => {
	beforeEach(() => {
		clearResourceCache();
		useConnectionStore.getState().reset();
		useConnectionStore.getState().setStatus('online');
		useSelectionStore.getState().reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearResourceCache();
		useConnectionStore.getState().reset();
		useSelectionStore.getState().reset();
		document.body.innerHTML = '';
	});

	it.each(['light', 'dark'] as const)(
		'keeps the %s document controls outside the batch title width cap',
		async (theme) => {
			vi.spyOn(httpClient, 'callRoute').mockResolvedValue({
				documents: [],
				agents: [],
				batches: [],
				tasks: [],
				runs: [],
				lanes: [],
			});
			const frame = document.createElement('div');
			frame.dataset.theme = theme;
			const page = document.createElement('div');
			page.dataset.component = 'deck-page';
			frame.appendChild(page);
			document.body.appendChild(frame);
			const root = createRoot(page);
			try {
				await act(async () =>
					root.render(
						createElement(RunDeckContainer, { lanes: [], batches: [], densityTier: 'full' }),
					),
				);
				const controls = frame.querySelector(
					'.deck-batch-tree > [data-component="document-execution-container"]',
				);
				expect(controls).not.toBeNull();
				const title = [...frame.querySelectorAll('.deck-batch-tree > div')].find(
					(element) => element.textContent === '批次与任务',
				);
				expect(title).toBeDefined();
				const capped: string[] = [];
				const titleCaps: string[] = [];
				const file = theme === 'light' ? 'memphis.css' : 'memphis-dark.css';
				const css = readFileSync(resolve(__dirname, '../src/styles', file), 'utf8');
				postcss.parse(css).walkRules((rule) => {
					if (!rule.selector.includes('.deck-batch-tree')) return;
					if (
						!rule.nodes.some(
							(node) => node.type === 'decl' && node.prop === 'max-width' && node.value !== 'none',
						)
					)
						return;
					if (controls?.matches(rule.selector)) capped.push(rule.selector);
					if (title?.matches(rule.selector)) titleCaps.push(rule.selector);
				});
				expect(capped, 'The title chip must not constrain the document form').toEqual([]);
				expect(titleCaps.length, 'The batch title retains its chip style').toBeGreaterThan(0);
			} finally {
				await act(async () => root.unmount());
			}
		},
	);

	it('drops a late lane snapshot from the document that was selected when the read started', async () => {
		const documents = [
			{
				id: 'doc-1',
				docsPath: 'D:/docs/one',
				projectName: '一',
				repoPath: 'D:/repo',
				mainBranch: 'main',
				branchPrefix: 'task/',
				laneCount: 1,
				contentFingerprint: 'fp-1',
				isSourceReadable: true,
				isTakeoverNotified: false,
				importedAt: '2026-10-15T00:00:00.000Z',
				lastSeenAt: '2026-10-15T00:00:00.000Z',
			},
			{
				id: 'doc-2',
				docsPath: 'D:/docs/two',
				projectName: '二',
				repoPath: 'D:/repo',
				mainBranch: 'main',
				branchPrefix: 'task/',
				laneCount: 3,
				contentFingerprint: 'fp-2',
				isSourceReadable: true,
				isTakeoverNotified: false,
				importedAt: '2026-10-15T00:00:00.000Z',
				lastSeenAt: '2026-10-15T00:00:00.000Z',
			},
		];
		const base = {
			documents,
			batches: [],
			tasks: [],
			runs: [],
			agents: [],
			gates: [],
			documentExecutions: [],
			latestEventId: 1,
		};
		const reads: { docId: string; resolve: (value: unknown) => void }[] = [];
		useSelectionStore.getState().setSelectedDocId('doc-1');
		vi.spyOn(httpClient, 'callRoute').mockImplementation(async (route, options) => {
			const query = options?.query as { docId?: string } | undefined;
			const params = options?.params as { docId?: string } | undefined;
			if (route.path === '/api/v1/snapshot' && query?.docId) {
				const pending = deferred<unknown>();
				reads.push({ docId: query.docId, resolve: pending.resolve });
				return pending.promise;
			}
			if (route.path === '/api/v1/snapshot') {
				return { ...base, lanes: [lane(1, 'run-a')] };
			}
			if (route.path.endsWith('/execution') && params?.docId) {
				return { execution: execution(params.docId) };
			}
			return {
				...base,
				lanes: [],
				models: [],
				isComplete: true,
				refreshedAt: null,
				liveFailure: null,
				isRefreshing: false,
				currentConfig: null,
				wrapups: [],
				bottleneck: null,
				capacity: null,
				batches: [],
			};
		});

		const container = document.createElement('div');
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(createElement(RunDeckContainer, { lanes: [], densityTier: 'full' }));
				for (let i = 0; i < 8; i++) await Promise.resolve();
			});
			expect(reads.map((read) => read.docId)).toContain('doc-1');

			await act(async () => {
				useSelectionStore.getState().setSelectedDocId('doc-2');
				for (let i = 0; i < 8; i++) await Promise.resolve();
			});

			const stale = reads.filter((read) => read.docId === 'doc-1');
			const current = reads.filter((read) => read.docId === 'doc-2');
			expect(current.length).toBeGreaterThan(0);
			await act(async () => {
				for (const read of stale) {
					read.resolve({ ...base, lanes: [lane(1, 'run-a')] });
				}
				for (let i = 0; i < 12; i++) await Promise.resolve();
			});
			await act(async () => {
				for (const read of current) {
					read.resolve({ ...base, lanes: [lane(1, null), lane(2, null), lane(3, null)] });
				}
				for (let i = 0; i < 16; i++) await Promise.resolve();
			});
			const panel = container.querySelector('[data-testid="document-execution"]');
			expect(panel?.textContent).toContain('窗口占用 0 / 3');
			expect(panel?.textContent).not.toContain('窗口占用 1 / 1');
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});

it('selects the document from an active snapshot and reveals blocked task handling', async () => {
	clearResourceCache();
	useConnectionStore.getState().reset();
	useConnectionStore.getState().setStatus('online');
	useSelectionStore.getState().reset();
	const docs = deferred<unknown>();
	const doc = {
		id: 'active-doc',
		docsPath: 'D:/docs/active',
		projectName: 'Active',
		repoPath: 'D:/repo',
		mainBranch: 'main',
		branchPrefix: 'task/',
		laneCount: 2,
		contentFingerprint: 'fp',
		isSourceReadable: true,
		isTakeoverNotified: false,
		importedAt: '2026-10-15T00:00:00Z',
		lastSeenAt: '2026-10-15T00:00:00Z',
	};
	const current = {
		...execution(doc.id),
		state: 'paused',
		version: 3,
		pauseReason: 'user_paused',
		canStart: false,
		canResume: true,
		currentBatchId: 'active-batch',
		currentBatchNo: 1,
		blockers: [{ code: 'contract_pending', batchId: 'active-batch', taskIds: ['task-a'] }],
	};
	const batch = {
		id: 'active-batch',
		docId: doc.id,
		batchNo: 1,
		state: 'running',
		startedAt: null,
		finishedAt: null,
		defaultExpanded: false,
		canWrapup: false,
	};
	const task = {
		id: 'task-a',
		docId: doc.id,
		batchId: batch.id,
		taskKey: 'ACTIVE-T1',
		title: 'Active task',
		moduleKey: 'M9',
		deps: [],
		estDays: 1,
		state: 'running',
	};
	const base = {
		documents: [{ ...doc, id: 'unreadable-doc', isSourceReadable: false }, doc],
		batches: [batch],
		tasks: [task],
		runs: [],
		agents: [],
		gates: [],
		documentExecutions: [current],
		latestEventId: 1,
		lanes: [lane(1, 'active-run')],
	};
	let snapshotReads = 0;
	vi.spyOn(httpClient, 'callRoute').mockImplementation(async (route) => {
		if (route.path === '/api/v1/snapshot') snapshotReads++;
		if (route.path === '/api/v1/documents') return docs.promise;
		if (route.path.endsWith('/execution')) return { execution: current };
		return {
			...base,
			models: [],
			isComplete: true,
			isRefreshing: false,
			currentConfig: null,
			wrapups: [],
		};
	});
	const frames: Array<FrameRequestCallback> = [];
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		frames.push(callback);
		return frames.length;
	});
	const scroll = vi.fn();
	vi.stubGlobal('ResizeObserver', undefined);
	const oldScroll = Element.prototype.scrollIntoView;
	Element.prototype.scrollIntoView = scroll;
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(createElement(RunDeckContainer, { lanes: [], densityTier: 'full' }));
			for (let i = 0; i < 20; i++) await Promise.resolve();
		});
		await act(async () => {
			docs.resolve({ documents: [doc] });
			for (let i = 0; i < 20; i++) await Promise.resolve();
		});
		expect(useSelectionStore.getState().selectedDocId).toBe(doc.id);
		expect(
			container.querySelector<HTMLButtonElement>('[data-action="resume-document"]')?.disabled,
		).toBe(false);
		await act(async () =>
			container
				.querySelector<HTMLButtonElement>('[data-blocker-action="contract_pending"]')
				?.click(),
		);
		await act(async () => {
			for (const frame of frames.splice(0)) frame(0);
		});
		expect(document.activeElement?.closest('[data-task-id]')?.getAttribute('data-task-id')).toBe(
			'task-a',
		);
		expect(scroll).toHaveBeenCalled();
		for (const event of [
			{ kind: 'task.landed', scope: 'task', payload: { by: 'human' } },
			{ kind: 'batch.advanced', scope: 'batch', payload: { batchId: batch.id } },
		] as const) {
			const before = snapshotReads;
			await act(async () => {
				eventBus.push({
					id: before + 100,
					ts: '2026-10-15T13:00:00Z',
					runId: null,
					taskId: null,
					seq: 1,
					actorDeviceId: null,
					...event,
				});
				for (let i = 0; i < 30; i++) await Promise.resolve();
			});
			expect(snapshotReads).toBeGreaterThan(before);
		}
	} finally {
		await act(async () => root.unmount());
		container.remove();
		Element.prototype.scrollIntoView = oldScroll;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		clearResourceCache();
		useConnectionStore.getState().reset();
		useSelectionStore.getState().reset();
	}
});
