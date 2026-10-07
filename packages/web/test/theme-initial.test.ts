import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { type Theme, resolveTheme } from '../src/app/theme-provider.tsx';

const webRoot = resolve(__dirname, '..');
const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8');
const head = html.split('</head>')[0] ?? '';

function beforeApp(stored: string | null, prefersDark?: boolean, storageBlocked = false) {
	const attributes = new Map<string, string>();
	const root = {
		setAttribute: (name: string, value: string) => attributes.set(name, value),
		style: {} as { colorScheme?: string },
	};
	const environment = {
		document: { documentElement: root },
		window: {
			matchMedia: prefersDark === undefined ? undefined : () => ({ matches: prefersDark }),
		},
		localStorage: {
			getItem: () => {
				if (storageBlocked) throw new Error('Storage access denied');
				return stored;
			},
		},
	};
	for (const tag of head.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
		const attributes = tag[1] ?? '';
		if (/\b(?:async|defer)\b|type=["']module["']/.test(attributes)) continue;
		const source = attributes.match(/src=["']([^"']+)["']/)?.[1];
		const script = source
			? readFileSync(resolve(webRoot, 'public', source), 'utf8')
			: (tag[2] ?? '');
		runInNewContext(script, environment);
	}
	return { theme: attributes.get('data-theme'), colorScheme: root.style.colorScheme };
}

describe('initial theme before app bootstrap (M9-T1, E-15)', () => {
	it.each([
		['light', true, false],
		['dark', false, false],
		['system', false, false],
		['system', true, false],
		[null, false, false],
		['invalid', false, false],
		['dark', false, true],
		['system', undefined, false],
		['light', undefined, false],
	] as const)(
		'applies stored %s with system dark %s before any app module',
		(stored, dark, blocked) => {
			const theme: Theme =
				!blocked && (stored === 'light' || stored === 'dark' || stored === 'system')
					? stored
					: 'system';
			const resolved = resolveTheme(theme, dark ?? true);
			expect(beforeApp(stored, dark, blocked)).toEqual({ theme: resolved, colorScheme: resolved });
		},
	);

	it('loads a parser-blocking same-origin script permitted by the desktop CSP', () => {
		const tag = head.match(/<script\b[^>]*src=["']\.\/theme-init\.js["'][^>]*><\/script>/)?.[0];
		expect(tag).toBeDefined();
		expect(tag).not.toMatch(/\b(?:async|defer)\b|type=["']module["']/);
		const csp = JSON.parse(
			readFileSync(resolve(webRoot, '../shell-desktop/src-tauri/tauri.conf.json'), 'utf8'),
		).app.security.csp as string;
		expect(csp).toContain("script-src 'self'");
	});
});
