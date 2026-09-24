import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StreamColumn } from '../src/components/stream-column.tsx';
import type { DensityTier } from '../src/hooks/use-breakpoint.ts';

const TIERS: readonly DensityTier[] = ['full', 'compact', 'narrow', 'phone', 'phone-xs'];
const STATES = ['running', 'idle', 'overLimit', 'wrapup'] as const;

describe('StreamColumn: Resident stop button and approval slot matrix (AC 8, E-106, E-236)', () => {
	// ─── 5 档 × {running, idle, overLimit, wrapup} = 20-cell 矩阵断言停止键常驻存在 ───
	for (const tier of TIERS) {
		for (const state of STATES) {
			it(`tier=${tier} × state=${state}: stop button and approval slot must exist`, () => {
				const isIdle = state === 'idle';
				const isWrapup = state === 'wrapup';
				const isOverLimit = state === 'overLimit';

				const html = renderToStaticMarkup(
					createElement(StreamColumn, {
						laneNo: 1,
						kind: isWrapup ? 'wrapup' : isIdle ? 'idle' : 'task',
						status: isIdle ? 'queued' : 'running',
						tier,
						overLimit: isOverLimit,
						approvalSlot: createElement(
							'div',
							{ 'data-testid': 'test-approval-card' },
							'审批卡内容',
						),
					}),
				);

				// 1. 停止控件必须无条件常驻存在（AC 8, E-106, E-236）
				expect(html).toContain('data-action="stop-stream"');
				expect(html).toContain('data-resident="true"');

				// 空闲态时停止键应处于禁用置灰态，但仍常驻原位（AC 7, E-319）
				if (isIdle) {
					expect(html).toContain('disabled=""');
				}

				// 2. 审批槽位必须常驻渲染在所有分支之外（AC 8, E-236）
				expect(html).toContain('data-slot="approval"');
				expect(html).toContain('data-resident-slot="true"');
			});
		}
	}

	it('AC 7 & E-309: overLimit=true renders "超出窗口数" chip', () => {
		const htmlWithOverLimit = renderToStaticMarkup(
			createElement(StreamColumn, { laneNo: 1, overLimit: true }),
		);
		expect(htmlWithOverLimit).toContain('data-chip="over-limit"');
		expect(htmlWithOverLimit).toContain('超出窗口数');

		const htmlWithoutOverLimit = renderToStaticMarkup(
			createElement(StreamColumn, { laneNo: 1, overLimit: false }),
		);
		expect(htmlWithoutOverLimit).not.toContain('data-chip="over-limit"');
		expect(htmlWithoutOverLimit).not.toContain('超出窗口数');
	});

	it('AC 7 & E-319: idle lane renders idleText in body slot when no custom children', () => {
		const html = renderToStaticMarkup(
			createElement(StreamColumn, {
				laneNo: 1,
				kind: 'idle',
				idleText: '空闲 · 队列下一个是 M9-T22（等 M9-T21 落地）',
			}),
		);

		expect(html).toContain('data-slot="idle-text"');
		expect(html).toContain('空闲 · 队列下一个是 M9-T22（等 M9-T21 落地）');
	});
});
