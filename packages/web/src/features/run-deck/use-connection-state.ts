/**
 * packages/web/src/features/run-deck/use-connection-state.ts
 *
 * M9-T11: Connection state wiring and version checking (07-前端架构 / AC 2-4, E-04, E-12, E-14).
 *
 * Architecture rules:
 * - Features layer is the ONLY layer allowed to import `src/api` and mutate store from external events (07:72).
 * - Reuses the single global application SSE client (sseClient), strictly no duplicate connections (07:342).
 * - Maps SSE client statuses to connection-store's 4 setters:
 *   - connected -> setStatus('online') (triggers resync handler on reconnect, E-12)
 *   - reconnecting / connecting -> setStatus('reconnecting')
 *   - disconnected -> setStatus('offline')
 *   - unauthorized -> setStatus('offline') + setNeedsPairing(true) (07:390)
 *   - event received -> setLastEventId(event.id) + setLastSyncedAt(now)
 * - Detects API version mismatch gracefully without throwing bottom-layer errors (AC 4, E-14).
 */

import { CURRENT_API_VERSION } from '@agent-scheduler/shared/api/system';
import { useEffect } from 'react';
import { type SseClient, type SseConnectionStatus, sseClient } from '../../api/sse-client.ts';
import { useCanDispatch, useConnectionStore } from '../../store/connection-store.ts';

export interface VersionInfo {
	readonly expected: string;
	readonly actual?: string;
}

export interface VersionCheckResult {
	readonly compatible: boolean;
	readonly message?: string;
	readonly info?: VersionInfo;
}

/**
 * Validate remote API version against expected CURRENT_API_VERSION (AC 4, E-14).
 * Never throws; returns compatibility result and graceful prompt message.
 */
export function checkVersionCompatibility(
	versionInput: string | { apiVersion?: string } | null | undefined,
): VersionCheckResult {
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
		return {
			compatible: false,
			message: `调度服务版本不兼容（服务端版本: ${actual}，要求版本: ${expected}），请升级客户端应用`,
			info,
		};
	}

	return { compatible: true, info: { expected } };
}

/**
 * Bind SSE client connection and event stream to connection-store setters (AC 2, E-12).
 * Returns an unbind cleanup function.
 */
export function bindConnectionState(client: SseClient = sseClient): () => void {
	const mapStatus = (status: SseConnectionStatus) => {
		const store = useConnectionStore.getState();
		switch (status) {
			case 'connected':
				store.setStatus('online');
				break;
			case 'reconnecting':
			case 'connecting':
				store.setStatus('reconnecting');
				break;
			case 'unauthorized':
				store.setStatus('offline');
				store.setNeedsPairing(true);
				break;
			default:
				store.setStatus('offline');
				break;
		}
	};

	// 1. Initial status synchronization
	mapStatus(client.getStatus());
	const initialLastEventId = client.getLastEventId();
	if (initialLastEventId !== null) {
		useConnectionStore.getState().setLastEventId(initialLastEventId);
	}

	// 2. Status change listener
	const unbindStatus = client.onStatusChange((status) => {
		mapStatus(status);
	});

	// 3. Event listener for lastEventId and lastSyncedAt
	const unbindEvents = client.subscribe((event) => {
		const store = useConnectionStore.getState();
		store.setLastSyncedAt(new Date().toISOString());
		if (typeof event.id === 'number') {
			store.setLastEventId(event.id);
		}
	});

	return () => {
		unbindStatus();
		unbindEvents();
	};
}

/**
 * Hook to bind SSE state to connection store and read connection state reactively.
 */
export function useConnectionState(client: SseClient = sseClient) {
	useEffect(() => {
		return bindConnectionState(client);
	}, [client]);

	const status = useConnectionStore((s) => s.status);
	const lastSyncedAt = useConnectionStore((s) => s.lastSyncedAt);
	const lastEventId = useConnectionStore((s) => s.lastEventId);
	const needsPairing = useConnectionStore((s) => s.needsPairing);
	const canDispatch = useCanDispatch();

	return {
		status,
		lastSyncedAt,
		lastEventId,
		needsPairing,
		canDispatch,
	};
}
