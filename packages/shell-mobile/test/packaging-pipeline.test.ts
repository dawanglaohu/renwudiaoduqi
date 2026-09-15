import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
	validateMobileFontFallbackAndChMetrics,
	validateMobileFontWeightsRestricted,
	validateMobileNoExternalCdn,
	validateMobilePackagingPipeline,
	validateMobileRelativeBasePath,
	validateMobileSingleBuildConsumption,
} from '../src/packaging-pipeline.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, '../../..');
const scratchDirs: string[] = [];

afterEach(() => {
	for (const dir of scratchDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('Mobile Shell Packaging Pipeline Validation (AC 2-6, E-174..E-176)', () => {
	it('AC 2: Capacitor webDir and daemon static root point to the same dist', () => {
		const result = validateMobileSingleBuildConsumption(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		const expectedCanonical = resolve(repoRoot, 'packages/web/dist');
		expect(result.resolvedWebDir).toBe(expectedCanonical);
		expect(result.expectedDist).toBe(expectedCanonical);
		expect(result.daemonStaticRoot).toBe(expectedCanonical);
	});

	it("AC 3: packages/web/vite.config.ts configures base: './'", () => {
		const result = validateMobileRelativeBasePath(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('AC 4 & E-175: zero external CDN links', () => {
		const result = validateMobileNoExternalCdn(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.violations).toEqual([]);
	});

	it('AC 5 & E-174: font-mono includes ui-monospace and ch column width', () => {
		const result = validateMobileFontFallbackAndChMetrics(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.hasUiMonospace).toBe(true);
		expect(result.hasChColumnWidth).toBe(true);
	});

	it('AC 6 & E-176: font weights are restricted', () => {
		const result = validateMobileFontWeightsRestricted(repoRoot);
		expect(result.valid).toBe(true);
	});

	it('runs the full mobile packaging pipeline validator', () => {
		const report = validateMobilePackagingPipeline(repoRoot);
		expect(report.valid).toBe(true);
		expect(report.errors).toEqual([]);
	});

	it('FAILS when a declared woff2 is missing', () => {
		const root = mkdtempSync(join(tmpdir(), 'agsched-mobile-pipeline-'));
		scratchDirs.push(root);
		mkdirSync(join(root, 'packages/web/src/styles'), { recursive: true });
		mkdirSync(join(root, 'packages/web/public/fonts'), { recursive: true });
		writeFileSync(
			join(root, 'packages/web/src/styles/fonts.css'),
			'@font-face { font-weight: 400; src: url("./fonts/public-sans-latin-400.woff2"); }\n',
		);
		writeFileSync(
			join(root, 'packages/web/src/styles/tokens.css'),
			':root { --font-mono: "Commit Mono", ui-monospace, monospace; }\n',
		);
		writeFileSync(join(root, 'packages/web/src/styles/base.css'), '.mono-col { width: 12ch; }\n');
		const result = validateMobileFontFallbackAndChMetrics(root);
		expect(result.valid).toBe(false);
	});
});
