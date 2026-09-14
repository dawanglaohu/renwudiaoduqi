import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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

describe('Shared Packaging Pipeline Validation (AC 2-6, E-174..E-176)', () => {
	it('AC 2: daemon static, Tauri frontendDist, and Capacitor webDir consume the exact same build directory', () => {
		const result = validateSingleBuildConsumption(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);

		const expectedCanonical = resolve(repoRoot, 'packages/web/dist');
		expect(result.paths.tauriDist).toBe(expectedCanonical);
		expect(result.paths.capacitorWebDir).toBe(expectedCanonical);
		expect(result.paths.expectedCanonicalDist).toBe(expectedCanonical);
	});

	it("AC 3: packages/web/vite.config.ts configures base: './' for multi-host relative asset loading", () => {
		const result = validateRelativeBasePath(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('AC 4 & E-175: zero external CDN links or external font references in web styles', () => {
		const result = validateNoExternalCdn(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.violations).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it('AC 5 & E-174: font-mono includes ui-monospace in fallback stack and column widths use ch units', () => {
		const result = validateFontFallbackAndChMetrics(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.hasUiMonospace).toBe(true);
		expect(result.errors).toEqual([]);

		// Verify ch column width computation prevents layout collapse when font metric varies
		const colWidth10 = calculateMonospaceColumnWidth(10);
		expect(colWidth10).toBe('12ch');
		const colWidth30 = calculateMonospaceColumnWidth(30, 4);
		expect(colWidth30).toBe('34ch');
	});

	it('AC 6 & E-176: font weights are restricted to used weights (400, 600) and reject full family variants', () => {
		const result = validateFontWeightsRestricted(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);

		// Prohibits full family variants like 100, 200, 300, 700, 800, 900
		for (const w of result.declaredWeights) {
			expect([400, 500, 600]).toContain(w);
			expect([100, 200, 300, 700, 800, 900]).not.toContain(w);
		}
	});

	it('runs the full desktop packaging pipeline validator and produces all-passing report', () => {
		const report = validateDesktopPackagingPipeline(repoRoot);
		expect(report.valid).toBe(true);
		expect(report.errors).toEqual([]);
		expect(report.details.singleBuildConsumption).toBe(true);
		expect(report.details.relativeBasePath).toBe(true);
		expect(report.details.noExternalCdn).toBe(true);
		expect(report.details.fontFallbackAndChMetrics).toBe(true);
		expect(report.details.fontWeightsRestricted).toBe(true);
	});
});
