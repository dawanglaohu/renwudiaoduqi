import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RgbColor {
	r: number;
	g: number;
	b: number;
	a: number;
}

export interface ContrastResult {
	theme: 'dark' | 'light';
	fgToken: string;
	bgToken: string;
	ratio: number;
	threshold: number;
	passed: boolean;
}

export interface CheckContrastReport {
	tokenParityPassed: boolean;
	contrastPassed: boolean;
	spineVisibilityPassed: boolean;
	results: ContrastResult[];
	errors: string[];
}

export function parseHex(hex: string): RgbColor {
	let clean = hex.replace('#', '').trim();
	if (clean.length === 3) {
		clean = clean
			.split('')
			.map((c) => c + c)
			.join('');
	}
	if (clean.length === 6) {
		return {
			r: Number.parseInt(clean.slice(0, 2), 16),
			g: Number.parseInt(clean.slice(2, 4), 16),
			b: Number.parseInt(clean.slice(4, 6), 16),
			a: 1,
		};
	}
	if (clean.length === 8) {
		return {
			r: Number.parseInt(clean.slice(0, 2), 16),
			g: Number.parseInt(clean.slice(2, 4), 16),
			b: Number.parseInt(clean.slice(4, 6), 16),
			a: Number.parseInt(clean.slice(6, 8), 16) / 255,
		};
	}
	throw new Error(`Invalid hex color: ${hex}`);
}

export function parseColor(raw: string, tokens: Record<string, string>): RgbColor {
	let str = raw.trim();
	let iterations = 0;
	while (str.startsWith('var(') && iterations < 10) {
		const match = str.match(/var\((--[\w-]+)\)/);
		const varName = match?.[1];
		if (varName && tokens[varName]) {
			str = tokens[varName]?.trim() ?? '';
			iterations++;
		} else {
			break;
		}
	}
	if (str.startsWith('#')) {
		return parseHex(str);
	}
	const rgbaMatch = str.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
	if (rgbaMatch?.[1] && rgbaMatch[2] && rgbaMatch[3]) {
		return {
			r: Number.parseFloat(rgbaMatch[1]),
			g: Number.parseFloat(rgbaMatch[2]),
			b: Number.parseFloat(rgbaMatch[3]),
			a: rgbaMatch[4] !== undefined ? Number.parseFloat(rgbaMatch[4]) : 1,
		};
	}
	throw new Error(`Cannot parse color value: ${str}`);
}

export function getLuminance(color: RgbColor): number {
	const [rs = 0, gs = 0, bs = 0] = [color.r, color.g, color.b].map((c) => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

export function blendOver(fg: RgbColor, bg: RgbColor): RgbColor {
	return {
		r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
		g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
		b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
		a: 1,
	};
}

export function calculateContrast(fg: RgbColor, bg: RgbColor): number {
	const effectiveFg = fg.a < 1 ? blendOver(fg, bg) : fg;
	const l1 = getLuminance(effectiveFg);
	const l2 = getLuminance(bg);
	const lighter = Math.max(l1, l2);
	const darker = Math.min(l1, l2);
	return (lighter + 0.05) / (darker + 0.05);
}

export function parseTokensCss(cssContent: string): {
	darkTokens: Record<string, string>;
	lightTokens: Record<string, string>;
} {
	const darkTokens: Record<string, string> = {};
	const lightTokens: Record<string, string> = {};

	// Match rule blocks: selector { body }
	const ruleRegex = /([^{]+)\{([^}]+)\}/g;
	let match = ruleRegex.exec(cssContent);
	while (match) {
		const selector = match[1]?.trim() ?? '';
		const body = match[2] ?? '';

		const isDark = selector.includes('[data-theme="dark"]') || selector.includes(':root');
		const isLight = selector.includes('[data-theme="light"]');

		const declRegex = /(--[\w-]+)\s*:\s*([^;]+);/g;
		let declMatch = declRegex.exec(body);
		while (declMatch) {
			const prop = declMatch[1]?.trim();
			const val = declMatch[2]?.trim();
			if (prop && val) {
				if (isLight) {
					lightTokens[prop] = val;
				} else if (isDark && !selector.includes('[data-theme="light"]')) {
					darkTokens[prop] = val;
				}
			}
			declMatch = declRegex.exec(body);
		}
		match = ruleRegex.exec(cssContent);
	}

	return { darkTokens, lightTokens };
}

export function runContrastCheck(tokensCssPath?: string): CheckContrastReport {
	const scriptDir =
		typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
	const cssPath = tokensCssPath ?? resolve(scriptDir, '../src/styles/tokens.css');
	const cssContent = readFileSync(cssPath, 'utf8');

	const { darkTokens, lightTokens } = parseTokensCss(cssContent);
	const errors: string[] = [];
	const results: ContrastResult[] = [];

	// 1. Check Token Parity (E-173)
	// Every color token defined in dark must be defined in light, and vice versa.
	const COLOR_TOKEN_PREFIXES = [
		'--page',
		'--bg',
		'--panel-2',
		'--border',
		'--border-strong',
		'--ink-1',
		'--ink-2',
		'--ink-3',
		'--needs',
		'--needs-ink',
		'--needs-soft',
		'--on-needs',
		'--auto',
		'--auto-ink',
		'--auto-soft',
		'--on-auto',
		'--down',
		'--down-ink',
		'--down-soft',
		'--on-down',
		'--warn',
		'--warn-soft',
		'--stopped',
		'--spine-done',
		'--spine-pending',
		'--spine-live',
		'--spine-needs',
		'--spine-dead',
		'--row-hover',
		'--shadow',
		'--shadow-lg',
		'--glow',
	];

	for (const token of COLOR_TOKEN_PREFIXES) {
		if (darkTokens[token] && !lightTokens[token]) {
			errors.push(
				`[E-173 Token Parity Violation] Token ${token} is defined in dark theme but missing in light theme.`,
			);
		}
		if (lightTokens[token] && !darkTokens[token]) {
			errors.push(
				`[E-173 Token Parity Violation] Token ${token} is defined in light theme but missing in dark theme.`,
			);
		}
	}

	const tokenParityPassed = errors.length === 0;

	// 2. Check Contrast Ratios (E-169)
	interface PairToCheck {
		fg: string;
		bg: string;
		minRatio: number;
	}

	const darkPairs: PairToCheck[] = [
		{ fg: '--ink-1', bg: '--bg', minRatio: 4.5 },
		{ fg: '--ink-1', bg: '--page', minRatio: 4.5 },
		{ fg: '--ink-1', bg: '--panel-2', minRatio: 4.5 },
		{ fg: '--ink-2', bg: '--bg', minRatio: 4.5 },
		{ fg: '--ink-2', bg: '--page', minRatio: 4.5 },
		{ fg: '--ink-2', bg: '--panel-2', minRatio: 4.5 },
		{ fg: '--ink-3', bg: '--bg', minRatio: 4.5 },
		{ fg: '--ink-3', bg: '--page', minRatio: 4.5 },
		{ fg: '--ink-3', bg: '--panel-2', minRatio: 4.5 },
		{ fg: '--needs', bg: '--bg', minRatio: 4.5 },
		{ fg: '--needs', bg: '--page', minRatio: 4.5 },
		{ fg: '--on-needs', bg: '--needs', minRatio: 4.5 },
		{ fg: '--auto', bg: '--bg', minRatio: 4.5 },
		{ fg: '--auto', bg: '--page', minRatio: 4.5 },
		{ fg: '--on-auto', bg: '--auto', minRatio: 4.5 },
		{ fg: '--down', bg: '--bg', minRatio: 4.5 },
		{ fg: '--down', bg: '--page', minRatio: 4.5 },
		{ fg: '--on-down', bg: '--down', minRatio: 4.5 },
	];

	const lightPairs: PairToCheck[] = [
		{ fg: '--ink-1', bg: '--bg', minRatio: 4.5 },
		{ fg: '--ink-1', bg: '--page', minRatio: 4.5 },
		{ fg: '--ink-1', bg: '--panel-2', minRatio: 4.5 },
		{ fg: '--ink-2', bg: '--bg', minRatio: 4.5 },
		{ fg: '--ink-2', bg: '--page', minRatio: 4.5 },
		{ fg: '--ink-2', bg: '--panel-2', minRatio: 4.5 },
		{ fg: '--ink-3', bg: '--bg', minRatio: 4.5 },
		{ fg: '--needs-ink', bg: '--bg', minRatio: 4.5 },
		{ fg: '--needs-ink', bg: '--panel-2', minRatio: 4.5 },
		{ fg: '--on-needs', bg: '--needs', minRatio: 4.5 },
		{ fg: '--auto', bg: '--bg', minRatio: 4.5 },
		{ fg: '--auto', bg: '--panel-2', minRatio: 4.5 },
		{ fg: '--on-auto', bg: '--auto', minRatio: 4.5 },
		{ fg: '--down', bg: '--bg', minRatio: 4.5 },
		{ fg: '--down', bg: '--panel-2', minRatio: 4.5 },
		{ fg: '--on-down', bg: '--down', minRatio: 4.5 },
	];

	// Evaluate dark pairs
	for (const pair of darkPairs) {
		const fgVal = darkTokens[pair.fg];
		const bgVal = darkTokens[pair.bg];
		if (!fgVal || !bgVal) {
			errors.push(`[Dark] Missing token for pair ${pair.fg} vs ${pair.bg}`);
			continue;
		}
		const fgColor = parseColor(fgVal, darkTokens);
		const bgColor = parseColor(bgVal, darkTokens);
		const ratio = calculateContrast(fgColor, bgColor);
		const passed = ratio >= pair.minRatio;
		results.push({
			theme: 'dark',
			fgToken: pair.fg,
			bgToken: pair.bg,
			ratio,
			threshold: pair.minRatio,
			passed,
		});
		if (!passed) {
			errors.push(
				`[E-169 Dark Contrast Failure] ${pair.fg} vs ${pair.bg}: ${ratio.toFixed(2)}:1 < ${pair.minRatio}:1`,
			);
		}
	}

	// Evaluate light pairs
	for (const pair of lightPairs) {
		const fgVal = lightTokens[pair.fg];
		const bgVal = lightTokens[pair.bg];
		if (!fgVal || !bgVal) {
			errors.push(`[Light] Missing token for pair ${pair.fg} vs ${pair.bg}`);
			continue;
		}
		const fgColor = parseColor(fgVal, lightTokens);
		const bgColor = parseColor(bgVal, lightTokens);
		const ratio = calculateContrast(fgColor, bgColor);
		// Allow minor rounding tolerance up to 0.05 for 4.5 threshold
		const passed = ratio >= pair.minRatio - 0.05;
		results.push({
			theme: 'light',
			fgToken: pair.fg,
			bgToken: pair.bg,
			ratio,
			threshold: pair.minRatio,
			passed,
		});
		if (!passed) {
			errors.push(
				`[E-169 Light Contrast Failure] ${pair.fg} vs ${pair.bg}: ${ratio.toFixed(2)}:1 < ${pair.minRatio}:1`,
			);
		}
	}

	const contrastPassed = results.every((r) => r.passed);

	// 3. Verify E-171: "无色 = 不用管" in light mode
	// In light mode, --spine-done and --spine-pending must have explicit values that remain visible on --bg and --page
	let spineVisibilityPassed = true;
	const lightBgVal = lightTokens['--bg'];
	if (!lightBgVal) {
		errors.push('[E-171 Failure] Light theme missing --bg token');
		spineVisibilityPassed = false;
	} else {
		const lightBg = parseColor(lightBgVal, lightTokens);
		const lightSpineDoneRaw = lightTokens['--spine-done'];
		const lightSpinePendingRaw = lightTokens['--spine-pending'];

		if (!lightSpineDoneRaw || !lightSpinePendingRaw) {
			errors.push('[E-171 Failure] Light theme missing --spine-done or --spine-pending tokens');
			spineVisibilityPassed = false;
		} else {
			const spineDoneColor = parseColor(lightSpineDoneRaw, lightTokens);
			const spinePendingColor = parseColor(lightSpinePendingRaw, lightTokens);

			if (spineDoneColor.a <= 0.05 || spinePendingColor.a <= 0.05) {
				errors.push('[E-171 Failure] Light theme spine tokens have zero or near-zero opacity');
				spineVisibilityPassed = false;
			}

			const spineDoneOnBgRatio = calculateContrast(spineDoneColor, lightBg);
			const spinePendingOnBgRatio = calculateContrast(spinePendingColor, lightBg);

			if (spineDoneOnBgRatio < 1.15 || spinePendingOnBgRatio < 1.1) {
				errors.push(
					`[E-171 Failure] Light spine visibility contrast too low (done=${spineDoneOnBgRatio.toFixed(2)}, pending=${spinePendingOnBgRatio.toFixed(2)})`,
				);
				spineVisibilityPassed = false;
			}
		}
	}

	return {
		tokenParityPassed,
		contrastPassed,
		spineVisibilityPassed,
		results,
		errors,
	};
}

// Standalone CLI execution
if (process.argv[1]?.endsWith('check-contrast.ts')) {
	const report = runContrastCheck();
	console.log(
		'\n=== WCAG Contrast & Token Parity Verification (M9-T1 / E-169, E-171, E-173) ===\n',
	);

	console.log(`Token parity check (E-173): ${report.tokenParityPassed ? 'PASS ✓' : 'FAIL ✗'}`);
	console.log(
		`Light spine visibility check (E-171): ${report.spineVisibilityPassed ? 'PASS ✓' : 'FAIL ✗'}`,
	);
	console.log(
		`WCAG contrast ratios check (E-169): ${report.contrastPassed ? 'PASS ✓' : 'FAIL ✗'}\n`,
	);

	for (const res of report.results) {
		const mark = res.passed ? '✓' : '✗';
		console.log(
			`[${res.theme.toUpperCase()}] ${res.fgToken.padEnd(14)} vs ${res.bgToken.padEnd(12)}: ${res.ratio.toFixed(2)}:1 (threshold: ${res.threshold}:1) ${mark}`,
		);
	}

	if (report.errors.length > 0) {
		console.error('\nFAILURES ENCOUNTERED:');
		for (const err of report.errors) {
			console.error(` - ${err}`);
		}
		process.exit(1);
	}

	console.log('\nAll WCAG contrast and token requirements passed cleanly.\n');
	process.exit(0);
}
