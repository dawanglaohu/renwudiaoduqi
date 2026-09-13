import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { FastifyRequest } from 'fastify';
import type { AppContainer } from '../boot/container.ts';
import type { AppError } from '../errors/app-error.ts';

// HTTP status code literals strictly permitted in this file per 08-backend architecture rules
const STATUS_OK = 200;
const STATUS_UNAUTHORIZED = 401;
const STATUS_REPLAY_WINDOW_EXPIRED = 409;

export const SSE_HEARTBEAT_FRAME = ':\n\n';
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export interface SseStreamOptions {
	readonly heartbeatIntervalMs?: number;
}

export interface HandleSseStreamParams {
	readonly request?: FastifyRequest;
	readonly rawRequest: IncomingMessage;
	readonly rawResponse: ServerResponse;
	readonly container: AppContainer;
	readonly options?: SseStreamOptions;
}

export function formatSseEvent(event: EventEnvelope): string {
	const idLine = `id: ${event.id}\n`;
	const eventLine = `event: ${event.kind}\n`;
	const dataLine = `data: ${JSON.stringify(event)}\n\n`;
	return `${idLine}${eventLine}${dataLine}`;
}

function createErrorEnvelopeJson(
	code: string,
	message: string,
	requestId: string,
	details?: Record<string, unknown>,
): string {
	return JSON.stringify({
		error: {
			code,
			message,
			requestId,
			...(details !== undefined ? { details } : {}),
		},
	});
}

function parseLastEventId(rawRequest: IncomingMessage, request?: FastifyRequest): number | null {
	const headerVal = rawRequest.headers['last-event-id'];
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

	if (request?.query && typeof request.query === 'object') {
		const q = request.query as Record<string, unknown>;
		const queryVal = q.lastEventId ?? q.last_event_id;
		if (typeof queryVal === 'string' && queryVal.trim() !== '') {
			const parsed = Number(queryVal.trim());
			return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
		}
		if (typeof queryVal === 'number' && Number.isSafeInteger(queryVal) && queryVal >= 0) {
			return queryVal;
		}
	}

	return null;
}

export function handleSseStream(params: HandleSseStreamParams): void {
	const { request, rawRequest, rawResponse, container, options } = params;
	const requestId =
		request?.id || (rawRequest.headers['x-request-id'] as string | undefined) || 'unknown';

	// 1. Authentication check (E-156): SSE stream requires authenticated device
	const actorDeviceId = request?.actorDeviceId ?? null;
	if (!actorDeviceId) {
		rawResponse.writeHead(STATUS_UNAUTHORIZED, {
			'Content-Type': 'application/json; charset=utf-8',
		});
		rawResponse.end(
			createErrorEnvelopeJson(
				'E_UNAUTHORIZED',
				'Authentication required for SSE event stream.',
				requestId,
			),
		);
		return;
	}

	// Verify device exists and is not revoked
	const device = container.repos.devices?.findById(actorDeviceId);
	if (!device || device.revoked_at) {
		rawResponse.writeHead(STATUS_UNAUTHORIZED, {
			'Content-Type': 'application/json; charset=utf-8',
		});
		rawResponse.end(
			createErrorEnvelopeJson('E_DEVICE_REVOKED', 'Device token has been revoked.', requestId),
		);
		return;
	}

	// 2. Replay check with Last-Event-ID (E-153)
	const parsedLastEventId = parseLastEventId(rawRequest, request);
	let replayEvents: readonly EventEnvelope[] = [];

	if (parsedLastEventId !== null) {
		const replayResult = container.events.ringBuffer.getEventsSince(parsedLastEventId);
		if (!replayResult.ok) {
			// Window expired: return 409 and close stream, no silent drop
			rawResponse.writeHead(STATUS_REPLAY_WINDOW_EXPIRED, {
				'Content-Type': 'application/json; charset=utf-8',
			});
			rawResponse.end(
				createErrorEnvelopeJson(
					'E_REPLAY_WINDOW_EXPIRED',
					`Replay window expired for Last-Event-ID ${parsedLastEventId}. Oldest available ID is ${replayResult.minId}.`,
					requestId,
					{
						minId: replayResult.minId,
						requestedLastEventId: replayResult.requestedLastEventId,
					},
				),
			);
			return;
		}
		replayEvents = replayResult.events;
	}

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

	// 3. Subscribe to event bus before writing replay to prevent missing concurrent events
	unsubscribeBus = container.events.bus.subscribe((event: EventEnvelope) => {
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

	// 4. Register connection for revocation notification (E-156)
	unregisterDeviceConnection = container.services.pairing.registerConnection(
		actorDeviceId,
		(revocationError: AppError) => {
			if (isClosed) return;
			cleanup();

			if (!rawResponse.headersSent) {
				rawResponse.writeHead(STATUS_UNAUTHORIZED, {
					'Content-Type': 'application/json; charset=utf-8',
				});
				rawResponse.end(
					createErrorEnvelopeJson(revocationError.code, revocationError.message, requestId),
				);
			} else {
				// Headers already sent: write error event frame and actively close the stream
				try {
					rawResponse.write(
						`event: error\ndata: ${createErrorEnvelopeJson(
							revocationError.code,
							revocationError.message,
							requestId,
						)}\n\n`,
					);
					rawResponse.end();
				} catch {
					// Connection might already be broken
				}
			}
		},
	);

	// 5. Send SSE response headers (AC 1, E-154)
	rawResponse.writeHead(STATUS_OK, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});

	if (rawResponse.socket) {
		rawResponse.socket.setNoDelay(true);
	}

	if (typeof rawResponse.flushHeaders === 'function') {
		rawResponse.flushHeaders();
	}

	// 6. Flush replayed events (AC 2, E-153)
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

	// 7. Setup 15-second heartbeat comment line (AC 1, E-154)
	const intervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
	heartbeatTimer = setInterval(() => {
		if (isClosed) return;

		// Periodically verify device active status (E-156 defense-in-depth)
		const currentDevice = container.repos.devices?.findById(actorDeviceId);
		if (!currentDevice || currentDevice.revoked_at) {
			cleanup();
			try {
				rawResponse.write(
					`event: error\ndata: ${createErrorEnvelopeJson(
						'E_DEVICE_REVOKED',
						'Device token has been revoked.',
						requestId,
					)}\n\n`,
				);
				rawResponse.end();
			} catch {
				// Socket closed
			}
			return;
		}

		try {
			rawResponse.write(SSE_HEARTBEAT_FRAME);
		} catch {
			cleanup();
		}
	}, intervalMs);

	// 8. Handle socket/response disconnect
	rawRequest.on('close', cleanup);
	rawResponse.on('close', cleanup);
	rawResponse.on('error', cleanup);
}
