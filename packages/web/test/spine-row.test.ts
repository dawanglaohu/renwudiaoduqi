import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Spine, type SpineSegment, SpineSegmentView } from '../src/components/spine.tsx';
import { StreamRow } from '../src/components/stream-row.tsx';

describe('M9-T7: Spine and StreamRow (AC 1-6, E-110, E-230)', () => {
	// ─── AC 1: 运行轨贯穿整栏全高含未来步骤的虚线段 ───
	describe('AC 1: Spine full-height traversal with future dashed segments', () => {
		it('renders full-height container with trailing future dashed segment by default', () => {
			const segments: SpineSegment[] = [
				{ kind: 'done', shape: 'tool' },
				{ kind: 'live', shape: 'tool' },
			];
			const html = renderToStaticMarkup(createElement(Spine, { segments }));
			expect(html).toContain('data-spine-root="true"');
			expect(html).toContain('h-full');
			expect(html).toContain('min-h-full');

			// 尾部未来虚线段（AC 1：只画到当前步即判不合格）
			expect(html).toContain('data-spine-tail="future"');
			expect(html).toContain('stroke-dasharray="3 3"');
			expect(html).toContain('var(--spine-pending)');
		});

		it('turns trailing future segment warm when workflow enters waiting state', () => {
			const segments: SpineSegment[] = [
				{ kind: 'done', shape: 'tool' },
				{ kind: 'waiting', shape: 'awaiting_input' },
			];
			const html = renderToStaticMarkup(createElement(Spine, { segments }));
			expect(html).toContain('data-warm="true"');

			// 尾部虚线段转暖色
			expect(html).toContain('data-spine-tail="future"');
			expect(html).toContain('stroke="var(--spine-needs)"');
		});

		it('does not render future tail when workflow is terminated with failed or stopped state', () => {
			const failedHtml = renderToStaticMarkup(
				createElement(Spine, {
					segments: [{ kind: 'done' }, { kind: 'failed' }],
				}),
			);
			expect(failedHtml).not.toContain('data-spine-tail="future"');

			const stoppedHtml = renderToStaticMarkup(
				createElement(Spine, {
					segments: [{ kind: 'done' }, { kind: 'stopped' }],
				}),
			);
			expect(stoppedHtml).not.toContain('data-spine-tail="future"');
		});
	});

	// ─── AC 2: 六种轨段形态各自可见且形状先于颜色 ───
	describe('AC 2: Six spine segment visual morphologies', () => {
		// 1. 已完成实线
		it('renders "done" segment with solid spine-done stroke and done-dot', () => {
			const html = renderToStaticMarkup(
				createElement(SpineSegmentView, {
					segment: { kind: 'done' },
					rowHeight: 30,
				}),
			);
			expect(html).toContain('data-kind="done"');
			expect(html).toContain('stroke="var(--spine-done)"');
			expect(html).toContain('data-spine-node="done-dot"');
		});

		// 2. 当前步：实心圆点 8px + 1.6s 呼吸环
		it('renders "live" segment with 8px dot and 1.6s pulse breathing ring', () => {
			const html = renderToStaticMarkup(
				createElement(SpineSegmentView, {
					segment: { kind: 'live' },
					rowHeight: 30,
				}),
			);
			expect(html).toContain('data-kind="live"');
			expect(html).toContain('data-spine-node="pulse-live"');
			// 呼吸环消费 --pulse 且标记 1.6s 时长（R2）
			expect(html).toContain('data-pulse="1.6s"');
			expect(html).toContain('var(--pulse');
			expect(html).toContain('r="7"');
			expect(html).toContain('fill="var(--auto-soft)"');
			expect(html).toContain('stroke="var(--auto)"');
			// 实心圆点半径 4
			expect(html).toContain('r="4"');
			expect(html).toContain('fill="var(--auto)"');
			// 下半段为虚线
			expect(html).toContain('stroke-dasharray="3 3"');
			expect(html).toContain('stroke="var(--spine-pending)"');
		});

		// 2b. 当前步带 stepType 形状：呼吸环不被吞掉，与形状共存（R1, R2）
		it('renders 1.6s pulse breathing ring even when combined with a stepType shape (R1, R2)', () => {
			const html = renderToStaticMarkup(
				createElement(SpineSegmentView, {
					segment: { kind: 'live', shape: 'tool' },
					rowHeight: 30,
				}),
			);
			expect(html).toContain('data-kind="live"');
			// 呼吸环绝不被吞掉（R1）
			expect(html).toContain('data-spine-node="pulse-live"');
			expect(html).toContain('data-pulse="1.6s"');
			expect(html).toContain('var(--pulse');
			expect(html).toContain('r="7"');
			expect(html).toContain('fill="var(--auto-soft)"');
			expect(html).toContain('stroke="var(--auto)"');
			// 步骤类型字形内嵌共存
			expect(html).toContain('data-shape="tool"');
		});

		// 3. 未执行虚线
		it('renders "pending" segment with dashed stroke and pending dot', () => {
			const html = renderToStaticMarkup(
				createElement(SpineSegmentView, {
					segment: { kind: 'pending' },
					rowHeight: 30,
				}),
			);
			expect(html).toContain('data-kind="pending"');
			expect(html).toContain('stroke-dasharray="3 3"');
			expect(html).toContain('stroke="var(--spine-pending)"');
			expect(html).toContain('data-spine-node="pending-dot"');
		});

		// 4. 等你：空心方块 9px + 当前点以下整段转暖
		it('renders "waiting" segment with 9px hollow square and warm stroke', () => {
			const html = renderToStaticMarkup(
				createElement(SpineSegmentView, {
					segment: { kind: 'waiting' },
					rowHeight: 30,
				}),
			);
			expect(html).toContain('data-kind="waiting"');
			expect(html).toContain('data-warm="true"');
			expect(html).toContain('data-spine-node="waiting-square"');
			expect(html).toContain('width="9"');
			expect(html).toContain('height="9"');
			expect(html).toContain('stroke="var(--spine-needs)"');
		});

		// 5. 失败：平头截断 4px 端帽
		it('renders "failed" segment with 4px flat truncation cap and stops downward line', () => {
			const html = renderToStaticMarkup(
				createElement(SpineSegmentView, {
					segment: { kind: 'failed' },
					rowHeight: 30,
				}),
			);
			expect(html).toContain('data-kind="failed"');
			expect(html).toContain('data-spine-cap="flat-truncation"');
			// 4px 端帽：x1="9" x2="13"
			expect(html).toContain('x1="9"');
			expect(html).toContain('x2="13"');
			expect(html).toContain('stroke="var(--down)"');
			expect(html).toContain('data-spine-node="failed-cross"');
		});

		// 6. 已停止：半调虚线 + 10px 横杠
		it('renders "stopped" segment with halftone dashed line and 10px bar cap', () => {
			const html = renderToStaticMarkup(
				createElement(SpineSegmentView, {
					segment: { kind: 'stopped' },
					rowHeight: 30,
				}),
			);
			expect(html).toContain('data-kind="stopped"');
			expect(html).toContain('data-spine-cap="stopped-bar"');
			// 10px 横杠：x1="6" x2="16"
			expect(html).toContain('x1="6"');
			expect(html).toContain('x2="16"');
			expect(html).toContain('stroke="var(--stopped)"');
			expect(html).toContain('data-spine-node="stopped-bar"');
		});

		// 返工回环片段（07 节 LOOP_PIECES）
		it('renders loop pieces within 20px spine column when requested', () => {
			const html = renderToStaticMarkup(
				createElement(SpineSegmentView, {
					segment: {
						kind: 'done',
						loop: { above: true, hook: true },
					},
					rowHeight: 30,
				}),
			);
			expect(html).toContain('class="spine-loop"');
			expect(html).toContain('stroke="var(--spine-done)"');
		});
	});

	// ─── AC 3: 条目折叠高度 30px（触摸 44px），网格 20px minmax(0,1fr) auto 16px，每步都显示耗时 ───
	describe('AC 3: StreamRow geometry and duration formatting', () => {
		it('renders default collapsed height 30px and touch height 44px', () => {
			const desktopHtml = renderToStaticMarkup(
				createElement(StreamRow, {
					tool: 'exec_command',
					target: 'git status',
					duration: 250,
				}),
			);
			expect(desktopHtml).toContain('height:30px');
			expect(desktopHtml).toContain('min-height:30px');

			const touchHtml = renderToStaticMarkup(
				createElement(StreamRow, {
					tool: 'exec_command',
					target: 'git status',
					duration: 250,
					isTouch: true,
				}),
			);
			expect(touchHtml).toContain('height:44px');
			expect(touchHtml).toContain('min-height:44px');
		});

		it('enforces exact grid layout: 20px minmax(0,1fr) auto 16px', () => {
			const html = renderToStaticMarkup(
				createElement(StreamRow, {
					tool: 'exec_command',
					target: 'git commit -m "feat"',
					duration: 1200,
				}),
			);
			expect(html).toContain('grid-cols-[20px_minmax(0,1fr)_auto_16px]');
			expect(html).toContain('w-[20px]');
			expect(html).toContain('min-w-0');
			expect(html).toContain('w-[16px]');
		});

		it('displays formatted duration on every step and returns "—" when missing (never 0)', () => {
			// 有数据
			const msHtml = renderToStaticMarkup(createElement(StreamRow, { duration: 85 }));
			expect(msHtml).toContain('85ms');

			const secHtml = renderToStaticMarkup(createElement(StreamRow, { duration: 3400 }));
			expect(secHtml).toContain('3.4s');

			const minHtml = renderToStaticMarkup(createElement(StreamRow, { duration: 75000 }));
			expect(minHtml).toContain('1m 15s');

			// 无数据返回 "—"，禁止返回 0 或 0ms
			const nullHtml = renderToStaticMarkup(createElement(StreamRow, { duration: null }));
			expect(nullHtml).toContain('—');
			expect(nullHtml).not.toContain('0ms');

			const zeroHtml = renderToStaticMarkup(createElement(StreamRow, { duration: 0 }));
			expect(zeroHtml).toContain('—');
			expect(zeroHtml).not.toContain('0ms');

			const undefHtml = renderToStaticMarkup(createElement(StreamRow, {}));
			expect(undefHtml).toContain('—');
		});
	});

	// ─── AC 4: 标签为「工具 + 对象」，成功步默认折叠、失败步默认展开并提供「从这一步重试」 ───
	describe('AC 4: Label format, default expansion rules, and retry step', () => {
		it('formats label as "工具 + 对象"', () => {
			const html = renderToStaticMarkup(
				createElement(StreamRow, {
					tool: 'exec_command',
					target: 'pnpm vitest run',
				}),
			);
			expect(html).toContain('exec_command pnpm vitest run');
		});

		it('defaults to collapsed on successful step (succeeded)', () => {
			const html = renderToStaticMarkup(
				createElement(StreamRow, {
					status: 'succeeded',
					tool: 'write_file',
					target: 'src/app.tsx',
					duration: 300,
				}),
			);
			expect(html).toContain('data-expanded="false"');
			expect(html).toContain('aria-expanded="false"');
			// 折叠时不渲染展开主体
			expect(html).not.toContain('data-stream-row-body="true"');
		});

		it('defaults to expanded on failed step and provides "从这一步重试" button', () => {
			const html = renderToStaticMarkup(
				createElement(StreamRow, {
					status: 'failed',
					tool: 'exec_command',
					target: 'cargo build',
					duration: 5200,
					errorMessage: 'Compilation error: missing lifetime specifier',
				}),
			);

			expect(html).toContain('data-failed="true"');
			expect(html).toContain('data-expanded="true"');
			expect(html).toContain('aria-expanded="true"');

			// 展开主体已渲染
			expect(html).toContain('data-stream-row-body="true"');
			expect(html).toContain('data-step-error-banner="true"');
			expect(html).toContain('Compilation error: missing lifetime specifier');
			// R3: 展开区左缘补 2px 延续轨，覆盖全高
			expect(html).toContain('data-spine-expansion-line="true"');
			expect(html).toContain('left:11px');
			expect(html).toContain('width:2px');
			expect(html).toContain('var(--spine-dead)');
			// R4: 禁止裸字符 ✕，使用 StatusIcon 内联 SVG path
			expect(html).not.toContain('>✕<');
			expect(html).toContain('d="M 4.5 4.5 L 11.5 11.5 M 11.5 4.5 L 4.5 11.5"');
			// 提供「从这一步重试」按钮
			expect(html).toContain('data-action="retry-step"');
			expect(html).toContain('从这一步重试');
		});
	});

	// ─── AC 5: 键盘焦点用内嵌环，滚动列表不整体抖 ───
	describe('AC 5: Keyboard focus inset ring and zero jitter', () => {
		it('applies inset shadow focus ring that avoids layout shifts', () => {
			const html = renderToStaticMarkup(
				createElement(StreamRow, {
					tool: 'read_file',
					target: 'config.json',
					duration: 12,
				}),
			);
			expect(html).toContain('tabindex="0"');
			// 键盘焦点必须用内嵌环 focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]
			expect(html).toContain('focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]');
			expect(html).toContain('focus-visible:outline-none');
		});
	});

	// ─── AC 6 & E-110, E-230: 状态区分不只靠色相，专属字形 ───
	describe('AC 6 & E-110, E-230: Dedicated glyphs for orphaned, review_incomplete, unrecognized', () => {
		it('orphaned state uses broken-link glyph and never reuses failed cross (E-230)', () => {
			const html = renderToStaticMarkup(
				createElement(SpineSegmentView, {
					segment: { kind: 'waiting', shape: 'orphaned' },
					rowHeight: 30,
				}),
			);
			expect(html).toContain('data-shape="orphaned"');
			// 绝不包含 failed-cross
			expect(html).not.toContain('data-spine-node="failed-cross"');
		});

		it('review_incomplete state uses magnifying glass glyph and never reuses failed cross (E-230)', () => {
			const html = renderToStaticMarkup(
				createElement(SpineSegmentView, {
					segment: { kind: 'waiting', shape: 'review_incomplete' },
					rowHeight: 30,
				}),
			);
			expect(html).toContain('data-shape="review_incomplete"');
			expect(html).not.toContain('data-spine-node="failed-cross"');
		});

		it('unrecognized state uses question mark dashed circle glyph (E-230)', () => {
			const html = renderToStaticMarkup(
				createElement(SpineSegmentView, {
					segment: { kind: 'pending', shape: 'unrecognized' },
					rowHeight: 30,
				}),
			);
			expect(html).toContain('data-shape="unrecognized"');
			expect(html).not.toContain('data-spine-node="failed-cross"');
		});

		// partial 也必须保留自己的 ◧ 形状，不得退化成与 awaiting_input 相同的 9px 空心方块
		// （两个状态共用同一形状又同为暖色，就等于 AC 6 / E-110 禁止的「只靠色相」，实为连色相都分不开）
		it('partial keeps its own ◧ glyph instead of the awaiting-input hollow square (AC 6, E-230)', () => {
			const segmentHtml = renderToStaticMarkup(
				createElement(SpineSegmentView, {
					segment: { kind: 'waiting', shape: 'partial' },
					rowHeight: 30,
				}),
			);
			expect(segmentHtml).toContain('data-shape="partial"');
			expect(segmentHtml).not.toContain('data-spine-node="waiting-square"');

			// 真实条目路径：status='partial' 派生出的轨段同样保留 ◧
			const rowHtml = renderToStaticMarkup(
				createElement(StreamRow, {
					status: 'partial',
					tool: 'write_file',
					target: 'src/app.tsx',
					duration: 4200,
				}),
			);
			expect(rowHtml).toContain('data-spine-node="partial"');
			expect(rowHtml).not.toContain('data-spine-node="waiting-square"');

			// awaiting_input 仍然是 9px 空心方块，两者不再共用形状
			const awaitingHtml = renderToStaticMarkup(
				createElement(SpineSegmentView, {
					segment: { kind: 'waiting', shape: 'awaiting_input' },
					rowHeight: 30,
				}),
			);
			expect(awaitingHtml).toContain('data-spine-node="waiting-square"');
		});
	});
});
