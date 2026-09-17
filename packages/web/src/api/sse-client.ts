import type { EventEnvelope, EventKind, EventScope } from '../../../shared/src/api/events.ts';
import type { SnapshotResponse } from '../../../shared/src/api/snapshot.ts';
import { resolveBaseUrl } from './base-url.ts';
import {
	SESSION_STORAGE_TOKEN_KEY,
	clearCachedToken,
	getCachedToken,
	httpClient,
} from './http-client.ts';

export const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 15000] as const;
export const MAX_BACKOFF_DELAY_MS = 15000;
export const DEFAULT_SILENCE_TIMEOUT_MS = 60_000;
export const SSE_PATH = '/api/v1/events';

export type SseConnectionStatus =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'reconnecting'
	| 'unauthorized';

export interface SseFilter {
	readonly taskId?: string;
	readonly runId?: string;
	readonly scope?: EventScope;
	readonly kind?: EventKind;
}

export type SseEventListener = (event: EventEnvelope) => void;
export type SseStatusListener = (status: SseConnectionStatus) => void;
export type SseBufferClearListener = () => void;

export interface SseClientOptions {
	getBaseUrl?: () => Promise<string> | string;
	getToken?: () => Promise<string | null> | string | null;
	clientVersion?: string;
	onUnauthorized?: () => void;
	onNeedsPairing?: (needsPairing: boolean) => void;
	onReplayWindowExpired?: (info?: Record<string, unknown>) => Promise<void> | void;
	fetchSnapshot?: () => Promise<SnapshotResponse | null>;
	sleep?: (ms: number) => Promise<void>;
	randomJitter?: () => number;
	silenceTimeoutMs?: number;
	backoffDelays?: readonly number[];
	maxBackoffDelayMs?: number;
	fetchFn?: typeof fetch;
	initialLastEventId?: number | null;
}

export interface SseFrameHandlers {
	onEvent?: (envelope: EventEnvelope) => void;
	onErrorEvent?: (errorPayload: Record<string, unknown>) => void;
	onId?: (id: number) => void;
}

/**
 * Calculates exponential backoff delay with ±20% jitter, capped at 15s (AC 3, E-158).
 * Base delays: [1000, 2000, 4000, 8000, 15000].
 */
export function calculateBackoffDelay(
	attempt: number,
	delays: readonly number[] = BACKOFF_DELAYS,
	maxDelayMs: number = MAX_BACKOFF_DELAY_MS,
	random: () => number = Math.random,
): number {
	const clampedIndex = Math.min(Math.max(0, attempt), delays.length - 1);
	const baseDelay = delays[clampedIndex] ?? maxDelayMs;
	// Jitter ±20%: factor in range [0.8, 1.2]
	const jitterFactor = 0.8 + random() * 0.4;
	const jittered = Math.round(baseDelay * jitterFactor);
	return Math.min(maxDelayMs, jittered);
}

function processSingleFrame(frameBlock: string, handlers: SseFrameHandlers): void {
	const lines = frameBlock.split('\n');
	let eventType: string | undefined;
	let parsedId: number | undefined;
	const dataLines: string[] = [];

	for (const line of lines) {
		// Ignore comment lines (including ":" heartbeat comment frames, AC 1, E-154)
		if (line.startsWith(':')) {
			continue;
		}
		if (line.length === 0) {
			continue;
		}

		const colonIdx = line.indexOf(':');
		let field = line;
		let value = '';
		if (colonIdx !== -1) {
			field = line.slice(0, colonIdx);
			value = line.slice(colonIdx + 1);
			if (value.startsWith(' ')) {
				value = value.slice(1);
			}
		}

		if (field === 'event') {
			eventType = value;
		} else if (field === 'id') {
			const num = Number(value.trim());
			if (Number.isSafeInteger(num) && num >= 0) {
				parsedId = num;
				handlers.onId?.(num);
			}
		} else if (field === 'data') {
			dataLines.push(value);
		}
	}

	if (dataLines.length === 0 && eventType === undefined) {
		return;
	}

	const rawData = dataLines.join('\n');

	if (eventType === 'error') {
		let errorPayload: Record<string, unknown> = {};
		if (rawData) {
			try {
				errorPayload = JSON.parse(rawData) as Record<string, unknown>;
			} catch {
				errorPayload = { raw: rawData };
			}
		}
		handlers.onErrorEvent?.(errorPayload);
		return;
	}

	if (rawData) {
		try {
			const parsed = JSON.parse(rawData) as EventEnvelope;
			if (typeof parsed.id === 'number' && parsedId === undefined) {
				handlers.onId?.(parsed.id);
			}
			handlers.onEvent?.(parsed);
		} catch (err) {
			console.error('Failed to parse SSE data as JSON EventEnvelope:', err);
		}
	}
}

/**
 * Splits streaming text buffer by double newlines into SSE frames and processes completed frames (AC 1).
 * Returns the unparsed remainder to keep across chunk boundaries.
 */
export function parseSseFrames(buffer: string, handlers: SseFrameHandlers): string {
	if (!buffer) {
		return '';
	}

	let working = buffer;
	let trailingCr = '';
	if (working.endsWith('\r')) {
		working = working.slice(0, -1);
		trailingCr = '\r';
	}

	// Normalize CR / CRLF into LF
	working = working.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

	let startIndex = 0;
	let doubleNewlineIndex = working.indexOf('\n\n', startIndex);

	while (doubleNewlineIndex !== -1) {
		const frameBlock = working.slice(startIndex, doubleNewlineIndex);
		startIndex = doubleNewlineIndex + 2;
		if (frameBlock.length > 0) {
			processSingleFrame(frameBlock, handlers);
		}
		doubleNewlineIndex = working.indexOf('\n\n', startIndex);
	}

	return working.slice(startIndex) + trailingCr;
}

export interface SseClient {
	connect(): void;
	disconnect(): void;
	getStatus(): SseConnectionStatus;
	getNeedsPairing(): boolean;
	setNeedsPairing(needs: boolean): void;
	getLastEventId(): number | null;
	setLastEventId(id: number | null): void;
	subscribe(listener: SseEventListener, filter?: SseFilter): () => void;
	subscribeToTask(taskId: string, listener: SseEventListener): () => void;
	subscribeToRun(runId: string, listener: SseEventListener): () => void;
	onStatusChange(listener: SseStatusListener): () => void;
	onClearBuffer(listener: SseBufferClearListener): () => void;
	resetBackoff(): void;
}

interface SubscriberRecord {
	readonly listener: SseEventListener;
	readonly filter?: SseFilter;
}

/**
 * Creates an SSE Client instance managing a single application-wide SSE connection (AC 1-6).
 */
export function createSseClient(options?: SseClientOptions): SseClient {
	const clientVersion = options?.clientVersion ?? '0.0.0';
	const silenceTimeoutMs = options?.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
	const backoffDelays = options?.backoffDelays ?? BACKOFF_DELAYS;
	const maxBackoffDelayMs = options?.maxBackoffDelayMs ?? MAX_BACKOFF_DELAY_MS;
	const randomJitter = options?.randomJitter ?? Math.random;
	const fetchFn = options?.fetchFn ?? globalThis.fetch;

	let status: SseConnectionStatus = 'disconnected';
	let needsPairing = false;
	let lastEventId: number | null = options?.initialLastEventId ?? null;
	let reconnectAttempt = 0;
	let shouldConnect = false;
	let isRunning = false;

	let currentAbortController: AbortController | null = null;
	let cancelSleep: (() => void) | null = null;

	const subscribers = new Set<SubscriberRecord>();
	const statusListeners = new Set<SseStatusListener>();
	const clearBufferListeners = new Set<SseBufferClearListener>();

	function setStatus(nextStatus: SseConnectionStatus): void {
		if (status === nextStatus) {
			return;
		}
		status = nextStatus;
		for (const listener of statusListeners) {
			try {
				listener(nextStatus);
			} catch (err) {
				console.error('Error in SSE status listener:', err);
			}
		}
	}

	async function resolveToken(): Promise<string | null> {
		if (options?.getToken) {
			return options.getToken();
		}
		const cached = getCachedToken();
		if (cached) {
			return cached;
		}
		if (typeof sessionStorage !== 'undefined') {
			return sessionStorage.getItem(SESSION_STORAGE_TOKEN_KEY);
		}
		return null;
	}

	async function resolveUrl(): Promise<string> {
		if (options?.getBaseUrl) {
			const custom = await options.getBaseUrl();
			const clean = custom.replace(/\/+$/, '');
			return `${clean}${SSE_PATH}`;
		}
		const baseUrl = await resolveBaseUrl();
		const clean = baseUrl.replace(/\/+$/, '');
		return `${clean}${SSE_PATH}`;
	}

	function interruptibleSleep(ms: number): Promise<void> {
		if (options?.sleep) {
			return options.sleep(ms);
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				cancelSleep = null;
				resolve();
			}, ms);
			cancelSleep = () => {
				clearTimeout(timer);
				cancelSleep = null;
				resolve();
			};
		});
	}

	function dispatchEvent(event: EventEnvelope): void {
		for (const sub of subscribers) {
			if (sub.filter) {
				if (sub.filter.taskId !== undefined && sub.filter.taskId !== event.taskId) {
					continue;
				}
				if (sub.filter.runId !== undefined && sub.filter.runId !== event.runId) {
					continue;
				}
				if (sub.filter.scope !== undefined && sub.filter.scope !== event.scope) {
					continue;
				}
				if (sub.filter.kind !== undefined && sub.filter.kind !== event.kind) {
					continue;
				}
			}
			try {
				sub.listener(event);
			} catch (err) {
				console.error('Error in SSE subscriber listener:', err);
			}
		}
	}

	function handleUnauthorized(): void {
		shouldConnect = false;
		needsPairing = true;
		setStatus('unauthorized');

		// 401 handling: clear memory token, clear session storage, navigate to #/pair, halt reconnect loop (AC 6, E-156)
		clearCachedToken();
		if (typeof sessionStorage !== 'undefined') {
			sessionStorage.removeItem(SESSION_STORAGE_TOKEN_KEY);
		}

		if (options?.onNeedsPairing) {
			options.onNeedsPairing(true);
		}
		if (options?.onUnauthorized) {
			options.onUnauthorized();
		} else if (typeof window !== 'undefined' && window.location) {
			window.location.hash = '#/pair';
		}
	}

	async function handleReplayWindowExpired(info?: Record<string, unknown>): Promise<void> {
		// 1. Clear local buffer (AC 5, E-153)
		for (const cb of clearBufferListeners) {
			try {
				cb();
			} catch (err) {
				console.error('Error in clearBufferListener:', err);
			}
		}
		if (options?.onReplayWindowExpired) {
			try {
				await options.onReplayWindowExpired(info);
			} catch (err) {
				console.error('Error in onReplayWindowExpired callback:', err);
			}
		}

		// 2. Pull REST full snapshot (AC 5, E-153)
		let snapshot: SnapshotResponse | null = null;
		if (options?.fetchSnapshot) {
			snapshot = await options.fetchSnapshot();
		} else {
			try {
				snapshot = await httpClient.get<SnapshotResponse>('/api/v1/snapshot');
			} catch (err) {
				console.error('Failed to fetch snapshot after replay window expired:', err);
			}
		}

		// 3. Update cursor from latest snapshot event id
		if (snapshot && typeof snapshot.latestEventId === 'number') {
			lastEventId = snapshot.latestEventId;
		} else {
			lastEventId = null;
		}

		// Reset backoff so reconnection resumes immediately from new id
		reconnectAttempt = 0;
	}

	async function runLoop(): Promise<void> {
		if (isRunning) {
			return;
		}
		isRunning = true;

		try {
			while (shouldConnect && !needsPairing) {
				let activeController: AbortController | null = null;
				let silenceTimer: ReturnType<typeof setTimeout> | null = null;

				try {
					setStatus(reconnectAttempt === 0 ? 'connecting' : 'reconnecting');

					activeController = new AbortController();
					currentAbortController = activeController;

					const token = await resolveToken();
					const requestUrl = await resolveUrl();

					const headers = new Headers();
					headers.set('Accept', 'text/event-stream');
					headers.set('Cache-Control', 'no-cache');
					headers.set('X-Agsched-Client', `web/${clientVersion}`);

					// E-08: Auth token if present, zero intranet auth bypass
					if (token) {
						headers.set('Authorization', `Bearer ${token}`);
					}

					// AC 3 & E-158: Retain Last-Event-ID across reconnects
					if (lastEventId !== null && lastEventId >= 0) {
						headers.set('Last-Event-ID', String(lastEventId));
					}

					// AC 4 also covers the handshake: a tunnel or reverse proxy can accept the socket and
					// then stall before any header arrives, so the no-bytes watchdog must already be armed.
					const handshakeTimer = setTimeout(() => {
						activeController?.abort(new Error('SSE handshake timeout: no response bytes received'));
					}, silenceTimeoutMs);

					let response: Response;
					try {
						response = await fetchFn(requestUrl, {
							method: 'GET',
							headers,
							signal: activeController.signal,
						});
					} finally {
						clearTimeout(handshakeTimer);
					}

					if (!shouldConnect) {
						break;
					}

					// 401 Unauthorized handling (AC 6, E-156)
					if (response.status === 401) {
						handleUnauthorized();
						break;
					}

					// 409 Replay Window Expired handling (AC 5, E-153)
					if (response.status === 409) {
						let errorInfo: Record<string, unknown> | undefined;
						try {
							const text = await response.text();
							const parsed = JSON.parse(text) as {
								error?: { code?: string; details?: Record<string, unknown> };
							};
							errorInfo = parsed?.error?.details;
						} catch {
							// Non-JSON response body
						}
						await handleReplayWindowExpired(errorInfo);
						continue;
					}

					if (!response.ok) {
						throw new Error(`SSE HTTP error ${response.status} ${response.statusText}`);
					}

					if (!response.body) {
						throw new Error('SSE response body is empty');
					}

					// Connection successfully established (AC 1, AC 2)
					setStatus('connected');
					reconnectAttempt = 0;

					// 60s silence timeout detection (AC 4)
					const resetSilenceTimer = () => {
						if (silenceTimer) {
							clearTimeout(silenceTimer);
						}
						silenceTimer = setTimeout(() => {
							// 60s with zero bytes received: abort connection to trigger reconnect (AC 4)
							activeController?.abort(new Error('SSE silence timeout: no bytes received in 60s'));
						}, silenceTimeoutMs);
					};

					resetSilenceTimer();

					const reader = response.body.getReader();
					const decoder = new TextDecoder('utf-8');
					let streamBuffer = '';

					try {
						while (shouldConnect && !needsPairing) {
							const { done, value } = await reader.read();
							if (done) {
								break;
							}

							if (value && value.byteLength > 0) {
								// Receiving any bytes (including ":" heartbeat) resets the 60s silence timer (AC 1, AC 4, E-154)
								resetSilenceTimer();

								streamBuffer += decoder.decode(value, { stream: true });

								streamBuffer = parseSseFrames(streamBuffer, {
									onEvent: (eventEnvelope) => {
										if (eventEnvelope.id !== undefined && eventEnvelope.id !== null) {
											lastEventId = eventEnvelope.id;
										}
										dispatchEvent(eventEnvelope);
									},
									onErrorEvent: (errorPayload) => {
										const code =
											(errorPayload?.error as { code?: string })?.code ??
											(errorPayload?.code as string);
										if (code === 'E_UNAUTHORIZED' || code === 'E_DEVICE_REVOKED') {
											handleUnauthorized();
										} else if (code === 'E_REPLAY_WINDOW_EXPIRED') {
											const details = (errorPayload?.error as { details?: Record<string, unknown> })
												?.details;
											void handleReplayWindowExpired(details).catch((err) => {
												console.error('Failed to handle in-stream replay expired:', err);
											});
										}
									},
									onId: (id) => {
										lastEventId = id;
									},
								});

								if (!shouldConnect || needsPairing) {
									break;
								}
							}
						}
					} finally {
						if (silenceTimer) {
							clearTimeout(silenceTimer);
							silenceTimer = null;
						}
						try {
							reader.releaseLock();
						} catch {
							// Reader lock already released
						}
					}
				} catch (err: unknown) {
					if (!shouldConnect || needsPairing) {
						break;
					}
				} finally {
					if (silenceTimer) {
						clearTimeout(silenceTimer);
						silenceTimer = null;
					}
					currentAbortController = null;
				}

				if (!shouldConnect || needsPairing) {
					break;
				}

				// Exponential backoff with ±20% jitter, capped at 15s (AC 3, E-158)
				setStatus('reconnecting');
				const delay = calculateBackoffDelay(
					reconnectAttempt,
					backoffDelays,
					maxBackoffDelayMs,
					randomJitter,
				);
				reconnectAttempt += 1;

				await interruptibleSleep(delay);
			}
		} finally {
			isRunning = false;
			currentAbortController = null;
			if (status !== 'unauthorized') {
				setStatus('disconnected');
			}
		}
	}

	function connect(): void {
		if (shouldConnect && (status === 'connected' || status === 'connecting')) {
			return;
		}
		needsPairing = false;
		shouldConnect = true;
		void runLoop().catch((err) => {
			console.error('Unexpected error in SSE runLoop:', err);
		});
	}

	function disconnect(): void {
		shouldConnect = false;
		if (cancelSleep) {
			cancelSleep();
			cancelSleep = null;
		}
		if (currentAbortController) {
			currentAbortController.abort(new Error('SSE disconnected by client'));
			currentAbortController = null;
		}
		setStatus('disconnected');
	}

	function subscribe(listener: SseEventListener, filter?: SseFilter): () => void {
		const record: SubscriberRecord = { listener, filter };
		subscribers.add(record);
		return () => {
			subscribers.delete(record);
		};
	}

	function subscribeToTask(taskId: string, listener: SseEventListener): () => void {
		return subscribe(listener, { taskId });
	}

	function subscribeToRun(runId: string, listener: SseEventListener): () => void {
		return subscribe(listener, { runId });
	}

	function onStatusChange(listener: SseStatusListener): () => void {
		statusListeners.add(listener);
		try {
			listener(status);
		} catch (err) {
			console.error('Error in immediate status listener invocation:', err);
		}
		return () => {
			statusListeners.delete(listener);
		};
	}

	function onClearBuffer(listener: SseBufferClearListener): () => void {
		clearBufferListeners.add(listener);
		return () => {
			clearBufferListeners.delete(listener);
		};
	}

	return {
		connect,
		disconnect,
		getStatus(): SseConnectionStatus {
			return status;
		},
		getNeedsPairing(): boolean {
			return needsPairing;
		},
		setNeedsPairing(needs: boolean): void {
			needsPairing = needs;
			if (needs) {
				handleUnauthorized();
			}
		},
		getLastEventId(): number | null {
			return lastEventId;
		},
		setLastEventId(id: number | null): void {
			lastEventId = id;
		},
		subscribe,
		subscribeToTask,
		subscribeToRun,
		onStatusChange,
		onClearBuffer,
		resetBackoff(): void {
			reconnectAttempt = 0;
		},
	};
}

/**
 * Default global SSE client instance (AC 2: single connection across the application).
 */
export const sseClient: SseClient = createSseClient();
