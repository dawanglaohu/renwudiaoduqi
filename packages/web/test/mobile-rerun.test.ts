/**
 * packages/web/test/mobile-rerun.test.ts
 *
 * M9-T13 手机原样重跑入口单元测试
 * （AC 1-5, E-177, E-181, E-178, E-180）
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ThumbBar } from '../src/components/thumb-bar.tsx';
import { MobileRerunBar } from '../src/features/run-detail/mobile-rerun-bar.tsx';
import { RerunConfirmDialog } from '../src/features/run-detail/rerun-confirm-dialog.tsx';
import { RunDetailContainer } from '../src/features/run-detail/run-detail-container.tsx';
import {
	isActiveRunState,
	isTerminalFailureOrAborted,
} from '../src/features/run-detail/use-run-rerun.ts';

describe('M9-T13: Mobile Rerun Entrance (AC 1-5, E-177, E-181)', () => {
	// ─────────────────────────────────────────────────────────────────────────────
	// AC 1 & E-177: 仅对终态失败/已中止的运行可用，严格复用原派发载荷、不出现任何选择器，需一次确认
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 1 & E-177: Only available for terminal failed / aborted runs, strictly reuse payload with zero selectors, requires confirmation', () => {
		it('correctly classifies terminal failed and aborted states', () => {
			// 终态失败或中止状态允许重跑
			expect(isTerminalFailureOrAborted('failed')).toBe(true);
			expect(isTerminalFailureOrAborted('aborted')).toBe(true);
			expect(isTerminalFailureOrAborted('interrupted')).toBe(true);
			expect(isTerminalFailureOrAborted('stopped')).toBe(true);

			// 成功终态（landed / succeeded）不可重跑
			expect(isTerminalFailureOrAborted('landed')).toBe(false);
			expect(isTerminalFailureOrAborted('succeeded')).toBe(false);

			// 运行中或未终态不可重跑
			expect(isTerminalFailureOrAborted('running')).toBe(false);
			expect(isTerminalFailureOrAborted('starting')).toBe(false);
			expect(isTerminalFailureOrAborted('queued')).toBe(false);
			expect(isTerminalFailureOrAborted('awaiting_reply')).toBe(false);
			expect(isTerminalFailureOrAborted('reviewing')).toBe(false);
			expect(isTerminalFailureOrAborted('reworking')).toBe(false);
			expect(isTerminalFailureOrAborted('')).toBe(false);
			expect(isTerminalFailureOrAborted(undefined)).toBe(false);
			expect(isTerminalFailureOrAborted(null)).toBe(false);
		});

		it('identifies active running states that must intercept rerun (E-177)', () => {
			expect(isActiveRunState('running')).toBe(true);
			expect(isActiveRunState('starting')).toBe(true);
			expect(isActiveRunState('reviewing')).toBe(true);
			expect(isActiveRunState('reworking')).toBe(true);
			expect(isActiveRunState('queued')).toBe(true);
			expect(isActiveRunState('failed')).toBe(false);
			expect(isActiveRunState('aborted')).toBe(false);
			expect(isActiveRunState('landed')).toBe(false);
		});

		it('does NOT render rerun bar if run is not terminal failed or aborted', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: false,
					canRerun: false,
					isRerunning: false,
					hasActiveRun: false,
					onTriggerRerun: vi.fn(),
				}),
			);
			expect(html).toBe('');
		});

		it('renders rerun button when run is terminal failed or aborted with ZERO selectors (no select, radio, or input)', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: true,
					canRerun: true,
					isRerunning: false,
					hasActiveRun: false,
					onTriggerRerun: vi.fn(),
				}),
			);

			expect(html).toContain('data-mobile-rerun-bar="true"');
			expect(html).toContain('原样重跑');
			// 严格断言不出现任何选择器
			expect(html).not.toContain('<select');
			expect(html).not.toContain('<input');
			expect(html).not.toContain('radio');
			expect(html).not.toContain('checkbox');
		});

		it('renders rerun confirmation dialog with zero selectors and proper accessibility markup', () => {
			const html = renderToStaticMarkup(
				createElement(RerunConfirmDialog, {
					isOpen: true,
					taskKey: 'M9-T13',
					runId: 'run-test-123',
					agentName: 'codex',
					isSubmitting: false,
					onConfirm: vi.fn(),
					onCancel: vi.fn(),
				}),
			);

			expect(html).toContain('data-rerun-confirm-dialog="true"');
			expect(html).toContain('确认原样重跑？');
			expect(html).toContain('不修改任何配置且不提供任何选择器');
			expect(html).toContain('M9-T13');
			expect(html).toContain('run-test-123');
			expect(html).toContain('data-action="cancel-rerun"');
			expect(html).toContain('data-action="confirm-rerun"');

			// 确认弹窗同样绝无选择器
			expect(html).not.toContain('<select');
			expect(html).not.toContain('<input');
		});

		it('does not render confirmation dialog when isOpen is false', () => {
			const html = renderToStaticMarkup(
				createElement(RerunConfirmDialog, {
					isOpen: false,
					onConfirm: vi.fn(),
					onCancel: vi.fn(),
				}),
			);
			expect(html).toBe('');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 2: 入口在流详情页日志末尾的整宽按钮，不进拇指条。拇指区仍只有停止与审批
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 2: Entrance at log tail in RunDetailContainer, strictly NOT in ThumbBar', () => {
		it('renders rerun entrance inside RunDetailContainer at the bottom when run is failed', () => {
			const html = renderToStaticMarkup(
				createElement(RunDetailContainer, {
					runId: 'run-failed-42',
					runStatus: 'failed',
					taskKey: 'M9-T13',
					isMobile: true,
				}),
			);

			expect(html).toContain('data-mobile-rerun-bar="true"');
			expect(html).toContain('原样重跑');
		});

		it('verifies ThumbBar strictly retains ONLY stop and approve actions, never containing rerun', () => {
			const html = renderToStaticMarkup(
				createElement(ThumbBar, {
					canStop: true,
					canApprove: true,
					stopLabel: '停止',
					approveLabel: '批准并继续',
					onStop: vi.fn(),
					onApprove: vi.fn(),
				}),
			);

			expect(html).toContain('data-thumb-bar="true"');
			expect(html).toContain('data-action="stop"');
			expect(html).toContain('data-action="approve"');
			expect(html).not.toContain('重跑');
			expect(html).not.toContain('rerun');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 3: 「换 agent／换模型重派」保持桌面端独占，手机上只显示一行「请到桌面端」，不做半截表单
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 3: Reassigning agent/model remains desktop-exclusive, mobile shows single text line without partial form', () => {
		it('renders explicit notice line directing user to desktop for agent/model reassignment', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: true,
					canRerun: true,
					isRerunning: false,
					hasActiveRun: false,
					onTriggerRerun: vi.fn(),
				}),
			);

			expect(html).toContain('data-testid="desktop-dispatch-notice"');
			expect(html).toContain('换 agent／换模型重派请到桌面端操作');

			// 验证绝不做半截表单
			expect(html).not.toContain('<form');
			expect(html).not.toContain('<select');
			expect(html).not.toContain('更换模型');
			expect(html).not.toContain('更换 Agent');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 4 & E-181: 手机端不提供「全部重跑」（早上多条失败逐条进入逐条确认）
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 4 & E-181: Mobile does NOT provide "rerun all"; multiple failures handled per-run with confirmation', () => {
		it('strictly forbids batch / "rerun all" entrance on mobile', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: true,
					canRerun: true,
					isRerunning: false,
					hasActiveRun: false,
					onTriggerRerun: vi.fn(),
				}),
			);

			expect(html).not.toContain('全部重跑');
			expect(html).not.toContain('批量重跑');
			expect(html).not.toContain('一键重跑');
			expect(html).not.toContain('rerun-all');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 5: 竖屏 <400px 时该按钮整宽独占一行，与拇指条保持间距防误触
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 5: Narrow vertical screen <400px has full-width button and anti-accidental-touch clearance', () => {
		it('renders full-width button with touch target >= 44px and bottom clearance against thumbbar', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: true,
					canRerun: true,
					isRerunning: false,
					hasActiveRun: false,
					isMobile: true,
					onTriggerRerun: vi.fn(),
				}),
			);

			// 检查整宽独占一行与 44px 触控高度
			expect(html).toContain('w-full');
			expect(html).toContain('min-h-[44px]');

			// 检查防误触间距（针对固定在底部的 ThumbBar）
			expect(html).toContain('var(--thumbbar-h,60px)');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// E-177: 手机重跑撞上已在跑
	// ─────────────────────────────────────────────────────────────────────────────
	describe('E-177: Mobile rerun collision with already active run disables button and prevents duplicate runs', () => {
		it('disables button and updates label to "任务已在运行中" when task already has active run', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: true,
					canRerun: false,
					isRerunning: false,
					hasActiveRun: true,
					onTriggerRerun: vi.fn(),
				}),
			);

			expect(html).toContain('disabled=""');
			expect(html).toContain('aria-disabled="true"');
			expect(html).toContain('cursor-not-allowed');
			expect(html).toContain('任务已在运行中');
			expect(html).not.toContain('原样重跑');
		});

		it('disables button during in-flight rerun dispatch to prevent double submission', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: true,
					canRerun: false,
					isRerunning: true,
					hasActiveRun: false,
					onTriggerRerun: vi.fn(),
				}),
			);

			expect(html).toContain('disabled=""');
			expect(html).toContain('重跑派发中...');
		});

		it('renders error notice when server reports E_RUN_ALREADY_EXISTS collision', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: true,
					canRerun: false,
					isRerunning: false,
					hasActiveRun: true,
					error: '该任务已在运行中，绝不产生第二次运行',
					onTriggerRerun: vi.fn(),
				}),
			);

			expect(html).toContain('data-testid="rerun-error-notice"');
			expect(html).toContain('该任务已在运行中，绝不产生第二次运行');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// E-178 & E-180: Agent 不在线与快照已变更异常展示
	// ─────────────────────────────────────────────────────────────────────────────
	describe('E-178 & E-180: Error notice display for offline agent and stale snapshot', () => {
		it('renders clear notice when agent is offline (E-178)', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: true,
					canRerun: true,
					isRerunning: false,
					hasActiveRun: false,
					error: '原 Agent 不在线，禁止重跑',
					onTriggerRerun: vi.fn(),
				}),
			);

			expect(html).toContain('原 Agent 不在线，禁止重跑');
		});

		it('renders clear notice when snapshot is stale (E-180)', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: true,
					canRerun: true,
					isRerunning: false,
					hasActiveRun: false,
					error: '文档快照已变更，重跑请到桌面端处理',
					onTriggerRerun: vi.fn(),
				}),
			);

			expect(html).toContain('文档快照已变更，重跑请到桌面端处理');
		});
	});
});
