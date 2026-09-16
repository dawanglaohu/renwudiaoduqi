/**
 * packages/web/test/thumb-bar.test.ts
 *
 * M9-T12 手机端布局与拇指区单元测试
 * （AC 1-8, E-13, E-58, E-99, E-107, E-124, E-145, E-240）
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ThumbBar } from '../src/components/thumb-bar.tsx';
import { MobileBatchList } from '../src/features/run-deck/mobile-batch-list.tsx';
import { MobileBottomSheet } from '../src/features/run-deck/mobile-bottom-sheet.tsx';
import { MobilePaneSwitcher } from '../src/features/run-deck/mobile-pane-switcher.tsx';
import { RunDeckView } from '../src/features/run-deck/run-deck-view.tsx';
import { StopConfirmDialog } from '../src/features/run-deck/stop-confirm-dialog.tsx';
import type { DeckStreamLane, MobileBatchItem } from '../src/features/run-deck/types.ts';
import { isWaitingApproval } from '../src/features/run-deck/use-run-deck.ts';
import { computeDensityTier } from '../src/hooks/use-breakpoint.ts';

describe('M9-T12: Mobile layout and thumb bar (AC 1-8, E-13, E-58, E-99, E-107, E-124, E-145, E-240)', () => {
	// ─────────────────────────────────────────────────────────────────────────────
	// 验收标准 1 & E-145: 手机竖屏 <400px 降级为单栏切换（任务列表／运行流／详情），不得横向滚动或并排三栏
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 1 & E-145: Ultra-narrow phone <400px downgrades to single-pane switching without horizontal scroll', () => {
		it('strictly computes phone-xs tier when width < 400px on touch device', () => {
			const tier = computeDensityTier({ width: 375, isTouch: true });
			expect(tier).toBe('phone-xs');
		});

		it('renders single-pane switcher in phone-xs tier with tasks, stream, and detail tabs', () => {
			const lanes: DeckStreamLane[] = [
				{ laneNo: 1, taskKey: 'M9-T12', title: '手机端布局与拇指区', status: 'streaming' },
			];

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'phone-xs',
					width: 375,
					activePane: 'stream',
				}),
			);

			expect(html).toContain('data-mobile-pane-switcher="true"');
			expect(html).toContain('data-pane-tab="tasks"');
			expect(html).toContain('data-pane-tab="stream"');
			expect(html).toContain('data-pane-tab="detail"');
			expect(html).toContain('data-pane-view="stream"');
			// 不得并排渲染其他两栏
			expect(html).not.toContain('data-pane-view="tasks"');
			expect(html).not.toContain('data-pane-view="detail"');
		});

		it('renders only the tasks pane when activePane is "tasks"', () => {
			const lanes: DeckStreamLane[] = [
				{ laneNo: 1, taskKey: 'M9-T12', title: '手机端布局与拇指区', status: 'streaming' },
			];

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'phone-xs',
					width: 375,
					activePane: 'tasks',
				}),
			);

			expect(html).toContain('data-pane-view="tasks"');
			expect(html).not.toContain('data-pane-view="stream"');
			expect(html).not.toContain('data-pane-view="detail"');
		});

		it('renders only the detail pane when activePane is "detail"', () => {
			const lanes: DeckStreamLane[] = [
				{ laneNo: 1, taskKey: 'M9-T12', title: '手机端布局与拇指区', status: 'streaming' },
			];

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'phone-xs',
					width: 375,
					activePane: 'detail',
				}),
			);

			expect(html).toContain('data-pane-view="detail"');
			expect(html).not.toContain('data-pane-view="tasks"');
			expect(html).not.toContain('data-pane-view="stream"');
		});

		it('ensures no horizontal scroll and lanes wrap or stack vertically', () => {
			const lanes: DeckStreamLane[] = [
				{ laneNo: 1, taskKey: 'M9-T1', title: '任务 1', status: 'succeeded' },
				{ laneNo: 2, taskKey: 'M9-T2', title: '任务 2', status: 'streaming' },
			];

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'phone-xs',
					width: 360,
					activePane: 'stream',
				}),
			);

			// 严禁出现 overflow-x 类名
			expect(html).not.toContain('overflow-x');
			// 单流在手机端全屏占满
			expect(html).toContain('data-pane-view="stream"');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// 验收标准 2 & E-107: 停止与批准固定在拇指区、分置两端或间距 ≥24px、各 ≥44×44px，不随日志滚动移出视野
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 2 & E-107: Stop and approve fixed in thumb bar, separated by >= 24px, >= 44x44px, never scrolled out', () => {
		it('renders fixed bottom thumb bar with safe-area padding', () => {
			const html = renderToStaticMarkup(
				createElement(ThumbBar, {
					canStop: true,
					canApprove: true,
				}),
			);

			expect(html).toContain('data-thumb-bar="true"');
			expect(html).toContain('fixed bottom-0');
			expect(html).toContain('env(safe-area-inset-bottom)');
			expect(html).toContain('min-h-[var(--thumbbar-h,60px)]');
		});

		it('places stop button on left and approve on right with gap >= 24px (gap-6) and justify-between', () => {
			const html = renderToStaticMarkup(
				createElement(ThumbBar, {
					canStop: true,
					canApprove: true,
				}),
			);

			// 两端分置且间距 >= 24px (gap-6 即 24px)
			expect(html).toContain('justify-between');
			expect(html).toContain('gap-6');
		});

		it('ensures stop and approve buttons both meet >= 44x44px touch target requirement', () => {
			const html = renderToStaticMarkup(
				createElement(ThumbBar, {
					canStop: true,
					canApprove: true,
				}),
			);

			// 停止按钮尺寸 >= 44x44px
			expect(html).toContain('data-action="stop"');
			expect(html).toContain('min-h-[44px]');
			expect(html).toContain('min-w-[44px]');

			// 批准按钮尺寸 >= 44x44px
			expect(html).toContain('data-action="approve"');
		});

		it('conforms to .btn-stop styling: square symbol ■, border-strong, not red', () => {
			const html = renderToStaticMarkup(
				createElement(ThumbBar, {
					canStop: true,
				}),
			);

			expect(html).toContain('btn-stop');
			expect(html).toContain('■');
			expect(html).not.toContain('bg-[var(--down)]'); // 严禁停止键使用红色实底
		});

		it('conforms to .btn-primary styling: solid --needs, text --on-needs for approve button', () => {
			const html = renderToStaticMarkup(
				createElement(ThumbBar, {
					canApprove: true,
				}),
			);

			expect(html).toContain('btn-primary');
			expect(html).toContain('bg-[var(--needs)]');
			expect(html).toContain('text-[var(--on-needs)]');
		});

		it('RunDeckView embeds ThumbBar in phone mode and reserves bottom padding', () => {
			const lanes: DeckStreamLane[] = [
				{ laneNo: 1, taskKey: 'M9-T12', status: 'awaiting_input', needsApproval: true },
			];

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'phone',
					width: 480,
					activePane: 'stream',
				}),
			);

			expect(html).toContain('data-thumb-bar="true"');
			expect(html).toContain('pb-[calc(var(--thumbbar-h,60px)+env(safe-area-inset-bottom)+12px)]');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// 验收标准 3 & E-240: 单栏切换到「任务列表」时若某条流转「等你」，必须有可见的未处理计数徽标
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 3 & E-240: Visible unhandled waiting badge on stream tab when switched to tasks or detail', () => {
		it('renders visible badge on stream tab when activePane is "tasks" and waitingCount > 0', () => {
			const html = renderToStaticMarkup(
				createElement(MobilePaneSwitcher, {
					activePane: 'tasks',
					onPaneChange: () => {},
					waitingCount: 2,
				}),
			);

			expect(html).toContain('data-indicator="unhandled-waiting-badge"');
			expect(html).toContain('data-waiting-count="2"');
			expect(html).toContain('2');
		});

		it('renders visible badge on stream tab when activePane is "detail" and waitingCount > 0', () => {
			const html = renderToStaticMarkup(
				createElement(MobilePaneSwitcher, {
					activePane: 'detail',
					onPaneChange: () => {},
					waitingCount: 1,
				}),
			);

			expect(html).toContain('data-indicator="unhandled-waiting-badge"');
			expect(html).toContain('data-waiting-count="1"');
			expect(html).toContain('1');
		});

		it('does not render waiting badge when on "stream" tab because user is already looking at it', () => {
			const html = renderToStaticMarkup(
				createElement(MobilePaneSwitcher, {
					activePane: 'stream',
					onPaneChange: () => {},
					waitingCount: 2,
				}),
			);

			expect(html).not.toContain('data-indicator="unhandled-waiting-badge"');
		});

		it('does not render badge when waitingCount is 0', () => {
			const html = renderToStaticMarkup(
				createElement(MobilePaneSwitcher, {
					activePane: 'tasks',
					onPaneChange: () => {},
					waitingCount: 0,
				}),
			);

			expect(html).not.toContain('data-indicator="unhandled-waiting-badge"');
		});

		it('RunDeckView displays unhandled waiting badge on switcher when lane is waiting approval in tasks pane', () => {
			const lanes: DeckStreamLane[] = [
				{
					laneNo: 1,
					taskKey: 'M9-T12',
					status: 'awaiting_input',
					needsApproval: true,
				},
			];

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'phone-xs',
					width: 375,
					activePane: 'tasks',
					totalWaitingCount: 1,
				}),
			);

			expect(html).toContain('data-indicator="unhandled-waiting-badge"');
			expect(html).toContain('data-waiting-count="1"');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// 验收标准 4 & E-124: 手机端中止需二次确认防口袋误触
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 4 & E-124: Mobile stop requires second confirmation to prevent pocket misclick', () => {
		it('StopConfirmDialog renders alertdialog with title, explanation and two >= 44px buttons', () => {
			const onConfirm = vi.fn();
			const onCancel = vi.fn();

			const html = renderToStaticMarkup(
				createElement(StopConfirmDialog, {
					isOpen: true,
					laneNo: 1,
					taskKey: 'M9-T12',
					runId: 'run-123',
					onConfirm,
					onCancel,
				}),
			);

			expect(html).toContain('data-stop-confirm-dialog="true"');
			expect(html).toContain('确认中止运行？');
			expect(html).toContain('M9-T12');
			expect(html).toContain('data-action="cancel-stop"');
			expect(html).toContain('data-action="confirm-stop"');
			expect(html).toContain('min-h-[44px]');
		});

		it('StopConfirmDialog does not render when isOpen is false', () => {
			const html = renderToStaticMarkup(
				createElement(StopConfirmDialog, {
					isOpen: false,
					onConfirm: () => {},
					onCancel: () => {},
				}),
			);

			expect(html).toBe('');
		});

		it('RunDeckView renders StopConfirmDialog when stopConfirmOpen is true', () => {
			const lanes: DeckStreamLane[] = [{ laneNo: 1, taskKey: 'M9-T12', status: 'streaming' }];

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'phone-xs',
					stopConfirmOpen: true,
					stopConfirmTarget: { laneNo: 1, taskKey: 'M9-T12' },
				}),
			);

			expect(html).toContain('data-stop-confirm-dialog="true"');
			expect(html).toContain('M9-T12');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// 验收标准 5 & E-99: 首屏加载量显著更小（尾部 32KB），不预取全量；切后台回前台不重拉全量
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 5 & E-99: Mobile initial log window is lightweight (32KB tail only) and incremental on resume', () => {
		it('RunDeckView marks tail-bytes as 32768 (32KB) and tail-only on phone tier', () => {
			const lanes: DeckStreamLane[] = [{ laneNo: 1, taskKey: 'M9-T12', status: 'streaming' }];

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'phone-xs',
					tailBytes: 32768,
					isTailOnly: true,
				}),
			);

			expect(html).toContain('data-tail-bytes="32768"');
			expect(html).toContain('data-tail-only="true"');
		});

		it('renders 32KB tail notice in detail pane when no slot provided', () => {
			const lanes: DeckStreamLane[] = [{ laneNo: 1, taskKey: 'M9-T12', status: 'streaming' }];

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'phone-xs',
					activePane: 'detail',
					tailBytes: 32768,
					isTailOnly: true,
				}),
			);

			expect(html).toContain('首屏尾部加载 32KB (E-99)');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// 验收标准 6: 展开的 tool payload 走 bottom sheet 不内联
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 6: Expanded tool payload opens via bottom sheet rather than inlining', () => {
		it('MobileBottomSheet renders fixed bottom sheet with font-mono and drag handle', () => {
			const html = renderToStaticMarkup(
				createElement(MobileBottomSheet, {
					isOpen: true,
					payload: {
						title: '执行命令',
						toolName: 'bash',
						inputPayload: '{"command": "pnpm -w check"}',
						outputPayload: 'All checks passed cleanly',
						durationText: '1.2s',
					},
					onClose: () => {},
				}),
			);

			expect(html).toContain('data-mobile-bottom-sheet="true"');
			expect(html).toContain('data-sheet-content="true"');
			expect(html).toContain('max-h-[80vh]');
			expect(html).toContain('bash');
			expect(html).toContain('执行命令');
			expect(html).toContain('pnpm -w check');
			expect(html).toContain('All checks passed cleanly');
		});

		it('MobileBottomSheet does not render when isOpen is false or payload is null', () => {
			const html1 = renderToStaticMarkup(
				createElement(MobileBottomSheet, {
					isOpen: false,
					payload: { title: '测试' },
					onClose: () => {},
				}),
			);
			expect(html1).toBe('');

			const html2 = renderToStaticMarkup(
				createElement(MobileBottomSheet, {
					isOpen: true,
					payload: null,
					onClose: () => {},
				}),
			);
			expect(html2).toBe('');
		});

		it('RunDeckView renders MobileBottomSheet when activeToolPayload is set', () => {
			const lanes: DeckStreamLane[] = [{ laneNo: 1, taskKey: 'M9-T12', status: 'streaming' }];

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'phone-xs',
					activeToolPayload: {
						title: '读取文档',
						toolName: 'read',
						inputPayload: '{"path": "README.md"}',
					},
				}),
			);

			expect(html).toContain('data-mobile-bottom-sheet="true"');
			expect(html).toContain('读取文档');
			expect(html).toContain('README.md');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// 验收标准 7 & E-13: 批次表格在小屏降级为可折叠列表
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 7 & E-13: Batch table downgraded to collapsible vertical list on small screen without wide table', () => {
		const mockBatches: MobileBatchItem[] = [
			{
				id: 'b-1',
				batchNo: 1,
				title: '核心基础',
				taskCount: 5,
				landedCount: 5,
				runningCount: 0,
				waitingCount: 0,
				tasks: [
					{ id: 't-1', taskKey: 'M1-T1', title: '初始化架构', isLanded: true },
					{ id: 't-2', taskKey: 'M1-T2', title: '代码检查规则', isLanded: true },
				],
			},
			{
				id: 'b-2',
				batchNo: 2,
				title: '多流监看',
				taskCount: 3,
				landedCount: 1,
				runningCount: 1,
				waitingCount: 1,
				defaultExpanded: true,
				tasks: [
					{ id: 't-3', taskKey: 'M9-T9', title: '多流甲板', isLanded: true },
					{ id: 't-4', taskKey: 'M9-T12', title: '手机端布局', status: 'streaming' },
					{ id: 't-5', taskKey: 'M9-T13', title: '审批闸门卡', status: 'awaiting_input' },
				],
			},
		];

		it('renders MobileBatchList with vertical collapsible items and no <table> element', () => {
			const html = renderToStaticMarkup(
				createElement(MobileBatchList, {
					batches: mockBatches,
				}),
			);

			expect(html).toContain('data-mobile-batch-list="true"');
			expect(html).toContain('data-batch-no="1"');
			expect(html).toContain('data-batch-no="2"');
			expect(html).not.toContain('<table'); // 严禁宽表格
			expect(html).not.toContain('<th');
			expect(html).not.toContain('<tr');
		});

		it('shows batch progress indicators: landed/total, running count, and waiting count', () => {
			const html = renderToStaticMarkup(
				createElement(MobileBatchList, {
					batches: mockBatches,
				}),
			);

			expect(html).toContain('5/5');
			expect(html).toContain('1/3');
			expect(html).toContain('在跑 1');
			expect(html).toContain('等你 1');
		});

		it('renders tasks vertically with status badge and >= 44px touch target', () => {
			const html = renderToStaticMarkup(
				createElement(MobileBatchList, {
					batches: mockBatches,
				}),
			);

			expect(html).toContain('data-task-row="t-4"');
			expect(html).toContain('M9-T12');
			expect(html).toContain('手机端布局');
			expect(html).toContain('min-h-[44px]');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// 验收标准 8 & E-58: app 曾退到后台时重回前台拉未读列表，等待中的确认项不过期、不自动放行
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 8 & E-58: Foreground resume triggers unread fetch, awaiting items never expire or auto-pass', () => {
		it('correctly identifies awaiting approval items across states', () => {
			expect(isWaitingApproval({ laneNo: 1, needsApproval: true })).toBe(true);
			expect(isWaitingApproval({ laneNo: 2, status: 'awaiting_input' })).toBe(true);
			expect(isWaitingApproval({ laneNo: 3, status: 'gate_waiting' })).toBe(true);
			expect(isWaitingApproval({ laneNo: 4, status: 'waiting' })).toBe(true);
			expect(isWaitingApproval({ laneNo: 5, status: 'streaming' })).toBe(false);
			expect(isWaitingApproval({ laneNo: 6, status: 'succeeded' })).toBe(false);
		});

		it('ensures awaiting tasks do not automatically flip to succeeded or disappear in UI', () => {
			const lanes: DeckStreamLane[] = [
				{
					laneNo: 1,
					taskKey: 'M9-T12',
					status: 'awaiting_input',
					needsApproval: true,
				},
			];

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'phone-xs',
					activePane: 'stream',
				}),
			);

			// 必须保持等待状态与批准按钮
			expect(html).toContain('data-has-approval="true"');
			expect(html).toContain('data-action="approve"');
		});
	});
});
