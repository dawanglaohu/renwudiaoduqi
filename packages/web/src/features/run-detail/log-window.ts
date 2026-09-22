/**
 * packages/web/src/features/run-detail/log-window.ts
 *
 * 日志窗口与分段内存管理器（M9-T8 / AC 1, AC 2, AC 3, E-98, E-100, E-143）
 *
 * 规范依据（07 节前端架构与 06 节共用约定）：
 * - 十万行日志只挂载可视窗口，任何时候不把全量放进 DOM 或 store（AC 1, E-143）
 * - 内存只保留 6 段（每段 ≤2000 行），滚出窗口即丢弃并可重拉（AC 2, E-98 客户端侧）
 * - 命名按 07-前端架构.md:284 规范为 LOG_SEGMENT_MAX_IN_MEMORY（R6）
 * - 管理器内部持 version 与缓存快照，只在变更时重建，getState() 返回同一引用（R2）
 * - 按 isProgressLine 折叠相邻刷新行，保持原文落盘，FlattenedLogLine 带 refreshCount（R3）
 * - 契约直接使用 GetRunLogResponse，禁止前端自造 DTO 与文本嗅探（R5 c）
 */

import type { GetRunLogResponse } from '@agent-scheduler/shared/api/runs';
import { isProgressLine } from '../../components/log-lines.tsx';

/**
 * 单段最大行数（daemon GET /api/v1/runs/:runId/log 单次分段上限）。
 */
export const SEGMENT_MAX_LINES = 2000;

/**
 * 客户端内存中允许保留的最大分段数（07-前端架构.md:284 / AC 2 / R6）。
 */
export const LOG_SEGMENT_MAX_IN_MEMORY = 6;

/**
 * 兼容旧命名的别名导出。
 */
export const MAX_RETAINED_SEGMENTS = LOG_SEGMENT_MAX_IN_MEMORY;

/**
 * 内存中驻留的日志行数理论上限（6 段 × 2000 行 = 12000 行）。
 */
export const MAX_RETAINED_LINES = SEGMENT_MAX_LINES * LOG_SEGMENT_MAX_IN_MEMORY;

/**
 * 内存中保留的单条日志条目（支持相邻进度行折叠）。
 */
export interface LogEntry {
	readonly text: string;
	readonly refreshCount?: number;
	readonly collapsedLines?: readonly string[];
}

/**
 * 内存中保留的单个日志片段。
 */
export interface LogWindowSegment {
	/** 片段唯一编号（如 'seg-0', 'seg-1'） */
	readonly id: string;
	/** 该段首行在全局日志流中的起始行索引（0-based） */
	readonly startLineIndex: number;
	/** 本段实际持有的日志条目数组（≤2000 行） */
	readonly entries: readonly LogEntry[];
	/** 向前翻页的字节游标（取自 daemon） */
	readonly prevCursor: string | null;
	/** 向后翻页的字节游标（取自 daemon） */
	readonly nextCursor: string | null;
}

/**
 * 展平后的单行数据视图项。
 */
export interface FlattenedLogLine {
	/** 全局行索引（0-based） */
	readonly globalIndex: number;
	/** 行内文本内容（若发生折叠，为最新一行内容） */
	readonly text: string;
	/** 所属片段编号 */
	readonly segmentId: string;
	/** 折叠的刷新次数（>1 表示有相邻刷新行折叠） */
	readonly refreshCount?: number;
	/** 折叠的全部原始行内容列表 */
	readonly collapsedLines?: readonly string[];
}

/**
 * 日志窗口管理器的不可变快照状态。
 */
export interface LogWindowState {
	/** 服务端报告或已统计的日志总行数（可能达到 100,000 行） */
	readonly totalLines: number;
	/** 内存当前保留的分段数量（严格 ≤ 6） */
	readonly retainedSegmentsCount: number;
	/** 内存当前保留的总行数（严格 ≤ 12,000） */
	readonly retainedLinesCount: number;
	/** 是否因超出 20MB 或 50 万字而默认截取尾部（E-98，取自服务端契约字段） */
	readonly isExceedsThreshold: boolean;
	/** 原始日志落盘路径（E-98 提供外部程序打开） */
	readonly originalFilePath: string | null;
	/** 外部打开命令提示（可选） */
	readonly openCommand: string | null;
	/** 顶部是否仍有更早的历史分段待加载 */
	readonly hasOlder: boolean;
	/** 底部是否仍有因滑动驱逐而被丢弃的较新分段待重新拉取 */
	readonly hasNewer: boolean;
	/** 用户处于非贴底状态时积累的新增行数（AC 3 / E-100） */
	readonly unreadNewCount: number;
	/** 用户当前是否贴底（跟随时新日志自动滚到底部） */
	readonly isAtBottom: boolean;
	/** 内存中当前挂载的展平行列表（可供虚拟列表直接索引） */
	readonly lines: readonly FlattenedLogLine[];
}

type Listener = () => void;

/**
 * 将原始行列表中的相邻进度行（isProgressLine）进行就地合并折叠（AC 4 / E-101 / R3）。
 */
function foldAdjacentProgressLines(rawLines: readonly string[]): LogEntry[] {
	const entries: LogEntry[] = [];
	for (const line of rawLines) {
		if (isProgressLine(line) && entries.length > 0) {
			const last = entries[entries.length - 1];
			if (last && isProgressLine(last.text)) {
				const prevCount = last.refreshCount ?? 1;
				const prevList = last.collapsedLines ?? [last.text];
				entries[entries.length - 1] = {
					text: line,
					refreshCount: prevCount + 1,
					collapsedLines: [...prevList, line],
				};
				continue;
			}
		}
		entries.push({
			text: line,
			refreshCount: 1,
			collapsedLines: [line],
		});
	}
	return entries;
}

/**
 * 日志窗口分段管理器（AC 1, AC 2, AC 3, E-98, E-100, E-143）。
 * 纯类实现，独立于 React 组件生命周期，严格控制内存开销。
 */
export class LogWindowManager {
	private segments: LogWindowSegment[] = [];
	/** Kind of the unfinished SSE text line; null after a newline or REST window reset. */
	private pendingLiveKind: string | null = null;
	private totalLines = 0;
	private isExceedsThreshold = false;
	private originalFilePath: string | null = null;
	private openCommand: string | null = null;
	private hasOlder = false;
	private hasNewer = false;
	private unreadNewCount = 0;
	private isAtBottom = true;
	private nextSegmentSeq = 0;
	private readonly listeners = new Set<Listener>();

	// R2: 管理器内持版本号与缓存快照，只在状态变更时更新
	private version = 0;
	private cachedState: LogWindowState | null = null;

	/**
	 * 构建当前不可变状态快照。
	 */
	private buildState(): LogWindowState {
		const lines: FlattenedLogLine[] = [];
		for (const seg of this.segments) {
			for (let i = 0; i < seg.entries.length; i++) {
				const entry = seg.entries[i];
				if (entry) {
					lines.push({
						globalIndex: seg.startLineIndex + i,
						text: entry.text,
						segmentId: seg.id,
						refreshCount: entry.refreshCount,
						collapsedLines: entry.collapsedLines,
					});
				}
			}
		}

		return Object.freeze({
			totalLines: Math.max(this.totalLines, lines.length),
			retainedSegmentsCount: this.segments.length,
			retainedLinesCount: lines.length,
			isExceedsThreshold: this.isExceedsThreshold,
			originalFilePath: this.originalFilePath,
			openCommand: this.openCommand,
			hasOlder: this.hasOlder,
			hasNewer: this.hasNewer,
			unreadNewCount: this.unreadNewCount,
			isAtBottom: this.isAtBottom,
			lines: Object.freeze(lines),
		});
	}

	/**
	 * 获取当前不可变状态快照（R2: 同一状态多次调用返回同一对象引用）。
	 */
	getState(): LogWindowState {
		if (this.cachedState === null) {
			this.cachedState = this.buildState();
		}
		return this.cachedState;
	}

	/**
	 * 获取当前管理器数据版本号。
	 */
	getVersion(): number {
		return this.version;
	}

	/**
	 * 订阅状态变更。
	 */
	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private invalidateAndNotify(): void {
		this.version += 1;
		this.cachedState = null;
		for (const listener of this.listeners) {
			listener();
		}
	}

	/**
	 * 装载首屏快照分段（E-98 / AC 1 / AC 2 / R5 c）。
	 * 读服务端契约字段，禁止前端自行正文嗅探。
	 */
	loadInitial(res: GetRunLogResponse): void {
		this.segments = [];
		this.pendingLiveKind = null;
		this.totalLines = Math.max(res.totalLines || 0, res.lines.length);
		// R5 c: 直接读取服务端契约字段，不从正文包含文本嗅探
		this.isExceedsThreshold = Boolean(res.isExceedsThreshold);
		this.originalFilePath = res.originalFilePath ?? null;
		this.openCommand = res.openCommand ?? null;
		this.hasOlder = Boolean(res.prevCursor);
		this.hasNewer = Boolean(res.nextCursor);
		this.unreadNewCount = 0;

		if (res.lines.length === 0) {
			this.invalidateAndNotify();
			return;
		}

		// 计算起始行号：若处于尾部截取态，起始行即 totalLines - lines.length
		const isTailLoad = Boolean(res.prevCursor) || this.isExceedsThreshold;
		const baseStartLine = isTailLoad ? Math.max(0, this.totalLines - res.lines.length) : 0;

		// 将输入行按 isProgressLine 折叠相邻刷新行（R3）
		const foldedEntries = foldAdjacentProgressLines(res.lines);
		const chunked: LogWindowSegment[] = [];

		for (let offset = 0; offset < foldedEntries.length; offset += SEGMENT_MAX_LINES) {
			const slice = foldedEntries.slice(offset, offset + SEGMENT_MAX_LINES);
			const segStart = baseStartLine + offset;
			this.nextSegmentSeq += 1;
			chunked.push({
				id: `seg-${this.nextSegmentSeq}`,
				startLineIndex: segStart,
				entries: Object.freeze(slice),
				prevCursor: offset === 0 ? res.prevCursor : null,
				nextCursor: offset + SEGMENT_MAX_LINES >= foldedEntries.length ? res.nextCursor : null,
			});
		}

		// AC 2 / R6: 内存只保留 LOG_SEGMENT_MAX_IN_MEMORY (6) 段
		while (chunked.length > LOG_SEGMENT_MAX_IN_MEMORY) {
			chunked.shift();
			this.hasOlder = true;
		}

		this.segments = chunked;
		this.invalidateAndNotify();
	}

	/**
	 * 向上加载历史片段（E-143 / E-98 / AC 2）。
	 * 向头部插入新段；超过 6 段时自动驱逐尾部段，丢弃的段可重新向后拉取。
	 */
	prependOlderSegment(res: GetRunLogResponse): void {
		if (res.lines.length === 0) {
			this.hasOlder = false;
			this.invalidateAndNotify();
			return;
		}

		const foldedEntries = foldAdjacentProgressLines(res.lines);
		const currentFirst = this.segments[0];
		const startLine = currentFirst
			? Math.max(0, currentFirst.startLineIndex - foldedEntries.length)
			: 0;

		this.nextSegmentSeq += 1;
		const newSeg: LogWindowSegment = {
			id: `seg-${this.nextSegmentSeq}`,
			startLineIndex: startLine,
			entries: Object.freeze(foldedEntries),
			prevCursor: res.prevCursor,
			nextCursor: res.nextCursor,
		};

		this.segments.unshift(newSeg);
		this.hasOlder = Boolean(res.prevCursor);

		// AC 2 / R6: 超过 6 段，丢弃尾部段
		while (this.segments.length > LOG_SEGMENT_MAX_IN_MEMORY) {
			this.segments.pop();
			this.hasNewer = true;
		}

		this.invalidateAndNotify();
	}

	/**
	 * 向下重新加载较新片段（AC 2 / E-98 滚出重拉）。
	 * 向尾部插入新段；超过 6 段时自动驱逐头部段。
	 */
	appendNewerSegment(res: GetRunLogResponse): void {
		this.pendingLiveKind = null;
		if (res.lines.length === 0) {
			this.hasNewer = false;
			this.invalidateAndNotify();
			return;
		}

		const foldedEntries = foldAdjacentProgressLines(res.lines);
		const currentLast = this.segments[this.segments.length - 1];
		const startLine = currentLast ? currentLast.startLineIndex + currentLast.entries.length : 0;

		this.nextSegmentSeq += 1;
		const newSeg: LogWindowSegment = {
			id: `seg-${this.nextSegmentSeq}`,
			startLineIndex: startLine,
			entries: Object.freeze(foldedEntries),
			prevCursor: res.prevCursor,
			nextCursor: res.nextCursor,
		};

		this.segments.push(newSeg);
		this.hasNewer = Boolean(res.nextCursor);

		// AC 2 / R6: 超过 6 段，丢弃头部段
		while (this.segments.length > LOG_SEGMENT_MAX_IN_MEMORY) {
			this.segments.shift();
			this.hasOlder = true;
		}

		this.invalidateAndNotify();
	}

	/**
	 * 追加实时运行日志行（AC 3 / E-100 / AC 2 / R3）。
	 * 折叠相邻进度刷新行（保留最新文本 + 计数），不让高频进度条打爆行数。
	 */
	appendLiveLines(newLines: readonly string[]): void {
		if (newLines.length === 0) {
			return;
		}
		this.pendingLiveKind = null;

		if (this.segments.length === 0) {
			this.nextSegmentSeq += 1;
			this.segments.push({
				id: `seg-${this.nextSegmentSeq}`,
				startLineIndex: 0,
				entries: Object.freeze([]),
				prevCursor: null,
				nextCursor: null,
			});
		}

		for (const rawLine of newLines) {
			const activeSegIndex = this.segments.length - 1;
			const activeSeg = this.segments[activeSegIndex];
			if (!activeSeg) {
				break;
			}

			const currentEntries = [...activeSeg.entries];
			const lastEntry =
				currentEntries.length > 0 ? currentEntries[currentEntries.length - 1] : undefined;

			// R3: 探测相邻进度刷新行，如果前一行也是进度行，则在原地折叠更新
			if (isProgressLine(rawLine) && lastEntry && isProgressLine(lastEntry.text)) {
				const prevCount = lastEntry.refreshCount ?? 1;
				const prevCollapsed = lastEntry.collapsedLines ?? [lastEntry.text];
				currentEntries[currentEntries.length - 1] = {
					text: rawLine,
					refreshCount: prevCount + 1,
					collapsedLines: [...prevCollapsed, rawLine],
				};
				this.segments[activeSegIndex] = {
					...activeSeg,
					entries: Object.freeze(currentEntries),
				};
				continue;
			}

			// 普通新增行或首个进度行
			const newEntry: LogEntry = {
				text: rawLine,
				refreshCount: 1,
				collapsedLines: [rawLine],
			};

			if (currentEntries.length < SEGMENT_MAX_LINES) {
				currentEntries.push(newEntry);
				this.segments[activeSegIndex] = {
					...activeSeg,
					entries: Object.freeze(currentEntries),
				};
			} else {
				// 当前段已满 2000 行，开新段
				this.nextSegmentSeq += 1;
				const startLine = activeSeg.startLineIndex + activeSeg.entries.length;
				const newSeg: LogWindowSegment = {
					id: `seg-${this.nextSegmentSeq}`,
					startLineIndex: startLine,
					entries: Object.freeze([newEntry]),
					prevCursor: null,
					nextCursor: null,
				};
				this.segments.push(newSeg);

				// 超过 6 段，驱逐头部段
				while (this.segments.length > LOG_SEGMENT_MAX_IN_MEMORY) {
					this.segments.shift();
					this.hasOlder = true;
				}
			}
		}

		this.totalLines += newLines.length;

		// AC 3 / E-100: 贴底才跟随；中部时不跳底，累加新增条数
		if (this.isAtBottom) {
			this.unreadNewCount = 0;
		} else {
			this.unreadNewCount += newLines.length;
		}

		this.invalidateAndNotify();
	}

	/**
	 * SSE message/thought events carry token deltas, not completed lines. Extend the current
	 * unfinished line in place; only a newline (or a change of event kind) starts another row.
	 * REST segments are never used as the unfinished line, even if their final text lacks a newline.
	 */
	appendLiveChunk(chunk: string, kind: string): void {
		if (!chunk) return;
		if (this.pendingLiveKind !== kind) this.pendingLiveKind = null;
		const pieces = chunk.split('\n');
		for (let index = 0; index < pieces.length; index += 1) {
			const piece = pieces[index] ?? '';
			const terminatesLine = index < pieces.length - 1;
			if (this.pendingLiveKind === kind && index === 0) {
				if (piece) {
					const tailIndex = this.segments.length - 1;
					const tail = this.segments[tailIndex];
					if (tail?.entries.length) {
						const entries = [...tail.entries];
						const previous = entries[entries.length - 1];
						if (previous) {
							const text = previous.text + piece;
							entries[entries.length - 1] = { ...previous, text, collapsedLines: [text] };
							this.segments[tailIndex] = { ...tail, entries: Object.freeze(entries) };
							this.invalidateAndNotify();
						}
					}
				}
			} else if (piece || terminatesLine) {
				this.appendLiveLines([piece]);
			}
			// A trailing newline closes the row. Its empty final split piece must not make
			// the next token append to the already-completed line.
			this.pendingLiveKind = terminatesLine || !piece ? null : kind;
		}
	}

	/**
	 * 更新用户的视口贴底状态（AC 3 / E-100）。
	 */
	setAtBottom(atBottom: boolean): void {
		if (this.isAtBottom === atBottom) {
			return;
		}
		this.isAtBottom = atBottom;
		if (atBottom) {
			this.unreadNewCount = 0;
		}
		this.invalidateAndNotify();
	}

	/**
	 * 用户手动点击「回到底部」清除未读并恢复贴底（AC 3 / E-100）。
	 */
	resetUnreadCount(): void {
		this.unreadNewCount = 0;
		this.isAtBottom = true;
		this.invalidateAndNotify();
	}

	/**
	 * 获取最早分段的前向游标（用于加载更早历史）。
	 */
	getOldestCursor(): string | null {
		return this.segments[0]?.prevCursor ?? null;
	}

	/** SSE chunks lack raw-file byte cursors: re-anchor from REST tail after it evicts every REST segment. */
	needsTailReload(): boolean {
		return this.hasOlder && this.getOldestCursor() === null;
	}

	/**
	 * 获取最新分段的后向游标（用于重拉已被丢弃的较新片段）。
	 */
	getNewestCursor(): string | null {
		return this.segments[this.segments.length - 1]?.nextCursor ?? null;
	}

	/**
	 * 获取内存中保留的分段数（用于断言 ≤ 6）。
	 */
	getRetainedSegmentCount(): number {
		return this.segments.length;
	}

	/**
	 * 获取内存中保留的总行数（用于断言 ≤ 12,000）。
	 */
	getRetainedLineCount(): number {
		let sum = 0;
		for (const seg of this.segments) {
			sum += seg.entries.length;
		}
		return sum;
	}
}
