// @vitest-environment jsdom
/**
 * packages/web/test/desktop-titlebar.test.tsx
 *
 * Custom Memphis desktop title bar: window controls, drag region, macOS overlay, resize edges.
 */

import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UI_STRINGS } from '../src/i18n/ui-strings.ts';
import {
	DesktopTitlebar,
	RESIZE_EDGES,
	type TitlebarInvoke,
	WINDOW_COMMANDS,
} from '../src/shell/desktop-titlebar.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
});

function makeInvoke(decorated: boolean, maximized = false) {
	return vi.fn<TitlebarInvoke>(async (cmd) => {
		if (cmd === WINDOW_COMMANDS.isDecorated) return decorated;
		if (cmd === WINDOW_COMMANDS.isMaximized) return maximized;
		return null;
	});
}

async function mount(invoke: TitlebarInvoke): Promise<HTMLDivElement> {
	host = document.createElement('div');
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(<DesktopTitlebar invoke={invoke} />);
	});
	return host;
}

const q = (el: Element, id: string) =>
	el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('DesktopTitlebar', () => {
	it('renders nothing without the Tauri bridge (web / mobile)', async () => {
		const el = await mount(undefined as unknown as TitlebarInvoke);
		expect(q(el, 'desktop-titlebar')).toBeNull();
		expect(document.documentElement.classList.contains('has-desktop-titlebar')).toBe(false);
	});

	it('undecorated window: drag region + min/max/close call window commands', async () => {
		const invoke = makeInvoke(false);
		const el = await mount(invoke);
		const bar = q(el, 'desktop-titlebar');
		expect(bar?.getAttribute('data-mode')).toBe('custom');
		expect(bar?.hasAttribute('data-tauri-drag-region')).toBe(true);
		expect(bar?.textContent).toContain(UI_STRINGS.titlebar.appTitle);
		expect(document.documentElement.classList.contains('has-desktop-titlebar')).toBe(true);

		await act(async () => q(el, 'titlebar-minimize')?.click());
		await act(async () => q(el, 'titlebar-maximize')?.click());
		await act(async () => q(el, 'titlebar-close')?.click());
		const cmds = invoke.mock.calls.map((c) => c[0]);
		expect(cmds).toContain(WINDOW_COMMANDS.minimize);
		expect(cmds).toContain(WINDOW_COMMANDS.toggleMaximize);
		expect(cmds).toContain(WINDOW_COMMANDS.close);
		for (const call of invoke.mock.calls) expect(call[1]).toMatchObject({ label: 'main' });
		expect(q(el, 'titlebar-maximize')?.getAttribute('aria-label')).toBe(
			UI_STRINGS.titlebar.maximize,
		);
	});

	it('shows restore when maximized and hides resize edges', async () => {
		const el = await mount(makeInvoke(false, true));
		expect(q(el, 'titlebar-maximize')?.getAttribute('aria-label')).toBe(
			UI_STRINGS.titlebar.restore,
		);
		expect(el.querySelectorAll('.desktop-resize-edge')).toHaveLength(0);
	});

	it('resize edges start an OS resize drag in the right direction', async () => {
		const invoke = makeInvoke(false);
		const el = await mount(invoke);
		expect(el.querySelectorAll('.desktop-resize-edge')).toHaveLength(RESIZE_EDGES.length);
		await act(async () => {
			q(el, 'titlebar-resize-SouthEast')?.dispatchEvent(
				new MouseEvent('mousedown', { bubbles: true, button: 0 }),
			);
		});
		expect(invoke).toHaveBeenCalledWith(WINDOW_COMMANDS.startResizeDragging, {
			label: 'main',
			value: 'SouthEast',
		});
	});

	it('macOS overlay (native traffic lights): drag region only, no custom buttons', async () => {
		const el = await mount(makeInvoke(true));
		expect(q(el, 'desktop-titlebar')?.getAttribute('data-mode')).toBe('overlay');
		expect(q(el, 'titlebar-close')).toBeNull();
		expect(el.querySelectorAll('.desktop-resize-edge')).toHaveLength(0);
	});
});
