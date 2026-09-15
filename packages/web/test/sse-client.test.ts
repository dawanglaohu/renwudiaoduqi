import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../../shared/src/api/events.ts';
import type { SnapshotResponse } from '../../shared/src/api/snapshot.ts';
import { clearCachedToken, setCachedToken } from '../src/api/http-client.ts';
import {
	BACKOFF_DELAYS,
	DEFAULT_SILENCE_TIMEOUT_MS,
	MAX_BACKOFF_DELAY_MS,
	SSE_PATH,
	calculateBackoffDelay,
	createSseClient,
	parseSseFrames,
} from '../src/api/sse-client.ts';

function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		async start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

const SAMPLE_EVENT_1: EventEnvelope = {
	id: 101,
	ts: '2026-09-15T08:00:00.000Z',
	runId: 'run-1',
	taskId: 'task-1',
	scope: 'run',
	kind: 'run.started',
	seq: 0,
	actorDeviceId: 'dev-001',
	payload: { runId: 'run-1' },
};

const SAMPLE_EVENT_2: EventEnvelope = {
	id: 102,
	ts: '2026-09-15T08:00:01.000Z',
	runId: 'run-2',
	taskId: 'task-2',
	scope: 'run',
	kind: 'run.started',
	seq: 0,
	actorDeviceId: 'dev-001',
	payload: { runId: 'run-2' },
};

describe('M9-T5 SSE Client (sse-client.ts)', () => {
	beforeEach(() => {
		clearCachedToken();
	});

	afterEach(() => {
		clearCachedToken();
	});

	describe('Pure functions & Backoff calculation (AC 3, E-158)', () => {
		it('calculates backoff delay adhering to [1000, 2000, 4000, 8000, 15000] with ±20% jitter and 15s ceiling', () => {
			expect(BACKOFF_DELAYS).toEqual([1000, 2000, 4000, 8000, 15000]);
			expect(MAX_BACKOFF_DELAY_MS).toBe(15000);
			expect(DEFAULT_SILENCE_TIMEOUT_MS).toBe(60000);
			expect(SSE_PATH).toBe('/api/v1/events');

			// Zero jitter (random returns 0.5 -> multiplier 1.0)
			const noJitter = () => 0.5;
			expect(calculateBackoffDelay(0, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, noJitter)).toBe(1000);
			expect(calculateBackoffDelay(1, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, noJitter)).toBe(2000);
			expect(calculateBackoffDelay(2, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, noJitter)).toBe(4000);
			expect(calculateBackoffDelay(3, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, noJitter)).toBe(8000);
			expect(calculateBackoffDelay(4, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, noJitter)).toBe(15000);
			expect(calculateBackoffDelay(5, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, noJitter)).toBe(15000);

			// Minimum jitter (-20% -> factor 0.8)
			const minJitter = () => 0.0;
			expect(calculateBackoffDelay(0, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, minJitter)).toBe(800);
			expect(calculateBackoffDelay(1, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, minJitter)).toBe(1600);
			expect(calculateBackoffDelay(2, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, minJitter)).toBe(3200);
			expect(calculateBackoffDelay(3, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, minJitter)).toBe(6400);
			expect(calculateBackoffDelay(4, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, minJitter)).toBe(12000);

			// Maximum jitter (+20% -> factor 1.2, capped at 15000)
			const maxJitter = () => 1.0;
			expect(calculateBackoffDelay(0, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, maxJitter)).toBe(1200);
			expect(calculateBackoffDelay(1, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, maxJitter)).toBe(2400);
			expect(calculateBackoffDelay(2, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, maxJitter)).toBe(4800);
			expect(calculateBackoffDelay(3, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, maxJitter)).toBe(9600);
			// 15000 * 1.2 = 18000 -> must cap at 15000
			expect(calculateBackoffDelay(4, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, maxJitter)).toBe(15000);
			expect(calculateBackoffDelay(10, BACKOFF_DELAYS, MAX_BACKOFF_DELAY_MS, maxJitter)).toBe(
				15000,
			);
		});

		it('parseSseFrames ignores comment and heartbeat lines (AC 1, E-154)', () => {
			const events: EventEnvelope[] = [];
			const onEvent = (e: EventEnvelope) => events.push(e);

			// Heartbeat comment frame ":\n\n"
			const remainder1 = parseSseFrames(':\n\n', { onEvent });
			expect(remainder1).toBe('');
			expect(events.length).toBe(0);

			// Comment with text ": ping keepalive\n\n"
			const remainder2 = parseSseFrames(': ping keepalive\n\n', { onEvent });
			expect(remainder2).toBe('');
			expect(events.length).toBe(0);
		});

		it('parseSseFrames parses complete events and retains unparsed remainder across chunk boundaries', () => {
			const events: EventEnvelope[] = [];
			const ids: number[] = [];
			const onEvent = (e: EventEnvelope) => events.push(e);
			const onId = (id: number) => ids.push(id);

			const fullFrame = `id: 101\nevent: run.started\ndata: ${JSON.stringify(SAMPLE_EVENT_1)}\n\n`;

			// Pass in two halves of the frame
			const half1 = fullFrame.slice(0, 30);
			const half2 = fullFrame.slice(30);

			const remainder1 = parseSseFrames(half1, { onEvent, onId });
			expect(events.length).toBe(0);
			expect(remainder1).toBe(half1);

			const remainder2 = parseSseFrames(remainder1 + half2, { onEvent, onId });
			expect(remainder2).toBe('');
			expect(events.length).toBe(1);
			expect(events[0]).toEqual(SAMPLE_EVENT_1);
			expect(ids).toEqual([101]);
		});
	});

	describe('Connection & Authentication (AC 1, E-08, E-154)', () => {
		it('attaches Authorization header when token is present and does not have intranet bypass (E-08)', async () => {
			let interceptedHeaders: Headers | null = null;

			const mockFetch: typeof fetch = async (_input, init) => {
				interceptedHeaders = new Headers(init?.headers);
				return new Response(createMockStream([':\n\n']), {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' },
				});
			};

			const client = createSseClient({
				getBaseUrl: () => 'http://192.168.1.100:7817',
				getToken: () => 'device-token-secret-123',
				clientVersion: '1.2.3',
				fetchFn: mockFetch,
			});

			client.connect();

			// Allow loop to tick
			await new Promise((r) => setTimeout(r, 10));
			client.disconnect();

			expect(interceptedHeaders).not.toBeNull();
			const headers = interceptedHeaders as Headers | null;
			expect(headers?.get('Authorization')).toBe('Bearer device-token-secret-123');
			expect(headers?.get('Accept')).toBe('text/event-stream');
			expect(headers?.get('Cache-Control')).toBe('no-cache');
			expect(headers?.get('X-Agsched-Client')).toBe('web/1.2.3');
		});

		it('omits Authorization header when token is absent (E-08)', async () => {
			let interceptedHeaders: Headers | null = null;

			const mockFetch: typeof fetch = async (_input, init) => {
				interceptedHeaders = new Headers(init?.headers);
				return new Response(createMockStream([':\n\n']), {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' },
				});
			};

			const client = createSseClient({
				getBaseUrl: () => 'http://localhost:7817',
				getToken: () => null,
				fetchFn: mockFetch,
			});

			client.connect();
			await new Promise((r) => setTimeout(r, 10));
			client.disconnect();

			expect(interceptedHeaders).not.toBeNull();
			const headers = interceptedHeaders as Headers | null;
			expect(headers?.has('Authorization')).toBe(false);
		});
	});

	describe('Single connection & Dispatching (AC 2)', () => {
		it('maintains a single connection and dispatches events by taskId and runId', async () => {
			let fetchCallCount = 0;

			const event1Chunk = `id: 101\nevent: run.started\ndata: ${JSON.stringify(SAMPLE_EVENT_1)}\n\n`;
			const event2Chunk = `id: 102\nevent: run.started\ndata: ${JSON.stringify(SAMPLE_EVENT_2)}\n\n`;

			const mockFetch: typeof fetch = async () => {
				fetchCallCount += 1;
				return new Response(createMockStream([event1Chunk, event2Chunk]), {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' },
				});
			};

			const client = createSseClient({
				getBaseUrl: () => 'http://localhost:7817',
				fetchFn: mockFetch,
			});

			const globalEvents: EventEnvelope[] = [];
			const task1Events: EventEnvelope[] = [];
			const run2Events: EventEnvelope[] = [];

			client.subscribe((e) => globalEvents.push(e));
			client.subscribeToTask('task-1', (e) => task1Events.push(e));
			client.subscribeToRun('run-2', (e) => run2Events.push(e));

			// Call connect multiple times
			client.connect();
			client.connect();

			await new Promise((r) => setTimeout(r, 20));
			client.disconnect();

			// AC 2: Only 1 fetch connection opened across the application
			expect(fetchCallCount).toBe(1);

			// Dispatched according to filters
			expect(globalEvents.length).toBe(2);
			expect(task1Events.length).toBe(1);
			expect(task1Events[0]?.taskId).toBe('task-1');
			expect(run2Events.length).toBe(1);
			expect(run2Events[0]?.runId).toBe('run-2');
		});
	});

	describe('Exponential backoff & Last-Event-ID retention (AC 3, E-158)', () => {
		it('preserves Last-Event-ID across reconnects and sends it in the header', async () => {
			const requestedLastEventIds: (string | null)[] = [];
			let attempt = 0;

			const mockFetch: typeof fetch = async (_input, init) => {
				attempt += 1;
				const headers = new Headers(init?.headers);
				requestedLastEventIds.push(headers.get('Last-Event-ID'));

				if (attempt === 1) {
					// First attempt streams event 101, then closes
					const chunk = `id: 101\nevent: run.started\ndata: ${JSON.stringify(SAMPLE_EVENT_1)}\n\n`;
					return new Response(createMockStream([chunk]), {
						status: 200,
						headers: { 'Content-Type': 'text/event-stream' },
					});
				}

				// Second attempt streams event 102
				const chunk = `id: 102\nevent: run.started\ndata: ${JSON.stringify(SAMPLE_EVENT_2)}\n\n`;
				return new Response(createMockStream([chunk]), {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' },
				});
			};

			const sleepDelays: number[] = [];
			const client = createSseClient({
				getBaseUrl: () => 'http://localhost:7817',
				fetchFn: mockFetch,
				sleep: async (ms) => {
					sleepDelays.push(ms);
					await new Promise((r) => setTimeout(r, 5));
				},
				randomJitter: () => 0.5,
			});

			client.connect();

			const startTime = Date.now();
			while (attempt < 2 && Date.now() - startTime < 1000) {
				await new Promise((r) => setTimeout(r, 10));
			}
			client.disconnect();

			expect(attempt).toBeGreaterThanOrEqual(2);
			expect(requestedLastEventIds[0]).toBeNull();
			// Second attempt retained Last-Event-ID 101!
			expect(requestedLastEventIds[1]).toBe('101');
			expect(client.getLastEventId()).toBe(102);
		});
	});

	describe('60s silence timeout (AC 4, E-154)', () => {
		it('aborts dead connection when no bytes are received within silence timeout', async () => {
			let abortTriggered = false;
			let callCount = 0;

			const mockFetch: typeof fetch = async (_input, init) => {
				callCount += 1;
				const signal = init?.signal;

				if (callCount === 1) {
					// Stream that sends nothing and hangs until aborted
					return new Response(
						new ReadableStream({
							start(controller) {
								signal?.addEventListener('abort', () => {
									abortTriggered = true;
									try {
										controller.error(new Error('Aborted'));
									} catch {
										// ignore
									}
								});
							},
						}),
						{ status: 200, headers: { 'Content-Type': 'text/event-stream' } },
					);
				}

				// Second attempt succeeds with a heartbeat
				return new Response(createMockStream([':\n\n']), {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' },
				});
			};

			const client = createSseClient({
				getBaseUrl: () => 'http://localhost:7817',
				fetchFn: mockFetch,
				silenceTimeoutMs: 30, // short silence timeout for test
				sleep: async () => new Promise((r) => setTimeout(r, 5)),
			});

			client.connect();

			const startTime = Date.now();
			while (callCount < 2 && Date.now() - startTime < 1000) {
				await new Promise((r) => setTimeout(r, 15));
			}
			client.disconnect();

			expect(abortTriggered).toBe(true);
			expect(callCount).toBeGreaterThanOrEqual(2);
		});

		it('heartbeat comments reset silence timer and prevent abort (AC 1, AC 4, E-154)', async () => {
			let silenceAbortTriggered = false;

			const mockFetch: typeof fetch = async (_input, init) => {
				const signal = init?.signal;
				signal?.addEventListener('abort', () => {
					if ((signal?.reason as Error)?.message?.includes('silence timeout')) {
						silenceAbortTriggered = true;
					}
				});

				// Heartbeat chunks sent every 20ms while silence timeout is 40ms
				return new Response(
					new ReadableStream({
						async start(controller) {
							const encoder = new TextEncoder();
							for (let i = 0; i < 4; i++) {
								await new Promise((r) => setTimeout(r, 20));
								controller.enqueue(encoder.encode(':\n\n'));
							}
							// Keep stream open until test disconnects
							await new Promise((r) => setTimeout(r, 200));
							try {
								controller.close();
							} catch {
								// ignore
							}
						},
					}),
					{ status: 200, headers: { 'Content-Type': 'text/event-stream' } },
				);
			};

			const client = createSseClient({
				getBaseUrl: () => 'http://localhost:7817',
				fetchFn: mockFetch,
				silenceTimeoutMs: 40,
			});

			client.connect();

			await new Promise((r) => setTimeout(r, 70));
			client.disconnect();

			// Heartbeat kept the connection alive, so no silence timeout abort was triggered!
			expect(silenceAbortTriggered).toBe(false);
		});
	});

	describe('Replay window expired handling (AC 5, E-153)', () => {
		it('clears buffer, pulls REST snapshot, and resumes from latest event id on 409 handshake', async () => {
			let bufferCleared = false;
			let snapshotPulled = false;
			let attempt = 0;
			const lastEventIdsSent: (string | null)[] = [];

			const mockSnapshot: SnapshotResponse = {
				documents: [],
				batches: [],
				tasks: [],
				runs: [],
				gates: [],
				agents: [],
				latestEventId: 500,
			};

			const mockFetch: typeof fetch = async (_input, init) => {
				attempt += 1;
				const headers = new Headers(init?.headers);
				lastEventIdsSent.push(headers.get('Last-Event-ID'));

				if (attempt === 1) {
					// 409 Replay Window Expired
					const errorEnvelope = {
						error: {
							code: 'E_REPLAY_WINDOW_EXPIRED',
							message: 'Replay window expired for Last-Event-ID 10.',
							details: { minId: 450, requestedLastEventId: 10 },
						},
					};
					return new Response(JSON.stringify(errorEnvelope), {
						status: 409,
						headers: { 'Content-Type': 'application/json' },
					});
				}

				// Next attempt after snapshot
				const chunk = `id: 501\nevent: run.started\ndata: ${JSON.stringify({ ...SAMPLE_EVENT_1, id: 501 })}\n\n`;
				return new Response(createMockStream([chunk]), {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' },
				});
			};

			const client = createSseClient({
				getBaseUrl: () => 'http://localhost:7817',
				fetchFn: mockFetch,
				initialLastEventId: 10,
				fetchSnapshot: async () => {
					snapshotPulled = true;
					return mockSnapshot;
				},
			});

			client.onClearBuffer(() => {
				bufferCleared = true;
			});

			client.connect();

			const startTime = Date.now();
			while ((!bufferCleared || !snapshotPulled || attempt < 2) && Date.now() - startTime < 1000) {
				await new Promise((r) => setTimeout(r, 10));
			}
			client.disconnect();

			expect(bufferCleared).toBe(true);
			expect(snapshotPulled).toBe(true);
			expect(lastEventIdsSent[0]).toBe('10');
			// Reconnection after 409 used snapshot's latestEventId 500!
			expect(lastEventIdsSent[1]).toBe('500');
			expect(client.getLastEventId()).toBe(501);
		});

		it('handles in-stream E_REPLAY_WINDOW_EXPIRED error frame', async () => {
			let bufferCleared = false;
			let snapshotPulled = false;

			const inStreamError = `event: error\ndata: ${JSON.stringify({
				error: { code: 'E_REPLAY_WINDOW_EXPIRED', message: 'Replay expired' },
			})}\n\n`;

			const mockFetch: typeof fetch = async () => {
				return new Response(createMockStream([inStreamError]), {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' },
				});
			};

			const client = createSseClient({
				getBaseUrl: () => 'http://localhost:7817',
				fetchFn: mockFetch,
				fetchSnapshot: async () => {
					snapshotPulled = true;
					return {
						documents: [],
						batches: [],
						tasks: [],
						runs: [],
						gates: [],
						agents: [],
						latestEventId: 999,
					};
				},
			});

			client.onClearBuffer(() => {
				bufferCleared = true;
			});

			client.connect();

			const startTime = Date.now();
			while ((!bufferCleared || !snapshotPulled) && Date.now() - startTime < 1000) {
				await new Promise((r) => setTimeout(r, 10));
			}
			client.disconnect();

			expect(bufferCleared).toBe(true);
			expect(snapshotPulled).toBe(true);
			expect(client.getLastEventId()).toBe(999);
		});
	});

	describe('401 Unauthorized handling (AC 6, E-156)', () => {
		it('halts reconnection loop immediately and sets needsPairing on 401 handshake response', async () => {
			let fetchCount = 0;
			let unauthorizedCalled = false;
			let needsPairingValue: boolean | null = null;

			setCachedToken('expired-device-token');

			const mockFetch: typeof fetch = async () => {
				fetchCount += 1;
				return new Response(
					JSON.stringify({
						error: { code: 'E_UNAUTHORIZED', message: 'Authentication required' },
					}),
					{ status: 401, headers: { 'Content-Type': 'application/json' } },
				);
			};

			const client = createSseClient({
				getBaseUrl: () => 'http://localhost:7817',
				fetchFn: mockFetch,
				onUnauthorized: () => {
					unauthorizedCalled = true;
				},
				onNeedsPairing: (needs) => {
					needsPairingValue = needs;
				},
			});

			client.connect();

			const startTime = Date.now();
			while (client.getStatus() !== 'unauthorized' && Date.now() - startTime < 1000) {
				await new Promise((r) => setTimeout(r, 10));
			}

			// AC 6: 收到 401 立即停止退避循环并置 needsPairing
			expect(fetchCount).toBe(1);
			expect(unauthorizedCalled).toBe(true);
			expect(needsPairingValue).toBe(true);
			expect(client.getNeedsPairing()).toBe(true);
			expect(client.getStatus()).toBe('unauthorized');
		});

		it('halts reconnection loop on in-stream revocation error frame (E-156)', async () => {
			let fetchCount = 0;
			let unauthorizedCalled = false;

			const inStreamRevoke = `event: error\ndata: ${JSON.stringify({
				error: { code: 'E_DEVICE_REVOKED', message: 'Device was revoked' },
			})}\n\n`;

			const mockFetch: typeof fetch = async () => {
				fetchCount += 1;
				return new Response(createMockStream([inStreamRevoke]), {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' },
				});
			};

			const client = createSseClient({
				getBaseUrl: () => 'http://localhost:7817',
				fetchFn: mockFetch,
				onUnauthorized: () => {
					unauthorizedCalled = true;
				},
			});

			client.connect();

			const startTime = Date.now();
			while (client.getStatus() !== 'unauthorized' && Date.now() - startTime < 1000) {
				await new Promise((r) => setTimeout(r, 10));
			}

			expect(fetchCount).toBe(1);
			expect(unauthorizedCalled).toBe(true);
			expect(client.getNeedsPairing()).toBe(true);
			expect(client.getStatus()).toBe('unauthorized');
		});
	});

	describe('Manual controls & status listeners', () => {
		it('transitions through status states and disconnects cleanly', () => {
			const statuses: string[] = [];
			const client = createSseClient();

			client.onStatusChange((s) => statuses.push(s));
			expect(client.getStatus()).toBe('disconnected');

			client.setLastEventId(42);
			expect(client.getLastEventId()).toBe(42);

			client.resetBackoff();
			client.disconnect();
			expect(client.getStatus()).toBe('disconnected');
		});
	});
});
