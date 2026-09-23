/**
 * packages/web/src/lib/run-pulse.ts
 *
 * 运行状态呼吸灯判定纯函数（M9-T19 / AC 3, E-282）
 *
 * 规范依据（07 节前端架构与 11 节 UI）：
 * - 純函数：无 React、无副作用、不引入除 @agent-scheduler/shared 外的其它目录
 * - RUN_PULSE 以 satisfies 机检穷尽覆盖全部 13 个运行状态（E-282）
 * - live 恰为 starting / running / reviewing / reworking（实心点 + 1.6s 呼吸环）
 * - awaiting_* 与 orphaned 态映射为 waiting（静态暖点）
 * - 四个终态（landed / failed / aborted / interrupted）与 queued / exited 无点（none）
 */

import type { RunState } from '@agent-scheduler/shared/api/runs';

export type PulseVariant = 'live' | 'waiting' | 'none';

/**
 * 13 个运行状态对应的呼吸点变体映射表（AC 3, E-282）。
 */
export const RUN_PULSE = {
	queued: 'none',
	starting: 'live',
	running: 'live',
	awaiting_reply: 'waiting',
	exited: 'none',
	reviewing: 'live',
	reworking: 'live',
	awaiting_human: 'waiting',
	orphaned: 'waiting',
	landed: 'none',
	failed: 'none',
	aborted: 'none',
	interrupted: 'none',
} as const satisfies Record<RunState, PulseVariant>;

/**
 * 根据运行状态计算呼吸灯形态（live | waiting | none）。
 * 无状态、未知状态或 null/undefined 均返回 'none'。
 */
export function pulseForRun(state: string | null | undefined): PulseVariant {
	if (!state) {
		return 'none';
	}
	return (RUN_PULSE as Record<string, PulseVariant>)[state] ?? 'none';
}
