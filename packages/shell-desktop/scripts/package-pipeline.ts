#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDesktopPackagingPipeline } from '../src/packaging-pipeline.ts';

const scriptDir =
	typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');

console.log('=== Desktop Shell Shared Packaging Pipeline Validation ===\n');

const report = validateDesktopPackagingPipeline(repoRoot);

console.log(
	`[1] Single build consumption (AC 2)           : ${report.details.singleBuildConsumption ? 'PASS ✓' : 'FAIL ✗'}`,
);
console.log(
	`[2] Relative base path base: './' (AC 3)       : ${report.details.relativeBasePath ? 'PASS ✓' : 'FAIL ✗'}`,
);
console.log(
	`[3] No external CDN links (AC 4, E-175)        : ${report.details.noExternalCdn ? 'PASS ✓' : 'FAIL ✗'}`,
);
console.log(
	`[4] Font fallback ui-monospace & ch (AC 5)    : ${report.details.fontFallbackAndChMetrics ? 'PASS ✓' : 'FAIL ✗'}`,
);
console.log(
	`[5] Font weights restricted (AC 6, E-176)      : ${report.details.fontWeightsRestricted ? 'PASS ✓' : 'FAIL ✗'}`,
);

if (report.valid) {
	console.log('\nAll packaging pipeline checks passed successfully! ✓');
	process.exit(0);
} else {
	console.error('\nPackaging pipeline validation failed with errors:');
	for (const err of report.errors) {
		console.error(`  - ${err}`);
	}
	process.exit(1);
}
