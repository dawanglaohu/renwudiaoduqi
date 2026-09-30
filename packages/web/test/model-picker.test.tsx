/**
 * packages/web/test/model-picker.test.tsx
 *
 * model-picker 组件单元测试（AC 2, E-338, E-339, E-350）
 */

// @vitest-environment jsdom

import type { ListAgentModelsResponse, LoginState } from '@agent-scheduler/shared/api/agents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../src/components/model-picker.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ModelPicker (AC 2, E-338, E-339, E-350)', () => {
	let container: HTMLDivElement;

	const mockCatalog: ListAgentModelsResponse = {
		models: [
			{ name: 'gpt-4o', source: 'live', provider: 'openai', isCurrentConfig: true },
			{ name: 'claude-3-5-sonnet', source: 'builtin', isCurrentConfig: false },
			{ name: 'old-custom-model', source: 'history', isCurrentConfig: false },
		],
		isComplete: false,
		refreshedAt: '2026-09-30T00:00:00.000Z',
		liveFailure: null,
		currentConfig: {
			model: 'gpt-4o',
			effort: null,
			configPath: '/path/to/config',
			effortRecognized: true,
		},
		isRefreshing: false,
	};

	const mockLogin: LoginState = {
		state: 'logged_in',
		reason: null,
		checkedAt: '2026-09-30T00:00:00.000Z',
		loginCommand: null,
		warningCode: null,
		providers: {
			openai: { state: 'logged_in', reason: null },
		},
	};

	beforeEach(() => {
		container = document.createElement('div');
		document.body.appendChild(container);
		window.matchMedia = vi.fn().mockImplementation((query) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
		window.HTMLElement.prototype.scrollIntoView = vi.fn();
		window.HTMLElement.prototype.hasPointerCapture = vi.fn();
		window.HTMLElement.prototype.releasePointerCapture = vi.fn();
	});

	afterEach(() => {
		container.remove();
	});

	it('disables trigger when catalog is null (AC 2)', () => {
		const root = createRoot(container);
		act(() => {
			root.render(
				createElement(ModelPicker, {
					catalog: null,
					selectedModel: null,
					onSelectModel: vi.fn(),
				}),
			);
		});

		const trigger = container.querySelector('[data-testid="grouped-select-trigger"]');
		expect(trigger).not.toBeNull();
		expect(trigger?.hasAttribute('disabled')).toBe(true);

		act(() => {
			root.unmount();
		});
	});

	it('renders future source text and duplicate daemon entries in the actual dropdown', async () => {
		const root = createRoot(container);
		await act(async () =>
			root.render(
				createElement(ModelPicker, {
					catalog: {
						...mockCatalog,
						models: [
							{ name: 'same-model', source: 'future-provider-source', isCurrentConfig: false },
							{ name: 'same-model', source: 'future-provider-source', isCurrentConfig: false },
						],
					},
					selectedModel: null,
					onSelectModel: vi.fn(),
				}),
			),
		);
		await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"]')?.click());
		expect(
			document.querySelectorAll('[role="option"][data-testid="select-option-same-model"]'),
		).toHaveLength(2);
		expect(document.querySelector('[data-group="other"]')?.textContent).toContain(
			'future-provider-source',
		);
		await act(async () => root.unmount());
	});

	it('renders incomplete footer when isComplete is false (AC 2, E-38)', async () => {
		const root = createRoot(container);
		act(() => {
			root.render(
				createElement(ModelPicker, {
					catalog: mockCatalog,
					selectedModel: 'gpt-4o',
					onSelectModel: vi.fn(),
					login: mockLogin,
				}),
			);
		});

		const trigger = container.querySelector(
			'[data-testid="grouped-select-trigger"]',
		) as HTMLButtonElement | null;
		expect(trigger).not.toBeNull();
		expect(trigger?.hasAttribute('disabled')).toBe(false);

		// Click to open dropdown
		await act(async () => {
			trigger?.click();
		});

		// Check incomplete note footer
		const footer = document.querySelector('[data-testid="select-note-footer"]');
		expect(footer).not.toBeNull();
		expect(footer?.textContent).toContain('清单可能不全，可手填');
		expect(footer?.getAttribute('role')).toBe('note');

		// Check current config chip
		const currentChip = document.body.textContent;
		expect(currentChip).toContain('当前配置');

		// Check provider badge for openai
		const providerBadge = document.querySelector('[data-testid="provider-badge-openai"]');
		expect(providerBadge).not.toBeNull();

		act(() => {
			root.unmount();
		});
	});

	it('displays "实时清单获取中" when isRefreshing is true (AC 2)', () => {
		const refreshingCatalog: ListAgentModelsResponse = {
			...mockCatalog,
			isRefreshing: true,
		};

		const root = createRoot(container);
		act(() => {
			root.render(
				createElement(ModelPicker, {
					catalog: refreshingCatalog,
					selectedModel: null,
					onSelectModel: vi.fn(),
				}),
			);
		});

		const trigger = container.querySelector('[data-testid="grouped-select-trigger"]');
		expect(trigger?.textContent).toContain('实时清单获取中');

		act(() => {
			root.unmount();
		});
	});

	it('renders refresh button and calls onRefresh when clicked (AC 1, AC 4)', async () => {
		const onRefreshMock = vi.fn();
		const root = createRoot(container);
		act(() => {
			root.render(
				createElement(ModelPicker, {
					catalog: mockCatalog,
					selectedModel: 'gpt-4o',
					onSelectModel: vi.fn(),
					onRefresh: onRefreshMock,
				}),
			);
		});

		const refreshBtn = container.querySelector(
			'[data-testid="refresh-models-btn"]',
		) as HTMLButtonElement | null;
		expect(refreshBtn).not.toBeNull();

		await act(async () => {
			refreshBtn?.click();
		});

		expect(onRefreshMock).toHaveBeenCalledTimes(1);

		act(() => {
			root.unmount();
		});
	});
});
