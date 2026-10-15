// @vitest-environment jsdom

import type { DocumentExecutionDto } from '@agent-scheduler/shared/api/document-execution';
import type { DocumentDto } from '@agent-scheduler/shared/api/documents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventBus } from '../src/api/event-bus.ts';
import { httpClient } from '../src/api/http-client.ts';
import { clearResourceCache } from '../src/api/resource-cache.ts';
import { EmptyOnboarding } from '../src/components/empty-onboarding.tsx';
import { DocumentExecutionContainer } from '../src/features/run-deck/document-execution-container.tsx';
import type { DocumentExecutionClient } from '../src/features/run-deck/use-document-execution.ts';
import { UI_STRINGS } from '../src/i18n/ui-strings.ts';
import { useConnectionStore } from '../src/store/connection-store.ts';
import { useSelectionStore } from '../src/store/selection-store.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COPY = UI_STRINGS.documentExecution;

function execution(patch: Partial<DocumentExecutionDto> = {}): DocumentExecutionDto {
	return {
		docId: 'doc-1',
		state: 'idle',
		version: 0,
		contentFingerprint: null,
		defaultAssignment: null,
		currentBatchId: null,
		currentBatchNo: null,
		completedBatchCount: 0,
		totalBatchCount: 3,
		pauseReason: null,
		blockers: [],
		canStart: true,
		canPause: false,
		canResume: false,
		updatedAt: null,
		wrapupProgress: null,
		...patch,
	};
}

function documentDto(patch: Partial<DocumentDto> = {}): DocumentDto {
	return {
		id: 'doc-1',
		docsPath: 'D:/docs/docs-data.js',
		projectName: '调度文档',
		repoPath: 'D:/repo',
		mainBranch: 'main',
		branchPrefix: 'task/',
		laneCount: 2,
		contentFingerprint: 'fp-1',
		isSourceReadable: true,
		isTakeoverNotified: false,
		importedAt: '2026-10-14T00:00:00.000Z',
		lastSeenAt: '2026-10-14T00:00:00.000Z',
		...patch,
	};
}

function client(overrides: Partial<DocumentExecutionClient> = {}): DocumentExecutionClient & {
	readonly calls: Array<{ readonly action: string; readonly body?: unknown }>;
} {
	const calls: Array<{ readonly action: string; readonly body?: unknown }> = [];
	const base: DocumentExecutionClient = {
		getExecution: vi.fn(async () => {
			calls.push({ action: 'get' });
			return { execution: execution() };
		}),
		start: vi.fn(async (_docId, body) => {
			calls.push({ action: 'start', body });
			return {
				execution: execution({ state: 'running', version: 1, canStart: false, canPause: true }),
			};
		}),
		pause: vi.fn(async (_docId, body) => {
			calls.push({ action: 'pause', body });
			return {
				execution: execution({ state: 'paused', version: 2, canPause: false, canResume: true }),
			};
		}),
		resume: vi.fn(async (_docId, body) => {
			calls.push({ action: 'resume', body });
			return {
				execution: execution({ state: 'running', version: 3, canPause: true, canResume: false }),
			};
		}),
		listDocuments: vi.fn(async () => {
			calls.push({ action: 'documents' });
			return { documents: [documentDto()] };
		}),
		refreshDocument: vi.fn(async () => {
			calls.push({ action: 'refresh' });
			return {
				changed: false,
				flags: { hasAcceptChanged: false, hasPromptChanged: false, isRemovedFromDoc: false },
			};
		}),
		listAgents: vi.fn(async () => {
			calls.push({ action: 'agents' });
			return {
				agents: [
					{
						id: 'agent-a',
						name: 'Alpha',
						monogram: 'AL',
						isAvailable: false,
						defaultModel: 'model-a',
						maxConcurrency: 2,
						permissionTier: 'workspaceWrite' as const,
						execPath: null,
						effortVendorMap: { low: 'low', medium: 'med', high: 'high' },
						effortOptions: ['xhigh'],
					},
				],
			};
		}),
		probeAgent: vi.fn(async () => {
			calls.push({ action: 'probe' });
			return {};
		}),
	};
	return { ...base, ...overrides, calls };
}

async function render(node: ReturnType<typeof createElement>) {
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(node);
	});
	return {
		container,
		async unmount() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

beforeEach(() => {
	clearResourceCache();
	useConnectionStore.getState().reset();
	useConnectionStore.getState().setStatus('online');
	useSelectionStore.getState().reset();
	useSelectionStore.getState().setSelectedDocId('doc-1');
	vi.spyOn(httpClient, 'callRoute').mockResolvedValue({
		models: [],
		isComplete: true,
		refreshedAt: '2026-10-14T00:00:00.000Z',
		liveFailure: null,
		isRefreshing: false,
		currentConfig: {
			model: null,
			effort: null,
			configPath: 'agent.json',
			effortRecognized: true,
		},
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	clearResourceCache();
	useConnectionStore.getState().reset();
	useSelectionStore.getState().reset();
	document.body.innerHTML = '';
});

describe('M9-T30 document execution controls', () => {
	it('shows start and keeps import, document switch and batch browsing off the start route', async () => {
		const onDispatch = vi.fn();
		const onImportDocument = vi.fn();
		const onSelectDoc = vi.fn();
		const onSelectBatch = vi.fn();
		const view = await render(
			createElement(EmptyOnboarding, {
				documents: [{ id: 'doc-1', title: '调度文档', path: 'D:/docs/docs-data.js' }],
				batches: [{ id: 'batch-1', docId: 'doc-1', name: '第 1 批' }],
				selectedDocId: 'doc-1',
				onDispatch,
				onImportDocument,
				onSelectDoc,
				onSelectBatch,
			}),
		);
		const path = view.container.querySelector<HTMLInputElement>('[data-testid="import-doc-path"]');
		await act(async () => {
			if (!path) return;
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
				path,
				'D:/docs/docs-data.js',
			);
			path.dispatchEvent(new Event('input', { bubbles: true }));
		});
		await act(async () => {
			view.container.querySelector<HTMLButtonElement>('[data-action="import-document"]')?.click();
		});
		expect(onImportDocument).toHaveBeenCalledWith('D:/docs/docs-data.js', undefined);
		expect(onDispatch).not.toHaveBeenCalled();

		await act(async () => {
			view.container.querySelector<HTMLButtonElement>('[data-action="next-step-1"]')?.click();
		});
		const batchButton = view.container.querySelector<HTMLButtonElement>(
			'[data-batch-id="batch-1"]',
		);
		await act(async () => batchButton?.click());
		expect(onSelectBatch).toHaveBeenCalledWith('batch-1');
		expect(onDispatch).not.toHaveBeenCalled();
		await view.unmount();
	});

	it('labels the old batch action separately from document start', async () => {
		const view = await render(
			createElement(EmptyOnboarding, {
				currentStep: 3,
				selectedDocId: 'doc-1',
				selectedBatchId: 'batch-1',
				canDispatch: true,
				onDispatch: vi.fn(),
			}),
		);
		const legacy = view.container.querySelector<HTMLButtonElement>(
			'[data-action="confirm-dispatch"]',
		);
		expect(legacy?.textContent).toBe(COPY.legacyBatchStart);
		expect(legacy?.getAttribute('data-legacy-batch')).toBe('true');
		expect(view.container.textContent).toContain(COPY.legacyBatchNote);
		expect(legacy?.textContent).not.toBe(COPY.start);
		await view.unmount();
	});

	it('reads progress, wrap-up quota and completion from the daemon DTO', async () => {
		const running = execution({
			state: 'running',
			version: 4,
			canStart: false,
			canPause: true,
			currentBatchId: 'batch-2',
			currentBatchNo: 2,
			completedBatchCount: 1,
			totalBatchCount: 3,
			wrapupProgress: { generationId: 7, validRounds: 1, physicalAttempts: 4 },
		});
		const api = client({
			getExecution: vi.fn(async () => ({ execution: running })),
		});
		const view = await render(
			createElement(DocumentExecutionContainer, {
				client: api,
				lanes: [
					{
						laneNo: 1,
						taskId: 'task-1',
						currentRunId: 'run-1',
						stage: 'implement',
						nextTaskId: null,
						nextBlockedBy: [],
						archivedTaskIds: [],
						archivedWrapupRunId: null,
						overLimit: false,
					},
					{
						laneNo: 2,
						taskId: null,
						currentRunId: null,
						stage: 'idle',
						nextTaskId: null,
						nextBlockedBy: [],
						archivedTaskIds: [],
						archivedWrapupRunId: null,
						overLimit: false,
					},
				],
				batches: [
					{
						id: 'batch-2',
						batchNo: 2,
						taskCount: 4,
						landedCount: 1,
						runningCount: 2,
						waitingCount: 1,
					},
				],
			}),
		);
		await flush();
		expect(view.container.textContent).toContain('第 2 / 3 批');
		expect(view.container.textContent).toContain('已完成批次 1 / 3');
		expect(view.container.textContent).toContain('本批已落地 1 / 4');
		expect(view.container.textContent).toContain('窗口占用 1 / 2');
		expect(view.container.textContent).toContain('第 7 代 · 有效自动收口 1/2 · 物理尝试 4/6');
		expect(view.container.textContent).not.toContain(COPY.stateCompleted);
		expect(view.container.querySelector('[data-complete="true"]')).toBeNull();
		expect(api.calls.some((call) => call.action === 'start')).toBe(false);
		await view.unmount();
	});

	it('does not call all-complete until the daemon state is completed', async () => {
		const api = client({
			getExecution: vi.fn(async () => ({
				execution: execution({
					state: 'idle',
					canStart: true,
					completedBatchCount: 2,
					totalBatchCount: 3,
				}),
			})),
		});
		const view = await render(createElement(DocumentExecutionContainer, { client: api }));
		await flush();
		expect(view.container.textContent).not.toContain(COPY.stateCompleted);
		await view.unmount();
	});

	it('shows completed only from the daemon completed state', async () => {
		const api = client({
			getExecution: vi.fn(async () => ({
				execution: execution({
					state: 'completed',
					canStart: false,
					completedBatchCount: 3,
					totalBatchCount: 3,
				}),
			})),
		});
		const view = await render(createElement(DocumentExecutionContainer, { client: api }));
		await flush();
		expect(view.container.querySelector('[data-complete="true"]')).not.toBeNull();
		expect(view.container.textContent).toContain(COPY.stateCompleted);
		await view.unmount();
	});

	it('shows source_runs_pending as waiting and refreshes when the event clears it', async () => {
		let current = execution({
			state: 'running',
			version: 2,
			canStart: false,
			canPause: true,
			blockers: [{ code: 'source_runs_pending', batchId: 'batch-1', taskIds: [] }],
		});
		const api = client({
			getExecution: vi.fn(async () => ({ execution: current })),
		});
		const view = await render(createElement(DocumentExecutionContainer, { client: api }));
		await flush();
		expect(view.container.querySelector('[data-testid="source-runs-pending"]')?.textContent).toBe(
			COPY.waitingRuns,
		);
		expect(view.container.textContent).not.toContain('未建立计划');
		current = execution({
			state: 'running',
			version: 2,
			canStart: false,
			canPause: true,
			blockers: [],
		});
		await act(async () => {
			eventBus.push({
				id: 8,
				ts: '2026-10-14T00:00:00.000Z',
				runId: null,
				taskId: null,
				scope: 'document',
				kind: 'document.execution_changed',
				seq: 1,
				actorDeviceId: null,
				payload: { execution: current },
			});
		});
		expect(view.container.querySelector('[data-testid="source-runs-pending"]')).toBeNull();
		await view.unmount();
	});

	it('keeps a legal unavailable-agent start as running and offers the agent refresh', async () => {
		const api = client({
			getExecution: vi.fn(async () => ({
				execution: execution({
					state: 'running',
					version: 1,
					canStart: false,
					canPause: true,
					defaultAssignment: {
						agentId: 'agent-a',
						modelName: 'model-a',
						effort: { vendor: 'xhigh' },
					},
					blockers: [{ code: 'agent_unavailable', batchId: 'batch-1', taskIds: ['task-1'] }],
				}),
			})),
		});
		const view = await render(createElement(DocumentExecutionContainer, { client: api }));
		await flush();
		expect(view.container.querySelector('[data-execution-state="running"]')).not.toBeNull();
		expect(
			view.container.querySelector('[data-testid="agent-unavailable-wait"]')?.textContent,
		).toBe(COPY.planWaiting);
		expect(view.container.querySelector('[data-testid="document-execution-error"]')).toBeNull();
		expect(view.container.querySelector('[data-action="refresh-agent"]')).not.toBeNull();
		await view.unmount();
	});

	it('sends one start with the observed version and a vendor effort', async () => {
		const api = client();
		const view = await render(createElement(DocumentExecutionContainer, { client: api }));
		await flush();
		const select = view.container.querySelector<HTMLSelectElement>(
			'[data-testid="document-default-agent"]',
		);
		await act(async () => {
			if (!select) return;
			select.value = 'agent-a';
			select.dispatchEvent(new Event('change', { bubbles: true }));
		});
		const effortPicker = view.container.querySelector<HTMLElement>(
			'[data-testid="effort-picker"], select',
		);
		expect(effortPicker).not.toBeNull();
		const start = view.container.querySelector<HTMLButtonElement>('[data-action="start-document"]');
		expect(start?.disabled).toBe(false);
		await act(async () => start?.click());
		await flush();
		const startCall = api.calls.find((call) => call.action === 'start');
		expect(startCall?.body).toMatchObject({
			expectedVersion: 0,
			expectedFingerprint: 'fp-1',
			defaultAssignment: { agentId: 'agent-a', modelName: null, effort: null },
		});
		expect(api.calls.filter((call) => call.action === 'start')).toHaveLength(1);
		const body = startCall?.body as { defaultAssignment: { effort: unknown } };
		expect(body.defaultAssignment.effort).toBeNull();
		await view.unmount();
	});
});

it('opens the batch when awaiting-landing has no task IDs', async () => {
	const onOpenBatch = vi.fn();
	const api = client({
		getExecution: async () => ({
			execution: execution({
				state: 'running',
				canStart: false,
				canPause: true,
				blockers: [{ code: 'awaiting_landing', batchId: 'batch-1', taskIds: [] }],
			}),
		}),
	});
	const view = await render(
		createElement(DocumentExecutionContainer, { client: api, onOpenBatch }),
	);
	try {
		await flush();
		const action = view.container.querySelector<HTMLButtonElement>(
			'[data-blocker-action="awaiting_landing"]',
		);
		expect(action).not.toBeNull();
		await act(async () => action?.click());
		expect(onOpenBatch).toHaveBeenCalledWith('batch-1');
	} finally {
		await view.unmount();
	}
});

it('reveals manual wrap-up on a phone without sending the desktop mutation', async () => {
	const onOpenBatch = vi.fn();
	const onWrapup = vi.fn();
	const api = client({
		getExecution: async () => ({
			execution: execution({
				state: 'running',
				canStart: false,
				canPause: true,
				blockers: [{ code: 'wrapup_manual', batchId: 'batch-1', taskIds: [] }],
			}),
		}),
	});
	const view = await render(
		createElement(DocumentExecutionContainer, {
			client: api,
			isPhoneTier: true,
			onOpenBatch,
			onWrapup,
		}),
	);
	try {
		await flush();
		await act(async () =>
			view.container
				.querySelector<HTMLButtonElement>('[data-blocker-action="wrapup_manual"]')
				?.click(),
		);
		expect(onOpenBatch).toHaveBeenCalledWith('batch-1');
		expect(onWrapup).not.toHaveBeenCalled();
	} finally {
		await view.unmount();
	}
});

it('keeps document switching available during an active plan without starting another document', async () => {
	const api = client({
		listDocuments: async () => ({
			documents: [
				documentDto(),
				documentDto({ id: 'doc-2', projectName: 'Second', contentFingerprint: 'fp-2' }),
			],
		}),
		getExecution: async (id) => ({
			execution: execution({
				docId: id,
				state: id === 'doc-1' ? 'running' : 'idle',
				version: id === 'doc-1' ? 3 : 0,
				canStart: id === 'doc-2',
				canPause: id === 'doc-1',
				defaultAssignment:
					id === 'doc-1' ? { agentId: 'agent-a', modelName: null, effort: null } : null,
			}),
		}),
	});
	const view = await render(createElement(DocumentExecutionContainer, { client: api }));
	try {
		await flush();
		const picker = view.container.querySelector<HTMLSelectElement>(
			'[data-testid="document-execution-document"]',
		);
		expect(picker).not.toBeNull();
		expect(picker?.disabled).toBe(false);
		await act(async () => {
			if (picker) {
				picker.value = 'doc-2';
				picker.dispatchEvent(new Event('change', { bubbles: true }));
			}
		});
		await flush();
		expect(useSelectionStore.getState().selectedDocId).toBe('doc-2');
		expect(view.container.querySelector('[data-execution-state="idle"]')).not.toBeNull();
		expect(api.start).not.toHaveBeenCalled();
	} finally {
		await view.unmount();
	}
});
it('keeps a read-only landing entry available while disconnected', async () => {
	useConnectionStore.getState().setStatus('offline');
	const api = client({
		getExecution: async () => ({
			execution: execution({
				state: 'running',
				canStart: false,
				canPause: true,
				blockers: [{ code: 'awaiting_landing', batchId: 'batch-1', taskIds: ['task-1'] }],
			}),
		}),
	});
	const view = await render(createElement(DocumentExecutionContainer, { client: api }));
	try {
		await flush();
		const action = view.container.querySelector<HTMLButtonElement>(
			'[data-blocker-action="awaiting_landing"]',
		);
		expect(action?.disabled).toBe(false);
	} finally {
		await view.unmount();
	}
});
it('opens the existing registry instead of probing a default agent that may not own the blocker', async () => {
	const previousHash = window.location.hash;
	const api = client({
		getExecution: async () => ({
			execution: execution({
				state: 'running',
				canStart: false,
				canPause: true,
				defaultAssignment: { agentId: 'agent-a', modelName: null, effort: null },
				blockers: [{ code: 'agent_unavailable', batchId: 'batch-1', taskIds: ['override-task'] }],
			}),
		}),
	});
	const view = await render(createElement(DocumentExecutionContainer, { client: api }));
	try {
		await flush();
		await act(async () =>
			view.container.querySelector<HTMLButtonElement>('[data-action="refresh-agent"]')?.click(),
		);
		expect(window.location.hash).toBe('#/settings/agents');
		expect(api.probeAgent).not.toHaveBeenCalled();
		await act(async () =>
			view.container
				.querySelector<HTMLButtonElement>('[data-blocker-action="agent_unavailable"]')
				?.click(),
		);
		expect(window.location.hash).toBe('#/settings/agents');
		expect(api.probeAgent).not.toHaveBeenCalled();
	} finally {
		await view.unmount();
		window.location.hash = previousHash;
	}
});
