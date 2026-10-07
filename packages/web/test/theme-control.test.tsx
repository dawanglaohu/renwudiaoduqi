// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeControl } from '../src/app/theme-control.tsx';
import { ThemeProvider } from '../src/app/theme-provider.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

it('switches the document theme, persists the choice and follows system changes', async () => {
	let onSystemChange: ((event: { matches: boolean }) => void) | undefined;
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({
			matches: false,
			addEventListener: (_: string, listener: typeof onSystemChange) => {
				onSystemChange = listener;
			},
			removeEventListener: vi.fn(),
		})),
	);
	const host = document.createElement('div');
	document.body.append(host);
	let root = createRoot(host);
	const mount = async () => {
		await act(async () =>
			root.render(createElement(ThemeProvider, null, createElement(ThemeControl))),
		);
	};
	const select = async (theme: string) => {
		const button = host.querySelector<HTMLButtonElement>(`[data-testid="theme-${theme}"]`);
		expect(button).not.toBeNull();
		await act(async () => button?.click());
	};
	try {
		await mount();
		expect(document.documentElement.dataset.theme).toBe('light');
		await select('dark');
		expect(document.documentElement.dataset.theme).toBe('dark');
		expect(document.documentElement.style.colorScheme).toBe('dark');
		expect(localStorage.getItem('theme')).toBe('dark');
		expect(host.querySelector('[data-testid="theme-dark"]')?.getAttribute('aria-pressed')).toBe(
			'true',
		);

		await act(async () => root.unmount());
		root = createRoot(host);
		await mount();
		expect(document.documentElement.dataset.theme).toBe('dark');
		await select('light');
		expect(document.documentElement.dataset.theme).toBe('light');
		await select('system');
		await act(async () => onSystemChange?.({ matches: true }));
		expect(document.documentElement.dataset.theme).toBe('dark');
		expect(localStorage.getItem('theme')).toBe('system');
		await act(async () => onSystemChange?.({ matches: false }));
		expect(document.documentElement.dataset.theme).toBe('light');
	} finally {
		await act(async () => root.unmount());
	}
});

it('closes with Escape and restores keyboard focus to the theme button', async () => {
	const host = document.createElement('div');
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(createElement(ThemeProvider, null, createElement(ThemeControl))),
		);
		const details = host.querySelector('details');
		const summary = host.querySelector('summary');
		if (!details || !summary) throw new Error('Theme control did not mount');
		details.open = true;
		await act(async () => {
			details.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		});
		expect(details.open).toBe(false);
		expect(document.activeElement).toBe(summary);
	} finally {
		await act(async () => root.unmount());
	}
});
