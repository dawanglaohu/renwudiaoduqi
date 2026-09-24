import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LaneHistoryRow } from '../src/components/lane-history-row.tsx';
import type { StageRow } from '../src/lib/stage-rows.ts';

const mockStageRows: readonly StageRow[] = [
	{
		id: 'implement',
		stage: 'implement',
		label: '实施',
		status: 'done',
		durationMs: 12000,
		runId: 'run-impl-1',
		spineKind: 'done',
		spineLevel: 'stage',
		interactive: false,
		stageRuns: [],
		isFuture: false,
		isCurrent: false,
		isDone: true,
	},
	{
		id: 'review',
		stage: 'review',
		label: '审查',
		status: 'done',
		durationMs: 8000,
		runId: 'run-rev-1',
		spineKind: 'done',
		spineLevel: 'stage',
		interactive: false,
		stageRuns: [],
		isFuture: false,
		isCurrent: false,
		isDone: true,
	},
	{
		id: 'landing',
		stage: 'landing',
		label: '落地',
		status: 'done',
		durationMs: 1000,
		runId: null,
		spineKind: 'done',
		spineLevel: 'stage',
		interactive: false,
		stageRuns: [],
		isFuture: false,
		isCurrent: false,
		isDone: true,
	},
];

describe('LaneHistoryRow (M9-T21 / AC 6, E-314, E-325)', () => {
	it('AC 6 & E-325: renders folded row with fixed 6 segments when reworkCount < 1', () => {
		const html = renderToStaticMarkup(
			createElement(LaneHistoryRow, {
				taskKey: 'M9-T21',
				title: '任务流水线泳道与历史行',
				status: 'succeeded',
				reworkCount: 0,
				duration: 21000,
				stageRows: mockStageRows,
			}),
		);

		// 1. taskKey
		expect(html).toContain('data-field="history-task-key"');
		expect(html).toContain('M9-T21');

		// 2. 标题截断
		expect(html).toContain('data-field="history-task-title"');
		expect(html).toContain('任务流水线泳道与历史行');

		// 3. 终态徽标
		expect(html).toContain('完成');

		// 4. 第 N 轮（reworkCount=0 即第 1 轮，N < 2 时不显示，E-325）
		expect(html).not.toContain('data-field="history-round"');

		// 5. 总耗时
		expect(html).toContain('data-field="history-duration"');
		expect(html).toContain('21s');

		// 6. 「会话已归档」chip
		expect(html).toContain('data-chip="session-archived"');
		expect(html).toContain('会话已归档');
	});

	it('AC 6 & E-325: displays "第 2 轮" when reworkCount >= 1', () => {
		const html = renderToStaticMarkup(
			createElement(LaneHistoryRow, {
				taskKey: 'M9-T21',
				title: '测试任务',
				status: 'succeeded',
				reworkCount: 1,
				duration: 35000,
			}),
		);

		// N = reworkCount + 1 = 2 >= 2，必须显示
		expect(html).toContain('data-field="history-round"');
		expect(html).toContain('第 2 轮');
		expect(html).toContain('会话已归档');
	});

	it('E-325: wrapup history row displays "批次收口 · 第 N 轮 · 第 M 批" and verdict badge', () => {
		const html = renderToStaticMarkup(
			createElement(LaneHistoryRow, {
				isWrapup: true,
				wrapupRound: 2,
				wrapupBatchNo: 3,
				wrapupVerdict: 'clean',
				duration: 18000,
			}),
		);

		expect(html).toContain('批次收口 · 第 2 轮 · 第 3 批');
		expect(html).toContain('完成');
		expect(html).toContain('18s');
		expect(html).toContain('会话已归档');
	});

	it('AC 6 & E-314: expanding row renders readonly stage-chain with zero pulse-dot and no action buttons', () => {
		const html = renderToStaticMarkup(
			createElement(LaneHistoryRow, {
				taskKey: 'M9-T21',
				title: '历史任务',
				status: 'succeeded',
				reworkCount: 1,
				duration: 45000,
				stageRows: mockStageRows,
				defaultExpanded: true,
			}),
		);

		// 展开后出现 stage-chain，带有 data-readonly="true"
		expect(html).toContain('data-slot="history-stage-chain"');
		expect(html).toContain('data-component="stage-chain"');
		expect(html).toContain('data-readonly="true"');

		// 零连续呼吸脉冲环（零 pulse-dot variant="live"）
		expect(html).not.toContain('data-pulse="live"');

		// 无任何停止、重跑、回话动作按钮
		expect(html).not.toContain('data-action="stop-stream"');
		expect(html).not.toContain('data-action="retry"');
		expect(html).not.toContain('<input');
	});
});
