// @vitest-environment jsdom

import type { DocumentDto } from '@agent-scheduler/shared/api/documents';
import { act, createElement, useState } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eventBus } from '../src/api/event-bus.ts';
import { httpClient } from '../src/api/http-client.ts';
import { clearResourceCache } from '../src/api/resource-cache.ts';
import { LaneCountSetting } from '../src/components/lane-count-setting.tsx';
import { SettingsAgentsPage } from '../src/pages/settings-agents-page.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	clearResourceCache();
	localStorage.clear();
	container = document.createElement('div');
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	clearResourceCache();
	vi.restoreAllMocks();
});

function countInput(): HTMLInputElement {
	const input = container.querySelector<HTMLInputElement>('input[aria-label="任务并行窗口数"]');
	expect(input, 'the count must be a focusable numeric input').not.toBeNull();
	return input as HTMLInputElement;
}

async function typeCount(value: string) {
	const input = countInput();
	await act(async () => {
		input.focus();
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
		input.dispatchEvent(new Event('input', { bubbles: true }));
	});
	return input;
}

async function selectDocument(id: string) {
	const select = container.querySelector<HTMLSelectElement>(
		'select[aria-label="窗口设置所属文档"]',
	);
	expect(select, 'the real settings page must offer an explicit document choice').not.toBeNull();
	await act(async () => {
		if (!select) return;
		select.value = id;
		select.dispatchEvent(new Event('change', { bubbles: true }));
	});
}

function documentDto(id: string, laneCount: number): DocumentDto {
	return {
		id,
		projectName: id,
		docsPath: `/projects/${id}/docs-data.js`,
		repoPath: `/projects/${id}`,
		mainBranch: 'main',
		branchPrefix: 'task/',
		laneCount,
		contentFingerprint: id,
		isSourceReadable: true,
		isTakeoverNotified: false,
		importedAt: '2026-10-07T00:00:00Z',
		lastSeenAt: '2026-10-07T00:00:00Z',
	};
}

function documentApi(initialDocuments = [documentDto('doc-a', 2), documentDto('doc-b', 4)]) {
	let documents = initialDocuments;
	let rejectSave = false;
	let rejectRead = false;
	const writes: { docId: string; laneCount: number }[] = [];
	vi.spyOn(httpClient, 'callRoute').mockImplementation(async (route, options) => {
		if (route.method === 'GET' && route.path === '/api/v1/agents') return { agents: [] };
		if (route.method === 'GET' && route.path === '/api/v1/documents') {
			if (rejectRead) throw new Error('document refresh failed');
			return { documents };
		}
		if (route.method === 'PATCH' && route.path === '/api/v1/documents/:docId/settings') {
			const docId = options?.params?.docId as string;
			const { laneCount } = options?.body as { laneCount: number };
			writes.push({ docId, laneCount });
			if (rejectSave) throw new Error('save failed');
			documents = documents.map((doc) => (doc.id === docId ? { ...doc, laneCount } : doc));
			return { document: documents.find((doc) => doc.id === docId) };
		}
		throw new Error(`Unexpected route ${route.method} ${route.path}`);
	});
	return {
		writes,
		failSaves: () => {
			rejectSave = true;
		},
		failReads: () => {
			rejectRead = true;
		},
		recoverReads: () => {
			rejectRead = false;
		},
		addDocument: (doc: DocumentDto) => {
			documents = [...documents, doc];
		},
	};
}

async function documentChanged(kind: 'document.settings_changed' | 'system.docs_changed') {
	const envelope = {
		id: 1001,
		ts: '2026-10-07T00:00:00Z',
		runId: null,
		taskId: null,
		seq: 1,
		actorDeviceId: null,
	};
	await act(async () => {
		if (kind === 'document.settings_changed') {
			eventBus.push({
				...envelope,
				kind,
				scope: 'document',
				payload: { docId: 'doc-b', laneCount: 5 },
			});
		} else {
			eventBus.push({
				...envelope,
				kind,
				scope: 'system',
				payload: { docsPath: '/projects/doc-a/docs-data.js' },
			});
		}
	});
}

it('lets the count receive focus and saves a typed integer once on Enter', async () => {
	const changed = vi.fn();
	function View() {
		const [laneCount, setLaneCount] = useState(2);
		return createElement(LaneCountSetting, {
			laneCount,
			onChangeLaneCount: (count) => {
				changed(count);
				setLaneCount(count);
			},
		});
	}
	await act(async () => root.render(createElement(View)));
	const input = await typeCount('5');
	expect(document.activeElement).toBe(input);
	await act(async () =>
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
	);
	expect(changed).toHaveBeenCalledTimes(1);
	expect(changed).toHaveBeenCalledWith(5);
	expect(input.value).toBe('5');
});

it.each(['', '0', '7', '2.5'])(
	'does not save the invalid or unfinished input %j',
	async (value) => {
		const changed = vi.fn();
		await act(async () =>
			root.render(createElement(LaneCountSetting, { laneCount: 2, onChangeLaneCount: changed })),
		);
		const input = await typeCount(value);
		await act(async () => input.blur());
		expect(changed).not.toHaveBeenCalled();
		expect(input.value).toBe('2');
	},
);

it('requires an explicit document and saves only that document, including after reopening settings', async () => {
	const api = documentApi();
	await act(async () => root.render(createElement(SettingsAgentsPage)));
	expect(container.querySelector('input[aria-label="任务并行窗口数"]')).toBeNull();
	expect(api.writes).toEqual([]);
	await selectDocument('doc-b');
	expect(countInput().value).toBe('4');
	const input = await typeCount('6');
	await act(async () => input.blur());
	expect(api.writes).toEqual([{ docId: 'doc-b', laneCount: 6 }]);
	await act(async () => root.unmount());
	root = createRoot(container);
	await act(async () => root.render(createElement(SettingsAgentsPage)));
	expect(countInput().value).toBe('6');
	expect(container.textContent).toContain('文档：doc-b');
	const decrease = container.querySelector<HTMLButtonElement>(
		'[data-testid="lane-count-decrease-btn"]',
	);
	await act(async () => decrease?.click());
	expect(api.writes.at(-1)).toEqual({ docId: 'doc-b', laneCount: 5 });
});

it('allows choosing a live document when the remembered document no longer exists', async () => {
	localStorage.setItem('agsched.ui.v1', JSON.stringify({ lastDocId: 'removed-document' }));
	documentApi();
	await act(async () => root.render(createElement(SettingsAgentsPage)));
	expect(container.querySelector('input[aria-label="任务并行窗口数"]')).toBeNull();
	await selectDocument('doc-a');
	expect(countInput().value).toBe('2');
});

it('restores the saved count and displays an error when the save fails', async () => {
	const api = documentApi();
	api.failSaves();
	await act(async () => root.render(createElement(SettingsAgentsPage)));
	await selectDocument('doc-b');
	const input = await typeCount('3');
	await act(async () => input.blur());
	expect(api.writes).toEqual([{ docId: 'doc-b', laneCount: 3 }]);
	expect(countInput().value).toBe('4');
	expect(container.querySelector('[data-testid="lane-count-error"]')?.textContent).toBeTruthy();
});

it('keeps the document choices and count after a failed refresh, and can retry', async () => {
	const api = documentApi();
	await act(async () => root.render(createElement(SettingsAgentsPage)));
	await selectDocument('doc-b');
	api.failReads();
	await documentChanged('document.settings_changed');
	expect(countInput().value).toBe('4');
	expect(container.querySelector('option[value="doc-a"]')).not.toBeNull();
	expect(container.textContent).toContain('加载文档列表失败，请重试');
	api.recoverReads();
	await act(async () =>
		container
			.querySelector<HTMLButtonElement>('[data-testid="lane-count-documents-retry"]')
			?.click(),
	);
	expect(container.querySelector('[data-testid="lane-count-documents-error"]')).toBeNull();
	expect(countInput().value).toBe('4');
});

it('shows a retryable document read error instead of asking to import when the initial read fails', async () => {
	const api = documentApi();
	api.failReads();
	await act(async () => root.render(createElement(SettingsAgentsPage)));
	expect(container.textContent).toContain('加载文档列表失败，请重试');
	expect(container.textContent).not.toContain('请先导入开发文档');
	api.recoverReads();
	await act(async () =>
		container
			.querySelector<HTMLButtonElement>('[data-testid="lane-count-documents-retry"]')
			?.click(),
	);
	await selectDocument('doc-b');
	expect(countInput().value).toBe('4');
});

it.each(['resolve', 'reject'] as const)(
	'ignores an older refresh that finishes with %s after the latest count',
	async (outcome) => {
		documentApi();
		await act(async () => root.render(createElement(SettingsAgentsPage)));
		await selectDocument('doc-b');
		let resolveOld: (value: { documents: DocumentDto[] }) => void = () => {};
		let rejectOld: (error: Error) => void = () => {};
		const oldRead = new Promise<{ documents: DocumentDto[] }>((resolve, reject) => {
			resolveOld = resolve;
			rejectOld = reject;
		});
		vi.mocked(httpClient.callRoute)
			.mockReturnValueOnce(oldRead)
			.mockResolvedValueOnce({ documents: [documentDto('doc-b', 5)] });
		await documentChanged('document.settings_changed');
		await documentChanged('document.settings_changed');
		expect(countInput().value).toBe('5');
		await act(async () => {
			if (outcome === 'resolve') resolveOld({ documents: [documentDto('doc-b', 3)] });
			else rejectOld(new Error('obsolete refresh failed'));
		});
		expect(countInput().value).toBe('5');
		expect(container.querySelector('[data-testid="lane-count-documents-error"]')).toBeNull();
	},
);

it('receives newly imported documents through the system document milestone while settings stays mounted', async () => {
	const api = documentApi([]);
	await act(async () => root.render(createElement(SettingsAgentsPage)));
	expect(container.querySelector('option[value="doc-a"]')).toBeNull();
	api.addDocument(documentDto('doc-a', 2));
	await documentChanged('system.docs_changed');
	expect(container.querySelector('option[value="doc-a"]')).not.toBeNull();
	await selectDocument('doc-a');
	expect(countInput().value).toBe('2');
	expect(api.writes).toEqual([]);
});

it('does not let a refresh started before a local save revert the saved count', async () => {
	const api = documentApi();
	await act(async () => root.render(createElement(SettingsAgentsPage)));
	await selectDocument('doc-b');
	let resolveOld: (value: { documents: DocumentDto[] }) => void = () => {};
	vi.mocked(httpClient.callRoute).mockReturnValueOnce(
		new Promise((resolve) => {
			resolveOld = resolve;
		}),
	);
	await documentChanged('document.settings_changed');
	const input = await typeCount('6');
	await act(async () => input.blur());
	expect(api.writes).toEqual([{ docId: 'doc-b', laneCount: 6 }]);
	await act(async () => resolveOld({ documents: [documentDto('doc-b', 4)] }));
	expect(countInput().value).toBe('6');
});

it('recovers a malformed document preference when selecting a valid document', async () => {
	localStorage.setItem('agsched.ui.v1', '{unreadable');
	documentApi();
	await act(async () => root.render(createElement(SettingsAgentsPage)));
	await selectDocument('doc-b');
	expect(JSON.parse(localStorage.getItem('agsched.ui.v1') ?? '{}')).toEqual({ lastDocId: 'doc-b' });
	await act(async () => root.unmount());
	root = createRoot(container);
	await act(async () => root.render(createElement(SettingsAgentsPage)));
	expect(countInput().value).toBe('4');
});

it.each(['resolve', 'reject'] as const)(
	'keeps newer remote document data when a delayed save finishes with %s',
	async (outcome) => {
		documentApi();
		await act(async () => root.render(createElement(SettingsAgentsPage)));
		await selectDocument('doc-b');
		let resolveSave: (value: { document: DocumentDto }) => void = () => {};
		let rejectSave: (error: Error) => void = () => {};
		const save = new Promise<{ document: DocumentDto }>((resolve, reject) => {
			resolveSave = resolve;
			rejectSave = reject;
		});
		vi.mocked(httpClient.callRoute)
			.mockReturnValueOnce(save)
			.mockResolvedValueOnce({ documents: [documentDto('doc-b', 5)] })
			.mockResolvedValueOnce({ documents: [documentDto('doc-b', 5)] });
		const input = await typeCount('6');
		await act(async () => input.blur());
		await documentChanged('document.settings_changed');
		expect(countInput().value).toBe('5');
		await act(async () => {
			if (outcome === 'resolve') resolveSave({ document: documentDto('doc-b', 6) });
			else rejectSave(new Error('delayed save failed'));
		});
		expect(countInput().value).toBe('5');
		if (outcome === 'reject') {
			expect(container.querySelector('[data-testid="lane-count-error"]')?.textContent).toBeTruthy();
		}
	},
);

it('does not let a read started during a save overwrite its later confirmation', async () => {
	documentApi();
	await act(async () => root.render(createElement(SettingsAgentsPage)));
	await selectDocument('doc-b');
	let resolveSave: (value: { document: DocumentDto }) => void = () => {};
	let resolveRead: (value: { documents: DocumentDto[] }) => void = () => {};
	vi.mocked(httpClient.callRoute)
		.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveSave = resolve;
			}),
		)
		.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveRead = resolve;
			}),
		)
		.mockResolvedValueOnce({ documents: [documentDto('doc-b', 6)] });
	const input = await typeCount('6');
	await act(async () => input.blur());
	await documentChanged('system.docs_changed');
	await act(async () => resolveSave({ document: documentDto('doc-b', 6) }));
	await act(async () => resolveRead({ documents: [documentDto('doc-b', 4)] }));
	expect(countInput().value).toBe('6');
});
