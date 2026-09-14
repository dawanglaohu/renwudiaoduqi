import { describe, expect, it, vi } from 'vitest';
import { MOBILE_LAST_EVENT_ID_KEY, createMobileEventSyncTracker } from '../src/event-sync.ts';

describe('Mobile Event Sync & Last-Event-ID Recovery (AC 4, E-147, E-11)', () => {
	it('AC 4 & E-147: persists Last-Event-ID to Preferences and restores it when app reopens after process kill', async () => {
		const mockStorage = new Map<string, string>();
		const mockBackend = {
			get: vi.fn(async ({ key }: { key: string }) => ({
				value: mockStorage.get(key) ?? null,
			})),
			set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
				mockStorage.set(key, value);
			}),
			remove: vi.fn(async ({ key }: { key: string }) => {
				mockStorage.delete(key);
			}),
		};

		// --- Phase 1: App is running, receives SSE stream events ---
		const tracker1 = createMobileEventSyncTracker({ backend: mockBackend });
		await tracker1.saveLastEventId(1048);

		expect(mockBackend.set).toHaveBeenCalledWith({
			key: MOBILE_LAST_EVENT_ID_KEY,
			value: '1048',
		});

		// --- Phase 2: Android OS kills the process in background (simulated) ---
		// tracker1 is garbage collected; memory is lost. Only Preferences storage persists.

		// --- Phase 3: App reopens (new process initialization) ---
		const tracker2 = createMobileEventSyncTracker({ backend: mockBackend });
		const restoredId = await tracker2.getLastEventId();

		expect(restoredId).toBe(1048);
	});

	it('handles replay window expired by resetting stored cursor', async () => {
		const mockStorage = new Map<string, string>([[MOBILE_LAST_EVENT_ID_KEY, '500']]);
		const mockBackend = {
			get: vi.fn(async ({ key }: { key: string }) => ({
				value: mockStorage.get(key) ?? null,
			})),
			set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
				mockStorage.set(key, value);
			}),
			remove: vi.fn(async ({ key }: { key: string }) => {
				mockStorage.delete(key);
			}),
		};

		const tracker = createMobileEventSyncTracker({ backend: mockBackend });

		// When replay window expired (E-153 / E-147), resets cursor with minAvailableId
		await tracker.handleReplayWindowExpired({
			requestedLastEventId: 500,
			minAvailableId: 1200,
		});

		expect(mockBackend.remove).toHaveBeenCalledWith({ key: MOBILE_LAST_EVENT_ID_KEY });
		expect(mockBackend.set).toHaveBeenCalledWith({
			key: MOBILE_LAST_EVENT_ID_KEY,
			value: '1200',
		});
	});

	it('AC 4 & E-11: explicitly does NOT support or depend on offline push servers (APNs/FCM)', () => {
		const tracker = createMobileEventSyncTracker();
		expect(tracker.isOfflinePushEnabled()).toBe(false);
	});
});
