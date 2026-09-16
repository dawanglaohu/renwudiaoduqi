/**
 * packages/web/src/components/virtual-rows.tsx
 *
 * 虚拟列表包装组件（M9-T8 / AC 1, AC 6, E-143）
 *
 * 规范依据（07 节前端架构与 11 节 UI）：
 * - 纯展示层组件：纯 props in / callback out，禁止 import api/store/features/shell，禁止内部 useEffect 取数（07 节）
 * - 虚拟滚动只经这一个包装使用，禁止第二处直接 import TanStack Virtual（AC 6）
 * - 十万行日志只挂载可视窗口，任何时候不把全量放进 DOM 或 store（AC 1, E-143）
 * - 支持动态元素高度测量（measureElement）与固定高度预估
 * - 提供滚动状态度量回调（isAtBottom、scrollTop、scrollHeight、clientHeight）
 * - 暴露出标准命令式句柄（scrollToIndex、scrollToOffset、scrollToBottom、isAtBottom、getTotalSize）
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import {
	type HTMLAttributes,
	type Key,
	type ReactNode,
	type UIEvent,
	forwardRef,
	useCallback,
	useImperativeHandle,
	useRef,
} from 'react';

/**
 * 虚拟列表中单个渲染项的几何与索引元信息。
 */
export interface VirtualRowItem {
	/** 在虚拟列表中的项目索引号（0-based） */
	readonly index: number;
	/** 绝对定位顶部偏移像素 */
	readonly start: number;
	/** 当前行的高（像素） */
	readonly size: number;
	/** 唯一键名 */
	readonly key: Key;
}

/**
 * 滚动位置与贴底状态度量。
 */
export interface VirtualScrollInfo {
	readonly scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
	readonly isAtBottom: boolean;
}

/**
 * 虚拟列表组件向外部暴露的命令式操作句柄。
 */
export interface VirtualRowsHandle {
	/** 滚动到指定行索引 */
	readonly scrollToIndex: (
		index: number,
		options?: {
			align?: 'start' | 'center' | 'end' | 'auto';
			behavior?: 'auto' | 'smooth';
		},
	) => void;
	/** 滚动到指定像素偏移 */
	readonly scrollToOffset: (
		offset: number,
		options?: {
			align?: 'start' | 'center' | 'end' | 'auto';
			behavior?: 'auto' | 'smooth';
		},
	) => void;
	/** 直接滚动至最底部 */
	readonly scrollToBottom: () => void;
	/** 检查当前是否处于贴底状态（距离底部在阈值内） */
	readonly isAtBottom: () => boolean;
	/** 获取外层滚动 DOM 容器节点 */
	readonly getScrollElement: () => HTMLDivElement | null;
	/** 获取虚拟内容的总像素高度 */
	readonly getTotalSize: () => number;
}

/**
 * 虚拟列表组件属性。
 */
export interface VirtualRowsProps
	extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'onScroll'> {
	/** 列表虚拟项总行数（十万行场景传入 totalLines） */
	readonly count: number;
	/** 单行预估高度（像素数值或依据索引的计算函数，默认 22px） */
	readonly estimateSize?: number | ((index: number) => number);
	/** 渲染每个可视项的回调函数 */
	readonly renderItem: (item: VirtualRowItem) => ReactNode;
	/** 可视窗口外预挂载缓冲行数（默认 5） */
	readonly overscan?: number;
	/** 判定「贴底」的底部剩余像素容差（默认 24px） */
	readonly bottomThreshold?: number;
	/** 滚动事件回调（带贴底判定与度量信息） */
	readonly onScroll?: (event: UIEvent<HTMLDivElement>, info: VirtualScrollInfo) => void;
	/** 键名提取函数 */
	readonly getItemKey?: (index: number) => Key;
	/** 放置在虚拟列表上方的自定义头部节点（如加载更多条或体积警告） */
	readonly header?: ReactNode;
	/** 放置在虚拟列表下方的自定义尾部节点 */
	readonly footer?: ReactNode;
	/** 虚拟内容容器自定义类名 */
	readonly innerClassName?: string;
	/** 是否启用动态 DOM 尺寸测量（默认 true，单行展开时自动更新高度） */
	readonly enableDynamicMeasurement?: boolean;
}

/**
 * 虚拟列表包装组件（AC 1, AC 6）。
 * 全仓唯一允许 import `@tanstack/react-virtual` 的地方。
 */
export const VirtualRows = forwardRef<VirtualRowsHandle, VirtualRowsProps>(function VirtualRows(
	{
		count,
		estimateSize = 22,
		renderItem,
		overscan = 5,
		bottomThreshold = 24,
		onScroll,
		getItemKey,
		header,
		footer,
		className,
		innerClassName,
		enableDynamicMeasurement = true,
		style,
		...rest
	},
	ref,
) {
	const scrollElementRef = useRef<HTMLDivElement | null>(null);

	const sizeEstimator = typeof estimateSize === 'function' ? estimateSize : () => estimateSize;

	// AC 6: 唯一一处调用 TanStack Virtual
	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => scrollElementRef.current,
		estimateSize: sizeEstimator,
		overscan,
		getItemKey,
	});

	const checkIsAtBottom = useCallback((): boolean => {
		const el = scrollElementRef.current;
		if (!el) {
			return true;
		}
		return el.scrollHeight - el.scrollTop - el.clientHeight <= bottomThreshold;
	}, [bottomThreshold]);

	const scrollToBottom = useCallback(() => {
		const el = scrollElementRef.current;
		if (!el) {
			return;
		}
		el.scrollTop = el.scrollHeight;
	}, []);

	useImperativeHandle(
		ref,
		() => ({
			scrollToIndex: (index, options) => virtualizer.scrollToIndex(index, options),
			scrollToOffset: (offset, options) => virtualizer.scrollToOffset(offset, options),
			scrollToBottom,
			isAtBottom: checkIsAtBottom,
			getScrollElement: () => scrollElementRef.current,
			getTotalSize: () => virtualizer.getTotalSize(),
		}),
		[virtualizer, scrollToBottom, checkIsAtBottom],
	);

	const handleScroll = (event: UIEvent<HTMLDivElement>) => {
		const el = event.currentTarget;
		const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= bottomThreshold;
		onScroll?.(event, {
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
			isAtBottom,
		});
	};

	const virtualItems = virtualizer.getVirtualItems();

	return (
		<div
			ref={scrollElementRef}
			onScroll={handleScroll}
			className={className}
			data-virtual-scroll="true"
			style={{
				overflowY: 'auto',
				position: 'relative',
				...style,
			}}
			{...rest}
		>
			{header}
			<div
				className={innerClassName}
				data-virtual-content="true"
				style={{
					height: `${virtualizer.getTotalSize()}px`,
					width: '100%',
					position: 'relative',
				}}
			>
				{virtualItems.map((virtualItem) => (
					<div
						key={virtualItem.key}
						data-index={virtualItem.index}
						ref={enableDynamicMeasurement ? virtualizer.measureElement : undefined}
						style={{
							position: 'absolute',
							top: 0,
							left: 0,
							width: '100%',
							transform: `translateY(${virtualItem.start}px)`,
						}}
					>
						{renderItem({
							index: virtualItem.index,
							start: virtualItem.start,
							size: virtualItem.size,
							key: virtualItem.key,
						})}
					</div>
				))}
			</div>
			{footer}
		</div>
	);
});
