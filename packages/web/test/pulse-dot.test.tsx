import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PulseDot } from '../src/components/pulse-dot.tsx';

describe('components/pulse-dot (M9-T19, AC 3, E-282)', () => {
	// ─── 1. HTML 模式下的 live 呼吸点 ───
	it('renders HTML live pulse dot with 8px base and live breathing class', () => {
		const html = renderToStaticMarkup(createElement(PulseDot, { variant: 'live' }));

		expect(html).toContain('data-pulse-dot="live"');
		expect(html).toContain('pulse-dot');
		expect(html).toContain('pulse-dot-live');
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-label="正在执行"');
	});

	// ─── 2. HTML 模式下的 waiting 静态暖点 ───
	it('renders HTML waiting dot with static warm color class and no ring', () => {
		const html = renderToStaticMarkup(createElement(PulseDot, { variant: 'waiting' }));

		expect(html).toContain('data-pulse-dot="waiting"');
		expect(html).toContain('pulse-dot');
		expect(html).toContain('pulse-dot-waiting');
		expect(html).not.toContain('pulse-dot-live');
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-label="等待处理"');
	});

	// ─── 3. 支持自定义无障碍标签 ───
	it('accepts custom accessibility label', () => {
		const html = renderToStaticMarkup(
			createElement(PulseDot, { variant: 'live', label: '任务 M9-T19 执行中' }),
		);
		expect(html).toContain('aria-label="任务 M9-T19 执行中"');
	});

	// ─── 4. SVG 模式下的 live 节点（供 spine.tsx 使用） ───
	it('renders SVG live node with 1.6s pulse ring and inner node', () => {
		const html = renderToStaticMarkup(
			createElement(PulseDot, {
				variant: 'live',
				asSvg: true,
				cx: 11,
				cy: 15,
			}),
		);

		expect(html).toContain('data-spine-node="pulse-live"');
		expect(html).toContain('data-pulse-dot="live"');
		expect(html).toContain('data-pulse="1.6s"');
		expect(html).toContain('var(--pulse');
		expect(html).toContain('agsched-pulse-ring');
		expect(html).toContain('r="7"');
		expect(html).toContain('fill="var(--auto-soft)"');
		expect(html).toContain('stroke="var(--auto)"');
		expect(html).toContain('r="4"');
		expect(html).toContain('fill="var(--auto)"');
	});

	// ─── 5. SVG 模式下的 waiting 节点（供 spine.tsx 使用） ───
	it('renders SVG waiting node with 9px square and needs color', () => {
		const html = renderToStaticMarkup(
			createElement(PulseDot, {
				variant: 'waiting',
				asSvg: true,
				cx: 11,
				cy: 15,
			}),
		);

		expect(html).toContain('data-spine-node="waiting-square"');
		expect(html).toContain('data-pulse-dot="waiting"');
		expect(html).toContain('width="9"');
		expect(html).toContain('height="9"');
		expect(html).toContain('var(--spine-needs)');
	});

	// ─── 6. SVG 模式支持内嵌子字形 ───
	it('renders custom innerNode in SVG mode without suppressing breathing ring', () => {
		const innerSvg = createElement('path', { d: 'M0 0', 'data-custom-glyph': 'true' });
		const html = renderToStaticMarkup(
			createElement(PulseDot, {
				variant: 'live',
				asSvg: true,
				cx: 11,
				cy: 15,
				innerNode: innerSvg,
			}),
		);

		expect(html).toContain('data-spine-node="pulse-live"');
		expect(html).toContain('data-custom-glyph="true"');
		expect(html).toContain('r="7"');
		expect(html).toContain('agsched-pulse-ring');
	});
});
