/**
 * packages/web/src/components/status-badge.tsx
 *
 * 状态徽标与字形图标组件（M9-T2 / E-110, E-172, E-230, E-231, E-232, E-233, E-234）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 徽标为矩形非药丸：height: 20px; border-radius: 6px; padding: 0 7px; font: 600 11px/1 var(--font-ui)（AC 6）
 * - 恒为「字形 + 文字」，颜色是第三层信息（AC 6）
 * - 12 个形状为单色描边内联 SVG，一律 currentColor，无颜色字面量（AC 1, E-231）
 * - 「失联」「审查未完成」「未识别／降级」各有专属形状，绝不复用 ✕（AC 2, E-230）
 * - 统一 viewBox="0 0 16 16" + vector-effect: non-scaling-stroke，DPR 缩放下不糊（AC 3, E-232）
 * - 每个形状带中文 aria-label，灰度打印下依靠形状本身完全区分（AC 4, E-233, E-110）
 * - 浅色深色模式逐一对应，不依赖发光或光晕（AC 4b, E-172）
 * - stopped 状态使用虚线边框（11 节与 AC 6）
 * - partial 状态使用 --warn / --needs 暖色，绝不绿（11 节）
 * - 纯 props in / callback out，禁止 import api/store/features/shell，禁止内部 useEffect（07 节）
 */

import type { CSSProperties, HTMLAttributes, SVGProps } from 'react';
import { type StatusState, getStatusShape, normalizeStatusState } from '../lib/spine-shape.ts';

/**
 * 状态徽标的主题色彩配置（全量引用 CSS 变量，绝无颜色字面量，E-170, E-231）。
 */
export interface StatusBadgeTheme {
	readonly bg: string;
	readonly text: string;
	readonly border: string;
	readonly borderStyle?: 'solid' | 'dashed';
}

export const STATUS_BADGE_THEMES: Readonly<Record<StatusState, StatusBadgeTheme>> = Object.freeze({
	queued: Object.freeze({
		bg: 'var(--panel-2)',
		text: 'var(--ink-3)',
		border: 'var(--border)',
		borderStyle: 'solid',
	}),
	thinking: Object.freeze({
		bg: 'var(--panel-2)',
		text: 'var(--ink-2)',
		border: 'var(--border)',
		borderStyle: 'solid',
	}),
	tool: Object.freeze({
		bg: 'var(--panel-2)',
		text: 'var(--ink-2)',
		border: 'var(--border)',
		borderStyle: 'solid',
	}),
	streaming: Object.freeze({
		bg: 'var(--panel-2)',
		text: 'var(--ink-2)',
		border: 'var(--border)',
		borderStyle: 'solid',
	}),
	awaiting_input: Object.freeze({
		bg: 'var(--needs-soft)',
		text: 'var(--needs-ink)',
		border: 'var(--needs)',
		borderStyle: 'solid',
	}),
	succeeded: Object.freeze({
		bg: 'var(--auto-soft)',
		text: 'var(--auto-ink)',
		border: 'var(--auto)',
		borderStyle: 'solid',
	}),
	partial: Object.freeze({
		bg: 'var(--needs-soft)',
		text: 'var(--needs-ink)',
		border: 'var(--needs)',
		borderStyle: 'solid',
	}),
	failed: Object.freeze({
		bg: 'var(--down-soft)',
		text: 'var(--down-ink)',
		border: 'var(--down)',
		borderStyle: 'solid',
	}),
	stopped: Object.freeze({
		bg: 'var(--panel-2)',
		text: 'var(--stopped)',
		border: 'var(--border-strong)',
		borderStyle: 'dashed',
	}),
	orphaned: Object.freeze({
		bg: 'var(--needs-soft)',
		text: 'var(--needs-ink)',
		border: 'var(--needs)',
		borderStyle: 'solid',
	}),
	review_incomplete: Object.freeze({
		bg: 'var(--needs-soft)',
		text: 'var(--needs-ink)',
		border: 'var(--needs)',
		borderStyle: 'solid',
	}),
	unrecognized: Object.freeze({
		bg: 'var(--panel-2)',
		text: 'var(--ink-3)',
		border: 'var(--border)',
		borderStyle: 'solid',
	}),
});

/**
 * 状态字形图标组件属性。
 */
export interface StatusIconProps extends SVGProps<SVGSVGElement> {
	/** 状态枚举（12 个标准状态之一，或合法别名/RunState） */
	readonly state: StatusState | string;
	/** 图标尺寸（默认 12px，适配 20px 徽标内部比例） */
	readonly size?: number;
	/** 是否对无障碍树隐藏（当外层已有 aria 说明时设为 true） */
	readonly ariaHidden?: boolean;
}

/**
 * 状态字形图标：渲染 12 态内联单色 SVG，一律 currentColor，带 vector-effect: non-scaling-stroke。
 */
export function StatusIcon({
	state,
	size = 12,
	ariaHidden = false,
	className,
	style,
	...rest
}: StatusIconProps) {
	const resolvedState = normalizeStatusState(state);
	const shape = getStatusShape(resolvedState);

	return (
		<svg
			viewBox={shape.viewBox}
			width={size}
			height={size}
			role={ariaHidden ? undefined : 'img'}
			aria-hidden={ariaHidden ? 'true' : undefined}
			aria-label={ariaHidden ? undefined : shape.ariaLabel}
			className={['inline-block shrink-0 overflow-visible align-middle', className]
				.filter(Boolean)
				.join(' ')}
			style={{
				vectorEffect: 'non-scaling-stroke',
				...style,
			}}
			fill="none"
			stroke="currentColor"
			{...rest}
		>
			{shape.elements.map((el, idx) => {
				const Tag = el.tag;
				return <Tag key={`${shape.id}-${idx}`} {...el.attrs} />;
			})}
		</svg>
	);
}

/**
 * 状态徽标组件属性。
 */
export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
	/** 状态枚举（12 个标准状态之一，或合法别名/RunState） */
	readonly state: StatusState | string;
	/** 自定义显示文案（可选；未提供时回退到状态默认文案） */
	readonly text?: string;
	/** 图标尺寸（默认 12px） */
	readonly iconSize?: number;
}

/**
 * 状态徽标：高度 20px、圆角 6px（矩形非药丸）、恒为「字形 + 文字」，颜色作为第三层信息。
 */
export function StatusBadge({
	state,
	text,
	iconSize = 12,
	className,
	style,
	...rest
}: StatusBadgeProps) {
	const resolvedState = normalizeStatusState(state);
	const shape = getStatusShape(resolvedState);
	const theme = STATUS_BADGE_THEMES[resolvedState];
	const displayText = text ?? shape.defaultText;
	const badgeAriaLabel = `${shape.ariaLabel} · ${displayText}`;

	const badgeStyle: CSSProperties = {
		backgroundColor: theme.bg,
		color: theme.text,
		borderColor: theme.border,
		borderStyle: theme.borderStyle ?? 'solid',
		borderWidth: '1px',
		...style,
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: badge is an inline status badge element, not a form output
		<span
			role="status"
			aria-label={badgeAriaLabel}
			data-state={resolvedState}
			data-shape={shape.id}
			className={[
				'inline-flex items-center gap-[5px] shrink-0 select-none align-middle',
				'h-[20px] rounded-[6px] px-[7px]',
				'font-ui font-semibold text-[11px] leading-none',
				theme.borderStyle === 'dashed' ? 'border-dashed' : 'border-solid',
				className,
			]
				.filter(Boolean)
				.join(' ')}
			style={badgeStyle}
			{...rest}
		>
			<StatusIcon state={resolvedState} size={iconSize} ariaHidden={true} />
			<span className="status-badge-text truncate">{displayText}</span>
		</span>
	);
}
