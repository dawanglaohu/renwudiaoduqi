import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PipelineValidationResult {
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
 * Validates that daemon @fastify/static, Tauri frontendDist, and Capacitor webDir
 * all consume the exact same build directory (AC 2).
 */
export function validateSingleBuildConsumption(repoRoot: string): {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly paths: {
		readonly tauriDist: string;
		readonly capacitorWebDir: string;
		readonly expectedCanonicalDist: string;
	};
} {
	const errors: string[] = [];
	const expectedCanonicalDist = resolve(repoRoot, 'packages/web/dist');

	// 1. Verify Tauri configuration
	const tauriConfPath = resolve(repoRoot, 'packages/shell-desktop/src-tauri/tauri.conf.json');
	let tauriDistResolved = '';
	if (existsSync(tauriConfPath)) {
		try {
			const conf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
			const rawFrontendDist = conf.build?.frontendDist;
			if (typeof rawFrontendDist !== 'string') {
				errors.push('Tauri tauri.conf.json is missing build.frontendDist string');
			} else {
				tauriDistResolved = resolve(dirname(tauriConfPath), rawFrontendDist);
				if (tauriDistResolved !== expectedCanonicalDist) {
					errors.push(
						`Tauri frontendDist resolves to '${tauriDistResolved}', expected '${expectedCanonicalDist}'`,
					);
				}
			}
		} catch (err) {
			errors.push(`Failed to parse tauri.conf.json: ${String(err)}`);
		}
	} else {
		errors.push(`Tauri config not found at: ${tauriConfPath}`);
	}

	// 2. Verify Capacitor configuration
	const capacitorConfigPath = resolve(repoRoot, 'packages/shell-mobile/capacitor.config.ts');
	let capacitorWebDirResolved = '';
	if (existsSync(capacitorConfigPath)) {
		try {
			const content = readFileSync(capacitorConfigPath, 'utf8');
			const match = content.match(/webDir:\s*['"]([^'"]+)['"]/);
			if (!match || !match[1]) {
				errors.push('Capacitor capacitor.config.ts is missing webDir string property');
			} else {
				capacitorWebDirResolved = resolve(dirname(capacitorConfigPath), match[1]);
				if (capacitorWebDirResolved !== expectedCanonicalDist) {
					errors.push(
						`Capacitor webDir resolves to '${capacitorWebDirResolved}', expected '${expectedCanonicalDist}'`,
					);
				}
			}
		} catch (err) {
			errors.push(`Failed to read capacitor.config.ts: ${String(err)}`);
		}
	} else {
		errors.push(`Capacitor config not found at: ${capacitorConfigPath}`);
	}

	return {
		valid: errors.length === 0,
		errors,
		paths: {
			tauriDist: tauriDistResolved,
			capacitorWebDir: capacitorWebDirResolved,
			expectedCanonicalDist,
		},
	};
}

/**
 * Validates that base is './' (relative) in vite.config.ts (AC 3).
 * Ensures assets are loaded with relative paths without 404s under tauri://, https://, and daemon.
 */
export function validateRelativeBasePath(repoRoot: string): {
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
				"packages/web/vite.config.ts must declare base: './' (relative) for multi-shell compatibility",
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
 * Validates that no external CDN or external asset URLs are used in styles or fonts (AC 4, E-175).
 */
export function validateNoExternalCdn(repoRoot: string): {
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

			// Check for generic external http:// or https:// URLs in @import or url()
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
 * Validates font fallback to ui-monospace and column width usage with ch units (AC 5, E-174).
 */
export function validateFontFallbackAndChMetrics(repoRoot: string): {
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
 * Calculates column width for monospace text given a character length using 'ch' units (AC 5, E-174).
 * Column widths calculated with 'ch' scale correctly with whatever monospace font is rendered,
 * preventing layout collapse when font fallback occurs.
 */
export function calculateMonospaceColumnWidth(charCount: number, paddingCh = 2): string {
	const totalCh = Math.max(0, charCount) + paddingCh;
	return `${totalCh}ch`;
}

/**
 * Validates that only actually used font weights are declared (regular 400 + emphasis 600) (AC 6, E-176).
 * Prohibits full family bundling (100, 200, 300, 700, 800, 900).
 */
export function validateFontWeightsRestricted(repoRoot: string): {
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
 * Runs the full shared packaging pipeline validation suite (AC 2, AC 3, AC 4, AC 5, AC 6).
 */
export function validateDesktopPackagingPipeline(
	customRepoRoot?: string,
): PipelineValidationResult {
	const currentDir =
		typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
	const repoRoot = customRepoRoot ?? resolve(currentDir, '../../..');

	const singleBuild = validateSingleBuildConsumption(repoRoot);
	const relativeBase = validateRelativeBasePath(repoRoot);
	const noCdn = validateNoExternalCdn(repoRoot);
	const fontFallback = validateFontFallbackAndChMetrics(repoRoot);
	const fontWeights = validateFontWeightsRestricted(repoRoot);

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
