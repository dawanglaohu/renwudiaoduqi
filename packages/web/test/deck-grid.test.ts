/**
 * packages/web/test/deck-grid.test.ts
 *
 * M9-T28 泳道网格模板纯函数测试（AC 2, E-163, E-164, E-168）
 * 覆盖泳道数 1 / 2 / 3 / 5 × 完整、紧凑两档与窄窗
 */

import { describe, expect, it } from 'vitest';
import { getDeckGridTemplate } from '../src/lib/deck-grid.ts';

describe('deck-grid: 泳道网格模板纯函数（AC 2, E-163, E-164, E-168）', () => {
	const laneCounts = [1, 2, 3, 5] as const;

	describe('完整档（full）：repeat(N, minmax(var(--stream-min), 1fr))（E-163）', () => {
		it.each(laneCounts)('泳道数 %i 时按实际条数分掉全部宽度', (count) => {
			const expected = `repeat(${count}, minmax(var(--stream-min), 1fr))`;
			expect(getDeckGridTemplate('full', count)).toBe(expected);
		});

		it('非正数或 0 泳道安全兜底为 1 列', () => {
			expect(getDeckGridTemplate('full', 0)).toBe('repeat(1, minmax(var(--stream-min), 1fr))');
			expect(getDeckGridTemplate('full', -2)).toBe('repeat(1, minmax(var(--stream-min), 1fr))');
		});
	});

	describe('紧凑档（compact）：repeat(auto-fill, minmax(var(--stream-min-dense), 1fr))（E-164）', () => {
		it.each(laneCounts)('泳道数 %i 时恒为换行网格而非横向滚动', (count) => {
			const expected = 'repeat(auto-fill, minmax(var(--stream-min-dense), 1fr))';
			expect(getDeckGridTemplate('compact', count)).toBe(expected);
		});
	});

	describe('窄窗（narrow）：单列吃满（E-168）', () => {
		it.each(laneCounts)('泳道数 %i 时退化为单列吃满 1fr', (count) => {
			expect(getDeckGridTemplate('narrow', count)).toBe('1fr');
		});
	});

	describe('手机档位：单列吃满', () => {
		it('phone 与 phone-xs 档位下同样单列吃满 1fr', () => {
			expect(getDeckGridTemplate('phone', 3)).toBe('1fr');
			expect(getDeckGridTemplate('phone-xs', 3)).toBe('1fr');
		});
	});
});
