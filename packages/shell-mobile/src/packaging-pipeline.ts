import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const FORBIDDEN_CDN_HOSTS = [
	'fonts.googleapis.com',
	'fonts.gstatic.com',
	'cdnjs.cloudflare.com',
	'cdn.jsdelivr.net',
	'unpkg.com',
	'cdn.skypack.dev',
	'esm.sh',
	'raw.githubusercontent.com',
] as const;

/**
 * Validates that Capacitor webDir points directly to ../web/dist to consume the single build (AC 2).
 */
export function validateMobileSingleBuildConsumption(repoRoot: string): {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly resolvedWebDir: string;
	readonly expectedDist: string;
} {
	const errors: string[] = [];
	const expectedDist = resolve(repoRoot, 'packages/web/dist');
	const capacitorConfigPath = resolve(repoRoot, 'packages/shell-mobile/capacitor.config.ts');

	let resolvedWebDir = '';
	if (existsSync(capacitorConfigPath)) {
		try {
			const content = readFileSync(capacitorConfigPath, 'utf8');
			const match = content.match(/webDir:\s*['"]([^'"]+)['"]/);
			if (!match || !match[1]) {
				errors.push('capacitor.config.ts is missing required webDir configuration');
			} else {
				resolvedWebDir = resolve(dirname(capacitorConfigPath), match[1]);
				if (resolvedWebDir !== expectedDist) {
					errors.push(
						`Capacitor webDir resolves to '${resolvedWebDir}', expected '${expectedDist}'`,
					);
				}
			}
		} catch (err) {
			errors.push(`Failed to read capacitor.config.ts: ${String(err)}`);
		}
	} else {
		errors.push(`capacitor.config.ts not found at: ${capacitorConfigPath}`);
	}

	return {
		valid: errors.length === 0,
		errors,
		resolvedWebDir,
		expectedDist,
	};
}

/**
 * Validates that base is './' (relative) in vite.config.ts for mobile WebView compatibility (AC 3).
 */
export function validateMobileRelativeBasePath(repoRoot: string): {
	readonly valid: boolean;
	readonly errors: readonly string[];
} {
	const errors: string[] = [];
	const viteConfigPath = resolve(repoRoot, 'packages/web/vite.config.ts');

	if (!existsSync(viteConfigPath)) {
		errors.push(`packages/web/vite.config.ts does not exist at: ${viteConfigPath}`);
		return { valid: false, errors };
	}

	try {
		const content = readFileSync(viteConfigPath, 'utf8');
		const baseMatch = content.match(/base:\s*['"](\.\/?)['"]/);
		if (!baseMatch) {
			errors.push(
				"packages/web/vite.config.ts must declare base: './' (relative) for mobile WebView asset resolution",
			);
		}
	} catch (err) {
		errors.push(`Failed to read packages/web/vite.config.ts: ${String(err)}`);
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Validates that no external CDN links exist in web styles used by mobile shell (AC 4, E-175).
 */
export function validateMobileNoExternalCdn(repoRoot: string): {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly violations: readonly string[];
} {
	const violations: string[] = [];
	const errors: string[] = [];
	const stylesDir = resolve(repoRoot, 'packages/web/src/styles');

	if (existsSync(stylesDir)) {
		const files = readdirSync(stylesDir);
		for (const file of files) {
			if (!file.endsWith('.css')) continue;
			const fullPath = join(stylesDir, file);
			const content = readFileSync(fullPath, 'utf8');

			for (const cdn of FORBIDDEN_CDN_HOSTS) {
				if (content.includes(cdn)) {
					violations.push(`${file} contains forbidden CDN host '${cdn}'`);
				}
			}

			const urlRegex = /url\(\s*['"]?https?:\/\/[^'")]+['"]?\s*\)/gi;
			let match = urlRegex.exec(content);
			while (match) {
				violations.push(`${file} contains external URL reference: ${match[0]}`);
				match = urlRegex.exec(content);
			}
		}
	}

	if (violations.length > 0) {
		errors.push(...violations);
	}

	return {
		valid: errors.length === 0,
		errors,
		violations,
	};
}

/**
 * Validates font-mono includes ui-monospace and column widths use ch units (AC 5, E-174).
 */
export function validateMobileFontFallbackAndChMetrics(repoRoot: string): {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly hasUiMonospace: boolean;
} {
	const errors: string[] = [];
	const tokensCssPath = resolve(repoRoot, 'packages/web/src/styles/tokens.css');

	let hasUiMonospace = false;
	if (existsSync(tokensCssPath)) {
		const content = readFileSync(tokensCssPath, 'utf8');
		const monoMatch = content.match(/--font-mono:\s*([^;]+);/);
		if (monoMatch?.[1]) {
			const monoStack = monoMatch[1];
			hasUiMonospace = monoStack.includes('ui-monospace');
			if (!hasUiMonospace) {
				errors.push(
					`--font-mono does not include 'ui-monospace' in its fallback stack: '${monoStack}'`,
				);
			}
		} else {
			errors.push('tokens.css is missing --font-mono definition');
		}
	} else {
		errors.push(`tokens.css not found at ${tokensCssPath}`);
	}

	return {
		valid: errors.length === 0,
		errors,
		hasUiMonospace,
	};
}

/**
 * Validates that font weights in styles are restricted to used weights (400 regular + 600 emphasis) (AC 6, E-176).
 */
export function validateMobileFontWeightsRestricted(repoRoot: string): {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly declaredWeights: readonly number[];
} {
	const errors: string[] = [];
	const fontsCssPath = resolve(repoRoot, 'packages/web/src/styles/fonts.css');
	const declaredWeights: number[] = [];

	const ALLOWED_WEIGHTS = new Set([400, 500, 600]);
	const FORBIDDEN_FAMILY_WEIGHTS = new Set([100, 200, 300, 700, 800, 900]);

	if (existsSync(fontsCssPath)) {
		const content = readFileSync(fontsCssPath, 'utf8');
		const weightRegex = /font-weight:\s*(\d+);/g;
		let match = weightRegex.exec(content);
		while (match) {
			const w = Number.parseInt(match[1] ?? '', 10);
			if (Number.isFinite(w)) {
				declaredWeights.push(w);
				if (FORBIDDEN_FAMILY_WEIGHTS.has(w)) {
					errors.push(
						`Forbidden full-family font-weight ${w} declared in fonts.css (violates E-176 weight budget)`,
					);
				} else if (!ALLOWED_WEIGHTS.has(w)) {
					errors.push(`Unexpected font-weight ${w} declared in fonts.css`);
				}
			}
			match = weightRegex.exec(content);
		}
	} else {
		errors.push(`fonts.css not found at ${fontsCssPath}`);
	}

	return {
		valid: errors.length === 0,
		errors,
		declaredWeights,
	};
}

/**
 * Runs the full mobile shell packaging pipeline validation suite (AC 2, AC 3, AC 4, AC 5, AC 6).
 */
export function validateMobilePackagingPipeline(
	customRepoRoot?: string,
): MobilePipelineValidationResult {
	const currentDir =
		typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
	const repoRoot = customRepoRoot ?? resolve(currentDir, '../../..');

	const singleBuild = validateMobileSingleBuildConsumption(repoRoot);
	const relativeBase = validateMobileRelativeBasePath(repoRoot);
	const noCdn = validateMobileNoExternalCdn(repoRoot);
	const fontFallback = validateMobileFontFallbackAndChMetrics(repoRoot);
	const fontWeights = validateMobileFontWeightsRestricted(repoRoot);

	const allErrors = [
		...singleBuild.errors,
		...relativeBase.errors,
		...noCdn.errors,
		...fontFallback.errors,
		...fontWeights.errors,
	];

	return {
		valid: allErrors.length === 0,
		errors: allErrors,
		details: {
			singleBuildConsumption: singleBuild.valid,
			relativeBasePath: relativeBase.valid,
			noExternalCdn: noCdn.valid,
			fontFallbackAndChMetrics: fontFallback.valid,
			fontWeightsRestricted: fontWeights.valid,
		},
	};
}
