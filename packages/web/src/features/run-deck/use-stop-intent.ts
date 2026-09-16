/**
 * packages/web/src/features/run-deck/use-stop-intent.ts
 *
 * M9-T11: Optimistic stop presentation & rollback pipeline (07-前端架构 / AC 1, E-157).
 *
 * Architecture rules:
 * - Features layer is the ONLY layer allowed to import `src/api` and subscribe to event-bus (07:72).
 * - Synchronously updates mutable local-intent Map beside event-bus within 1 frame (< 16ms)
 *   with 「你在第 N/M 步停止」, without writing to run.state or zustand (AC 1, 07:86-88, 07:300).
 * - Issues POST stop request injected by the caller.
 * - On success: remains in place without modifying state, awaiting server streaming event confirmation (E-157).
 * - On failure (POST reject): clears local intent and records a rollback banner to notice slice (07:89).
 * - Failure is captured gracefully and never throws to the caller.
 */

import { clearLocalIntent, setLocalIntent } from '../../api/event-bus.ts';
import { useNoticeStore } from '../../store/notice-store.ts';

/**
 * Format optimistic stopped step string (AC 1):
 * e.g. "你在第 3/5 步停止" or "你在第 3 步停止" or "你在停止中"
 */
export function formatStopStep(atStep?: number, totalSteps?: number): string {
	if (typeof atStep === 'number' && typeof totalSteps === 'number' && totalSteps > 0) {
		return `你在第 ${atStep}/${totalSteps} 步停止`;
	}
	if (typeof atStep === 'number') {
		return `你在第 ${atStep} 步停止`;
	}
	return '你在停止中';
}

export interface OptimisticStopOptions {
	readonly runId: string;
	readonly atStep?: number;
	readonly totalSteps?: number;
	readonly stopFn: () => Promise<unknown>;
}

export interface OptimisticStopResult {
	readonly ok: boolean;
	readonly stepText: string;
	readonly error?: unknown;
}

/**
 * Executes optimistic stop pipeline (AC 1, E-157):
 * 1. Synchronously writes intent to mutable Map beside event-bus within 1 frame: 「你在第 N/M 步停止」
 * 2. Issues POST stop request without modifying state based on response body (E-157)
 * 3. On failure: clears intent + records rollback banner in notice store without throwing
 */
export function executeOptimisticStop(
	options: OptimisticStopOptions,
): Promise<OptimisticStopResult> & { stepText: string } {
	const { runId, atStep, totalSteps, stopFn } = options;
	const stepText = formatStopStep(atStep, totalSteps);

	// 1. One frame local state: immediate synchronous write to mutable Map beside event-bus (AC 1, 07:86)
	setLocalIntent({
		runId,
		kind: 'stopping',
		atStep,
		timestamp: Date.now(),
	});

	// 2. Wrap async POST pipeline
	const promise = (async (): Promise<OptimisticStopResult> => {
		try {
			// Issue POST abort
			await stopFn();
			// Success: do not touch state, await server streaming event to confirm (E-157)
			return { ok: true, stepText };
		} catch (error) {
			// Failure: clear intent and record rollback notice to notice slice (07:89)
			clearLocalIntent(runId);
			useNoticeStore.getState().setRollbackNotice({
				runId,
				message: `${stepText}失败，已恢复原状态`,
			});
			return { ok: false, stepText, error };
		}
	})();

	void Object.assign(promise, { stepText });
	return promise as Promise<OptimisticStopResult> & { stepText: string };
}

/**
 * Hook for optimistic stop interactions in React components.
 */
export function useStopIntent() {
	return {
		formatStopStep,
		executeOptimisticStop,
	};
}
