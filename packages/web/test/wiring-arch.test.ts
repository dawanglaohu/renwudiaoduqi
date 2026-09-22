import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const srcDir = join(webDir, 'src');

function walkSource(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const path = join(directory, entry);
		return statSync(path).isDirectory()
			? walkSource(path)
			: /\.(?:ts|tsx)$/.test(path)
				? [path]
				: [];
	});
}

function source(path: string): string {
	return readFileSync(join(webDir, path), 'utf8');
}

describe('M9-T26 production wiring architecture', () => {
	it('keeps the single sseClient.connect call in app/bootstrap.ts', () => {
		const hits = walkSource(srcDir).flatMap((path) => {
			const matches = readFileSync(path, 'utf8').match(/\bsseClient\.connect\s*\(/g) ?? [];
			return matches.map(() => relative(webDir, path).replaceAll('\\', '/'));
		});
		expect(hits).toEqual(['src/app/bootstrap.ts']);
	});

	it('calls every registration seam from production code', () => {
		const production = walkSource(srcDir)
			.map((path) => readFileSync(path, 'utf8'))
			.join('\n');
		for (const name of [
			'registerNativeShellAdapter',
			'registerTokenProvider',
			'registerShellHostHint',
		]) {
			const calls = production.match(new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`, 'g')) ?? [];
			expect(calls.length, `${name} production calls`).toBeGreaterThanOrEqual(1);
		}
	});

	it('confines native globals to the two shell boundary files', () => {
		const hits = walkSource(srcDir)
			.filter((path) => /__TAURI_INTERNALS__|window\.Capacitor/.test(readFileSync(path, 'utf8')))
			.map((path) => relative(webDir, path).replaceAll('\\', '/'))
			.sort();
		expect(hits).toEqual(['src/shell/detect-shell.ts', 'src/shell/shell-bridge.ts']);
	});

	it('awaits bootstrap before createRoot and exposes connection status without polling', () => {
		const main = source('src/main.tsx');
		const bootstrapSource = source('src/app/bootstrap.ts');
		expect(main.indexOf('await bootstrap()')).toBeGreaterThan(-1);
		expect(main.indexOf('createRoot(')).toBeGreaterThan(main.indexOf('await bootstrap()'));
		expect(bootstrapSource).toContain('root.dataset.connectionStatus = status');
		expect(bootstrapSource).not.toMatch(/setInterval\s*\(/);
	});
});
