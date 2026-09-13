import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import type { AppContainer } from '../../src/boot/container.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import type { AppError } from '../../src/errors/app-error.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import { createHttpServer } from '../../src/http/server.ts';
import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	SSE_HEARTBEAT_FRAME,
	formatSseEvent,
	handleSseStream,
} from '../../src/http/sse.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';

interface MockResponseState {
	statusCode?: number;
	headers: Record<string, string>;
	chunks: string[];
	ended: boolean;
	headersSent: boolean;
}

function createMockResponse(): {
	res: ServerResponse;
	state: MockResponseState;
	events: EventEmitter;
} {
	const events = new EventEmitter();
	const state: MockResponseState = {
		headers: {},
		chunks: [],
		ended: false,
		headersSent: false,
	};

	const res = {
		get headersSent() {
			return state.headersSent;
		},
		socket: {
			setNoDelay: vi.fn(),
		},
		writeHead: vi.fn((code: number, headers?: Record<string, string>) => {
			state.statusCode = code;
			state.headersSent = true;
			if (headers) {
				Object.assign(state.headers, headers);
			}
			return res;
		}),
		setHeader: vi.fn((name: string, value: string) => {
			state.headers[name.toLowerCase()] = value;
			return res;
		}),
		write: vi.fn((chunk: string | Buffer) => {
			state.chunks.push(chunk.toString());
			return true;
		}),
		end: vi.fn((chunk?: string | Buffer) => {
			if (chunk) {
				state.chunks.push(chunk.toString());
			}
			state.ended = true;
			events.emit('close');
			return res;
		}),
		on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			events.on(event, handler);
			return res;
		}),
		emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
	} as unknown as ServerResponse;

	return { res, state, events };
}

function createMockRequest(headers: Record<string, string> = {}): {
	req: IncomingMessage;
	events: EventEmitter;
} {
	const events = new EventEmitter();
	const req = {
		headers: { ...headers },
		on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			events.on(event, handler);
			return req;
		}),
		emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
	} as unknown as IncomingMessage;

	return { req, events };
}

function createTestEnvelope(id: number, kind = 'run.started'): EventEnvelope {
	return {
		id,
		ts: '2026-09-12T12:00:00.000Z',
		runId: 'run-1',
		taskId: 'task-1',
		scope: 'run',
		kind,
		seq: 0,
		actorDeviceId: 'device-1',
		payload: { runId: 'run-1', pid: 1234 },
	} as unknown as EventEnvelope;
}

function createStubRequest(options: {
	id?: string;
	actorDeviceId?: string | null;
	query?: Record<string, unknown>;
	raw?: IncomingMessage;
	container?: AppContainer;
}): FastifyRequest {
	return {
		id: options.id ?? 'req-stub',
		actorDeviceId: options.actorDeviceId ?? null,
		query: options.query,
		raw: options.raw,
		server: {
			container: options.container,
		},
	} as unknown as FastifyRequest;
}

describe('M2-T5 SSE Server: Framing, Heartbeat, Replay, and Disconnect', () => {
	let ringBuffer: ReturnType<typeof createRingBuffer>;
	let bus: ReturnType<typeof createEventBus>;
	let devicesMap: Map<string, { id: string; name: string; revoked_at: string | null }>;
	let activeRevokeListeners: Map<string, Set<(error: AppError) => void>>;
	let mockContainer: AppContainer;

	beforeEach(() => {
		vi.useFakeTimers();
		ringBuffer = createRingBuffer();
		bus = createEventBus({ ringBuffer });
		devicesMap = new Map();
		activeRevokeListeners = new Map();

		devicesMap.set('device-active', {
			id: 'device-active',
			name: 'Desktop Device',
			revoked_at: null,
		});

		mockContainer = {
			config: { dev: false },
			events: { ringBuffer, bus },
			repos: {
				devices: {
					findById: vi.fn((id: string) => devicesMap.get(id) ?? null),
				},
			},
			services: {
				pairing: {
					registerConnection: vi.fn((deviceId: string, onRevoke: (error: AppError) => void) => {
						let set = activeRevokeListeners.get(deviceId);
						if (!set) {
							set = new Set();
							activeRevokeListeners.set(deviceId, set);
						}
						set.add(onRevoke);
						return () => {
							set?.delete(onRevoke);
						};
					}),
				},
			},
		} as unknown as AppContainer;
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	describe('AC 1 & E-154: SSE Headers and Periodic Heartbeat', () => {
		it('sets required response headers text/event-stream, no-cache, no-transform, keep-alive, and X-Accel-Buffering: no', () => {
			const { req } = createMockRequest();
			const { res, state } = createMockResponse();

			handleSseStream({
				request: createStubRequest({
					actorDeviceId: 'device-active',
					id: 'req-1',
				}),
				rawRequest: req,
				rawResponse: res,
				container: mockContainer,
			});

			expect(state.statusCode).toBe(200);
			expect(state.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
			expect(state.headers['Cache-Control']).toBe('no-cache, no-transform');
			expect(state.headers.Connection).toBe('keep-alive');
			expect(state.headers['X-Accel-Buffering']).toBe('no');
		});

		it('writes :\\n\\n heartbeat frame every 15 seconds (E-154)', () => {
			const { req } = createMockRequest();
			const { res, state } = createMockResponse();

			handleSseStream({
				request: createStubRequest({
					actorDeviceId: 'device-active',
					id: 'req-1',
				}),
				rawRequest: req,
				rawResponse: res,
				container: mockContainer,
			});

			expect(state.chunks.filter((c) => c === SSE_HEARTBEAT_FRAME).length).toBe(0);

			// Advance 15 seconds
			vi.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL_MS);
			expect(state.chunks.filter((c) => c === SSE_HEARTBEAT_FRAME).length).toBe(1);

			// Advance another 15 seconds
			vi.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL_MS);
			expect(state.chunks.filter((c) => c === SSE_HEARTBEAT_FRAME).length).toBe(2);
		});

		it('cleans up heartbeat timer when client connection closes', () => {
			const { req, events: reqEvents } = createMockRequest();
			const { res, state } = createMockResponse();

			handleSseStream({
				request: createStubRequest({
					actorDeviceId: 'device-active',
					id: 'req-1',
				}),
				rawRequest: req,
				rawResponse: res,
				container: mockContainer,
				options: { heartbeatIntervalMs: 100 },
			});

			vi.advanceTimersByTime(100);
			expect(state.chunks.filter((c) => c === SSE_HEARTBEAT_FRAME).length).toBe(1);

			// Client disconnects
			reqEvents.emit('close');

			// Advance time further, no more heartbeats should be emitted
			vi.advanceTimersByTime(500);
			expect(state.chunks.filter((c) => c === SSE_HEARTBEAT_FRAME).length).toBe(1);
		});

		it('formatSseEvent produces compliant id, event, and data lines terminated with \\n\\n', () => {
			const envelope = createTestEnvelope(42, 'run.started');
			const formatted = formatSseEvent(envelope);

			expect(formatted).toContain('id: 42\n');
			expect(formatted).toContain('event: run.started\n');
			expect(formatted).toContain(`data: ${JSON.stringify(envelope)}\n\n`);
			expect(formatted.endsWith('\n\n')).toBe(true);
		});
	});

	describe('AC 2 & E-153: Last-Event-ID Replay and Window Expiry', () => {
		it('replays missing events when connecting with valid Last-Event-ID', () => {
			// Populate ring buffer with events 1, 2, 3
			bus.publish(createTestEnvelope(1));
			bus.publish(createTestEnvelope(2));
			bus.publish(createTestEnvelope(3));

			const { req } = createMockRequest({ 'last-event-id': '1' });
			const { res, state } = createMockResponse();

			handleSseStream({
				request: createStubRequest({
					actorDeviceId: 'device-active',
					id: 'req-replay',
				}),
				rawRequest: req,
				rawResponse: res,
				container: mockContainer,
			});

			expect(state.statusCode).toBe(200);
			// Should have replayed event 2 and 3, but not 1
			expect(state.chunks.some((c) => c.includes('id: 1\n'))).toBe(false);
			expect(state.chunks.some((c) => c.includes('id: 2\n'))).toBe(true);
			expect(state.chunks.some((c) => c.includes('id: 3\n'))).toBe(true);
		});

		it('supports Last-Event-ID passed via query parameter fallback', () => {
			bus.publish(createTestEnvelope(10));
			bus.publish(createTestEnvelope(11));

			const { req } = createMockRequest();
			const { res, state } = createMockResponse();

			handleSseStream({
				request: createStubRequest({
					actorDeviceId: 'device-active',
					id: 'req-q',
					query: { lastEventId: '10' },
				}),
				rawRequest: req,
				rawResponse: res,
				container: mockContainer,
			});

			expect(state.statusCode).toBe(200);
			expect(state.chunks.some((c) => c.includes('id: 10\n'))).toBe(false);
			expect(state.chunks.some((c) => c.includes('id: 11\n'))).toBe(true);
		});

		it('returns 409 E_REPLAY_WINDOW_EXPIRED and actively closes stream when Last-Event-ID is older than buffer minId (E-153)', () => {
			// Push 5005 events to evict early events from the 5000-capacity ring buffer
			for (let i = 1; i <= 5005; i++) {
				ringBuffer.push(createTestEnvelope(i));
			}

			// Buffer now holds 6..5005 (minId is 6)
			const { req } = createMockRequest({ 'last-event-id': '2' });
			const { res, state } = createMockResponse();

			handleSseStream({
				request: createStubRequest({
					actorDeviceId: 'device-active',
					id: 'req-expired',
				}),
				rawRequest: req,
				rawResponse: res,
				container: mockContainer,
			});

			expect(state.statusCode).toBe(409);
			expect(state.headers['Content-Type']).toBe('application/json; charset=utf-8');
			expect(state.ended).toBe(true);

			const body = JSON.parse(state.chunks.join(''));
			expect(body.error.code).toBe('E_REPLAY_WINDOW_EXPIRED');
			expect(body.error.requestId).toBe('req-expired');
			expect(body.error.details.minId).toBe(6);
			expect(body.error.details.requestedLastEventId).toBe(2);
			// No SSE header was written
			expect(state.headers['X-Accel-Buffering']).toBeUndefined();
		});
	});

	describe('AC 3 & E-155: Independent Connection Cursors and Deduplication', () => {
		it('maintains independent cursors and deduplication for multiple simultaneous clients', () => {
			bus.publish(createTestEnvelope(10));
			bus.publish(createTestEnvelope(20));

			// Client A (e.g. Mobile) starts at Last-Event-ID: 10
			const { req: reqA } = createMockRequest({ 'last-event-id': '10' });
			const { res: resA, state: stateA } = createMockResponse();
			handleSseStream({
				request: createStubRequest({
					actorDeviceId: 'device-active',
					id: 'req-client-a',
				}),
				rawRequest: reqA,
				rawResponse: resA,
				container: mockContainer,
			});

			// Client B (e.g. Desktop) starts at Last-Event-ID: 20
			const { req: reqB } = createMockRequest({ 'last-event-id': '20' });
			const { res: resB, state: stateB } = createMockResponse();
			handleSseStream({
				request: createStubRequest({
					actorDeviceId: 'device-active',
					id: 'req-client-b',
				}),
				rawRequest: reqB,
				rawResponse: resB,
				container: mockContainer,
			});

			// Client A replayed event 20
			expect(stateA.chunks.some((c) => c.includes('id: 20\n'))).toBe(true);
			// Client B already had event 20, replayed nothing
			expect(stateB.chunks.some((c) => c.includes('id: 20\n'))).toBe(false);

			// Now broadcast new event 25
			bus.publish(createTestEnvelope(25));

			// Both clients receive event 25
			expect(stateA.chunks.some((c) => c.includes('id: 25\n'))).toBe(true);
			expect(stateB.chunks.some((c) => c.includes('id: 25\n'))).toBe(true);

			// Client A disconnects
			resA.end();

			// Broadcast event 30
			bus.publish(createTestEnvelope(30));

			// Client B still receives event 30
			expect(stateB.chunks.some((c) => c.includes('id: 30\n'))).toBe(true);
		});
	});

	describe('AC 4 & E-156: Token Revocation or Expiry Closes Stream with 401', () => {
		it('returns 401 E_UNAUTHORIZED when actorDeviceId is missing', () => {
			const { req } = createMockRequest();
			const { res, state } = createMockResponse();

			handleSseStream({
				request: createStubRequest({
					actorDeviceId: null,
					id: 'req-no-auth',
				}),
				rawRequest: req,
				rawResponse: res,
				container: mockContainer,
			});

			expect(state.statusCode).toBe(401);
			expect(state.headers['Content-Type']).toBe('application/json; charset=utf-8');
			expect(state.ended).toBe(true);
			const body = JSON.parse(state.chunks.join(''));
			expect(body.error.code).toBe('E_UNAUTHORIZED');
		});

		it('returns 401 E_DEVICE_REVOKED when connecting device is already revoked', () => {
			devicesMap.set('device-revoked', {
				id: 'device-revoked',
				name: 'Revoked Device',
				revoked_at: '2026-09-12T10:00:00.000Z',
			});

			const { req } = createMockRequest();
			const { res, state } = createMockResponse();

			handleSseStream({
				request: createStubRequest({
					actorDeviceId: 'device-revoked',
					id: 'req-revoked',
				}),
				rawRequest: req,
				rawResponse: res,
				container: mockContainer,
			});

			expect(state.statusCode).toBe(401);
			expect(state.ended).toBe(true);
			const body = JSON.parse(state.chunks.join(''));
			expect(body.error.code).toBe('E_DEVICE_REVOKED');
		});

		it('actively closes open stream and emits error envelope when device is revoked during live connection (E-156)', () => {
			const { req } = createMockRequest();
			const { res, state } = createMockResponse();

			handleSseStream({
				request: createStubRequest({
					actorDeviceId: 'device-active',
					id: 'req-live',
				}),
				rawRequest: req,
				rawResponse: res,
				container: mockContainer,
			});

			expect(state.statusCode).toBe(200);
			expect(state.ended).toBe(false);

			// Device is revoked by another action (e.g. DELETE /api/v1/devices/:id)
			const listeners = activeRevokeListeners.get('device-active');
			expect(listeners?.size).toBe(1);

			const revocationError = {
				code: 'E_DEVICE_REVOKED',
				message: 'Device token has been revoked.',
			} as unknown as AppError;
			for (const listener of Array.from(listeners ?? [])) {
				listener(revocationError);
			}

			// Stream is actively closed and ended
			expect(state.ended).toBe(true);
			const errorChunk = state.chunks.find((c) => c.includes('event: error\n'));
			expect(errorChunk).toBeDefined();
			expect(errorChunk).toContain('"code":"E_DEVICE_REVOKED"');
		});

		it('periodically checks device validity during heartbeat and closes stream if revoked out-of-band (E-156)', () => {
			const { req } = createMockRequest();
			const { res, state } = createMockResponse();

			handleSseStream({
				request: createStubRequest({
					actorDeviceId: 'device-active',
					id: 'req-heartbeat-revoke',
				}),
				rawRequest: req,
				rawResponse: res,
				container: mockContainer,
				options: { heartbeatIntervalMs: 50 },
			});

			expect(state.statusCode).toBe(200);
			expect(state.ended).toBe(false);

			// Device status changes in DB without firing registered listener
			devicesMap.set('device-active', {
				id: 'device-active',
				name: 'Desktop Device',
				revoked_at: '2026-09-12T12:00:00.000Z',
			});

			vi.advanceTimersByTime(50);

			expect(state.ended).toBe(true);
			const errorChunk = state.chunks.find((c) => c.includes('event: error\n'));
			expect(errorChunk).toBeDefined();
			expect(errorChunk).toContain('E_DEVICE_REVOKED');
		});
	});

	describe('AC 5: Route Operates Strictly via reply.raw without reply.send', () => {
		it('registers GET /api/v1/events and handles request using reply.hijack and reply.raw', async () => {
			const { registerEventsRoutes } = await import('../../src/http/routes/events.ts');

			let registeredHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<void> =
				async () => {};
			const mockFastify = {
				get: vi.fn(
					(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
						if (path === '/api/v1/events') {
							registeredHandler = handler;
						}
					},
				),
			};

			registerEventsRoutes(mockFastify as unknown as FastifyInstance);
			expect(mockFastify.get).toHaveBeenCalledWith('/api/v1/events', expect.any(Function));

			const { req } = createMockRequest();
			const { res, state } = createMockResponse();
			const mockReply = {
				hijack: vi.fn(),
				raw: res,
				send: vi.fn(),
			} as unknown as FastifyReply;

			const mockFastifyReq = createStubRequest({
				raw: req,
				actorDeviceId: 'device-active',
				id: 'req-fastify-1',
				container: mockContainer,
			});

			await registeredHandler(mockFastifyReq, mockReply);

			expect(mockReply.hijack).toHaveBeenCalledTimes(1);
			expect(mockReply.send).not.toHaveBeenCalled();
			expect(state.statusCode).toBe(200);
			expect(state.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
		});
	});

	describe('Fastify End-to-End Real HTTP Server Integration', () => {
		const currentDir = dirname(fileURLToPath(import.meta.url));
		const migrationsDir = resolve(currentDir, '../../migrations');
		const testDirs: string[] = [];
		const testDbs: ReturnType<typeof openDatabase>[] = [];

		beforeEach(() => {
			vi.useRealTimers();
		});

		afterEach(async () => {
			for (const db of testDbs.splice(0)) {
				if (db.open) db.close();
			}
			for (const d of testDirs.splice(0)) {
				rmSync(d, { recursive: true, force: true });
			}
		});

		function createRealServer() {
			const dataDir = mkdtempSync(join(tmpdir(), 'agent-sched-sse-e2e-'));
			testDirs.push(dataDir);
			const db = openDatabase(':memory:');
			testDbs.push(db);

			const runner = createMigrationRunner({
				clock: { now: () => '2026-09-12T12:00:00.000Z' },
				database: db,
				fileSystem: {
					readDirectory: () => ['0001_init.sql'],
					readFile: (p: string) => readFileSync(p, 'utf8'),
				},
			});
			runner.run(migrationsDir);

			const dummyLockAdapter = {
				platform: 'linux',
				filePath: join(dataDir, 'test.lock'),
				dirPath: dataDir,
				reclaimPath: join(dataDir, 'test.lock.reclaim'),
				permissionLines: [],
				createExclusive: () => ({ ok: true }),
				read: () => ({ ok: true, contents: '{}' }),
				remove: () => ({ ok: true }),
				verifyPermissions: () => ({ ok: true }),
				inspectPermissions: () => ({ ok: true, contents: 'mode=600' }),
				createReclaimGuard: () => ({ ok: true }),
				readReclaimGuard: () => ({ ok: true, contents: '{}' }),
				removeReclaimGuard: () => ({ ok: true }),
			} as unknown as NativeLockAdapter;

			const container = createContainer({
				config: {
					port: 0,
					bind: '127.0.0.1',
					dataDir,
					logLevel: 'error',
					dev: false,
				},
				database: db,
				hostInputs: { platform: 'linux', homedir: dataDir },
				lockAdapter: dummyLockAdapter,
				instanceLock: { release: () => undefined } as unknown as LockFileHandle,
				clock: { now: () => '2026-09-12T12:00:00.000Z' },
			});

			const server = createHttpServer({ container });
			return { server, container };
		}

		it('rejects unauthenticated GET /api/v1/events with 401 and error envelope', async () => {
			const { server } = createRealServer();
			const listenAddr = await server.listen({ host: '127.0.0.1', port: 0 });
			const port = Number(new URL(listenAddr).port);

			try {
				const res = await new Promise<{ statusCode?: number; body: string }>(
					(resolvePromise, rejectPromise) => {
						const req = http.request(
							{
								host: '127.0.0.1',
								port,
								path: '/api/v1/events',
								method: 'GET',
							},
							(response) => {
								let data = '';
								response.on('data', (chunk) => {
									data += chunk;
								});
								response.on('end', () => {
									resolvePromise({
										statusCode: response.statusCode,
										body: data,
									});
								});
							},
						);
						req.on('error', rejectPromise);
						req.end();
					},
				);

				expect(res.statusCode).toBe(401);
				const parsed = JSON.parse(res.body);
				expect(parsed.error.code).toBe('E_UNAUTHORIZED');
			} finally {
				await server.close();
			}
		});

		it('establishes SSE stream for paired device, streams published events, and cuts stream on revocation', async () => {
			const { server, container } = createRealServer();
			const listenAddr = await server.listen({ host: '127.0.0.1', port: 0 });
			const port = Number(new URL(listenAddr).port);

			// Pair a device
			const code =
				container.services.pairing.getActivePairingCode()?.code ??
				container.services.pairing.createPairingCode().code;
			const claim = await container.services.pairing.claimPairingCode({
				code,
				deviceName: 'E2E-Device',
			});

			try {
				let headersReceived: http.IncomingHttpHeaders | undefined;
				let receivedData = '';
				let streamClosed = false;

				const sseClientReq = http.request(
					{
						host: '127.0.0.1',
						port,
						path: '/api/v1/events',
						method: 'GET',
						headers: {
							Authorization: `Bearer ${claim.token}`,
						},
					},
					(response) => {
						headersReceived = response.headers;
						response.on('data', (chunk) => {
							receivedData += chunk.toString();
						});
						response.on('end', () => {
							streamClosed = true;
						});
					},
				);

				sseClientReq.on('error', () => {});
				sseClientReq.end();

				// Wait briefly for handshake
				await vi.waitFor(
					() => {
						expect(headersReceived).toBeDefined();
						expect(headersReceived?.['content-type']).toContain('text/event-stream');
						expect(headersReceived?.['x-accel-buffering']).toBe('no');
					},
					{ timeout: 3000, interval: 50 },
				);

				// Broadcast an event via bus
				container.events.bus.publish({
					id: 999,
					ts: '2026-09-12T12:00:00.000Z',
					runId: 'e2e-run',
					taskId: 'e2e-task',
					scope: 'run',
					kind: 'run.started',
					seq: 1,
					actorDeviceId: claim.deviceId,
					payload: { runId: 'e2e-run' },
				} as EventEnvelope);

				// Verify event arrived at client
				await vi.waitFor(
					() => {
						expect(receivedData).toContain('id: 999\n');
						expect(receivedData).toContain('event: run.started\n');
					},
					{ timeout: 3000, interval: 50 },
				);

				// Revoke the device - stream should be cut by server
				await container.services.pairing.revokeDevice(claim.deviceId);

				await vi.waitFor(
					() => {
						expect(streamClosed).toBe(true);
						expect(receivedData).toContain('E_DEVICE_REVOKED');
					},
					{ timeout: 3000, interval: 50 },
				);
			} finally {
				await server.close();
			}
		});
	});
});
