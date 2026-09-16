/**
 * packages/web/src/components/batch-summary-bar.tsx
 *
 * 批次汇总条组件（M9-T16 / AC 2, E-111, E-110）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 批次汇总条是四个数字 + 一条比例条，不得升格成饼图或环形图挤占运行流主位（AC 2, E-111）
 * - 四个数字固定为：进行中 / 待审批 / 已落地 / 失败（E-111）
 * - 紧凑高度（~44px），定位在批次流上方或左栏顶，绝不抢占实时运行流主视觉
 * - 状态区分不能只靠色相，必须同时具有专属形状字形或明确文字（E-110）
 * - 大数采用 Commit Mono 等宽字体（font-mono），UI 标签 Public Sans（font-ui）
 * - 所有颜色引用 tokens.css 的 CSS 变量，严禁硬编码颜色字面量（check-forbidden 机检）
 * - 纯展示组件（components 纯 props in / callback out），禁止内部副作用或取数
 */

import type { CSSProperties, HTMLAttributes } from 'react';
import { getStatusShape } from '../lib/spine-shape.ts';

export interface BatchSummaryCounts {
	/** 进行中的任务数（流处于运行、排队或思考阶段） */
	readonly running: number;
	/** 待人工确认/审批的任务数（人工闸门拦截） */
	readonly awaiting: number;
	/** 已验收/已落地的任务数 */
	readonly landed: number;
	/** 执行失败/异常退出的任务数 */
	readonly failed: number;
}

export interface BatchSummaryBarProps extends HTMLAttributes<HTMLDivElement> {
	/** 所属批次编号（例如 "batch-1" 或 "第 1 批"） */
	readonly batchId?: string;
	/** 批次友好显示名称 */
	readonly batchName?: string;
	/** 四项核心状态计数（AC 2, E-111） */
	readonly counts: BatchSummaryCounts;
	/** 总任务数（可选，未传时由四项计数之和派生） */
	readonly totalTasks?: number;
	/** 是否支持收口操作（收口闸门状态） */
	readonly canWrapUp?: boolean;
	/** 收口触发回调 */
	readonly onWrapUp?: () => void;
	/** 样式自定义类名 */
	readonly className?: string;
}

/**
 * 内联 SVG 状态形状渲染器（E-110 / E-231，无外部图标库依赖，单色 currentColor）。
 */
function SummaryGlyph({
	status,
}: { status: 'streaming' | 'awaiting_input' | 'succeeded' | 'failed' }) {
	const shape = getStatusShape(status);
	return (
		<svg
			viewBox={shape.viewBox}
			aria-hidden="true"
			className="h-3.5 w-3.5 flex-shrink-0 text-current"
			style={{ vectorEffect: 'non-scaling-stroke' }}
		>
			{shape.elements.map((spec, idx) => {
				const key = `${spec.tag}-${idx}`;
				switch (spec.tag) {
					case 'path':
						return <path key={key} {...spec.attrs} />;
					case 'rect':
						return <rect key={key} {...spec.attrs} />;
					case 'circle':
						return <circle key={key} {...spec.attrs} />;
					case 'line':
						return <line key={key} {...spec.attrs} />;
					case 'polyline':
						return <polyline key={key} {...spec.attrs} />;
					case 'polygon':
						return <polygon key={key} {...spec.attrs} />;
					default:
						return null;
				}
			})}
		</svg>
	);
}

export function BatchSummaryBar({
	batchId,
	batchName,
	counts,
	totalTasks: explicitTotal,
	canWrapUp = false,
	onWrapUp,
	className = '',
	...rest
}: BatchSummaryBarProps) {
	const running = Math.max(0, counts?.running ?? 0);
	const awaiting = Math.max(0, counts?.awaiting ?? 0);
	const landed = Math.max(0, counts?.landed ?? 0);
	const failed = Math.max(0, counts?.failed ?? 0);

	const sum = running + awaiting + landed + failed;
	const total = explicitTotal !== undefined && explicitTotal > sum ? explicitTotal : sum;

	// 计算比例条各段百分比（总和等于 100%）
	const landedPercent = total > 0 ? (landed / total) * 100 : 0;
	const runningPercent = total > 0 ? (running / total) * 100 : 0;
	const awaitingPercent = total > 0 ? (awaiting / total) * 100 : 0;
	const failedPercent = total > 0 ? (failed / total) * 100 : 0;

	return (
		<section
			data-testid="batch-summary-bar"
			data-batch-id={batchId}
			aria-label={`批次汇总状态${batchName ? `: ${batchName}` : ''}`}
			className={[
				'flex flex-col gap-2 rounded border border-border bg-bg px-3 py-2 text-ink-1 font-ui select-none',
				className,
			].join(' ')}
			{...rest}
		>
			{/* 顶行：批次标题 + 四个数字指标 + 可选收口操作（AC 2 / E-111 / E-110） */}
			<div className="flex flex-wrap items-center justify-between gap-3 text-meta">
				{/* 批次标识 */}
				{batchName && (
					<div className="flex items-center gap-1.5 font-semibold text-ink-1">
						<span className="font-mono text-dense text-ink-2">{batchName}</span>
						{total > 0 && <span className="font-mono text-micro text-ink-3">(共 {total} 项)</span>}
					</div>
				)}

				{/* 四个核心数字（AC 2: 进行中 / 待审批 / 已落地 / 失败） */}
				<div
					data-testid="batch-summary-counts"
					className="flex items-center gap-3 sm:gap-4 ml-auto"
				>
					{/* 1. 进行中 */}
					<div
						data-stat="running"
						title={`进行中: ${running} 个`}
						className="flex items-center gap-1 text-ink-1"
					>
						<SummaryGlyph status="streaming" />
						<span className="text-micro text-ink-2">进行中</span>
						<span className="font-mono font-semibold text-dense text-ink-1">{running}</span>
					</div>

					{/* 2. 待审批 */}
					<div
						data-stat="awaiting"
						title={`待审批: ${awaiting} 个`}
						className="flex items-center gap-1 text-needs"
					>
						<SummaryGlyph status="awaiting_input" />
						<span className="text-micro text-needs">待审批</span>
						<span className="font-mono font-semibold text-dense text-needs">{awaiting}</span>
					</div>

					{/* 3. 已落地 */}
					<div
						data-stat="landed"
						title={`已落地: ${landed} 个`}
						className="flex items-center gap-1 text-auto"
					>
						<SummaryGlyph status="succeeded" />
						<span className="text-micro text-auto">已落地</span>
						<span className="font-mono font-semibold text-dense text-auto">{landed}</span>
					</div>

					{/* 4. 失败 */}
					<div
						data-stat="failed"
						title={`失败: ${failed} 个`}
						className="flex items-center gap-1 text-down"
					>
						<SummaryGlyph status="failed" />
						<span className="text-micro text-down">失败</span>
						<span className="font-mono font-semibold text-dense text-down">{failed}</span>
					</div>
				</div>

				{/* 批次收口快捷入口 */}
				{canWrapUp && (
					<button
						type="button"
						data-action="wrapup"
						onClick={onWrapUp}
						className="h-btn-sm px-2.5 rounded-sm bg-needs text-on-needs text-micro font-semibold transition-colors hover:brightness-105 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--needs-soft)]"
					>
						批次收口
					</button>
				)}
			</div>

			{/* 底行：一条比例条，不得升格成饼图或环形图挤占运行流主位（AC 2, E-111） */}
			<div
				data-testid="batch-proportional-bar"
				role="progressbar"
				tabIndex={0}
				aria-valuenow={landed}
				aria-valuemin={0}
				aria-valuemax={total}
				aria-label={`批次进度比例: 已落地 ${landed} / ${total}`}
				className="relative h-1.5 w-full overflow-hidden rounded-pill bg-panel-2 border border-border flex"
			>
				{/* 已落地比例 (绿色 --auto) */}
				{landedPercent > 0 && (
					<div
						data-bar-segment="landed"
						title={`已落地 ${landedPercent.toFixed(1)}%`}
						style={{ width: `${landedPercent}%` } as CSSProperties}
						className="h-full bg-auto transition-all duration-DEFAULT"
					/>
				)}

				{/* 进行中比例 (机器活跃 --ink-1) */}
				{runningPercent > 0 && (
					<div
						data-bar-segment="running"
						title={`进行中 ${runningPercent.toFixed(1)}%`}
						style={{ width: `${runningPercent}%` } as CSSProperties}
						className="h-full bg-ink-1 transition-all duration-DEFAULT"
					/>
				)}

				{/* 待审批比例 (暖色 --needs) */}
				{awaitingPercent > 0 && (
					<div
						data-bar-segment="awaiting"
						title={`待审批 ${awaitingPercent.toFixed(1)}%`}
						style={{ width: `${awaitingPercent}%` } as CSSProperties}
						className="h-full bg-needs transition-all duration-DEFAULT"
					/>
				)}

				{/* 失败比例 (红色 --down) */}
				{failedPercent > 0 && (
					<div
						data-bar-segment="failed"
						title={`失败 ${failedPercent.toFixed(1)}%`}
						style={{ width: `${failedPercent}%` } as CSSProperties}
						className="h-full bg-down transition-all duration-DEFAULT"
					/>
				)}

				{/* 全空态占位 */}
				{total === 0 && <div data-bar-segment="empty" className="h-full w-full bg-panel-2" />}
			</div>
		</section>
	);
}

export default BatchSummaryBar;
