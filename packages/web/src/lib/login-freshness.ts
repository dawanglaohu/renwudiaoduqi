/**
 * packages/web/src/lib/login-freshness.ts
 *
 * 登录态状态谓词、新鲜度判定与探测时间格式化纯函数（M9-T23 / AC 1, AC 5, E-335, E-355, E-357）
 *
 * 规范依据（07 节前端架构 lib 规范）：
 * - 纯函数：同输入同输出，不 import React，不 import src 下除 lib 外任何目录
 * - 状态谓词统一由本文件导出，组件层严禁直接书写 'logged_*' 状态字面量
 * - 单测覆盖时钟回拨与 24 小时过期边界（E-335、E-357）
 */

import type { LoginState } from '@agent-scheduler/shared/api/agents';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

/**
 * 判定 agent 是否处于已登录状态。
 */
export function isLoggedIn(login?: LoginState | null): boolean {
	return login?.state === 'logged_in';
}

/**
 * 判定 agent 是否处于未登录状态。
 */
export function isLoggedOut(login?: LoginState | null): boolean {
	return login?.state === 'logged_out';
}

/**
 * 判定 agent 登录态是否未知/无法判定。
 */
export function isLoginUnknown(login?: LoginState | null): boolean {
	return login?.state === 'unknown';
}

/**
 * 判定探测时间是否已经超过 24 小时（过期）。
 * 时钟回拨（checkedAt 晚于当前时间）不判为过期。
 */
export function isLoginExpired(checkedAt: string | null | undefined, now = Date.now()): boolean {
	if (!checkedAt) {
		return false;
	}
	const timestamp = new Date(checkedAt).getTime();
	if (Number.isNaN(timestamp)) {
		return false;
	}
	// 时钟回拨：checkedAt 在未来，不认为过期
	if (timestamp > now) {
		return false;
	}
	return now - timestamp >= TWENTY_FOUR_HOURS_MS;
}

/**
 * 格式化探测时间（E-335, E-357）。
 * - 缺失返回 '—'
 * - 时钟回拨或在 1 分钟之内返回 '刚刚'
 * - 否则返回 'N 分钟前探测'
 */
export function formatProbeTime(checkedAt: string | null | undefined, now = Date.now()): string {
	if (!checkedAt) {
		return '—';
	}
	const timestamp = new Date(checkedAt).getTime();
	if (Number.isNaN(timestamp)) {
		return '—';
	}
	// 时钟回拨
	if (timestamp > now) {
		return '刚刚';
	}
	const diffMs = now - timestamp;
	const diffMinutes = Math.floor(diffMs / ONE_MINUTE_MS);
	if (diffMinutes <= 0) {
		return '刚刚';
	}
	return `${diffMinutes} 分钟前探测`;
}

/**
 * 徽标文案计算。
 * 徽标 login === null / undefined 时不显示。
 * 三态文案：已登录／未登录／无法判定；若过期追加「 · 已过期」。
 */
export function getLoginBadgeText(login: LoginState | null | undefined, now = Date.now()): string | null {
	if (!login) {
		return null;
	}
	let label: string;
	if (isLoggedIn(login)) {
		label = '已登录';
	} else if (isLoggedOut(login)) {
		label = '未登录';
	} else {
		label = '无法判定';
	}

	if (isLoginExpired(login.checkedAt, now)) {
		return `${label} · 已过期`;
	}
	return label;
}

export type LoginBadgeVariant = 'warm' | 'neutral' | 'expired';

/**
 * 徽标主题变体（logged_out 暖色，其余无色，超 24 小时退成无色虚线边框 expired）。
 */
export function getLoginBadgeVariant(
	login: LoginState | null | undefined,
	now = Date.now(),
): LoginBadgeVariant {
	if (!login) {
		return 'neutral';
	}
	if (isLoginExpired(login.checkedAt, now)) {
		return 'expired';
	}
	if (isLoggedOut(login)) {
		return 'warm';
	}
	return 'neutral';
}
