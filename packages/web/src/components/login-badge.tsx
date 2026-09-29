/**
 * packages/web/src/components/login-badge.tsx
 *
 * 登录态徽标组件（M9-T23 / AC 1, E-335, E-336, E-355, E-357）
 *
 * 规范依据：
 * - 纯展示层组件：纯 props in / callback out
 * - login === null 或 undefined 时不渲染任何 DOM
 * - 三态文案：已登录／未登录／无法判定，超 24 小时加「· 已过期」
 * - 主题：logged_out 暖色、其余无色；超 24 小时退成无色虚线边并加「· 已过期」，不用透明度
 * - 组件严禁出现 'logged_*' 状态字面量，统一使用 lib/login-freshness.ts
 * - 驱动「N 分钟前探测」依赖 useMinuteTick()
 */

import type { LoginState } from '@agent-scheduler/shared/api/agents';
import type { HTMLAttributes } from 'react';
import { useMinuteTick } from '../hooks/use-minute-tick.ts';
import {
	formatProbeTime,
	getLoginBadgeText,
	getLoginBadgeVariant,
} from '../lib/login-freshness.ts';

export interface LoginBadgeProps extends HTMLAttributes<HTMLSpanElement> {
	readonly login?: LoginState | null;
	/** 允许覆盖当前时间（单测用） */
	readonly now?: number;
}

export function LoginBadge({
	login,
	now: propNow,
	className = '',
	...rest
}: LoginBadgeProps) {
	const tickNow = useMinuteTick();
	const now = propNow ?? tickNow;

	if (!login) {
		return null;
	}

	const badgeText = getLoginBadgeText(login, now);
	const variant = getLoginBadgeVariant(login, now);
	const timeTitle = formatProbeTime(login.checkedAt, now);

	let variantClasses =
		'border-[var(--border)] text-[var(--ink-2)] bg-[var(--panel-2)]';
	if (variant === 'warm') {
		variantClasses =
			'border-[var(--needs)] text-[var(--needs)] bg-[var(--needs-soft)]';
	} else if (variant === 'expired') {
		// 已过期退成无色虚线边，不使用 opacity
		variantClasses =
			'border-dashed border-[var(--border-strong)] text-[var(--ink-3)] bg-transparent';
	}

	return (
		<span
			data-testid="login-badge"
			data-login-variant={variant}
			title={timeTitle}
			className={`inline-flex items-center justify-center px-1.5 h-[var(--badge-h-inline)] rounded-[4px] border font-mono text-[10.5px] leading-none select-none ${variantClasses} ${className}`}
			{...rest}
		>
			{badgeText}
		</span>
	);
}
