// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { GroupedSelect } from '../src/ui/grouped-select.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
	window.matchMedia = vi.fn().mockImplementation(() => ({
		matches: false,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	}));
	window.HTMLElement.prototype.scrollIntoView = vi.fn();
	window.HTMLElement.prototype.hasPointerCapture = vi.fn();
	window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

it.each(['cancel', 'confirm', 'external', 'Enter', 'Escape'])(
	'manual %s preserves the intended action and change count',
	async (action) => {
		const host = document.createElement('div');
		document.body.append(host);
		const root = createRoot(host);
		const onValueChange = vi.fn();
		try {
			await act(async () =>
				root.render(
					createElement(GroupedSelect, {
						value: 'old',
						onValueChange,
						labels: { confirm: 'confirm', cancel: 'cancel', close: 'close' },
						groups: [
							{
								id: 'manual',
								label: 'manual',
								subgroups: [
									{
										items: [
											{ value: '__manual_custom_model__', label: 'manual', isCustomAction: true },
										],
									},
								],
							},
						],
					}),
				),
			);
			await act(async () => host.querySelector<HTMLButtonElement>('[role="combobox"]')?.click());
			await act(async () =>
				document
					.querySelector('[role="option"]')
					?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
			);
			const input = host.querySelector<HTMLInputElement>('input');
			expect(input).not.toBeNull();
			if (!input) throw new Error('manual input missing');
			await act(async () => {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
					input,
					'new-model',
				);
				input.dispatchEvent(new Event('input', { bubbles: true }));
			});
			if (action === 'cancel' || action === 'confirm') {
				const button = Array.from(host.querySelectorAll('button')).find(
					(b) => b.textContent === action,
				);
				await act(async () => button?.focus());
				await act(async () => button?.click());
			} else if (action === 'external') {
				await act(async () => input.blur());
			} else {
				await act(async () =>
					input.dispatchEvent(new KeyboardEvent('keydown', { key: action, bubbles: true })),
				);
			}
			expect(onValueChange).toHaveBeenCalledTimes(
				action === 'cancel' || action === 'Escape' ? 0 : 1,
			);
			if (action !== 'cancel' && action !== 'Escape')
				expect(onValueChange).toHaveBeenCalledWith('new-model');
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	},
);
