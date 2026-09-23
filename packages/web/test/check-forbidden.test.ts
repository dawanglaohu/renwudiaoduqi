import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
	findFontStacks,
	findRootFontSizeLocks,
	isDeckContainer,
	runForbiddenCheck,
} from '../scripts/check-forbidden.js';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratchDirs: string[] = [];

afterEach(() => {
	for (const dir of scratchDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function scratchWebDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'agsched-forbidden-'));
	scratchDirs.push(dir);
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

function ruleHits(dir: string): string[] {
	return runForbiddenCheck(dir, dir).violations.map((v) => `${v.rule}@${basename(v.file)}`);
}

describe('check-forbidden (M9-T1, E-170, E-15)', () => {
	it('passes every architecture check on the clean workspace', () => {
		const report = runForbiddenCheck();
		expect(report.passed).toBe(true);
		expect(report.violations).toEqual([]);
	});

	it('flags a root font-size lock even when the declaration sits on its own line (E-15)', () => {
		expect(findRootFontSizeLocks('html {\n\tfont-size: 14px;\n}\n')).toEqual([1]);
		expect(findRootFontSizeLocks(':root { font-size: 16px; }')).toEqual([1]);
		expect(findRootFontSizeLocks('.html-snippet { font-size: 14px; }')).toEqual([]);
		expect(findRootFontSizeLocks('html { font-size: 100%; }')).toEqual([]);
	});

	it('treats the run-deck lanes as the container that must never scroll sideways (E-145)', () => {
		expect(isDeckContainer('packages/web/src/features/run-deck/run-deck-container.tsx')).toBe(true);
		expect(isDeckContainer('packages/web/src/components/stream-column.tsx')).toBe(true);
		expect(isDeckContainer('packages/web/src/components/virtual-rows.tsx')).toBe(false);
	});
});

describe('check-forbidden: build configs alias tokens only (M9-T24, E-159)', () => {
	it('findFontStacks reports generic families and non-alias fontFamily entries by line', () => {
		expect(
			findFontStacks(
				[
					"import type { Config } from 'tailwindcss';",
					'const config: Config = {',
					'\ttheme: { extend: { fontFamily: {',
					"\t\tui: 'var(--font-ui)',",
					"\t\tmono: 'var(--font-mono)',",
					'\t} } },',
					'};',
				].join('\n'),
			),
		).toEqual([]);
		expect(
			findFontStacks(
				[
					'const config = { theme: { fontFamily: {',
					"\tui: ['Inter', 'sans-serif'],",
					"\tmono: 'var(--font-mono)',",
					'\tdisplay: \'"Commit Mono"\',',
					'} } };',
				].join('\n'),
			),
		).toEqual([2, 4]);
		expect(findFontStacks("module.exports = { family: 'ui-monospace, Menlo' };")).toEqual([1]);
		// Comments are not stacks, and a token alias written in a comment stays silent
		expect(
			findFontStacks('// falls back to system-ui when the woff2 is missing\nconst a = 1;'),
		).toEqual([]);
		expect(findFontStacks('/* monospace */ const fontFamily = { ui: "var(--font-ui)" };')).toEqual(
			[],
		);
	});

	it('fails when tailwind.config.ts carries a hex colour or a font stack', () => {
		const dir = scratchWebDir({
			'tailwind.config.ts': [
				'const config = {',
				"\ttheme: { colors: { page: '#123456' }, fontFamily: { ui: ['Inter', 'sans-serif'] } },",
				'};',
				'export default config;',
			].join('\n'),
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('COLOR_LITERAL_OUTSIDE_TOKENS_CSS@tailwind.config.ts');
		expect(hits).toContain('FONT_STACK_IN_BUILD_CONFIG@tailwind.config.ts');
	});

	it('fails when postcss.config.cjs carries a hex colour or a font stack', () => {
		const dir = scratchWebDir({
			'postcss.config.cjs': [
				'module.exports = {',
				"\tplugins: [require('tailwindcss')(), require('autoprefixer')()],",
				"\tbrand: { accent: 'rgba(1, 2, 3, 0.5)', family: '\"Public Sans\", system-ui' },",
				'};',
			].join('\n'),
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('COLOR_LITERAL_OUTSIDE_TOKENS_CSS@postcss.config.cjs');
		expect(hits).toContain('FONT_STACK_IN_BUILD_CONFIG@postcss.config.cjs');
	});

	it('accepts build configs that only alias var(--*) tokens', () => {
		const dir = scratchWebDir({
			'tailwind.config.ts': [
				'const config = {',
				"\ttheme: { extend: { colors: { page: 'var(--page)' }, fontFamily: { ui: 'var(--font-ui)' } } },",
				'};',
				'export default config;',
			].join('\n'),
			'postcss.config.cjs':
				"module.exports = { plugins: [require('tailwindcss')(), require('autoprefixer')()] };\n",
		});
		expect(ruleHits(dir)).toEqual([]);
	});

	it('the real tailwind.config.ts and postcss.config.cjs declare no font stack', () => {
		for (const name of ['tailwind.config.ts', 'postcss.config.cjs']) {
			expect(findFontStacks(readFileSync(join(webDir, name), 'utf8')), name).toEqual([]);
		}
	});
});
