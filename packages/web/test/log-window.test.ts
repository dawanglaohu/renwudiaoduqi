/**
 * packages/web/test/log-window.test.ts
 *
 * M9-T8 日志窗口与分段内存管理测试（AC 1-5, E-100, E-101, E-102, E-143, E-98）
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
	LINE_COLLAPSED_MAX_CHARS,
	LINE_EXPANDED_MAX_CHARS,
	LogBottomNotice,
	LogLine,
	LogThresholdBanner,
	isProgressLine,
	parseAnsiCodes,
	resolveCarriageReturns,
	sanitizeControlCharacters,
	truncateLongLine,
} from '../src/components/log-lines.tsx';
import {
	LogWindowManager,
	MAX_RETAINED_LINES,
	MAX_RETAINED_SEGMENTS,
} from '../src/features/run-detail/log-window.ts';

describe('M9-T8: Log Window & Virtual List (AC 1-5, E-100, E-101, E-102, E-143, E-98)', () => {
	// ─── AC 1 & E-143: 十万行日志只挂载可视窗口，任何时候不把全量放进 DOM 或 store ───
	describe('AC 1 & E-143: Ten-thousand/hundred-thousand line log window bounded memory', () => {
		it('manages 100,000 lines log by loading only bounded segments into memory, not putting all 100,000 in memory or store', () => {
			const manager = new LogWindowManager();

			// 模拟服务端下发 100,000 行会话的尾部片段（2000 行）
			const tailLines = Array.from({ length: 2000 }, (_, i) => `Tail line ${98000 + i}`);
			manager.loadInitial({
				lines: tailLines,
				totalLines: 100_000,
				prevCursor: '1:4800000',
				nextCursor: null,
			});

			const state = manager.getState();
			// 总行数记录为 100,000
			expect(state.totalLines).toBe(100_000);
			// 但内存中驻留行数仅为 2000 行，绝非 100,000 行
			expect(state.retainedLinesCount).toBe(2000);
			expect(state.retainedSegmentsCount).toBe(1);
			expect(state.hasOlder).toBe(true);
			expect(state.hasNewer).toBe(false);

			// 验证挂载的行起始索引在 98,000
			expect(state.lines[0]?.globalIndex).toBe(98_000);
			expect(state.lines[state.lines.length - 1]?.globalIndex).toBe(99_999);
		});
	});

	// ─── AC 2 & E-98: 内存只保留 6 段（每段 ≤2000 行），滚出窗口即丢弃并可重拉 ───
	describe('AC 2 & E-98: Sliding window of strictly at most 6 segments in memory', () => {
		it('retains at most 6 segments (≤ 12,000 lines); discards oldest/furthest segment on eviction and allows refetching', () => {
			const manager = new LogWindowManager();

			// 1. 装载初始尾部段（第 1 段）
			manager.loadInitial({
				lines: Array.from({ length: 2000 }, (_, i) => `Segment 1 Line ${i}`),
				totalLines: 20_000,
				prevCursor: 'cur-1',
				nextCursor: null,
			});
			expect(manager.getRetainedSegmentCount()).toBe(1);

			// 2. 依次向上加载更早历史段（装入第 2 至第 6 段，共 6 段满载）
			for (let s = 2; s <= 6; s++) {
				manager.prependOlderSegment({
					lines: Array.from({ length: 2000 }, (_, i) => `Segment ${s} Line ${i}`),
					totalLines: 20_000,
					prevCursor: s < 6 ? `cur-${s}` : null,
					nextCursor: `cur-next-${s}`,
				});
			}
			expect(manager.getRetainedSegmentCount()).toBe(6);
			expect(manager.getRetainedLineCount()).toBe(6 * 2000); // 12,000 行满载

			// 3. 再次装入第 7 段：触发驱逐！
			manager.prependOlderSegment({
				lines: Array.from({ length: 2000 }, (_, i) => `Segment 7 Line ${i}`),
				totalLines: 20_000,
				prevCursor: null,
				nextCursor: 'cur-next-7',
			});

			// AC 2: 内存严格只保留 6 段，绝不超过 MAX_RETAINED_SEGMENTS (6)
			expect(manager.getRetainedSegmentCount()).toBe(MAX_RETAINED_SEGMENTS);
			expect(manager.getRetainedLineCount()).toBeLessThanOrEqual(MAX_RETAINED_LINES);
			// 最早的第 1 段（尾部）被丢弃，标记 hasNewer = true（可重拉）
			expect(manager.getState().hasNewer).toBe(true);

			// 4. 用户滚回尾部并重拉（向后拉取）：
			manager.appendNewerSegment({
				lines: Array.from({ length: 2000 }, (_, i) => `Re-fetched Segment Line ${i}`),
				totalLines: 20_000,
				prevCursor: 'cur-prev',
				nextCursor: null,
			});

			// 内存仍然维持严格 ≤ 6 段，头部被丢弃，标记 hasOlder = true
			expect(manager.getRetainedSegmentCount()).toBe(MAX_RETAINED_SEGMENTS);
			expect(manager.getState().hasOlder).toBe(true);
		});

		it('live streaming continuous appends split into 2000-line segments and evict old segments when exceeding 6', () => {
			const manager = new LogWindowManager();
			manager.loadInitial({
				lines: ['initial line 1'],
				totalLines: 1,
				prevCursor: null,
				nextCursor: null,
			});

			// 持续追加 14,000 行（超过 7 个完整段）
			const batchSize = 1000;
			for (let i = 0; i < 14; i++) {
				const batch = Array.from(
					{ length: batchSize },
					(_, j) => `Stream line ${i * batchSize + j}`,
				);
				manager.appendLiveLines(batch);
			}

			expect(manager.getRetainedSegmentCount()).toBeLessThanOrEqual(MAX_RETAINED_SEGMENTS);
			expect(manager.getRetainedLineCount()).toBeLessThanOrEqual(MAX_RETAINED_LINES);
			expect(manager.getState().hasOlder).toBe(true);
		});
	});

	// ─── AC 3 & E-100: 用户滚到中部时新事件到达不自动跳底，显示「N 条新事件」，仅贴底才跟随 ───
	describe('AC 3 & E-100: Stick-to-bottom auto-following and unread count banner', () => {
		it('auto-follows when at bottom with unreadNewCount remaining 0', () => {
			const manager = new LogWindowManager();
			manager.loadInitial({
				lines: ['line 1', 'line 2'],
				totalLines: 2,
				prevCursor: null,
				nextCursor: null,
			});
			manager.setAtBottom(true);

			manager.appendLiveLines(['line 3', 'line 4']);
			expect(manager.getState().unreadNewCount).toBe(0);
			expect(manager.getState().isAtBottom).toBe(true);
		});

		it('stops auto-following when user scrolls away from bottom, accumulating unreadNewCount', () => {
			const manager = new LogWindowManager();
			manager.loadInitial({
				lines: ['line 1', 'line 2'],
				totalLines: 2,
				prevCursor: null,
				nextCursor: null,
			});

			// 用户向上滚动到中部：贴底状态变为 false
			manager.setAtBottom(false);

			// 新事件到达：不自动跳底，累加 unreadNewCount
			manager.appendLiveLines(['new line 3', 'new line 4', 'new line 5']);
			expect(manager.getState().unreadNewCount).toBe(3);
			expect(manager.getState().isAtBottom).toBe(false);

			// 再次追加 2 条
			manager.appendLiveLines(['new line 6', 'new line 7']);
			expect(manager.getState().unreadNewCount).toBe(5);

			// 渲染底栏提示组件：显示「回到底部（有 5 行新增）」
			const noticeHtml = renderToStaticMarkup(
				createElement(LogBottomNotice, {
					unreadCount: manager.getState().unreadNewCount,
					onClick: () => manager.resetUnreadCount(),
				}),
			);
			expect(noticeHtml).toContain('data-log-bottom-notice="true"');
			expect(noticeHtml).toContain('回到底部（有 5 行新增）');

			// 用户点击「回到底部」：清除未读计数并恢复贴底
			manager.resetUnreadCount();
			expect(manager.getState().unreadNewCount).toBe(0);
			expect(manager.getState().isAtBottom).toBe(true);

			// 再次渲染 notice 组件：无新增时不挂载
			const emptyNoticeHtml = renderToStaticMarkup(
				createElement(LogBottomNotice, {
					unreadCount: manager.getState().unreadNewCount,
					onClick: () => manager.resetUnreadCount(),
				}),
			);
			expect(emptyNoticeHtml).toBe('');
		});
	});

	// ─── AC 4 & E-101: ANSI 转义与重复刷新行折叠，控制字符不破坏布局 ───
	describe('AC 4 & E-101: Terminal control sequences, ANSI formatting, and progress collapse', () => {
		it('resolves carriage returns (\\r) by overwriting previous text on same line', () => {
			// 终端进度覆盖示例
			const input = 'Downloading 10%\rDownloading 50%\rDownloading 100% [DONE]';
			const resolved = resolveCarriageReturns(input);
			expect(resolved).toBe('Downloading 100% [DONE]');

			const partial = 'First message\rSecond';
			expect(resolveCarriageReturns(partial)).toBe('Secondmessage');
		});

		it('sanitizes layout-breaking non-printable control characters while preserving tabs and newlines', () => {
			// 含 ASCII 0x07 (bell), 0x00 (null), 0x1f 等非法控制字符
			const dirty = 'Hello\x00\x07World\x1f!\tIndented line\nSecond clean line.';
			const clean = sanitizeControlCharacters(dirty);
			expect(clean).toBe('HelloWorld!\tIndented line\nSecond clean line.');
		});

		it('parses ANSI SGR colors into token-safe CSS variables and strips non-SGR escape codes', () => {
			// 红字 (31m), 绿字 (32m), 重置 (0m), 伴随擦除光标转义 (\x1b[2K)
			const ansiText = '\x1b[2K\x1b[31mError message\x1b[0m: \x1b[32mSuccess\x1b[0m';
			const spans = parseAnsiCodes(ansiText);

			expect(spans).toHaveLength(3);
			// 红色部分映射到 var(--down)
			expect(spans[0]?.text).toBe('Error message');
			expect(spans[0]?.colorVar).toBe('var(--down)');

			// 冒号中性文本
			expect(spans[1]?.text).toBe(': ');

			// 绿色部分映射到 var(--auto)
			expect(spans[2]?.text).toBe('Success');
			expect(spans[2]?.colorVar).toBe('var(--auto)');
		});

		it('detects progress bar and overwrite lines for folding', () => {
			expect(isProgressLine('Building [=======>    ] 70%')).toBe(true);
			expect(isProgressLine('downloading package-1.tar.gz')).toBe(true);
			expect(isProgressLine('Step 1/10\rStep 2/10')).toBe(true);
			expect(isProgressLine('Normal text statement')).toBe(false);
		});

		it('renders LogLine with folded progress indicator when refreshCount > 1', () => {
			const html = renderToStaticMarkup(
				createElement(LogLine, {
					index: 0,
					text: 'Fetching assets 100%',
					refreshCount: 42,
					isProgressCollapsed: true,
				}),
			);
			expect(html).toContain('[已折叠 42 次进度刷新]');
		});
	});

	// ─── AC 5 & E-102: 单行超长按宽度截断并可展开，绝不把整行塞进 DOM ───
	describe('AC 5 & E-102: Truncation of extremely long lines without DOM pollution', () => {
		it('renders normal lines as-is without truncation', () => {
			const normalText = 'This is a regular length log line.';
			const result = truncateLongLine(normalText, false);
			expect(result.isTruncated).toBe(false);
			expect(result.visibleText).toBe(normalText);
		});

		it('truncates lines exceeding 300 chars by default, exposing an expand button', () => {
			const hugeBase64 = `data:image/png;base64,${'A'.repeat(50_000)}`;
			const collapsedResult = truncateLongLine(hugeBase64, false);

			expect(collapsedResult.isTruncated).toBe(true);
			expect(collapsedResult.totalChars).toBe(50_022);
			// 未展开时只挂载前 300 字符
			expect(collapsedResult.visibleText.length).toBe(LINE_COLLAPSED_MAX_CHARS);

			const html = renderToStaticMarkup(
				createElement(LogLine, {
					index: 0,
					text: hugeBase64,
					isExpanded: false,
				}),
			);
			expect(html).toContain('… (共 50022 字符)');
			expect(html).toContain('展开 (+49722 字符)');
			// 绝不包含整段 50,000 字符
			expect(html.length).toBeLessThan(2000);
		});

		it('caps expanded lines at 2000 chars, NEVER inserting the entire 50,000+ line into DOM (E-102)', () => {
			const hugeJson = `{"data":"${'x'.repeat(80_000)}"}`;
			const expandedResult = truncateLongLine(hugeJson, true);

			expect(expandedResult.isTruncated).toBe(true);
			expect(expandedResult.isCappedAtMax).toBe(true);
			// 展开态严格封顶在 2000 字符，绝不把 80,000 字符全量塞入 DOM
			expect(expandedResult.visibleText.length).toBe(LINE_EXPANDED_MAX_CHARS);

			const html = renderToStaticMarkup(
				createElement(LogLine, {
					index: 0,
					text: hugeJson,
					isExpanded: true,
				}),
			);
			expect(html).toContain(`[已截取前 ${LINE_EXPANDED_MAX_CHARS} 字符以保护 DOM 性能 (E-102)]`);
			expect(html).toContain('收起');
			// DOM 节点内容严格受控
			expect(html.length).toBeLessThan(4000);
		});
	});

	// ─── E-98: 单会话体积超阈值 ───
	describe('E-98: Single session size threshold (>20MB or 500,000 chars)', () => {
		it('renders LogThresholdBanner with tail-loaded notice, load-older button, and open-original file action', () => {
			const html = renderToStaticMarkup(
				createElement(LogThresholdBanner, {
					hasOlder: true,
					isExceedsThreshold: true,
					originalFilePath: 'C:\\Users\\admin\\AppData\\runs\\run-1\\raw.log',
					onLoadOlder: () => {},
				}),
			);

			expect(html).toContain('data-log-threshold-banner="true"');
			expect(html).toContain('体积超限 (E-98)');
			expect(html).toContain('会话体积已超 20MB 或 50 万字，默认加载尾部片段');
			expect(html).toContain('向上加载更多');
			expect(html).toContain('用系统默认程序打开原始文件');
		});
	});
});
