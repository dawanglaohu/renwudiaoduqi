import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ForbiddenViolation {
	rule: string;
	file: string;
	line?: number;
	snippet?: string;
	message: string;
}

export interface CheckForbiddenReport {
	passed: boolean;
	violations: ForbiddenViolation[];
}

const INDIGO_VIOLET_HEXES = ['#6366f1', '#5e6ad2', '#635bff', '#7c3aed'];

/** Build configs that alias tokens for Tailwind and PostCSS and may declare none (M9-T24, E-159). */
const BUILD_CONFIG_FILE_NAMES = ['tailwind.config.ts', 'postcss.config.cjs'] as const;

const GENERIC_FONT_FAMILY_REGEX =
	/\b(?:sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|cursive|fantasy|emoji|fangsong)\b/g;
const STRING_LITERAL_REGEX = /'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g;
const TOKEN_ALIAS_REGEX = /^var\(--[\w-]+\)$/;

/** Blanks comment bodies with spaces (string literals kept) so line numbers survive the scan. */
function blankComments(source: string): string {
	return source.replace(
		/('[^'\n]*'|"[^"\n]*"|`[^`\n]*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
		(match, literal?: string) => literal ?? match.replace(/[^\n]/g, ' '),
	);
}

/**
 * Line numbers of font stacks in a build config (M9-T24, E-159). A generic family keyword
 * anywhere, or a `fontFamily` entry that is not a `var(--…)` alias, both count: typefaces are
 * declared in tokens.css and reach Tailwind only through that alias.
 */
export function findFontStacks(source: string): number[] {
	const code = blankComments(source);
	const lineOf = (index: number): number => code.slice(0, index).split('\n').length;
	const lines = new Set<number>();
	for (const match of code.matchAll(GENERIC_FONT_FAMILY_REGEX)) {
		lines.add(lineOf(match.index ?? 0));
	}
	for (const block of code.matchAll(/\bfontFamily\s*:\s*\{([^}]*)\}/g)) {
		const bodyStart = (block.index ?? 0) + block[0].indexOf('{') + 1;
		for (const literal of (block[1] ?? '').matchAll(STRING_LITERAL_REGEX)) {
			if (!TOKEN_ALIAS_REGEX.test(literal[0].slice(1, -1))) {
				lines.add(lineOf(bodyStart + (literal.index ?? 0)));
			}
		}
	}
	return [...lines].sort((a, b) => a - b);
}

/**
 * Line numbers of `html` / `:root` rule blocks that lock the root font size (E-15).
 * Matching has to cover the whole declaration block: the formatter puts the declaration on its
 * own line, so a per-line scan misses exactly the shape a hand-written lock takes.
 * `font-size: 100%` stays allowed — it preserves the user's own root size.
 */
export function findRootFontSizeLocks(cssContent: string): number[] {
	const withoutComments = cssContent.replace(/\/\*[\s\S]*?\*\//g, '');
	const lines: number[] = [];
	const blockRegex = /([^{}]*)\{([^{}]*)\}/g;
	let block = blockRegex.exec(withoutComments);
	while (block) {
		const selector = block[1] ?? '';
		const body = block[2] ?? '';
		const targetsRoot = /(^|[\s,])(html|:root)\s*(,|$)/.test(selector);
		const declared = /font-size\s*:\s*([^;}]+)/i.exec(body)?.[1];
		const locksFontSize = declared !== undefined && !/^100\s*%$/.test(declared.trim());
		if (targetsRoot && locksFontSize) {
			lines.push(withoutComments.slice(0, block.index).split('\n').length);
		}
		block = blockRegex.exec(withoutComments);
	}
	return lines;
}

/**
 * The run deck wraps its lanes onto more rows (auto-fill grid) and never scrolls sideways,
 * on the desktop window or on a narrow phone (E-145, E-164).
 */
export function isDeckContainer(relativePath: string): boolean {
	const normalized = relativePath.split('\\').join('/');
	return (
		normalized.includes('/src/features/run-deck/') ||
		normalized.endsWith('/src/components/stream-column.tsx')
	);
}

function walkFiles(dir: string, filter?: (path: string) => boolean): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	const results: string[] = [];
	const entries = readdirSync(dir);
	for (const entry of entries) {
		if (entry === 'node_modules' || entry === 'dist' || entry === '.git') {
			continue;
		}
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			results.push(...walkFiles(fullPath, filter));
		} else if (!filter || filter(fullPath)) {
			results.push(fullPath);
		}
	}
	return results;
}

export function runForbiddenCheck(
	projectRootPath?: string,
	webDirPath?: string,
): CheckForbiddenReport {
	const scriptDir =
		typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
	const webDir = webDirPath ?? resolve(scriptDir, '..');
	const rootDir = projectRootPath ?? resolve(webDir, '../..');

	const violations: ForbiddenViolation[] = [];

	// 1. Check for .env files anywhere in repo and packages/web
	const envFiles = [
		join(rootDir, '.env'),
		join(rootDir, '.env.example'),
		join(rootDir, '.env.local'),
		join(rootDir, '.env.production'),
		join(rootDir, '.env.development'),
		join(webDir, '.env'),
		join(webDir, '.env.example'),
		join(webDir, '.env.local'),
	];
	for (const envFile of envFiles) {
		if (existsSync(envFile)) {
			violations.push({
				rule: 'NO_ENV_FILES',
				file: relative(rootDir, envFile),
				message:
					'Environment files (.env, .env.example, etc.) are strictly forbidden in repository.',
			});
		}
	}

	// 2. Check for any index.ts / index.tsx in packages/web
	const allWebFiles = walkFiles(webDir);
	for (const file of allWebFiles) {
		const parts = file.split(/[\\/]/);
		const base = parts[parts.length - 1];
		if (base === 'index.ts' || base === 'index.tsx') {
			violations.push({
				rule: 'NO_INDEX_FILES',
				file: relative(rootDir, file),
				message: 'No barrel index.ts or index.tsx is allowed anywhere in packages/web.',
			});
		}
	}

	// 3. Scan packages/web source files for forbidden patterns
	const srcDir = existsSync(join(webDir, 'src')) ? join(webDir, 'src') : webDir;
	const webSourceFiles = walkFiles(srcDir, (f) => /\.(ts|tsx|css|js|jsx)$/.test(f));
	// Both build configs go through the same colour rules as src/ (M9-T24)
	const buildConfigFiles = BUILD_CONFIG_FILE_NAMES.map((name) => join(webDir, name)).filter(
		(file) => existsSync(file),
	);
	webSourceFiles.push(...buildConfigFiles);

	const tokensCssPath = resolve(webDir, 'src/styles/tokens.css');

	// Color literal regexes (matching standalone hex, rgb, rgba, hsl, hsla)
	const HEX_COLOR_REGEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
	const FUNCTIONAL_COLOR_REGEX = /\b(?:rgb|rgba|hsl|hsla)\([^)]+\)/g;

	for (const file of webSourceFiles) {
		const content = readFileSync(file, 'utf8');
		const lines = content.split('\n');
		const relPath = relative(rootDir, file);
		const isTokensCss = resolve(file) === tokensCssPath;

		// Check 1: Indigo/violet hex literals (check across ALL files)
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? '';
			const lowerLine = line.toLowerCase();
			for (const forbiddenHex of INDIGO_VIOLET_HEXES) {
				if (lowerLine.includes(forbiddenHex)) {
					violations.push({
						rule: 'FORBIDDEN_VIOLET_INDIGO',
						file: relPath,
						line: i + 1,
						snippet: line.trim(),
						message: `Forbidden indigo/violet color ${forbiddenHex} detected.`,
					});
				}
			}
		}

		// Check 2: Color literals in non-tokens.css files (AC 1, E-170)
		if (!isTokensCss) {
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? '';
				// Skip comments and imports
				const stripped = line.replace(/\/\*.*?\*\/|\/\/.*/g, '');

				const hexMatches = stripped.match(HEX_COLOR_REGEX);
				if (hexMatches) {
					for (const match of hexMatches) {
						violations.push({
							rule: 'COLOR_LITERAL_OUTSIDE_TOKENS_CSS',
							file: relPath,
							line: i + 1,
							snippet: line.trim(),
							message: `Color literal '${match}' found outside tokens.css. All colors must be CSS variables from tokens.css.`,
						});
					}
				}

				const funcMatches = stripped.match(FUNCTIONAL_COLOR_REGEX);
				if (funcMatches) {
					for (const match of funcMatches) {
						violations.push({
							rule: 'COLOR_LITERAL_OUTSIDE_TOKENS_CSS',
							file: relPath,
							line: i + 1,
							snippet: line.trim(),
							message: `Color function '${match}' found outside tokens.css. All colors must be CSS variables from tokens.css.`,
						});
					}
				}
			}
		} else {
			// Inside tokens.css: ensure colors only appear inside :root or [data-theme] blocks
			const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');
			const blockRegex = /([^{]+)\{([^}]+)\}/g;
			let blockMatch = blockRegex.exec(stripped);
			while (blockMatch) {
				const selector = blockMatch[1]?.trim() ?? '';
				const body = blockMatch[2] ?? '';
				const isAllowedBlock = selector.includes(':root') || selector.includes('[data-theme');
				if (!isAllowedBlock) {
					const hexes = body.match(HEX_COLOR_REGEX);
					const funcs = body.match(FUNCTIONAL_COLOR_REGEX);
					if (hexes || funcs) {
						violations.push({
							rule: 'COLOR_LITERAL_INVALID_BLOCK',
							file: relPath,
							snippet: selector,
							message: `Color literals in tokens.css are only permitted inside :root or [data-theme] blocks, but found in '${selector}'.`,
						});
					}
				}
				blockMatch = blockRegex.exec(stripped);
			}
		}

		// Check 3: fetch( outside src/api/
		const isApiFile = file.includes('/src/api/') || file.includes('\\src\\api\\');
		if (!isApiFile) {
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? '';
				if (/\bfetch\s*\(/.test(line)) {
					violations.push({
						rule: 'FETCH_OUTSIDE_API',
						file: relPath,
						line: i + 1,
						snippet: line.trim(),
						message: 'fetch() calls are strictly prohibited outside packages/web/src/api/.',
					});
				}
			}
		}

		// Check 4: @radix-ui outside src/ui/
		const isUiFile = file.includes('/src/ui/') || file.includes('\\src\\ui\\');
		if (!isUiFile) {
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? '';
				if (line.includes('@radix-ui/')) {
					violations.push({
						rule: 'RADIX_OUTSIDE_UI',
						file: relPath,
						line: i + 1,
						snippet: line.trim(),
						message: '@radix-ui/* imports are strictly prohibited outside packages/web/src/ui/.',
					});
				}
			}
		}

		// Check 5: Shell internals outside src/shell/
		const isShellFile = file.includes('/src/shell/') || file.includes('\\src\\shell\\');
		if (!isShellFile) {
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? '';
				if (
					line.includes('__TAURI_INTERNALS__') ||
					line.includes('window.__TAURI__') ||
					line.includes('window.Capacitor')
				) {
					violations.push({
						rule: 'SHELL_INTERNALS_OUTSIDE_SHELL',
						file: relPath,
						line: i + 1,
						snippet: line.trim(),
						message:
							'Direct access to Tauri or Capacitor internals is prohibited outside packages/web/src/shell/.',
					});
				}
			}
		}

		// Check 6: Horizontal scrolling on the run deck (E-145)
		if (isDeckContainer(relPath)) {
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? '';
				if (/overflow-x/.test(line)) {
					violations.push({
						rule: 'DECK_OVERFLOW_X',
						file: relPath,
						line: i + 1,
						snippet: line.trim(),
						message:
							'Horizontal scrolling on the run deck is prohibited; lanes wrap instead (E-145).',
					});
				}
			}
		}

		// Check 7: Fixed font-size / text-size-adjust: none / zoom on html (E-15)
		if (file.endsWith('.css')) {
			for (const line of findRootFontSizeLocks(content)) {
				violations.push({
					rule: 'E15_ROOT_FONT_SIZE_LOCKED',
					file: relPath,
					line,
					message:
						'Fixed font-size on the html root is prohibited (violates E-15 system font-size scaling).',
				});
			}
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? '';
				const stripped = line.replace(/\/\*.*?\*\/|\/\/.*/g, '');
				if (/text-size-adjust\s*:\s*none/i.test(stripped)) {
					violations.push({
						rule: 'E15_TEXT_SIZE_ADJUST_NONE',
						file: relPath,
						line: i + 1,
						snippet: line.trim(),
						message: 'text-size-adjust: none is prohibited (violates E-15).',
					});
				}
				if (/\bzoom\s*:\s*[^;]+/i.test(stripped) && !stripped.includes('var(')) {
					violations.push({
						rule: 'E15_ZOOM_PROHIBITED',
						file: relPath,
						line: i + 1,
						snippet: line.trim(),
						message: 'CSS zoom property is prohibited (violates E-15).',
					});
				}
			}
		}

		// Check 8: Font stacks in the build configs (M9-T24, E-159)
		if (buildConfigFiles.includes(file)) {
			for (const line of findFontStacks(content)) {
				violations.push({
					rule: 'FONT_STACK_IN_BUILD_CONFIG',
					file: relPath,
					line,
					snippet: lines[line - 1]?.trim(),
					message:
						'Font stacks live in src/styles/tokens.css only; tailwind.config.ts and postcss.config.cjs must alias var(--font-*) (E-159).',
				});
			}
		}

		// Check 9: @keyframes must only appear in base.css and nowhere else (AC 3, E-282)
		const isBaseCss = resolve(file) === resolve(webDir, 'src/styles/base.css');
		if (!isBaseCss) {
			const cleanContent = content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
			const cleanLines = cleanContent.split('\n');
			for (let i = 0; i < cleanLines.length; i++) {
				const line = cleanLines[i] ?? '';
				const stripped = line.replace(/\/\/.*/g, '');
				if (/@keyframes\b/i.test(stripped)) {
					violations.push({
						rule: 'KEYFRAMES_OUTSIDE_BASE_CSS',
						file: relPath,
						line: i + 1,
						snippet: line.trim(),
						message:
							'@keyframes declarations are strictly prohibited outside packages/web/src/styles/base.css (AC 3, E-282).',
					});
				}
			}
		}

		// Check 10: animation: properties must not appear outside src/styles/ (AC 3, E-282)
		const isStylesFile = file.includes('/src/styles/') || file.includes('\\src\\styles\\');
		if (!isStylesFile) {
			const cleanContent = content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
			const cleanLines = cleanContent.split('\n');
			for (let i = 0; i < cleanLines.length; i++) {
				const line = cleanLines[i] ?? '';
				const stripped = line.replace(/\/\/.*/g, '');
				if (
					/\banimation(?:-[a-z]+)?\s*:/i.test(stripped) ||
					/\banimationDuration\s*:/i.test(stripped) ||
					/\banimationName\s*:/i.test(stripped)
				) {
					violations.push({
						rule: 'ANIMATION_OUTSIDE_STYLES',
						file: relPath,
						line: i + 1,
						snippet: line.trim(),
						message:
							'animation: properties are prohibited outside packages/web/src/styles/. Use CSS classes from styles/ (AC 3, E-282).',
					});
				}
			}
		}

		// Check 12: Stage literal comparison in components/, features/, pages/ (AC 1, E-317)
		const isUiLayer =
			file.includes('/src/components/') ||
			file.includes('\\src\\components\\') ||
			file.includes('/src/features/') ||
			file.includes('\\src\\features\\') ||
			file.includes('/src/pages/') ||
			file.includes('\\src\\pages\\');

		if (isUiLayer) {
			const cleanLines = blankComments(content).split('\n');
			const STAGE_LITERAL_CMP_REGEX =
				/(?:\.stage|currentStage|laneStage|\bstage)\s*(?:===|!==)\s*['"](?:implement|review|bughunt|landing|rework|queued|idle)['"]|['"](?:implement|review|bughunt|landing|rework|queued|idle)['"]\s*(?:===|!==)\s*(?:\.stage|currentStage|laneStage|\bstage)/;
			for (let i = 0; i < cleanLines.length; i++) {
				const line = cleanLines[i] ?? '';
				if (STAGE_LITERAL_CMP_REGEX.test(line)) {
					violations.push({
						rule: 'STAGE_LITERAL_COMPARISON',
						file: relPath,
						line: i + 1,
						snippet: lines[i]?.trim(),
						message:
							'Stage literal comparison is prohibited in UI layer; use pure helpers from lib/stage-rows.ts (AC 1, E-317).',
					});
				}
			}
		}

		// Check 13: Lane number must not enter URL (AC 9, E-324)
		{
			const cleanLines = blankComments(content).split('\n');
			const LANE_IN_URL_REGEX =
				/[?&]lane(?:No)?=|(?:searchParams\.set|searchParams\.append)\s*\(\s*['"](?:lane|laneNo|lane_no)['"]/;
			for (let i = 0; i < cleanLines.length; i++) {
				const line = cleanLines[i] ?? '';
				if (LANE_IN_URL_REGEX.test(line)) {
					violations.push({
						rule: 'LANE_IN_URL',
						file: relPath,
						line: i + 1,
						snippet: lines[i]?.trim(),
						message:
							'Lane number is prohibited from entering URL; current lane must be stored in selection-store in-memory only (AC 9, E-324).',
					});
				}
			}
		}

		// Check 14: Spine and stage-chain must not measure DOM (AC 3, 07 节)
		const isSpineOrStageChain =
			file.endsWith('/spine.tsx') ||
			file.endsWith('\\spine.tsx') ||
			file.endsWith('/stage-chain.tsx') ||
			file.endsWith('\\stage-chain.tsx');

		if (isSpineOrStageChain) {
			const cleanLines = blankComments(content).split('\n');
			const DOM_MEASURE_REGEX =
				/\b(?:getBoundingClientRect|offsetHeight|offsetWidth|clientHeight|clientWidth|scrollHeight|scrollWidth|ResizeObserver|getComputedStyle)\b/;
			for (let i = 0; i < cleanLines.length; i++) {
				const line = cleanLines[i] ?? '';
				if (DOM_MEASURE_REGEX.test(line)) {
					violations.push({
						rule: 'SPINE_DOM_MEASUREMENT',
						file: relPath,
						line: i + 1,
						snippet: lines[i]?.trim(),
						message:
							'DOM measurement is strictly prohibited in spine and stage-chain components (AC 3, 07 节).',
					});
				}
			}
		}

		// Check 15: Gate toggles and pipeline toggles must not import each other (M9-T22 / AC 1)
		const isGateToggles = file.endsWith('/gate-toggles.tsx') || file.endsWith('\\gate-toggles.tsx');
		const isPipelineToggles =
			file.endsWith('/pipeline-toggles.tsx') || file.endsWith('\\pipeline-toggles.tsx');

		if (isGateToggles || isPipelineToggles) {
			const cleanLines = blankComments(content).split('\n');
			for (let i = 0; i < cleanLines.length; i++) {
				const line = cleanLines[i] ?? '';
				if (isGateToggles && /from\s+['"].*pipeline-toggles(?:\.tsx)?['"]/.test(line)) {
					violations.push({
						rule: 'TOGGLES_MUTUAL_IMPORT',
						file: relPath,
						line: i + 1,
						snippet: lines[i]?.trim(),
						message:
							'gate-toggles.tsx must not import pipeline-toggles; both must only import ui/segmented-toggle (M9-T22 / AC 1).',
					});
				}
				if (isPipelineToggles && /from\s+['"].*gate-toggles(?:\.tsx)?['"]/.test(line)) {
					violations.push({
						rule: 'TOGGLES_MUTUAL_IMPORT',
						file: relPath,
						line: i + 1,
						snippet: lines[i]?.trim(),
						message:
							'pipeline-toggles.tsx must not import gate-toggles; both must only import ui/segmented-toggle (M9-T22 / AC 1).',
					});
				}
			}
		}
	}

	// Check 11: @keyframes must appear exactly once across base.css (AC 3, E-282).
	// Only the real stylesheet is judged; a scan of a synthetic web dir without base.css is not a violation.
	const baseCssPath = resolve(webDir, 'src/styles/base.css');
	if (existsSync(baseCssPath)) {
		const baseContent = readFileSync(baseCssPath, 'utf8');
		const cleanBase = baseContent.replace(/\/\*[\s\S]*?\*\//g, '');
		const keyframesMatches = cleanBase.match(/@keyframes\s+([a-zA-Z0-9_-]+)/g) ?? [];
		if (keyframesMatches.length !== 1 || !keyframesMatches[0]?.includes('agsched-pulse')) {
			violations.push({
				rule: 'KEYFRAMES_EXACTLY_ONE_BASE_CSS',
				file: relative(rootDir, baseCssPath),
				message: `@keyframes must appear exactly once in base.css and define agsched-pulse (found: ${keyframesMatches.join(', ') || 'none'}).`,
			});
		}
	}

	return {
		passed: violations.length === 0,
		violations,
	};
}

// Standalone CLI execution
if (process.argv[1]?.endsWith('check-forbidden.ts')) {
	const report = runForbiddenCheck();
	console.log(
		'\n=== Architecture Forbidden Patterns Verification (M9-T1, M9-T24 / E-170, E-15, E-159) ===\n',
	);

	if (report.violations.length === 0) {
		console.log('All architecture grep and token restrictions passed cleanly. (0 violations) ✓\n');
		process.exit(0);
	} else {
		console.error(`FAILED: ${report.violations.length} architecture violations found:\n`);
		for (const v of report.violations) {
			const loc = v.line ? `${v.file}:${v.line}` : v.file;
			console.error(` [${v.rule}] ${loc}`);
			console.error(`   ${v.message}`);
			if (v.snippet) {
				console.error(`   Snippet: ${v.snippet}`);
			}
		}
		console.error('');
		process.exit(1);
	}
}
