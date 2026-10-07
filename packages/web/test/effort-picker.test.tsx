/**
 * packages/web/test/effort-picker.test.tsx
 *
 * effort-picker 组件单元测试（AC 3, E-254, E-351）
 */

// @vitest-environment jsdom

import type { EffortVendorMap } from '@agent-scheduler/shared/api/agents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EffortPicker } from '../src/components/effort-picker.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('EffortPicker (AC 3, E-254, E-351)', () => {
	let container: HTMLDivElement;

	const sampleVendorMap: EffortVendorMap = {
		low: 'low_v',
		medium: 'medium_v',
		high: 'high_v',
	};

	it.each([
		{ name: 'empty probed list', options: [], warns: true },
		{ name: 'reduced agent list', options: ['low', 'medium', 'high'], warns: true },
		{ name: 'missing capability data', options: undefined, warns: false },
	])('preserves saved native effort and reports support with $name', ({ options, warns }) => {
		const root = createRoot(container);
		const onChange = vi.fn();
		act(() =>
			root.render(
				createElement(EffortPicker, {
					vendorMap: { low: 'low', medium: 'medium', high: 'high' },
					value: { vendor: 'max' },
					agentEffortOptions: options,
					onChange,
				}),
			),
		);
		expect(
			container.querySelector('[data-testid="grouped-select-trigger"]')?.textContent,
		).toContain('max');
		const warning = container.querySelector('[data-testid="effort-support-warning"]');
		if (warns) {
			expect(warning?.textContent).toContain('max');
			expect(warning?.getAttribute('aria-live')).toBe('polite');
		} else {
			expect(warning).toBeNull();
		}
		expect(onChange).not.toHaveBeenCalled();
		act(() => root.unmount());
	});

	it('offers native fallback levels, prefers model levels, and preserves a selected unsupported value', async () => {
		const root = createRoot(container);
		const onChange = vi.fn();
		const props = {
			vendorMap: { low: 'low', medium: 'medium', high: 'high' },
			agentEffortOptions: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
			value: null,
			onChange,
		};
		act(() => root.render(createElement(EffortPicker, props)));
		await act(async () =>
			(container.querySelector('[data-testid="grouped-select-trigger"]') as HTMLElement).click(),
		);
		const ultra = document.querySelector(
			'[data-testid="select-option-vendor:ultra"]',
		) as HTMLElement;
		expect(ultra).not.toBeNull();
		await act(async () => ultra.click());
		expect(onChange).toHaveBeenCalledWith({ vendor: 'ultra' });
		act(() =>
			root.render(
				createElement(EffortPicker, {
					...props,
					selectedModelEffortOptions: ['low', 'medium', 'high', 'max'],
				}),
			),
		);
		await act(async () =>
			(container.querySelector('[data-testid="grouped-select-trigger"]') as HTMLElement).click(),
		);
		expect(document.querySelector('[data-testid="select-option-vendor:ultra"]')).toBeNull();
		await act(async () =>
			(document.querySelector('[data-testid="select-option-vendor:max"]') as HTMLElement).click(),
		);
		act(() =>
			root.render(
				createElement(EffortPicker, {
					...props,
					value: { vendor: 'ultra' },
					selectedModelEffortOptions: ['high'],
				}),
			),
		);
		expect(
			container.querySelector('[data-testid="grouped-select-trigger"]')?.textContent,
		).toContain('ultra');
		expect(
			container.querySelector('[data-testid="effort-support-warning"]')?.textContent,
		).toContain('ultra');
		act(() => root.unmount());
	});

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

	it('renders read-only "—" with title when vendorMap is null (E-254)', () => {
		const root = createRoot(container);
		act(() => {
			root.render(
				createElement(EffortPicker, {
					vendorMap: null,
					value: null,
					onChange: vi.fn(),
				}),
			);
		});

		const unsupported = container?.querySelector('[data-testid="effort-unsupported-display"]');
		expect(unsupported).not.toBeNull();
		expect(unsupported?.textContent?.trim()).toBe('—');
		expect(unsupported?.getAttribute('title')).toContain('不支持思考强度');

		// Select trigger should not be rendered
		const trigger = container?.querySelector('[data-testid="grouped-select-trigger"]');
		expect(trigger).toBeNull();

		act(() => {
			root.unmount();
		});
	});

	it('renders select trigger when vendorMap is present and roundtrips onChange', async () => {
		const onChangeMock = vi.fn();
		const root = createRoot(container);
		act(() => {
			root.render(
				createElement(EffortPicker, {
					vendorMap: sampleVendorMap,
					value: { tier: 'medium' },
					onChange: onChangeMock,
					selectedModelEffortOptions: ['low_v', 'medium_v', 'high_v', 'max_vendor'],
					allowVendor: true,
				}),
			);
		});

		const trigger = container.querySelector(
			'[data-testid="grouped-select-trigger"]',
		) as HTMLButtonElement | null;
		expect(trigger).not.toBeNull();
		expect(trigger?.textContent).toContain('中档 (medium)');

		await act(async () => {
			trigger?.click();
		});

		// Check vendor group item is rendered
		const maxOption = document.querySelector('[data-testid="select-option-vendor:max_vendor"]');
		expect(maxOption).not.toBeNull();

		await act(async () => {
			(maxOption as HTMLElement)?.click();
		});

		expect(onChangeMock).toHaveBeenCalledWith({ vendor: 'max_vendor' });

		act(() => {
			root.unmount();
		});
	});

	it('displays unsupported warning without disabling or resetting value when model does not support tier (E-351)', () => {
		const root = createRoot(container);
		act(() => {
			root.render(
				createElement(EffortPicker, {
					vendorMap: sampleVendorMap,
					value: { tier: 'high' },
					onChange: vi.fn(),
					// Model only supports low and medium
					selectedModelEffortOptions: ['low_v', 'medium_v'],
				}),
			);
		});

		const warning = container?.querySelector('[data-testid="effort-support-warning"]');
		expect(warning).not.toBeNull();
		expect(warning?.textContent).toContain('该模型不支持 high');
		expect(warning?.getAttribute('aria-live')).toBe('polite');

		const trigger = container?.querySelector('[data-testid="grouped-select-trigger"]');
		expect(trigger?.hasAttribute('disabled')).toBe(false);

		act(() => {
			root.unmount();
		});
	});
});
