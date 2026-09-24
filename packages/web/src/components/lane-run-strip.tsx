/**
 * packages/web/src/components/lane-run-strip.tsx
 *
 * 手机档单泳道顶部 44px 运行条（M9-T21 / AC 9, E-319, E-324 / 11 节 UI）
 *
 * 规范依据：
 * - 纯展示组件（components 纯 props in / callback out），禁止 import api/store/features/shell（07 节）
 * - 顶部 44px 运行条「泳道 k/N · 〈taskKey〉 · 状态字形+文字」（AC 9, E-324）
 * - 两端各一个 ≥44×44 的 ◀ ▶ 切换按钮，totalLanes <= 1 或到边界时 disabled 不隐藏（AC 9, E-324）
 * - 空闲泳道写「泳道 k/N · 空闲」（E-319）
 * - 收口运行泳道同样单流显示，不出「收口」按钮（E-324）
 */

import type { HTMLAttributes } from 'react';
import type { StatusState } from '../lib/spine-shape.ts';
import { StatusBadge } from './status-badge.tsx';

export interface LaneRunStripProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
	/** 当前泳道序号（1-based 整数，k） */
	readonly currentIndex: number;
	/** 总泳道数（N） */
	readonly totalLanes: number;
	/** 任务标识符（如 M9-T21） */
	readonly taskKey?: string | null;
	/** 任务标题 */
	readonly title?: string | null;
	/** 状态 */
	readonly status?: StatusState | string;
	/** 是否处于空闲态（E-319） */
	readonly isIdle?: boolean;
	/** 是否为收口泳道（E-324） */
	readonly isWrapup?: boolean;
	/** 切换到上一泳道 */
	readonly onPrev?: () => void;
	/** 切换到下一泳道 */
	readonly onNext?: () => void;
}

export function LaneRunStrip({
	currentIndex,
	totalLanes,
	taskKey,
	title,
	status = 'queued',
	isIdle = false,
	isWrapup = false,
	onPrev,
	onNext,
	className,
	...rest
}: LaneRunStripProps) {
	// 边界与禁用判定（N <= 1 或到边界 disabled，绝不隐藏，AC 9, E-324）
	const canPrev = totalLanes > 1 && currentIndex > 1;
	const canNext = totalLanes > 1 && currentIndex < totalLanes;

	let middleText = '';
	if (isIdle) {
		middleText = `泳道 ${currentIndex}/${totalLanes} · 空闲`;
	} else if (isWrapup) {
		middleText = `泳道 ${currentIndex}/${totalLanes} · 批次收口`;
	} else {
		const taskIdentifier = taskKey ?? title ?? '—';
		middleText = `泳道 ${currentIndex}/${totalLanes} · ${taskIdentifier}`;
	}

	return (
		<div
			data-component="lane-run-strip"
			data-current-lane={currentIndex}
			data-total-lanes={totalLanes}
			className={[
				'flex items-center justify-between w-full h-[44px] min-h-[44px] px-1',
				'bg-[var(--bg)] border-b border-[var(--border)] select-none text-[13px] font-ui',
				className ?? '',
			].join(' ')}
			{...rest}
		>
			{/* 左侧 ◀ 切换按钮：尺寸必须 ≥44×44px，disabled 不隐藏（AC 9, E-324） */}
			<button
				type="button"
				data-action="prev-lane"
				disabled={!canPrev}
				onClick={onPrev}
				aria-label="查看上一泳道"
				className={`
					flex items-center justify-center w-[44px] h-[44px] min-w-[44px] min-h-[44px]
					rounded-[9px] text-[var(--ink-2)] hover:text-[var(--ink-1)] active:bg-[var(--panel-2)]
					focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--needs-soft)]
					${canPrev ? 'cursor-pointer opacity-100' : 'cursor-not-allowed opacity-30'}
				`}
			>
				<span className="text-[16px] leading-none" aria-hidden="true">
					◀
				</span>
			</button>

			{/* 中间文字与状态徽标 */}
			<div className="flex items-center gap-2 min-w-0 flex-1 justify-center px-2 truncate">
				<span
					data-field="strip-title"
					title={middleText}
					className="font-mono text-[12px] font-medium text-[var(--ink-1)] truncate"
				>
					{middleText}
				</span>

				{/* 状态字形+文字 */}
				<StatusBadge state={isIdle ? 'queued' : status} className="shrink-0" />
			</div>

			{/* 右侧 ▶ 切换按钮：尺寸必须 ≥44×44px，disabled 不隐藏（AC 9, E-324） */}
			<button
				type="button"
				data-action="next-lane"
				disabled={!canNext}
				onClick={onNext}
				aria-label="查看下一泳道"
				className={`
					flex items-center justify-center w-[44px] h-[44px] min-w-[44px] min-h-[44px]
					rounded-[9px] text-[var(--ink-2)] hover:text-[var(--ink-1)] active:bg-[var(--panel-2)]
					focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--needs-soft)]
					${canNext ? 'cursor-pointer opacity-100' : 'cursor-not-allowed opacity-30'}
				`}
			>
				<span className="text-[16px] leading-none" aria-hidden="true">
					▶
				</span>
			</button>
		</div>
	);
}
