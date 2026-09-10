import { describe, expect, it } from 'vitest';
import {
	findRootFontSizeLocks,
	isDeckContainer,
	runForbiddenCheck,
} from '../scripts/check-forbidden.js';

describe('check-forbidden (M9-T1, E-170, E-15)', () => {
	it('passes every architecture check on the clean workspace', () => {
		const report = runForbiddenCheck();
		expect(report.passed).toBe(true);
		expect(report.violations).toEqual([]);
	});

	it('flags a root font-size lock even when the declaration sits on its own line (E-15)', () => {
		expect(findRootFontSizeLocks('html {\n\tfont-size: 14px;\n}\n')).toEqual([1]);
		expect(findRootFontSizeLocks(':root { font-size: 16px; }')).toEqual([1]);
		expect(findRootFontSizeLocks('.html-snippet { font-size: 14px; }')).toEqual([]);
		expect(findRootFontSizeLocks('html { font-size: 100%; }')).toEqual([]);
	});

	it('treats the run-deck lanes as the container that must never scroll sideways (E-145)', () => {
		expect(isDeckContainer('packages/web/src/features/run-deck/run-deck-container.tsx')).toBe(true);
		expect(isDeckContainer('packages/web/src/components/stream-column.tsx')).toBe(true);
		expect(isDeckContainer('packages/web/src/components/virtual-rows.tsx')).toBe(false);
	});
});
