/**
 * packages/web/src/features/run-detail/log-window.ts
 *
 * 日志窗口与分段内存管理器（M9-T8 / AC 1, AC 2, AC 3, E-98, E-100, E-143）
 *
 * 规范依据（07 节前端架构与 06 节共用约定）：
 * - 十万行日志只挂载可视窗口，任何时候不把全量放进 DOM 或 store（AC 1, E-143）
 * - 内存只保留 6 段（每段 ≤2000 行），滚出窗口即丢弃并可重拉（AC 2, E-98 客户端侧）
 * - 用户滚到中部时新事件到达不自动跳底，显示「N 条新事件」，仅贴底才跟随（AC 3, E-100）
 * - 大会话体积超阈值（>20MB 或 50 万字）默认加载尾部片段，顶部提供「向上加载更多」与「用系统默认程序打开原始文件」（E-98）
 * - 高频事件流不进 zustand 也不进 React state，日志正文只在内存窗口维护（07 节状态管理）
 */

import type { GetRunLogResponse } from '@agent-scheduler/shared/api/runs';

/**
 * 单段最大行数（daemon GET /api/v1/runs/:runId/log 单次分段上限）。
 */
export const SEGMENT_MAX_LINES = 2000;

/**
 * 客户端内存中允许保留的最大分段数（AC 2 / E-98 / 07 节状态管理）。
 */
export const MAX_RETAINED_SEGMENTS = 6;

/**
 * 内存中驻留的日志行数理论上限（6 段 × 2000 行 = 12000 行）。
 */
export const MAX_RETAINED_LINES = SEGMENT_MAX_LINES * MAX_RETAINED_SEGMENTS;

/**
 * 日志响应输入类型（兼顾 shared DTO 与守护进程扩展的 E-98 体积超限字段）。
 */
export interface ExtendedLogResponse extends GetRunLogResponse {
	readonly isExceedsThreshold?: boolean;
	readonly originalFilePath?: string | null;
	readonly openCommand?: string | null;
}

/**
 * 内存中保留的单个日志片段。
 */
export interface LogWindowSegment {
	/** 片段唯一编号（如 'seg-0', 'seg-1'） */
	readonly id: string;
	/** 该段首行在全局日志流中的起始行索引（0-based） */
	readonly startLineIndex: number;
	/** 本段实际持有的日志行数组（≤2000 行） */
	readonly lines: readonly string[];
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
	/** 行内文本内容 */
	readonly text: string;
	/** 所属片段编号 */
	readonly segmentId: string;
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
	/** 是否因超出 20MB 或 50 万字而默认截取尾部（E-98） */
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
 * 日志窗口分段管理器（AC 1, AC 2, AC 3, E-98, E-100, E-143）。
 * 纯类实现，独立于 React 组件生命周期，严格控制内存开销。
 */
export class LogWindowManager {
	private segments: LogWindowSegment[] = [];
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

	/**
	 * 获取当前不可变状态快照。
	 */
	getState(): LogWindowState {
		const lines: FlattenedLogLine[] = [];
		for (const seg of this.segments) {
			for (let i = 0; i < seg.lines.length; i++) {
				lines.push({
					globalIndex: seg.startLineIndex + i,
					text: seg.lines[i] ?? '',
					segmentId: seg.id,
				});
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
	 * 订阅状态变更。
	 */
	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	/**
	 * 装载首屏快照分段（E-98 / AC 1 / AC 2）。
	 * 若会话超限默认加载尾部片段；切分为至多 6 段。
	 */
	loadInitial(res: ExtendedLogResponse): void {
		this.segments = [];
		this.totalLines = Math.max(res.totalLines || 0, res.lines.length);

		// 判定是否超限（支持字段或根据首行提示文本回落识别）
		const hasExceedHint = res.lines.some(
			(l) => l.includes('20MB') || l.includes('50 万字') || l.includes('E-98'),
		);
		this.isExceedsThreshold = Boolean(res.isExceedsThreshold || hasExceedHint);
		this.originalFilePath = res.originalFilePath ?? null;
		this.openCommand = res.openCommand ?? null;
		this.hasOlder = Boolean(res.prevCursor);
		this.hasNewer = Boolean(res.nextCursor);
		this.unreadNewCount = 0;

		if (res.lines.length === 0) {
			this.notify();
			return;
		}

		// 计算起始行号：若处于尾部截取态，起始行即 totalLines - lines.length
		const isTailLoad = Boolean(res.prevCursor) || this.isExceedsThreshold;
		const baseStartLine = isTailLoad ? Math.max(0, this.totalLines - res.lines.length) : 0;

		// 将输入行以 SEGMENT_MAX_LINES (2000) 为单位切片
		const incomingLines = [...res.lines];
		const chunked: LogWindowSegment[] = [];

		for (let offset = 0; offset < incomingLines.length; offset += SEGMENT_MAX_LINES) {
			const slice = incomingLines.slice(offset, offset + SEGMENT_MAX_LINES);
			const segStart = baseStartLine + offset;
			this.nextSegmentSeq += 1;
			chunked.push({
				id: `seg-${this.nextSegmentSeq}`,
				startLineIndex: segStart,
				lines: Object.freeze(slice),
				prevCursor: offset === 0 ? res.prevCursor : null,
				nextCursor: offset + SEGMENT_MAX_LINES >= incomingLines.length ? res.nextCursor : null,
			});
		}

		// AC 2: 内存只保留 6 段，多出的片段驱逐
		while (chunked.length > MAX_RETAINED_SEGMENTS) {
			chunked.shift();
			this.hasOlder = true;
		}

		this.segments = chunked;
		this.notify();
	}

	/**
	 * 向上加载历史片段（E-143 / E-98 / AC 2）。
	 * 向头部插入新段；超过 6 段时自动驱逐尾部段，丢弃的段可重新向后拉取。
	 */
	prependOlderSegment(res: ExtendedLogResponse): void {
		if (res.lines.length === 0) {
			this.hasOlder = false;
			this.notify();
			return;
		}

		const currentFirst = this.segments[0];
		const startLine = currentFirst
			? Math.max(0, currentFirst.startLineIndex - res.lines.length)
			: 0;

		this.nextSegmentSeq += 1;
		const newSeg: LogWindowSegment = {
			id: `seg-${this.nextSegmentSeq}`,
			startLineIndex: startLine,
			lines: Object.freeze([...res.lines]),
			prevCursor: res.prevCursor,
			nextCursor: res.nextCursor,
		};

		this.segments.unshift(newSeg);
		this.hasOlder = Boolean(res.prevCursor);

		// AC 2: 超过 6 段，丢弃尾部段（滚出窗口即丢弃，并可重拉）
		while (this.segments.length > MAX_RETAINED_SEGMENTS) {
			this.segments.pop();
			this.hasNewer = true; // 尾部被丢弃，标记可向后重拉
		}

		this.notify();
	}

	/**
	 * 向下重新加载较新片段（AC 2 / E-98 滚出重拉）。
	 * 向尾部插入新段；超过 6 段时自动驱逐头部段。
	 */
	appendNewerSegment(res: ExtendedLogResponse): void {
		if (res.lines.length === 0) {
			this.hasNewer = false;
			this.notify();
			return;
		}

		const currentLast = this.segments[this.segments.length - 1];
		const startLine = currentLast ? currentLast.startLineIndex + currentLast.lines.length : 0;

		this.nextSegmentSeq += 1;
		const newSeg: LogWindowSegment = {
			id: `seg-${this.nextSegmentSeq}`,
			startLineIndex: startLine,
			lines: Object.freeze([...res.lines]),
			prevCursor: res.prevCursor,
			nextCursor: res.nextCursor,
		};

		this.segments.push(newSeg);
		this.hasNewer = Boolean(res.nextCursor);

		// AC 2: 超过 6 段，丢弃头部段
		while (this.segments.length > MAX_RETAINED_SEGMENTS) {
			this.segments.shift();
			this.hasOlder = true; // 头部被丢弃，标记可向前重拉
		}

		this.notify();
	}

	/**
	 * 追加实时运行日志行（AC 3 / E-100 / AC 2）。
	 * 仅贴底时自动跟随；滚到中部时新事件到达不自动跳底，累加 unreadNewCount。
	 */
	appendLiveLines(newLines: readonly string[]): void {
		if (newLines.length === 0) {
			return;
		}

		// 如果内存尚无片段，建立第一个片段
		if (this.segments.length === 0) {
			this.nextSegmentSeq += 1;
			this.segments.push({
				id: `seg-${this.nextSegmentSeq}`,
				startLineIndex: 0,
				lines: Object.freeze([]),
				prevCursor: null,
				nextCursor: null,
			});
		}

		let pendingLines = [...newLines];

		while (pendingLines.length > 0) {
			const activeSeg = this.segments[this.segments.length - 1];
			if (!activeSeg) {
				break;
			}
			const currentLines = activeSeg.lines;
			const availableSpace = SEGMENT_MAX_LINES - currentLines.length;

			if (availableSpace > 0) {
				const takeCount = Math.min(availableSpace, pendingLines.length);
				const toAppend = pendingLines.slice(0, takeCount);
				pendingLines = pendingLines.slice(takeCount);

				const updatedSeg: LogWindowSegment = {
					...activeSeg,
					lines: Object.freeze([...currentLines, ...toAppend]),
				};
				this.segments[this.segments.length - 1] = updatedSeg;
			} else {
				// 当前尾部段已满 2000 行，开启新分段
				this.nextSegmentSeq += 1;
				const startLine = activeSeg.startLineIndex + activeSeg.lines.length;
				const newSeg: LogWindowSegment = {
					id: `seg-${this.nextSegmentSeq}`,
					startLineIndex: startLine,
					lines: Object.freeze([]),
					prevCursor: null,
					nextCursor: null,
				};
				this.segments.push(newSeg);

				// AC 2: 超过 6 段，驱逐头部段
				while (this.segments.length > MAX_RETAINED_SEGMENTS) {
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

		this.notify();
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
		this.notify();
	}

	/**
	 * 用户手动点击「回到底部」清除未读并恢复贴底（AC 3 / E-100）。
	 */
	resetUnreadCount(): void {
		this.unreadNewCount = 0;
		this.isAtBottom = true;
		this.notify();
	}

	/**
	 * 获取最早分段的前向游标（用于加载更早历史）。
	 */
	getOldestCursor(): string | null {
		return this.segments[0]?.prevCursor ?? null;
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
			sum += seg.lines.length;
		}
		return sum;
	}
}
