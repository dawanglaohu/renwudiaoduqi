/**
 * packages/web/src/store/connection-store.ts
 *
 * M9-T11: Connection state zustand slice (07-前端架构 / 07:249, 07:298).
 *
 * Architecture rules:
 * - Low-frequency zustand slice strictly containing 07:249's four fields:
 *   status ('online' | 'reconnecting' | 'offline'), lastSyncedAt, lastEventId, needsPairing.
 * - Dispatch capability (canDispatch) is an exported selector, NEVER stored as state (07:298).
 * - Disconnect / reconnecting disables dispatch (AC 2, E-12).
 * - Offline/reconnecting -> online triggers registered resync handlers once (AC 2, E-12).
 * - Strictly forbidden from importing api layer (07:72; features layer handles external wiring).
 */

import { create } from 'zustand';

export type ConnectionStatus = 'online' | 'reconnecting' | 'offline';

export interface ConnectionState {
	/** Current connection status: online, reconnecting, or offline (07:249) */
	readonly status: ConnectionStatus;
	/** ISO8601 string of last received event or sync */
	readonly lastSyncedAt: string | null;
	/** Last received SSE event ID for reconnect resume (07:249, E-158) */
	readonly lastEventId: number | null;
	/** Whether the device must pair first (401 unauthorized / needs pair) (07:249) */
	readonly needsPairing: boolean;
}

export interface ConnectionActions {
	/** Set connection status and trigger resync on recovery (AC 2, E-12) */
	setStatus(status: ConnectionStatus): void;
	/** Record timestamp of successful synchronization */
	setLastSyncedAt(timestamp: string | number | Date | null): void;
	/** Record last received SSE event ID */
	setLastEventId(id: number | null): void;
	/** Set whether pairing authentication is required */
	setNeedsPairing(needs: boolean): void;
	/** Reset store to initial offline state */
	reset(): void;
}

export type ConnectionStore = ConnectionState & ConnectionActions;

const resyncHandlers = new Set<() => void | Promise<void>>();

/**
 * Register a resync callback to be executed when connection transitions back to 'online' (AC 2, E-12).
 */
export function registerResyncHandler(handler: () => void | Promise<void>): () => void {
	resyncHandlers.add(handler);
	return () => {
		resyncHandlers.delete(handler);
	};
}

/**
 * Trigger all registered resync handlers on connection recovery (E-12).
 */
export async function triggerResync(): Promise<void> {
	for (const handler of Array.from(resyncHandlers)) {
		try {
			await handler();
		} catch (err) {
			console.error('Error during connection recovery resync (E-12):', err);
		}
	}
}

/**
 * Pure selector for task dispatch capability (07:298, AC 2, E-12).
 * True strictly when status is 'online' and device does not need pairing.
 */
export function selectCanDispatch(state: {
	readonly status: ConnectionStatus;
	readonly needsPairing: boolean;
}): boolean {
	return state.status === 'online' && !state.needsPairing;
}

/**
 * Hook selector for canDispatch.
 */
export function useCanDispatch(): boolean {
	return useConnectionStore(selectCanDispatch);
}

const INITIAL_STATE: ConnectionState = {
	status: 'offline',
	lastSyncedAt: null,
	lastEventId: null,
	needsPairing: false,
};

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
	...INITIAL_STATE,

	setStatus: (status: ConnectionStatus) => {
		const prev = get().status;
		set({ status });

		// Trigger resync when transitioning from offline/reconnecting to online (AC 2, E-12)
		if (status === 'online' && prev !== 'online') {
			void triggerResync();
		}
	},

	setLastSyncedAt: (timestamp: string | number | Date | null) => {
		if (timestamp === null) {
			set({ lastSyncedAt: null });
			return;
		}
		let isoString: string | null = null;
		if (typeof timestamp === 'string') {
			isoString = timestamp;
		} else if (typeof timestamp === 'number') {
			isoString = new Date(timestamp).toISOString();
		} else if (timestamp instanceof Date) {
			isoString = timestamp.toISOString();
		}
		set({ lastSyncedAt: isoString });
	},

	setLastEventId: (id: number | null) => {
		set({ lastEventId: id });
	},

	setNeedsPairing: (needs: boolean) => {
		set({ needsPairing: needs });
	},

	reset: () => {
		set(INITIAL_STATE);
	},
}));
