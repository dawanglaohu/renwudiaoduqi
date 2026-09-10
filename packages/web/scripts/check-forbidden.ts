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

export function runForbiddenCheck(projectRootPath?: string): CheckForbiddenReport {
	const scriptDir =
		typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
	const webDir = resolve(scriptDir, '..');
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
	const webSourceFiles = walkFiles(join(webDir, 'src'), (f) => /\.(ts|tsx|css|js|jsx)$/.test(f));
	// Also include tailwind.config.ts
	const tailwindConfig = join(webDir, 'tailwind.config.ts');
	if (existsSync(tailwindConfig)) {
		webSourceFiles.push(tailwindConfig);
	}

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

		// Check 6: Fixed font-size / text-size-adjust: none / zoom on html (E-15)
		if (file.endsWith('.css')) {
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? '';
				const stripped = line.replace(/\/\*.*?\*\/|\/\/.*/g, '');
				if (
					/html\s*\{[^}]*font-size\s*:\s*\d+px/i.test(stripped) ||
					(/font-size\s*:\s*\d+px/i.test(stripped) && stripped.includes('html'))
				) {
					violations.push({
						rule: 'E15_ROOT_FONT_SIZE_LOCKED',
						file: relPath,
						line: i + 1,
						snippet: line.trim(),
						message:
							'Fixed font-size on html root is prohibited (violates E-15 system font-size scaling).',
					});
				}
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
	}

	return {
		passed: violations.length === 0,
		violations,
	};
}

// Standalone CLI execution
if (process.argv[1]?.endsWith('check-forbidden.ts')) {
	const report = runForbiddenCheck();
	console.log('\n=== Architecture Forbidden Patterns Verification (M9-T1 / E-170, E-15) ===\n');

	if (report.violations.length === 0) {
		console.log(
			'All 8 architecture grep and token restrictions passed cleanly. (0 violations) ✓\n',
		);
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
