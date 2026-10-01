/**
 * packages/web/src/hooks/use-minute-tick.ts
 *
 * 模块级 60 秒时钟 Tick 驱动 Hook（M9-T23 / AC 5, E-335, E-357）
 *
 * 规范依据（07 节前端架构与 E-357）：
 * - 模块级 setInterval(60_000) + useSyncExternalStore
 * - 无订阅者不起（listeners 为空时自动 clearInterval）
 * - 绝对不 import src/api
 * - getSnapshot 稳定返回数字时间戳
 */

import { useSyncExternalStore } from 'react';

const TICK_INTERVAL_MS = 60_000;

let currentTick: number = Date.now();
let intervalTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function startTimerIfNeeded(): void {
	if (intervalTimer === null && listeners.size > 0) {
		intervalTimer = setInterval(() => {
			currentTick = Date.now();
			for (const listener of listeners) {
				try {
					listener();
				} catch {
					// 忽略监听器异常
				}
			}
		}, TICK_INTERVAL_MS);
	}
}

function stopTimerIfIdle(): void {
	if (listeners.size === 0 && intervalTimer !== null) {
		clearInterval(intervalTimer);
		intervalTimer = null;
	}
}

/**
 * 订阅时钟 Tick 变化。
 */
export function subscribeMinuteTick(listener: () => void): () => void {
	listeners.add(listener);
	startTimerIfNeeded();
	return () => {
		listeners.delete(listener);
		stopTimerIfIdle();
	};
}

/**
 * 获取当前 Tick 时间戳快照。
 */
export function getMinuteTickSnapshot(): number {
	return currentTick;
}

/**
 * 测试/调试辅助：手动触发 Tick 并设置当前时间。
 */
export function _advanceTickForTesting(newTime: number = Date.now()): void {
	currentTick = newTime;
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			// 忽略
		}
	}
}

/**
 * 测试/调试辅助：检查定时器是否处于激活状态及活跃监听器数量。
 */
export function _getTimerStatusForTesting(): {
	readonly isTimerRunning: boolean;
	readonly listenerCount: number;
} {
	return {
		isTimerRunning: intervalTimer !== null,
		listenerCount: listeners.size,
	};
}

/**
 * 驱动「N 分钟前探测」的 Hook。
 */
export function useMinuteTick(): number {
	return useSyncExternalStore(subscribeMinuteTick, getMinuteTickSnapshot, getMinuteTickSnapshot);
}
