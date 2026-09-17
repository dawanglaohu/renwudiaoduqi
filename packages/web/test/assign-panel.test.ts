/**
 * packages/web/test/assign-panel.test.ts
 *
 * M9-T18 逐任务指派面板与并发瓶颈说明组件测试
 * 验收标准与边界测试（AC 1-4, E-108, E-31, E-47, E-52, E-254, E-34, E-35）
 * 包含返工第 1 轮 R1（删除组件层补算/缺失显示「—」）、R2（EmptyOnboarding 槽位接入）、R3（focus-visible 与 44px 触控/键盘证据）
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
import { EmptyOnboarding } from '../src/components/empty-onboarding.tsx';

describe('M9-T18 逐任务指派面板与并发瓶颈说明', () => {
	const mockTasks: readonly TaskItem[] = [
		{
			id: 'task-1',
			taskKey: 'M9-T1',
			title: 'Web 骨架与 token 层',
			moduleKey: 'M9',
			defaultAgentId: 'codex',
			sessionIndex: 1, // 由 daemon/feature 明确下发
		},
		{
			id: 'task-2',
			taskKey: 'M9-T2',
			title: '形状枚举与状态徽标',
			moduleKey: 'M9',
			defaultAgentId: 'grok',
			sessionIndex: 1,
		},
		{
			id: 'task-3',
			taskKey: 'M9-T3',
			title: '自写 hash 路由与守卫',
			moduleKey: 'M9',
			// 未下发 defaultAgentId 与 sessionIndex (用于 R1 缺失测试)
		},
	];

	const mockAgents: readonly AssignableAgent[] = [
		{
			id: 'codex',
			name: 'Codex',
			monogram: 'CX',
			maxConcurrency: 2,
			usedConcurrency: 1,
			isLimitReached: false,
			nextSessionIndex: 2,
			defaultModel: 'gpt-5-codex',
			supportsEffort: true,
			models: ['gpt-5-codex', 'gpt-5-mini'],
		},
		{
			id: 'grok',
			name: 'Grok',
			monogram: 'GK',
			maxConcurrency: 4,
			usedConcurrency: 0,
			isLimitReached: false,
			nextSessionIndex: 1,
			defaultModel: 'grok-beta',
			supportsEffort: false, // grok 不支持思考强度 (E-254)
			models: ['grok-beta', 'grok-fast'],
		},
		{
			id: 'claude',
			name: 'Claude Code',
			monogram: 'CC',
			maxConcurrency: 2,
			usedConcurrency: 0,
			isLimitReached: false,
			nextSessionIndex: 1,
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
		});
	});

	// ─────────────────────────────────────────────────────────────
	// 返工 R1 核心行为测试：删除组件层自算与补齐默认，缺失一律显示「—」
	// ─────────────────────────────────────────────────────────────
	describe('R1: 彻底删除组件层默认值、会话序号、容量、用户缺省与越界补算，缺失显示「—」', () => {
		it('未下发 defaultAgentId 时不自动选择 agents[0]，未选显示「请选择 Agent...」', () => {
			const unassignedTask: TaskItem = {
				id: 't-unassigned',
				taskKey: 'M9-T99',
				title: '未配置任务',
			};

			const html = renderToStaticMarkup(
				createElement(TaskAssignmentList, {
					tasks: [unassignedTask],
					agents: mockAgents,
					assignments: {},
				}),
			);

			expect(html).toContain('请选择 Agent...');
			// select 值为 empty string
			expect(html).toContain('value=""');
		});

		it('会话序号 sessionIndex 未下发时显示「—」，严禁组件层自算累加', () => {
			const taskWithoutSession: TaskItem = {
				id: 'task-no-session',
				taskKey: 'M9-T99',
				title: '无序号任务',
			};
			const draftWithoutSession: TaskAssignmentDraft = {
				taskId: 'task-no-session',
				taskKey: 'M9-T99',
				title: '无序号任务',
				agentKey: 'codex',
				modelName: '',
				sessionIndex: null, // 明确未下发
			};

			const html = renderToStaticMarkup(
				createElement(TaskAssignmentList, {
					tasks: [taskWithoutSession],
					agents: mockAgents,
					assignments: { 'task-no-session': draftWithoutSession },
				}),
			);

			// 显示为「—」，禁止伪造会话序号
			expect(html).toContain('data-session-badge="—"');
			expect(html).toContain('—');
		});

		it('Agent 容量未下发时显示「—/max」，严禁组件层自算统计', () => {
			const agentsWithoutUsage: readonly AssignableAgent[] = [
				{
					id: 'cx',
					name: 'Codex',
					monogram: 'CX',
					maxConcurrency: 2,
					// usedConcurrency 未下发
				},
			];

			const html = renderToStaticMarkup(
				createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: agentsWithoutUsage,
					assignments: {},
				}),
			);

			// 显示为 —/2
			expect(html).toContain('Codex: —/2');
		});

		it('用户偏好设定 userSetting 未下发时显示「—」，严禁组件层私自补 2', () => {
			const html = renderToStaticMarkup(
				createElement(ConcurrencyBottleneckCard, {
					userSetting: null, // 未传
					effectiveCapacity: null,
					windowCount: 2,
					agentLimit: 2,
					onChangeUserSetting: vi.fn(),
				}),
			);

			// 明确断言显示 —，而非 2
			expect(html).toContain('data-testid="user-setting-value"');
			expect(html).toContain('—');
			// 当 userSetting 为 null 时调节按钮 disabled
			expect(html).toContain('disabled=""');
		});

		it('越界提示严格依据下发的 isExceedingWindow，缺失时严禁前端自算数值比较', () => {
			// 虽然 windowCount=2，userSetting=4，但 isExceedingWindow 为 false/未下发时，不展示越界警告
			const htmlWithoutWarning = renderToStaticMarkup(
				createElement(ConcurrencyBottleneckCard, {
					windowCount: 2,
					userSetting: 4,
					isExceedingWindow: false, // daemon 判定未越界或无需警告
					onChangeUserSetting: vi.fn(),
					onToggleUnlockAboveWindow: vi.fn(),
				}),
			);
			expect(htmlWithoutWarning).not.toContain('data-testid="exceed-window-warning"');

			// daemon 明确下发 isExceedingWindow: true 时才呈现警告
			const htmlWithWarning = renderToStaticMarkup(
				createElement(ConcurrencyBottleneckCard, {
					windowCount: 2,
					userSetting: 4,
					isExceedingWindow: true,
					onChangeUserSetting: vi.fn(),
					onToggleUnlockAboveWindow: vi.fn(),
				}),
			);
			expect(htmlWithWarning).toContain('data-testid="exceed-window-warning"');
			expect(htmlWithWarning).toContain('后果提示');
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
	});

	// ─────────────────────────────────────────────────────────────
	// 验收标准 4: 某 agent 已达并发上限时其余任务仍可指派给别家，不空转等待 (E-47)
	// ─────────────────────────────────────────────────────────────
	describe('AC 4 & E-47: 某 agent 已达并发上限时其余任务仍可指派给别家，不空转等待', () => {
		it('当 Codex 满额时，其余未指派任务仍可正常指派给 Grok 或 Claude，空位不空转等待', () => {
			const firstAgent = mockAgents[0];
			const secondAgent = mockAgents[1];
			const thirdAgent = mockAgents[2];
			if (!firstAgent || !secondAgent || !thirdAgent) {
				throw new Error('mockAgents are missing');
			}
			const agentsWithCodexFull: readonly AssignableAgent[] = [
				{
					...firstAgent,
					usedConcurrency: 2,
					isLimitReached: true, // 明确标明满额
				},
				secondAgent,
				thirdAgent,
			];

			const html = renderToStaticMarkup(
				createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: agentsWithCodexFull,
					assignments: {},
				}),
			);

			// 顶部容量指标标明 Codex 已满额
			expect(html).toContain('data-agent-capacity="codex"');
			expect(html).toContain('Codex: 2/2 (已满)');

			// 其他 Agent 如 Grok 依然充裕 (0/4)
			expect(html).toContain('data-agent-capacity="grok"');
			expect(html).toContain('Grok: 0/4');

			// 未指派任务依然提供完整选择其它 Agent 的能力，不被阻塞
			expect(html).toContain('Grok (GK) — 0/4 [可用]');
			expect(html).toContain('Claude Code (CC) — 0/2 [可用]');
		});

		it('若选择已满额的 Agent，展示 E-47 提示说明其余任务可顺延指派别家', () => {
			const firstAgent = mockAgents[0];
			const firstTask = mockTasks[0];
			if (!firstAgent || !firstTask) {
				throw new Error('mock task or agent is missing');
			}
			const agentsWithCodexFull: readonly AssignableAgent[] = [
				{
					...firstAgent,
					usedConcurrency: 2,
					isLimitReached: true,
				},
			];

			const html = renderToStaticMarkup(
				createElement(TaskAssignmentList, {
					tasks: [firstTask], // 选了 codex
					agents: agentsWithCodexFull,
					assignments: {},
				}),
			);

			expect(html).toContain('data-testid="agent-limit-warning"');
			expect(html).toContain('已达并发上限');
			expect(html).toContain('其余任务可继续指派给别家 Agent，不空转等待（E-47）');
		});
	});

	// ─────────────────────────────────────────────────────────────
	// 返工 R2: 通过 EmptyOnboarding 的 step3Slot/step4Slot 接入真实零运行流程
	// ─────────────────────────────────────────────────────────────
	describe('R2: EmptyOnboarding 步骤槽位深度集成 AssignPanel 真实零运行流程', () => {
		it('EmptyOnboarding 步骤 3 默认槽位渲染 AssignPanel 逐任务指派内容', () => {
			const html = renderToStaticMarkup(
				createElement(EmptyOnboarding, {
					currentStep: 2, // 第 3 步
					tasks: mockTasks,
					agents: mockAgents,
				}),
			);

			expect(html).toContain('data-step-content="2"');
			expect(html).toContain('data-slot="step-3-assign"');
			expect(html).toContain('data-testid="task-assignment-list"');
			expect(html).toContain('逐任务执行指派');
		});

		it('EmptyOnboarding 步骤 4 默认槽位渲染 AssignPanel 并发限制审计内容', () => {
			const html = renderToStaticMarkup(
				createElement(EmptyOnboarding, {
					currentStep: 3, // 第 4 步
					effectiveCapacity: 2,
					laneCount: 2,
					agentConcurrencyLimit: 4,
					bottleneckSource: 'window_count',
				}),
			);

			expect(html).toContain('data-step-content="3"');
			expect(html).toContain('data-testid="concurrency-bottleneck-card"');
			expect(html).toContain('有效并行并发容量');
			expect(html).toContain('并行窗口数 (依赖拓扑)');
		});
	});

	// ─────────────────────────────────────────────────────────────
	// 返工 R3: focus-visible 环与 44×44 手机触控及键盘测试证据
	// ─────────────────────────────────────────────────────────────
	describe('R3: 交互控件 focus-visible 环、移除无替代 outline-none、44×44 手机触控尺寸', () => {
		it('所有交互按钮与选择器均具备规定的 focus-visible 环样式且无裸露 outline-none', () => {
			const html = renderToStaticMarkup(
				createElement(AssignPanel, {
					mode: 'all',
					tasks: mockTasks,
					agents: mockAgents,
					onChangeUserSetting: vi.fn(),
					onToggleUnlockAboveWindow: vi.fn(),
					userSetting: 2,
				}),
			);

			// 验证全部按钮与选择器带有规定的 focus-visible:shadow-[0_0_0_3px_var(--needs-soft)] 样式
			expect(html).toContain('focus-visible:shadow-[0_0_0_3px_var(--needs-soft)]');
			// 验证伴随 focus-visible:outline-none 而非裸露的 outline-none
			expect(html).toContain('focus-visible:outline-none');
			expect(html).not.toMatch(/\soutline-none(?!\S)/);
		});

		it('手机端触控按钮均具备 min-h-[44px] 尺寸保障 (11 节 UI 触摸标准)', () => {
			const assignments: Record<string, TaskAssignmentDraft> = {
				'task-1': {
					taskId: 'task-1',
					taskKey: 'M9-T1',
					title: 'Web 骨架',
					agentKey: 'codex',
					modelName: '',
					sessionIndex: 1,
				},
			};

			const html = renderToStaticMarkup(
				createElement(AssignPanel, {
					mode: 'all',
					tasks: mockTasks,
					agents: mockAgents,
					assignments,
					onChangeUserSetting: vi.fn(),
					onToggleUnlockAboveWindow: vi.fn(),
					userSetting: 2,
				}),
			);

			// 确认指派按钮手机触控目标 >= 44px
			expect(html).toContain('min-h-[44px]');
			// 调节 -/+ 按钮在触控端具备 min-h-[44px] min-w-[44px]
			expect(html).toContain('min-w-[44px]');
		});
	});
});
