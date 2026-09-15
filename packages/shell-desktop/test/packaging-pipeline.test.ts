import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
	calculateMonospaceColumnWidth,
	validateDesktopPackagingPipeline,
	validateFontFallbackAndChMetrics,
	validateFontWeightsRestricted,
	validateNoExternalCdn,
	validateRelativeBasePath,
	validateSingleBuildConsumption,
} from '../src/packaging-pipeline.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, '../../..');
const scratchDirs: string[] = [];

afterEach(() => {
	for (const dir of scratchDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function scratchRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), 'agsched-pipeline-'));
	scratchDirs.push(dir);
	return dir;
}

describe('Shared Packaging Pipeline Validation (AC 2-6, E-174..E-176)', () => {
	it('AC 2: daemon static, Tauri frontendDist, and Capacitor webDir consume the exact same build directory', () => {
		const result = validateSingleBuildConsumption(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);

		const expectedCanonical = resolve(repoRoot, 'packages/web/dist');
		expect(result.paths.tauriDist).toBe(expectedCanonical);
		expect(result.paths.capacitorWebDir).toBe(expectedCanonical);
		expect(result.paths.daemonStaticRoot).toBe(expectedCanonical);
		expect(result.paths.expectedCanonicalDist).toBe(expectedCanonical);
	});

	it("AC 3: packages/web/vite.config.ts configures base: './' and dist CSS has no absolute url(/…)", () => {
		const result = validateRelativeBasePath(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('AC 4 & E-175: zero external CDN links in styles, index.html, and JS', () => {
		const result = validateNoExternalCdn(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.violations).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it('AC 5 & E-174: font-mono includes ui-monospace and column widths use ch units', () => {
		const result = validateFontFallbackAndChMetrics(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.hasUiMonospace).toBe(true);
		expect(result.hasChColumnWidth).toBe(true);
		expect(result.errors).toEqual([]);

		const colWidth10 = calculateMonospaceColumnWidth(10);
		expect(colWidth10).toBe('12ch');
	});

	it('AC 6 & E-176: font weights are restricted to used weights', () => {
		const result = validateFontWeightsRestricted(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		for (const w of result.declaredWeights) {
			expect([400, 500, 600]).toContain(w);
		}
	});

	it('runs the full desktop packaging pipeline validator and produces all-passing report', () => {
		const report = validateDesktopPackagingPipeline(repoRoot);
		expect(report.valid).toBe(true);
		expect(report.errors).toEqual([]);
	});

	it('FAILS when a declared woff2 is missing from public/fonts', () => {
		const root = scratchRoot();
		mkdirSync(join(root, 'packages/web/src/styles'), { recursive: true });
		mkdirSync(join(root, 'packages/web/public/fonts'), { recursive: true });
		writeFileSync(
			join(root, 'packages/web/src/styles/fonts.css'),
			'@font-face { font-weight: 400; src: url("./fonts/commit-mono-latin-400.woff2"); }\n',
		);
		writeFileSync(
			join(root, 'packages/web/src/styles/tokens.css'),
			':root { --font-mono: "Commit Mono", ui-monospace, monospace; }\n',
		);
		writeFileSync(join(root, 'packages/web/src/styles/base.css'), '.mono-col { width: 12ch; }\n');
		const result = validateFontFallbackAndChMetrics(root);
		expect(result.valid).toBe(false);
		expect(result.errors.some((err) => err.includes('commit-mono-latin-400.woff2'))).toBe(true);
	});

	it('FAILS when a declared woff2 is only a placeholder stub (E-176)', () => {
		const root = scratchRoot();
		mkdirSync(join(root, 'packages/web/src/styles'), { recursive: true });
		mkdirSync(join(root, 'packages/web/public/fonts'), { recursive: true });
		writeFileSync(
			join(root, 'packages/web/src/styles/fonts.css'),
			'@font-face { font-weight: 400; src: url("./fonts/commit-mono-latin-400.woff2"); }\n',
		);
		writeFileSync(
			join(root, 'packages/web/src/styles/tokens.css'),
			':root { --font-mono: "Commit Mono", ui-monospace, monospace; }\n',
		);
		writeFileSync(join(root, 'packages/web/src/styles/base.css'), '.mono-col { width: 12ch; }\n');
		// Header-only woff2: correct signature, 620 bytes of "sfnt", zero glyph outlines.
		const stub = Buffer.alloc(288);
		stub.write('wOF2', 0, 'ascii');
		stub.writeUInt32BE(288, 8);
		stub.writeUInt32BE(620, 16);
		writeFileSync(join(root, 'packages/web/public/fonts/commit-mono-latin-400.woff2'), stub);
		const result = validateFontFallbackAndChMetrics(root);
		expect(result.valid).toBe(false);
		expect(result.errors.some((err) => err.includes('placeholder font'))).toBe(true);
	});

	it("FAILS when vite base is '/'", () => {
		const root = scratchRoot();
		mkdirSync(join(root, 'packages/web'), { recursive: true });
		writeFileSync(join(root, 'packages/web/vite.config.ts'), "export default { base: '/' }\n");
		const result = validateRelativeBasePath(root);
		expect(result.valid).toBe(false);
		expect(result.errors.some((err) => err.includes("base: './'"))).toBe(true);
	});

	it('FAILS when daemon static root is not packages/web/dist', () => {
		const root = scratchRoot();
		mkdirSync(join(root, 'packages/daemon/src/http/plugins'), { recursive: true });
		mkdirSync(join(root, 'packages/shell-desktop/src-tauri'), { recursive: true });
		mkdirSync(join(root, 'packages/shell-mobile'), { recursive: true });
		writeFileSync(
			join(root, 'packages/shell-desktop/src-tauri/tauri.conf.json'),
			JSON.stringify({ build: { frontendDist: '../../web/dist' } }),
		);
		writeFileSync(
			join(root, 'packages/shell-mobile/capacitor.config.ts'),
			"export default { webDir: '../web/dist' }\n",
		);
		writeFileSync(
			join(root, 'packages/daemon/src/http/plugins/80-static.ts'),
			"import fastifyStatic from '@fastify/static';\nexport const staticPlugin = async () => {};\n",
		);
		const result = validateSingleBuildConsumption(root);
		expect(result.valid).toBe(false);
		expect(result.errors.some((err) => err.includes('packages/web/dist'))).toBe(true);
	});
});
