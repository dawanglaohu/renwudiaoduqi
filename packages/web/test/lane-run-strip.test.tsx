import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LaneRunStrip } from '../src/components/lane-run-strip.tsx';

describe('LaneRunStrip (M9-T21 / AC 9, E-319, E-324)', () => {
	it('AC 9 & E-324: renders 44px bar with ◀ ▶ buttons of size >= 44x44px', () => {
		const html = renderToStaticMarkup(
			createElement(LaneRunStrip, {
				currentIndex: 2,
				totalLanes: 4,
				taskKey: 'M9-T21',
				status: 'thinking',
			}),
		);

		expect(html).toContain('data-component="lane-run-strip"');
		expect(html).toContain('h-[44px]');
		expect(html).toContain('min-h-[44px]');

		// 尺寸必须 >= 44x44
		expect(html).toContain('w-[44px]');
		expect(html).toContain('min-w-[44px]');
		expect(html).toContain('min-h-[44px]');

		// 中间内容格式
		expect(html).toContain('data-field="strip-title"');
		expect(html).toContain('泳道 2/4 · M9-T21');
	});

	it('AC 9 & E-324: buttons are disabled but NOT hidden when totalLanes <= 1', () => {
		const html = renderToStaticMarkup(
			createElement(LaneRunStrip, {
				currentIndex: 1,
				totalLanes: 1,
				taskKey: 'M9-T21',
			}),
		);

		// disabled 但不隐藏（不可 display:none / hidden）
		expect(html).toContain('data-action="prev-lane" disabled=""');
		expect(html).toContain('data-action="next-lane" disabled=""');
		expect(html).not.toMatch(/data-action="prev-lane"[^>]*hidden/);
		expect(html).not.toMatch(/data-action="next-lane"[^>]*hidden/);
	});

	it('AC 9 & E-324: boundary buttons are disabled but not hidden', () => {
		// 在第 1 条泳道：prev disabled, next enabled
		const html1 = renderToStaticMarkup(
			createElement(LaneRunStrip, {
				currentIndex: 1,
				totalLanes: 3,
				taskKey: 'M9-T1',
			}),
		);
		expect(html1).toContain('data-action="prev-lane" disabled=""');
		expect(html1).not.toContain('data-action="next-lane" disabled=""');

		// 在第 3 条泳道（末尾）：prev enabled, next disabled
		const html3 = renderToStaticMarkup(
			createElement(LaneRunStrip, {
				currentIndex: 3,
				totalLanes: 3,
				taskKey: 'M9-T3',
			}),
		);
		expect(html3).not.toContain('data-action="prev-lane" disabled=""');
		expect(html3).toContain('data-action="next-lane" disabled=""');
	});

	it('E-319: idle lane displays "泳道 k/N · 空闲"', () => {
		const html = renderToStaticMarkup(
			createElement(LaneRunStrip, {
				currentIndex: 2,
				totalLanes: 4,
				isIdle: true,
			}),
		);

		expect(html).toContain('泳道 2/4 · 空闲');
	});

	it('E-324: wrapup lane displays "泳道 k/N · 批次收口"', () => {
		const html = renderToStaticMarkup(
			createElement(LaneRunStrip, {
				currentIndex: 3,
				totalLanes: 3,
				isWrapup: true,
			}),
		);

		expect(html).toContain('泳道 3/3 · 批次收口');
	});
});
