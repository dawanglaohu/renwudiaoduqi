/**
 * packages/web/test/virtual-rows.test.ts
 *
 * M9-T8 虚拟列表包装测试（AC 1, AC 6, E-143）
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type VirtualRowItem, VirtualRows } from '../src/components/virtual-rows.tsx';

function walkFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const results: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === '.pnpm') {
			continue;
		}
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			results.push(...walkFiles(full));
		} else if (/\.(ts|tsx)$/.test(full)) {
			results.push(full);
		}
	}
	return results;
}

describe('M9-T8: VirtualRows Component (AC 1, AC 6, E-143)', () => {
	// ─── AC 6: 虚拟滚动只经这一个包装使用，禁止第二处直接 import ───
	describe('AC 6: TanStack Virtual single import encapsulation', () => {
		it('ensures @tanstack/react-virtual is ONLY imported in packages/web/src/components/virtual-rows.tsx', () => {
			const webSrc = join(__dirname, '../src');
			const files = walkFiles(webSrc);
			expect(files.length).toBeGreaterThan(5);

			const forbiddenFiles: string[] = [];
			for (const file of files) {
				const content = readFileSync(file, 'utf8');
				if (content.includes('@tanstack/react-virtual') && !file.endsWith('virtual-rows.tsx')) {
					forbiddenFiles.push(file);
				}
			}

			expect(
				forbiddenFiles,
				`Direct imports of @tanstack/react-virtual are strictly forbidden outside virtual-rows.tsx: ${forbiddenFiles.join(', ')}`,
			).toHaveLength(0);
		});
	});

	// ─── AC 1 & E-143: 十万行虚拟列表只挂载可视窗口，不把全量放进 DOM ───
	describe('AC 1 & E-143: Virtual window bounded rendering for large line counts', () => {
		it('mounts only viewport bounded items for 100,000 items, not the full 100,000 in DOM', () => {
			const renderedIndices: number[] = [];
			const html = renderToStaticMarkup(
				createElement(VirtualRows, {
					count: 100_000,
					estimateSize: 22,
					className: 'h-[600px] w-full',
					renderItem: (item: VirtualRowItem) => {
						renderedIndices.push(item.index);
						return createElement('div', { 'data-row-id': item.index }, `Line ${item.index + 1}`);
					},
				}),
			);

			expect(html).toContain('data-virtual-scroll="true"');
			expect(html).toContain('data-virtual-content="true"');

			// SSR / 初始静态渲染时，只渲染由 overscan 和容器视口切出的极少部分，绝不渲染 100,000 行
			expect(renderedIndices.length).toBeLessThan(100);
			expect(html).not.toContain('Line 99999');
		});

		it('supports custom headers and footers alongside virtualized rows', () => {
			const html = renderToStaticMarkup(
				createElement(VirtualRows, {
					count: 50,
					estimateSize: 22,
					header: createElement('div', { 'data-test-header': 'true' }, 'Header View'),
					footer: createElement('div', { 'data-test-footer': 'true' }, 'Footer View'),
					renderItem: (item: VirtualRowItem) => createElement('div', null, `Row ${item.index}`),
				}),
			);

			expect(html).toContain('data-test-header="true"');
			expect(html).toContain('Header View');
			expect(html).toContain('data-test-footer="true"');
			expect(html).toContain('Footer View');
		});
	});
});
