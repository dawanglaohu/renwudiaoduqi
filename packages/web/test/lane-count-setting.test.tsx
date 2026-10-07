// @vitest-environment jsdom

import type { DocumentDto } from '@agent-scheduler/shared/api/documents';
import { act, createElement, useState } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
	const writes: { docId: string; laneCount: number }[] = [];
	vi.spyOn(httpClient, 'callRoute').mockImplementation(async (route, options) => {
		if (route.method === 'GET' && route.path === '/api/v1/agents') return { agents: [] };
		if (route.method === 'GET' && route.path === '/api/v1/documents') return { documents };
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
	};
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
