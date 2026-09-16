/**
 * packages/web/src/store/connection-store.ts
 *
 * M9-T11: Connection state zustand slice & optimistic stop presentation (07-前端架构 / AC 1-4, E-04, E-12, E-14, E-157).
 *
 * Architecture rules:
 * - Low-frequency zustand slice: status ('online' | 'reconnecting' | 'offline'), lastSyncedAt, lastEventId, needsPairing.
 * - Dispatch button disabling reads `canDispatch` from this store (AC 2, E-12).
 * - Daemon unreachability explicitly presents 「电脑上的调度服务未启动」, not connection timeout (AC 3, E-04).
 * - Incompatible API version gracefully presents upgrade prompt without throwing (AC 4, E-14).
 * - Optimistic stop: updates local-intent Map beside event-bus within 1 frame with 「你在第 N/M 步停止」,
 *   waits for streaming event confirmation, and rolls back with topbar notice on failure (AC 1, E-157).
 */

import { CURRENT_API_VERSION } from '@agent-scheduler/shared/api/system';
import { create } from 'zustand';
import {
	type LocalIntent,
	clearLocalIntent as clearEventBusLocalIntent,
	getLocalIntent as getEventBusLocalIntent,
	localIntents,
	setLocalIntent as setEventBusLocalIntent,
} from '../api/event-bus.ts';
import type { SseClient, SseConnectionStatus } from '../api/sse-client.ts';

// Re-export mutable Map instance beside event-bus (07-前端架构)
export { localIntents };

export type ConnectionStatus = 'online' | 'reconnecting' | 'offline';

export interface VersionInfo {
	readonly expected: string;
	readonly actual?: string;
}

export interface RollbackNotice {
	readonly runId: string;
	readonly message: string;
	readonly timestamp: number;
}

/**
 * Extended local stop intent carrying formatted step information (AC 1, E-157).
 */
export interface LocalStopIntent extends LocalIntent {
	readonly totalSteps?: number;
	readonly stepText: string;
}

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

/**
 * Format ISO timestamp or Date into readable time string (AC 2, E-12).
 */
export function formatLastSyncedAt(timestamp: string | number | Date | null | undefined): string {
	if (!timestamp) {
		return '—';
	}
	if (typeof timestamp === 'string') {
		const trimmed = timestamp.trim();
		if (/^\d{2}:\d{2}(:\d{2})?$/.test(trimmed) || trimmed === '—') {
			return trimmed;
		}
	}
	try {
		const d =
			typeof timestamp === 'string' || typeof timestamp === 'number'
				? new Date(timestamp)
				: timestamp;
		if (Number.isNaN(d.getTime())) {
			return typeof timestamp === 'string' ? timestamp : '—';
		}
		const hours = String(d.getHours()).padStart(2, '0');
		const minutes = String(d.getMinutes()).padStart(2, '0');
		const seconds = String(d.getSeconds()).padStart(2, '0');
		return `${hours}:${minutes}:${seconds}`;
	} catch {
		return '—';
	}
}

export interface ConnectionState {
	/** Current connection status: online, reconnecting, or offline (07-前端架构) */
	readonly status: ConnectionStatus;
	/** ISO8601 string of last received event or sync */
	readonly lastSyncedAt: string | null;
	/** Last received SSE event ID for reconnect resume (E-158) */
	readonly lastEventId: number | null;
	/** Whether the device must pair first (401 unauthorized / needs pair) */
	readonly needsPairing: boolean;
	/** Whether the daemon process is running and accessible (AC 3, E-04) */
	readonly isDaemonRunning: boolean;
	/** Specific error reason when daemon is offline */
	readonly daemonErrorReason?: 'daemon_down' | 'network_error' | 'unauthorized' | string;
	/** Whether the daemon API version matches client expectations (AC 4, E-14) */
	readonly isVersionCompatible: boolean;
	/** Expected and actual version details if incompatible */
	readonly versionInfo: VersionInfo | null;
	/** Rollback notice when an optimistic stop request fails (AC 1, E-157) */
	readonly rollbackNotice: RollbackNotice | null;
	/**
	 * Whether task dispatch is permitted (AC 2, E-12).
	 * Strictly false whenever offline, reconnecting, daemon down, version incompatible, or unauthenticated.
	 */
	readonly canDispatch: boolean;
	/** In-flight optimistic stop intents mapped by runId */
	readonly activeStopIntents: Readonly<Record<string, LocalStopIntent>>;
}

export interface ConnectionActions {
	/** Set connection status and update canDispatch (AC 2) */
	setStatus(status: ConnectionStatus): void;
	/** Record timestamp of successful synchronization */
	setLastSyncedAt(timestamp: string | number | Date | null): void;
	/** Record last received SSE event ID */
	setLastEventId(id: number | null): void;
	/** Set whether pairing authentication is required */
	setNeedsPairing(needs: boolean): void;
	/** Mark whether the background daemon process is running (AC 3, E-04) */
	setDaemonRunning(running: boolean, reason?: string): void;
	/** Check or set version compatibility (AC 4, E-14) */
	setVersionCompatibility(compatible: boolean, info?: VersionInfo | null): void;
	/** Set optimistic stop rollback notice (AC 1, E-157) */
	setRollbackNotice(notice: { runId: string; message?: string } | null): void;
	/** Dismiss active rollback notice */
	clearRollbackNotice(): void;
	/**
	 * Create and register an optimistic stop intent within 1 frame (AC 1).
	 * Writes to localIntents Map immediately and sets store state.
	 */
	createStopIntent(runId: string, atStep?: number, totalSteps?: number): LocalStopIntent;
	/** Clear stop intent when server event confirms transition (E-157) */
	clearStopIntent(runId: string): void;
	/** Roll back optimistic stop intent and trigger topbar banner on API failure (AC 1, E-157) */
	rollbackStopIntent(runId: string, message?: string): void;
	/**
	 * Validate remote API version against expected CURRENT_API_VERSION (AC 4, E-14).
	 * Never throws; records incompatibility gracefully.
	 */
	checkVersionCompatibility(versionInput: string | { apiVersion?: string } | null | undefined): {
		compatible: boolean;
		message?: string;
	};
	/**
	 * Get formatted offline error message (AC 3, E-04).
	 * Strictly yields 「电脑上的调度服务未启动」 when daemon is not running, never "连接超时".
	 */
	getOfflineErrorMessage(): string;
	/** Reset store to initial offline state */
	reset(): void;
}

export type ConnectionStore = ConnectionState & ConnectionActions;

function computeCanDispatch(
	status: ConnectionStatus,
	needsPairing: boolean,
	isDaemonRunning: boolean,
	isVersionCompatible: boolean,
): boolean {
	return status === 'online' && !needsPairing && isDaemonRunning && isVersionCompatible;
}

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

const INITIAL_STATE: ConnectionState = {
	status: 'offline',
	lastSyncedAt: null,
	lastEventId: null,
	needsPairing: false,
	isDaemonRunning: true,
	daemonErrorReason: undefined,
	isVersionCompatible: true,
	versionInfo: null,
	rollbackNotice: null,
	canDispatch: false,
	activeStopIntents: {},
};

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
	...INITIAL_STATE,

	setStatus: (status: ConnectionStatus) => {
		const prev = get().status;
		set((state) => {
			const isRunning = status === 'online' ? true : state.isDaemonRunning;
			return {
				status,
				isDaemonRunning: isRunning,
				canDispatch: computeCanDispatch(
					status,
					state.needsPairing,
					isRunning,
					state.isVersionCompatible,
				),
			};
		});

		// Trigger resync when transitioning from offline/reconnecting to online (AC 2, E-12)
		if (status === 'online' && prev !== 'online') {
			triggerResync();
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
		set((state) => ({
			needsPairing: needs,
			canDispatch: computeCanDispatch(
				state.status,
				needs,
				state.isDaemonRunning,
				state.isVersionCompatible,
			),
		}));
	},

	setDaemonRunning: (running: boolean, reason?: string) => {
		set((state) => {
			const status = running ? state.status : 'offline';
			return {
				isDaemonRunning: running,
				status,
				daemonErrorReason: running ? undefined : (reason ?? 'daemon_down'),
				canDispatch: computeCanDispatch(
					status,
					state.needsPairing,
					running,
					state.isVersionCompatible,
				),
			};
		});
	},

	setVersionCompatibility: (compatible: boolean, info?: VersionInfo | null) => {
		set((state) => ({
			isVersionCompatible: compatible,
			versionInfo: compatible ? null : (info ?? null),
			canDispatch: computeCanDispatch(
				state.status,
				state.needsPairing,
				state.isDaemonRunning,
				compatible,
			),
		}));
	},

	setRollbackNotice: (notice: { runId: string; message?: string } | null) => {
		if (!notice) {
			set({ rollbackNotice: null });
			return;
		}
		set({
			rollbackNotice: {
				runId: notice.runId,
				message: notice.message ?? '中止任务失败，已恢复原状态',
				timestamp: Date.now(),
			},
		});
	},

	clearRollbackNotice: () => {
		set({ rollbackNotice: null });
	},

	createStopIntent: (runId: string, atStep?: number, totalSteps?: number) => {
		const stepText = formatStopStep(atStep, totalSteps);
		const intent: LocalStopIntent = {
			runId,
			kind: 'stopping',
			atStep,
			totalSteps,
			stepText,
			timestamp: Date.now(),
		};

		// 1. One frame local state: immediate synchronous write to mutable Map beside event-bus (AC 1)
		setEventBusLocalIntent(intent);

		// 2. Reactively update store in the same execution frame
		set((state) => ({
			activeStopIntents: {
				...state.activeStopIntents,
				[runId]: intent,
			},
		}));

		return intent;
	},

	clearStopIntent: (runId: string) => {
		clearEventBusLocalIntent(runId);
		set((state) => {
			if (!(runId in state.activeStopIntents)) {
				return state;
			}
			const nextIntents = { ...state.activeStopIntents };
			delete nextIntents[runId];
			return { activeStopIntents: nextIntents };
		});
	},

	rollbackStopIntent: (runId: string, message?: string) => {
		const current =
			get().activeStopIntents[runId] ??
			(getEventBusLocalIntent(runId) as LocalStopIntent | undefined);
		clearEventBusLocalIntent(runId);

		const fallbackMessage = current?.stepText
			? `${current.stepText}失败，已恢复原状态`
			: '中止任务失败，已恢复原状态';

		set((state) => {
			const nextIntents = { ...state.activeStopIntents };
			delete nextIntents[runId];
			return {
				activeStopIntents: nextIntents,
				rollbackNotice: {
					runId,
					message: message ?? fallbackMessage,
					timestamp: Date.now(),
				},
			};
		});
	},

	checkVersionCompatibility: (versionInput) => {
		let remoteApiVersion: string | undefined;
		if (typeof versionInput === 'string') {
			remoteApiVersion = versionInput;
		} else if (versionInput && typeof versionInput === 'object') {
			remoteApiVersion = versionInput.apiVersion;
		}

		const actual = remoteApiVersion ? remoteApiVersion.trim() : '';
		const expected = CURRENT_API_VERSION;

		// Normalize v1 vs /api/v1 vs api/v1
		const isMatch =
			actual === expected || actual === `/api/${expected}` || actual === `api/${expected}`;

		if (!isMatch && actual.length > 0) {
			const info: VersionInfo = { expected, actual };
			get().setVersionCompatibility(false, info);
			return {
				compatible: false,
				message: `调度服务版本不兼容（服务端版本: ${actual}，要求版本: ${expected}），请升级客户端应用`,
			};
		}

		get().setVersionCompatibility(true, null);
		return { compatible: true };
	},

	getOfflineErrorMessage: () => {
		const state = get();
		if (!state.isDaemonRunning || state.daemonErrorReason === 'daemon_down') {
			return '电脑上的调度服务未启动';
		}
		if (!state.isVersionCompatible) {
			return '调度服务版本不兼容，请升级应用';
		}
		return '网络连接已断开，正在尝试重连';
	},

	reset: () => {
		set(INITIAL_STATE);
	},
}));

/**
 * Executes optimistic stop pipeline (AC 1, E-157):
 * 1. Writes intent to mutable Map beside event-bus within 1 frame: 「你在第 N/M 步停止」
 * 2. Issues POST abort call without modifying state based on response body (E-157)
 * 3. On failure: clears intent + records topbar rollback notice (E-157)
 */
export async function executeOptimisticStop(options: {
	runId: string;
	atStep?: number;
	totalSteps?: number;
	stopFn: () => Promise<unknown>;
}): Promise<{ ok: boolean; error?: unknown }> {
	const { runId, atStep, totalSteps, stopFn } = options;

	// 1. One frame local state update
	useConnectionStore.getState().createStopIntent(runId, atStep, totalSteps);

	try {
		// 2. Issue POST abort
		await stopFn();
		// State changes await server streaming event (E-157)
		return { ok: true };
	} catch (error) {
		// 3. Roll back on failure with banner notice
		useConnectionStore.getState().rollbackStopIntent(runId);
		return { ok: false, error };
	}
}

/**
 * Bind SSE client instance to connection store (M9-T5 input integration).
 */
export function bindSseClient(client: SseClient): () => void {
	const mapStatus = (status: SseConnectionStatus) => {
		switch (status) {
			case 'connected':
				useConnectionStore.getState().setStatus('online');
				useConnectionStore.getState().setDaemonRunning(true);
				break;
			case 'reconnecting':
			case 'connecting':
				useConnectionStore.getState().setStatus('reconnecting');
				break;
			case 'unauthorized':
				useConnectionStore.getState().setStatus('offline');
				useConnectionStore.getState().setNeedsPairing(true);
				break;
			default:
				useConnectionStore.getState().setStatus('offline');
				break;
		}
	};

	mapStatus(client.getStatus());
	const initialEventId = client.getLastEventId();
	if (initialEventId !== null) {
		useConnectionStore.getState().setLastEventId(initialEventId);
	}

	const unbindStatus = client.onStatusChange((status) => {
		mapStatus(status);
	});

	const unbindEvents = client.subscribe((event) => {
		useConnectionStore.getState().setLastSyncedAt(new Date());
		if (typeof event.id === 'number') {
			useConnectionStore.getState().setLastEventId(event.id);
		}
	});

	return () => {
		unbindStatus();
		unbindEvents();
	};
}
