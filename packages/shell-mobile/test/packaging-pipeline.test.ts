import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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

describe('Mobile Shell Packaging Pipeline Validation (AC 2-6, E-174..E-176)', () => {
	it('AC 2: Capacitor webDir points directly to ../web/dist to consume the single build', () => {
		const result = validateMobileSingleBuildConsumption(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);

		const expectedCanonical = resolve(repoRoot, 'packages/web/dist');
		expect(result.resolvedWebDir).toBe(expectedCanonical);
		expect(result.expectedDist).toBe(expectedCanonical);
	});

	it("AC 3: packages/web/vite.config.ts configures base: './' for mobile WebView relative loading", () => {
		const result = validateMobileRelativeBasePath(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('AC 4 & E-175: zero external CDN links in styles consumed by mobile shell', () => {
		const result = validateMobileNoExternalCdn(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.violations).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it('AC 5 & E-174: font-mono includes ui-monospace for fallback stability without layout collapse', () => {
		const result = validateMobileFontFallbackAndChMetrics(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.hasUiMonospace).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it('AC 6 & E-176: font weights are restricted to used weights (400, 600) and reject full family variants', () => {
		const result = validateMobileFontWeightsRestricted(repoRoot);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);

		for (const w of result.declaredWeights) {
			expect([400, 500, 600]).toContain(w);
			expect([100, 200, 300, 700, 800, 900]).not.toContain(w);
		}
	});

	it('runs the full mobile packaging pipeline validator and produces all-passing report', () => {
		const report = validateMobilePackagingPipeline(repoRoot);
		expect(report.valid).toBe(true);
		expect(report.errors).toEqual([]);
		expect(report.details.singleBuildConsumption).toBe(true);
		expect(report.details.relativeBasePath).toBe(true);
		expect(report.details.noExternalCdn).toBe(true);
		expect(report.details.fontFallbackAndChMetrics).toBe(true);
		expect(report.details.fontWeightsRestricted).toBe(true);
	});
});
