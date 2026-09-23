/**
 * packages/web/src/components/pulse-dot.tsx
 *
 * 呼吸灯与等待点展示组件（M9-T19 / AC 3, E-282）
 *
 * 规范依据（07 节前端架构与 11 节 UI）：
 * - 纯 props 展示层组件：不直接 import api/store/features/shell
 * - spine 运行轨当前步与批次树执行行均 import 这一个组件（E-282）
 * - 8px 圆点，live 外加 ::after 呼吸环（1.6s 周期，共用 @keyframes agsched-pulse 与 --pulse）
 * - waiting 态为 8px 静态暖点（var(--needs)），无动画
 * - prefers-reduced-motion 下呼吸环冻结在中间不透明度（在 base.css 中声明）
 * - 本文件禁止出现 animation: 样式属性（check-forbidden 机检禁令）
 */

import type { HTMLAttributes, ReactNode } from 'react';

export interface PulseDotProps extends HTMLAttributes<HTMLElement> {
	/** 呼吸点形态：live（在跑呼吸点）或 waiting（静态暖点） */
	readonly variant: 'live' | 'waiting';
	/** 无障碍提示文本（默认根据 variant 自动生成） */
	readonly label?: string;
	/** 外部自定义类名 */
	readonly className?: string;
	/** 是否在 SVG 视口内绘制（用于 spine 运行轨嵌入） */
	readonly asSvg?: boolean;
	/** SVG 视口中心 x 坐标 */
	readonly cx?: number;
	/** SVG 视口中心 y 坐标 */
	readonly cy?: number;
	/** SVG 模式下内嵌的步骤形状或圆点 */
	readonly innerNode?: ReactNode;
}

/**
 * 呼吸灯组件（展示层纯 props 组件）。
 */
export function PulseDot({
	variant,
	label,
	className = '',
	asSvg = false,
	cx,
	cy,
	innerNode,
	...rest
}: PulseDotProps) {
	const defaultLabel = variant === 'live' ? '正在执行' : '等待处理';
	const ariaLabel = label ?? defaultLabel;

	// ─── SVG 视口绘制分支（供 spine.tsx 使用） ───
	if (asSvg || (cx !== undefined && cy !== undefined)) {
		const centerX = cx ?? 11;
		const centerY = cy ?? 15;

		if (variant === 'waiting') {
			return (
				<g data-pulse-dot="waiting" aria-label={ariaLabel}>
					<rect
						data-spine-node="waiting-square"
						x={centerX - 4.5}
						y={centerY - 4.5}
						width={9}
						height={9}
						fill="none"
						stroke="var(--spine-needs)"
						strokeWidth={1.5}
						style={{ vectorEffect: 'non-scaling-stroke' }}
					/>
					{innerNode}
				</g>
			);
		}

		return (
			<g data-spine-node="pulse-live" data-pulse-dot="live" aria-label={ariaLabel}>
				{/* 1.6s 呼吸外环，消费 base.css 中的 agsched-pulse-ring 与 --pulse (R2, 11 节) */}
				<circle
					cx={centerX}
					cy={centerY}
					r={7}
					data-pulse="1.6s"
					data-pulse-var="var(--pulse, 1.6s)"
					className="agsched-pulse-ring"
					fill="var(--auto-soft)"
					stroke="var(--auto)"
					strokeWidth={1}
					style={{
						vectorEffect: 'non-scaling-stroke',
						transformOrigin: `${centerX}px ${centerY}px`,
					}}
				/>
				{innerNode ?? (
					<circle
						cx={centerX}
						cy={centerY}
						r={4}
						fill="var(--auto)"
						style={{ vectorEffect: 'non-scaling-stroke' }}
					/>
				)}
			</g>
		);
	}

	// ─── 标准 HTML DOM 绘制分支（供 batch-tree.tsx 使用） ───
	return (
		<span
			data-pulse-dot={variant}
			role="status"
			aria-label={ariaLabel}
			className={[
				'pulse-dot',
				variant === 'live' ? 'pulse-dot-live' : 'pulse-dot-waiting',
				className,
			]
				.filter(Boolean)
				.join(' ')}
			{...rest}
		/>
	);
}

export default PulseDot;
