/**
 * packages/web/src/shell/desktop-titlebar.tsx
 *
 * Custom window title bar for the Tauri desktop shell (Memphis light/dark).
 * - Windows / Linux: the window is undecorated (tauri.conf.json `decorations: false`), so this
 *   bar draws the drag region plus minimize / maximize / close and thin resize edges.
 * - macOS: the window keeps native traffic lights (`titleBarStyle: Overlay`); the bar only
 *   draws the drag region and leaves room for the lights.
 * Dragging uses `data-tauri-drag-region`, so the OS performs the move: edge snapping, Win+arrow
 * and double-click-to-maximize keep working. Rendered only when SHELL.platform === 'tauri'.
 */

import { type ReactElement, useEffect, useState } from 'react';
import { UI_STRINGS } from '../i18n/ui-strings.ts';
import { getTauriWindowInvoke } from './shell-bridge.ts';

export type TitlebarInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
export type TitlebarMode = 'pending' | 'custom' | 'overlay';

const WINDOW_LABEL = 'main';

export const WINDOW_COMMANDS = {
	isDecorated: 'plugin:window|is_decorated',
	isMaximized: 'plugin:window|is_maximized',
	minimize: 'plugin:window|minimize',
	toggleMaximize: 'plugin:window|toggle_maximize',
	close: 'plugin:window|close',
	startResizeDragging: 'plugin:window|start_resize_dragging',
} as const;

export const RESIZE_EDGES = [
	'North',
	'South',
	'East',
	'West',
	'NorthEast',
	'NorthWest',
	'SouthEast',
	'SouthWest',
] as const;

export interface DesktopTitlebarProps {
	readonly invoke?: TitlebarInvoke;
	readonly title?: string;
}

export function DesktopTitlebar({ invoke, title }: DesktopTitlebarProps): ReactElement | null {
	const call = invoke ?? getTauriWindowInvoke();
	const [mode, setMode] = useState<TitlebarMode>('pending');
	const [maximized, setMaximized] = useState(false);
	const strings = UI_STRINGS.titlebar;

	useEffect(() => {
		if (!call) return;
		let alive = true;
		const refresh = (): void => {
			void call(WINDOW_COMMANDS.isMaximized, { label: WINDOW_LABEL }).then(
				(value) => alive && setMaximized(value === true),
				() => undefined,
			);
		};
		void call(WINDOW_COMMANDS.isDecorated, { label: WINDOW_LABEL }).then(
			(decorated) => alive && setMode(decorated === true ? 'overlay' : 'custom'),
			() => alive && setMode('custom'),
		);
		refresh();
		window.addEventListener('resize', refresh);
		document.documentElement.classList.add('has-desktop-titlebar');
		return () => {
			alive = false;
			window.removeEventListener('resize', refresh);
			document.documentElement.classList.remove('has-desktop-titlebar');
		};
	}, [call]);

	if (!call) return null;
	const run = (cmd: string, extra?: Record<string, unknown>): void => {
		void call(cmd, { label: WINDOW_LABEL, ...extra }).catch(() => undefined);
	};

	return (
		<>
			<header
				className="desktop-titlebar"
				data-testid="desktop-titlebar"
				data-mode={mode}
				data-tauri-drag-region=""
			>
				<span className="desktop-titlebar-mark" aria-hidden="true" data-tauri-drag-region="" />
				<span className="desktop-titlebar-title" data-tauri-drag-region="">
					{title ?? strings.appTitle}
				</span>
				{mode === 'custom' ? (
					<div className="desktop-titlebar-controls">
						<button
							type="button"
							className="desktop-titlebar-btn"
							data-testid="titlebar-minimize"
							aria-label={strings.minimize}
							title={strings.minimize}
							onClick={() => run(WINDOW_COMMANDS.minimize)}
						>
							<span className="desktop-titlebar-glyph is-min" aria-hidden="true" />
						</button>
						<button
							type="button"
							className="desktop-titlebar-btn"
							data-testid="titlebar-maximize"
							aria-label={maximized ? strings.restore : strings.maximize}
							title={maximized ? strings.restore : strings.maximize}
							onClick={() => run(WINDOW_COMMANDS.toggleMaximize)}
						>
							<span
								className={`desktop-titlebar-glyph ${maximized ? 'is-restore' : 'is-max'}`}
								aria-hidden="true"
							/>
						</button>
						<button
							type="button"
							className="desktop-titlebar-btn is-close"
							data-testid="titlebar-close"
							aria-label={strings.close}
							title={strings.close}
							onClick={() => run(WINDOW_COMMANDS.close)}
						>
							<span className="desktop-titlebar-glyph is-close" aria-hidden="true" />
						</button>
					</div>
				) : null}
			</header>
			{mode === 'custom' && !maximized
				? RESIZE_EDGES.map((edge) => (
						<div
							key={edge}
							className={`desktop-resize-edge edge-${edge}`}
							data-testid={`titlebar-resize-${edge}`}
							aria-hidden="true"
							onMouseDown={(event) => {
								if (event.button !== 0) return;
								event.preventDefault();
								run(WINDOW_COMMANDS.startResizeDragging, { value: edge });
							}}
						/>
					))
				: null}
		</>
	);
}
