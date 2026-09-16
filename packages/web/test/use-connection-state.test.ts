/**
 * packages/web/test/use-connection-state.test.ts
 *
 * M9-T11: Connection state wiring and version check unit tests (07-前端架构 / AC 2-4, E-04, E-12, E-14).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseClient, SseConnectionStatus } from '../src/api/sse-client.ts';
import {
	bindConnectionState,
	checkVersionCompatibility,
} from '../src/features/run-deck/use-connection-state.ts';
import { registerResyncHandler, useConnectionStore } from '../src/store/connection-store.ts';

describe('M9-T11: use-connection-state wiring (07:72, 07:342, 07:390)', () => {
	beforeEach(() => {
		useConnectionStore.getState().reset();
		vi.clearAllMocks();
	});

	afterEach(() => {
		useConnectionStore.getState().reset();
	});

	function createMockSseClient(
		initialStatus: SseConnectionStatus = 'disconnected',
		initialEventId: number | null = null,
	) {
		const statusListeners: ((status: SseConnectionStatus) => void)[] = [];
		const eventListeners: ((event: { id?: number }) => void)[] = [];
		let currentStatus = initialStatus;
		let lastEventId = initialEventId;

		const client = {
			getStatus: vi.fn(() => currentStatus),
			getLastEventId: vi.fn(() => lastEventId),
			onStatusChange: vi.fn((fn: (status: SseConnectionStatus) => void) => {
				statusListeners.push(fn);
				return () => {
					const idx = statusListeners.indexOf(fn);
					if (idx >= 0) statusListeners.splice(idx, 1);
				};
			}),
			subscribe: vi.fn((fn: (event: { id?: number }) => void) => {
				eventListeners.push(fn);
				return () => {
					const idx = eventListeners.indexOf(fn);
					if (idx >= 0) eventListeners.splice(idx, 1);
				};
			}),
			// Test helpers
			emitStatus(status: SseConnectionStatus) {
				currentStatus = status;
				for (const listener of [...statusListeners]) {
					listener(status);
				}
			},
			emitEvent(event: { id?: number }) {
				if (typeof event.id === 'number') {
					lastEventId = event.id;
				}
				for (const listener of [...eventListeners]) {
					listener(event);
				}
			},
		} as unknown as SseClient & {
			emitStatus: (status: SseConnectionStatus) => void;
			emitEvent: (event: { id?: number }) => void;
		};

		return client;
	}

	it('synchronizes initial status and initial lastEventId from SseClient', () => {
		const mockClient = createMockSseClient('disconnected', 55);
		const unbind = bindConnectionState(mockClient);

		expect(useConnectionStore.getState().status).toBe('offline');
		expect(useConnectionStore.getState().lastEventId).toBe(55);

		unbind();
	});

	it('offline -> online triggers resync handler exactly once (AC 2, E-12)', () => {
		const resyncMock = vi.fn();
		const unbindResync = registerResyncHandler(resyncMock);

		const mockClient = createMockSseClient('disconnected');
		const unbind = bindConnectionState(mockClient);

		expect(useConnectionStore.getState().status).toBe('offline');
		expect(resyncMock).toHaveBeenCalledTimes(0);

		// Transition to connected
		mockClient.emitStatus('connected');
		expect(useConnectionStore.getState().status).toBe('online');
		expect(resyncMock).toHaveBeenCalledTimes(1);

		unbind();
		unbindResync();
	});

	it('online -> online does NOT trigger resync handler', () => {
		const resyncMock = vi.fn();
		const unbindResync = registerResyncHandler(resyncMock);

		const mockClient = createMockSseClient('connected');
		const unbind = bindConnectionState(mockClient);

		expect(useConnectionStore.getState().status).toBe('online');
		// Initial sync doesn't transition from offline, or even if it set online, check subsequent
		resyncMock.mockClear();

		// Emit connected again while already online
		mockClient.emitStatus('connected');
		expect(useConnectionStore.getState().status).toBe('online');
		expect(resyncMock).toHaveBeenCalledTimes(0);

		unbind();
		unbindResync();
	});

	it('unauthorized status sets needsPairing to true and status to offline (07:390)', () => {
		const mockClient = createMockSseClient('connected');
		const unbind = bindConnectionState(mockClient);

		expect(useConnectionStore.getState().status).toBe('online');
		expect(useConnectionStore.getState().needsPairing).toBe(false);

		// Emit unauthorized (HTTP 401)
		mockClient.emitStatus('unauthorized');

		const state = useConnectionStore.getState();
		expect(state.status).toBe('offline');
		expect(state.needsPairing).toBe(true);

		unbind();
	});

	it('reconnecting and connecting map to reconnecting status', () => {
		const mockClient = createMockSseClient('connected');
		const unbind = bindConnectionState(mockClient);

		mockClient.emitStatus('reconnecting');
		expect(useConnectionStore.getState().status).toBe('reconnecting');

		mockClient.emitStatus('connecting');
		expect(useConnectionStore.getState().status).toBe('reconnecting');

		mockClient.emitStatus('disconnected');
		expect(useConnectionStore.getState().status).toBe('offline');

		unbind();
	});

	it('event arrival updates lastEventId and lastSyncedAt', () => {
		const mockClient = createMockSseClient('connected');
		const unbind = bindConnectionState(mockClient);

		expect(useConnectionStore.getState().lastSyncedAt).toBeNull();
		expect(useConnectionStore.getState().lastEventId).toBeNull();

		mockClient.emitEvent({ id: 204 });

		const state = useConnectionStore.getState();
		expect(state.lastEventId).toBe(204);
		expect(state.lastSyncedAt).not.toBeNull();
		expect(typeof state.lastSyncedAt).toBe('string');

		unbind();
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 4 & E-14: Graceful version checking
	// ─────────────────────────────────────────────────────────────────────────────
	describe('checkVersionCompatibility (AC 4, E-14)', () => {
		it('accepts v1, /api/v1, and api/v1 as compatible', () => {
			expect(checkVersionCompatibility('v1').compatible).toBe(true);
			expect(checkVersionCompatibility('/api/v1').compatible).toBe(true);
			expect(checkVersionCompatibility('api/v1').compatible).toBe(true);
			expect(checkVersionCompatibility({ apiVersion: 'v1' }).compatible).toBe(true);
			expect(checkVersionCompatibility(null).compatible).toBe(true);
			expect(checkVersionCompatibility(undefined).compatible).toBe(true);
		});

		it('detects mismatch without throwing and provides user-facing prompt message', () => {
			const result = checkVersionCompatibility('v2');
			expect(result.compatible).toBe(false);
			expect(result.message).toContain('调度服务版本不兼容');
			expect(result.info?.expected).toBe('v1');
			expect(result.info?.actual).toBe('v2');
		});

		it('handles object version input with mismatch', () => {
			const result = checkVersionCompatibility({ apiVersion: 'v99' });
			expect(result.compatible).toBe(false);
			expect(result.info?.actual).toBe('v99');
		});
	});
});
