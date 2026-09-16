/**
 * packages/web/test/gate-card.test.tsx
 *
 * M9-T10 审批卡与闸门交互单元测试（AC 1..5, E-109, E-182）
 */

import type { GateDto } from '@agent-scheduler/shared/api/gates';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
	GateCard,
	GatePendingBadge,
	PendingApprovalBadge,
	resolveApproveActionLabel,
} from '../src/components/gate-card.tsx';

describe('M9-T10: 审批卡与闸门交互 (AC 1..5, E-109, E-182)', () => {
	// ─────────────────────────────────────────────────────────────────────────────
	// AC 1 & E-109: 审批卡就地插在流时间轴里，禁止 dialog / createPortal，不弹全局模态
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 1 & E-109: Inline card placement, no modal, no dialog, no portal', () => {
		it('renders as an inline resident card within the stream timeline', () => {
			const html = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					taskTitle: '审批卡与闸门交互',
					gateKind: 'review',
				}),
			);

			// 就地内联卡片标识与结构
			expect(html).toContain('data-component="gate-card"');
			expect(html).toContain('data-resident-card="true"');
			expect(html).toContain('data-gate-kind="review"');

			// 整卡染色与 1px --needs 边框，不用左侧 3px 彩条（11 节）
			expect(html).toContain('border-[var(--needs)]');
			expect(html).toContain('bg-[var(--needs-soft)]');
			expect(html).not.toContain('border-l-');

			// 严禁 dialog 与全局模态特征
			expect(html).not.toContain('<dialog');
			expect(html).not.toContain('role="dialog"');
			expect(html).not.toContain('role="alertdialog"');
			expect(html).not.toContain('fixed inset-0');
		});

		it('has accessible region attributes without interrupting other streams', () => {
			const html = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'dispatch',
				}),
			);

			// 带有 aria 关联属性
			expect(html).toContain('aria-labelledby=');
			expect(html).toContain('aria-describedby=');
			expect(html).toContain('data-segment="what"');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 2: 四段固定顺序（要做什么／影响什么／凭什么／三个动作，「改一下」不是可选项）
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 2: Four fixed sections in strict order', () => {
		it('maintains strict DOM order: what -> impact -> why -> actions -> timeout', () => {
			const html = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'review',
					stepNumber: 3,
					stepLabel: '第 3 步 · 运行审查',
				}),
			);

			const whatIdx = html.indexOf('data-segment="what"');
			const impactIdx = html.indexOf('data-segment="impact"');
			const whyIdx = html.indexOf('data-segment="why"');
			const actionsIdx = html.indexOf('data-segment="actions"');
			const timeoutIdx = html.indexOf('data-segment="timeout-policy"');

			expect(whatIdx).toBeGreaterThan(-1);
			expect(impactIdx).toBeGreaterThan(whatIdx);
			expect(whyIdx).toBeGreaterThan(impactIdx);
			expect(actionsIdx).toBeGreaterThan(whyIdx);
			expect(timeoutIdx).toBeGreaterThan(actionsIdx);
		});

		it('renders Section 1 (要做什么) with 14px font-semibold text', () => {
			const html = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'landing',
				}),
			);

			expect(html).toContain('data-segment="what"');
			expect(html).toContain('data-field="what-title"');
			expect(html).toContain('text-[14px]');
			expect(html).toContain('font-semibold');
			expect(html).toContain('批准合并分支并将改动记录落地');
		});

		it('renders Section 2 (影响什么) with 26px mono metric (--needs or --down)', () => {
			// 可逆操作使用 --needs 暖色
			const reversibleHtml = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'review',
					impactValue: '18.2k',
					impactUnit: 'token',
					impactDescription: '确认验收并推进后续阶段',
					isIrreversible: false,
				}),
			);

			expect(reversibleHtml).toContain('data-segment="impact"');
			expect(reversibleHtml).toContain('data-field="impact-metric"');
			expect(reversibleHtml).toContain('text-[var(--fs-num-lg,26px)]');
			expect(reversibleHtml).toContain('font-mono');
			expect(reversibleHtml).toContain('text-[var(--needs)]');
			expect(reversibleHtml).toContain('18.2k');
			expect(reversibleHtml).toContain('token');

			// 不可逆操作使用 --down 红色
			const irreversibleHtml = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'landing',
					impactValue: 14,
					impactUnit: '个文件',
					isIrreversible: true,
				}),
			);

			expect(irreversibleHtml).toContain('text-[var(--down)]');
			expect(irreversibleHtml).toContain('不可逆操作');
		});

		it('renders Section 3 (凭什么) with a clickable link back to producing step', () => {
			const html = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'review',
					stepNumber: 4,
					stepLabel: '步骤 4 · 运行审查',
					evidence: '机械检查 12 项全部通过，覆盖率达到 98%',
				}),
			);

			expect(html).toContain('data-segment="why"');
			expect(html).toContain('机械检查 12 项全部通过');
			expect(html).toContain('data-action="goto-step"');
			expect(html).toContain('data-step-number="4"');
			expect(html).toContain('回到步骤：步骤 4 · 运行审查');
		});

		it('renders Section 3 with anchor link when stepHref is provided', () => {
			const html = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'review',
					stepNumber: 2,
					stepHref: '#/run/run-123#step-2',
				}),
			);

			expect(html).toContain('<a');
			expect(html).toContain('href="#/run/run-123#step-2"');
			expect(html).toContain('data-action="goto-step"');
		});

		it('renders Section 4 with three fixed actions: approve, edit, reject (改一下 is not optional)', () => {
			const html = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'review',
				}),
			);

			expect(html).toContain('data-segment="actions"');

			// 动作 1：批准并继续 (primary, 无 --glow)
			expect(html).toContain('data-action="approve"');
			expect(html).toContain('bg-[var(--needs)]');
			expect(html).toContain('text-[var(--on-needs)]');
			expect(html).toContain('批准并继续');
			expect(html).not.toContain('--glow');

			// 动作 2：改一下 (ghost，「改一下」不是可选项)
			expect(html).toContain('data-action="edit"');
			expect(html).toContain('改一下');

			// 动作 3：拒绝 (danger outline)
			expect(html).toContain('data-action="reject"');
			expect(html).toContain('border-[var(--down)]');
			expect(html).toContain('拒绝');
		});

		it('supports M9-T20 conditional action: 投递原文到实施会话 when reviewVerdict=incomplete', () => {
			const onDeliverRaw = vi.fn();

			// 正常 incomplete 且有 reworkText
			const html = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					reviewVerdict: 'incomplete',
					reworkText: 'R1: 未满足验收标准第 2 条\nR2: 缺少异常边界用例',
					onDeliverRaw,
					canReply: true,
				}),
			);

			expect(html).toContain('data-action="deliver-raw"');
			expect(html).toContain('投递原文到实施会话');
			expect(html).toContain('data-field="rework-text-block"');
			expect(html).toContain('审查意见原文（未结构化）');

			// canReply=false 时按钮处于 disabled 并提示
			const disabledHtml = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					reviewVerdict: 'incomplete',
					reworkText: 'R1: 未满足验收标准',
					onDeliverRaw,
					canReply: false,
				}),
			);
			expect(disabledHtml).toContain('title="目标运行不支持回话"');
			expect(disabledHtml).toContain('disabled=""');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 3: 底部写明「无人应答不会自动批准，任务保持等待」
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 3: Footer timeout policy text', () => {
		it('strictly displays "无人应答不会自动批准，任务保持等待"', () => {
			const html = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'dispatch',
				}),
			);

			expect(html).toContain('data-segment="timeout-policy"');
			expect(html).toContain('data-field="timeout-text"');
			expect(html).toContain('无人应答不会自动批准，任务保持等待');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 4 & E-109: 全局只用一个未处理计数徽标提示
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 4 & E-109: Global single unhandled count badge (GatePendingBadge)', () => {
		it('renders null when count is 0 or negative', () => {
			expect(renderToStaticMarkup(createElement(GatePendingBadge, { count: 0 }))).toBe('');
			expect(renderToStaticMarkup(createElement(GatePendingBadge, { count: -1 }))).toBe('');
		});

		it('renders single pending badge when count > 0 with correct styling and accessibility', () => {
			const html = renderToStaticMarkup(createElement(GatePendingBadge, { count: 3 }));

			expect(html).toContain('data-pending-badge="true"');
			expect(html).toContain('data-count="3"');
			expect(html).toContain('3');
			expect(html).toContain('aria-label="有 3 项待处理审批"');
			expect(html).toContain('rounded-[6px]');
			expect(html).toContain('border-[var(--needs)]');
			expect(html).toContain('text-[var(--needs)]');
			expect(html).toContain('bg-[var(--needs-soft)]');
		});

		it('supports clickable badge with role=button and keyboard accessibility', () => {
			const onClick = vi.fn();
			const html = renderToStaticMarkup(createElement(GatePendingBadge, { count: 2, onClick }));

			expect(html).toContain('role="button"');
			expect(html).toContain('tabindex="0"');
			expect(html).toContain('cursor-pointer');
		});

		it('exports PendingApprovalBadge as identical alias', () => {
			expect(PendingApprovalBadge).toBe(GatePendingBadge);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 5 & E-182: 手机上审批派发前闸门时文案必须写「批准派发」，不得含糊成「同意」
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 5 & E-182: Mobile dispatch gate approval action label', () => {
		it('strictly outputs "批准派发" on mobile when approving dispatch gate', () => {
			// 手机档 + dispatch 闸门
			const mobileHtml = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'dispatch',
					isMobile: true,
				}),
			);

			expect(mobileHtml).toContain('data-action="approve"');
			expect(mobileHtml).toContain('批准派发');
			expect(mobileHtml).not.toContain('同意');

			// phone 密度档 + dispatch 闸门
			const phoneTierHtml = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'dispatch',
					tier: 'phone',
				}),
			);

			expect(phoneTierHtml).toContain('批准派发');
			expect(phoneTierHtml).not.toContain('同意');

			// phone-xs 密度档 + dispatch 闸门
			const phoneXsTierHtml = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'dispatch',
					tier: 'phone-xs',
				}),
			);

			expect(phoneXsTierHtml).toContain('批准派发');
			expect(phoneXsTierHtml).not.toContain('同意');
		});

		it('sanitizes ambiguous "同意" to "批准派发" on mobile dispatch gate (E-182 defensive check)', () => {
			const html = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'dispatch',
					isMobile: true,
					approveLabel: '同意', // 传入了含糊文案
				}),
			);

			// 必须被校正为明确的「批准派发」
			expect(html).toContain('批准派发');
			expect(html).not.toContain('>同意<');
		});

		it('sanitizes ambiguous "同意" on non-dispatch gates to "批准并继续"', () => {
			const html = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					gateKind: 'review',
					approveLabel: '同意',
				}),
			);

			expect(html).toContain('批准并继续');
			expect(html).not.toContain('>同意<');
		});

		it('test resolveApproveActionLabel helper across all permutations', () => {
			// 手机 + 派发 -> 批准派发
			expect(resolveApproveActionLabel({ isMobileView: true, isDispatchGate: true })).toBe(
				'批准派发',
			);
			// 手机 + 派发 + 显式传"同意" -> 仍必须是 批准派发 (E-182)
			expect(
				resolveApproveActionLabel({
					isMobileView: true,
					isDispatchGate: true,
					customLabel: '同意',
				}),
			).toBe('批准派发');

			// 桌面 + 派发 -> 批准派发
			expect(resolveApproveActionLabel({ isMobileView: false, isDispatchGate: true })).toBe(
				'批准派发',
			);
			// 桌面 + 派发 + 传"同意" -> 强制转换为 批准派发
			expect(
				resolveApproveActionLabel({
					isMobileView: false,
					isDispatchGate: true,
					customLabel: '同意',
				}),
			).toBe('批准派发');

			// 桌面 + 审查 -> 批准并继续
			expect(resolveApproveActionLabel({ isMobileView: false, isDispatchGate: false })).toBe(
				'批准并继续',
			);
			// 桌面 + 审查 + 传"同意" -> 替换为 批准并继续
			expect(
				resolveApproveActionLabel({
					isMobileView: false,
					isDispatchGate: false,
					customLabel: '同意',
				}),
			).toBe('批准并继续');

			// 自定义合法文案保持
			expect(
				resolveApproveActionLabel({
					isMobileView: false,
					isDispatchGate: false,
					customLabel: '批准落地',
				}),
			).toBe('批准落地');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// E-348 / E-359 / M9-T23 零产出退出 context 契约兼容
	// ─────────────────────────────────────────────────────────────────────────────
	describe('E-348 & E-359: Zero-output exit context support', () => {
		it('renders exit code, fixed notice, and stderr diagnostic lines', () => {
			const html = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T23',
					context: {
						exitCode: 1,
						stderrTail: {
							kind: 'lines',
							lines: ['error: missing API token [REDACTED]', 'failed to initialize'],
						},
						login: {
							status: 'logged_out',
							hint: '请运行 codex auth login',
						},
					},
				}),
			);

			expect(html).toContain('agent 未产出任何内容就退出');
			expect(html).toContain('exit: 1');
			expect(html).toContain(
				'agent 未产出任何内容就退出，常见原因：未登录、模型名不可用、参数被拒',
			);
			expect(html).toContain('[已脱敏]');
			expect(html).toContain('未登录');
			expect(html).toContain('请运行 codex auth login');

			// 三动作复用：重跑、换 agent 重派、标失败
			expect(html).toContain('换 agent 重派');
			expect(html).toContain('标失败');
		});

		it('hides "换 agent 重派" button on mobile view in zero-output context (E-359)', () => {
			const html = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T23',
					isMobile: true,
					context: {
						exitCode: 1,
						stderrTail: { kind: 'lines', lines: [] },
					},
				}),
			);

			// 手机档零产出不渲染第二个按钮（E-359 规定）
			expect(html).not.toContain('换 agent 重派');
		});

		it('handles legacy_run and event_missing states for stderrTail', () => {
			const legacyHtml = renderToStaticMarkup(
				createElement(GateCard, {
					context: {
						stderrTail: { kind: 'unavailable', reason: 'legacy_run' },
					},
				}),
			);
			expect(legacyHtml).toContain('无记录（旧运行）');

			const missingHtml = renderToStaticMarkup(
				createElement(GateCard, {
					context: {
						stderrTail: { kind: 'unavailable', reason: 'event_missing' },
					},
				}),
			);
			expect(missingHtml).toContain('事件缺失');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// 尺寸、触控与交互状态
	// ─────────────────────────────────────────────────────────────────────────────
	describe('Interactive sizing and touch targets', () => {
		it('enlarges action button heights to 44px on touch or phone tier (11 节)', () => {
			const touchHtml = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					isTouch: true,
				}),
			);

			expect(touchHtml).toContain('min-h-[var(--h-btn-lg,44px)]');

			const desktopHtml = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					isTouch: false,
					isMobile: false,
				}),
			);

			expect(desktopHtml).toContain('h-[var(--h-btn,32px)]');
		});

		it('disables all buttons when isSubmitting or disabled is true', () => {
			const submittingHtml = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					isSubmitting: true,
				}),
			);

			expect(submittingHtml).toContain('提交中…');
			expect(submittingHtml).toContain('disabled=""');

			const disabledHtml = renderToStaticMarkup(
				createElement(GateCard, {
					taskKey: 'M9-T10',
					disabled: true,
				}),
			);
			expect(disabledHtml).toContain('disabled=""');
		});

		it('supports GateDto object passed directly', () => {
			const mockGate: GateDto = {
				id: 'gate-1',
				taskId: 'M9-T10',
				runId: 'run-1',
				kind: 'landing',
				state: 'waiting',
				decision: null,
				comment: null,
				decidedByDeviceId: null,
				createdAt: '2026-09-16T12:00:00.000Z',
				decidedAt: null,
			};

			const html = renderToStaticMarkup(
				createElement(GateCard, {
					gate: mockGate,
					taskKey: 'M9-T10',
				}),
			);

			expect(html).toContain('data-gate-kind="landing"');
			expect(html).toContain('批准合并分支并将改动记录落地');
		});
	});
});
