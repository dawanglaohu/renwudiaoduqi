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

export interface SingleBuildPaths {
	readonly tauriDist: string;
	readonly capacitorWebDir: string;
	readonly daemonStaticRoot: string;
	readonly expectedCanonicalDist: string;
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

function walkFiles(dir: string, filter?: (file: string) => boolean): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkFiles(full, filter));
		} else if (!filter || filter(full)) {
			out.push(full);
		}
	}
	return out;
}

function extractDeclaredFontFiles(fontsCss: string): string[] {
	const files: string[] = [];
	const regex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
	let match = regex.exec(fontsCss);
	while (match) {
		const raw = match[1] ?? '';
		const basename = raw.split('/').pop() ?? '';
		if (basename.endsWith('.woff2')) {
			files.push(basename);
		}
		match = regex.exec(fontsCss);
	}
	return files;
}

/**
 * Validates that daemon @fastify/static, Tauri frontendDist, and Capacitor webDir
 * all consume packages/web/dist (AC 2).
 */
export function validateSingleBuildConsumption(repoRoot: string): {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly paths: SingleBuildPaths;
} {
	const errors: string[] = [];
	const expectedCanonicalDist = resolve(repoRoot, 'packages/web/dist');

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

	const capacitorConfigPath = resolve(repoRoot, 'packages/shell-mobile/capacitor.config.ts');
	let capacitorWebDirResolved = '';
	if (existsSync(capacitorConfigPath)) {
		try {
			const content = readFileSync(capacitorConfigPath, 'utf8');
			const match = content.match(/webDir:\s*['"]([^'"]+)['"]/);
			if (!match?.[1]) {
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

	const staticPluginPath = resolve(repoRoot, 'packages/daemon/src/http/plugins/80-static.ts');
	let daemonStaticRoot = '';
	if (!existsSync(staticPluginPath)) {
		errors.push(`daemon static plugin not found at: ${staticPluginPath}`);
	} else {
		const staticSource = readFileSync(staticPluginPath, 'utf8');
		if (!staticSource.includes("resolve(currentDir, '../../../../web/dist')")) {
			errors.push(
				'daemon 80-static.ts source layout must resolve to packages/web/dist from plugins/',
			);
		}
		if (!staticSource.includes('@fastify/static')) {
			errors.push('daemon 80-static.ts must register @fastify/static');
		}
		if (!staticSource.includes('throw new Error')) {
			errors.push('daemon 80-static.ts must throw when web dist is missing');
		}
		daemonStaticRoot = expectedCanonicalDist;
		if (!existsSync(expectedCanonicalDist)) {
			errors.push(`web dist missing at ${expectedCanonicalDist}; execute vite build first`);
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		paths: {
			tauriDist: tauriDistResolved,
			capacitorWebDir: capacitorWebDirResolved,
			daemonStaticRoot,
			expectedCanonicalDist,
		},
	};
}

export function validateRelativeBasePath(repoRoot: string): {
	readonly valid: boolean;
	readonly errors: readonly string[];
} {
	const errors: string[] = [];
	const viteConfigPath = resolve(repoRoot, 'packages/web/vite.config.ts');
	const distDir = resolve(repoRoot, 'packages/web/dist');

	if (!existsSync(viteConfigPath)) {
		errors.push(`packages/web/vite.config.ts does not exist at: ${viteConfigPath}`);
		return { valid: false, errors };
	}

	const content = readFileSync(viteConfigPath, 'utf8');
	const baseMatch = content.match(/base:\s*['"](\.\/?)['"]/);
	if (!baseMatch) {
		errors.push(
			"packages/web/vite.config.ts must declare base: './' (relative) for multi-shell compatibility",
		);
	}

	if (existsSync(distDir)) {
		const cssFiles = walkFiles(join(distDir, 'assets'), (f) => f.endsWith('.css'));
		for (const cssFile of cssFiles) {
			const css = readFileSync(cssFile, 'utf8');
			if (/url\(\s*['"]?\/(?!\/)/.test(css)) {
				errors.push(`${cssFile} contains absolute url(/…) after build; base must stay './'`);
			}
		}
		const indexHtml = join(distDir, 'index.html');
		if (existsSync(indexHtml)) {
			const html = readFileSync(indexHtml, 'utf8');
			if (/src="\/assets\//.test(html) || /href="\/assets\//.test(html)) {
				errors.push('dist/index.html uses absolute /assets/ paths');
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

export function validateNoExternalCdn(repoRoot: string): {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly violations: readonly string[];
} {
	const violations: string[] = [];
	const errors: string[] = [];
	const scanRoots = [
		resolve(repoRoot, 'packages/web/src'),
		resolve(repoRoot, 'packages/web/index.html'),
		resolve(repoRoot, 'packages/web/dist'),
	];

	const files: string[] = [];
	for (const root of scanRoots) {
		if (!existsSync(root)) continue;
		if (root.endsWith('.html')) {
			files.push(root);
		} else {
			files.push(...walkFiles(root, (f) => /\.(css|js|html|tsx|ts)$/.test(f)));
		}
	}

	for (const file of files) {
		const content = readFileSync(file, 'utf8');
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
		if (/https?:\/\/fonts\./i.test(content)) {
			violations.push(`${file} contains an external font host`);
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

const WOFF2_SIGNATURE = 'wOF2';
const WOFF2_HEADER_BYTES = 48;

/**
 * A latin subset of a real text face carries tens of KB of sfnt data; a header-only
 * placeholder (empty glyf/cmap, ~600 bytes) is rejected. Coarse on purpose: the check
 * only needs to catch stub binaries that would silently fall back at runtime (E-176).
 */
const MIN_EMBEDDED_SFNT_BYTES = 4096;

function readWoff2Header(filePath: string): {
	readonly fileBytes: number;
	readonly declaredLength: number;
	readonly totalSfntSize: number;
} | null {
	const buffer = readFileSync(filePath);
	if (buffer.length < WOFF2_HEADER_BYTES || buffer.toString('ascii', 0, 4) !== WOFF2_SIGNATURE) {
		return null;
	}
	return {
		fileBytes: buffer.length,
		declaredLength: buffer.readUInt32BE(8),
		totalSfntSize: buffer.readUInt32BE(16),
	};
}

export function validateFontFallbackAndChMetrics(repoRoot: string): {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly hasUiMonospace: boolean;
	readonly hasChColumnWidth: boolean;
} {
	const errors: string[] = [];
	const tokensCssPath = resolve(repoRoot, 'packages/web/src/styles/tokens.css');
	const baseCssPath = resolve(repoRoot, 'packages/web/src/styles/base.css');
	const fontsCssPath = resolve(repoRoot, 'packages/web/src/styles/fonts.css');
	const distDir = resolve(repoRoot, 'packages/web/dist');
	const publicFontsDir = resolve(repoRoot, 'packages/web/public/fonts');

	let hasUiMonospace = false;
	let hasChColumnWidth = false;

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

	if (existsSync(baseCssPath)) {
		const baseCss = readFileSync(baseCssPath, 'utf8');
		hasChColumnWidth = /\b\d+ch\b/.test(baseCss);
		if (!hasChColumnWidth) {
			errors.push('base.css must declare a column width in ch units (E-174)');
		}
	} else {
		errors.push(`base.css not found at ${baseCssPath}`);
	}

	if (!existsSync(fontsCssPath)) {
		errors.push(`fonts.css not found at ${fontsCssPath}`);
	} else {
		const fontsCss = readFileSync(fontsCssPath, 'utf8');
		const declared = extractDeclaredFontFiles(fontsCss);
		if (declared.length === 0) {
			errors.push('fonts.css declares no woff2 files');
		}

		const publicFiles = existsSync(publicFontsDir)
			? readdirSync(publicFontsDir).filter((name) => name.endsWith('.woff2'))
			: [];
		for (const file of declared) {
			if (!publicFiles.includes(file)) {
				errors.push(`declared font ${file} is missing from packages/web/public/fonts`);
				continue;
			}
			const header = readWoff2Header(join(publicFontsDir, file));
			if (!header) {
				errors.push(`${file} is not a woff2 payload (missing 'wOF2' signature)`);
				continue;
			}
			if (header.declaredLength !== header.fileBytes) {
				errors.push(
					`${file} declares ${header.declaredLength} bytes but the file is ${header.fileBytes} bytes`,
				);
			}
			if (header.totalSfntSize < MIN_EMBEDDED_SFNT_BYTES) {
				errors.push(
					`${file} carries only ${header.totalSfntSize} bytes of sfnt data; a real latin subset is tens of KB, so this is a placeholder font (E-176)`,
				);
			}
		}

		const distFontsDir = join(distDir, 'fonts');
		if (existsSync(distFontsDir)) {
			const distFiles = readdirSync(distFontsDir).filter((name) => name.endsWith('.woff2'));
			const declaredSet = new Set(declared);
			const distSet = new Set(distFiles);
			for (const file of declaredSet) {
				if (!distSet.has(file)) {
					errors.push(`declared font ${file} is missing from dist/fonts`);
				}
			}
			for (const file of distSet) {
				if (!declaredSet.has(file)) {
					errors.push(`dist/fonts contains undeclared font ${file}`);
				}
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		hasUiMonospace,
		hasChColumnWidth,
	};
}

export function calculateMonospaceColumnWidth(charCount: number, paddingCh = 2): string {
	const totalCh = Math.max(0, charCount) + paddingCh;
	return `${totalCh}ch`;
}

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
