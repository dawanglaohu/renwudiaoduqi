/**
 * packages/web/test/stream-head-meta.test.tsx
 *
 * M9-T17 流头部参照条与会话序号测试
 * 覆盖：AC 1-5，边界 E-136, E-254, E-256, E-31, E-347, E-357, E-37
 */

import type { RunDto } from '@agent-scheduler/shared/api/runs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentMonogram, StreamHeadMeta } from '../src/components/stream-head-meta.tsx';
import type { DensityTier } from '../src/hooks/use-breakpoint.ts';

function createMockRun(partial: Partial<RunDto> = {}): RunDto {
	return {
		id: 'run-test-1',
		taskId: 'task-test-1',
		attemptNo: 1,
		kind: 'implement',
		parentRunId: null,
		state: 'running',
		reviewVerdict: null,
		agentId: 'codex',
		modelName: 'claude-3-5-sonnet',
		reportedModel: null,
		effortTier: 'high',
		effortVendor: null,
		reportedEffort: null,
		permissionTier: 'workspaceWrite',
		worktreePath: null,
		branchName: null,
		pid: 1234,
		exitCode: null,
		exitSignal: null,
		changedFileCount: null,
		tokenUsage: null,
		isStallSuspected: false,
		reworkCount: 0,
		queuedReason: null,
		idempotencyKey: 'idem-12345678',
		actorDeviceId: null,
		startedAt: '2026-09-25T10:00:00.000Z',
		lastEventAt: '2026-09-25T10:00:05.000Z',
		endedAt: null,
		sessionNo: 1,
		assignmentSource: 'task',
		followedTaskId: null,
		...partial,
	};
}

describe('M9-T17: 流头部参照条与会话序号 (AC 1-5, E-136, E-254, E-256, E-31, E-347, E-357, E-37)', () => {
	// ─────────────────────────────────────────────────────────────────────────────
	// 验收标准 1: 四段常驻网格参照条（auto auto auto minmax(0,1fr)），第四段截断前三段不截断
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 1: 参照条常驻、不可折叠与四段网格布局', () => {
		it('renders resident 4-segment reference bar in auto auto auto minmax(0,1fr) grid without collapsible state', () => {
			const run = createMockRun();
			const html = renderToStaticMarkup(createElement(StreamHeadMeta, { run }));

			// 常驻标记与组件标识
			expect(html).toContain('data-component="stream-head-meta"');
			expect(html).toContain('data-ref-bar="true"');
			expect(html).toContain('data-resident="true"');

			// 网格布局类
			expect(html).toContain('grid-cols-[auto_auto_auto_minmax(0,1fr)]');

			// 不可折叠（不包含 hidden / collapsible 等开关）
			expect(html).not.toContain('data-collapsed');
			expect(html).not.toContain('data-state="closed"');

			// 前三段包含 whitespace-nowrap flex-shrink-0（不截断），第四段包含 min-w-0 truncate（可截断）
			expect(html).toContain('data-segment-cell="model"');
			expect(html).toContain('data-segment-cell="effort"');
			expect(html).toContain('data-segment-cell="permission"');
			expect(html).toContain('data-segment-cell="source"');

			// 检查截断和不截断样式
			expect(html).toMatch(/data-segment-cell="model"[^>]*whitespace-nowrap flex-shrink-0/);
			expect(html).toMatch(/data-segment-cell="effort"[^>]*whitespace-nowrap flex-shrink-0/);
			expect(html).toMatch(/data-segment-cell="permission"[^>]*whitespace-nowrap flex-shrink-0/);
			expect(html).toMatch(/data-segment-cell="source"[^>]*min-w-0 truncate/);
		});

		it('renders 4th segment sources correctly in full mode (E-347, E-357)', () => {
			// task -> 来源：任务指派
			const htmlTask = renderToStaticMarkup(
				createElement(StreamHeadMeta, {
					run: createMockRun({ assignmentSource: 'task' }),
				}),
			);
			expect(htmlTask).toContain('来源：任务指派');

			// review_override -> 来源：审查覆盖
			const htmlReview = renderToStaticMarkup(
				createElement(StreamHeadMeta, {
					run: createMockRun({ assignmentSource: 'review_override' }),
				}),
			);
			expect(htmlReview).toContain('来源：审查覆盖');

			// wrapup_settings with followedTaskId -> 来源：收口设置（跟随 〈taskKey〉）
			const htmlWrapup = renderToStaticMarkup(
				createElement(StreamHeadMeta, {
					run: createMockRun({
						assignmentSource: 'wrapup_settings',
						followedTaskId: 'M4-T6',
					}),
				}),
			);
			expect(htmlWrapup).toContain('来源：收口设置（跟随 M4-T6）');

			// wrapup_settings without followedTaskId -> 来源：收口设置（跟随任务未记录）
			const htmlWrapupNoTask = renderToStaticMarkup(
				createElement(StreamHeadMeta, {
					run: createMockRun({
						assignmentSource: 'wrapup_settings',
						followedTaskId: null,
					}),
				}),
			);
			expect(htmlWrapupNoTask).toContain('来源：收口设置（跟随任务未记录）');

			// agent_default -> 来源：任务指派（agent 默认），括注可见，title 说明按 agent 当前生效默认运行
			const htmlAgentDefault = renderToStaticMarkup(
				createElement(StreamHeadMeta, {
					run: createMockRun({ assignmentSource: 'agent_default' }),
				}),
			);
			expect(htmlAgentDefault).toContain('来源：任务指派（agent 默认）');
			expect(htmlAgentDefault).toContain('title="按 agent 当前生效默认运行"');

			// 四值之外或缺失 -> 来源：— 并把原始值放 title
			const htmlFallbackUnknown = renderToStaticMarkup(
				createElement(StreamHeadMeta, {
					assignmentSource: 'custom_source' as unknown as string,
				}),
			);
			expect(htmlFallbackUnknown).toContain('来源：—');
			expect(htmlFallbackUnknown).toContain('title="custom_source"');

			const htmlFallbackNull = renderToStaticMarkup(
				createElement(StreamHeadMeta, {
					assignmentSource: null,
				}),
			);
			expect(htmlFallbackNull).toContain('来源：—');
		});

		it('uses short text in compact and narrow tiers (E-357)', () => {
			const tiers: DensityTier[] = ['compact', 'narrow', 'phone'];

			for (const tier of tiers) {
				const htmlTask = renderToStaticMarkup(
					createElement(StreamHeadMeta, {
						tier,
						assignmentSource: 'task',
					}),
				);
				expect(htmlTask).toContain('来源：任务');
				expect(htmlTask).toContain('title="来源：任务指派"');

				const htmlReview = renderToStaticMarkup(
					createElement(StreamHeadMeta, {
						tier,
						assignmentSource: 'review_override',
					}),
				);
				expect(htmlReview).toContain('来源：审查');

				const htmlWrapup = renderToStaticMarkup(
					createElement(StreamHeadMeta, {
						tier,
						assignmentSource: 'wrapup_settings',
						followedTaskId: 'M2-T1',
					}),
				);
				expect(htmlWrapup).toContain('来源：收口（跟随 M2-T1）');

				const htmlAgentDefault = renderToStaticMarkup(
					createElement(StreamHeadMeta, {
						tier,
						assignmentSource: 'agent_default',
					}),
				);
				expect(htmlAgentDefault).toContain('来源：任务（agent 默认）');
			}
		});

		it('renders vendor effort raw string with title when effort is {vendor} (AC 1, M4-T14)', () => {
			const html = renderToStaticMarkup(
				createElement(StreamHeadMeta, {
					effort: { vendor: 'xhigh-reasoning' },
				}),
			);
			expect(html).toContain('xhigh-reasoning');
			expect(html).toContain('title="厂商原值，未映射到三档"');
			expect(html).toContain('data-vendor="true"');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// 验收标准 2: 思考强度不支持的 agent 显示「—」并在 title 说明原因，不补默认档冒充（E-254）
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 2 & E-254: 思考强度不支持', () => {
		it('renders "—" with reason title and does NOT pretend a default tier when unsupported', () => {
			const run = createMockRun({
				effortTier: null,
				effortVendor: null,
				effort: null,
			});
			const html = renderToStaticMarkup(createElement(StreamHeadMeta, { run }));

			expect(html).toContain('data-unsupported="true"');
			expect(html).toContain('>—<');
			expect(html).toContain('title="不支持思考强度"');

			// 严禁补默认档冒充
			expect(html).not.toMatch(/data-field="effort"[^>]*>中</);
			expect(html).not.toMatch(/data-field="effort"[^>]*>低</);
			expect(html).not.toMatch(/data-field="effort"[^>]*>高</);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// 验收标准 3: 自报值与所选不一致时两者都显示并转 --needs，模型与思考强度同规则（E-37, E-256）
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 3: 自报值不一致处理（E-37, E-256）', () => {
		it('displays both and switches to --needs when reported model disagrees with selected model (E-37)', () => {
			const run = createMockRun({
				modelName: 'claude-3-5-sonnet',
				reportedModel: 'claude-3-7-sonnet',
			});
			const html = renderToStaticMarkup(createElement(StreamHeadMeta, { run }));

			// 两者都显示：所选 → 实际 自报
			expect(html).toContain('claude-3-5-sonnet → 实际 claude-3-7-sonnet');
			expect(html).toContain('text-[var(--needs)]');
			expect(html).toContain('data-mismatch="model"');
		});

		it('displays normal text without --needs when reported model matches selected model', () => {
			const run = createMockRun({
				modelName: 'claude-3-5-sonnet',
				reportedModel: 'claude-3-5-sonnet',
			});
			const html = renderToStaticMarkup(createElement(StreamHeadMeta, { run }));

			expect(html).toContain('>claude-3-5-sonnet<');
			expect(html).not.toContain('data-mismatch="model"');
			expect(html).not.toContain('→ 实际');
		});

		it('displays both and switches to --needs when reported effort disagrees with selected effort (E-256)', () => {
			const run = createMockRun({
				effortTier: 'high',
				reportedEffort: 'medium',
			});
			const html = renderToStaticMarkup(createElement(StreamHeadMeta, { run }));

			// 两者都显示：高 → 实际 中（E-256 典型用例）
			expect(html).toContain('高 → 实际 中');
			expect(html).toContain('text-[var(--needs)]');
			expect(html).toContain('data-mismatch="effort"');
		});

		it('handles Chinese string reported effort correctly', () => {
			const run = createMockRun({
				effortTier: 'high',
				reportedEffort: '低',
			});
			const html = renderToStaticMarkup(createElement(StreamHeadMeta, { run }));

			expect(html).toContain('高 → 实际 低');
			expect(html).toContain('text-[var(--needs)]');
		});

		it('displays normal text without --needs when reported effort matches selected effort', () => {
			const run = createMockRun({
				effortTier: 'high',
				reportedEffort: 'high',
			});
			const html = renderToStaticMarkup(createElement(StreamHeadMeta, { run }));

			expect(html).toContain('>高<');
			expect(html).not.toContain('data-mismatch="effort"');
			expect(html).not.toContain('→ 实际');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// 验收标准 4: 权限档为最高档时转 --down 且持续显示，不是一次性提示（E-136）
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 4 & E-136: 最高权限档持续醒目显示', () => {
		it('switches to --down and persistently displays warning for unrestricted tier', () => {
			const run = createMockRun({
				permissionTier: 'unrestricted',
			});
			const html = renderToStaticMarkup(createElement(StreamHeadMeta, { run }));

			expect(html).toContain('无限制');
			expect(html).toContain('text-[var(--down)]');
			expect(html).toContain('data-elevated="true"');
			expect(html).toContain('title="最高权限档（无限制）：持续生效"');
		});

		it('renders normal ink color for readOnly and workspaceWrite tiers', () => {
			const htmlReadOnly = renderToStaticMarkup(
				createElement(StreamHeadMeta, {
					run: createMockRun({ permissionTier: 'readOnly' }),
				}),
			);
			expect(htmlReadOnly).toContain('只读');
			expect(htmlReadOnly).not.toContain('data-elevated="true"');
			expect(htmlReadOnly).not.toContain('text-[var(--down)]');

			const htmlWorkspace = renderToStaticMarkup(
				createElement(StreamHeadMeta, {
					run: createMockRun({ permissionTier: 'workspaceWrite' }),
				}),
			);
			expect(htmlWorkspace).toContain('工作区');
			expect(htmlWorkspace).not.toContain('data-elevated="true"');
			expect(htmlWorkspace).not.toContain('text-[var(--down)]');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// 验收标准 5: 同一 agent 并发多会话在 monogram 右下角带中性序号角标，序号不占色相（E-31, 决策 33）
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 5 & E-31: 中性会话序号角标', () => {
		it('renders neutral session ordinal badge at bottom-right of monogram without taking hue (decision 33)', () => {
			const html = renderToStaticMarkup(
				createElement(AgentMonogram, {
					monogram: 'CX',
					sessionNo: 2,
				}),
			);

			// 带有 monogram chip
			expect(html).toContain('data-agent-monogram="true"');
			expect(html).toContain('>CX<');

			// 带有会话序号角标
			expect(html).toContain('data-session-ordinal="2"');
			expect(html).toContain('>2<');

			// 位置在右下角
			expect(html).toContain('-bottom-1');
			expect(html).toContain('-right-1');

			// 严禁占色相：序号不占色相，使用中性色（bg-[var(--bg)], text-[var(--ink-2)], border-[var(--border-strong)]）
			expect(html).toContain('text-[var(--ink-2)]');
			expect(html).not.toContain('text-auto');
			expect(html).not.toContain('text-[var(--auto)]');
			expect(html).not.toContain('text-needs');
			expect(html).not.toContain('text-[var(--needs)]');
			expect(html).not.toContain('text-[var(--down)]');
		});

		it('does NOT render session ordinal badge when sessionNo is null or undefined', () => {
			const htmlNoSession = renderToStaticMarkup(
				createElement(AgentMonogram, {
					monogram: 'GK',
					sessionNo: null,
				}),
			);
			expect(htmlNoSession).toContain('>GK<');
			expect(htmlNoSession).not.toContain('data-session-ordinal');
		});

		it('renders AgentMonogram inside StreamHeadMeta when includeMonogram is true', () => {
			const html = renderToStaticMarkup(
				createElement(StreamHeadMeta, {
					agentMonogram: 'PI',
					sessionNo: 3,
					includeMonogram: true,
					assignmentSource: 'task',
				}),
			);

			expect(html).toContain('data-agent-monogram="true"');
			expect(html).toContain('>PI<');
			expect(html).toContain('data-session-ordinal="3"');
			expect(html).toContain('data-ref-bar="true"');
		});
	});
});
