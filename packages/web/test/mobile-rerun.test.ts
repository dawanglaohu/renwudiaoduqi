/**
 * packages/web/test/mobile-rerun.test.ts
 *
 * M9-T13 手机原样重跑入口单元测试（AC 1-5, E-177, E-181, R1, R2, R3）
 */

import { readFileSync } from 'node:fs';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCachedToken, setCachedToken } from '../src/api/http-client.ts';
import { App } from '../src/app/app.tsx';
import { navigateTo } from '../src/app/routes.tsx';
import { ThumbBar } from '../src/components/thumb-bar.tsx';
import { MobileRerunBar } from '../src/features/run-detail/mobile-rerun-bar.tsx';
import { RerunConfirmDialog } from '../src/features/run-detail/rerun-confirm-dialog.tsx';
import { RunDetailContainer } from '../src/features/run-detail/run-detail-container.tsx';
import {
	isActiveRunState,
	isTerminalFailureOrAborted,
} from '../src/features/run-detail/use-run-rerun.ts';
import { getErrorMessage } from '../src/i18n/error-messages.ts';
import { RunDetailPage } from '../src/pages/run-detail-page.tsx';
import viteConfig from '../vite.config.ts';

describe('M9-T13: Mobile Rerun Entrance (AC 1-5, E-177, E-181, R1-R3)', () => {
	beforeEach(() => {
		setCachedToken('test-valid-device-token-123');
		navigateTo('#/');
	});

	afterEach(() => {
		clearCachedToken();
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// R1: 真实 App 与路由集成测试 #/run/:runId
	// ─────────────────────────────────────────────────────────────────────────────
	describe('R1: Real App and Router integration for #/run/:runId', () => {
		it('renders RunDetailPage within App when navigating to #/run/:runId with terminal failure', () => {
			navigateTo('#/run/run-fail-101');

			const html = renderToStaticMarkup(createElement(App));

			expect(html).toContain('data-testid="run-detail-page"');
			expect(html).toContain('run-fail-101');
			expect(html).toContain('Agent 任务调度器');
			expect(html).toContain('运行详情');
			expect(html).toContain('返回甲板');
		});

		it('shows unknown route fallback when runId is missing in route', () => {
			const html = renderToStaticMarkup(
				createElement(RunDetailPage, {
					match: {
						id: 'runDetail',
						path: '#/run/',
						params: {},
						query: {},
						isUnknown: false,
						auth: true,
						lazy: false,
					},
				}),
			);

			expect(html).toContain('data-testid="unknown-route-page"');
			expect(html).toContain('未知路径');
		});

		it('shows rerun entrance at log tail when RunDetailPage renders failed run in mobile tier', () => {
			const failedRun: RunDto = {
				id: 'run-fail-102',
				taskId: 'M9-T13',
				attemptNo: 1,
				kind: 'implement',
				parentRunId: null,
				state: 'failed',
				reviewVerdict: null,
				agentId: 'codex',
				modelName: 'gpt-5',
				reportedModel: null,
				effortTier: 'high',
				reportedEffort: null,
				permissionTier: 'workspaceWrite',
				worktreePath: null,
				branchName: null,
				pid: null,
				exitCode: 1,
				exitSignal: null,
				changedFileCount: null,
				tokenUsage: null,
				isStallSuspected: false,
				reworkCount: 0,
				queuedReason: null,
				idempotencyKey: 'idem_test_102',
				actorDeviceId: null,
				startedAt: '2026-09-17T00:00:00.000Z',
				lastEventAt: '2026-09-17T00:01:00.000Z',
				endedAt: '2026-09-17T00:01:05.000Z',
			};

			const html = renderToStaticMarkup(
				createElement(RunDetailPage, {
					runId: 'run-fail-102',
					run: failedRun,
					isMobile: true,
				}),
			);

			expect(html).toContain('data-testid="run-detail-page"');
			expect(html).toContain('data-mobile-rerun-bar="true"');
			expect(html).toContain('原样重跑');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 1 & E-177: 仅对终态失败/已中止的运行可用，严格复用原派发载荷、不出现任何选择器，需一次确认
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 1 & E-177: Only available for terminal failed / aborted runs, zero selectors, requires confirmation', () => {
		it('correctly classifies terminal failed and aborted states', () => {
			expect(isTerminalFailureOrAborted('failed')).toBe(true);
			expect(isTerminalFailureOrAborted('aborted')).toBe(true);
			expect(isTerminalFailureOrAborted('interrupted')).toBe(true);
			expect(isTerminalFailureOrAborted('stopped')).toBe(true);

			// 成功终态与在跑状态不可重跑
			expect(isTerminalFailureOrAborted('landed')).toBe(false);
			expect(isTerminalFailureOrAborted('succeeded')).toBe(false);
			expect(isTerminalFailureOrAborted('running')).toBe(false);
			expect(isTerminalFailureOrAborted('starting')).toBe(false);
			expect(isTerminalFailureOrAborted('queued')).toBe(false);
			expect(isTerminalFailureOrAborted('')).toBe(false);
			expect(isTerminalFailureOrAborted(undefined)).toBe(false);
		});

		it('identifies active running states that must intercept rerun (E-177)', () => {
			expect(isActiveRunState('running')).toBe(true);
			expect(isActiveRunState('starting')).toBe(true);
			expect(isActiveRunState('reviewing')).toBe(true);
			expect(isActiveRunState('reworking')).toBe(true);
			expect(isActiveRunState('queued')).toBe(true);
			expect(isActiveRunState('awaiting_reply')).toBe(true);
			expect(isActiveRunState('awaiting_human')).toBe(true);

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
					isMobile: true,
					onTriggerRerun: vi.fn(),
				}),
			);
			expect(html).toBe('');
		});

		it('renders rerun button with ZERO selectors (no select, radio, or input)', () => {
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

			expect(html).toContain('data-mobile-rerun-bar="true"');
			expect(html).toContain('原样重跑');
			expect(html).not.toContain('<select');
			expect(html).not.toContain('<input');
			expect(html).not.toContain('radio');
			expect(html).not.toContain('checkbox');
		});

		it('renders confirmation dialog with zero selectors and proper accessibility markup', () => {
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
			expect(html).not.toContain('<select');
			expect(html).not.toContain('<input');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 2: 入口在流详情页日志末尾的整宽按钮，不进拇指条。拇指区仍只有停止与审批
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 2: Entrance at log tail in RunDetailContainer, strictly NOT in ThumbBar', () => {
		it('renders rerun entrance inside RunDetailContainer at the bottom when run is failed and in mobile tier', () => {
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
					isMobile: true,
					onTriggerRerun: vi.fn(),
				}),
			);

			expect(html).toContain('data-testid="desktop-dispatch-notice"');
			expect(html).toContain('换 agent／换模型重派请到桌面端操作');

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
					isMobile: true,
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

			expect(html).toContain('w-full');
			expect(html).toContain('min-h-[44px]');
			expect(html).toContain('var(--thumbbar-h,60px)');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// R2 & E-177: 识别同任务已有 active run 并预先置灰；rerun POST 返回 200 + 既有 active run 处理
	// ─────────────────────────────────────────────────────────────────────────────
	describe('R2 & E-177: Active run detection, pre-disabling, and safe 200 handling without run replacement', () => {
		it('never mutates the viewed run from a rerun POST response', () => {
			const source = readFileSync(
				new URL('../src/features/run-detail/use-run-rerun.ts', import.meta.url),
				'utf8',
			);
			const executeStart = source.indexOf('const executeRerun = useCallback');
			const executeEnd = source.indexOf('\n\treturn {', executeStart);
			const executeSource = source.slice(executeStart, executeEnd);

			expect(executeSource).not.toContain('setRun(res.run)');
			expect(executeSource).not.toContain('onRerunSuccess?.');
			expect(executeSource).toContain('setHasActiveRun(true)');
		});

		it('disables button and updates label to "任务已在运行中" when task already has active run', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: true,
					canRerun: false,
					isRerunning: false,
					hasActiveRun: true,
					isMobile: true,
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
					isMobile: true,
					onTriggerRerun: vi.fn(),
				}),
			);

			expect(html).toContain('disabled=""');
			expect(html).toContain('重跑派发中...');
		});

		it('renders user-facing Chinese message and technical details with copyable requestId', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: true,
					canRerun: false,
					isRerunning: false,
					hasActiveRun: true,
					isMobile: true,
					error: getErrorMessage('E_RUN_ALREADY_EXISTS'),
					techError: 'Run already active on task M9-T13',
					requestId: 'req_test_888',
					onTriggerRerun: vi.fn(),
				}),
			);

			expect(html).toContain('data-testid="rerun-error-notice"');
			expect(html).toContain('任务已在运行中，绝不产生重复运行');
			expect(html).toContain('data-testid="error-tech-details"');
			expect(html).toContain('Run already active on task M9-T13');
			expect(html).toContain('req_test_888');
			expect(html).toContain('data-action="copy-request-id"');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// R3: 手机与桌面端渲染隔离，以及基于 error-messages.ts 的错误路径映射
	// ─────────────────────────────────────────────────────────────────────────────
	describe('R3: Render isolated strictly to phone/phone-xs and error-messages.ts mapping', () => {
		it('renders rerun entrance on mobile tier (isMobile: true)', () => {
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

			expect(html).toContain('data-mobile-rerun-bar="true"');
		});

		it('strictly does NOT render rerun entrance on desktop tier (isMobile: false)', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: true,
					canRerun: true,
					isRerunning: false,
					hasActiveRun: false,
					isMobile: false,
					onTriggerRerun: vi.fn(),
				}),
			);

			expect(html).toBe('');
		});

		it('maps error codes correctly through error-messages.ts with fallback to raw code', () => {
			expect(getErrorMessage('E_AGENT_UNAVAILABLE')).toBe('原 Agent 不在线或路径无效，禁止重跑');
			expect(getErrorMessage('E_SNAPSHOT_STALE')).toBe('文档快照已变更，重跑请到桌面端处理');
			expect(getErrorMessage('E_RUN_ALREADY_EXISTS')).toBe('任务已在运行中，绝不产生重复运行');
			// 未知错误码回退为自身
			expect(getErrorMessage('E_UNKNOWN_CODE_XYZ')).toBe('E_UNKNOWN_CODE_XYZ');
		});

		it('renders stale snapshot error and tech details cleanly', () => {
			const html = renderToStaticMarkup(
				createElement(MobileRerunBar, {
					isTerminalFailureOrAborted: true,
					canRerun: true,
					isRerunning: false,
					hasActiveRun: false,
					isMobile: true,
					error: getErrorMessage('E_SNAPSHOT_STALE'),
					techError: 'Task contract has changed since dispatch (E-180)',
					requestId: 'req_stale_123',
					onTriggerRerun: vi.fn(),
				}),
			);

			expect(html).toContain('文档快照已变更，重跑请到桌面端处理');
			expect(html).toContain('Task contract has changed since dispatch (E-180)');
			expect(html).toContain('req_stale_123');
		});
	});

	describe('R4: Production CSS includes Tailwind utilities', () => {
		it('registers the Tailwind PostCSS plugin in the Vite build', () => {
			const config = viteConfig as unknown as {
				readonly css?: {
					readonly postcss?: { readonly plugins?: readonly { readonly postcssPlugin?: string }[] };
				};
			};
			const plugins = config.css?.postcss?.plugins ?? [];

			expect(plugins.some((plugin) => plugin.postcssPlugin === 'tailwindcss')).toBe(true);
		});
	});
});
