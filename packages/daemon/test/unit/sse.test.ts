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
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import { createHttpServer } from '../../src/http/server.ts';
import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	SSE_HEARTBEAT_FRAME,
	formatSseEvent,
	handleSseStream,
	parseLastEventId,
	resolveReplayEvents,
} from '../../src/http/sse.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';

interface MockResponseState {
	headers: Record<string, string>;
	chunks: string[];
	ended: boolean;
	headersSent: boolean;
	flushedHeaders: boolean;
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
		flushedHeaders: false,
	};

	const res = {
		get headersSent() {
			return state.headersSent;
		},
		socket: {
			setNoDelay: vi.fn(),
		},
		setHeader: vi.fn((name: string, value: string) => {
			state.headers[name.toLowerCase()] = value;
			return res;
		}),
		flushHeaders: vi.fn(() => {
			state.headersSent = true;
			state.flushedHeaders = true;
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

describe('M2-T5 SSE Server: Framing, Heartbeat, Replay, and Disconnect', () => {
	let ringBuffer: ReturnType<typeof createRingBuffer>;
	let bus: ReturnType<typeof createEventBus>;
	let activeRevokeListeners: Map<string, Set<(error: AppError) => void>>;
	let mockPairingService: {
		registerConnection: (deviceId: string, onRevoke: (error: AppError) => void) => () => void;
	};

	beforeEach(() => {
		vi.useFakeTimers();
		ringBuffer = createRingBuffer();
		bus = createEventBus({ ringBuffer });
		activeRevokeListeners = new Map();

		mockPairingService = {
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
		};
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	describe('AC 1 & E-154: SSE Headers and Periodic Heartbeat', () => {
		it('sets required response headers text/event-stream, no-cache, no-transform, keep-alive, and X-Accel-Buffering: no without status code literals', () => {
			const { req } = createMockRequest();
			const { res, state } = createMockResponse();

			handleSseStream({
				rawRequest: req,
				rawResponse: res,
				requestId: 'req-1',
				actorDeviceId: 'device-active',
				bus,
				pairingService: mockPairingService,
			});

			expect(state.headers['content-type']).toBe('text/event-stream; charset=utf-8');
			expect(state.headers['cache-control']).toBe('no-cache, no-transform');
			expect(state.headers.connection).toBe('keep-alive');
			expect(state.headers['x-accel-buffering']).toBe('no');
			expect(state.flushedHeaders).toBe(true);
		});

		it('writes :\\n\\n heartbeat frame every 15 seconds (E-154)', () => {
			const { req } = createMockRequest();
			const { res, state } = createMockResponse();

			handleSseStream({
				rawRequest: req,
				rawResponse: res,
				requestId: 'req-1',
				actorDeviceId: 'device-active',
				bus,
				pairingService: mockPairingService,
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
				rawRequest: req,
				rawResponse: res,
				requestId: 'req-1',
				actorDeviceId: 'device-active',
				bus,
				pairingService: mockPairingService,
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

	describe('AC 2 & E-153: Last-Event-ID Parsing, Replay, and Window Expiry', () => {
		it('parseLastEventId parses non-negative safe integers from header and ignores missing/invalid', () => {
			expect(parseLastEventId(undefined)).toBeNull();
			expect(parseLastEventId('')).toBeNull();
			expect(parseLastEventId('not-a-number')).toBeNull();
			expect(parseLastEventId('-5')).toBeNull();
			expect(parseLastEventId('0')).toBe(0);
			expect(parseLastEventId('123')).toBe(123);
			expect(parseLastEventId(['456'])).toBe(456);
		});

		it('resolveReplayEvents returns empty replay when Last-Event-ID is absent', () => {
			const result = resolveReplayEvents(ringBuffer, undefined);
			expect(result.parsedLastEventId).toBeNull();
			expect(result.replayEvents).toEqual([]);
		});

		it('resolveReplayEvents replays events strictly greater than Last-Event-ID', () => {
			ringBuffer.push(createTestEnvelope(1));
			ringBuffer.push(createTestEnvelope(2));
			ringBuffer.push(createTestEnvelope(3));

			const result = resolveReplayEvents(ringBuffer, '1');
			expect(result.parsedLastEventId).toBe(1);
			expect(result.replayEvents.map((e) => e.id)).toEqual([2, 3]);
		});

		it('resolveReplayEvents throws AppError(E_REPLAY_WINDOW_EXPIRED) with details when cursor is older than minId (E-153)', () => {
			// Push 5005 events to evict early events from the 5000-capacity ring buffer
			for (let i = 1; i <= 5005; i++) {
				ringBuffer.push(createTestEnvelope(i));
			}

			// Buffer now holds 6..5005 (minId is 6)
			expect(() => resolveReplayEvents(ringBuffer, '2')).toThrowError(AppError);
			try {
				resolveReplayEvents(ringBuffer, '2');
			} catch (err: unknown) {
				const appError = err as AppError;
				expect(appError.code).toBe('E_REPLAY_WINDOW_EXPIRED');
				expect(appError.details).toEqual({
					minId: 6,
					requestedLastEventId: 2,
				});
			}
		});

		it('flushes pre-resolved replay events into SSE stream before accepting new events', () => {
			const ev2 = createTestEnvelope(2);
			const ev3 = createTestEnvelope(3);

			const { req } = createMockRequest();
			const { res, state } = createMockResponse();

			handleSseStream({
				rawRequest: req,
				rawResponse: res,
				requestId: 'req-replay',
				actorDeviceId: 'device-active',
				bus,
				pairingService: mockPairingService,
				parsedLastEventId: 1,
				replayEvents: [ev2, ev3],
			});

			expect(state.chunks.some((c) => c.includes('id: 1\n'))).toBe(false);
			expect(state.chunks.some((c) => c.includes('id: 2\n'))).toBe(true);
			expect(state.chunks.some((c) => c.includes('id: 3\n'))).toBe(true);
		});
	});

	describe('AC 3 & E-155: Independent Connection Cursors and Deduplication', () => {
		it('maintains independent cursors and deduplication for multiple simultaneous clients', () => {
			const ev20 = createTestEnvelope(20);

			// Client A (e.g. Mobile) starts at Last-Event-ID: 10
			const { req: reqA } = createMockRequest();
			const { res: resA, state: stateA } = createMockResponse();
			handleSseStream({
				rawRequest: reqA,
				rawResponse: resA,
				requestId: 'req-client-a',
				actorDeviceId: 'device-active',
				bus,
				pairingService: mockPairingService,
				parsedLastEventId: 10,
				replayEvents: [ev20],
			});

			// Client B (e.g. Desktop) starts at Last-Event-ID: 20
			const { req: reqB } = createMockRequest();
			const { res: resB, state: stateB } = createMockResponse();
			handleSseStream({
				rawRequest: reqB,
				rawResponse: resB,
				requestId: 'req-client-b',
				actorDeviceId: 'device-active',
				bus,
				pairingService: mockPairingService,
				parsedLastEventId: 20,
				replayEvents: [],
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

	describe('AC 4 & E-156: In-Stream Revocation Notification', () => {
		it('actively closes open stream and emits error envelope when device is revoked during live connection (E-156)', () => {
			const { req } = createMockRequest();
			const { res, state } = createMockResponse();

			handleSseStream({
				rawRequest: req,
				rawResponse: res,
				requestId: 'req-live',
				actorDeviceId: 'device-active',
				bus,
				pairingService: mockPairingService,
			});

			expect(state.ended).toBe(false);

			// Device is revoked during live streaming
			const listeners = activeRevokeListeners.get('device-active');
			expect(listeners?.size).toBe(1);

			const revocationError = new AppError('E_DEVICE_REVOKED', 'Device token has been revoked.');
			for (const listener of Array.from(listeners ?? [])) {
				listener(revocationError);
			}

			// Stream is actively closed and ended
			expect(state.ended).toBe(true);
			const errorChunk = state.chunks.find((c) => c.includes('event: error\n'));
			expect(errorChunk).toBeDefined();
			expect(errorChunk).toContain('"code":"E_DEVICE_REVOKED"');
			expect(errorChunk).toContain('Device token has been revoked.');
		});
	});

	describe('AC 5: Route Operates Strictly via reply.raw without reply.send', () => {
		it('registers GET /api/v1/events and handles request using reply.hijack and reply.raw without reply.send', async () => {
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

			const mockContainer = {
				events: { ringBuffer, bus },
				services: { pairing: mockPairingService },
			};

			const mockFastifyReq = {
				headers: {},
				raw: req,
				actorDeviceId: 'device-active',
				id: 'req-fastify-1',
				server: { container: mockContainer },
			} as unknown as FastifyRequest;

			await registeredHandler(mockFastifyReq, mockReply);

			expect(mockReply.hijack).toHaveBeenCalledTimes(1);
			expect(mockReply.send).not.toHaveBeenCalled();
			expect(state.headers['content-type']).toBe('text/event-stream; charset=utf-8');
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

		it('returns 401 with standard error envelope when request is unauthenticated (E-156 handshake)', async () => {
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
				expect(parsed.error).toBeDefined();
				expect(parsed.error.code).toBe('E_UNAUTHORIZED');
				expect(parsed.error.requestId).toBeDefined();
			} finally {
				await server.close();
			}
		});

		it('returns 401 with standard error envelope when token belongs to revoked device (E-156 handshake)', async () => {
			const { server, container } = createRealServer();
			const listenAddr = await server.listen({ host: '127.0.0.1', port: 0 });
			const port = Number(new URL(listenAddr).port);

			// Pair then revoke device
			const code =
				container.services.pairing.getActivePairingCode()?.code ??
				container.services.pairing.createPairingCode().code;
			const claim = await container.services.pairing.claimPairingCode({
				code,
				deviceName: 'Revoked-Before-Connect',
			});
			await container.services.pairing.revokeDevice(claim.deviceId);

			try {
				const res = await new Promise<{ statusCode?: number; body: string }>(
					(resolvePromise, rejectPromise) => {
						const req = http.request(
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
				expect(parsed.error).toBeDefined();
				expect(parsed.error.code).toBe('E_DEVICE_REVOKED');
				expect(parsed.error.requestId).toBeDefined();
			} finally {
				await server.close();
			}
		});

		it('returns 409 with standard error envelope when Last-Event-ID is expired before stream hijacking (E-153 handshake)', async () => {
			const { server, container } = createRealServer();
			const listenAddr = await server.listen({ host: '127.0.0.1', port: 0 });
			const port = Number(new URL(listenAddr).port);

			// Push 5005 events to evict ID 1..5
			for (let i = 1; i <= 5005; i++) {
				container.events.ringBuffer.push(createTestEnvelope(i));
			}

			// Pair device
			const code =
				container.services.pairing.getActivePairingCode()?.code ??
				container.services.pairing.createPairingCode().code;
			const claim = await container.services.pairing.claimPairingCode({
				code,
				deviceName: 'Valid-Device',
			});

			try {
				const res = await new Promise<{ statusCode?: number; body: string }>(
					(resolvePromise, rejectPromise) => {
						const req = http.request(
							{
								host: '127.0.0.1',
								port,
								path: '/api/v1/events',
								method: 'GET',
								headers: {
									Authorization: `Bearer ${claim.token}`,
									'Last-Event-ID': '2',
								},
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

				// Handled by 90-error-handler: HTTP status 409 and standard error envelope
				expect(res.statusCode).toBe(409);
				const parsed = JSON.parse(res.body);
				expect(parsed.error).toBeDefined();
				expect(parsed.error.code).toBe('E_REPLAY_WINDOW_EXPIRED');
				expect(parsed.error.details).toBeDefined();
				expect(parsed.error.details.minId).toBe(6);
				expect(parsed.error.details.requestedLastEventId).toBe(2);
			} finally {
				await server.close();
			}
		});

		it('establishes live SSE stream for paired device, streams published events, and cuts stream on revocation (E-156)', async () => {
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
