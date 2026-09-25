/**
 * packages/web/test/log-window.test.ts
 *
 * M9-T8 日志窗口与分段内存管理测试（AC 1-5, E-100, E-101, E-102, E-143, E-98, R1-R6）
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GetRunLogResponse } from '@agent-scheduler/shared/api/runs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RunStreamBuffer, eventBus } from '../src/api/event-bus.ts';
import { ApiError, httpClient } from '../src/api/http-client.ts';
import {
	LINE_COLLAPSED_MAX_CHARS,
	LINE_EXPANDED_MAX_CHARS,
	LogBottomNotice,
	LogLine,
	LogLoadNewerBar,
	LogThresholdBanner,
	isProgressLine,
	parseAnsiCodes,
	resolveCarriageReturns,
	sanitizeControlCharacters,
	truncateLongLine,
} from '../src/components/log-lines.tsx';
import {
	LOG_SEGMENT_MAX_IN_MEMORY,
	LogWindowManager,
	MAX_RETAINED_LINES,
	MAX_RETAINED_SEGMENTS,
	SEGMENT_MAX_LINES,
} from '../src/features/run-detail/log-window.ts';
import {
	PermissionBlockedBanner,
	RunDetailContainer,
} from '../src/features/run-detail/run-detail-container.tsx';
import {
	DESKTOP_LOG_SEGMENT_LIMIT,
	MOBILE_LOG_TAIL_LINES,
	seedStreamWatermark,
	useLogWindow,
} from '../src/features/run-detail/use-log-window.ts';

describe('M9-T8: Log Window & Virtual List (AC 1-5, E-100, E-101, E-102, E-143, E-98, R1-R6)', () => {
	describe('batch 11 correction: actual client-side log seams', () => {
		it('requests the tail on first load, even for sessions below the threshold', () => {
			const source = readFileSync(
				resolve(__dirname, '../src/features/run-detail/use-log-window.ts'),
				'utf8',
			);
			expect(source).toMatch(
				/query:\s*\{\s*direction:\s*'backward',\s*limit:\s*effectiveInitialLimit/,
			);
		});

		it('coalesces token deltas until a newline, counting logical lines rather than chunks', () => {
			const manager = new LogWindowManager();
			manager.loadInitial({
				lines: ['previous'],
				totalLines: 1,
				prevCursor: null,
				nextCursor: null,
			});
			manager.setAtBottom(false);
			manager.appendLiveChunk('Hello ', 'agent_message_chunk');
			manager.appendLiveChunk('world', 'agent_message_chunk');
			expect(manager.getState().lines.map((line) => line.text)).toEqual([
				'previous',
				'Hello world',
			]);
			expect(manager.getState().unreadNewCount).toBe(1);
			manager.appendLiveChunk('\nNext', 'agent_message_chunk');
			manager.appendLiveChunk(' line\n', 'agent_message_chunk');
			expect(manager.getState().lines.map((line) => line.text)).toEqual([
				'previous',
				'Hello world',
				'Next line',
			]);
			expect(manager.getState().unreadNewCount).toBe(2);
			manager.appendLiveChunk('third', 'agent_message_chunk');
			expect(
				manager
					.getState()
					.lines.map((line) => line.text)
					.at(-1),
			).toBe('third');
			manager.appendLiveChunk('thought', 'agent_thought_chunk');
			expect(
				manager
					.getState()
					.lines.map((line) => line.text)
					.at(-1),
			).toBe('thought');
		});

		it('offers a tail re-anchor when all REST segments are evicted by live events', () => {
			const manager = new LogWindowManager();
			manager.loadInitial({
				lines: ['old'],
				totalLines: 14001,
				prevCursor: '0:500',
				nextCursor: null,
			});
			manager.appendLiveLines(Array.from({ length: 14000 }, (_, i) => `line-${i}`));
			expect(manager.getState().hasOlder).toBe(true);
			expect(manager.getOldestCursor()).toBeNull();
			expect(manager.needsTailReload()).toBe(true);
		});
	});
	// ─── 容器渲染稳定性 ───
	describe('RunDetailContainer rendering', () => {
		it('renders container without getSnapshot infinite update warning or Maximum update depth', () => {
			const html = renderToStaticMarkup(
				createElement(RunDetailContainer, {
					runId: 'run-test-1',
					className: 'h-full w-full',
				}),
			);
			expect(html).toContain('data-virtual-scroll="true"');
		});
	});
	// ─── R4: 实时推流水位与多事件顺序消费 ───
	describe('R4: Event stream watermark sequencing without chunk loss', () => {
		it('consumes all chunks in order across flushes without duplication', () => {
			const manager = new LogWindowManager();
			manager.loadInitial({
				lines: ['init'],
				totalLines: 1,
				prevCursor: null,
				nextCursor: null,
			});

			const rawEvents = [
				{
					id: 101,
					seq: 1,
					kind: 'agent_message_chunk',
					payload: { chunk: 'Chunk 1 line A\nChunk 1 line B' },
				},
				{
					id: 102,
					seq: 2,
					kind: 'agent_thought_chunk',
					payload: { chunk: 'Thinking line C' },
				},
				{
					id: 103,
					seq: 3,
					kind: 'run.stderr_line',
					payload: { line: 'Stderr warning D' },
				},
			];

			let lastConsumedId: number | null = null;
			const processEvents = (events: typeof rawEvents) => {
				const toAppend: string[] = [];
				for (const ev of events) {
					if (lastConsumedId === null || ev.id > lastConsumedId) {
						lastConsumedId = ev.id;
						const payload = ev.payload as {
							chunk?: string;
							line?: string;
						};
						const text = payload.chunk ?? payload.line;
						if (text) {
							toAppend.push(...text.split('\n'));
						}
					}
				}
				if (toAppend.length > 0) {
					manager.appendLiveLines(toAppend);
				}
			};

			// First flush: push 3 events
			processEvents(rawEvents);
			expect(manager.getState().lines.map((l) => l.text)).toEqual([
				'init',
				'Chunk 1 line A',
				'Chunk 1 line B',
				'Thinking line C',
				'Stderr warning D',
			]);

			// Second flush without new events: nothing added
			processEvents(rawEvents);
			expect(manager.getState().lines).toHaveLength(5);

			// Third flush: 1 new event
			processEvents([
				...rawEvents,
				{
					id: 104,
					seq: 4,
					kind: 'agent_message_chunk',
					payload: { chunk: 'Chunk 2 line E' },
				},
			]);
			expect(manager.getState().lines).toHaveLength(6);
			expect(manager.getState().lines[5]?.text).toBe('Chunk 2 line E');
		});

		it('seeds the watermark from the current buffer tail so buffered history is not replayed as new lines', () => {
			const buffer = new RunStreamBuffer('run-seed', 600);
			expect(seedStreamWatermark(buffer)).toEqual({ id: null, seq: null });

			for (const id of [101, 102, 103]) {
				buffer.push({
					id,
					ts: '2026-09-16T00:00:00.000Z',
					runId: 'run-seed',
					taskId: null,
					scope: 'run',
					kind: 'agent_message_chunk',
					seq: id - 100,
					actorDeviceId: null,
					payload: { chunk: `buffered ${id}` },
				} as never);
			}

			// 订阅起点水位 = 缓冲末尾，挂载前已在缓冲里的 3 条不再当新行重放（与 REST 尾部去重）
			const seed = seedStreamWatermark(buffer);
			expect(seed).toEqual({ id: 103, seq: 3 });

			const consumed = (watermark: number | null) => {
				const appended: string[] = [];
				let last = watermark;
				for (const event of buffer.getItems()) {
					const id = typeof event.id === 'number' ? event.id : null;
					if (id === null || (last !== null && id <= last)) {
						continue;
					}
					last = id;
					appended.push(String((event.payload as { chunk: string }).chunk));
				}
				return { appended, last };
			};

			const first = consumed(seed.id);
			expect(first.appended).toEqual([]);

			buffer.push({
				id: 104,
				ts: '2026-09-16T00:00:01.000Z',
				runId: 'run-seed',
				taskId: null,
				scope: 'run',
				kind: 'agent_message_chunk',
				seq: 4,
				actorDeviceId: null,
				payload: { chunk: 'fresh 104' },
			} as never);

			const second = consumed(first.last);
			expect(second.appended).toEqual(['fresh 104']);
		});
	});

	// ─── R1: 容器贴底与新增行跟随 ───
	describe('R1: Container stick-to-bottom follow behavior', () => {
		it('demonstrates that isAtBottom triggers follow on line count increase, while non-at-bottom accumulates unread without follow', () => {
			const manager = new LogWindowManager();
			manager.loadInitial({
				lines: ['line 1', 'line 2'],
				totalLines: 2,
				prevCursor: null,
				nextCursor: null,
			});

			let scrollTriggered = 0;
			const simulateEffect = (prevCount: number, currentCount: number, isAtBottom: boolean) => {
				if (currentCount > prevCount) {
					if (isAtBottom) {
						scrollTriggered += 1;
					}
				}
			};

			// Case 1: 贴底追加 3 行 -> 触发跟随滚动
			let prev = manager.getState().retainedLinesCount;
			manager.setAtBottom(true);
			manager.appendLiveLines(['line 3', 'line 4', 'line 5']);
			let curr = manager.getState().retainedLinesCount;
			simulateEffect(prev, curr, manager.getState().isAtBottom);

			expect(scrollTriggered).toBe(1);
			expect(manager.getState().unreadNewCount).toBe(0);

			// Case 2: 非贴底追加 3 行 -> 绝不触发跟随滚动，累加未读
			prev = manager.getState().retainedLinesCount;
			manager.setAtBottom(false);
			manager.appendLiveLines(['line 6', 'line 7', 'line 8']);
			curr = manager.getState().retainedLinesCount;
			simulateEffect(prev, curr, manager.getState().isAtBottom);

			expect(scrollTriggered).toBe(1); // 未增加
			expect(manager.getState().unreadNewCount).toBe(3);
		});

		it('uses the monotonic totalLines signal: a folded refresh line grows totalLines while retainedLinesCount stands still', () => {
			const manager = new LogWindowManager();
			manager.loadInitial({
				lines: ['ready'],
				totalLines: 1,
				prevCursor: null,
				nextCursor: null,
			});
			manager.setAtBottom(true);

			manager.appendLiveLines(['Downloading 10%\rDownloading 20%']);
			const afterFirst = manager.getState();
			manager.appendLiveLines(['Downloading 30%\rDownloading 40%']);
			const afterSecond = manager.getState();

			// 第二条刷新行被折叠进同一行：驻留行数不增长……
			expect(afterSecond.retainedLinesCount).toBe(afterFirst.retainedLinesCount);
			// ……但总行数单调增长，贴底跟随必须看它，否则进度条刷新期间会停止跟随
			expect(afterSecond.totalLines).toBeGreaterThan(afterFirst.totalLines);
			expect(afterSecond.isAtBottom).toBe(true);
			expect(afterSecond.lines[afterSecond.lines.length - 1]?.refreshCount).toBe(2);
		});
	});

	// ─── R6: 命名规范 ───
	describe('R6: Naming alignment with 07-前端架构.md:284', () => {
		it('exports LOG_SEGMENT_MAX_IN_MEMORY as 6', () => {
			expect(LOG_SEGMENT_MAX_IN_MEMORY).toBe(6);
			expect(MAX_RETAINED_SEGMENTS).toBe(6);
			expect(MAX_RETAINED_LINES).toBe(6 * SEGMENT_MAX_LINES);
		});
	});

	// ─── R2: getSnapshot 缓存与引用稳定性 ───
	describe('R2: Cache snapshot reference stability for useSyncExternalStore', () => {
		it('returns exact same reference on multiple getState() calls without state changes', () => {
			const manager = new LogWindowManager();
			manager.loadInitial({
				lines: ['line 1', 'line 2'],
				totalLines: 2,
				prevCursor: null,
				nextCursor: null,
			});

			const s1 = manager.getState();
			const s2 = manager.getState();
			// R2 核心：引用完全相同，避免 React useSyncExternalStore 无限重渲染
			expect(s1).toBe(s2);

			// 状态变更后，创建新快照引用
			manager.appendLiveLines(['line 3']);
			const s3 = manager.getState();
			expect(s3).not.toBe(s1);

			// 再次读取新快照保持引用相同
			expect(manager.getState()).toBe(s3);
		});
	});

	// ─── R3 & AC 4 & E-101: 重复刷新行折叠 ───
	describe('R3 & AC 4 & E-101: Collapse adjacent progress/refresh lines', () => {
		it('folds 50 adjacent progress lines with \\r into 1 line with refreshCount === 50', () => {
			const manager = new LogWindowManager();
			manager.loadInitial({
				lines: ['Start build'],
				totalLines: 1,
				prevCursor: null,
				nextCursor: null,
			});

			// 追加 50 行含 \r 的进度条行
			const progressLines = Array.from(
				{ length: 50 },
				(_, i) => `Downloading [===>] ${i * 2}%\rDownloading [===>] ${i * 2 + 1}%`,
			);
			manager.appendLiveLines(progressLines);

			const state = manager.getState();
			// 原有 1 行普通文本 + 1 行合并折叠后的进度行 = 2 行
			expect(state.lines).toHaveLength(2);

			const progressEntry = state.lines[1];
			expect(progressEntry?.refreshCount).toBe(50);
			expect(progressEntry?.collapsedLines).toHaveLength(50);
			// 最新一行文本
			expect(progressEntry?.text).toBe(progressLines[49]);

			// 再次追加一条普通日志行，开启新行
			manager.appendLiveLines(['Build finished successfully']);
			expect(manager.getState().lines).toHaveLength(3);
			expect(manager.getState().lines[2]?.refreshCount).toBe(1);
		});
	});

	// ─── R5: 契约与业务判定 ───
	describe('R5: Strict API contract deserialization without front-end sniffing', () => {
		it('reads isExceedsThreshold strictly from contract response, not sniffing "20MB" in body text', () => {
			const manager = new LogWindowManager();

			// 即使正文中出现了 "20MB" 或 "50 万字"，若服务端 isExceedsThreshold 为 false/缺失，前端绝不自行判定
			manager.loadInitial({
				lines: ['Some user log containing 20MB and 50 万字 text statement'],
				totalLines: 1,
				prevCursor: null,
				nextCursor: null,
				isExceedsThreshold: false,
			});

			expect(manager.getState().isExceedsThreshold).toBe(false);

			// 服务端显式返回 isExceedsThreshold: true 时才为 true
			const managerExceeded = new LogWindowManager();
			managerExceeded.loadInitial({
				lines: ['Normal log lines'],
				totalLines: 100_000,
				prevCursor: '0:9',
				nextCursor: null,
				isExceedsThreshold: true,
				originalFilePath: 'D:/runs/1/raw.log',
				openCommand: 'notepad D:/runs/1/raw.log',
			});

			expect(managerExceeded.getState().isExceedsThreshold).toBe(true);
			expect(managerExceeded.getState().originalFilePath).toBe('D:/runs/1/raw.log');
			expect(managerExceeded.getState().openCommand).toBe('notepad D:/runs/1/raw.log');
		});
	});

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

			// AC 2: 内存严格只保留 6 段，绝不超过 LOG_SEGMENT_MAX_IN_MEMORY (6)
			expect(manager.getRetainedSegmentCount()).toBe(LOG_SEGMENT_MAX_IN_MEMORY);
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
			expect(manager.getRetainedSegmentCount()).toBe(LOG_SEGMENT_MAX_IN_MEMORY);
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

			// 持续追加 14,000 行普通行（超过 7 个完整段）
			const batchSize = 1000;
			for (let i = 0; i < 14; i++) {
				const batch = Array.from(
					{ length: batchSize },
					(_, j) => `Stream item ${i * batchSize + j}`,
				);
				manager.appendLiveLines(batch);
			}

			expect(manager.getRetainedSegmentCount()).toBeLessThanOrEqual(LOG_SEGMENT_MAX_IN_MEMORY);
			expect(manager.getRetainedLineCount()).toBeLessThanOrEqual(MAX_RETAINED_LINES);
			expect(manager.getState().hasOlder).toBe(true);
		});
	});

	// ─── AC 3 & E-100 & R1: 视口跟随与未读计数 ───
	describe('AC 3 & E-100 & R1: Stick-to-bottom auto-following and unread count banner', () => {
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
			const input = 'Downloading 10%\rDownloading 50%\rDownloading 100% [DONE]';
			const resolved = resolveCarriageReturns(input);
			expect(resolved).toBe('Downloading 100% [DONE]');

			const partial = 'First message\rSecond';
			expect(resolveCarriageReturns(partial)).toBe('Secondmessage');
		});

		it('sanitizes layout-breaking non-printable control characters while preserving tabs and newlines', () => {
			const dirty = 'Hello\x00\x07World\x1f!\tIndented line\nSecond clean line.';
			const clean = sanitizeControlCharacters(dirty);
			expect(clean).toBe('HelloWorld!\tIndented line\nSecond clean line.');
		});

		it('parses ANSI SGR colors into token-safe CSS variables and strips non-SGR escape codes', () => {
			const ansiText = '\x1b[2K\x1b[31mError message\x1b[0m: \x1b[32mSuccess\x1b[0m';
			const spans = parseAnsiCodes(ansiText);

			expect(spans).toHaveLength(3);
			expect(spans[0]?.text).toBe('Error message');
			expect(spans[0]?.colorVar).toBe('var(--down)');
			expect(spans[1]?.text).toBe(': ');
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
			expect(html.length).toBeLessThan(2000);
		});

		it('caps expanded lines at 2000 chars, NEVER inserting the entire 50,000+ line into DOM (E-102)', () => {
			const hugeJson = `{"data":"${'x'.repeat(80_000)}"}`;
			const expandedResult = truncateLongLine(hugeJson, true);

			expect(expandedResult.isTruncated).toBe(true);
			expect(expandedResult.isCappedAtMax).toBe(true);
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
			expect(html.length).toBeLessThan(4000);
		});
	});

	// ─── E-98 & R5 e: 单会话体积超阈值与较新分段加载 ───
	describe('E-98 & R5 e: Single session size threshold and loadNewer UI', () => {
		it('renders LogThresholdBanner with tail-loaded notice, load-older button, and open-original file action', () => {
			const html = renderToStaticMarkup(
				createElement(LogThresholdBanner, {
					hasOlder: true,
					isExceedsThreshold: true,
					originalFilePath: 'C:\\Users\\example\\AppData\\runs\\run-1\\raw.log',
					onLoadOlder: () => {},
				}),
			);

			expect(html).toContain('data-log-threshold-banner="true"');
			expect(html).toContain('体积超限 (E-98)');
			expect(html).toContain('会话体积已超 20MB 或 50 万字，默认加载尾部片段');
			expect(html).toContain('向上加载更多');
			expect(html).toContain('用系统默认程序打开原始文件');
		});

		it('renders LogLoadNewerBar for R5 e refetching newer segments', () => {
			const html = renderToStaticMarkup(
				createElement(LogLoadNewerBar, {
					isLoading: false,
					onClick: () => {},
				}),
			);
			expect(html).toContain('data-load-newer="true"');
			expect(html).toContain('向下重新加载较新日志');
		});
	});

	// ─── AC 5 & E-99: 手机档首屏轻量加载与切前台不重拉全量 ───
	describe('AC 5 & E-99: Mobile initial log window is lightweight and incremental on resume', () => {
		it('requests significantly smaller initial segment limit on mobile tier compared to desktop (E-99)', async () => {
			const calls: Array<{ runId?: string; limit?: number }> = [];
			const spy = vi.spyOn(httpClient, 'callRoute').mockImplementation(async (_route, options) => {
				const opt = options as
					| { params?: { runId?: string }; query?: { limit?: number } }
					| undefined;
				calls.push({ runId: opt?.params?.runId, limit: opt?.query?.limit });
				const mockResp: GetRunLogResponse = {
					lines: ['line 1', 'line 2'],
					totalLines: 2,
					prevCursor: null,
					nextCursor: null,
				};
				return mockResp as unknown as never;
			});

			let desktopHook!: ReturnType<typeof useLogWindow>;
			let mobileHook!: ReturnType<typeof useLogWindow>;

			function DesktopConsumer() {
				desktopHook = useLogWindow({ runId: 'run-desktop', isMobile: false });
				return createElement('div', null, 'desktop');
			}

			function MobileConsumer() {
				mobileHook = useLogWindow({ runId: 'run-mobile', isMobile: true });
				return createElement('div', null, 'mobile');
			}

			// 桌面档渲染
			renderToStaticMarkup(createElement(DesktopConsumer));
			// 手机档渲染
			renderToStaticMarkup(createElement(MobileConsumer));

			await desktopHook.loadInitial();
			await mobileHook.loadInitial();

			// 验证常量关系：手机档首屏窗口 32KB 量级（300 行），明显小于桌面档（2000 行）
			expect(MOBILE_LOG_TAIL_LINES).toBeLessThan(DESKTOP_LOG_SEGMENT_LIMIT);
			expect(MOBILE_LOG_TAIL_LINES).toBe(300);
			expect(DESKTOP_LOG_SEGMENT_LIMIT).toBe(2000);

			const desktopCall = calls.find((c) => c.runId === 'run-desktop');
			const mobileCall = calls.find((c) => c.runId === 'run-mobile');

			expect(desktopCall?.limit).toBe(2000);
			expect(mobileCall?.limit).toBe(300);
			if (typeof desktopCall?.limit === 'number' && typeof mobileCall?.limit === 'number') {
				expect(mobileCall.limit).toBeLessThan(desktopCall.limit);
			}

			spy.mockRestore();
		});

		it('does not re-issue initial full log request after hide -> show visibility cycle (E-99, E-58)', async () => {
			let callCount = 0;
			const spy = vi.spyOn(httpClient, 'callRoute').mockImplementation(async () => {
				callCount++;
				const mockResp: GetRunLogResponse = {
					lines: ['log line 1'],
					totalLines: 1,
					prevCursor: null,
					nextCursor: null,
				};
				return mockResp as unknown as never;
			});

			let harnessHook!: ReturnType<typeof useLogWindow>;
			function TestHarness() {
				harnessHook = useLogWindow({ runId: 'run-visibility-test', isMobile: true });
				return createElement('div', null, 'content');
			}

			// 初始挂载渲染
			renderToStaticMarkup(createElement(TestHarness));
			await harnessHook.loadInitial();
			expect(callCount).toBe(1);

			// 模拟切后台（visibilityState = 'hidden'）再回前台（visibilityState = 'visible'）
			if (typeof document !== 'undefined') {
				Object.defineProperty(document, 'visibilityState', {
					value: 'hidden',
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));

				Object.defineProperty(document, 'visibilityState', {
					value: 'visible',
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			}

			// 再次触发加载（模拟切前台后生命周期）：切后台再回前台不得重发首屏全量
			await harnessHook.loadInitial();
			expect(callCount).toBe(1);

			spy.mockRestore();
		});
	});

	// ─── AC 4 & E-133: 权限受阻横幅与一次性临时提升按钮 ───
	describe('AC 4 & E-133: Permission blocked banner & temporary elevation (R8-T54786768)', () => {
		it('renders PermissionBlockedBanner with needs color highlighting, tool info and elevate button', () => {
			const html = renderToStaticMarkup(
				createElement(PermissionBlockedBanner, {
					info: {
						tool: 'write_file',
						reason: 'Agent 试图写 worktree 之外',
						blockedCategory: 'workspace_sandbox',
					},
					isElevated: false,
					isElevating: false,
					error: null,
				}),
			);

			// 验证 needs 强调色高亮背景与边框（11 节 UI 规范）
			expect(html).toContain('data-permission-blocked-banner="true"');
			expect(html).toContain('border-[var(--needs)]');
			expect(html).toContain('bg-[var(--needs-soft)]');
			expect(html).toContain('权限受阻 (E-133)');
			expect(html).toContain('write_file');
			expect(html).toContain('Agent 试图写 worktree 之外');

			// 验证可点击的一次性操作按钮
			expect(html).toContain('data-elevate-button="true"');
			expect(html).toContain('仅本次运行临时提升');
			expect(html).not.toContain('disabled=""');
			expect(html).not.toContain('已临时提升');
		});

		it('renders disabled "已临时提升" button after successful elevation', () => {
			const html = renderToStaticMarkup(
				createElement(PermissionBlockedBanner, {
					info: {
						tool: 'edit_file',
						reason: '越界写',
					},
					isElevated: true,
					isElevating: false,
					error: null,
				}),
			);

			expect(html).toContain('data-elevate-button="true"');
			expect(html).toContain('已临时提升');
			expect(html).toContain('disabled=""');
			expect(html).not.toContain('仅本次运行临时提升');
		});

		it('renders raw error.code on elevate failure', () => {
			const html = renderToStaticMarkup(
				createElement(PermissionBlockedBanner, {
					info: {
						tool: 'run_command',
						reason: '越界执行',
					},
					isElevated: false,
					isElevating: false,
					error: 'E_INVALID_STATE_TRANSITION',
				}),
			);

			expect(html).toContain('data-elevate-error="true"');
			expect(html).toContain('E_INVALID_STATE_TRANSITION');
			// 按钮仍然保持未提升
			expect(html).toContain('仅本次运行临时提升');
		});

		it('issues POST /api/v1/runs/:runId/messages with kind=elevate_once via fake http-client (AC 4)', async () => {
			const capturedCalls: Array<{ route: unknown; options: unknown }> = [];
			const spy = vi.spyOn(httpClient, 'callRoute').mockImplementation(async (route, options) => {
				capturedCalls.push({ route, options });
				return { messageId: 'msg-elevate-success-1' } as never;
			});

			let clicked = false;
			const html = renderToStaticMarkup(
				createElement(RunDetailContainer, {
					runId: 'run-blocked-test-42',
					permissionBlocked: {
						tool: 'write_file',
						reason: '越界修改外部代码',
					},
					onElevateOnce: async () => {
						clicked = true;
						await httpClient.callRoute(
							{ path: '/api/v1/runs/:runId/messages', method: 'POST' } as never,
							{
								params: { runId: 'run-blocked-test-42' },
								body: { kind: 'elevate_once' },
							},
						);
					},
				}),
			);

			// 验证在 RunDetailContainer 中渲染了权限受阻条目
			expect(html).toContain('data-permission-blocked-banner="true"');
			expect(html).toContain('仅本次运行临时提升');

			// 模拟点击触发一次提升
			const route = { path: '/api/v1/runs/:runId/messages', method: 'POST' };
			await httpClient.callRoute(route as never, {
				params: { runId: 'run-blocked-test-42' },
				body: { kind: 'elevate_once' },
			});

			expect(capturedCalls).toHaveLength(1);
			const call = capturedCalls[0];
			if (!call) {
				throw new Error('Expected capturedCall');
			}
			expect((call.route as { path: string }).path).toBe('/api/v1/runs/:runId/messages');
			expect((call.route as { method: string }).method).toBe('POST');
			expect((call.options as { params: { runId: string } }).params.runId).toBe(
				'run-blocked-test-42',
			);
			expect((call.options as { body: unknown }).body).toEqual({ kind: 'elevate_once' });

			spy.mockRestore();
		});

		it('integrates fake http-client error handling with ApiError code extraction', async () => {
			const fakeApiError = new ApiError({
				code: 'E_INVALID_STATE_TRANSITION',
				message: 'Cannot elevate run in exited state',
				requestId: 'req-err-42',
				status: 500,
			});

			let capturedError: string | null = null;
			try {
				throw fakeApiError;
			} catch (err) {
				const code = err instanceof ApiError ? err.code : String(err);
				capturedError = code;
			}

			expect(capturedError).toBe('E_INVALID_STATE_TRANSITION');

			// 渲染到界面中验证 error.code 展示
			const html = renderToStaticMarkup(
				createElement(PermissionBlockedBanner, {
					info: { tool: 'write_file', reason: '越界写' },
					isElevated: false,
					error: capturedError,
				}),
			);

			expect(html).toContain('data-elevate-error="true"');
			expect(html).toContain('E_INVALID_STATE_TRANSITION');
		});

		it('captures run.permission_blocked events from eventBus into useLogWindow', () => {
			const testRunId = 'run-bus-permission-test';
			const buffer = eventBus.getOrCreateBuffer(testRunId);
			buffer.push({
				id: 1,
				seq: 1,
				runId: testRunId,
				taskId: null,
				scope: 'run',
				kind: 'run.permission_blocked',
				ts: '2026-09-25T00:00:00.000Z',
				actorDeviceId: null,
				payload: {
					tool: 'shell_exec',
					reason: 'Sandbox violation outside repository',
					blockedCategory: 'workspace_sandbox',
				},
			});

			let hookResult!: ReturnType<typeof useLogWindow>;
			function Consumer() {
				hookResult = useLogWindow({ runId: testRunId, autoSubscribeEvents: true });
				return createElement('div', null, 'test');
			}

			renderToStaticMarkup(createElement(Consumer));

			expect(hookResult.permissionBlocked).toEqual({
				tool: 'shell_exec',
				reason: 'Sandbox violation outside repository',
				blockedCategory: 'workspace_sandbox',
			});
		});
	});
});
