/**
 * packages/web/test/connection-store.test.ts
 *
 * M9-T11: Connection store unit tests (AC 1-4, E-04, E-12, E-14, E-157)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseConnectionStatus } from '../src/api/sse-client.ts';
import {
	bindSseClient,
	executeOptimisticStop,
	formatLastSyncedAt,
	formatStopStep,
	localIntents,
	registerResyncHandler,
	useConnectionStore,
} from '../src/store/connection-store.ts';

describe('M9-T11: Connection store & optimistic stop presentation (AC 1-4, E-04, E-12, E-14, E-157)', () => {
	beforeEach(() => {
		useConnectionStore.getState().reset();
		localIntents.clear();
		vi.clearAllMocks();
	});

	afterEach(() => {
		useConnectionStore.getState().reset();
		localIntents.clear();
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 1 & E-157: 按停止键后一帧内本地置态并写明「你在第 N/M 步停止」，不等回包
	// 服务端事件到达即清 intent，失败则清 intent + 横幅回滚
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 1 & E-157: Optimistic stop presentation in local-intent Map', () => {
		it('formats stop step text correctly with N/M or single step', () => {
			expect(formatStopStep(3, 5)).toBe('你在第 3/5 步停止');
			expect(formatStopStep(1, 1)).toBe('你在第 1/1 步停止');
			expect(formatStopStep(4)).toBe('你在第 4 步停止');
			expect(formatStopStep(undefined)).toBe('你在停止中');
		});

		it('creates and records local stop intent within 1 frame (< 16ms synchronously)', () => {
			const start = performance.now();
			const intent = useConnectionStore.getState().createStopIntent('run-stop-test-1', 2, 6);
			const duration = performance.now() - start;

			// Verified within 1 frame (16.6ms)
			expect(duration).toBeLessThan(16);
			expect(intent.runId).toBe('run-stop-test-1');
			expect(intent.kind).toBe('stopping');
			expect(intent.atStep).toBe(2);
			expect(intent.totalSteps).toBe(6);
			expect(intent.stepText).toBe('你在第 2/6 步停止');

			// Stored in mutable localIntents Map beside event-bus (07-前端架构)
			expect(localIntents.has('run-stop-test-1')).toBe(true);
			expect(localIntents.get('run-stop-test-1')?.kind).toBe('stopping');

			// Reactively tracked on connectionStore
			const state = useConnectionStore.getState();
			expect(state.activeStopIntents['run-stop-test-1']).toBeDefined();
			expect(state.activeStopIntents['run-stop-test-1']?.stepText).toBe('你在第 2/6 步停止');
		});

		it('clears stop intent when server confirmation event arrives (E-157)', () => {
			useConnectionStore.getState().createStopIntent('run-stop-test-2', 4, 8);
			expect(localIntents.has('run-stop-test-2')).toBe(true);

			// Server event arrives and clears intent
			useConnectionStore.getState().clearStopIntent('run-stop-test-2');
			expect(localIntents.has('run-stop-test-2')).toBe(false);
			expect(useConnectionStore.getState().activeStopIntents['run-stop-test-2']).toBeUndefined();
		});

		it('rolls back intent and sets rollback notice when stop API fails (AC 1, E-157)', async () => {
			const stopApiMock = vi.fn().mockRejectedValue(new Error('Network failure'));

			const result = await executeOptimisticStop({
				runId: 'run-stop-fail',
				atStep: 3,
				totalSteps: 5,
				stopFn: stopApiMock,
			});

			expect(result.ok).toBe(false);
			expect(stopApiMock).toHaveBeenCalledTimes(1);

			// Intent is cleared from mutable map
			expect(localIntents.has('run-stop-fail')).toBe(false);
			expect(useConnectionStore.getState().activeStopIntents['run-stop-fail']).toBeUndefined();

			// Rollback notice is set on store for topbar banner presentation
			const rollback = useConnectionStore.getState().rollbackNotice;
			expect(rollback).not.toBeNull();
			expect(rollback?.runId).toBe('run-stop-fail');
			expect(rollback?.message).toContain('你在第 3/5 步停止失败，已恢复原状态');
		});

		it('retains intent pending server streaming events when stop API succeeds (E-157)', async () => {
			const stopApiMock = vi.fn().mockResolvedValue({ accepted: true });

			const result = await executeOptimisticStop({
				runId: 'run-stop-ok',
				atStep: 1,
				totalSteps: 3,
				stopFn: stopApiMock,
			});

			expect(result.ok).toBe(true);

			// Intent remains in place awaiting streaming events (E-157: UI never uses POST response body directly)
			expect(localIntents.has('run-stop-ok')).toBe(true);
			expect(useConnectionStore.getState().rollbackNotice).toBeNull();
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 2 & E-12: 断连时顶栏显示「离线，最后同步于 X」并禁用派发按钮，恢复后自动补拉
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 2 & E-12: Offline state, dispatch disabling, and reconnect resync', () => {
		it('formats last synced timestamp into readable time', () => {
			expect(formatLastSyncedAt(null)).toBe('—');
			expect(formatLastSyncedAt(undefined)).toBe('—');
			expect(formatLastSyncedAt('—')).toBe('—');
			expect(formatLastSyncedAt('14:30:25')).toBe('14:30:25');

			// Date object
			const date = new Date('2026-09-16T10:20:30.000Z');
			const formatted = formatLastSyncedAt(date);
			expect(formatted).toMatch(/^\d{2}:\d{2}:\d{2}$/);
		});

		it('disables dispatch when status is offline or reconnecting (AC 2, E-12)', () => {
			const store = useConnectionStore.getState();

			// Initial offline state: canDispatch must be false
			expect(store.status).toBe('offline');
			expect(store.canDispatch).toBe(false);

			// Transition to online
			store.setStatus('online');
			expect(useConnectionStore.getState().status).toBe('online');
			expect(useConnectionStore.getState().canDispatch).toBe(true);

			// Reconnecting state: canDispatch must be disabled
			store.setStatus('reconnecting');
			expect(useConnectionStore.getState().status).toBe('reconnecting');
			expect(useConnectionStore.getState().canDispatch).toBe(false);

			// Offline state: canDispatch must be disabled
			store.setStatus('offline');
			expect(useConnectionStore.getState().status).toBe('offline');
			expect(useConnectionStore.getState().canDispatch).toBe(false);
		});

		it('disables dispatch when needsPairing is true', () => {
			useConnectionStore.getState().setStatus('online');
			expect(useConnectionStore.getState().canDispatch).toBe(true);

			useConnectionStore.getState().setNeedsPairing(true);
			expect(useConnectionStore.getState().canDispatch).toBe(false);
		});

		it('triggers registered resync handlers when transitioning to online (E-12 recovery)', () => {
			const resyncMock = vi.fn();
			const unbind = registerResyncHandler(resyncMock);

			// Offline -> Online triggers resync
			useConnectionStore.getState().setStatus('offline');
			useConnectionStore.getState().setStatus('online');

			expect(resyncMock).toHaveBeenCalledTimes(1);

			// Online -> Online does not trigger
			useConnectionStore.getState().setStatus('online');
			expect(resyncMock).toHaveBeenCalledTimes(1);

			// Reconnecting -> Online triggers resync
			useConnectionStore.getState().setStatus('reconnecting');
			useConnectionStore.getState().setStatus('online');
			expect(resyncMock).toHaveBeenCalledTimes(2);

			unbind();
		});

		it('binds to SSE client and synchronizes status and last synced timestamp', () => {
			const mockStatusListeners: ((status: SseConnectionStatus) => void)[] = [];
			const mockEventListeners: ((event: { id?: number }) => void)[] = [];

			const mockSseClient = {
				getStatus: vi.fn((): SseConnectionStatus => 'disconnected'),
				getLastEventId: vi.fn((): number | null => 42),
				onStatusChange: vi.fn((fn: (status: SseConnectionStatus) => void) => {
					mockStatusListeners.push(fn);
					return () => {};
				}),
				subscribe: vi.fn((fn: (event: { id?: number }) => void) => {
					mockEventListeners.push(fn);
					return () => {};
				}),
			} as unknown as import('../src/api/sse-client.ts').SseClient;

			const unbind = bindSseClient(mockSseClient);

			expect(useConnectionStore.getState().status).toBe('offline');
			expect(useConnectionStore.getState().lastEventId).toBe(42);

			// SSE connects
			mockStatusListeners[0]?.('connected');
			expect(useConnectionStore.getState().status).toBe('online');
			expect(useConnectionStore.getState().canDispatch).toBe(true);

			// SSE event arrives
			mockEventListeners[0]?.({ id: 108 });
			expect(useConnectionStore.getState().lastEventId).toBe(108);
			expect(useConnectionStore.getState().lastSyncedAt).not.toBeNull();

			// SSE drops connection
			mockStatusListeners[0]?.('reconnecting');
			expect(useConnectionStore.getState().status).toBe('reconnecting');
			expect(useConnectionStore.getState().canDispatch).toBe(false);

			unbind();
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 3 & E-04: daemon 未运行时明确提示「电脑上的调度服务未启动」，而不是连接超时
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 3 & E-04: Daemon unreachability messaging', () => {
		it('reports 「电脑上的调度服务未启动」 when daemon is not running', () => {
			useConnectionStore.getState().setDaemonRunning(false);

			const state = useConnectionStore.getState();
			expect(state.isDaemonRunning).toBe(false);
			expect(state.status).toBe('offline');
			expect(state.canDispatch).toBe(false);

			const msg = useConnectionStore.getState().getOfflineErrorMessage();
			expect(msg).toBe('电脑上的调度服务未启动');
			expect(msg).not.toContain('连接超时');
		});

		it('distinguishes daemon down from generic network failure', () => {
			useConnectionStore.getState().setDaemonRunning(true);
			useConnectionStore.getState().setStatus('offline');

			const msg = useConnectionStore.getState().getOfflineErrorMessage();
			expect(msg).not.toContain('连接超时');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 4 & E-14: 版本不兼容时提示升级而不是抛底层错误
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 4 & E-14: Graceful version compatibility handling', () => {
		it('gracefully detects version mismatch without throwing', () => {
			expect(() => {
				const res = useConnectionStore.getState().checkVersionCompatibility('v2');
				expect(res.compatible).toBe(false);
				expect(res.message).toContain('调度服务版本不兼容');
			}).not.toThrow();

			const state = useConnectionStore.getState();
			expect(state.isVersionCompatible).toBe(false);
			expect(state.versionInfo?.expected).toBe('v1');
			expect(state.versionInfo?.actual).toBe('v2');
			expect(state.canDispatch).toBe(false);
		});

		it('accepts matching version and marks compatible', () => {
			const res = useConnectionStore.getState().checkVersionCompatibility({ apiVersion: 'v1' });
			expect(res.compatible).toBe(true);

			const state = useConnectionStore.getState();
			expect(state.isVersionCompatible).toBe(true);
			expect(state.versionInfo).toBeNull();
		});

		it('handles object with incompatible apiVersion without throwing', () => {
			expect(() => {
				const res = useConnectionStore.getState().checkVersionCompatibility({
					apiVersion: 'v99',
				});
				expect(res.compatible).toBe(false);
			}).not.toThrow();

			expect(useConnectionStore.getState().isVersionCompatible).toBe(false);
		});
	});
});
