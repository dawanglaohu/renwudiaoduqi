// @vitest-environment jsdom

import type { DocumentExecutionDto } from '@agent-scheduler/shared/api/document-execution';
import type { DocumentDto } from '@agent-scheduler/shared/api/documents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventBus } from '../src/api/event-bus.ts';
import { ApiError, httpClient } from '../src/api/http-client.ts';
import { clearResourceCache } from '../src/api/resource-cache.ts';
import { DocumentExecutionControls } from '../src/components/document-execution-controls.tsx';
import {
	type DocumentExecutionClient,
	httpDocumentExecutionClient,
	publishDocumentExecutions,
	useDocumentExecution,
} from '../src/features/run-deck/use-document-execution.ts';
import { UI_STRINGS } from '../src/i18n/ui-strings.ts';
import { useConnectionStore } from '../src/store/connection-store.ts';
import { useSelectionStore } from '../src/store/selection-store.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function execution(patch: Partial<DocumentExecutionDto> = {}): DocumentExecutionDto {
	return {
		docId: 'doc-1',
		state: 'running',
		version: 3,
		contentFingerprint: 'fp-1',
		defaultAssignment: { agentId: 'agent-a', modelName: 'model-a', effort: { vendor: 'xhigh' } },
		currentBatchId: 'batch-1',
		currentBatchNo: 1,
		completedBatchCount: 0,
		totalBatchCount: 2,
		pauseReason: null,
		blockers: [],
		canStart: false,
		canPause: true,
		canResume: false,
		updatedAt: '2026-10-14T00:00:00.000Z',
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

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	let reject: (reason?: unknown) => void = () => undefined;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function Harness({ client }: { readonly client: DocumentExecutionClient }) {
	const docId = useSelectionStore((state) => state.selectedDocId);
	const model = useDocumentExecution(docId, { client });
	return createElement(
		'div',
		null,
		createElement(DocumentExecutionControls, {
			docId,
			execution: model.execution,
			assignment: model.assignment,
			agents: model.agents,
			catalog: model.catalog,
			batchProgress: null,
			occupiedLaneCount: 1,
			laneCount: model.document?.laneCount ?? null,
			pendingAction: model.pendingAction,
			errorMessage: model.error?.message,
			errorTechnical: model.error?.technical,
			canControl: model.canControl,
			canStart: model.canStart,
			canPause: model.canPause,
			canResume: model.canResume,
			needsSourceConfirm: model.needsSourceConfirm,
			sourceConfirmed: model.sourceConfirmed,
			onAgentId: model.setAgentId,
			onModelName: model.setModelName,
			onEffort: model.setEffort,
			onStart: () => void model.start(),
			onPause: () => void model.pause(),
			onResume: () => void model.resume(),
			onConfirmSource: () => void model.confirmSource(),
			onRefreshAgent: () => void model.refreshAgent(),
			onOpenTasks: () => undefined,
			onOpenLanding: () => undefined,
			onWrapup: () => undefined,
			onOpenBatch: () => undefined,
		}),
		createElement('button', {
			type: 'button',
			'data-action': 'pick-vendor',
			onClick: () => {
				model.setAgentId('agent-a');
				model.setModelName('model-a');
				model.setEffort({ vendor: 'xhigh' });
			},
		}),
	);
}

async function mount(client: DocumentExecutionClient) {
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(createElement(Harness, { client }));
	});
	await act(async () => {
		await Promise.resolve();
	});
	return {
		container,
		async unmount() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
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
		currentConfig: { model: null, effort: null, configPath: 'agent.json', effortRecognized: true },
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	clearResourceCache();
	useConnectionStore.getState().reset();
	useSelectionStore.getState().reset();
	document.body.innerHTML = '';
});

describe('M9-T30 document execution races', () => {
	it('disables a second click and keeps the observed expectedVersion', async () => {
		const gate = deferred<void>();
		const bodies: unknown[] = [];
		let reads = 0;
		const client: DocumentExecutionClient = {
			getExecution: vi.fn(async () => {
				reads += 1;
				return {
					execution: execution({
						state: reads > 1 ? 'paused' : 'running',
						version: reads > 1 ? 4 : 3,
						canPause: reads <= 1,
						canResume: reads > 1,
						pauseReason: reads > 1 ? 'user_paused' : null,
					}),
				};
			}),
			start: vi.fn(async () => ({ execution: execution() })),
			pause: vi.fn((_docId, body) => {
				bodies.push(body);
				return gate.promise.then(() => ({
					execution: execution({ state: 'paused', version: 4, canPause: false, canResume: true }),
				}));
			}),
			resume: vi.fn(async () => ({ execution: execution() })),
			listDocuments: vi.fn(async () => ({ documents: [documentDto()] })),
			refreshDocument: vi.fn(async () => ({})),
			listAgents: vi.fn(async () => ({ agents: [] })),
			probeAgent: vi.fn(async () => ({})),
		};
		const view = await mount(client);
		const pause = view.container.querySelector<HTMLButtonElement>('[data-action="pause-document"]');
		expect(pause?.disabled).toBe(false);
		await act(async () => {
			pause?.click();
			pause?.click();
		});
		expect(
			view.container.querySelector<HTMLButtonElement>('[data-action="pause-document"]')?.disabled,
		).toBe(true);
		await act(async () => {
			eventBus.push({
				id: 4,
				ts: '2026-10-14T00:00:01.000Z',
				runId: null,
				taskId: null,
				scope: 'document',
				kind: 'document.execution_changed',
				seq: 2,
				actorDeviceId: 'other',
				payload: {
					execution: execution({
						state: 'paused',
						version: 9,
						canPause: false,
						canResume: true,
						pauseReason: 'user_paused',
					}),
				},
			});
		});
		await act(async () => {
			gate.resolve();
			await gate.promise;
		});
		expect(bodies).toEqual([{ expectedVersion: 3 }]);
		expect(client.pause).toHaveBeenCalledTimes(1);
		expect(view.container.querySelector('[data-execution-state="paused"]')).not.toBeNull();
		expect(view.container.textContent).not.toContain(UI_STRINGS.documentExecution.versionConflict);
		await view.unmount();
	});

	it('refreshes a version conflict and does not resend with the new version', async () => {
		const client: DocumentExecutionClient = {
			getExecution: vi.fn(async () => ({ execution: execution() })),
			start: vi.fn(async () => ({ execution: execution() })),
			pause: vi.fn(async () => {
				throw new ApiError({
					code: 'E_VALIDATION',
					message: 'Document execution version changed.',
					requestId: 'req-conflict',
					details: {
						expectedVersion: 3,
						actualVersion: 5,
						execution: execution({
							state: 'paused',
							version: 5,
							canPause: false,
							canResume: true,
							pauseReason: 'user_paused',
						}),
					},
				});
			}),
			resume: vi.fn(async () => ({ execution: execution() })),
			listDocuments: vi.fn(async () => ({ documents: [documentDto()] })),
			refreshDocument: vi.fn(async () => ({})),
			listAgents: vi.fn(async () => ({ agents: [] })),
			probeAgent: vi.fn(async () => ({})),
		};
		const view = await mount(client);
		await act(async () => {
			view.container.querySelector<HTMLButtonElement>('[data-action="pause-document"]')?.click();
		});
		expect(client.pause).toHaveBeenCalledTimes(1);
		expect(view.container.textContent).toContain(UI_STRINGS.documentExecution.versionConflict);
		expect(view.container.querySelector('[data-execution-state="paused"]')).not.toBeNull();
		expect(client.resume).not.toHaveBeenCalled();
		await view.unmount();
	});

	it('drops a late response after the selected document changes', async () => {
		const gate = deferred<{ execution: DocumentExecutionDto }>();
		const client: DocumentExecutionClient = {
			getExecution: vi.fn(async (docId: string) => ({
				execution: execution({
					docId,
					state: 'idle',
					version: docId === 'doc-2' ? 0 : 3,
					canStart: true,
					canPause: false,
					defaultAssignment: null,
				}),
			})),
			start: vi.fn(() => gate.promise),
			pause: vi.fn(async () => ({ execution: execution() })),
			resume: vi.fn(async () => ({ execution: execution() })),
			listDocuments: vi.fn(async () => ({
				documents: [documentDto(), documentDto({ id: 'doc-2', contentFingerprint: 'fp-2' })],
			})),
			refreshDocument: vi.fn(async () => ({})),
			listAgents: vi.fn(async () => ({
				agents: [
					{
						id: 'agent-a',
						name: 'Alpha',
						monogram: 'AL',
						isAvailable: true,
						defaultModel: null,
						maxConcurrency: 1,
						permissionTier: 'workspaceWrite' as const,
						execPath: null,
					},
				],
			})),
			probeAgent: vi.fn(async () => ({})),
		};
		const view = await mount(client);
		await act(async () => {
			view.container.querySelector<HTMLButtonElement>('[data-action="pick-vendor"]')?.click();
		});
		const start = view.container.querySelector<HTMLButtonElement>('[data-action="start-document"]');
		expect(start?.disabled).toBe(false);
		await act(async () => start?.click());
		await act(async () => {
			useSelectionStore.getState().setSelectedDocId('doc-2');
		});
		await act(async () => {
			gate.resolve({
				execution: execution({ state: 'running', version: 4, canStart: false, canPause: true }),
			});
			await gate.promise;
		});
		expect(view.container.querySelector('[data-execution-state="running"]')).toBeNull();
		expect(view.container.querySelector('[data-execution-state="idle"]')).not.toBeNull();
		const body = vi.mocked(client.start).mock.calls[0]?.[1];
		expect(body).toMatchObject({
			expectedVersion: 3,
			expectedFingerprint: 'fp-1',
			defaultAssignment: { agentId: 'agent-a', modelName: 'model-a', effort: { vendor: 'xhigh' } },
		});
		await view.unmount();
	});

	it('keeps the previous execution when a control fails', async () => {
		const client: DocumentExecutionClient = {
			getExecution: vi.fn(async () => ({ execution: execution() })),
			start: vi.fn(async () => ({ execution: execution() })),
			pause: vi.fn(async () => {
				throw new ApiError({
					code: 'E_INTERNAL',
					message: 'boom',
					requestId: 'req-fail',
				});
			}),
			resume: vi.fn(async () => ({ execution: execution() })),
			listDocuments: vi.fn(async () => ({ documents: [documentDto()] })),
			refreshDocument: vi.fn(async () => ({})),
			listAgents: vi.fn(async () => ({ agents: [] })),
			probeAgent: vi.fn(async () => ({})),
		};
		const view = await mount(client);
		await act(async () => {
			view.container.querySelector<HTMLButtonElement>('[data-action="pause-document"]')?.click();
		});
		expect(view.container.querySelector('[data-execution-state="running"]')).not.toBeNull();
		expect(view.container.querySelector('[data-testid="document-execution-error"]')).not.toBeNull();
		await view.unmount();
	});

	it('does not enable controls while the connection is down', async () => {
		useConnectionStore.getState().setStatus('offline');
		const pause = vi.fn(async () => ({ execution: execution() }));
		const client: DocumentExecutionClient = {
			getExecution: vi.fn(async () => ({ execution: execution() })),
			start: vi.fn(async () => ({ execution: execution() })),
			pause,
			resume: vi.fn(async () => ({ execution: execution() })),
			listDocuments: vi.fn(async () => ({ documents: [documentDto()] })),
			refreshDocument: vi.fn(async () => ({})),
			listAgents: vi.fn(async () => ({ agents: [] })),
			probeAgent: vi.fn(async () => ({})),
		};
		const view = await mount(client);
		const button = view.container.querySelector<HTMLButtonElement>(
			'[data-action="pause-document"]',
		);
		expect(button?.disabled).toBe(true);
		expect(view.container.textContent).toContain(UI_STRINGS.documentExecution.offline);
		await act(async () => button?.click());
		expect(pause).not.toHaveBeenCalled();
		await view.unmount();
	});

	it('requires a document refresh after daemon restart before resume', async () => {
		let fingerprint = 'fp-1';
		const resumes: unknown[] = [];
		const client: DocumentExecutionClient = {
			getExecution: vi.fn(async () => ({
				execution: execution({
					state: 'paused',
					version: 6,
					canPause: false,
					canResume: true,
					pauseReason: 'daemon_restarted',
				}),
			})),
			start: vi.fn(async () => ({ execution: execution() })),
			pause: vi.fn(async () => ({ execution: execution() })),
			resume: vi.fn(async (_docId, body) => {
				resumes.push(body);
				return {
					execution: execution({ state: 'running', version: 7, canPause: true, canResume: false }),
				};
			}),
			listDocuments: vi.fn(async () => ({
				documents: [documentDto({ contentFingerprint: fingerprint })],
			})),
			refreshDocument: vi.fn(async () => {
				fingerprint = 'fp-confirmed';
				return {};
			}),
			listAgents: vi.fn(async () => ({ agents: [] })),
			probeAgent: vi.fn(async () => ({})),
		};
		const view = await mount(client);
		expect(view.container.textContent).toContain(
			UI_STRINGS.documentExecution.pauseReasons.daemon_restarted,
		);
		const resume = view.container.querySelector<HTMLButtonElement>(
			'[data-action="resume-document"]',
		);
		expect(resume?.disabled).toBe(true);
		await act(async () => resume?.click());
		expect(resumes).toHaveLength(0);
		await act(async () => {
			view.container
				.querySelector<HTMLButtonElement>('[data-action="confirm-document-source"]')
				?.click();
		});
		expect(view.container.querySelector('[data-source-confirmed="true"]')).not.toBeNull();
		expect(
			view.container.querySelector<HTMLButtonElement>('[data-action="resume-document"]')?.disabled,
		).toBe(false);
		await act(async () => {
			view.container.querySelector<HTMLButtonElement>('[data-action="resume-document"]')?.click();
		});
		expect(resumes).toEqual([{ expectedVersion: 6, expectedFingerprint: 'fp-confirmed' }]);
		await view.unmount();
	});

	it('ignores an older read that finishes after a same-version execution event', async () => {
		const firstRead = deferred<{ execution: DocumentExecutionDto }>();
		let getCalls = 0;
		const client: DocumentExecutionClient = {
			getExecution: vi.fn(() => {
				getCalls += 1;
				if (getCalls === 1) return firstRead.promise;
				return Promise.resolve({
					execution: execution({
						state: 'running',
						version: 3,
						blockers: [],
					}),
				});
			}),
			start: vi.fn(async () => ({ execution: execution() })),
			pause: vi.fn(async () => ({ execution: execution() })),
			resume: vi.fn(async () => ({ execution: execution() })),
			listDocuments: vi.fn(async () => ({ documents: [documentDto()] })),
			refreshDocument: vi.fn(async () => ({})),
			listAgents: vi.fn(async () => ({ agents: [] })),
			probeAgent: vi.fn(async () => ({})),
		};
		const view = await mount(client);
		await act(async () => {
			eventBus.push({
				id: 9,
				ts: '2026-10-14T00:00:02.000Z',
				runId: null,
				taskId: null,
				scope: 'document',
				kind: 'document.execution_changed',
				seq: 3,
				actorDeviceId: null,
				payload: {
					execution: execution({
						state: 'running',
						version: 3,
						blockers: [{ code: 'source_runs_pending', batchId: 'batch-1', taskIds: [] }],
					}),
				},
			});
		});
		expect(view.container.querySelector('[data-testid="source-runs-pending"]')).not.toBeNull();
		await act(async () => {
			firstRead.resolve({
				execution: execution({ state: 'running', version: 3, blockers: [] }),
			});
			await firstRead.promise;
		});
		expect(view.container.querySelector('[data-testid="source-runs-pending"]')).not.toBeNull();
		await view.unmount();
	});
});

function makeClient(overrides: Partial<DocumentExecutionClient> = {}): DocumentExecutionClient {
	return {
		getExecution: async () => ({ execution: execution() }),
		start: async () => ({ execution: execution() }),
		pause: async () => ({ execution: execution() }),
		resume: async () => ({ execution: execution() }),
		listDocuments: async () => ({ documents: [documentDto()] }),
		refreshDocument: async () => ({}),
		listAgents: async () => ({ agents: [] }),
		probeAgent: async () => ({}),
		...overrides,
	};
}

it.each([
	{
		kind: 'agent.availability_changed',
		scope: 'agent',
		payload: { agentId: 'agent-a', available: false },
	},
	{ kind: 'task.landed', scope: 'task', payload: { by: 'human' } },
	{ kind: 'batch.advanced', scope: 'batch', payload: { batchId: 'batch-1' } },
] as const)('reloads same-version execution projections on $kind', async (event) => {
	let current = execution();
	vi.mocked(httpClient.callRoute).mockImplementation(async (route) =>
		route.path.endsWith('/execution')
			? { execution: current }
			: { models: [], isComplete: true, currentConfig: null },
	);
	const listAgents = vi.fn(async () => ({ agents: [] }));
	const view = await mount(
		makeClient({ getExecution: httpDocumentExecutionClient.getExecution, listAgents }),
	);
	try {
		current = execution({
			completedBatchCount: 1,
			blockers: [{ code: 'agent_unavailable', batchId: 'batch-1', taskIds: [] }],
		});
		await act(async () => {
			eventBus.push({
				id: 51,
				ts: '2026-10-15T13:00:00Z',
				runId: null,
				taskId: null,
				seq: 1,
				actorDeviceId: null,
				...event,
			});
			for (let i = 0; i < 12; i++) await Promise.resolve();
		});
		expect(view.container.textContent).toContain('已完成批次 1 / 2');
		expect(view.container.querySelector('[data-blocker="agent_unavailable"]')).not.toBeNull();
		if (event.kind === 'agent.availability_changed') expect(listAgents).toHaveBeenCalledTimes(2);
	} finally {
		await view.unmount();
	}
});

it('invalidates cached document capacity while the panel is unmounted', async () => {
	let laneCount = 2;
	vi.mocked(httpClient.callRoute).mockImplementation(async (route) =>
		route.path === '/api/v1/documents'
			? { documents: [documentDto({ laneCount })] }
			: { models: [], isComplete: true, currentConfig: null },
	);
	const client = makeClient({ listDocuments: httpDocumentExecutionClient.listDocuments });
	const first = await mount(client);
	await first.unmount();
	laneCount = 4;
	eventBus.push({
		id: 52,
		ts: '2026-10-15T13:00:01Z',
		runId: null,
		taskId: null,
		scope: 'document',
		kind: 'document.settings_changed',
		seq: 1,
		actorDeviceId: null,
		payload: { docId: 'doc-1', laneCount },
	});
	const second = await mount(client);
	try {
		expect(second.container.textContent).toContain('窗口占用 1 / 4');
	} finally {
		await second.unmount();
	}
});

describe('document execution cache and snapshot ordering', () => {
	it('reads the current execution when remounting after an event while the panel was absent', async () => {
		let serverExecution = execution();
		let executionGets = 0;
		vi.mocked(httpClient.callRoute).mockImplementation(async (route: { path: string }) => {
			if (route.path.endsWith('/execution')) {
				executionGets++;
				return { execution: serverExecution };
			}
			return {
				models: [],
				isComplete: true,
				refreshedAt: null,
				liveFailure: null,
				isRefreshing: false,
				currentConfig: null,
			};
		});
		const client = makeClient({ getExecution: httpDocumentExecutionClient.getExecution });
		const first = await mount(client);
		expect(first.container.querySelector('[data-execution-state="running"]')).not.toBeNull();
		await first.unmount();
		serverExecution = execution({
			state: 'paused',
			version: 4,
			pauseReason: 'user_paused',
			canPause: false,
			canResume: true,
		});
		eventBus.push({
			id: 14,
			ts: '2026-10-15T10:00:00Z',
			runId: null,
			taskId: null,
			scope: 'document',
			kind: 'document.execution_changed',
			seq: 1,
			actorDeviceId: null,
			payload: { execution: serverExecution },
		});
		// Mobile details keeps the deck alive while the execution panel is absent.
		publishDocumentExecutions([serverExecution]);
		const second = await mount(client);
		try {
			expect({
				executionGets,
				state: second.container
					.querySelector('[data-execution-state]')
					?.getAttribute('data-execution-state'),
			}).toEqual({ executionGets: 2, state: 'paused' });
		} finally {
			await second.unmount();
		}
	});
	it.each([4, 5])(
		'preserves a version-%i snapshot against an older version-4 read in the same React batch',
		async (version) => {
			const docs = deferred<{ documents: DocumentDto[] }>();
			const client = makeClient({
				getExecution: async () => ({ execution: execution({ version: 4 }) }),
				listDocuments: () => docs.promise,
			});
			const view = await mount(client);
			await act(async () => {
				publishDocumentExecutions([
					execution({
						state: 'paused',
						version,
						pauseReason: 'user_paused',
						canPause: false,
						canResume: true,
					}),
				]);
				docs.resolve({ documents: [documentDto()] });
				await docs.promise;
				await Promise.resolve();
			});
			try {
				expect(
					view.container
						.querySelector('[data-execution-state]')
						?.getAttribute('data-execution-state'),
				).toBe('paused');
			} finally {
				await view.unmount();
			}
		},
	);
});

it('refreshes the cached execution after a committed control loses its response', async () => {
	let serverExecution = execution();
	vi.mocked(httpClient.callRoute).mockImplementation(async (route: { path: string }) =>
		route.path.endsWith('/execution')
			? { execution: serverExecution }
			: { models: [], isComplete: true, currentConfig: null },
	);
	const pause = vi.fn(async () => {
		serverExecution = execution({
			state: 'paused',
			version: 4,
			pauseReason: 'user_paused',
			canPause: false,
			canResume: true,
		});
		throw new ApiError({
			code: 'E_NETWORK',
			message: 'Response was lost.',
			requestId: 'lost-response',
		});
	});
	const view = await mount(
		makeClient({ getExecution: httpDocumentExecutionClient.getExecution, pause }),
	);
	try {
		await act(async () =>
			view.container.querySelector<HTMLButtonElement>('[data-action="pause-document"]')?.click(),
		);
		expect(view.container.querySelector('[data-execution-state="paused"]')).not.toBeNull();
		expect(pause).toHaveBeenCalledTimes(1);
		expect(view.container.querySelector('[data-testid="document-execution-error"]')).not.toBeNull();
	} finally {
		await view.unmount();
	}
});

it('invalidates a settled control for a document that is no longer selected', async () => {
	const response = deferred<{ execution: DocumentExecutionDto }>();
	let first = execution({
		state: 'idle',
		canStart: true,
		canPause: false,
		defaultAssignment: null,
	});
	vi.mocked(httpClient.callRoute).mockImplementation(async (route: { path: string }, options) =>
		route.path.endsWith('/execution')
			? {
					execution:
						options?.params?.docId === 'doc-1'
							? first
							: execution({
									docId: 'doc-2',
									state: 'idle',
									version: 0,
									canStart: true,
									canPause: false,
									defaultAssignment: null,
								}),
				}
			: { models: [], isComplete: true, currentConfig: null },
	);
	const api = makeClient({
		getExecution: httpDocumentExecutionClient.getExecution,
		start: () => response.promise,
		listDocuments: async () => ({
			documents: [documentDto(), documentDto({ id: 'doc-2', contentFingerprint: 'fp-2' })],
		}),
	});
	const view = await mount(api);
	try {
		await act(async () =>
			view.container.querySelector<HTMLButtonElement>('[data-action="pick-vendor"]')?.click(),
		);
		await act(async () =>
			view.container.querySelector<HTMLButtonElement>('[data-action="start-document"]')?.click(),
		);
		await act(async () => useSelectionStore.getState().setSelectedDocId('doc-2'));
		await act(async () => {
			first = execution({ version: 4 });
			response.resolve({ execution: first });
			await response.promise;
		});
		expect(view.container.querySelector('[data-execution-state="idle"]')).not.toBeNull();
		await act(async () => useSelectionStore.getState().setSelectedDocId('doc-1'));
		expect(view.container.querySelector('[data-execution-state="running"]')).not.toBeNull();
	} finally {
		await view.unmount();
	}
});
