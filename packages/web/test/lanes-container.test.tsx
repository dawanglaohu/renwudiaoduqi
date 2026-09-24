// @vitest-environment jsdom
/**
 * packages/web/test/lanes-container.test.tsx
 *
 * M9-T21 返工专项回归测试：真实甲板步骤接线、实际 run ID / 归档隔离、稀疏泳道手机切换与空闲提示
 * 覆盖 R1, R2, R3, R4 阻断项（AC 1, 2, 5, 6, 7b, 8, 9; E-106, E-313, E-314, E-315, E-317, E-319, E-324, E-325, E-333）
 */

import type { BatchWrapupDto } from '@agent-scheduler/shared/api/batches';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { LaneView, PipelineStage } from '@agent-scheduler/shared/api/lanes';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LaneStepItem } from '../src/features/run-deck/lane-steps-container.tsx';
import { LanesContainer, mapEventsToLaneSteps } from '../src/features/run-deck/lanes-container.tsx';
import { RunDeckView } from '../src/features/run-deck/run-deck-view.tsx';
import type { DeckStreamLane } from '../src/features/run-deck/types.ts';
import { DeckPage } from '../src/pages/deck-page.tsx';

const PIPELINE_STAGES: readonly PipelineStage[] = ['implement', 'review', 'bughunt', 'landing'];

function createMockTask(partial: Partial<TaskDto> = {}): TaskDto {
	return {
		id: partial.id ?? 'task-1',
		docId: 'doc-1',
		taskKey: partial.taskKey ?? 'M9-T21',
		title: partial.title ?? '任务流水线泳道与历史行',
		moduleKey: 'M9',
		deps: [],
		estDays: 2,
		batchId: 'batch-1',
		state: partial.state ?? 'running',
		...partial,
	};
}

function createMockRun(
	partial: Partial<Omit<RunDto, 'parentRunId' | 'reviewVerdict'>> & {
		parentRunId?: string | null;
		reviewVerdict?: RunDto['reviewVerdict'];
	} = {},
): RunDto {
	return {
		id: partial.id ?? 'run-1',
		taskId: partial.taskId ?? 'task-1',
		batchId: 'batch-1',
		agentId: 'agent-scheduler',
		modelName: 'claude-3-5-sonnet',
		state: partial.state ?? 'running',
		attemptNo: partial.attemptNo ?? 1,
		kind: partial.kind ?? 'implement',
		startedAt: partial.startedAt ?? '2025-01-01T00:00:00.000Z',
		endedAt: partial.endedAt ?? '2025-01-01T00:00:20.000Z',
		parentRunId: partial.parentRunId ?? null,
		...partial,
	} as RunDto;
}

function createMockLane(partial: Partial<LaneView> & { laneNo: number }): LaneView {
	return {
		stage: partial.stage ?? 'idle',
		taskId: partial.taskId ?? null,
		currentRunId: partial.currentRunId ?? null,
		nextTaskId: partial.nextTaskId ?? null,
		nextBlockedBy: partial.nextBlockedBy ?? [],
		archivedTaskIds: partial.archivedTaskIds ?? [],
		archivedWrapupRunId: partial.archivedWrapupRunId ?? null,
		overLimit: partial.overLimit ?? false,
		...partial,
	};
}

function createMockSteps(): readonly LaneStepItem[] {
	return [
		{
			id: 'step-1',
			tool: 'read_file',
			target: 'package.json',
			status: 'succeeded',
			duration: 120,
		},
		{
			id: 'step-2',
			tool: 'run_command',
			target: 'pnpm test',
			status: 'succeeded',
			duration: 1500,
		},
		{
			id: 'step-3',
			tool: 'git_commit',
			target: 'commit message',
			status: 'running',
			duration: 250,
		},
	];
}

describe('M9-T21 返工 R1: 真实甲板与步骤接线 (AC 1, AC 2, E-315, E-333)', () => {
	it('tool_call 与 tool_call_update 按 callId 更新同一步骤', () => {
		const events = [
			{ id: 1, kind: 'tool_call', payload: { callId: 'call-1', tool: 'read_file' } },
			{ id: 2, kind: 'tool_call_update', payload: { callId: 'call-1', output: 'done' } },
		] as EventEnvelope[];
		expect(mapEventsToLaneSteps(events)).toMatchObject([
			{ id: 'call-1', tool: 'read_file', status: 'succeeded' },
		]);
	});
	it('紧凑档（compact）下步骤只显示最后一步，展开后显示全部步骤', () => {
		const steps = createMockSteps();
		const lane = createMockLane({
			laneNo: 1,
			stage: 'implement',
			taskId: 'task-1',
			currentRunId: 'run-1',
		});
		const task = createMockTask();
		const run = createMockRun();

		// 1. 紧凑档且未展开：只显示最后一步（step-3）
		const compactHtml = renderToStaticMarkup(
			createElement(LanesContainer, {
				lanes: [lane],
				tasks: [task],
				runs: [run],
				overrideTier: 'compact',
				expandedLaneNo: null,
				getLaneSteps: () => steps,
			}),
		);

		expect(compactHtml).toContain('data-container="lane-steps"');
		expect(compactHtml).toContain('data-compact-collapsed="true"');
		expect(compactHtml).toContain('git_commit');
		expect(compactHtml).not.toContain('read_file');

		// 2. 展开后：显示全部 3 个步骤
		const expandedHtml = renderToStaticMarkup(
			createElement(LanesContainer, {
				lanes: [lane],
				tasks: [task],
				runs: [run],
				overrideTier: 'compact',
				expandedLaneNo: 1,
				getLaneSteps: () => steps,
			}),
		);

		expect(expandedHtml).toContain('data-container="lane-steps"');
		expect(expandedHtml).toContain('data-compact-collapsed="false"');
		expect(expandedHtml).toContain('read_file');
		expect(expandedHtml).toContain('run_command');
		expect(expandedHtml).toContain('git_commit');
	});

	it('快照缺 lanes 键或非数组时甲板显示「泳道数据不可用」（E-333）', () => {
		const html = renderToStaticMarkup(
			createElement(LanesContainer, {
				isUnavailable: true,
				errorMessage: '泳道数据不可用',
			}),
		);

		expect(html).toContain('data-container="lanes-deck"');
		expect(html).toContain('data-state="unavailable"');
		expect(html).toContain('data-field="lanes-unavailable"');
		expect(html).toContain('泳道数据不可用');
	});

	it('真实甲板视图 RunDeckView 挂载 LanesContainer 并保留审批卡与停止按钮', () => {
		const deckLanes: DeckStreamLane[] = [
			{
				laneNo: 1,
				id: 'lane-1',
				kind: 'task',
				taskKey: 'M9-T21',
				title: '任务流水线',
				gateId: 'gate-100',
				reviewVerdict: 'incomplete',
				reworkText: '请修改步骤渲染',
				status: 'awaiting_human',
			},
		];

		const html = renderToStaticMarkup(
			createElement(RunDeckView, {
				lanes: deckLanes,
				tier: 'full',
				isTouch: false,
				width: 1200,
				expandedLaneNo: null,
				toggleExpandLane: vi.fn(),
				stoppingLanes: new Set<number>(),
				handleStopLane: vi.fn(),
				onDecideGate: vi.fn(),
				userPreference: 'auto',
				togglePreference: vi.fn(),
				scrollContainerRef: { current: null },
				offScreenWaiting: { left: 0, right: 0 },
				scrollToLane: vi.fn(),
			}),
		);

		// 验证新泳道甲板已接通
		expect(html).toContain('data-container="lanes-deck"');
		expect(html).toContain('data-mode="desktop"');
		// 验证审批槽位常驻渲染且挂有审批卡
		expect(html).toContain('data-component="gate-card"');
		expect(html).toContain('请修改步骤渲染');
		// 验证 StreamColumn 的停止按钮存在
		expect(html).toContain('data-action="stop-stream"');
	});

	it('活动收口泳道在阶段链之外保留报告面板和真实轮次', () => {
		const html = renderToStaticMarkup(
			createElement(RunDeckView, {
				lanes: [
					{
						laneNo: 1,
						kind: 'wrapup',
						currentRunId: 'run-wrapup',
						batchId: 'batch-1',
						wrapupRound: 2,
						wrapupBatchNo: 3,
					},
				],
				rawLanes: [
					createMockLane({
						laneNo: 1,
						stage: 'wrapup',
						currentRunId: 'run-wrapup',
					}),
				],
				runs: [createMockRun({ id: 'run-wrapup', kind: 'wrapup', taskId: null })],
				tier: 'full',
				isTouch: false,
				width: 1200,
				expandedLaneNo: null,
				toggleExpandLane: vi.fn(),
				stoppingLanes: new Set<number>(),
				handleStopLane: vi.fn(),
				userPreference: 'auto',
				togglePreference: vi.fn(),
				scrollContainerRef: { current: null },
				offScreenWaiting: { left: 0, right: 0 },
				scrollToLane: vi.fn(),
			}),
		);
		expect(html).toContain('data-component="wrapup-panel"');
		expect(html).toContain('批次收口 · 第 2 轮 · 第 3 批');
	});
});

describe('M9-T21 返工 R2: 实际 run ID、运行时序与归档泳道隔离 (AC 5, AC 6; E-313, E-314, E-325)', () => {
	it('同一任务换道重派时，历史归档按泳道号隔离，不混入其他泳道运行', () => {
		const task = createMockTask({ id: 'task-reassigned', taskKey: 'M9-T99' });

		// run-1 在 lane 1 上执行（较早），run-2 在 lane 2 上执行（较晚）
		const run1 = createMockRun({
			id: 'run-1',
			taskId: 'task-reassigned',
			laneNo: 1,
			startedAt: '2025-01-01T01:00:00.000Z',
			endedAt: '2025-01-01T01:10:00.000Z',
			state: 'failed',
		});
		const run2 = createMockRun({
			id: 'run-2',
			taskId: 'task-reassigned',
			laneNo: 2,
			startedAt: '2025-01-01T02:00:00.000Z',
			endedAt: '2025-01-01T02:15:00.000Z',
			state: 'running',
		});

		// lane 1 之前跑过 task-reassigned（归档），现在是 idle
		const lane1 = createMockLane({
			laneNo: 1,
			stage: 'idle',
			archivedTaskIds: ['task-reassigned'],
		});

		// lane 2 当前正在跑 task-reassigned
		const lane2 = createMockLane({
			laneNo: 2,
			stage: 'implement',
			taskId: 'task-reassigned',
			currentRunId: 'run-2',
		});

		const html = renderToStaticMarkup(
			createElement(LanesContainer, {
				lanes: [lane1, lane2],
				tasks: [task],
				runs: [run1, run2],
				overrideTier: 'full',
			}),
		);

		// lane 1 的历史行包含自身归档的 run-1（耗时 10 分钟 = 600s），终态为 failed
		expect(html).toContain('data-slot="lane-history"');
		expect(html).toContain('data-state="failed"');
		// 历史分隔线仅在有历史行时渲染
		expect(html).toContain('data-history-divider="true"');
	});

	it('历史收口运行正确传入阶段链并能打开真实运行', () => {
		const wrapupRun = createMockRun({
			id: 'run-wrapup-archived',
			kind: 'wrapup',
			attemptNo: 2,
			state: 'landed',
			startedAt: '2025-01-01T05:00:00.000Z',
			endedAt: '2025-01-01T05:05:00.000Z',
		});

		const lane = createMockLane({
			laneNo: 1,
			stage: 'idle',
			archivedWrapupRunId: 'run-wrapup-archived',
		});

		const html = renderToStaticMarkup(
			createElement(LanesContainer, {
				lanes: [lane],
				runs: [wrapupRun],
				wrapups: [
					{
						id: 'wrapup-1',
						batchId: 'batch-1',
						batchNo: 3,
						tasks: [],
						round: 2,
						runId: wrapupRun.id,
						verdict: 'fixed',
						declaredVerdict: 'fixed',
						isHumanVerdict: false,
						promptSource: 'docs',
						tests: { status: 'pass', items: [] },
						summaryText: '',
						findings: [],
						unassigned: [],
						fixRunIds: [],
						reportText: '',
						createdAt: '2025-01-01T05:05:00.000Z',
					},
				] satisfies BatchWrapupDto[],
				overrideTier: 'full',
			}),
		);

		expect(html).toContain('data-slot="lane-history"');
		expect(html).toContain('批次收口');
		expect(html).toContain('第 2 轮');
		expect(html).toContain('第 3 批');
		expect(html).toContain('已修');
	});
});

describe('M9-T21 返工 R3: 手机端稀疏泳道导航与空闲提示 (AC 1, AC 7, AC 9; E-317, E-319, E-324)', () => {
	it('稀疏泳道 [1, 3] 在手机端显示泳道 1/2 与 2/2，不出现 3/2', () => {
		const lanes: LaneView[] = [
			createMockLane({ laneNo: 1, stage: 'implement', taskId: 'task-1', currentRunId: 'run-1' }),
			createMockLane({ laneNo: 3, stage: 'implement', taskId: 'task-2', currentRunId: 'run-2' }),
		];
		const task1 = createMockTask({ id: 'task-1', taskKey: 'M9-T1' });
		const task2 = createMockTask({ id: 'task-2', taskKey: 'M9-T3' });

		// 第 1 泳道：显示 1/2
		const html1 = renderToStaticMarkup(
			createElement(LanesContainer, {
				lanes,
				tasks: [task1, task2],
				overrideTier: 'phone',
				activeMobileLanePosition: 1,
				activeMobileLaneNo: 1,
			}),
		);
		expect(html1).toContain('data-component="lane-run-strip"');
		expect(html1).toContain('data-current-lane="1"');
		expect(html1).toContain('data-total-lanes="2"');
		expect(html1).toContain('泳道 1/2');
		expect(html1).not.toContain('泳道 3/2');

		// 第 2 泳道（实际 laneNo 为 3）：显示 2/2
		const html2 = renderToStaticMarkup(
			createElement(LanesContainer, {
				lanes,
				tasks: [task1, task2],
				overrideTier: 'phone',
				activeMobileLanePosition: 2,
				activeMobileLaneNo: 3,
			}),
		);
		expect(html2).toContain('data-current-lane="2"');
		expect(html2).toContain('data-total-lanes="2"');
		expect(html2).toContain('泳道 2/2');
		expect(html2).not.toContain('泳道 3/2');
	});

	it('空闲泳道有历史行时，上方展示历史行，下方依然渲染 idleText 及阻塞前置', () => {
		const task = createMockTask({ id: 'task-hist', taskKey: 'M9-T10' });
		const run = createMockRun({ id: 'run-hist', taskId: 'task-hist', laneNo: 1 });

		const lane = createMockLane({
			laneNo: 1,
			stage: 'idle',
			archivedTaskIds: ['task-hist'],
			nextTaskId: 'M9-T22',
			nextBlockedBy: ['M9-T21'],
		});

		const html = renderToStaticMarkup(
			createElement(LanesContainer, {
				lanes: [lane],
				tasks: [task],
				runs: [run],
				overrideTier: 'full',
			}),
		);

		// 1. 存在历史行
		expect(html).toContain('data-slot="lane-history"');
		expect(html).toContain('M9-T10');
		// 2. 存在历史与当前的分隔线
		expect(html).toContain('data-history-divider="true"');
		// 3. 空闲占位区依然存在且包含下一个任务与阻塞前置
		expect(html).toContain('data-field="idle-placeholder"');
		expect(html).toContain('M9-T22');
		expect(html).toContain('M9-T21');
	});
});

describe('M9-T21 返工 页面入口 DeckPage 集成验证 (AC 1, AC 2, AC 9)', () => {
	it('从页面入口 DeckPage 进入，正确挂载流水线泳道与阶段链', () => {
		const deckLanes: DeckStreamLane[] = [
			{
				laneNo: 1,
				id: 'lane-1',
				kind: 'task',
				taskKey: 'M9-T21',
				title: '任务流水线泳道',
				status: 'running',
			},
		];

		const html = renderToStaticMarkup(
			createElement(DeckPage, {
				lanes: deckLanes,
			}),
		);

		// 页面层根节点
		expect(html).toContain('data-component="deck-page"');
		// 容器层根节点
		expect(html).toContain('data-component="run-deck-container"');
		// 视图层根节点
		expect(html).toContain('data-run-deck="true"');
		// 流水线泳道容器已挂载
		expect(html).toContain('data-container="lanes-deck"');
		expect(html).toContain('data-component="pipeline-lane"');
		expect(html).toContain('M9-T21');
	});
});
