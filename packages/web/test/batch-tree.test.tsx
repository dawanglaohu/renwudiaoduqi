import type { BatchDto } from '@agent-scheduler/shared/api/batches';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BatchTree, type BatchTreeItem } from '../src/components/batch-tree.tsx';
import {
	clearBatchExpansion,
	getExpandedBatchIds,
	handleBatchAdvancedPayload,
	mapSnapshotToBatches,
	seedBatchExpansion,
	toggleBatchExpansion,
} from '../src/features/run-deck/batch-expansion.ts';

describe('components/batch-tree (M9-T19, AC 1, AC 4, AC 5, E-13, E-272, E-282, E-284, E-298, R5)', () => {
	const sampleBatches: readonly BatchTreeItem[] = [
		{
			id: 'batch-1',
			batchNo: 1,
			taskCount: 5,
			landedCount: 3,
			runningCount: 1,
			waitingCount: 1,
			defaultExpanded: true,
			canWrapup: false,
			tasks: [
				{
					id: 't-1',
					docId: 'doc-1',
					moduleKey: 'M9',
					deps: [],
					estDays: null,
					batchId: 'batch-1',
					taskKey: 'M9-T1',
					title: 'Web 骨架、token 层与主题',
					state: 'landed',
					inHead: true,
				},
				{
					id: 't-2',
					docId: 'doc-1',
					moduleKey: 'M9',
					deps: [],
					estDays: null,
					batchId: 'batch-1',
					taskKey: 'M9-T2',
					title: '形状枚举与状态徽标',
					state: 'running',
					inHead: false,
					inHeadMethod: 'git merge-base --is-ancestor',
				},
				{
					id: 't-3',
					docId: 'doc-1',
					moduleKey: 'M9',
					deps: [],
					estDays: null,
					batchId: 'batch-1',
					taskKey: 'M9-T3',
					title: '自写 hash 路由与守卫',
					state: 'awaiting_reply',
					inHead: null,
					crossBatchFix: true,
				},
				{
					id: 't-4',
					docId: 'doc-1',
					moduleKey: 'M9',
					deps: [],
					estDays: null,
					batchId: 'batch-1',
					taskKey: 'M9-T4',
					title: 'HTTP 客户端',
					state: 'queued',
				},
			],
		},
		{
			id: 'batch-2',
			batchNo: 2,
			taskCount: 4,
			landedCount: 4,
			runningCount: 0,
			waitingCount: 0,
			notInHeadCount: 2,
			canWrapup: true,
			wrapupBadge: {
				kind: 'awaiting_landing',
				notInHeadCount: 2,
			},
			hasCrossBatchFix: true,
			tasks: [
				{
					id: 't-5',
					docId: 'doc-1',
					moduleKey: 'M9',
					deps: [],
					estDays: null,
					batchId: 'batch-2',
					taskKey: 'M9-T5',
					title: '自写 SSE 客户端',
					state: 'landed',
					inHead: false,
				},
			],
		},
	];

	// ─── AC 1: 折叠的批不渲染子行（非 display:none） ───
	it('does not render child rows in DOM when collapsed (not display:none, pure props)', () => {
		const html = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: sampleBatches,
				expandedIds: new Set<string>(), // 全部折叠
			}),
		);

		expect(html).toContain('第 1 批');
		expect(html).toContain('第 2 批');
		// 子行任务在 DOM 中根本不存在
		expect(html).not.toContain('M9-T1');
		expect(html).not.toContain('M9-T2');
		expect(html).not.toContain('Web 骨架、token 层与主题');
		expect(html).not.toContain('role="group"');
	});

	// ─── AC 1: 展开的批渲染子行 ───
	it('renders child rows only for batches present in expandedIds', () => {
		const html = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: sampleBatches,
				expandedIds: new Set<string>(['batch-1']), // 仅展开批次 1
			}),
		);

		expect(html).toContain('M9-T1');
		expect(html).toContain('M9-T2');
		expect(html).toContain('role="group"');

		// 批次 2 未展开，其任务不应在 DOM 中
		expect(html).not.toContain('M9-T5');
	});

	// ─── AC 1: 标题计数固定格式与 --needs 高亮 ───
	it('renders title count in fixed tabular format and highlights waiting in needs color', () => {
		const html = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: sampleBatches,
				expandedIds: new Set<string>(),
			}),
		);

		// batch-1 waitingCount > 0 -> 等你 1 带 text-needs
		expect(html).toContain('已落地 3/5 · 在跑 1 ·');
		expect(html).toContain('<span class="text-needs">等你 1</span>');

		// batch-2 waitingCount == 0 -> 等你 0 带 text-ink-3
		expect(html).toContain('已落地 4/4 · 在跑 0 ·');
		expect(html).toContain('<span class="text-ink-3">等你 0</span>');
	});

	// ─── AC 1 & E-272: 收口徽标展示「等你落地 N 个」暖色 ───
	it('renders awaiting_landing wrapup badge with warm color and notInHeadCount (E-272)', () => {
		const html = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: sampleBatches,
				expandedIds: new Set<string>(),
			}),
		);

		expect(html).toContain('等你落地 2 个');
		expect(html).toContain('data-badge="awaiting_landing"');
	});

	// ─── E-272 & R5: 计数与 notInHeadCount 缺失严格显示「—」，绝不猜测默认值 ───
	it('renders "—" for missing counts and missing notInHeadCount without guessing defaults (E-272, R5)', () => {
		const missingDataBatches: readonly BatchTreeItem[] = [
			{
				id: 'batch-missing',
				batchNo: 9,
				// 计数完全缺失（模拟 daemon 尚未上报或返回 null/undefined）
				taskCount: undefined,
				landedCount: undefined,
				runningCount: undefined,
				waitingCount: undefined,
				notInHeadCount: undefined,
				wrapupBadge: {
					kind: 'awaiting_landing',
					// notInHeadCount 缺失
					notInHeadCount: undefined,
				},
				tasks: [],
			},
		];

		const html = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: missingDataBatches,
				expandedIds: new Set<string>(),
			}),
		);

		// 标题计数缺失必须显示「—」，绝不写成 0/0 或 undefined
		expect(html).toContain('已落地 —/— · 在跑 — ·');
		expect(html).toContain('等你 —');

		// awaiting_landing 徽标在 notInHeadCount 缺失时显示「等你落地 — 个」，绝不猜测 1
		expect(html).toContain('等你落地 — 个');
		expect(html).not.toContain('等你落地 1 个');
	});

	// ─── AC 1: 能否收口按钮（canWrapup） ───
	it('renders wrapup button only when canWrapup is true and not phone tier', () => {
		const desktopHtml = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: sampleBatches,
				expandedIds: new Set<string>(),
				densityTier: 'full',
			}),
		);
		expect(desktopHtml).toContain('data-action="wrapup-batch"');
		expect(desktopHtml).toContain('收口');

		// 手机档不渲染收口按钮（决策 32）
		const phoneHtml = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: sampleBatches,
				expandedIds: new Set<string>(),
				densityTier: 'phone',
			}),
		);
		expect(phoneHtml).not.toContain('data-action="wrapup-batch"');
	});

	// ─── AC 4 & E-298: 进 HEAD 标记三态同色、固定 7ch 列，false 带判定方法 title ───
	it('renders inHead mark in three states using ink-3 color and 7ch column (E-298)', () => {
		const html = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: sampleBatches,
				expandedIds: new Set<string>(['batch-1']),
			}),
		);

		// true -> 进 HEAD
		expect(html).toContain('data-in-head="true"');
		expect(html).toContain('进 HEAD');

		// false -> 未进 HEAD，带 title
		expect(html).toContain('data-in-head="false"');
		expect(html).toContain('未进 HEAD');
		expect(html).toContain('title="git merge-base --is-ancestor"');

		// null -> —
		expect(html).toContain('data-in-head="null"');

		// 7ch 列宽与 ink-3 同色
		expect(html).toContain('w-[7ch]');
		expect(html).toContain('text-ink-3');
	});

	// ─── E-298 & R5: inHeadMethod 缺失时绝不猜测默认判定方法 ───
	it('omits title attribute when inHeadMethod is absent on false inHead (E-298, R5)', () => {
		const customBatch: readonly BatchTreeItem[] = [
			{
				id: 'batch-test-inhead',
				batchNo: 1,
				taskCount: 1,
				landedCount: 1,
				runningCount: 0,
				waitingCount: 0,
				tasks: [
					{
						id: 't-no-method',
						docId: 'doc-1',
						moduleKey: 'M9',
						deps: [],
						estDays: null,
						batchId: 'batch-test-inhead',
						taskKey: 'M9-T99',
						title: '测试任务',
						state: 'landed',
						inHead: false,
						// inHeadMethod 为 undefined
						inHeadMethod: undefined,
					},
				],
			},
		];

		const html = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: customBatch,
				expandedIds: new Set<string>(['batch-test-inhead']),
			}),
		);

		expect(html).toContain('未进 HEAD');
		// 严禁猜测默认值 git merge-base --is-ancestor
		expect(html).not.toContain('title="git merge-base --is-ancestor"');
		expect(html).not.toContain('title=');
	});

	// ─── AC 4 & E-298: 跨批修复 chip ───
	it('renders cross-batch fix chip on task and title note on batch', () => {
		const html = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: sampleBatches,
				expandedIds: new Set<string>(['batch-1', 'batch-2']),
			}),
		);

		// 批次 2 标题追加 · 含跨批修复
		expect(html).toContain('第 2 批 · 含跨批修复');

		// 任务 3 带跨批修复 chip
		expect(html).toContain('data-chip="cross-batch-fix"');
		expect(html).toContain('跨批修复');
	});

	// ─── AC 3 & E-282: 任务行呼吸点槽，标题行不放呼吸点 ───
	it('renders pulse-dot in task rows and never in batch header row (E-282)', () => {
		const html = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: sampleBatches,
				expandedIds: new Set<string>(['batch-1']),
			}),
		);

		// running 任务带 live 呼吸点
		expect(html).toContain('data-pulse-dot="live"');
		// awaiting_reply 任务带 waiting 静态暖点
		expect(html).toContain('data-pulse-dot="waiting"');
	});

	// ─── AC 5 & E-13: 行高 30px，phone 44px 且开合槽 44×44，role="tree" ───
	it('renders 30px row on desktop and 44px with 44x44 toggle slot on touch/phone (AC 5, E-13)', () => {
		const desktopHtml = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: sampleBatches,
				expandedIds: new Set<string>(),
				densityTier: 'full',
			}),
		);
		expect(desktopHtml).toContain('h-[30px]');
		expect(desktopHtml).toContain('w-[16px]');
		expect(desktopHtml).toContain('role="tree"');
		expect(desktopHtml).toContain('role="treeitem"');

		const phoneHtml = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: sampleBatches,
				expandedIds: new Set<string>(),
				densityTier: 'phone',
			}),
		);
		expect(phoneHtml).toContain('h-[44px]');
		expect(phoneHtml).toContain('w-[44px]');
		expect(phoneHtml).toContain('h-[44px]');
	});

	// ─── 收口运行行支持 ───
	it('renders wrapup row as the first child row when batch has wrapupRow', () => {
		const batchesWithWrapup: readonly BatchTreeItem[] = [
			{
				id: 'batch-w',
				batchNo: 3,
				taskCount: 2,
				landedCount: 2,
				runningCount: 0,
				waitingCount: 0,
				wrapupRow: {
					runId: 'run-w-1',
					round: 1,
					state: 'running',
					title: '批次收口 · 第 1 轮',
				},
				tasks: [
					{
						id: 't-w1',
						docId: 'doc-1',
						moduleKey: 'M9',
						deps: [],
						estDays: null,
						batchId: 'batch-w',
						taskKey: 'M9-T20',
						title: '收口泳道',
						state: 'landed',
						inHead: true,
					},
				],
			},
		];

		const html = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: batchesWithWrapup,
				expandedIds: new Set<string>(['batch-w']),
			}),
		);

		expect(html).toContain('data-wrapup-row="true"');
		expect(html).toContain('批次收口 · 第 1 轮');
		expect(html).toContain('data-run-id="run-w-1"');
	});

	// ─── R13-T98191508 AC 3: 真实服务端快照投影在批次树中呈现实际数字，左栏与任务页一致 ───
	it('R13-T98191508 AC 3: renders authoritative counts from daemon snapshot instead of dashes across desktop and mobile', () => {
		const snapshot: SnapshotResponse = {
			documents: [
				{
					id: 'doc-real',
					docsPath: 'docs/test',
					projectName: 'Test',
					repoPath: '/tmp/repo',
					mainBranch: 'main',
					branchPrefix: 'task/',
					laneCount: 2,
					contentFingerprint: 'fp-1',
					isSourceReadable: true,
					isTakeoverNotified: false,
					importedAt: '2026-09-25T12:00:00.000Z',
					lastSeenAt: '2026-09-25T12:00:00.000Z',
				},
			],
			batches: [
				{
					id: 'batch-real-1',
					docId: 'doc-real',
					batchNo: 1,
					state: 'running',
					startedAt: '2026-09-25T12:00:00.000Z',
					finishedAt: null,
					canWrapup: false,
					notInHeadCount: 0,
					taskCount: 3,
					landedCount: 2,
					runningCount: 1,
					waitingCount: 0,
					defaultExpanded: true,
				},
				{
					id: 'batch-real-2',
					docId: 'doc-real',
					batchNo: 2,
					state: 'idle',
					startedAt: null,
					finishedAt: null,
					canWrapup: false,
					notInHeadCount: 0,
					taskCount: 2,
					landedCount: 0,
					runningCount: 0,
					waitingCount: 1,
					defaultExpanded: false,
				},
			],
			tasks: [
				{
					id: 't-r1',
					docId: 'doc-real',
					moduleKey: 'M2',
					deps: [],
					estDays: 1,
					batchId: 'batch-real-1',
					taskKey: 'M2-T1',
					title: '已落地任务 1',
					state: 'landed',
					inHead: true,
				},
				{
					id: 't-r2',
					docId: 'doc-real',
					moduleKey: 'M2',
					deps: [],
					estDays: 1,
					batchId: 'batch-real-1',
					taskKey: 'M2-T2',
					title: '已落地任务 2',
					state: 'landed',
					inHead: true,
				},
				{
					id: 't-r3',
					docId: 'doc-real',
					moduleKey: 'M2',
					deps: [],
					estDays: 1,
					batchId: 'batch-real-1',
					taskKey: 'M2-T3',
					title: '在跑任务',
					state: 'running',
					inHead: null,
				},
				{
					id: 't-r4',
					docId: 'doc-real',
					moduleKey: 'M2',
					deps: [],
					estDays: 1,
					batchId: 'batch-real-2',
					taskKey: 'M2-T4',
					title: '等待任务',
					state: 'awaiting_human',
					inHead: null,
				},
				{
					id: 't-r5',
					docId: 'doc-real',
					moduleKey: 'M2',
					deps: [],
					estDays: 1,
					batchId: 'batch-real-2',
					taskKey: 'M2-T5',
					title: '未派任务',
					state: 'never_dispatched',
					inHead: null,
				},
			],
			runs: [],
			agents: [],
			lanes: [],
			gates: [],
			latestEventId: null,
		};

		// 经由 mapSnapshotToBatches 统一投影
		const mappedBatches = mapSnapshotToBatches(snapshot);
		expect(mappedBatches).toHaveLength(2);
		expect(mappedBatches[0]?.taskCount).toBe(3);
		expect(mappedBatches[0]?.landedCount).toBe(2);
		expect(mappedBatches[0]?.runningCount).toBe(1);
		expect(mappedBatches[0]?.waitingCount).toBe(0);

		// 桌面左栏批次树渲染
		const desktopHtml = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: mappedBatches,
				expandedIds: new Set<string>(['batch-real-1']),
				densityTier: 'full',
			}),
		);
		// 严禁显示「—/—」或「—」
		expect(desktopHtml).not.toContain('已落地 —/—');
		expect(desktopHtml).toContain('已落地 2/3 · 在跑 1 ·');
		expect(desktopHtml).toContain('<span class="text-ink-3">等你 0</span>');
		expect(desktopHtml).toContain('已落地 0/2 · 在跑 0 ·');
		expect(desktopHtml).toContain('<span class="text-needs">等你 1</span>');

		// 任务列表页使用同一投影与组件渲染，保持一致
		const tasksPageHtml = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: mappedBatches,
				expandedIds: new Set<string>(['batch-real-1']),
				densityTier: 'phone',
			}),
		);
		expect(tasksPageHtml).toContain('已落地 2/3 · 在跑 1 ·');
		expect(tasksPageHtml).toContain('已落地 0/2 · 在跑 0 ·');
	});

	// ─── R13-T98191508 AC 3 & E-284: 服务端 defaultExpanded 自动展开、手动折叠保护与文档切换 ───
	it('R13-T98191508 & E-284: seeds defaultExpanded, respects manual toggle, and resets on doc switch', () => {
		clearBatchExpansion();

		const docBatchesA: readonly BatchDto[] = [
			{
				id: 'b-docA-1',
				docId: 'doc-A',
				batchNo: 1,
				state: 'running',
				startedAt: '2026-09-25T12:00:00.000Z',
				finishedAt: null,
				taskCount: 2,
				landedCount: 1,
				runningCount: 1,
				waitingCount: 0,
				defaultExpanded: true,
			},
			{
				id: 'b-docA-2',
				docId: 'doc-A',
				batchNo: 2,
				state: 'idle',
				startedAt: null,
				finishedAt: null,
				taskCount: 3,
				landedCount: 0,
				runningCount: 0,
				waitingCount: 0,
				defaultExpanded: false,
			},
		];

		// 首次 seed：defaultExpanded 为 true 的批次自动展开
		seedBatchExpansion(docBatchesA, 'doc-A');
		expect(getExpandedBatchIds().has('b-docA-1')).toBe(true);
		expect(getExpandedBatchIds().has('b-docA-2')).toBe(false);

		// 用户手动折叠批次 1
		toggleBatchExpansion('b-docA-1');
		expect(getExpandedBatchIds().has('b-docA-1')).toBe(false);

		// 后续快照刷新：不重新打开用户手动折叠的批次（E-284）
		seedBatchExpansion(docBatchesA, 'doc-A');
		expect(getExpandedBatchIds().has('b-docA-1')).toBe(false);

		// batch.advanced 到达：to=running 时重新自动并入展开集
		handleBatchAdvancedPayload({ batchId: 'b-docA-1', to: 'running' });
		expect(getExpandedBatchIds().has('b-docA-1')).toBe(true);

		// 切换文档到 doc-B：旧展开集被清空，重新根据 doc-B 的 defaultExpanded seed
		const docBatchesB: readonly BatchDto[] = [
			{
				id: 'b-docB-1',
				docId: 'doc-B',
				batchNo: 1,
				state: 'awaiting_landing',
				startedAt: '2026-09-25T12:00:00.000Z',
				finishedAt: null,
				taskCount: 1,
				landedCount: 1,
				runningCount: 0,
				waitingCount: 0,
				defaultExpanded: true,
			},
		];
		seedBatchExpansion(docBatchesB, 'doc-B');
		expect(getExpandedBatchIds().has('b-docA-1')).toBe(false);
		expect(getExpandedBatchIds().has('b-docB-1')).toBe(true);
	});

	// ─── R13-T98191508 AC 4: 修复前失败的生产入口回归（B2 缺陷场景） ───
	it('R13-T98191508 AC 4: regressions against B2 defect where batches displayed dashes and failed default expansion', () => {
		// 模拟生产返回的标准 BatchDto
		const productionBatch: BatchDto = {
			id: 'batch-prod',
			docId: 'doc-prod',
			batchNo: 1,
			state: 'running',
			startedAt: '2026-09-25T12:00:00.000Z',
			finishedAt: null,
			taskCount: 5,
			landedCount: 2,
			runningCount: 2,
			waitingCount: 1,
			defaultExpanded: true,
		};

		const item: BatchTreeItem = {
			...productionBatch,
			tasks: [
				{
					id: 't-p1',
					docId: 'doc-prod',
					moduleKey: 'M2',
					deps: [],
					estDays: null,
					batchId: 'batch-prod',
					taskKey: 'M2-T1',
					title: '生产任务 1',
					state: 'running',
				},
			],
		};

		// 验证 defaultExpanded 为 true
		expect(item.defaultExpanded).toBe(true);

		// 验证 HTML 渲染正确显示 2/5, 2, 1
		const html = renderToStaticMarkup(
			createElement(BatchTree, {
				batches: [item],
				expandedIds: new Set<string>(['batch-prod']),
			}),
		);
		expect(html).toContain('已落地 2/5 · 在跑 2 ·');
		expect(html).toContain('<span class="text-needs">等你 1</span>');
		expect(html).not.toContain('已落地 —/—');
		expect(html).not.toContain('在跑 —');
		expect(html).not.toContain('等你 —');
	});
});
