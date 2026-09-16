/**
 * packages/web/test/use-stop-intent.test.ts
 *
 * M9-T11: Optimistic stop intent pipeline unit tests (07-前端架构 / AC 1, E-157).
 */

import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventBus, localIntents } from '../src/api/event-bus.ts';
import {
	type OptimisticStopResult,
	executeOptimisticStop,
	formatStopStep,
	useStopIntent,
} from '../src/features/run-deck/use-stop-intent.ts';
import { useNoticeStore } from '../src/store/notice-store.ts';

describe('M9-T11: use-stop-intent pipeline (AC 1, E-157, 07:86-89)', () => {
	beforeEach(() => {
		localIntents.clear();
		useNoticeStore.getState().reset();
		vi.clearAllMocks();
	});

	afterEach(() => {
		localIntents.clear();
		useNoticeStore.getState().reset();
		eventBus.destroy();
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// Step text formatting
	// ─────────────────────────────────────────────────────────────────────────────
	describe('formatStopStep', () => {
		it('formats stop step text correctly with N/M or single step', () => {
			expect(formatStopStep(3, 5)).toBe('你在第 3/5 步停止');
			expect(formatStopStep(1, 1)).toBe('你在第 1/1 步停止');
			expect(formatStopStep(4)).toBe('你在第 4 步停止');
			expect(formatStopStep(undefined)).toBe('你在停止中');
			expect(formatStopStep(undefined, 5)).toBe('你在停止中');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 1 & E-157: 按下停止一帧内本地置态写入 localIntents 并返回文案
	// ─────────────────────────────────────────────────────────────────────────────
	describe('executeOptimisticStop: synchronous 1-frame registration', () => {
		it('synchronously records intent in localIntents Map within 1 frame and returns text', async () => {
			let resolvePost: (val?: unknown) => void = () => {};
			const stopApiMock = vi.fn(
				() =>
					new Promise((resolve) => {
						resolvePost = resolve;
					}),
			);

			const start = performance.now();
			const execution = executeOptimisticStop({
				runId: 'run-intent-1',
				atStep: 2,
				totalSteps: 6,
				stopFn: stopApiMock,
			});
			const elapsed = performance.now() - start;

			// Synchronously executed within 1 frame (< 16ms)
			expect(elapsed).toBeLessThan(16);

			// Synchronously available: localIntents Map has key immediately
			expect(localIntents.has('run-intent-1')).toBe(true);
			const stored = localIntents.get('run-intent-1');
			expect(stored?.kind).toBe('stopping');
			expect(stored?.atStep).toBe(2);

			// Synchronously available: stepText is immediately accessible on return
			expect(execution.stepText).toBe('你在第 2/6 步停止');

			// Notice store has no rollback notice
			expect(useNoticeStore.getState().rollbackNotice).toBeNull();

			// Resolve POST
			resolvePost({ accepted: true });
			const result = await execution;
			expect(result.ok).toBe(true);
			expect(result.stepText).toBe('你在第 2/6 步停止');

			// Intent remains in place awaiting streaming events (E-157)
			expect(localIntents.has('run-intent-1')).toBe(true);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 1 & E-157: 服务端事件到达即清 intent (覆盖验收标准 1 清理路径)
	// ─────────────────────────────────────────────────────────────────────────────
	describe('Server streaming event clears localIntents (E-157)', () => {
		it('clears localIntents when run.state_changed event arrives', async () => {
			const stopApiMock = vi.fn().mockResolvedValue({ accepted: true });

			await executeOptimisticStop({
				runId: 'run-stream-event-1',
				atStep: 4,
				totalSteps: 8,
				stopFn: stopApiMock,
			});

			expect(localIntents.has('run-stream-event-1')).toBe(true);

			// Server event arrives through eventBus
			const envelope: EventEnvelope = {
				id: 101,
				scope: 'run',
				kind: 'run.state_changed',
				ts: new Date().toISOString(),
				seq: 1,
				taskId: null,
				actorDeviceId: null,
				runId: 'run-stream-event-1',
				payload: { from: 'running', to: 'stopped' },
			};
			eventBus.push(envelope);

			// localIntents Map has no key
			expect(localIntents.has('run-stream-event-1')).toBe(false);
		});

		it('clears localIntents when run.exited or run.aborted arrives', async () => {
			const stopApiMock = vi.fn().mockResolvedValue({ accepted: true });

			// Test run.exited
			await executeOptimisticStop({
				runId: 'run-stream-exited',
				atStep: 1,
				totalSteps: 3,
				stopFn: stopApiMock,
			});
			expect(localIntents.has('run-stream-exited')).toBe(true);

			const exitedEnvelope: EventEnvelope = {
				id: 102,
				scope: 'run',
				kind: 'run.exited',
				ts: new Date().toISOString(),
				seq: 1,
				taskId: null,
				actorDeviceId: null,
				runId: 'run-stream-exited',
				payload: { exitCode: 0 },
			};
			eventBus.push(exitedEnvelope);
			expect(localIntents.has('run-stream-exited')).toBe(false);

			// Test run.aborted
			await executeOptimisticStop({
				runId: 'run-stream-aborted',
				atStep: 2,
				totalSteps: 4,
				stopFn: stopApiMock,
			});
			expect(localIntents.has('run-stream-aborted')).toBe(true);

			const abortedEnvelope: EventEnvelope = {
				id: 103,
				scope: 'run',
				kind: 'run.aborted',
				ts: new Date().toISOString(),
				seq: 1,
				taskId: null,
				actorDeviceId: null,
				runId: 'run-stream-aborted',
				payload: { reason: 'user_requested' },
			};
			eventBus.push(abortedEnvelope);
			expect(localIntents.has('run-stream-aborted')).toBe(false);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 1 & E-157: POST reject 时清空 Map + notice-store 出现回滚横幅且不抛出错误
	// ─────────────────────────────────────────────────────────────────────────────
	describe('POST rejection rollback behavior (AC 1, 07:89)', () => {
		it('clears localIntents and writes rollback banner to notice-store without throwing', async () => {
			const stopApiMock = vi.fn().mockRejectedValue(new Error('Network connection aborted'));

			// Must not throw to caller
			let result: OptimisticStopResult | undefined;
			await expect(
				(async () => {
					result = await executeOptimisticStop({
						runId: 'run-fail-1',
						atStep: 3,
						totalSteps: 5,
						stopFn: stopApiMock,
					});
				})(),
			).resolves.not.toThrow();

			expect(result?.ok).toBe(false);
			expect(result?.stepText).toBe('你在第 3/5 步停止');
			expect(result?.error).toBeDefined();

			// localIntents Map is cleared
			expect(localIntents.has('run-fail-1')).toBe(false);

			// notice-store has rollback banner
			const rollback = useNoticeStore.getState().rollbackNotice;
			expect(rollback).not.toBeNull();
			expect(rollback?.runId).toBe('run-fail-1');
			expect(rollback?.message).toBe('你在第 3/5 步停止失败，已恢复原状态');
		});

		it('formats single step failure message when totalSteps is omitted', async () => {
			const stopApiMock = vi.fn().mockRejectedValue(new Error('Server internal error'));

			const result = await executeOptimisticStop({
				runId: 'run-fail-single-step',
				atStep: 7,
				stopFn: stopApiMock,
			});

			expect(result.ok).toBe(false);
			expect(localIntents.has('run-fail-single-step')).toBe(false);

			const rollback = useNoticeStore.getState().rollbackNotice;
			expect(rollback?.message).toBe('你在第 7 步停止失败，已恢复原状态');
		});
	});

	describe('useStopIntent hook', () => {
		it('exposes formatStopStep and executeOptimisticStop', () => {
			const hook = useStopIntent();
			expect(typeof hook.formatStopStep).toBe('function');
			expect(typeof hook.executeOptimisticStop).toBe('function');
			expect(hook.formatStopStep(1, 2)).toBe('你在第 1/2 步停止');
		});
	});
});
