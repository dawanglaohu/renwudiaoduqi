import type { LaneView, PipelineStage } from '@agent-scheduler/shared/api/lanes';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PipelineLane } from '../src/components/pipeline-lane.tsx';
import type { DensityTier } from '../src/hooks/use-breakpoint.ts';

const PIPELINE_STAGES: readonly PipelineStage[] = ['implement', 'review', 'bughunt', 'landing'];

const TIERS: readonly DensityTier[] = ['full', 'compact', 'narrow', 'phone', 'phone-xs'];
const STATES = ['running', 'idle', 'overLimit', 'wrapup'] as const;

function createMockLane(partial: Partial<LaneView> = {}): LaneView {
	return {
		laneNo: 1,
		taskId: 'task-1',
		currentRunId: 'run-1',
		stage: 'implement',
		nextTaskId: null,
		nextBlockedBy: [],
		archivedTaskIds: [],
		archivedWrapupRunId: null,
		overLimit: false,
		...partial,
	};
}

function createMockTask(partial: Partial<TaskDto> = {}): TaskDto {
	return {
		id: 'task-1',
		docId: 'doc-1',
		taskKey: 'M9-T21',
		title: '任务流水线泳道与历史行',
		moduleKey: 'M9',
		deps: [],
		estDays: 2,
		batchId: 'batch-1',
		state: 'running',
		...partial,
	};
}

function createMockRun(partial: Partial<RunDto> = {}): RunDto {
	const startedAt = partial.startedAt ?? '2025-01-01T00:00:00.000Z';
	const endedAt = partial.endedAt ?? '2025-01-01T00:00:15.000Z';

	return {
		id: partial.id ?? 'run-1',
		taskId: partial.taskId ?? 'task-1',
		kind: partial.kind ?? 'implement',
		state: partial.state ?? 'running',
		attemptNo: partial.attemptNo ?? 1,
		startedAt,
		endedAt,
		lastEventAt: endedAt,
		reworkCount: partial.reworkCount ?? 0,
		parentRunId: partial.parentRunId ?? null,
		agentId: 'agent-1',
		modelName: null,
		reportedModel: null,
		effortTier: null,
		reportedEffort: null,
		permissionTier: 'readOnly',
		worktreePath: null,
		branchName: null,
		pid: null,
		exitCode: null,
		exitSignal: null,
		changedFileCount: null,
		tokenUsage: null,
		isStallSuspected: false,
		queuedReason: null,
		idempotencyKey: 'idem-1',
		actorDeviceId: null,
		reviewVerdict: null,
		...partial,
	} as RunDto;
}

describe('PipelineLane: Resident stop button matrix (AC 8, E-106, E-236)', () => {
	// ─── 5 档 × {running, idle, overLimit, wrapup} = 20-cell 矩阵断言停止键常驻存在 ───
	for (const tier of TIERS) {
		for (const state of STATES) {
			it(`tier=${tier} × state=${state}: stop button must exist on PipelineLane`, () => {
				const isIdle = state === 'idle';
				const isWrapup = state === 'wrapup';
				const isOverLimit = state === 'overLimit';

				const lane = createMockLane({
					stage: isWrapup ? 'wrapup' : isIdle ? 'idle' : 'implement',
					taskId: isIdle ? null : isWrapup ? null : 'task-1',
					currentRunId: isIdle ? null : 'run-1',
					overLimit: isOverLimit,
				});

				const task = isIdle || isWrapup ? null : createMockTask();
				const runs = isIdle ? [] : [createMockRun({ kind: isWrapup ? 'wrapup' : 'implement' })];

				const html = renderToStaticMarkup(
					createElement(PipelineLane, {
						lane,
						task,
						runs,
						stageOrder: PIPELINE_STAGES,
						tier,
					}),
				);

				expect(html).toContain('data-action="stop-stream"');
				expect(html).toContain('data-resident="true"');

				// 空闲态时停止键应处于禁用置灰态（AC 7, E-319）
				if (isIdle) {
					expect(html).toContain('disabled=""');
				}
			});
		}
	}
});

describe('PipelineLane: Feature semantics and edge cases (AC 1, 5, 6, 7, E-309, E-313, E-314, E-319, E-325)', () => {
	it('AC 6 & E-325: lane first task has NO history row and NO separator line', () => {
		const lane = createMockLane({
			archivedTaskIds: [],
			archivedWrapupRunId: null,
		});

		const html = renderToStaticMarkup(
			createElement(PipelineLane, {
				lane,
				task: createMockTask(),
				runs: [createMockRun()],
				stageOrder: PIPELINE_STAGES,
			}),
		);

		// 泳道首个任务：不渲染历史行与分隔线（E-314、E-325）
		expect(html).not.toContain('data-slot="lane-history"');
		expect(html).not.toContain('data-history-divider="true"');
		expect(html).toContain('data-component="stage-chain"');
	});

	it('AC 6 & E-325: subsequent task renders history row and divider', () => {
		const lane = createMockLane({
			archivedTaskIds: ['task-archived-1'],
		});

		const historyTask = createMockTask({
			id: 'task-archived-1',
			taskKey: 'M9-T20',
			title: '收口泳道',
			state: 'landed',
		});

		const html = renderToStaticMarkup(
			createElement(PipelineLane, {
				lane,
				task: createMockTask(),
				runs: [createMockRun()],
				stageOrder: PIPELINE_STAGES,
				historyTask,
				historyRuns: [createMockRun({ id: 'run-archived-1', taskId: 'task-archived-1' })],
			}),
		);

		// 必须渲染历史行与分隔线
		expect(html).toContain('data-slot="lane-history"');
		expect(html).toContain('data-history-divider="true"');
		expect(html).toContain('M9-T20');
		expect(html).toContain('会话已归档');
	});

	it('AC 7 & E-319: idle lane renders idleText, does NOT draw fake stage chain, and stop button is greyed out', () => {
		const lane = createMockLane({
			stage: 'idle',
			taskId: null,
			currentRunId: null,
			nextTaskId: 'M9-T22',
			nextBlockedBy: ['M9-T21'],
		});

		const html = renderToStaticMarkup(
			createElement(PipelineLane, {
				lane,
				stageOrder: PIPELINE_STAGES,
			}),
		);

		// 渲染提示文案
		expect(html).toContain('空闲 · 队列下一个是 M9-T22（等 M9-T21 落地）');

		// 不画假阶段链（AC 7）
		expect(html).not.toContain('data-component="stage-chain"');

		// 停止键置灰保持原位
		expect(html).toContain('data-action="stop-stream"');
		expect(html).toContain('disabled=""');
	});

	it('AC 7 & E-309: overLimit=true renders "超出窗口数" chip in lane header', () => {
		const lane = createMockLane({
			overLimit: true,
		});

		const html = renderToStaticMarkup(
			createElement(PipelineLane, {
				lane,
				task: createMockTask(),
				runs: [createMockRun()],
				stageOrder: PIPELINE_STAGES,
			}),
		);

		expect(html).toContain('data-chip="over-limit"');
		expect(html).toContain('超出窗口数');
	});

	it('AC 5 & E-313: stage nodes have interactive role and runId tabIndex', () => {
		const lane = createMockLane({
			stage: 'review',
		});

		const runs = [
			createMockRun({ id: 'run-impl-latest', kind: 'implement' }),
			createMockRun({ id: 'run-rev-latest', kind: 'review' }),
		];

		const html = renderToStaticMarkup(
			createElement(PipelineLane, {
				lane,
				task: createMockTask(),
				runs,
				stageOrder: PIPELINE_STAGES,
				onOpenRun: () => {},
			}),
		);

		expect(html).toContain('role="button"');
		expect(html).toContain('tabindex="0"');
		expect(html).toContain('实施');
		expect(html).toContain('审查');
	});

	// ─── R3: 空闲且有历史行时仍展示 idleText ───
	it('R3 & E-319: idle lane with history row STILL renders idleText with next task and blocked-by info', () => {
		const lane = createMockLane({
			stage: 'idle',
			taskId: null,
			currentRunId: null,
			nextTaskId: 'M9-T22',
			nextBlockedBy: ['M9-T21'],
			archivedTaskIds: ['task-old'],
		});

		const html = renderToStaticMarkup(
			createElement(PipelineLane, {
				lane,
				historyTask: createMockTask({ id: 'task-old', taskKey: 'M9-T20', title: '收口泳道' }),
				historyRuns: [createMockRun({ taskId: 'task-old', state: 'landed' })],
				stageOrder: PIPELINE_STAGES,
			}),
		);

		// 必须同时包含历史行和空闲提示（R3）
		expect(html).toContain('data-slot="lane-history"');
		expect(html).toContain('data-field="idle-placeholder"');
		expect(html).toContain('M9-T22');
		expect(html).toContain('M9-T21');
	});

	// ─── R2: 历史收口运行绑定到历史阶段链 ───
	it('R2 & E-325: archived wrapup run binds to history stage chain allowing onOpenRun', () => {
		const wrapupRun = createMockRun({
			id: 'run-wrapup-archived-99',
			kind: 'wrapup',
			state: 'exited',
			reviewVerdict: 'pass',
		});

		const lane = createMockLane({
			stage: 'idle',
			taskId: null,
			currentRunId: null,
			archivedWrapupRunId: 'run-wrapup-archived-99',
		});

		const html = renderToStaticMarkup(
			createElement(PipelineLane, {
				lane,
				historyWrapupRun: wrapupRun,
				stageOrder: PIPELINE_STAGES,
				defaultHistoryExpanded: true,
				onOpenRun: () => {},
			}),
		);

		expect(html).toContain('data-slot="lane-history"');
		expect(html).toContain('批次收口');
		// 历史阶段链展开后必须包含收口阶段节点且具备可点击 button 角色（支持 onOpenRun）
		expect(html).toContain('data-stage-row="wrapup"');
		expect(html).toContain('role="button"');
	});

	// ─── R2: 历史折叠行终态取归档运行自身，不取 TaskDto 当前状态（避免跨道重派两处呼吸） ───
	it('R2 & E-325: history row status derives from archived runs, not TaskDto state (prevents double breathing)', () => {
		const lane = createMockLane({
			laneNo: 1,
			stage: 'idle',
			taskId: null,
			currentRunId: null,
			archivedTaskIds: ['task-reassigned'],
		});

		// 任务在别的泳道被重派，TaskDto.state 当前是 'running'
		const taskDto = createMockTask({
			id: 'task-reassigned',
			state: 'running',
		});

		// 但在本泳道跑过的归档运行是 failed
		const historyRuns = [
			createMockRun({
				id: 'run-archived-f1',
				taskId: 'task-reassigned',
				laneNo: 1,
				state: 'failed',
			}),
		];

		const html = renderToStaticMarkup(
			createElement(PipelineLane, {
				lane,
				historyTask: taskDto,
				historyRuns,
				stageOrder: PIPELINE_STAGES,
			}),
		);

		// 历史折叠行必须展示 failed 状态，绝不展示 running
		expect(html).toContain('data-slot="lane-history"');
		expect(html).toContain('data-state="failed"');
		expect(html).not.toContain('data-state="running"');
	});
});
