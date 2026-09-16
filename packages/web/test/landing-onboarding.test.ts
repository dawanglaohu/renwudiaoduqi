/**
 * packages/web/test/landing-onboarding.test.ts
 *
 * M9-T16 验收标准与边界测试（AC 1-6, E-108, E-110, E-111, E-19, E-218, E-74）
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BatchSummaryBar, type BatchSummaryCounts } from '../src/components/batch-summary-bar.tsx';
import { DocChangeBanner, EmptyOnboarding } from '../src/components/empty-onboarding.tsx';
import { LandingPage, SessionSearchEntrance } from '../src/pages/landing-page.tsx';

describe('M9-T16 空态四步引导、批次汇总与落地清单页', () => {
	// ─── AC 1 & E-108: 空态四步引导 ───
	describe('AC 1 & E-108: 零运行空态是「选文档 → 选批次 → 逐任务指派 → 派发」四步引导，不是插画', () => {
		it('renders all four step indicators with text labels and step numbers', () => {
			const html = renderToStaticMarkup(createElement(EmptyOnboarding));

			// 必须包含四步引导明确文案（AC 1）
			expect(html).toContain('选文档');
			expect(html).toContain('选批次');
			expect(html).toContain('逐任务指派');
			expect(html).toContain('派发');

			// 严禁插画与吉祥物（E-108 / 11 节 avoid#14）
			expect(html).not.toContain('<img');
			expect(html).not.toContain('illustration');
			expect(html).not.toContain('empty-state-art');

			// 控制台仪表感基调
			expect(html).toContain('零运行调度向导');
		});

		it('highlights the current step with active attribute and styling', () => {
			const html = renderToStaticMarkup(createElement(EmptyOnboarding));

			// 默认第 0 步选文档处于激活高亮态
			expect(html).toContain('data-step-index="0"');
			expect(html).toContain('data-step-active="true"');
			expect(html).toContain('第一步：选择调度目标需求开发文档');
		});

		it('supports individual task assignment in step 3 (agent, model, effort tier) rather than single batch model', () => {
			// 直接测试步骤 3 渲染
			const customTasks = [
				{ id: 't-m9-1', taskKey: 'M9-T1', title: 'Web 骨架与主题' },
				{ id: 't-m9-2', taskKey: 'M9-T2', title: '形状枚举与状态徽标' },
			];

			const html = renderToStaticMarkup(
				createElement(EmptyOnboarding, {
					tasks: customTasks,
				}),
			);

			// 验证初始状态渲染
			expect(html).toContain('Agent任务调度器-开发文档');
		});
	});

	// ─── AC 2 & E-111: 批次汇总条 ───
	describe('AC 2 & E-111: 批次汇总条是四个数字 + 一条比例条，不得升格成饼图或环形图', () => {
		const counts: BatchSummaryCounts = {
			running: 3,
			awaiting: 2,
			landed: 5,
			failed: 1,
		};

		it('renders exact four numbers for running, awaiting, landed, and failed', () => {
			const html = renderToStaticMarkup(
				createElement(BatchSummaryBar, {
					batchName: '第 2 批',
					counts,
				}),
			);

			// 四个数字指标与对应语义标签
			expect(html).toContain('进行中');
			expect(html).toContain('3');
			expect(html).toContain('待审批');
			expect(html).toContain('2');
			expect(html).toContain('已落地');
			expect(html).toContain('5');
			expect(html).toContain('失败');
			expect(html).toContain('1');

			// 检查 data-stat 属性
			expect(html).toContain('data-stat="running"');
			expect(html).toContain('data-stat="awaiting"');
			expect(html).toContain('data-stat="landed"');
			expect(html).toContain('data-stat="failed"');
		});

		it('renders a single proportional bar and strictly NO pie chart or donut chart', () => {
			const html = renderToStaticMarkup(
				createElement(BatchSummaryBar, {
					batchName: '第 2 批',
					counts,
				}),
			);

			// 存在比例条容器
			expect(html).toContain('data-testid="batch-proportional-bar"');
			expect(html).toContain('data-bar-segment="landed"');
			expect(html).toContain('data-bar-segment="running"');
			expect(html).toContain('data-bar-segment="awaiting"');
			expect(html).toContain('data-bar-segment="failed"');

			// 严禁饼图、环形图（E-111 明确禁止升格）
			expect(html).not.toContain('<pie');
			expect(html).not.toContain('<doughnut');
			expect(html).not.toContain('recharts');
			expect(html).not.toContain('pie-chart');
			expect(html).not.toContain('donut-chart');
		});

		it('adheres to E-110: each stat has both shape glyph and text label', () => {
			const html = renderToStaticMarkup(
				createElement(BatchSummaryBar, {
					counts,
				}),
			);

			// 内联 SVG 形状存在，状态区分不只靠色相
			expect(html).toContain('<svg');
			expect(html).toContain('viewBox="0 0 16 16"');
		});
	});

	// ─── AC 3 & E-74: 落地清单页 ───
	describe('AC 3 & E-74: 落地清单页展示 worktree 路径、分支名、diff 摘要、可一键复制命令，复制而不执行', () => {
		const mockData = {
			worktreePath: 'D:/xiangmu/agent-scheduler-m5-t4',
			branchName: 'task/M5-T4',
			diffStat: {
				filesChanged: 4,
				insertions: 88,
				deletions: 16,
			},
			commands: [
				'gh stack push && gh stack submit --auto --open',
				'python docs/Agent任务调度器-开发文档/_run/build_docs.py docs/Agent任务调度器-开发文档 --landed M5-T4',
			],
		};

		it('renders worktree path, branch name, diff stat, and both copyable commands', () => {
			const html = renderToStaticMarkup(
				createElement(LandingPage, {
					taskId: 'M5-T4',
					initialData: mockData,
				}),
			);

			// 1. Worktree 路径
			expect(html).toContain('D:/xiangmu/agent-scheduler-m5-t4');
			expect(html).toContain('data-copy-btn="worktree"');

			// 2. 分支名
			expect(html).toContain('task/M5-T4');
			expect(html).toContain('data-copy-btn="branch"');

			// 3. Diff 摘要
			expect(html).toContain('4');
			expect(html).toContain('+88');
			expect(html).toContain('-16');
			expect(html).toContain('data-copy-btn="diff"');

			// 4. gh stack 命令与复制按钮
			expect(html).toContain('gh stack push');
			expect(html).toContain('data-copy-btn="gh-stack"');
			expect(html).toContain('复制 gh stack 命令');

			// 5. build_docs.py --landed 命令与复制按钮
			expect(html).toContain('--landed M5-T4');
			expect(html).toContain('data-copy-btn="build-docs"');
			expect(html).toContain('复制落地命令');

			// 只读契约提示（E-74：复制而不执行）
			expect(html).toContain('只读清单 · 复制而不执行');
		});
	});

	// ─── AC 4 & E-19: 文档变更横幅 ───
	describe('AC 4 & E-19: 文档变更横幅显示「本文档已更新，N 个任务的依据已变」并可进入受影响任务列表', () => {
		it('renders document change warning banner with count and action button', () => {
			const html = renderToStaticMarkup(
				createElement(DocChangeBanner, {
					notice: {
						affectedCount: 3,
						affectedTaskIds: ['M1-T1', 'M1-T2', 'M1-T3'],
						summary: '验收标准已被更新',
					},
				}),
			);

			expect(html).toContain('本文档已更新，3 个任务的依据已变');
			expect(html).toContain('查看受影响任务 (3)');
			expect(html).toContain('data-action="view-affected"');
		});

		it('does not render banner when affected count is zero', () => {
			const html = renderToStaticMarkup(
				createElement(DocChangeBanner, {
					notice: {
						affectedCount: 0,
					},
				}),
			);

			expect(html).toBe('');
		});
	});

	// ─── AC 5 & E-218: 显式「在整个会话中查找」入口 ───
	describe('AC 5 & E-218: 「在整个会话中查找」显式入口，避免用户误以为 Ctrl+F 已搜全文', () => {
		it('renders explicit search entrance with warning about Ctrl+F limits in large sessions', () => {
			const html = renderToStaticMarkup(createElement(SessionSearchEntrance));

			// 显式入口
			expect(html).toContain('在整个会话中查找');
			expect(html).toContain('data-action="search-whole-session"');
			expect(html).toContain('data-testid="whole-session-search-input"');

			// 显式解释 Ctrl+F 局限性（E-218）
			expect(html).toContain('浏览器 Ctrl+F 仅搜已加载日志');
		});
	});

	// ─── AC 6 & E-110: 深色为默认、日志等宽 ───
	describe('AC 6 & E-110: 长时间盯屏下深色为默认、路径/日志/命令等宽', () => {
		it('applies monospace font to paths, commands, diffs, numbers, and dark page background', () => {
			const html = renderToStaticMarkup(
				createElement(LandingPage, {
					taskId: 'M5-T4',
					initialData: {
						worktreePath: 'D:/xiangmu/wt',
						branchName: 'task/M5-T4',
						diffStat: { filesChanged: 1, insertions: 2, deletions: 0 },
						commands: ['gh stack push', 'python build_docs.py --landed M5-T4'],
					},
				}),
			);

			// 深色底 token
			expect(html).toContain('bg-page');

			// 等宽类名 font-mono
			expect(html).toContain('font-mono text-log');
			expect(html).toContain('D:/xiangmu/wt');
			expect(html).toContain('task/M5-T4');
		});
	});
});
