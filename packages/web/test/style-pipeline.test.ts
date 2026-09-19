// @vitest-environment jsdom
/**
 * packages/web/test/style-pipeline.test.ts
 *
 * M9-T24 前端样式管线接通：postcss 与 tailwind 进 Vite 构建（AC 1..5, E-159, E-175, E-224）
 *
 * jsdom 只为 AC 3 的挂载断言而来；AC 1 / AC 5 在子进程里跑真实的 `vite build`，与本文件的
 * 测试环境无关。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type AcceptedPlugin } from 'postcss';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ThemeProvider, markStyleLoaded } from '../src/app/theme-provider.tsx';

const require = createRequire(import.meta.url);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const postcssConfigPath = resolve(webDir, 'postcss.config.cjs');
const baseCssPath = resolve(webDir, 'src/styles/base.css');
const tokensCssPath = resolve(webDir, 'src/styles/tokens.css');

/** Selector count of single-class rules such as `.flex{` / `.gap-2{` in a minified stylesheet. */
function countUtilityRules(css: string): number {
	return css.match(/\.[a-z][a-z0-9-]*\{/g)?.length ?? 0;
}

function loadPostcssPlugins(): AcceptedPlugin[] {
	const config = require(postcssConfigPath) as { plugins: AcceptedPlugin[] };
	return config.plugins;
}

interface BuildOutput {
	readonly html: string;
	readonly cssFiles: readonly string[];
	readonly jsFiles: readonly string[];
	readonly css: string;
}

function readBuildOutput(outDir: string): BuildOutput {
	const assetsDir = join(outDir, 'assets');
	const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
	const cssFiles = assets.filter((name) => name.endsWith('.css'));
	const jsFiles = assets.filter((name) => name.endsWith('.js'));
	return {
		html: readFileSync(join(outDir, 'index.html'), 'utf8'),
		cssFiles,
		jsFiles,
		css: cssFiles.map((name) => readFileSync(join(assetsDir, name), 'utf8')).join('\n'),
	};
}

/** The same assertions for every build directory: the one this test produces and CI's dist. */
function expectStyledBuild(output: BuildOutput, label: string): void {
	expect(output.cssFiles, `${label}: exactly one stylesheet is emitted`).toHaveLength(1);
	expect(output.css, `${label}: @tailwind directives must be compiled away`).not.toContain(
		'@tailwind',
	);
	expect(countUtilityRules(output.css), `${label}: utility rule count`).toBeGreaterThanOrEqual(200);
	expect(output.css).toMatch(/\.flex\{display:flex\}/);
	expect(output.css).toMatch(/\.gap-2\{gap:var\(--sp-2\)\}/);
}

const scratchDirs: string[] = [];

function scratchDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratchDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of scratchDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('M9-T24: PostCSS pipeline (AC 2, E-159)', () => {
	it('postcss.config.cjs registers exactly tailwindcss and autoprefixer', () => {
		const names = loadPostcssPlugins().map((plugin) =>
			typeof plugin === 'object' && 'postcssPlugin' in plugin ? plugin.postcssPlugin : 'unknown',
		);
		expect(names).toEqual(['tailwindcss', 'autoprefixer']);
	});

	it('processing src/styles/base.css emits .bg-page backed by var(--page), no hex in between', async () => {
		const result = await postcss(loadPostcssPlugins()).process(readFileSync(baseCssPath, 'utf8'), {
			from: baseCssPath,
		});
		expect(result.css).not.toContain('@tailwind');
		const bgPage = /\.bg-page\s*\{([^}]*)\}/.exec(result.css);
		expect(bgPage?.[1]).toMatch(/background-color:\s*var\(--page\)/);
		expect(bgPage?.[1]).not.toMatch(/#[0-9a-f]{3,8}/i);
		// Bare `border` picks up the token, not Tailwind's grey preflight default (E-159)
		expect(result.css).toMatch(/border-color:\s*var\(--border\)/);
	}, 60_000);
});

describe('M9-T24: vite build output (AC 1, AC 5, E-175, E-224)', () => {
	const viteBin = resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
	let output: BuildOutput | null = null;

	function buildOnce(): BuildOutput {
		if (output) {
			return output;
		}
		const outDir = scratchDir('agsched-style-pipeline-');
		try {
			execFileSync(
				process.execPath,
				[viteBin, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'],
				{ cwd: webDir, shell: false, stdio: 'pipe', encoding: 'utf8', windowsHide: true },
			);
		} catch (error) {
			const stderr = (error as { stderr?: string }).stderr ?? '';
			throw new Error(`vite build failed:\n${stderr}`);
		}
		output = readBuildOutput(outDir);
		return output;
	}

	it('AC 1: the built stylesheet contains no @tailwind literal and at least 200 utility rules', () => {
		expectStyledBuild(buildOnce(), 'fresh build');
	}, 300_000);

	it('AC 5 & E-224: base stays ./, the vendor chunk names stay, one relative CSS for all three loaders', () => {
		const viteConfig = readFileSync(resolve(webDir, 'vite.config.ts'), 'utf8');
		expect(viteConfig).toMatch(/base:\s*'\.\/'/);
		expect(viteConfig).toMatch(/postcss:\s*resolve\(__dirname,\s*'postcss\.config\.cjs'\)/);
		expect(viteConfig).toContain("return 'vendor-react'");
		expect(viteConfig).toContain("return 'vendor-ui'");

		const built = buildOnce();
		const stylesheetLinks = built.html.match(/<link rel="stylesheet"[^>]*>/g) ?? [];
		expect(stylesheetLinks).toHaveLength(1);
		expect(stylesheetLinks[0]).toMatch(/href="\.\/assets\/[^"]+\.css"/);
		expect(built.html).not.toMatch(/(?:href|src)="\/assets\//);
		expect(built.html).toMatch(/src="\.\/assets\/index-[^"]+\.js"/);

		expect(built.jsFiles.some((name) => /^vendor-react-[\w-]+\.js$/.test(name))).toBe(true);
		for (const name of built.jsFiles.filter((file) => file.startsWith('vendor-'))) {
			expect(name).toMatch(/^vendor-(?:react|ui)-[\w-]+\.js$/);
		}
	}, 300_000);

	it('E-175: fonts and every other asset resolve relative to the stylesheet, never a CDN', () => {
		const built = buildOnce();
		expect(built.css).not.toMatch(/url\(\s*['"]?\/(?!\/)/);
		expect(built.css).not.toMatch(/https?:\/\//);
		expect(built.css).toMatch(/url\(\.\.\/fonts\/public-sans-latin-400\.woff2\)/);
	}, 300_000);

	it('the committed dist, when present, went through the same pipeline (CI builds it first)', () => {
		const distDir = resolve(webDir, 'dist');
		if (!existsSync(join(distDir, 'index.html'))) {
			return;
		}
		expectStyledBuild(readBuildOutput(distDir), 'packages/web/dist (rebuild it if stale)');
	});
});

describe('M9-T24: theme-provider marks the document once styles apply (AC 3, E-159)', () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

	function mountThemeProvider(): () => void {
		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container);
		act(() => {
			root.render(createElement(ThemeProvider, null, null));
		});
		return () => {
			act(() => {
				root.unmount();
			});
			container.remove();
		};
	}

	afterEach(() => {
		delete document.documentElement.dataset.styleLoaded;
		for (const style of Array.from(document.head.querySelectorAll('style'))) {
			style.remove();
		}
	});

	it('does not fake data-style-loaded while --page is empty (bare jsdom, no stylesheet)', () => {
		expect(getComputedStyle(document.documentElement).getPropertyValue('--page')).toBe('');
		expect(markStyleLoaded()).toBe(false);
		const unmount = mountThemeProvider();
		expect(document.documentElement.hasAttribute('data-style-loaded')).toBe(false);
		expect(document.documentElement.getAttribute('data-theme')).toMatch(/^(?:dark|light)$/);
		unmount();
	});

	it('writes data-style-loaded="true" after mount once tokens.css is in effect', () => {
		const style = document.createElement('style');
		style.textContent = readFileSync(tokensCssPath, 'utf8');
		document.head.appendChild(style);
		expect(getComputedStyle(document.documentElement).getPropertyValue('--page')).not.toBe('');
		const unmount = mountThemeProvider();
		expect(document.documentElement.getAttribute('data-style-loaded')).toBe('true');
		expect(document.documentElement.dataset.styleLoaded).toBe('true');
		unmount();
	});
});
