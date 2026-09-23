/**
 * packages/web/test/assign-panel.test.ts
 *
 * M9-T18 逐任务指派面板与并发瓶颈说明测试
 * 验收标准与边界（AC 1-5, E-108, E-31, E-47, E-52, E-254, E-34, E-35, 决策 136）
 * 覆盖三层：展示组件（不补算）、feature Hook（会话序号与预览只认 daemon 返回值）、
 * 生产装配件（run-deck-view 不含内置演示数组）
 */

// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEntryDto, ListAgentsResponse } from '@agent-scheduler/shared/api/agents';
import type {
	BatchAssignmentsResponse,
	ConcurrencyPreview,
	TaskAssignmentDto,
} from '@agent-scheduler/shared/api/batches';
import type {
	ListDocumentBatchesResponse,
	ListDocumentTasksResponse,
	ListDocumentsResponse,
} from '@agent-scheduler/shared/api/documents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup as renderToStaticMarkupOf } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AssignPanel,
	type AssignableAgent,
	ConcurrencyBottleneckCard,
	TaskAssignmentList,
	type TaskAssignmentSelection,
	type TaskItem,
} from '../src/components/assign-panel.tsx';
import { EmptyOnboarding } from '../src/components/empty-onboarding.tsx';
import {
	type AssignPanelClient,
	type UseAssignPanelResult,
	useAssignPanel,
} from '../src/features/run-deck/use-assign-panel.ts';
import { useSelectionStore } from '../src/store/selection-store.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
		usedConcurrency: 1,
		isLimitReached: false,
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
		defaultModel: 'grok-beta',
		supportsEffort: false,
		models: ['grok-beta', 'grok-fast'],
	},
	{
		id: 'claude',
		name: 'Claude Code',
		monogram: 'CC',
		maxConcurrency: 2,
		usedConcurrency: 0,
		isLimitReached: false,
		defaultModel: 'claude-3-5-sonnet',
		supportsEffort: true,
		models: ['claude-3-5-sonnet', 'claude-3-opus'],
	},
];

function selection(
	overrides: Partial<TaskAssignmentSelection> & Pick<TaskAssignmentSelection, 'taskId' | 'taskKey'>,
): TaskAssignmentSelection {
	return {
		agentId: 'codex',
		model: null,
		effort: null,
		sessionNo: 1,
		...overrides,
	};
}

describe('M9-T18 逐任务指派面板与并发瓶颈说明', () => {
	// ─────────────────────────────────────────────────────────────
	// 验收标准 1: 四步引导第三步是「逐任务指派」而不是「给整批选一个模型」
	// ─────────────────────────────────────────────────────────────
	describe('AC 1 & E-108: 逐任务指派而非整批套用，已指派行显示所选值可点回改', () => {
		it('渲染每行一个任务的独立指派表单，严禁整批统一套用按钮', () => {
			const html = renderToStaticMarkupOf(
				createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: mockAgents,
					assignments: {},
				}),
			);

			expect(html).toContain('data-task-editing-row="M9-T1"');
			expect(html).toContain('data-task-editing-row="M9-T2"');
			expect(html).toContain('data-task-editing-row="M9-T3"');

			expect(html).toContain('data-testid="select-agent-M9-T1"');
			expect(html).toContain('data-testid="select-agent-M9-T2"');
			expect(html).toContain('data-testid="select-agent-M9-T3"');

			expect(html).not.toContain('给整批统一应用');
			expect(html).not.toContain('整批一键套用');
			expect(html).toContain('逐任务独立指定，严禁整批统一套用');
		});

		it('已指派行清晰回显所选值，并提供修改指派（点回改）按钮', () => {
			const assignments: Record<string, TaskAssignmentSelection> = {
				'task-1': selection({
					taskId: 'task-1',
					taskKey: 'M9-T1',
					model: 'gpt-5-codex',
					effort: { tier: 'high' },
					sessionNo: 1,
				}),
			};

			const html = renderToStaticMarkupOf(
				createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: mockAgents,
					assignments,
				}),
			);

			expect(html).toContain('data-task-assigned-row="M9-T1"');
			expect(html).toContain('gpt-5-codex');
			expect(html).toContain('high');
			expect(html).toContain('CX');

			expect(html).toContain('data-action="edit-assignment"');
			expect(html).toContain('修改指派');

			expect(html).toContain('data-task-editing-row="M9-T2"');
			expect(html).toContain('data-task-editing-row="M9-T3"');
		});

		it('不支持思考强度的 Agent 明确显示「—」，严禁补充伪造默认档 (M4-T6, E-254)', () => {
			const assignments: Record<string, TaskAssignmentSelection> = {
				'task-2': selection({
					taskId: 'task-2',
					taskKey: 'M9-T2',
					agentId: 'grok',
					model: 'grok-beta',
					effort: null,
				}),
			};

			const secondTask = mockTasks[1];
			if (!secondTask) throw new Error('mockTasks[1] is missing');
			const html = renderToStaticMarkupOf(
				createElement(TaskAssignmentList, {
					tasks: [secondTask],
					agents: mockAgents,
					assignments,
				}),
			);

			expect(html).toContain('data-task-assigned-row="M9-T2"');
			expect(html).toContain('思考: <span class="text-ink-1">—</span>');
		});
	});

	// ─────────────────────────────────────────────────────────────
	// 验收标准 2: 同一个 agent 允许被指派多次，每次是一个独立会话并显示由 daemon 下发的序号
	// ─────────────────────────────────────────────────────────────
	describe('AC 2 & E-31: 同一 agent 允许被指派多次，每次为独立会话并显示会话序号', () => {
		it('同一个 agent 被指派多次时，各自显示 daemon 下发的独立会话序号 (会话 #1, 会话 #2)', () => {
			const assignments: Record<string, TaskAssignmentSelection> = {
				'task-1': selection({
					taskId: 'task-1',
					taskKey: 'M9-T1',
					model: 'gpt-5-codex',
					effort: { tier: 'medium' },
					sessionNo: 1,
				}),
				'task-2': selection({
					taskId: 'task-2',
					taskKey: 'M9-T2',
					model: 'gpt-5-mini',
					effort: { tier: 'low' },
					sessionNo: 2,
				}),
			};

			const html = renderToStaticMarkupOf(
				createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: mockAgents,
					assignments,
				}),
			);

			expect(html).toContain('data-session-badge="1"');
			expect(html).toContain('会话 #1');
			expect(html).toContain('data-session-badge="2"');
			expect(html).toContain('会话 #2');
		});

		it('daemon 序号即使与数组顺序不一致也原样呈现，组件不按行序自算 (E-31)', () => {
			const assignments: Record<string, TaskAssignmentSelection> = {
				'task-2': selection({ taskId: 'task-2', taskKey: 'M9-T2', sessionNo: 7 }),
			};

			const html = renderToStaticMarkupOf(
				createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: mockAgents,
					assignments,
				}),
			);

			expect(html).toContain('data-session-badge="7"');
			expect(html).not.toContain('data-session-badge="1"');
		});
	});

	// ─────────────────────────────────────────────────────────────
	// R1: 组件层不补算、不造假默认，缺失统一显示「—」
	// ─────────────────────────────────────────────────────────────
	describe('R1: 组件层默认值、会话序号、容量、用户缺省与越界一律读下发字段', () => {
		it('未下发 defaultAgentId 时不自动选择 agents[0]，未选显示「请选择 Agent...」', () => {
			const unassignedTask: TaskItem = {
				id: 't-unassigned',
				taskKey: 'M9-T99',
				title: '未配置任务',
			};

			const html = renderToStaticMarkupOf(
				createElement(TaskAssignmentList, {
					tasks: [unassignedTask],
					agents: mockAgents,
					assignments: {},
				}),
			);

			expect(html).toContain('请选择 Agent...');
			expect(html).toContain('value=""');
		});

		it('会话序号未下发时显示「—」，严禁组件层自算累加', () => {
			const taskWithoutSession: TaskItem = {
				id: 'task-no-session',
				taskKey: 'M9-T99',
				title: '无序号任务',
			};
			const draftWithoutSession = selection({
				taskId: 'task-no-session',
				taskKey: 'M9-T99',
				sessionNo: null,
			});

			const html = renderToStaticMarkupOf(
				createElement(TaskAssignmentList, {
					tasks: [taskWithoutSession],
					agents: mockAgents,
					assignments: { 'task-no-session': draftWithoutSession },
				}),
			);

			expect(html).toContain('data-session-badge="—"');
			expect(html).toContain('—');
		});

		it('未选择 Agent 时不替 daemon 断言「不支持思考强度」(E-254)', () => {
			const firstTask = mockTasks[0];
			if (!firstTask) throw new Error('mockTasks[0] is missing');
			const html = renderToStaticMarkupOf(
				createElement(TaskAssignmentList, {
					tasks: [firstTask],
					agents: mockAgents,
					assignments: {},
				}),
			);

			expect(html).toContain('(请先选择 Agent)');
			expect(html).toContain('(待选择 Agent)');
			expect(html).not.toContain('不支持思考档位');
		});

		it('Agent 容量未下发时显示「—/max」，严禁组件层自算统计', () => {
			const agentsWithoutUsage: readonly AssignableAgent[] = [
				{
					id: 'cx',
					name: 'Codex',
					monogram: 'CX',
					maxConcurrency: 2,
				},
			];

			const html = renderToStaticMarkupOf(
				createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: agentsWithoutUsage,
					assignments: {},
				}),
			);

			expect(html).toContain('Codex: —/2');
		});

		it('用户偏好设定未下发时显示「—」，并在能力未下发时禁用调节按钮', () => {
			const html = renderToStaticMarkupOf(
				createElement(ConcurrencyBottleneckCard, {
					userSetting: null,
					effectiveCapacity: null,
					windowCount: 2,
					onChangeUserSetting: vi.fn(),
				}),
			);

			expect(html).toContain('data-testid="user-setting-value"');
			expect(html).toContain('—');
			expect(html).toContain('disabled=""');
		});

		it('越界提示严格依据 daemon 下发的 isExceedingWindow，缺失时不自行比较', () => {
			const htmlWithoutWarning = renderToStaticMarkupOf(
				createElement(ConcurrencyBottleneckCard, {
					windowCount: 2,
					userSetting: 4,
					isExceedingWindow: false,
					onChangeUserSetting: vi.fn(),
					onToggleUnlockAboveWindow: vi.fn(),
				}),
			);
			expect(htmlWithoutWarning).not.toContain('data-testid="exceed-window-warning"');

			const htmlWithWarning = renderToStaticMarkupOf(
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

		it('调节能力由下发字段决定：daemon 禁止上调时点击不回调 (E-52)', () => {
			const onChangeUserSetting = vi.fn();
			const html = renderToStaticMarkupOf(
				createElement(ConcurrencyBottleneckCard, {
					userSetting: 2,
					windowCount: 2,
					canIncreaseUserSetting: false,
					canDecreaseUserSetting: true,
					onChangeUserSetting,
					onToggleUnlockAboveWindow: vi.fn(),
					isUnlockedAboveWindow: false,
				}),
			);

			expect(html).toContain('data-action="increase-user-setting"');
			expect(html).toContain('disabled=""');
			// 上调按钮被 daemon 判定为不可用时，组件不自行加一
			expect(onChangeUserSetting).not.toHaveBeenCalled();
		});
	});

	// ─────────────────────────────────────────────────────────────
	// 验收标准 3: 第四步显示并发三者取 min 的结果，并明确指出哪一个是瓶颈 (E-52)
	// ─────────────────────────────────────────────────────────────
	describe('AC 3 & E-52: 并发三者取 min 与明确指出是并行窗口、agent 上限还是用户设定成了瓶颈', () => {
		it('显示有效并发容量为 daemon 结果，并高亮指出「并行窗口数」瓶颈', () => {
			const html = renderToStaticMarkupOf(
				createElement(ConcurrencyBottleneckCard, {
					effectiveCapacity: 2,
					windowCount: 2,
					agentLimit: 4,
					userSetting: 3,
					bottleneckSource: 'window_count',
					bottleneckDescription: '受批次内依赖拓扑限制，最大并行窗口数为 2。',
				}),
			);

			expect(html).toContain('data-testid="effective-capacity-value"');
			expect(html).toContain('2');
			expect(html).toContain('data-factor="window_count"');
			expect(html).toContain('data-factor="agent_limit"');
			expect(html).toContain('data-factor="user_setting"');

			expect(html).toContain('data-testid="bottleneck-badge-window"');
			expect(html).toContain('data-testid="bottleneck-source-name"');
			expect(html).toContain('并行窗口数 (依赖拓扑)');
			expect(html).toContain('受批次内依赖拓扑限制，最大并行窗口数为 2。');
		});

		it('当 Agent 单体并发达到上限时，明确指出「Agent 基础上限」成了瓶颈', () => {
			const html = renderToStaticMarkupOf(
				createElement(ConcurrencyBottleneckCard, {
					effectiveCapacity: 1,
					windowCount: 4,
					agentLimit: 1,
					userSetting: 3,
					bottleneckSource: 'agent_limit',
				}),
			);

			expect(html).toContain('data-testid="bottleneck-badge-agent"');
			expect(html).toContain('Agent 单体并发上限');
			expect(html).toContain('所指派 Agent 的单体最大并发上限为 1');
		});

		it('当用户设定为最低时，明确指出「用户偏好设定」成了瓶颈', () => {
			const html = renderToStaticMarkupOf(
				createElement(ConcurrencyBottleneckCard, {
					effectiveCapacity: 1,
					windowCount: 4,
					agentLimit: 4,
					userSetting: 1,
					bottleneckSource: 'user_setting',
				}),
			);

			expect(html).toContain('data-testid="bottleneck-badge-user"');
			expect(html).toContain('用户设定并发上限');
			expect(html).toContain('受用户偏好设定上限 (1) 约束');
		});

		it('agent 上限标量缺失时不合成数字，逐 agent 数值仍来自 daemon', () => {
			const html = renderToStaticMarkupOf(
				createElement(ConcurrencyBottleneckCard, {
					effectiveCapacity: 1,
					windowCount: 4,
					userSetting: 3,
					bottleneckSource: 'agent_limit',
					agentCapacities: [{ agentId: 'codex', active: 0, limit: 1, drafted: 1, isFull: true }],
				}),
			);

			expect(html).toContain('codex 1/1 已满额');
			expect(html).not.toContain('单体最大并发上限为 —');
			expect(html).toContain('是三者中最小的一项');
		});

		it('逐 agent 容量直接列出 daemon preview.agentCapacities（含满额标记）', () => {
			const html = renderToStaticMarkupOf(
				createElement(ConcurrencyBottleneckCard, {
					audit: {
						effectiveCapacity: 1,
						windowCount: 4,
						userSetting: 3,
						bottleneckSource: 'agent_limit',
						agentCapacities: [
							{ agentId: 'codex', active: 0, limit: 1, drafted: 1, isFull: true },
							{ agentId: 'claude', active: 0, limit: 2, drafted: 0, isFull: false },
						],
					},
				}),
			);

			expect(html).toContain('data-testid="agent-capacity-factors"');
			expect(html).toContain('codex 1/1 已满额');
			expect(html).toContain('claude 0/2');
		});
	});

	// ─────────────────────────────────────────────────────────────
	// 验收标准 4: 某 agent 已达并发上限时其余任务仍可指派给别家，不空转等待 (E-47)
	// ─────────────────────────────────────────────────────────────
	describe('AC 4 & E-47: 某 agent 已达并发上限时其余任务仍可指派给别家，不空转等待', () => {
		it('当 Codex 满额时，其余未指派任务仍可正常指派给 Grok 或 Claude', () => {
			const firstAgent = mockAgents[0];
			const secondAgent = mockAgents[1];
			const thirdAgent = mockAgents[2];
			if (!firstAgent || !secondAgent || !thirdAgent) {
				throw new Error('mockAgents are missing');
			}
			const agentsWithCodexFull: readonly AssignableAgent[] = [
				{ ...firstAgent, usedConcurrency: 2, isLimitReached: true },
				secondAgent,
				thirdAgent,
			];

			const html = renderToStaticMarkupOf(
				createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: agentsWithCodexFull,
					assignments: {},
				}),
			);

			expect(html).toContain('data-agent-capacity="codex"');
			expect(html).toContain('Codex: 2/2 (已满)');
			expect(html).toContain('data-agent-capacity="grok"');
			expect(html).toContain('Grok: 0/4');
			expect(html).toContain('Grok (GK) — 0/4 [可用]');
			expect(html).toContain('Claude Code (CC) — 0/2 [可用]');
		});

		it('已选中的 Agent 满额时展示 E-47 提示：本任务排队，其余任务可指派别家', () => {
			const firstAgent = mockAgents[0];
			if (!firstAgent) {
				throw new Error('mock agent is missing');
			}
			const agentsWithCodexFull: readonly AssignableAgent[] = [
				{ ...firstAgent, usedConcurrency: 2, isLimitReached: true },
			];
			// 只有调用方（feature/daemon 数据）明确下发默认 agent 时才会预选，组件自己不挑 agents[0]
			const preselectedTask: TaskItem = {
				id: 'task-1',
				taskKey: 'M9-T1',
				title: 'Web 骨架与 token 层',
				moduleKey: 'M9',
				defaultAgentId: 'codex',
			};

			const html = renderToStaticMarkupOf(
				createElement(TaskAssignmentList, {
					tasks: [preselectedTask],
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
	// 验收标准 5（决策 136）: 会话序号、占用、并发与瓶颈只读 daemon 字段，改选整批 POST 后以返回值刷新
	// ─────────────────────────────────────────────────────────────
	describe('AC 5 & 决策 136: 指派面板经真实端点取数与写回，前端不自算', () => {
		const docId = 'doc-1';
		const batchId = 'batch-1';

		const preview = (overrides: Partial<ConcurrencyPreview> = {}): ConcurrencyPreview => ({
			windowCount: 4,
			userSetting: 3,
			agentCapacities: [
				{ agentId: 'codex', active: 0, limit: 1, drafted: 0, isFull: false },
				{ agentId: 'claude', active: 0, limit: 2, drafted: 0, isFull: false },
			],
			effectiveConcurrency: 1,
			bottleneck: 'agent_limit',
			exceedsWindowCount: false,
			...overrides,
		});

		const draft = (overrides: Partial<TaskAssignmentDto> = {}): TaskAssignmentDto => ({
			taskId: 'task-1',
			taskKey: 'M9-T1',
			agentId: 'codex',
			model: null,
			effort: null,
			sessionNo: 1,
			draftedAt: '2026-09-19T10:00:00.000Z',
			...overrides,
		});

		function createClient(overrides: Partial<AssignPanelClient> = {}): AssignPanelClient {
			const documents: ListDocumentsResponse = {
				documents: [
					{
						id: docId,
						docsPath: 'D:/repo/docs/Agent任务调度器-开发文档/docs-data.js',
						projectName: 'Agent 任务调度器',
						repoPath: 'D:/repo',
						mainBranch: 'main',
						branchPrefix: 'task/',
						laneCount: 3,
						contentFingerprint: 'fp-1',
						isSourceReadable: true,
						isTakeoverNotified: false,
						importedAt: '2026-09-19T09:00:00.000Z',
						lastSeenAt: '2026-09-19T09:00:00.000Z',
					},
				],
			};
			const agents: ListAgentsResponse = {
				agents: [
					agentEntry('codex', 'Codex', 'CX', 1, { low: 'low', medium: 'medium', high: 'high' }),
					agentEntry('claude', 'Claude Code', 'CL', 2, {
						low: '2048',
						medium: '8192',
						high: '32768',
					}),
					agentEntry('dsh', 'DSH', 'DS', 1, null),
				],
			};
			const batches: ListDocumentBatchesResponse = {
				batches: [
					{
						id: batchId,
						docId,
						batchNo: 1,
						state: 'idle',
						startedAt: null,
						finishedAt: null,
					},
				],
			};
			const tasks: ListDocumentTasksResponse = {
				tasks: mockTasks.map((task) => ({
					id: task.id,
					docId,
					taskKey: task.taskKey,
					title: task.title,
					moduleKey: task.moduleKey ?? 'M9',
					deps: [],
					estDays: null,
					batchId,
					state: 'never_dispatched' as const,
				})),
				nextCursor: null,
			};

			return {
				listDocuments: vi.fn(async () => documents),
				listBatches: vi.fn(async () => batches),
				listTasks: vi.fn(async () => tasks),
				listAgents: vi.fn(async () => agents),
				listAgentModels: vi.fn(async (agentId: string) => ({
					models: [{ name: `${agentId}-model`, source: 'builtin' as const, isCurrentConfig: true }],
					isComplete: true,
					refreshedAt: '2026-09-19T10:00:00.000Z',
					liveFailure: null,
					currentConfig: {
						model: null,
						effort: null,
						configPath: 'D:/config.json',
						effortRecognized: true,
					},
					isRefreshing: false,
				})),
				readAssignments: vi.fn(
					async (): Promise<BatchAssignmentsResponse> => ({ drafts: [], preview: preview() }),
				),
				putAssignments: vi.fn(
					async (): Promise<BatchAssignmentsResponse> => ({ drafts: [], preview: preview() }),
				),
				updateLaneCount: vi.fn(async () => {}),
				...overrides,
			};
		}

		beforeEach(() => {
			useSelectionStore.getState().reset();
		});

		afterEach(() => {
			useSelectionStore.getState().reset();
		});

		it('挂载后走真实端点：选定文档与批次、按 batchId 过滤可指派任务、读回草稿与预览', async () => {
			const client = createClient({
				readAssignments: vi.fn(async () => ({
					drafts: [draft({ sessionNo: 4 })],
					preview: preview({
						agentCapacities: [
							{ agentId: 'codex', active: 3, limit: 4, drafted: 1, isFull: true },
							{ agentId: 'claude', active: 0, limit: 2, drafted: 0, isFull: false },
						],
					}),
				})),
			});
			const probe = await mountAssignPanel(client);

			expect(client.listDocuments).toHaveBeenCalledTimes(1);
			expect(client.listBatches).toHaveBeenCalledWith(docId);
			expect(client.listTasks).toHaveBeenCalledWith(docId, batchId, null);
			expect(client.readAssignments).toHaveBeenCalledWith(batchId);

			const state = probe.current();
			expect(state.tasks.map((task) => task.taskKey)).toEqual(['M9-T1', 'M9-T2', 'M9-T3']);
			// 会话序号与占用只认 daemon：sessionNo=4 而不是按行序的 1
			expect(state.assignments['task-1']?.sessionNo).toBe(4);
			const codex = state.agents.find((agent) => agent.id === 'codex');
			expect(codex?.usedConcurrency).toBe(3);
			expect(codex?.maxConcurrency).toBe(4);
			expect(codex?.isLimitReached).toBe(true);
			expect(state.audit.effectiveCapacity).toBe(1);
			expect(state.audit.bottleneckSource).toBe('agent_limit');
			// dsh 的 effortVendorMap 为 null → 思考强度不支持（E-254）
			expect(state.agents.find((agent) => agent.id === 'dsh')?.supportsEffort).toBe(false);
			await probe.unmount();
		});

		it('改选后整批覆写同一端点，并用返回值（含新会话序号）刷新界面', async () => {
			const client = createClient({
				putAssignments: vi.fn(async () => ({
					drafts: [draft({ sessionNo: 2, effort: { tier: 'high' }, model: 'codex-model' })],
					preview: preview({
						agentCapacities: [
							{ agentId: 'codex', active: 1, limit: 1, drafted: 1, isFull: true },
							{ agentId: 'claude', active: 0, limit: 2, drafted: 0, isFull: false },
						],
					}),
				})),
			});
			const probe = await mountAssignPanel(client);

			await act(async () => {
				await probe.current().assignTask('task-1', {
					taskId: 'task-1',
					taskKey: 'M9-T1',
					agentId: 'codex',
					model: 'codex-model',
					effort: { tier: 'high' },
					sessionNo: null,
				});
			});

			expect(client.putAssignments).toHaveBeenCalledWith(batchId, [
				{ taskId: 'task-1', agentId: 'codex', model: 'codex-model', effort: { tier: 'high' } },
			]);
			// 刷新来自响应：序号 2 是 daemon 给的，不是组件按顺序推的
			const state = probe.current();
			expect(state.assignments['task-1']?.sessionNo).toBe(2);
			expect(state.assignments['task-1']?.effort).toEqual({ tier: 'high' });
			expect(state.agentCapacities.codex).toEqual({ used: 1, max: 1, isFull: true });
			await probe.unmount();
		});

		it('重置单任务指派时也只 POST 剩余草稿集合，任务数归零', async () => {
			const client = createClient({
				readAssignments: vi.fn(async () => ({
					drafts: [draft(), draft({ taskId: 'task-2', taskKey: 'M9-T2', sessionNo: 2 })],
					preview: preview(),
				})),
				putAssignments: vi.fn(async () => ({
					drafts: [draft({ taskId: 'task-2', taskKey: 'M9-T2', sessionNo: 1 })],
					preview: preview(),
				})),
			});
			const probe = await mountAssignPanel(client);
			expect(Object.keys(probe.current().assignments)).toHaveLength(2);

			await act(async () => {
				await probe.current().resetAssignment('task-1');
			});

			expect(client.putAssignments).toHaveBeenCalledWith(batchId, [
				{ taskId: 'task-2', agentId: 'codex', model: null, effort: null },
			]);
			expect(Object.keys(probe.current().assignments)).toEqual(['task-2']);
			await probe.unmount();
		});

		it('用户设定写入 documents settings 后重新读预览，有效并发与瓶颈仍由 daemon 给', async () => {
			const client = createClient({
				readAssignments: vi
					.fn()
					.mockResolvedValueOnce({ drafts: [], preview: preview({ userSetting: 3 }) })
					.mockResolvedValueOnce({
						drafts: [],
						preview: preview({
							userSetting: 4,
							effectiveConcurrency: 4,
							bottleneck: 'window_count',
							exceedsWindowCount: true,
						}),
					}),
			});
			const probe = await mountAssignPanel(client);

			await act(async () => {
				await probe.current().changeUserSetting(4);
			});

			expect(client.updateLaneCount).toHaveBeenCalledWith(docId, 4);
			expect(client.readAssignments).toHaveBeenCalledTimes(2);
			const state = probe.current();
			expect(state.audit.userSetting).toBe(4);
			expect(state.audit.effectiveCapacity).toBe(4);
			expect(state.audit.bottleneckSource).toBe('window_count');
			expect(state.audit.isExceedingWindow).toBe(true);
			await probe.unmount();
		});

		it('daemon 未下发占用与设定时保持缺失（渲染显示「—」），前端不补 0 或 2', async () => {
			const client = createClient({
				readAssignments: vi.fn(async () => ({
					drafts: [],
					preview: preview({ userSetting: 0, agentCapacities: [], effectiveConcurrency: 0 }),
				})),
			});
			const probe = await mountAssignPanel(client);
			const state = probe.current();

			expect(state.agents.every((agent) => agent.usedConcurrency === null)).toBe(true);
			expect(state.agents.every((agent) => agent.isLimitReached === null)).toBe(true);
			expect(state.audit.agentCapacities).toEqual([]);
			await probe.unmount();
		});

		it('写回被 daemon 拒绝时就地报错并保持服务端原状（不乐观改本地草稿）', async () => {
			const client = createClient({
				putAssignments: vi.fn(async () => {
					const error = new Error(
						'assignments[0].agentId is not in the agent registry',
					) as Error & {
						code: string;
						requestId: string;
					};
					error.code = 'E_VALIDATION';
					error.requestId = 'req-1';
					error.name = 'ApiError';
					throw error;
				}),
			});
			const probe = await mountAssignPanel(client);

			await act(async () => {
				await probe.current().assignTask('task-1', {
					taskId: 'task-1',
					taskKey: 'M9-T1',
					agentId: 'ghost',
					model: null,
					effort: null,
					sessionNo: null,
				});
			});

			const state = probe.current();
			expect(state.assignments['task-1']).toBeUndefined();
			expect(state.error?.message).toBe('输入参数不合规，请检查后重试');
			await probe.unmount();
		});
	});

	// ─────────────────────────────────────────────────────────────
	// 生产装配件：零运行流程不含演示数组，槽位来自 daemon 数据
	// ─────────────────────────────────────────────────────────────
	describe('接线: run-deck-view 零运行流程只呈现 daemon 数据', () => {
		const viewSource = readFileSync(
			resolve(
				dirname(fileURLToPath(import.meta.url)),
				'../src/features/run-deck/run-deck-view.tsx',
			),
			'utf8',
		);

		it('不存在内置的文档／批次／任务／agent 演示数组', () => {
			expect(viewSource).not.toContain("id: 'doc-main'");
			expect(viewSource).not.toContain("id: 'batch-1'");
			expect(viewSource).not.toContain("taskKey: 'M9-T18'");
			expect(viewSource).not.toContain('gpt-5-codex');
			expect(viewSource).not.toContain('documents={[');
			expect(viewSource).not.toContain('agents={[');
		});

		it('经 use-assign-panel 取数并填进 step3Slot / step4Slot', () => {
			expect(viewSource).toContain('useAssignPanel(');
			expect(viewSource).toContain('step3Slot={');
			expect(viewSource).toContain('step4Slot={');
			expect(viewSource).toContain('assignments={assignPanel.assignments}');
			expect(viewSource).toContain('audit={assignPanel.audit}');
		});
	});

	// ─────────────────────────────────────────────────────────────
	// R3: focus-visible 环与 44×44 手机触控
	// ─────────────────────────────────────────────────────────────
	describe('R3: 交互控件 focus-visible 环、移除无替代 outline-none、44×44 手机触控尺寸', () => {
		it('所有交互按钮与选择器均具备规定的 focus-visible 环样式且无裸露 outline-none', () => {
			const html = renderToStaticMarkupOf(
				createElement(AssignPanel, {
					mode: 'all',
					tasks: mockTasks,
					agents: mockAgents,
					onChangeUserSetting: vi.fn(),
					onToggleUnlockAboveWindow: vi.fn(),
					userSetting: 2,
					bottleneckSource: 'user_setting',
				}),
			);

			expect(html).toContain('focus-visible:shadow-[0_0_0_3px_var(--needs-soft)]');
			expect(html).toContain('focus-visible:outline-none');
			expect(html).not.toMatch(/\soutline-none(?!\S)/);
		});

		it('手机端触控按钮均具备 min-h-[44px]/min-w-[44px] 尺寸保障 (11 节 UI 触摸标准)', () => {
			const assignments: Record<string, TaskAssignmentSelection> = {
				'task-1': selection({ taskId: 'task-1', taskKey: 'M9-T1' }),
			};

			const html = renderToStaticMarkupOf(
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

			expect(html).toContain('min-h-[44px]');
			expect(html).toContain('min-w-[44px]');
		});
	});
});

/**
 * EmptyOnboarding 的槽位契约：第三步正文由 feature 通过 step3Slot 注入（M9-T16 外壳 + M9-T18 正文）。
 */
describe('M9-T18 与 M9-T16 的槽位契约', () => {
	it('step3Slot / step4Slot 由调用方注入逐任务指派与并发瓶颈正文', () => {
		const html = renderToStaticMarkupOf(
			createElement(EmptyOnboarding, {
				currentStep: 2,
				documents: [{ id: 'doc-1', title: 'Agent 任务调度器', path: 'docs/x' }],
				batches: [{ id: 'batch-1', docId: 'doc-1', name: '第 1 批' }],
				tasks: mockTasks,
				step3Slot: createElement(TaskAssignmentList, {
					tasks: mockTasks,
					agents: mockAgents,
					assignments: {},
				}),
			}),
		);

		expect(html).toContain('data-step-content="2"');
		expect(html).toContain('data-slot="step-3-assign"');
		expect(html).toContain('data-testid="task-assignment-list"');
		expect(html).toContain('逐任务执行指派');
	});

	it('step4Slot 注入并发瓶颈卡片，缺失时可回落 M9-T16 的只读外壳', () => {
		const withSlot = renderToStaticMarkupOf(
			createElement(EmptyOnboarding, {
				currentStep: 3,
				step4Slot: createElement(ConcurrencyBottleneckCard, {
					effectiveCapacity: 2,
					windowCount: 2,
					userSetting: 2,
					bottleneckSource: 'window_count',
				}),
			}),
		);
		expect(withSlot).toContain('data-testid="concurrency-bottleneck-card"');
		expect(withSlot).toContain('并行窗口数 (依赖拓扑)');

		const withoutSlot = renderToStaticMarkupOf(
			createElement(EmptyOnboarding, {
				currentStep: 3,
				effectiveCapacity: 2,
				laneCount: 2,
				agentConcurrencyLimit: 4,
				bottleneckSource: 'window_count',
			}),
		);
		expect(withoutSlot).toContain('data-testid="concurrency-bottleneck-card"');
		expect(withoutSlot).toContain('有效并行并发容量');
	});
});

function agentEntry(
	id: string,
	name: string,
	monogram: string,
	maxConcurrency: number,
	effortVendorMap: AgentEntryDto['effortVendorMap'],
): AgentEntryDto {
	return {
		id,
		name,
		monogram,
		isAvailable: true,
		defaultModel: null,
		maxConcurrency,
		permissionTier: 'workspaceWrite',
		execPath: `D:/bin/${id}`,
		effortVendorMap,
	};
}

interface MountedAssignPanel {
	readonly current: () => UseAssignPanelResult;
	readonly unmount: () => Promise<void>;
}

async function mountAssignPanel(client: AssignPanelClient): Promise<MountedAssignPanel> {
	const observed: { value?: UseAssignPanelResult } = {};
	function Probe() {
		observed.value = useAssignPanel({ enabled: true, client });
		return createElement('div', null, observed.value.step3Summary);
	}
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(createElement(Probe));
	});
	// 取数链路是「文档 → 默认批次 → 任务与草稿」的级联 effect，多刷几轮微任务再断言
	for (let round = 0; round < 6; round += 1) {
		await act(async () => {});
	}
	return {
		current: () => {
			if (!observed.value) throw new Error('Probe did not render');
			return observed.value;
		},
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}
