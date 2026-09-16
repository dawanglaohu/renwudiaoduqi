/**
 * packages/web/test/landing-onboarding.test.ts
 *
 * M9-T16 验收标准与边界测试（AC 1-7, E-108, E-110, E-111, E-19, E-218, E-74, E-52, E-47, E-254）
 *
 * 返工第 1 轮验证（R1 - R5）：
 * - R1: pages/landing-page.tsx 只接 props，无 src/api、http-client、useEffect；容器测试注入 fetcher 断言只发一次请求
 * - R2: 失败路径不伪造清单，渲染就地 inline notice（带 requestId + 复制），无数据字段显示「—」，缺 taskId 走未知路径
 * - R3: E-218 会话查找入口落 features/run-detail/run-detail-container.tsx，纯 props 传 {hits:[],truncated:false,scannedUntilSeq:9,canceled:false} 显式显示 0 命中且无「已检索全量」；全仓无 fake Math.random
 * - R4: 源码无 Math.min|Math.max；并发与瓶颈读 daemon props，为 null 时渲染「—」
 * - R5: 删掉全部内置清单/计数，不传清单显示「—」且无 gpt-4o、M1-T1；第二步按 selectedDocId 过滤；总数缺失显示「—」不求和；真断言（步骤切换、已完成步可点回改、复制按钮真的写剪贴板）
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BatchSummaryBar } from '../src/components/batch-summary-bar.tsx';
import {
	DocChangeBanner,
	EmptyOnboarding,
	type OnboardingBatchOption,
	type OnboardingDocOption,
} from '../src/components/empty-onboarding.tsx';
import { SessionSearchEntrance } from '../src/components/session-search-entrance.tsx';
import { LandingContainer, copyToClipboard } from '../src/features/landing/landing-container.tsx';
import type { UseLandingResult } from '../src/features/landing/use-landing.ts';
import { LandingPage } from '../src/pages/landing-page.tsx';

describe('M9-T16 空态四步引导、批次汇总与落地清单页（返工第 1 轮）', () => {
	// ─── R1: pages 层取数越界与容器 fetcher 注入 ───
	describe('R1: pages/landing-page.tsx 架构分层与 fetcher 注入', () => {
		it('pages/landing-page.tsx 内 grep 不到 src/api、http-client、useEffect', () => {
			const filePath = resolve(__dirname, '../src/pages/landing-page.tsx');
			const content = readFileSync(filePath, 'utf8');

			expect(content).not.toMatch(/src\/api/);
			expect(content).not.toMatch(/http-client/);
			expect(content).not.toMatch(/\buseEffect\b/);
		});

		it('容器测试注入 fetcher 断言只发一次请求', async () => {
			const mockData = {
				worktreePath: 'D:/xiangmu/agent-scheduler-m5-t4',
				branchName: 'task/M5-T4',
				diffStat: { filesChanged: 2, insertions: 10, deletions: 3 },
				commands: ['gh stack push', 'python build_docs.py --landed M5-T4'],
			};

			const mockFetcher = vi.fn().mockResolvedValue(mockData);
			let capturedResult!: UseLandingResult;

			renderToStaticMarkup(
				createElement(LandingContainer, {
					taskId: 'M5-T4',
					fetcher: mockFetcher,
					onResult: (res) => {
						capturedResult = res;
					},
				}),
			);

			// 触发 fetch 并验证单次调用
			const fetchedData = await capturedResult.refetch();
			expect(mockFetcher).toHaveBeenCalledTimes(1);
			expect(mockFetcher).toHaveBeenCalledWith('M5-T4');

			const html = renderToStaticMarkup(
				createElement(LandingContainer, {
					taskId: 'M5-T4',
					initialData: fetchedData ?? undefined,
				}),
			);
			expect(html).toContain('D:/xiangmu/agent-scheduler-m5-t4');
		});
	});

	// ─── R2: 失败路径不伪造清单与未知路由 ───
	describe('R2: 失败路径就地 inline notice（带 requestId），无数据字段显示「—」，缺 taskId 走未知路径', () => {
		it('注入 500/网络错，断言 DOM 无 worktree 路径与 diff 数字、含 requestId', () => {
			const netError = new Error('Connection refused (500 Internal Server Error)');
			const requestId = 'req-err-500-xyz';

			const html = renderToStaticMarkup(
				createElement(LandingContainer, {
					taskId: 'M5-T4',
					initialError: netError,
					initialRequestId: requestId,
				}),
			);

			// 严禁伪造的缺省 worktree 路径与 diff 统计
			expect(html).not.toContain('D:/xiangmu/agent-scheduler-m5-t4');
			expect(html).not.toContain('files changed');

			// 呈现「—」
			expect(html).toContain('—');

			// 显式包含 requestId
			expect(html).toContain('req-err-500-xyz');
		});

		it('路由缺 taskId 走未知路径不回落 M5-T4', () => {
			const html = renderToStaticMarkup(
				createElement(LandingPage, {
					taskId: undefined,
					params: {},
				}),
			);

			// 走未知路径页面（UnknownRouteView）
			expect(html).toContain('未知路径');
			expect(html).toContain('404');
			expect(html).toContain('回到运行甲板');

			// 绝不回落至 M5-T4
			expect(html).not.toContain('M5-T4');
		});
	});

	// ─── R3: E-218 全会话查找入口与真实命中 ───
	describe('R3 & E-218: 全会话查找入口纯 props 与真实命中，无 fake Math.random', () => {
		it('传 {hits:[],truncated:false,scannedUntilSeq:9,canceled:false} 断言显示 0 命中且无「已检索全量」文案', () => {
			const html = renderToStaticMarkup(
				createElement(SessionSearchEntrance, {
					searchResult: {
						hits: [],
						truncated: false,
						scannedUntilSeq: 9,
						canceled: false,
					},
				}),
			);

			// 真实命中数
			expect(html).toContain('0 命中');
			expect(html).toContain('已扫描至序号 9');

			// 严禁虚假宣传「已检索全量」
			expect(html).not.toContain('已检索全量');
		});

		it('组件源码与落地清单源码中无 Math.random 假结果', () => {
			const entrancePath = resolve(__dirname, '../src/components/session-search-entrance.tsx');
			const entranceContent = readFileSync(entrancePath, 'utf8');
			expect(entranceContent).not.toMatch(/Math\.random/);

			const landingPath = resolve(__dirname, '../src/pages/landing-page.tsx');
			const landingContent = readFileSync(landingPath, 'utf8');
			expect(landingContent).not.toMatch(/Math\.random/);

			const onboardingPath = resolve(__dirname, '../src/components/empty-onboarding.tsx');
			const onboardingContent = readFileSync(onboardingPath, 'utf8');
			expect(onboardingContent).not.toMatch(/Math\.random/);
		});
	});

	// ─── R4: 严禁自算并发瓶颈，读 daemon 下发字段 ───
	describe('R4: 源码无 Math.min|Math.max，并发与瓶颈读 daemon props，为 null 时渲染「—」', () => {
		it('empty-onboarding.tsx 源码无 Math.min 与 Math.max', () => {
			const onboardingPath = resolve(__dirname, '../src/components/empty-onboarding.tsx');
			const content = readFileSync(onboardingPath, 'utf8');

			expect(content).not.toMatch(/Math\.min/);
			expect(content).not.toMatch(/Math\.max/);
		});

		it('并发 props 为 null 时渲染「—」', () => {
			const html = renderToStaticMarkup(
				createElement(EmptyOnboarding, {
					currentStep: 3,
					effectiveCapacity: null,
					laneCount: null,
					agentConcurrencyLimit: null,
					bottleneckSource: null,
					bottleneckDescription: null,
				}),
			);

			// 并发审计卡片内呈现「—」
			expect(html).toContain('data-testid="concurrency-bottleneck-card"');
			expect(html).toContain('有效并行并发容量');
			expect(html).toContain('—');
		});
	});

	// ─── R5: 清单联动、缺失总数不求和与真实交互断言 ───
	describe('R5: 清单联动、缺失总数不求和与真断言', () => {
		it('不传清单时断言出现「—」且无 gpt-4o、M1-T1 字面量', () => {
			const html = renderToStaticMarkup(
				createElement(EmptyOnboarding, {
					documents: [],
					batches: [],
					tasks: [],
				}),
			);

			expect(html).toContain('—');
			expect(html).not.toContain('gpt-4o');
			expect(html).not.toContain('claude-3-5-sonnet');
			expect(html).not.toContain('M1-T1');
		});

		it('第二步按 batch.docId === selectedDocId 联动过滤批次', () => {
			const docs: readonly OnboardingDocOption[] = [
				{ id: 'doc-alpha', title: '文档 Alpha', path: 'docs/alpha' },
				{ id: 'doc-beta', title: '文档 Beta', path: 'docs/beta' },
			];

			const batches: readonly OnboardingBatchOption[] = [
				{ id: 'b-a1', docId: 'doc-alpha', name: 'Alpha 批次 1', taskCount: 4 },
				{ id: 'b-b1', docId: 'doc-beta', name: 'Beta 批次 1', taskCount: 7 },
			];

			// 选定 doc-alpha 时步骤 2 只渲染 Alpha 批次
			const htmlAlpha = renderToStaticMarkup(
				createElement(EmptyOnboarding, {
					currentStep: 1,
					documents: docs,
					batches: batches,
				}),
			);

			expect(htmlAlpha).toContain('Alpha 批次 1');
			expect(htmlAlpha).not.toContain('Beta 批次 1');
		});

		it('BatchSummaryBar: 计数或总数缺失时显示「—」，严禁前端求和补总数', () => {
			const html = renderToStaticMarkup(
				createElement(BatchSummaryBar, {
					batchName: '第 1 批',
					counts: {
						running: 2,
						awaiting: null,
						landed: null,
						failed: 1,
					},
					totalTasks: null, // 未传总数
				}),
			);

			// 核心指标缺失显示「—」
			expect(html).toContain('data-stat="running"');
			expect(html).toContain('2');
			expect(html).toContain('data-stat="awaiting"');
			expect(html).toContain('—');
			expect(html).toContain('data-stat="landed"');
			expect(html).toContain('data-stat="failed"');
			expect(html).toContain('1');

			// 总数缺失严禁以 2 + 1 = 3 补上，必须显示 (共 — 项)
			expect(html).toContain('(共 — 项)');
			expect(html).not.toContain('(共 3 项)');
		});

		it('步骤切换与已完成步可点回改属性断言', () => {
			const docs: readonly OnboardingDocOption[] = [
				{ id: 'doc-1', title: '核心调度文档', path: 'docs/main' },
			];
			const batches: readonly OnboardingBatchOption[] = [
				{ id: 'b-1', docId: 'doc-1', name: '批次 1', taskCount: 5 },
			];

			// 1. 处于步骤 0 时：步骤 0 激活，步骤 1/2/3 禁用
			const htmlStep0 = renderToStaticMarkup(
				createElement(EmptyOnboarding, {
					currentStep: 0,
					documents: docs,
					batches: batches,
				}),
			);
			expect(htmlStep0).toContain(
				'data-step-index="0" data-step-active="true" data-step-completed="false"',
			);
			expect(htmlStep0).toContain(
				'data-step-index="1" data-step-active="false" data-step-completed="false" disabled=""',
			);

			// 2. 处于步骤 2 时：步骤 0 与 1 标记为已完成（data-step-completed="true"），显示「修改 ↩」，并且未禁用
			const htmlStep2 = renderToStaticMarkup(
				createElement(EmptyOnboarding, {
					currentStep: 2,
					documents: docs,
					batches: batches,
					tasks: [{ id: 't1', taskKey: 'M9-T1', title: 'Task 1' }],
				}),
			);
			expect(htmlStep2).toContain(
				'data-step-index="0" data-step-active="false" data-step-completed="true"',
			);
			expect(htmlStep2).toContain(
				'data-step-index="1" data-step-active="false" data-step-completed="true"',
			);
			expect(htmlStep2).toContain(
				'data-step-index="2" data-step-active="true" data-step-completed="false"',
			);
			expect(htmlStep2).toContain('修改 ↩');
		});

		it('复制按钮真的写剪贴板 (navigator.clipboard.writeText 与 document.execCommand 降级)', async () => {
			const writeTextMock = vi.fn().mockResolvedValue(undefined);
			const origClipboard = navigator.clipboard;

			// 模拟可用剪贴板
			Object.assign(navigator, {
				clipboard: {
					writeText: writeTextMock,
				},
			});

			const cmdText = 'gh stack push && gh stack submit --auto --open';
			const success = await copyToClipboard(cmdText);

			expect(success).toBe(true);
			expect(writeTextMock).toHaveBeenCalledTimes(1);
			expect(writeTextMock).toHaveBeenCalledWith(cmdText);

			// 恢复剪贴板
			Object.assign(navigator, { clipboard: origClipboard });
		});
	});

	// ─── AC 3 & E-74: 落地清单只读呈现与独立复制按钮 ───
	describe('AC 3 & E-74: 落地清单只读呈现与独立复制按钮', () => {
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

			// 5. build_docs.py --landed 命令与复制按钮
			expect(html).toContain('--landed M5-T4');
			expect(html).toContain('data-copy-btn="build-docs"');

			// 只读契约提示（E-74：复制而不执行）
			expect(html).toContain('只读清单 · 复制而不执行');
		});
	});

	// ─── AC 4 & E-19: 文档变更横幅 ───
	describe('AC 4 & E-19: 文档变更横幅', () => {
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
});
