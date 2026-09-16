/**
 * packages/web/src/components/spine.tsx
 *
 * 运行轨组件（M9-T7 / AC 1, AC 2, AC 6, E-110, E-230）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 纯 props in / callback out，禁止 import api/store/features/shell，内部不允许知道 runId（07 节）
 * - 运行轨贯穿整栏全高含未来步骤的虚线段，只画到当前步即判不合格（AC 1）
 * - 六种轨段形态（实线／心跳点／虚线／空心方块＋整段转暖／平头截断／半调虚线＋横杠）各自可见且形状先于颜色（AC 2）
 * - 轨列宽度 20px，轨中心线 x=11px（--spine-x: 11px），线宽 2px（--spine-w: 2px）（11 节）
 * - 呼吸环是全页唯一的连续动画种类，只动 opacity 与 scale（AC 2, 11 节）
 * - 轨段形态与状态徽标共用同一张形状枚举（lib/spine-shape.ts），状态区分不只靠色相（E-110）
 * - 「失联」「审查未完成」「未识别/降级」各有专属形状而非复用失败形状（E-230）
 * - 轨不测量 DOM：禁止 getBoundingClientRect / offsetHeight / ResizeObserver（07 节架构禁令）
 * - 支持返工回环片段（loop: above / below / hook），按行拆成片段画在 20px 轨列内（07 节）
 * - 支持 stage 节点（12px）与 step 节点（8px）（level 字段）
 */

import type { HTMLAttributes } from 'react';
import {
	STATUS_SHAPES,
	STEP_SHAPES,
	type StatusState,
	type StepType,
	getStatusShape,
	normalizeStatusState,
} from '../lib/spine-shape.ts';

/**
 * 运行轨的六种轨段形态枚举（AC 2, 11 节）。
 */
export type SpineSegmentKind =
	| 'done' // 已完成实线
	| 'live' // 当前步实心点 + 1.6s 呼吸环
	| 'pending' // 未执行虚线
	| 'waiting' // 等你：空心方块 9px + 当前点以下整段转暖
	| 'failed' // 失败：平头截断 4px 横向端帽
	| 'stopped'; // 已停止：半调虚线 + 10px 横杠

/**
 * 节点尺寸级别（07 节）：
 * stage 为阶段大节点（12px），step 为运行流步骤小节点（8px）。
 */
export type SpineSegmentLevel = 'stage' | 'step';

/**
 * 回环片段配置（07 节）。
 * 返工回环按行拆成片段画在 20px 轨列内，不占文字列，不跨行绝对定位。
 */
export interface SpineLoopPiece {
	readonly above?: boolean;
	readonly below?: boolean;
	readonly hook?: boolean;
}

/**
 * 单个运行轨片段数据结构（07 节）。
 */
export interface SpineSegment {
	/** 步骤或节点唯一标识 */
	readonly id?: string | number;
	/** 轨段形态（对应六种形态） */
	readonly kind: SpineSegmentKind;
	/** 节点形状 id（可为 12 状态之一或 6 步骤类型之一） */
	readonly shape?: StatusState | StepType | string;
	/** 节点尺寸档位（默认 'step'） */
	readonly level?: SpineSegmentLevel;
	/** 是否携带返工回环片段 */
	readonly loop?: SpineLoopPiece;
	/** 无障碍标签文案 */
	readonly label?: string;
	/** 是否为第一个节点（默认 false） */
	readonly isFirst?: boolean;
	/** 是否为最后一个节点（默认 false） */
	readonly isLast?: boolean;
	/** 是否处于等待/等你导致的暖色继承区间 */
	readonly isWarm?: boolean;
}

/**
 * 单轨段视图属性。
 */
export interface SpineSegmentViewProps extends HTMLAttributes<HTMLDivElement> {
	/** 轨段数据 */
	readonly segment: SpineSegment;
	/** 行高度（默认折叠 30px，触摸档 44px） */
	readonly rowHeight?: number;
	/** 是否为触摸档（默认 false） */
	readonly isTouch?: boolean;
	/** 容器或上下文是否已处于整段转暖状态（用于等你态以下整段转暖） */
	readonly isWarmContext?: boolean;
}

/**
 * 运行轨整栏全高组件属性（AC 1）。
 */
export interface SpineProps extends HTMLAttributes<HTMLDivElement> {
	/** 全部轨段列表 */
	readonly segments: readonly SpineSegment[];
	/** 是否为触摸档 */
	readonly isTouch?: boolean;
	/** 是否显示贯穿整栏全高的尾部未来步骤虚线段（默认 true，AC 1 硬指标） */
	readonly showTrailingFuture?: boolean;
	/** 外部自定义类名 */
	readonly className?: string;
}

/**
 * 在 20px 宽度内回环片段（LOOP_PIECES）的 SVG 绘制。
 * viewBox 0 0 20 16, preserveAspectRatio="none", currentColor + non-scaling-stroke
 * 着色使用 var(--spine-done)，无动画（07 节约束）。
 */
function renderLoopPieces(loop: SpineLoopPiece | undefined, height: number) {
	if (!loop || (!loop.above && !loop.below && !loop.hook)) {
		return null;
	}

	const centerY = height / 2;
	const loopX = 4.5;
	const spineX = 11;

	return (
		<g
			className="spine-loop"
			stroke="var(--spine-done)"
			strokeWidth={1.25}
			fill="none"
			style={{ vectorEffect: 'non-scaling-stroke' }}
		>
			{/* above: 上半截垂线从顶端到中心 */}
			{loop.above && <line x1={loopX} y1={0} x2={loopX} y2={centerY} />}
			{/* below: 下半截垂线从中心到底部 */}
			{loop.below && <line x1={loopX} y1={centerY} x2={loopX} y2={height} />}
			{/* hook: 从回环垂线勾向轨中心线 x=11 */}
			{loop.hook && (
				<path
					d={`M ${loopX} ${centerY} C ${loopX + 2} ${centerY} ${spineX - 2} ${centerY} ${spineX} ${centerY}`}
				/>
			)}
		</g>
	);
}

/**
 * 绘制特定状态或步骤的几何形状节点（E-110, E-230, AC 6）。
 * 形状先于颜色，绝不只靠色相区分。
 */
function renderShapeNode(
	shapeId: StatusState | StepType | string | undefined,
	kind: SpineSegmentKind,
	level: SpineSegmentLevel,
	centerX: number,
	centerY: number,
	isWarm: boolean,
) {
	const nodeSize = level === 'stage' ? 12 : 8;
	const halfSize = nodeSize / 2;

	// 1. 若指定了专属字形（E-110, E-230, AC 6）：
	// 「失联」「审查未完成」「未识别/降级」等态各有专属形状而非复用失败形状
	// 当传入具体形状且非纯 awaiting_input / waiting 时，优先渲染其专属几何形状
	if (shapeId && shapeId !== 'awaiting_input' && shapeId !== 'waiting') {
		const normState = normalizeStatusState(shapeId);
		const isRegisteredState = normState in STATUS_SHAPES && normState !== 'unrecognized';
		const shapeDef = isRegisteredState
			? getStatusShape(normState)
			: (STEP_SHAPES[shapeId as StepType] ?? getStatusShape(normState));

		const strokeColor =
			isWarm || kind === 'waiting'
				? 'var(--spine-needs)'
				: kind === 'done'
					? 'var(--spine-done)'
					: kind === 'pending'
						? 'var(--spine-pending)'
						: kind === 'failed'
							? 'var(--down)'
							: kind === 'stopped'
								? 'var(--stopped)'
								: 'currentColor';

		return (
			<svg
				x={centerX - halfSize}
				y={centerY - halfSize}
				width={nodeSize}
				height={nodeSize}
				viewBox={shapeDef.viewBox}
				data-shape={shapeDef.id}
				data-spine-node={shapeDef.id}
				aria-hidden="true"
				fill="none"
				stroke={strokeColor}
				style={{
					color: strokeColor,
					vectorEffect: 'non-scaling-stroke',
					overflow: 'visible',
				}}
			>
				{shapeDef.elements.map((el, idx) => {
					const Tag = el.tag;
					return <Tag key={`${shapeDef.id}-${idx}`} {...el.attrs} />;
				})}
			</svg>
		);
	}

	// 2. 等你（waiting）：当前点变空心方块 9px（AC 2, 11 节）
	if (kind === 'waiting') {
		const boxSize = 9;
		const offset = boxSize / 2;
		return (
			<rect
				data-spine-node="waiting-square"
				x={centerX - offset}
				y={centerY - offset}
				width={boxSize}
				height={boxSize}
				rx={1.5}
				fill="none"
				stroke="var(--spine-needs)"
				strokeWidth={1.75}
				style={{ vectorEffect: 'non-scaling-stroke' }}
			/>
		);
	}

	// 3. 当前步心跳点（live）：实心圆点 8px + 1.6s 呼吸环（AC 2, 11 节）
	if (kind === 'live') {
		return (
			<g data-spine-node="pulse-live">
				{/* 呼吸外环（全页唯一连续动画类，只动 opacity 与 scale） */}
				<circle
					cx={centerX}
					cy={centerY}
					r={7}
					className="animate-pulse"
					fill="var(--auto-soft)"
					stroke="var(--auto)"
					strokeWidth={1}
					style={{
						vectorEffect: 'non-scaling-stroke',
						transformOrigin: `${centerX}px ${centerY}px`,
					}}
				/>
				{/* 实心中心圆点 8px（半径 4px） */}
				<circle
					cx={centerX}
					cy={centerY}
					r={4}
					fill="var(--auto)"
					style={{ vectorEffect: 'non-scaling-stroke' }}
				/>
			</g>
		);
	}

	// 4. 已停止（stopped）：水平横杠 ▬（AC 2, 11 节）
	if (kind === 'stopped') {
		return (
			<rect
				data-spine-node="stopped-bar"
				x={centerX - 5}
				y={centerY - 1.5}
				width={10}
				height={3}
				rx={1}
				fill="var(--stopped)"
				style={{ vectorEffect: 'non-scaling-stroke' }}
			/>
		);
	}

	// 5. 失败（failed）：对角叉号 ✕（AC 2, 11 节）
	if (kind === 'failed') {
		const crossOffset = 4;
		return (
			<g
				data-spine-node="failed-cross"
				stroke="var(--down)"
				strokeWidth={1.75}
				strokeLinecap="round"
				style={{ vectorEffect: 'non-scaling-stroke' }}
			>
				<line
					x1={centerX - crossOffset}
					y1={centerY - crossOffset}
					x2={centerX + crossOffset}
					y2={centerY + crossOffset}
				/>
				<line
					x1={centerX + crossOffset}
					y1={centerY - crossOffset}
					x2={centerX - crossOffset}
					y2={centerY + crossOffset}
				/>
			</g>
		);
	}

	// 6. 默认回退圆点（done 或 pending）
	if (kind === 'done') {
		return (
			<circle
				data-spine-node="done-dot"
				cx={centerX}
				cy={centerY}
				r={3}
				fill="var(--spine-done)"
				style={{ vectorEffect: 'non-scaling-stroke' }}
			/>
		);
	}

	// pending 默认空心点
	return (
		<circle
			data-spine-node="pending-dot"
			cx={centerX}
			cy={centerY}
			r={2.5}
			fill="none"
			stroke={isWarm ? 'var(--spine-needs)' : 'var(--spine-pending)'}
			strokeWidth={1.25}
			style={{ vectorEffect: 'non-scaling-stroke' }}
		/>
	);
}

/**
 * 单个运行轨片段视图组件（可嵌入 stream-row 或阶段行中，首尾相接连通整轨）。
 */
export function SpineSegmentView({
	segment,
	rowHeight,
	isTouch = false,
	isWarmContext = false,
	className,
	style,
	...rest
}: SpineSegmentViewProps) {
	const height = rowHeight ?? (isTouch ? 44 : 30);
	const centerY = height / 2;
	const spineX = 11; // 11 节约定：中心线位于 x=11px（20px 网格偏右 1px）
	const spineWidth = 2; // --spine-w: 2px

	const isWarm = segment.isWarm || isWarmContext || segment.kind === 'waiting';

	// 上半段线色彩与虚实
	let topStroke = 'var(--spine-done)';
	let topDasharray: string | undefined;
	if (segment.kind === 'pending') {
		topStroke = isWarm ? 'var(--spine-needs)' : 'var(--spine-pending)';
		topDasharray = '3 3';
	} else if (segment.kind === 'stopped') {
		topStroke = 'var(--stopped)';
		topDasharray = '2 2';
	} else if (isWarmContext) {
		topStroke = 'var(--spine-needs)';
	}

	// 下半段线色彩与虚实
	let bottomStroke = 'var(--spine-done)';
	let bottomDasharray: string | undefined;
	let renderBottomLine = true;

	if (segment.kind === 'live') {
		// 当前步向下一步为未执行虚线
		bottomStroke = 'var(--spine-pending)';
		bottomDasharray = '3 3';
	} else if (segment.kind === 'pending') {
		bottomStroke = isWarm ? 'var(--spine-needs)' : 'var(--spine-pending)';
		bottomDasharray = '3 3';
	} else if (segment.kind === 'waiting') {
		// 等你：当前点以下整段轨转暖色（AC 2）
		bottomStroke = 'var(--spine-needs)';
		bottomDasharray = '3 3';
	} else if (segment.kind === 'failed') {
		// 失败：轨在此平头截断，不再向下延伸（AC 2）
		renderBottomLine = false;
	} else if (segment.kind === 'stopped') {
		// 已停止：半调虚线 + 10px 横杠后截断
		renderBottomLine = false;
	} else if (isWarm) {
		bottomStroke = 'var(--spine-needs)';
	}

	return (
		<div
			role="presentation"
			aria-hidden="true"
			data-kind={segment.kind}
			data-level={segment.level ?? 'step'}
			data-warm={isWarm ? 'true' : 'false'}
			className={['relative w-[20px] shrink-0 select-none overflow-visible', className]
				.filter(Boolean)
				.join(' ')}
			style={{
				height: `${height}px`,
				...style,
			}}
			{...rest}
		>
			<svg
				viewBox={`0 0 20 ${height}`}
				width={20}
				height={height}
				aria-hidden="true"
				className="w-full h-full block overflow-visible"
				style={{ vectorEffect: 'non-scaling-stroke' }}
			>
				{/* 1. 返工回环片段（07 节） */}
				{renderLoopPieces(segment.loop, height)}

				{/* 2. 上半段竖线（非第一项且无上方截断） */}
				{!segment.isFirst && (
					<line
						x1={spineX}
						y1={0}
						x2={spineX}
						y2={centerY}
						stroke={topStroke}
						strokeWidth={spineWidth}
						strokeDasharray={topDasharray}
						style={{ vectorEffect: 'non-scaling-stroke' }}
					/>
				)}

				{/* 3. 下半段竖线 */}
				{renderBottomLine && (
					<line
						x1={spineX}
						y1={centerY}
						x2={spineX}
						y2={height}
						stroke={bottomStroke}
						strokeWidth={spineWidth}
						strokeDasharray={bottomDasharray}
						style={{ vectorEffect: 'non-scaling-stroke' }}
					/>
				)}

				{/* 4. 失败：平头截断 4px 横向端帽（AC 2, 11 节） */}
				{segment.kind === 'failed' && (
					<g data-spine-cap="flat-truncation">
						<line
							x1={spineX}
							y1={centerY}
							x2={spineX}
							y2={centerY + 6}
							stroke="var(--down)"
							strokeWidth={spineWidth}
							style={{ vectorEffect: 'non-scaling-stroke' }}
						/>
						{/* 4px 横向端帽（从 x=9 到 x=13，宽 4px） */}
						<line
							x1={spineX - 2}
							y1={centerY + 6}
							x2={spineX + 2}
							y2={centerY + 6}
							stroke="var(--down)"
							strokeWidth={2}
							strokeLinecap="square"
							style={{ vectorEffect: 'non-scaling-stroke' }}
						/>
					</g>
				)}

				{/* 5. 已停止：半调虚线 + 10px 横杠（AC 2, 11 节） */}
				{segment.kind === 'stopped' && (
					<g data-spine-cap="stopped-bar">
						<line
							x1={spineX}
							y1={centerY}
							x2={spineX}
							y2={centerY + 6}
							stroke="var(--stopped)"
							strokeWidth={spineWidth}
							strokeDasharray="2 2"
							opacity={0.65}
							style={{ vectorEffect: 'non-scaling-stroke' }}
						/>
						{/* 10px 横杠（从 x=6 到 x=16，宽 10px） */}
						<line
							x1={spineX - 5}
							y1={centerY + 6}
							x2={spineX + 5}
							y2={centerY + 6}
							stroke="var(--stopped)"
							strokeWidth={2.5}
							strokeLinecap="round"
							style={{ vectorEffect: 'non-scaling-stroke' }}
						/>
					</g>
				)}

				{/* 6. 节点几何形状 */}
				{renderShapeNode(
					segment.shape,
					segment.kind,
					segment.level ?? 'step',
					spineX,
					centerY,
					isWarm,
				)}
			</svg>
		</div>
	);
}

/**
 * 运行轨主组件（AC 1, AC 2）。
 * 必须贯穿整栏全高（含未来步骤的虚线段，只画到当前步即判不合格）。
 */
export function Spine({
	segments,
	isTouch = false,
	showTrailingFuture = true,
	className,
	style,
	...rest
}: SpineProps) {
	// 判断整条轨是否在某一步转入了「等你（waiting）」
	let isWarm = false;
	let isTerminated = false;

	const segmentViews = segments.map((seg, idx) => {
		if (seg.kind === 'waiting') {
			isWarm = true;
		}
		const segView = (
			<SpineSegmentView
				key={seg.id ?? `seg-${idx}`}
				segment={{
					...seg,
					isFirst: idx === 0,
					isLast: idx === segments.length - 1,
					isWarm: isWarm || seg.isWarm,
				}}
				isTouch={isTouch}
				isWarmContext={isWarm}
			/>
		);
		if (seg.kind === 'failed' || seg.kind === 'stopped') {
			isTerminated = true;
		}
		return segView;
	});

	// 若整个流程未处于失败或停止终态，且启用了 showTrailingFuture：
	// 尾部渲染自适应贯穿全高的未来虚线段（AC 1 硬指标：只画到当前步即判不合格）
	const showFutureTail = showTrailingFuture && !isTerminated;

	return (
		<div
			role="presentation"
			aria-hidden="true"
			data-spine-root="true"
			data-warm={isWarm ? 'true' : 'false'}
			className={[
				'relative flex flex-col items-center w-[20px] h-full min-h-full shrink-0 select-none overflow-visible',
				className,
			]
				.filter(Boolean)
				.join(' ')}
			style={style}
			{...rest}
		>
			{/* 各步骤轨段 */}
			{segmentViews}

			{/* 尾部贯穿全高的虚线段（填充容器剩余高度） */}
			{showFutureTail && (
				<div
					data-spine-tail="future"
					className="w-[20px] flex-1 min-h-[30px] relative overflow-visible"
				>
					<svg
						className="w-full h-full block overflow-visible"
						preserveAspectRatio="none"
						viewBox="0 0 20 100"
						aria-hidden="true"
						style={{ vectorEffect: 'non-scaling-stroke' }}
					>
						<line
							x1={11}
							y1={0}
							x2={11}
							y2="100"
							stroke={isWarm ? 'var(--spine-needs)' : 'var(--spine-pending)'}
							strokeWidth={2}
							strokeDasharray="3 3"
							style={{ vectorEffect: 'non-scaling-stroke' }}
						/>
					</svg>
				</div>
			)}
		</div>
	);
}
