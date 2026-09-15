import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	validateDesktopPackagingPipeline,
	validateFontFallbackAndChMetrics,
	validateFontWeightsRestricted,
	validateNoExternalCdn,
	validateRelativeBasePath,
	validateSingleBuildConsumption,
} from '../../shell-desktop/src/packaging-pipeline.ts';

export interface MobilePipelineValidationResult {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly details: {
		readonly singleBuildConsumption: boolean;
		readonly relativeBasePath: boolean;
		readonly noExternalCdn: boolean;
		readonly fontFallbackAndChMetrics: boolean;
		readonly fontWeightsRestricted: boolean;
	};
}

export function validateMobileSingleBuildConsumption(repoRoot: string) {
	const result = validateSingleBuildConsumption(repoRoot);
	return {
		valid: result.valid,
		errors: result.errors,
		resolvedWebDir: result.paths.capacitorWebDir,
		expectedDist: result.paths.expectedCanonicalDist,
		daemonStaticRoot: result.paths.daemonStaticRoot,
	};
}

export function validateMobileRelativeBasePath(repoRoot: string) {
	return validateRelativeBasePath(repoRoot);
}

export function validateMobileNoExternalCdn(repoRoot: string) {
	return validateNoExternalCdn(repoRoot);
}

export function validateMobileFontFallbackAndChMetrics(repoRoot: string) {
	return validateFontFallbackAndChMetrics(repoRoot);
}

export function validateMobileFontWeightsRestricted(repoRoot: string) {
	return validateFontWeightsRestricted(repoRoot);
}

export function validateMobilePackagingPipeline(
	customRepoRoot?: string,
): MobilePipelineValidationResult {
	const currentDir =
		typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
	const repoRoot = customRepoRoot ?? resolve(currentDir, '../../..');
	return validateDesktopPackagingPipeline(repoRoot);
}
