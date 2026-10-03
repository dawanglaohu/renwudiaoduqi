import { type Server, createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../src/api/http-client.ts';

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
	return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

describe('M9-T4 HTTP response body lifetime', () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([200, 503])(
		'keeps the timeout active while reading a %i response body',
		async (status) => {
			let requests = 0;
			const server = createServer((_request, response) => {
				requests += 1;
				response.writeHead(status, { 'content-type': 'application/json' });
				response.write('{');
			});
			const baseUrl = await listen(server);
			try {
				const client = createHttpClient({ getBaseUrl: () => baseUrl });
				const result = client
					.get('/api/v1/snapshot', { auth: 'none', retry: false, timeoutMs: 80 })
					.catch((error: unknown) => error);
				const outcome = await Promise.race([result, delay(800, 'body-still-pending')]);
				expect(outcome).toMatchObject({ name: 'ApiError', code: 'E_TIMEOUT' });
				expect(requests).toBe(1);
			} finally {
				await close(server);
			}
		},
	);

	it.each([200, 503])(
		'propagates caller cancellation during a %i response body',
		async (status) => {
			let requests = 0;
			const server = createServer((_request, response) => {
				requests += 1;
				response.writeHead(status, { 'content-type': 'application/json' });
				response.write('{');
			});
			const baseUrl = await listen(server);
			const originalFetch = globalThis.fetch;
			let signalBodyRead: () => void = () => {};
			const bodyRead = new Promise<void>((resolve) => {
				signalBodyRead = resolve;
			});
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
				const response = await originalFetch(input, init);
				const readText = response.text.bind(response);
				response.text = () => {
					signalBodyRead();
					return readText();
				};
				return response;
			});
			try {
				const controller = new AbortController();
				const reason = new Error('The owning view was disposed');
				const client = createHttpClient({ getBaseUrl: () => baseUrl });
				const result = client
					.get('/api/v1/snapshot', { auth: 'none', signal: controller.signal })
					.catch((error: unknown) => error);
				await bodyRead;
				controller.abort(reason);
				const outcome = await Promise.race([result, delay(800, 'body-still-pending')]);
				expect(outcome).toBe(reason);
				expect(requests).toBe(1);
			} finally {
				await close(server);
			}
		},
	);
});
