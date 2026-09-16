/**
 * packages/web/src/features/run-detail/run-detail-container.tsx
 *
 * 运行详情与日志窗口容器（M9-T8 / AC 1, AC 2, AC 3, E-98, E-100, E-143）
 *
 * 规范依据（07 节前端架构）：
 * - features 容器层：只负责拼装展示组件与连接数据源
 * - 容器里只许写 grid/flex/gap，禁止写颜色字号圆角（07 节架构硬性规则）
 * - 虚拟滚动经 components/virtual-rows.tsx 使用（AC 6）
 * - 十万行日志只挂载可视窗口，任何时候不把全量放进 DOM 或 store（AC 1, E-143）
 * - 内存只保留 6 段，用户滚到中部时新事件到达不自动跳底，显示「N 条新事件」（AC 2, AC 3, E-100）
 */

import { useCallback, useRef, useState } from 'react';
import { LogBottomNotice, LogLine, LogThresholdBanner } from '../../components/log-lines.tsx';
import { VirtualRows, type VirtualRowsHandle } from '../../components/virtual-rows.tsx';
import { useLogWindow } from './use-log-window.ts';

export interface RunDetailContainerProps {
	/** 运行编号 */
	readonly runId: string;
	/** 容器布局外层类名（只许包含 flex/grid/gap/尺寸，不包含颜色圆角） */
	readonly className?: string;
	/** 用系统默认程序打开原始文件的外部回调（E-98） */
	readonly onOpenOriginalFile?: (filePath: string) => void;
}

/**
 * 运行详情与日志窗口容器组件。
 */
export function RunDetailContainer({
	runId,
	className,
	onOpenOriginalFile,
}: RunDetailContainerProps) {
	const virtualRef = useRef<VirtualRowsHandle | null>(null);
	const [expandedIndices, setExpandedIndices] = useState<ReadonlySet<number>>(() => new Set());

	const { state, isLoadingOlder, loadOlder, handleScroll, handleResetUnread } = useLogWindow({
		runId,
	});

	const handleScrollToBottom = useCallback(() => {
		virtualRef.current?.scrollToBottom();
		handleResetUnread();
	}, [handleResetUnread]);

	const handleToggleExpand = useCallback((index: number) => {
		setExpandedIndices((prev) => {
			const next = new Set(prev);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			return next;
		});
	}, []);

	const handleOpenOriginal = useCallback(() => {
		if (state.originalFilePath) {
			onOpenOriginalFile?.(state.originalFilePath);
		}
	}, [state.originalFilePath, onOpenOriginalFile]);

	return (
		<div className={`flex flex-col h-full gap-2 relative ${className ?? ''}`}>
			{/* E-98 顶部体积警告与历史分段加载栏 */}
			<LogThresholdBanner
				hasOlder={state.hasOlder}
				isExceedsThreshold={state.isExceedsThreshold}
				originalFilePath={state.originalFilePath}
				isLoadingOlder={isLoadingOlder}
				onLoadOlder={loadOlder}
				onOpenOriginal={state.originalFilePath ? handleOpenOriginal : undefined}
			/>

			{/* 虚拟滚动列表展示区（AC 1, AC 6, E-143） */}
			<div className="flex-1 min-h-0 relative">
				<VirtualRows
					ref={virtualRef}
					count={state.lines.length}
					estimateSize={22}
					renderItem={({ index }) => {
						const line = state.lines[index];
						if (!line) {
							return null;
						}
						return (
							<LogLine
								index={index}
								lineNumber={line.globalIndex + 1}
								text={line.text}
								isExpanded={expandedIndices.has(index)}
								onToggleExpand={handleToggleExpand}
							/>
						);
					}}
					onScroll={handleScroll}
					className="h-full w-full"
				/>

				{/* AC 3 / E-100: 滚到中部时新事件到达不自动跳底，显示浮动未读提示 */}
				{state.unreadNewCount > 0 && !state.isAtBottom && (
					<LogBottomNotice unreadCount={state.unreadNewCount} onClick={handleScrollToBottom} />
				)}
			</div>
		</div>
	);
}

// 同时导出别名 LogWindowContainer 以便按语境调用
export { RunDetailContainer as LogWindowContainer };
