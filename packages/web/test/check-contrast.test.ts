import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	calculateContrast,
	getLuminance,
	parseColor,
	parseHex,
	runContrastCheck,
} from '../scripts/check-contrast.js';

describe('check-contrast (M9-T1, E-169, E-171, E-173)', () => {
	it('verifies real tokens.css has full parity, valid contrast, and visible spine', () => {
		const report = runContrastCheck();
		expect(report.tokenParityPassed).toBe(true);
		expect(report.contrastPassed).toBe(true);
		expect(report.spineVisibilityPassed).toBe(true);
		expect(report.errors).toEqual([]);
		expect(report.results.length).toBeGreaterThanOrEqual(30);
	});

	it('calculates WCAG 2.1 contrast correctly for black and white', () => {
		const black = parseHex('#000000');
		const white = parseHex('#ffffff');
		const ratio = calculateContrast(white, black);
		expect(ratio).toBeCloseTo(21, 0);
	});

	it('calculates luminance for known primary colors', () => {
		const white = parseHex('#ffffff');
		const black = parseHex('#000000');
		expect(getLuminance(white)).toBeCloseTo(1, 4);
		expect(getLuminance(black)).toBeCloseTo(0, 4);
	});

	it('detects contrast failures when ratio is below 4.5:1', () => {
		const lowContrastFg = parseHex('#777777');
		const lowContrastBg = parseHex('#888888');
		const ratio = calculateContrast(lowContrastFg, lowContrastBg);
		expect(ratio).toBeLessThan(4.5);
	});

	it('resolves var() color token references correctly', () => {
		const tokens = {
			'--needs': '#F0B03C',
			'--warn': 'var(--needs)',
		};
		const color = parseColor('var(--warn)', tokens);
		expect(color.r).toBe(0xf0);
		expect(color.g).toBe(0xb0);
		expect(color.b).toBe(0x3c);
	});

	it('fails token parity when a dark-only color token is added (E-173)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'agsched-tokens-'));
		const cssPath = join(dir, 'tokens.css');
		writeFileSync(
			cssPath,
			':root, [data-theme="dark"] { --bg: #171b1c; --partial: #f0b03c; }\n[data-theme="light"] { --bg: #fbfcfc; }\n',
		);
		try {
			const report = runContrastCheck(cssPath);
			expect(report.tokenParityPassed).toBe(false);
			expect(report.errors.some((error) => error.includes('--partial'))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
