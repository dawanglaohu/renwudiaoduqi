// @vitest-environment jsdom

import type { DocumentExecutionDto } from '@agent-scheduler/shared/api/document-execution';
import type { LaneView } from '@agent-scheduler/shared/api/lanes';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
