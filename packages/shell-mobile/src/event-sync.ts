import { Preferences } from '@capacitor/preferences';
import type { StorageBackend } from './preferences-store.ts';

export const MOBILE_LAST_EVENT_ID_KEY = 'agsched.last_event_id' as const;

export interface MobileEventSyncOptions {
	readonly backend?: StorageBackend;
	readonly key?: string;
}

export interface ReplayWindowExpiredDetail {
	readonly requestedLastEventId: number;
	readonly minAvailableId: number;
}

export interface MobileEventSyncTracker {
	getLastEventId(): Promise<number | null>;
	saveLastEventId(id: number): Promise<void>;
	clearLastEventId(): Promise<void>;
	handleReplayWindowExpired(detail?: Partial<ReplayWindowExpiredDetail>): Promise<void>;
	isOfflinePushEnabled(): boolean;
}

/**
 * Manages Last-Event-ID persistence in native Preferences for mobile recovery (AC 4, E-147, E-11).
 * When Android kills the background app, reopening reads the locally persisted Last-Event-ID
 * to resume SSE and catch up on unread events without introducing offline push servers.
 */
export function createMobileEventSyncTracker(
	options: MobileEventSyncOptions = {},
): MobileEventSyncTracker {
	const backend: StorageBackend = options.backend ?? Preferences;
	const key = options.key ?? MOBILE_LAST_EVENT_ID_KEY;

	return {
		async getLastEventId(): Promise<number | null> {
			const { value } = await backend.get({ key });
			if (value === null || value === undefined || value.trim().length === 0) {
				return null;
			}
			const parsed = Number.parseInt(value, 10);
			return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
		},

		async saveLastEventId(id: number): Promise<void> {
			if (!Number.isFinite(id) || id < 0) {
				throw new Error('Event ID must be a non-negative integer');
			}
			await backend.set({ key, value: String(Math.floor(id)) });
		},

		async clearLastEventId(): Promise<void> {
			await backend.remove({ key });
		},

		async handleReplayWindowExpired(detail?: Partial<ReplayWindowExpiredDetail>): Promise<void> {
			// When daemon replay window expired (E-153 / E-147), reset the cursor so
			// the client falls back to REST snapshot reload rather than looping on expired cursor.
			await backend.remove({ key });
			if (detail?.minAvailableId !== undefined && Number.isFinite(detail.minAvailableId)) {
				await backend.set({ key, value: String(Math.floor(detail.minAvailableId)) });
			}
		},

		isOfflinePushEnabled(): boolean {
			// Explicitly false per E-11: no third-party cloud relay / APNs / FCM dependencies
			return false;
		},
	};
}
