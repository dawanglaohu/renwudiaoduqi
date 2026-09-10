import { describe, expect, it } from 'vitest';
import { runForbiddenCheck } from '../scripts/check-forbidden.js';

describe('check-forbidden (M9-T1, E-170, E-15)', () => {
	it('passes all 8 architecture checks on clean workspace', () => {
		const report = runForbiddenCheck();
		expect(report.passed).toBe(true);
		expect(report.violations).toEqual([]);
	});
});
