// @vitest-environment jsdom

import { type Server, type ServerResponse, createServer } from 'node:http';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { ShellBridge } from '@agent-scheduler/shared/shell/bridge-contract';
import { createElement } from 'react';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventBus } from '../src/api/event-bus.ts';
import { clearCachedToken, setCachedToken } from '../src/api/http-client.ts';
import { type SseClient, createSseClient } from '../src/api/sse-client.ts';
import { bootstrap } from '../src/app/bootstrap.ts';
import { ConnectionStatusBanner } from '../src/features/run-deck/use-connection-state.ts';
import { type ConnectionStore, useConnectionStore } from '../src/store/connection-store.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createShell(token: string | null, order?: string[]): ShellBridge {
	return {
		platform: 'browser',
		capabilities: {
			hasSecureStorage: false,
			hasNativeNotification: false,
		},
		tokenStore: {
			async get() {
				order?.push('tokenStore.get');
				return token;
			},
			async set() {},
			async clear() {},
		},
		async notify() {},
		async hostHint() {
			return null;
		},
	};
}

function createFakeSseClient(onConnect?: () => void): SseClient {
	return {
		connect: vi.fn(() => onConnect?.()),
		disconnect: vi.fn(),
		getStatus: () => 'disconnected',
		getNeedsPairing: () => false,
		setNeedsPairing: vi.fn(),
		getLastEventId: () => null,
		setLastEventId: vi.fn(),
		subscribe: () => () => {},
		subscribeToTask: () => () => {},
		subscribeToRun: () => () => {},
		onStatusChange: (listener) => {
			listener('disconnected');
			return () => {};
		},
		onClearBuffer: () => () => {},
		resetBackoff: vi.fn(),
	};
}

function waitForConnectionState(
	predicate: (state: ConnectionStore) => boolean,
	label: string,
): Promise<ConnectionStore> {
	const current = useConnectionStore.getState();
	if (predicate(current)) {
		return Promise.resolve(current);
	}
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error(`Timed out waiting for connection state: ${label}`));
		}, 5_000);
		const unsubscribe = useConnectionStore.subscribe((state) => {
			if (!predicate(state)) {
				return;
			}
			clearTimeout(timeout);
			unsubscribe();
			resolve(state);
		});
	});
}

interface FakeSseServer {
	readonly server: Server;
	readonly url: string;
	readonly connected: Promise<ServerResponse>;
	readonly requestCount: () => number;
}

async function startFakeSseServer(): Promise<FakeSseServer> {
	let responseResolve!: (response: ServerResponse) => void;
	const connected = new Promise<ServerResponse>((resolve) => {
		responseResolve = resolve;
	});
	let requests = 0;
	const server = createServer((request, response) => {
		requests += 1;
		expect(request.url).toBe('/api/v1/events');
		expect(request.headers.authorization).toBe('Bearer bootstrap-token');
		response.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		});
		response.flushHeaders();
		responseResolve(response);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Fake SSE server did not expose a TCP address');
	}
	return {
		server,
		url: `http://127.0.0.1:${address.port}`,
		connected,
		requestCount: () => requests,
	};
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

describe('M9-T26 application bootstrap', () => {
	beforeEach(() => {
		clearCachedToken();
		useConnectionStore.getState().reset();
		delete document.documentElement.dataset.connectionStatus;
	});

	afterEach(() => {
		clearCachedToken();
		useConnectionStore.getState().reset();
		delete document.documentElement.dataset.connectionStatus;
	});

	it('reads the shell token before resolving the base URL and opening the one SSE stream', async () => {
		const order: string[] = [];
		const client = createFakeSseClient(() => order.push('connect'));
		const result = await bootstrap({
			shell: createShell('bootstrap-token', order),
			sseClient: client,
			resolveBaseUrl: async () => {
				order.push('resolveBaseUrl');
				return 'http://localhost:7817';
			},
		});

		expect(order.slice(0, 3)).toEqual(['tokenStore.get', 'resolveBaseUrl', 'connect']);
		expect(result.hasToken).toBe(true);
		expect(result.needsPairing).toBe(false);
		result.teardown();
	});

	it('does not connect without a token, then pairs and disconnects through the module token cache', async () => {
		setCachedToken('stale-token-from-an-earlier-bootstrap');
		const client = createFakeSseClient();
		const shell = createShell(null);
		const clearShellToken = vi.spyOn(shell.tokenStore, 'clear');
		const result = await bootstrap({
			shell,
			sseClient: client,
			resolveBaseUrl: async () => 'http://localhost:7817',
		});

		expect(client.connect).not.toHaveBeenCalled();
		expect(result.needsPairing).toBe(true);
		expect(useConnectionStore.getState().needsPairing).toBe(true);
		expect(document.documentElement.dataset.connectionStatus).toBe('offline');

		setCachedToken('newly-paired-token');
		expect(client.connect).toHaveBeenCalledTimes(1);
		expect(useConnectionStore.getState().needsPairing).toBe(false);

		clearCachedToken();
		expect(client.disconnect).toHaveBeenCalledTimes(1);
		expect(useConnectionStore.getState().needsPairing).toBe(true);
		expect(clearShellToken).toHaveBeenCalledTimes(1);
		result.teardown();
	});

	it('drives the store, DOM status, sync readout, and backoff from a real fake SSE server', async () => {
		const fakeServer = await startFakeSseServer();
		let releaseBackoff: (() => void) | undefined;
		const client = createSseClient({
			getBaseUrl: () => fakeServer.url,
			getToken: () => 'bootstrap-token',
			randomJitter: () => 0.5,
			sleep: () =>
				new Promise<void>((resolve) => {
					releaseBackoff = resolve;
				}),
		});
		let boot: Awaited<ReturnType<typeof bootstrap>> | undefined;
		let root: Root | undefined;
		let response: ServerResponse | undefined;
		try {
			boot = await bootstrap({
				shell: createShell('bootstrap-token'),
				sseClient: client,
				resolveBaseUrl: async () => fakeServer.url,
			});
			response = await fakeServer.connected;
			await waitForConnectionState((state) => state.status === 'online', 'online');

			const container = document.createElement('div');
			document.body.appendChild(container);
			root = createRoot(container);
			await act(async () => {
				root?.render(createElement(ConnectionStatusBanner));
			});

			const event: EventEnvelope = {
				id: 4242,
				ts: '2026-09-19T12:34:56.000Z',
				runId: 'run-bootstrap-1',
				taskId: 'M9-T26',
				scope: 'run',
				kind: 'run.state_changed',
				seq: 1,
				actorDeviceId: 'device-bootstrap-test',
				payload: { from: 'running', to: 'reviewing' },
			};
			await act(async () => {
				response?.write(
					`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`,
				);
				await waitForConnectionState(
					(state) => state.lastEventId === event.id && state.lastSyncedAt !== null,
					'event cursor and sync timestamp',
				);
			});

			expect(useConnectionStore.getState().lastEventId).toBe(4242);
			// The single production stream must also feed the M9-T6 ring buffer: the run-detail log
			// window subscribes to eventBus, so an envelope that only reaches connection-store is lost.
			const streamBuffer = eventBus.getBuffer('run-bootstrap-1');
			expect(streamBuffer?.length).toBe(1);
			expect(streamBuffer?.lastEventId).toBe(event.id);
			expect(document.documentElement.dataset.connectionStatus).toBe('online');
			expect(container.textContent).toContain('最后同步于');
			expect(container.querySelector('[data-connection-status="online"]')).not.toBeNull();

			await act(async () => {
				response?.end();
				await waitForConnectionState((state) => state.status === 'reconnecting', 'reconnecting');
			});
			expect(fakeServer.requestCount()).toBe(1);
			expect(document.documentElement.dataset.connectionStatus).toBe('reconnecting');
		} finally {
			boot?.teardown();
			releaseBackoff?.();
			if (root) {
				await act(async () => root?.unmount());
			}
			response?.end();
			await closeServer(fakeServer.server);
		}
	});

	it('delivers each envelope exactly once through the production default SSE client', async () => {
		const fakeServer = await startFakeSseServer();
		const shell: ShellBridge = {
			...createShell('bootstrap-token'),
			hostHint: async () => fakeServer.url,
		};
		let boot: Awaited<ReturnType<typeof bootstrap>> | undefined;
		let response: ServerResponse | undefined;
		try {
			boot = await bootstrap({
				shell,
				resolveBaseUrl: async () => fakeServer.url,
			});
			response = await fakeServer.connected;
			await waitForConnectionState((state) => state.status === 'online', 'online');

			const runId = 'run-default-sse-1';
			const event: EventEnvelope = {
				id: 5252,
				ts: '2026-09-22T02:00:00.000Z',
				runId,
				taskId: 'M9-T5',
				scope: 'run',
				kind: 'run.state_changed',
				seq: 1,
				actorDeviceId: 'device-bootstrap-test',
				payload: { from: 'running', to: 'reviewing' },
			};
			response.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
			await waitForConnectionState(
				(state) => state.lastEventId === event.id,
				'default SSE event cursor',
			);

			expect(fakeServer.requestCount()).toBe(1);
			expect(
				eventBus
					.getBuffer(runId)
					?.getItems()
					.map((item) => item.id),
			).toEqual([event.id]);
		} finally {
			boot?.teardown();
			response?.end();
			await closeServer(fakeServer.server);
		}
	});
});
