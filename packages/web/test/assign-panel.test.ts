/**
 * packages/web/test/assign-panel.test.tsx
 *
 * M9-T18 逐任务指派面板与并发瓶颈说明组件测试
 * 验收标准与边界测试（AC 1-4, E-108, E-31, E-47, E-52, E-254, E-34, E-35）
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
	AssignPanel,
	type AssignableAgent,
	CONCURRENCY_BOTTLENECK_TYPES,
	ConcurrencyBottleneckCard,
	type TaskAssignmentDraft,
	TaskAssignmentList,
	type TaskItem,
} from '../src/components/assign-panel.tsx';

describe('M9-T18 逐任务指派面板与并发瓶颈说明', () => {
	const mockTasks: readonly TaskItem[] = [
		{
			id: 'task-1',
			taskKey: 'M9-T1',
			title: 'Web 骨架与 token 层',
			moduleKey: 'M9',
		},
		{
			id: 'task-2',
			taskKey: 'M9-T2',
			title: '形状枚举与状态徽标',
			moduleKey: 'M9',
		},
		{
			id: 'task-3',
			taskKey: 'M9-T3',
			title: '自写 hash 路由与守卫',
			moduleKey: 'M9',
		},
	];

	const mockAgents: readonly AssignableAgent[] = [
		{
			id: 'codex',
			name: 'Codex',
			monogram: 'CX',
			maxConcurrency: 2,
			defaultModel: 'gpt-5-codex',
			supportsEffort: true,
			models: ['gpt-5-codex', 'gpt-5-mini'],
		},
		{
			id: 'grok',
			name: 'Grok',
			monogram: 'GK',
			maxConcurrency: 4,
			defaultModel: 'grok-beta',
			supportsEffort: false, // grok 不支持思考强度 (E-254)
			models: ['grok-beta', 'grok-fast'],
		},
		{
			id: 'claude',
			name: 'Claude Code',
			monogram: 'CC',
			maxConcurrency: 2,
			defaultModel: 'claude-3-5-sonnet',
			supportsEffort: true,
			models: ['claude-3-5-sonnet', 'claude-3-opus'],
		},
	];

	// ─────────────────────────────────────────────────────────────
	// 验收标准 1: 四步引导第三步是「逐任务指派」而不是「给整批选一个模型」
	// ─────────────────────────────────────────────────────────────
	describe('AC 1 & E-108: 逐任务指派而非整批套用，已指派行显示所选值可点回改', () => {
		it('渲染每行一个任务的独立指派表单，严禁整批统一套用按钮', () => {
			const html = renderToStaticMarkup(
				createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: mockAgents,
					assignments: {},
				}),
			);

			// 每行一个任务，独立渲染
			expect(html).toContain('data-task-editing-row="M9-T1"');
			expect(html).toContain('data-task-editing-row="M9-T2"');
			expect(html).toContain('data-task-editing-row="M9-T3"');

			// 各自拥有独立的下拉选择器
			expect(html).toContain('data-testid="select-agent-M9-T1"');
			expect(html).toContain('data-testid="select-agent-M9-T2"');
			expect(html).toContain('data-testid="select-agent-M9-T3"');

			// 确认没有全局一键批量套用整批的按钮
			expect(html).not.toContain('给整批统一应用');
			expect(html).not.toContain('整批一键套用');
			expect(html).toContain('逐任务独立指定，严禁整批统一套用');
		});

		it('已指派行清晰回显所选值，并提供修改指派（点回改）按钮', () => {
			const assignments: Record<string, TaskAssignmentDraft> = {
				'task-1': {
					taskId: 'task-1',
					taskKey: 'M9-T1',
					title: 'Web 骨架与 token 层',
					agentKey: 'codex',
					modelName: 'gpt-5-codex',
					effortTier: 'high',
					sessionIndex: 1,
				},
			};

			const html = renderToStaticMarkup(
				createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: mockAgents,
					assignments,
				}),
			);

			// task-1 渲染为已指派展示行
			expect(html).toContain('data-task-assigned-row="M9-T1"');
			expect(html).toContain('gpt-5-codex');
			expect(html).toContain('high');
			expect(html).toContain('CX'); // Monogram

			// 提供可点回改按钮
			expect(html).toContain('data-action="edit-assignment"');
			expect(html).toContain('修改指派');

			// task-2 与 task-3 仍为未指派的编辑行
			expect(html).toContain('data-task-editing-row="M9-T2"');
			expect(html).toContain('data-task-editing-row="M9-T3"');
		});

		it('不支持思考强度的 Agent 明确显示「—」，严禁补充伪造默认档 (M4-T6, E-254)', () => {
			// 将 grok (supportsEffort=false) 指派给任务
			const assignments: Record<string, TaskAssignmentDraft> = {
				'task-2': {
					taskId: 'task-2',
					taskKey: 'M9-T2',
					title: '形状枚举与状态徽标',
					agentKey: 'grok',
					modelName: 'grok-beta',
					effortTier: null,
					sessionIndex: 1,
				},
			};

			const secondTask = mockTasks[1];
			if (!secondTask) throw new Error('mockTasks[1] is missing');
			const html = renderToStaticMarkup(
				createElement(TaskAssignmentList, {
					tasks: [secondTask],
					agents: mockAgents,
					assignments,
				}),
			);

			expect(html).toContain('data-task-assigned-row="M9-T2"');
			// 思考强度显示「—」
			expect(html).toContain('思考: <span class="text-ink-1">—</span>');
		});
	});

	// ─────────────────────────────────────────────────────────────
	// 验收标准 2: 同一个 agent 允许被指派多次，每次是一个独立会话并显示将要使用的会话序号
	// ─────────────────────────────────────────────────────────────
	describe('AC 2 & E-31: 同一 agent 允许被指派多次，每次为独立会话并显示会话序号', () => {
		it('同一个 agent 被指派多次时，各自显示独立会话序号 (会话 #1, 会话 #2)', () => {
			const assignments: Record<string, TaskAssignmentDraft> = {
				'task-1': {
					taskId: 'task-1',
					taskKey: 'M9-T1',
					title: 'Web 骨架与 token 层',
					agentKey: 'codex',
					modelName: 'gpt-5-codex',
					effortTier: 'medium',
					sessionIndex: 1,
				},
				'task-2': {
					taskId: 'task-2',
					taskKey: 'M9-T2',
					title: '形状枚举与状态徽标',
					agentKey: 'codex', // 再次指派给 codex
					modelName: 'gpt-5-mini',
					effortTier: 'low',
					sessionIndex: 2,
				},
			};

			const html = renderToStaticMarkup(
				createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: mockAgents,
					assignments,
				}),
			);

			// task-1 为 Codex 会话 #1
			expect(html).toContain('data-session-badge="1"');
			expect(html).toContain('会话 #1');

			// task-2 同样指派给 Codex，显示独立会话 #2
			expect(html).toContain('data-session-badge="2"');
			expect(html).toContain('会话 #2');

			// task-3 还未指派，若选择 codex，将分配会话序号 #3
			expect(html).toContain('data-next-session-preview="3"');
			expect(html).toContain('将分配会话 #3');
		});

		it('不同 agent 的会话序号各自独立计算', () => {
			const assignments: Record<string, TaskAssignmentDraft> = {
				'task-1': {
					taskId: 'task-1',
					taskKey: 'M9-T1',
					title: 'Web 骨架与 token 层',
					agentKey: 'codex',
					modelName: 'gpt-5-codex',
					sessionIndex: 1,
				},
				'task-2': {
					taskId: 'task-2',
					taskKey: 'M9-T2',
					title: '形状枚举与状态徽标',
					agentKey: 'grok', // 换为 grok
					modelName: 'grok-beta',
					sessionIndex: 1, // grok 的第 1 个会话
				},
			};

			const html = renderToStaticMarkup(
				createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: mockAgents,
					assignments,
				}),
			);

			expect(html).toContain('会话 #1');
		});
	});

	// ─────────────────────────────────────────────────────────────
	// 验收标准 3: 第四步显示并发三者取 min 的结果，并明确指出哪一个是瓶颈 (E-52)
	// ─────────────────────────────────────────────────────────────
	describe('AC 3 & E-52: 并发三者取 min 与明确指出是并行窗口、agent 上限还是用户设定成了瓶颈', () => {
		it('显示有效并发容量为三者取 min 结果，并高亮指出「并行窗口数」瓶颈', () => {
			const html = renderToStaticMarkup(
				createElement(ConcurrencyBottleneckCard, {
					effectiveCapacity: 2,
					windowCount: 2,
					agentLimit: 4,
					userSetting: 3,
					bottleneckSource: CONCURRENCY_BOTTLENECK_TYPES.WINDOW_COUNT,
					bottleneckDescription: '受批次内依赖拓扑限制，最大并行窗口数为 2。',
				}),
			);

			// 有效并发容量为 2
			expect(html).toContain('data-testid="effective-capacity-value"');
			expect(html).toContain('2');

			// 三要素对比完整呈现
			expect(html).toContain('data-factor="window_count"');
			expect(html).toContain('data-factor="agent_limit"');
			expect(html).toContain('data-factor="user_setting"');

			// 高亮指出窗口数是瓶颈
			expect(html).toContain('data-testid="bottleneck-badge-window"');
			expect(html).toContain('data-testid="bottleneck-source-name"');
			expect(html).toContain('并行窗口数 (依赖拓扑)');
			expect(html).toContain('受批次内依赖拓扑限制，最大并行窗口数为 2。');
		});

		it('当 Agent 单体并发达到上限时，明确指出「Agent 基础上限」成了瓶颈', () => {
			const html = renderToStaticMarkup(
				createElement(ConcurrencyBottleneckCard, {
					effectiveCapacity: 1,
					windowCount: 4,
					agentLimit: 1,
					userSetting: 3,
					bottleneckSource: CONCURRENCY_BOTTLENECK_TYPES.AGENT_LIMIT,
				}),
			);

			expect(html).toContain('data-testid="bottleneck-badge-agent"');
			expect(html).toContain('Agent 单体并发上限');
			expect(html).toContain('所指派 Agent 的单体最大并发上限为 1');
		});

		it('当用户设定为最低时，明确指出「用户偏好设定」成了瓶颈', () => {
			const html = renderToStaticMarkup(
				createElement(ConcurrencyBottleneckCard, {
					effectiveCapacity: 1,
					windowCount: 4,
					agentLimit: 4,
					userSetting: 1,
					bottleneckSource: CONCURRENCY_BOTTLENECK_TYPES.USER_SETTING,
				}),
			);

			expect(html).toContain('data-testid="bottleneck-badge-user"');
			expect(html).toContain('用户设定并发上限');
			expect(html).toContain('受用户偏好设定上限 (1) 约束');
		});

		it('用户可向下调，向上超过窗口数需显式解锁并提示后果 (E-52)', () => {
			const html = renderToStaticMarkup(
				createElement(ConcurrencyBottleneckCard, {
					windowCount: 2,
					userSetting: 3, // 设定 3 > 窗口 2
					isUnlockedAboveWindow: true,
					onChangeUserSetting: vi.fn(),
					onToggleUnlockAboveWindow: vi.fn(),
				}),
			);

			// 包含调节按钮
			expect(html).toContain('data-action="decrease-user-setting"');
			expect(html).toContain('data-action="increase-user-setting"');

			// 包含显式解锁开关 (E-52)
			expect(html).toContain('data-action="toggle-unlock-above-window"');
			expect(html).toContain('显式解锁超过并行窗口数设定 (E-52)');

			// 向上超额时提示后果文案
			expect(html).toContain('data-testid="exceed-window-warning"');
			expect(html).toContain('后果提示');
			expect(html).toContain('并不会带来额外的物理并发加速');
		});

		it('缺失或 null 字段渲染为「—」，禁止前端造假 (07 节与 R4)', () => {
			const html = renderToStaticMarkup(
				createElement(ConcurrencyBottleneckCard, {
					effectiveCapacity: null,
					windowCount: null,
					agentLimit: null,
					userSetting: null,
					bottleneckSource: null,
				}),
			);

			expect(html).toContain('—');
			expect(html).not.toContain('null');
			expect(html).not.toContain('undefined');
		});
	});

	// ─────────────────────────────────────────────────────────────
	// 验收标准 4: 某 agent 已达并发上限时其余任务仍可指派给别家，不空转等待 (E-47)
	// ─────────────────────────────────────────────────────────────
	describe('AC 4 & E-47: 某 agent 已达并发上限时其余任务仍可指派给别家，不空转等待', () => {
		it('当 Codex 满额 (2/2) 时，其余未指派任务仍可正常指派给 Grok 或 Claude', () => {
			// Codex maxConcurrency = 2，已指派给 task-1 和 task-2
			const assignments: Record<string, TaskAssignmentDraft> = {
				'task-1': {
					taskId: 'task-1',
					taskKey: 'M9-T1',
					title: 'Web 骨架',
					agentKey: 'codex',
					modelName: 'gpt-5-codex',
					sessionIndex: 1,
				},
				'task-2': {
					taskId: 'task-2',
					taskKey: 'M9-T2',
					title: '状态徽标',
					agentKey: 'codex',
					modelName: 'gpt-5-mini',
					sessionIndex: 2,
				},
			};

			const html = renderToStaticMarkup(
				createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: mockAgents,
					assignments,
				}),
			);

			// 顶部容量指标标明 Codex 已满额
			expect(html).toContain('data-agent-capacity="codex"');
			expect(html).toContain('Codex: 2/2 (已满)');

			// 其他 Agent 如 Grok 依然充裕 (0/4)
			expect(html).toContain('data-agent-capacity="grok"');
			expect(html).toContain('Grok: 0/4');

			// task-3 仍处于编辑状态，提供选择 Grok / Claude 的能力，不会被禁用
			expect(html).toContain('data-task-editing-row="M9-T3"');
			expect(html).toContain('data-testid="select-agent-M9-T3"');
			expect(html).toContain('Grok (GK) — 0/4 [可用]');
			expect(html).toContain('Claude Code (CC) — 0/2 [可用]');
		});

		it('若继续选择已满额的 Agent，提示该 Agent 已满且说明空位顺延给其他 Agent 不空转等待', () => {
			const assignments: Record<string, TaskAssignmentDraft> = {
				'task-1': {
					taskId: 'task-1',
					taskKey: 'M9-T1',
					title: 'Web 骨架',
					agentKey: 'codex',
					modelName: 'gpt-5-codex',
					sessionIndex: 1,
				},
				'task-2': {
					taskId: 'task-2',
					taskKey: 'M9-T2',
					title: '状态徽标',
					agentKey: 'codex',
					modelName: 'gpt-5-mini',
					sessionIndex: 2,
				},
			};

			// task-3 默认选了 codex
			const thirdTask = mockTasks[2];
			if (!thirdTask) throw new Error('mockTasks[2] is missing');
			const tasksWithDefault = [
				...mockTasks.slice(0, 2),
				{ ...thirdTask, defaultAgentId: 'codex' },
			];

			const html = renderToStaticMarkup(
				createElement(TaskAssignmentList, {
					tasks: tasksWithDefault,
					agents: mockAgents,
					assignments,
				}),
			);

			// 呈现 E-47 提示警告
			expect(html).toContain('data-testid="agent-limit-warning"');
			expect(html).toContain('已达并发上限');
			expect(html).toContain('其余任务可继续指派给别家 Agent，不空转等待（E-47）');
		});
	});

	// ─────────────────────────────────────────────────────────────
	// AssignPanel 容器主组件形态与步骤适配 (step 2 & step 3)
	// ─────────────────────────────────────────────────────────────
	describe('AssignPanel 容器主组件适配四步引导的第 3 步与第 4 步', () => {
		it('step=2 或 mode="step3" 时仅渲染逐任务指派面板', () => {
			const html = renderToStaticMarkup(
				createElement(AssignPanel, {
					step: 2,
					tasks: mockTasks,
					agents: mockAgents,
				}),
			);

			expect(html).toContain('data-testid="task-assignment-list"');
			expect(html).not.toContain('data-testid="concurrency-bottleneck-card"');
		});

		it('step=3 或 mode="step4" 时仅渲染并发瓶颈审计卡片', () => {
			const html = renderToStaticMarkup(
				createElement(AssignPanel, {
					step: 3,
					effectiveCapacity: 2,
					windowCount: 2,
					agentLimit: 4,
					userSetting: 2,
					bottleneckSource: 'window_count',
				}),
			);

			expect(html).not.toContain('data-testid="task-assignment-list"');
			expect(html).toContain('data-testid="concurrency-bottleneck-card"');
		});

		it('mode="all" 时一体化渲染逐任务指派与并发说明两部分', () => {
			const html = renderToStaticMarkup(
				createElement(AssignPanel, {
					mode: 'all',
					tasks: mockTasks,
					agents: mockAgents,
					effectiveCapacity: 2,
					windowCount: 2,
					agentLimit: 4,
					userSetting: 2,
					bottleneckSource: 'window_count',
				}),
			);

			expect(html).toContain('data-testid="task-assignment-list"');
			expect(html).toContain('data-testid="concurrency-bottleneck-card"');
		});
	});
});
