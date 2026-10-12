import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = resolve(fileURLToPath(new URL('..', import.meta.url)), 'src-tauri');
const read = (name: string) => JSON.parse(readFileSync(resolve(dir, name), 'utf8'));

describe('custom Memphis title bar window config', () => {
	it('Windows/Linux: main window is undecorated, resizable, keeps the OS shadow', () => {
		const win = read('tauri.conf.json').app.windows[0];
		expect(win).toMatchObject({ label: 'main', decorations: false, shadow: true, resizable: true });
	});

	it('macOS: keeps native traffic lights via Overlay title bar', () => {
		const win = read('tauri.macos.conf.json').app.windows[0];
		expect(win).toMatchObject({
			label: 'main',
			decorations: true,
			titleBarStyle: 'Overlay',
			hiddenTitle: true,
		});
		const base = read('tauri.conf.json').app.windows[0];
		expect({
			...win,
			decorations: base.decorations,
			titleBarStyle: undefined,
			hiddenTitle: undefined,
		}).toMatchObject({
			width: base.width,
			height: base.height,
			minWidth: base.minWidth,
			minHeight: base.minHeight,
		});
	});

	it('grants exactly the window permissions the title bar invokes', () => {
		const perms: string[] = read('capabilities/default.json').permissions;
		for (const p of [
			'core:window:allow-minimize',
			'core:window:allow-toggle-maximize',
			'core:window:allow-internal-toggle-maximize',
			'core:window:allow-close',
			'core:window:allow-start-dragging',
			'core:window:allow-start-resize-dragging',
		]) {
			expect(perms).toContain(p);
		}
	});
});
