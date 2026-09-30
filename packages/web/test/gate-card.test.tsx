// @vitest-environment jsdom
/**
 * packages/web/test/gate-card.test.tsx
 *
 * M9-T23 零产出退出审批卡单元测试（AC 6, E-348, E-359）
 */

import type { LoginState } from '@agent-scheduler/shared/api/agents';
import type { GateDto } from '@agent-scheduler/shared/api/gates';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { httpClient } from '../src/api/http-client.ts';
import { GateCard } from '../src/components/gate-card.tsx';
import * as batchExpansion from '../src/features/run-deck/batch-expansion.ts';
import { TaskApprovalCard } from '../src/features/run-deck/run-deck-view.tsx';
import { useGateCard } from '../src/features/run-deck/use-gate-card.ts';
import { UI_STRINGS } from '../src/i18n/ui-strings.ts';
import { useSelectionStore } from '../src/store/selection-store.ts';

beforeEach(() => {
	useSelectionStore.getState().reset();
});

const mockLogin: LoginState = {
	state: 'logged_out',
	checkedAt: new Date().toISOString(),
	loginCommand: 'claude login',
	providers: {},
};

describe('GateCard Zero-Output Context (M9-T23 / AC 6, E-348, E-359)', () => {
	it('renders four-segment layout when context is non-null (AC 6)', () => {
		const html = renderToStaticMarkup(
			<GateCard
				taskKey="M9-T23"
				context={{
					exitCode: 1,
					stderrTail: {
						kind: 'lines',
						lines: ['line 1', 'error with [REDACTED] credential', 'line 3'],
					},
					login: mockLogin,
				}}
				onApprove={() => {}}
				onEdit={() => {}}
				onReject={() => {}}
			/>,
		);

		// 第 1 段：标题
		expect(html).toContain(UI_STRINGS.gateCard.zeroOutputTitle);

		// 第 2 段：退出码大数与固定提示句
		expect(html).toContain('exit: 1');
		expect(html).toContain(UI_STRINGS.gateCard.zeroOutputHint);

		// 第 3 段：stderr 诊断记录与脱敏替换
		expect(html).toContain(UI_STRINGS.gateCard.stderrTitle);
		expect(html).toContain('error with [已脱敏] credential');

		// 登录态徽标行
		expect(html).toContain(UI_STRINGS.gateCard.loginProbe);
		expect(html).toContain('data-testid="login-badge"');
		expect(html).toContain(UI_STRINGS.login.loggedOut);

		// 第 4 段：三动作 [重跑][换 agent 重派][标失败]
		expect(html).toContain(UI_STRINGS.gateCard.rerun);
		expect(html).toContain(UI_STRINGS.gateCard.reassign);
		expect(html).toContain(UI_STRINGS.gateCard.markFailed);
		expect(html).toContain('data-action="approve"');
	});

	it('handles stderr three states: noStderr, legacy_run, event_missing (AC 6, E-348, E-359)', () => {
		// 1. 无 stderr 输出
		const html1 = renderToStaticMarkup(
			<GateCard
				context={{
					exitCode: 0,
					stderrTail: { kind: 'lines', lines: [] },
				}}
			/>,
		);
		expect(html1).toContain(UI_STRINGS.gateCard.noStderr);

		// 2. legacy_run -> 无记录（旧运行）
		const html2 = renderToStaticMarkup(
			<GateCard
				context={{
					exitCode: 1,
					stderrTail: { kind: 'unavailable', reason: 'legacy_run' },
				}}
			/>,
		);
		expect(html2).toContain(UI_STRINGS.gateCard.legacyRun);

		// 3. event_missing -> 事件缺失
		const html3 = renderToStaticMarkup(
			<GateCard
				context={{
					exitCode: 1,
					stderrTail: { kind: 'unavailable', reason: 'event_missing' },
				}}
			/>,
		);
		expect(html3).toContain(UI_STRINGS.gateCard.eventMissing);

		// 4. stderrTail 为 null -> 事件缺失
		const html4 = renderToStaticMarkup(
			<GateCard
				context={{
					exitCode: 1,
					stderrTail: null,
				}}
			/>,
		);
		expect(html4).toContain(UI_STRINGS.gateCard.eventMissing);
	});

	it('hides second action and folds lines to 5 in phone view (AC 6, E-359)', () => {
		const longLines = Array.from({ length: 12 }, (_, i) => `log line ${i + 1}`);

		const html = renderToStaticMarkup(
			<GateCard
				tier="phone"
				context={{
					exitCode: 1,
					stderrTail: { kind: 'lines', lines: longLines },
				}}
			/>,
		);

		// phone 档不渲染第二个动作「换 agent 重派」（E-359）
		expect(html).not.toContain(UI_STRINGS.gateCard.reassign);
		// 动作 1 和 动作 3 依然存在
		expect(html).toContain(UI_STRINGS.gateCard.rerun);
		expect(html).toContain(UI_STRINGS.gateCard.markFailed);

		// 包含展开按钮
		expect(html).toContain(UI_STRINGS.gateCard.expandLines);
	});

	it('keeps verbatim behavior when context is null (AC 6)', () => {
		const html = renderToStaticMarkup(
			<GateCard
				taskKey="M9-T10"
				gateKind="review"
				title="测试常规审批"
				impactValue={5}
				impactUnit="个文件"
			/>,
		);

		// 常规标题与数值
		expect(html).toContain('测试常规审批');
		expect(html).toContain('5');
		expect(html).toContain('个文件');

		// 不应有零产出特征
		expect(html).not.toContain(UI_STRINGS.gateCard.zeroOutputTitle);
		expect(html).not.toContain(UI_STRINGS.gateCard.zeroOutputHint);
	});
});

describe('useGateCard hook actions (AC 6, E-348, E-359)', () => {
	it('handleReassign expands batch and calls selectionStore.openReassign', () => {
		const expandSpy = vi.spyOn(batchExpansion, 'expandBatch');
		useSelectionStore.getState().setTaskFilter('foo');

		let hookResult: ReturnType<typeof useGateCard> | undefined;
		function TestComponent() {
			hookResult = useGateCard({
				runId: 'run-1',
				taskId: 'task-10',
				batchId: 'batch-2',
				snapshotAgentId: 'agent-cx',
			});
			return null;
		}

		renderToStaticMarkup(createElement(TestComponent));

		hookResult?.handleReassign();

		// 1. expandBatch 展开所在批次
		expect(expandSpy).toHaveBeenCalledWith('batch-2');

		// 2. selectionStore.openReassign 清除筛选并记录重派任务
		const state = useSelectionStore.getState();
		expect(state.taskFilter).toBe('');
		expect(state.reassignTaskId).toBe('task-10');
		expect(state.reassignToast).toBe('已清除筛选以定位 task-10');
		expect(state.assignments['task-10']?.agentId).toBe('agent-cx');
	});
});

describe('R3: production task approval assembly', () => {
	const task: TaskDto = {
		id: 'task-zero',
		taskKey: 'ZERO-T1',
		title: 'Zero task',
		docId: 'doc-zero',
		batchId: 'batch-zero',
		state: 'awaiting_human',
		deps: [],
		moduleKey: 'M9',
		estDays: 1,
	};
	const gate: GateDto = {
		id: 'gate-zero',
		taskId: task.id,
		runId: 'run-zero',
		kind: 'review',
		state: 'waiting',
		decision: null,
		comment: null,
		decidedByDeviceId: null,
		createdAt: '2026-09-30',
		decidedAt: null,
		context: {
			exitCode: 1,
			exitSignal: null,
			stderrTail: { kind: 'lines', lines: ['invalid model'] },
			login: null,
		},
	};
	it('rerun uses its run route; reassign expands before navigation; failure waits for confirmation', async () => {
		const call = vi.spyOn(httpClient, 'callRoute').mockResolvedValue({});
		const decide = vi.fn();
		const order: string[] = [];
		const expand = vi.spyOn(batchExpansion, 'expandBatch').mockImplementation(() => {
			order.push('expand');
		});
		const open = vi.spyOn(useSelectionStore.getState(), 'openReassign').mockImplementation(() => {
			order.push('open');
		});
		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				createElement(TaskApprovalCard, {
					gate,
					task,
					runs: [],
					tier: 'full',
					isMobileMode: false,
					isTouch: false,
					onDecideGate: decide,
				}),
			);
		});
		expect(document.activeElement).toBe(container.querySelector('[data-action="approve"]'));
		await act(async () => {
			container.querySelector<HTMLButtonElement>('[data-action="approve"]')?.click();
		});
		expect(call).toHaveBeenCalledTimes(1);
		expect(call.mock.calls[0]?.[0].path).toBe('/api/v1/runs/:runId/rerun');
		expect(call.mock.calls[0]?.[1]?.params).toEqual({ runId: 'run-zero' });
		expect(decide).not.toHaveBeenCalled();
		await act(async () => {
			container.querySelector<HTMLButtonElement>('[data-action="edit"]')?.click();
		});
		expect(order).toEqual(['expand', 'open']);
		expect(expand).toHaveBeenCalledWith(task.batchId);
		expect(open).toHaveBeenCalledWith(task.id, null);
		expect(decide).not.toHaveBeenCalled();
		await act(async () => {
			container.querySelector<HTMLButtonElement>('[data-action="reject"]')?.click();
		});
		expect(decide).not.toHaveBeenCalled();
		await act(async () => {
			container.querySelector<HTMLButtonElement>('[data-testid="confirm-reject"]')?.click();
		});
		expect(decide).toHaveBeenCalledWith(gate.id, 'reject');
		expect(call).toHaveBeenCalledTimes(1);
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
	});
	it('ordinary approval and edit keep their gate decisions and never rerun', async () => {
		const call = vi.spyOn(httpClient, 'callRoute').mockResolvedValue({});
		const decide = vi.fn();
		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				createElement(TaskApprovalCard, {
					gate: { ...gate, context: null },
					task,
					runs: [],
					tier: 'full',
					isMobileMode: false,
					isTouch: false,
					onDecideGate: decide,
				}),
			);
		});
		await act(async () => {
			container.querySelector<HTMLButtonElement>('[data-action="approve"]')?.click();
			container.querySelector<HTMLButtonElement>('[data-action="edit"]')?.click();
		});
		expect(decide.mock.calls).toEqual([
			[gate.id, 'pass'],
			[gate.id, 'reject', '改一下'],
		]);
		expect(call).not.toHaveBeenCalled();
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
	});
});
