import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { RingBuffer } from '../events/ring-buffer.ts';
import { isAllowedShellOrigin } from './plugins/20-security-headers.ts';

export const SSE_HEARTBEAT_FRAME = ':\n\n';
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export interface SseStreamOptions {
	readonly heartbeatIntervalMs?: number;
}

export interface PairingConnectionRegistrar {
	registerConnection(deviceId: string, onRevoke: (error: AppError) => void): () => void;
}

export interface HandleSseStreamParams {
	readonly rawRequest: IncomingMessage;
	readonly rawResponse: ServerResponse;
	readonly requestId: string;
	readonly actorDeviceId: string;
	readonly bus: EventBus;
	readonly pairingService: PairingConnectionRegistrar;
	readonly parsedLastEventId?: number | null;
	readonly replayEvents?: readonly EventEnvelope[];
	readonly options?: SseStreamOptions;
}

export function formatSseEvent(event: EventEnvelope): string {
	const idLine = `id: ${event.id}\n`;
	const eventLine = `event: ${event.kind}\n`;
	const dataLine = `data: ${JSON.stringify(event)}\n\n`;
	return `${idLine}${eventLine}${dataLine}`;
}

export function parseLastEventId(headerVal: string | string[] | undefined): number | null {
	if (typeof headerVal === 'string' && headerVal.trim() !== '') {
		const parsed = Number(headerVal.trim());
		return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
	}
	if (
		Array.isArray(headerVal) &&
		headerVal.length > 0 &&
		typeof headerVal[0] === 'string' &&
		headerVal[0].trim() !== ''
	) {
		const parsed = Number(headerVal[0].trim());
		return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
	}
	return null;
}

export function resolveReplayEvents(
	ringBuffer: RingBuffer,
	lastEventIdHeader: string | string[] | undefined,
): {
	readonly parsedLastEventId: number | null;
	readonly replayEvents: readonly EventEnvelope[];
} {
	const parsedLastEventId = parseLastEventId(lastEventIdHeader);
	if (parsedLastEventId === null) {
		return { parsedLastEventId: null, replayEvents: [] };
	}

	const replayResult = ringBuffer.getEventsSince(parsedLastEventId);
	if (!replayResult.ok) {
		throw new AppError(
			'E_REPLAY_WINDOW_EXPIRED',
			`Replay window expired for Last-Event-ID ${parsedLastEventId}. Oldest available ID is ${replayResult.minId}.`,
			{
				details: {
					minId: replayResult.minId,
					requestedLastEventId: replayResult.requestedLastEventId,
				},
			},
		);
	}

	return {
		parsedLastEventId,
		replayEvents: replayResult.events,
	};
}

export function handleSseStream(params: HandleSseStreamParams): void {
	const {
		rawRequest,
		rawResponse,
		requestId,
		actorDeviceId,
		bus,
		pairingService,
		parsedLastEventId,
		replayEvents = [],
		options,
	} = params;

	// Connection state for this specific client (E-155)
	let isClosed = false;
	let cursor = parsedLastEventId ?? 0;
	const pendingQueue: EventEnvelope[] = [];
	let isReplaying = true;

	// Helper for resource cleanup
	let unsubscribeBus: (() => void) | undefined;
	let unregisterDeviceConnection: (() => void) | undefined;
	let heartbeatTimer: NodeJS.Timeout | undefined;

	function cleanup(): void {
		if (isClosed) return;
		isClosed = true;

		if (heartbeatTimer !== undefined) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		}
		if (unsubscribeBus) {
			unsubscribeBus();
			unsubscribeBus = undefined;
		}
		if (unregisterDeviceConnection) {
			unregisterDeviceConnection();
			unregisterDeviceConnection = undefined;
		}
	}

	// 1. Subscribe to event bus before writing replay to prevent missing concurrent events
	unsubscribeBus = bus.subscribe((event: EventEnvelope) => {
		if (isClosed) return;
		if (isReplaying) {
			pendingQueue.push(event);
		} else {
			// Each connection maintains its own cursor and deduplication (E-155)
			if (event.id > cursor) {
				cursor = event.id;
				try {
					rawResponse.write(formatSseEvent(event));
				} catch {
					cleanup();
				}
			}
		}
	});

	// 2. Register connection for revocation notification (E-156)
	unregisterDeviceConnection = pairingService.registerConnection(
		actorDeviceId,
		(revocationError: AppError) => {
			if (isClosed) return;
			cleanup();

			// Headers already sent for live stream: write error event frame and actively close the stream
			try {
				const errorPayload = JSON.stringify({
					error: {
						code: revocationError.code,
						message: revocationError.message,
						requestId,
					},
				});
				rawResponse.write(`event: error\ndata: ${errorPayload}\n\n`);
				rawResponse.end();
			} catch {
				// Connection might already be broken
			}
		},
	);

	// 3. Send SSE response headers (AC 1, E-154) without manual status literals
	rawResponse.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
	rawResponse.setHeader('Cache-Control', 'no-cache, no-transform');
	rawResponse.setHeader('Connection', 'keep-alive');
	rawResponse.setHeader('X-Accel-Buffering', 'no');
	const origin = rawRequest.headers.origin;
	if (origin && isAllowedShellOrigin(origin)) {
		rawResponse.setHeader('Access-Control-Allow-Origin', origin);
		rawResponse.setHeader('Access-Control-Allow-Credentials', 'true');
	}

	if (rawResponse.socket) {
		rawResponse.socket.setNoDelay(true);
	}

	if (typeof rawResponse.flushHeaders === 'function') {
		rawResponse.flushHeaders();
	}

	// 4. Flush replayed events (AC 2, E-153)
	for (const event of replayEvents) {
		if (event.id > cursor) {
			cursor = event.id;
			rawResponse.write(formatSseEvent(event));
		}
	}

	// Flush pending queue accumulated during replay preparation
	for (const event of pendingQueue) {
		if (event.id > cursor) {
			cursor = event.id;
			rawResponse.write(formatSseEvent(event));
		}
	}
	pendingQueue.length = 0;
	isReplaying = false;

	// 5. Setup 15-second heartbeat comment line (AC 1, E-154)
	const intervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
	heartbeatTimer = setInterval(() => {
		if (isClosed) return;

		try {
			rawResponse.write(SSE_HEARTBEAT_FRAME);
		} catch {
			cleanup();
		}
	}, intervalMs);

	// 6. Handle socket/response disconnect
	rawRequest.on('close', cleanup);
	rawResponse.on('close', cleanup);
	rawResponse.on('error', cleanup);
}
