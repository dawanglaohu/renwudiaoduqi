import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDefinition } from '../../shared/src/api/routes.ts';
import {
	MANUAL_HOST_STORAGE_KEY,
	clearManualHost,
	getManualHost,
	normalizeBaseUrl,
	registerShellHostHint,
	resolveBaseUrl,
	setManualHost,
} from '../src/api/base-url.ts';
import {
	ApiError,
	SESSION_STORAGE_TOKEN_KEY,
	clearCachedToken,
	createHttpClient,
	getCachedToken,
	isApiError,
	registerTokenProvider,
	setCachedToken,
} from '../src/api/http-client.ts';

// In Node environment, polyfill minimal in-memory localStorage and sessionStorage if missing
class MemoryStorage implements Storage {
	private store = new Map<string, string>();
	get length(): number {
		return this.store.size;
	}
	clear(): void {
		this.store.clear();
	}
	getItem(key: string): string | null {
		return this.store.get(key) ?? null;
	}
	key(index: number): string | null {
		return Array.from(this.store.keys())[index] ?? null;
	}
	removeItem(key: string): void {
		this.store.delete(key);
	}
	setItem(key: string, value: string): void {
		this.store.set(key, String(value));
	}
}

if (typeof globalThis.localStorage === 'undefined') {
	globalThis.localStorage = new MemoryStorage();
}
if (typeof globalThis.sessionStorage === 'undefined') {
	globalThis.sessionStorage = new MemoryStorage();
}

describe('M9-T4 base-url.ts', () => {
	beforeEach(() => {
		clearManualHost();
		registerShellHostHint(null);
	});

	afterEach(() => {
		clearManualHost();
		registerShellHostHint(null);
	});

	describe('normalizeBaseUrl', () => {
		it('normalizes trailing slashes, trims whitespace, and prepends http if missing', () => {
			expect(normalizeBaseUrl('  http://localhost:7817/  ')).toBe('http://localhost:7817');
			expect(normalizeBaseUrl('https://example.com///')).toBe('https://example.com');
			expect(normalizeBaseUrl('192.168.1.100:7817')).toBe('http://192.168.1.100:7817');
			expect(normalizeBaseUrl('   ')).toBe('');
		});
	});

	describe('manual host localStorage persistence (E-06)', () => {
		it('reads, sets, and clears manual host in localStorage', () => {
			expect(getManualHost()).toBeNull();
			setManualHost('192.168.1.50:7817');
			expect(getManualHost()).toBe('192.168.1.50:7817');
			expect(localStorage.getItem(MANUAL_HOST_STORAGE_KEY)).toBe('192.168.1.50:7817');
			clearManualHost();
			expect(getManualHost()).toBeNull();
		});
	});

	describe('three-level baseUrl discovery (AC 2, E-06)', () => {
		it('Level 1: resolves shell injected hostHint first when available', async () => {
			const baseUrl = await resolveBaseUrl({
				shellHostHint: () => 'http://127.0.0.1:9999',
				manualHost: 'http://192.168.1.10:7817',
				origin: 'http://localhost:5173',
			});
			expect(baseUrl).toBe('http://127.0.0.1:9999');
		});

		it('Level 1 via registered provider', async () => {
			registerShellHostHint(() => 'http://shell-injected:7817');
			const baseUrl = await resolveBaseUrl({
				manualHost: 'http://192.168.1.10:7817',
				origin: 'http://localhost:5173',
			});
			expect(baseUrl).toBe('http://shell-injected:7817');
		});

		it('Level 2: falls back to user manual host when shell injection is absent (E-06)', async () => {
			const baseUrl = await resolveBaseUrl({
				shellHostHint: () => null,
				manualHost: 'http://192.168.1.200:7817',
				origin: 'http://localhost:5173',
			});
			expect(baseUrl).toBe('http://192.168.1.200:7817');
		});

		it('Level 3: falls back to location.origin when neither shell nor manual host is provided', async () => {
			const baseUrl = await resolveBaseUrl({
				shellHostHint: () => null,
				manualHost: null,
				origin: 'http://browser-origin.local:3000',
			});
			expect(baseUrl).toBe('http://browser-origin.local:3000');
		});
	});
});

describe('M9-T4 http-client.ts', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		clearCachedToken();
		clearManualHost();
		sessionStorage.clear();
		registerTokenProvider(null);
		registerShellHostHint(null);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearCachedToken();
		clearManualHost();
		sessionStorage.clear();
		registerTokenProvider(null);
		registerShellHostHint(null);
		vi.restoreAllMocks();
	});

	describe('ApiError and error classification (AC 4)', () => {
		it('creates ApiError with required attributes and satisfies isApiError guard', () => {
			const error = new ApiError({
				code: 'E_VALIDATION',
				message: 'Invalid run payload',
				requestId: 'req-42',
				status: 400,
				details: { field: 'model' },
				idempotencyKey: 'idem-1',
			});

			expect(error).toBeInstanceOf(Error);
			expect(error).toBeInstanceOf(ApiError);
			expect(isApiError(error)).toBe(true);
			expect(error.name).toBe('ApiError');
			expect(error.code).toBe('E_VALIDATION');
			expect(error.message).toBe('Invalid run payload');
			expect(error.requestId).toBe('req-42');
			expect(error.status).toBe(400);
			expect(error.details).toEqual({ field: 'model' });
			expect(error.idempotencyKey).toBe('idem-1');
		});

		it('normalizes server error envelope into ApiError', async () => {
			globalThis.fetch = vi.fn().mockImplementation(() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							error: {
								code: 'E_DOC_SOURCE_UNREADABLE',
								message: 'Markdown file cannot be opened',
								requestId: 'server-req-99',
								details: { path: '/docs/plan.md' },
							},
						}),
						{
							status: 409,
							headers: { 'Content-Type': 'application/json', 'x-request-id': 'server-req-99' },
						},
					),
				),
			);

			const client = createHttpClient({ getBaseUrl: () => 'http://127.0.0.1:7817' });

			await expect(client.get('/api/v1/documents')).rejects.toSatisfy((err: unknown) => {
				if (!isApiError(err)) return false;
				expect(err.code).toBe('E_DOC_SOURCE_UNREADABLE');
				expect(err.message).toBe('Markdown file cannot be opened');
				expect(err.requestId).toBe('server-req-99');
				expect(err.status).toBe(409);
				expect(err.details).toEqual({ path: '/docs/plan.md' });
				return true;
			});
		});

		it('normalizes non-JSON or proxy error into E_INTERNAL ApiError', async () => {
			globalThis.fetch = vi.fn().mockImplementation(() =>
				Promise.resolve(
					new Response('<html>Bad Gateway</html>', {
						status: 500,
						statusText: 'Internal Server Error',
						headers: { 'x-request-id': 'gw-req-1' },
					}),
				),
			);

			const client = createHttpClient({ getBaseUrl: () => 'http://127.0.0.1:7817' });

			await expect(client.get('/api/v1/health')).rejects.toSatisfy((err: unknown) => {
				if (!isApiError(err)) return false;
				expect(err.code).toBe('E_INTERNAL');
				expect(err.status).toBe(500);
				expect(err.requestId).toBe('gw-req-1');
				return true;
			});
		});
	});

	describe('Interceptors: Headers, Tokens, Idempotency (AC 1, AC 5, E-14, E-126)', () => {
		it('injects X-Agsched-Client and Authorization header from token provider', async () => {
			let capturedHeaders: Headers | undefined;
			globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
				capturedHeaders = new Headers(init?.headers);
				return Promise.resolve(
					new Response(JSON.stringify({ status: 'ok' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}),
				);
			});

			const client = createHttpClient({
				getBaseUrl: () => 'http://127.0.0.1:7817',
				getToken: () => 'mock-device-token-123',
				clientVersion: '1.2.3',
			});

			const res = await client.get<{ status: string }>('/api/v1/health');
			expect(res).toEqual({ status: 'ok' });
			expect(capturedHeaders?.get('X-Agsched-Client')).toBe('web/1.2.3');
			expect(capturedHeaders?.get('Authorization')).toBe('Bearer mock-device-token-123');
			expect(getCachedToken()).toBe('mock-device-token-123');
		});

		it('caches token in module variable and does not call getToken on subsequent requests', async () => {
			const getTokenSpy = vi.fn().mockResolvedValue('token-once');
			globalThis.fetch = vi.fn().mockImplementation(() =>
				Promise.resolve(
					new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}),
				),
			);

			const client = createHttpClient({
				getBaseUrl: () => 'http://127.0.0.1:7817',
				getToken: getTokenSpy,
			});

			await client.get('/api/v1/documents');
			await client.get('/api/v1/agents');

			expect(getTokenSpy).toHaveBeenCalledTimes(1);
			expect(getCachedToken()).toBe('token-once');
		});

		it('omits Authorization header when auth: "none" is specified', async () => {
			let capturedHeaders: Headers | undefined;
			globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
				capturedHeaders = new Headers(init?.headers);
				return Promise.resolve(
					new Response(JSON.stringify({ status: 'ok' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}),
				);
			});

			setCachedToken('existing-token');
			const client = createHttpClient({ getBaseUrl: () => 'http://127.0.0.1:7817' });

			await client.request({
				path: '/api/v1/version',
				method: 'GET',
				auth: 'none',
			});

			expect(capturedHeaders?.get('Authorization')).toBeNull();
		});

		it('injects X-Idempotency-Key for write requests and reuses it across retries (AC 5, E-126)', async () => {
			const capturedKeys: string[] = [];
			globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
				const h = new Headers(init?.headers);
				const key = h.get('X-Idempotency-Key');
				if (key) capturedKeys.push(key);
				return Promise.resolve(
					new Response(JSON.stringify({ runId: 'run-new' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}),
				);
			});

			const client = createHttpClient({ getBaseUrl: () => 'http://127.0.0.1:7817' });

			const writeOptions = {
				timeoutMs: 5000,
			};

			// First manual dispatch
			await client.post('/api/v1/runs', { taskId: 'M9-T4' }, writeOptions);
			expect(capturedKeys.length).toBe(1);
			const firstKey = capturedKeys[0];
			expect(firstKey).toBeDefined();

			// Second dispatch re-using same options (e.g. user retrying a failed dispatch or concurrent click)
			await client.post('/api/v1/runs', { taskId: 'M9-T4' }, writeOptions);
			expect(capturedKeys.length).toBe(2);
			expect(capturedKeys[1]).toBe(firstKey);
		});

		it('does NOT inject X-Idempotency-Key on GET requests', async () => {
			let capturedKey: string | null = null;
			globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
				const h = new Headers(init?.headers);
				capturedKey = h.get('X-Idempotency-Key');
				return Promise.resolve(
					new Response(JSON.stringify([]), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}),
				);
			});

			const client = createHttpClient({ getBaseUrl: () => 'http://127.0.0.1:7817' });
			await client.get('/api/v1/runs');
			expect(capturedKey).toBeNull();
		});
	});

	describe('Retry strategy (AC 3)', () => {
		it('retries GET requests up to 2 times on network errors with 300ms and 900ms backoff', async () => {
			const delays: number[] = [];
			const mockSleep = vi.fn().mockImplementation((ms: number) => {
				delays.push(ms);
				return Promise.resolve();
			});

			let attempts = 0;
			globalThis.fetch = vi.fn().mockImplementation(() => {
				attempts += 1;
				if (attempts < 3) {
					return Promise.reject(new TypeError('Failed to fetch'));
				}
				return Promise.resolve(
					new Response(JSON.stringify({ healthy: true }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}),
				);
			});

			const client = createHttpClient({
				getBaseUrl: () => 'http://127.0.0.1:7817',
				sleep: mockSleep,
			});

			const result = await client.get<{ healthy: boolean }>('/api/v1/health');
			expect(result).toEqual({ healthy: true });
			expect(attempts).toBe(3); // attempt 0, retry 1, retry 2
			expect(delays).toEqual([300, 900]);
		});

		it('retries GET requests on 502/503/504 up to 2 times', async () => {
			const delays: number[] = [];
			const mockSleep = vi.fn().mockImplementation((ms: number) => {
				delays.push(ms);
				return Promise.resolve();
			});

			let attempts = 0;
			globalThis.fetch = vi.fn().mockImplementation(() => {
				attempts += 1;
				if (attempts === 1) {
					return Promise.resolve(new Response('Gateway Timeout', { status: 504 }));
				}
				if (attempts === 2) {
					return Promise.resolve(new Response('Bad Gateway', { status: 502 }));
				}
				return Promise.resolve(
					new Response(JSON.stringify({ agents: [] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}),
				);
			});

			const client = createHttpClient({
				getBaseUrl: () => 'http://127.0.0.1:7817',
				sleep: mockSleep,
			});

			const res = await client.get<{ agents: unknown[] }>('/api/v1/agents');
			expect(res).toEqual({ agents: [] });
			expect(attempts).toBe(3);
			expect(delays).toEqual([300, 900]);
		});

		it('does NOT retry GET requests on 500 or 4xx', async () => {
			let attempts = 0;
			globalThis.fetch = vi.fn().mockImplementation(() => {
				attempts += 1;
				return Promise.resolve(
					new Response(
						JSON.stringify({
							error: { code: 'E_INTERNAL', message: 'DB crash', requestId: 'req-500' },
						}),
						{ status: 500, headers: { 'Content-Type': 'application/json' } },
					),
				);
			});

			const client = createHttpClient({ getBaseUrl: () => 'http://127.0.0.1:7817' });

			await expect(client.get('/api/v1/agents')).rejects.toThrow();
			expect(attempts).toBe(1);
		});

		it('exhausts retries on persistent GET network failure and throws E_NETWORK ApiError', async () => {
			const delays: number[] = [];
			const mockSleep = vi.fn().mockImplementation((ms: number) => {
				delays.push(ms);
				return Promise.resolve();
			});

			globalThis.fetch = vi
				.fn()
				.mockImplementation(() => Promise.reject(new TypeError('Connection refused')));

			const client = createHttpClient({
				getBaseUrl: () => 'http://127.0.0.1:7817',
				sleep: mockSleep,
			});

			await expect(client.get('/api/v1/runs')).rejects.toSatisfy((err: unknown) => {
				if (!isApiError(err)) return false;
				expect(err.code).toBe('E_NETWORK');
				expect(err.message).toBe('Connection refused');
				return true;
			});

			expect(delays).toEqual([300, 900]);
		});

		it('POST requests are NEVER automatically retried (AC 3)', async () => {
			let postAttempts = 0;
			globalThis.fetch = vi.fn().mockImplementation(() => {
				postAttempts += 1;
				return Promise.resolve(
					new Response(
						JSON.stringify({
							error: { code: 'E_INTERNAL', message: 'Temporary failure', requestId: 'req-1' },
						}),
						{ status: 503, headers: { 'Content-Type': 'application/json' } },
					),
				);
			});

			const client = createHttpClient({ getBaseUrl: () => 'http://127.0.0.1:7817' });

			await expect(client.post('/api/v1/runs', { taskId: 'M9-T4' })).rejects.toSatisfy(
				(err: unknown) => {
					if (!isApiError(err)) return false;
					expect(err.status).toBe(503);
					return true;
				},
			);

			// Must strictly be tried only once
			expect(postAttempts).toBe(1);
		});

		it('PATCH and DELETE requests are also never automatically retried', async () => {
			let patchAttempts = 0;
			let deleteAttempts = 0;

			globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
				if (init?.method === 'PATCH') {
					patchAttempts += 1;
					return Promise.reject(new TypeError('Network offline'));
				}
				if (init?.method === 'DELETE') {
					deleteAttempts += 1;
					return Promise.resolve(new Response('Gateway Timeout', { status: 504 }));
				}
				return Promise.resolve(new Response(null, { status: 200 }));
			});

			const client = createHttpClient({ getBaseUrl: () => 'http://127.0.0.1:7817' });

			await expect(client.patch('/api/v1/agents/dev', { model: 'gpt' })).rejects.toSatisfy(
				(err: unknown) => {
					if (!isApiError(err)) return false;
					expect(err.code).toBe('E_NETWORK');
					return true;
				},
			);
			expect(patchAttempts).toBe(1);

			await expect(client.delete('/api/v1/devices/dev-1')).rejects.toSatisfy((err: unknown) => {
				if (!isApiError(err)) return false;
				expect(err.status).toBe(504);
				return true;
			});
			expect(deleteAttempts).toBe(1);
		});
	});

	describe('401 handling (07-前端架构 / AC 4)', () => {
		it('clears in-memory token, clears sessionStorage fallback, triggers onUnauthorized callback, and throws E_UNAUTHORIZED ApiError', async () => {
			setCachedToken('revoked-token');
			sessionStorage.setItem(SESSION_STORAGE_TOKEN_KEY, 'revoked-token');
			const onUnauthorizedSpy = vi.fn();

			globalThis.fetch = vi.fn().mockImplementation(() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							error: {
								code: 'E_UNAUTHORIZED',
								message: 'Invalid or revoked token',
								requestId: 'req-401',
							},
						}),
						{ status: 401, headers: { 'Content-Type': 'application/json' } },
					),
				),
			);

			const client = createHttpClient({
				getBaseUrl: () => 'http://127.0.0.1:7817',
				onUnauthorized: onUnauthorizedSpy,
			});

			await expect(client.get('/api/v1/documents')).rejects.toSatisfy((err: unknown) => {
				if (!isApiError(err)) return false;
				expect(err.code).toBe('E_UNAUTHORIZED');
				expect(err.status).toBe(401);
				return true;
			});

			expect(getCachedToken()).toBeNull();
			expect(sessionStorage.getItem(SESSION_STORAGE_TOKEN_KEY)).toBeNull();
			expect(onUnauthorizedSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('callRoute integration with shared RouteDefinition', () => {
		it('invokes RouteDefinition with interpolated parameters and correct method and auth', async () => {
			let capturedUrl: string | undefined;
			let capturedMethod: string | undefined;

			globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
				capturedUrl = url;
				capturedMethod = init?.method;
				return Promise.resolve(
					new Response(JSON.stringify({ runId: 'run-1', state: 'aborted' }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}),
				);
			});

			const client = createHttpClient({ getBaseUrl: () => 'http://127.0.0.1:7817' });

			const abortRoute: RouteDefinition = {
				method: 'POST',
				path: '/api/v1/runs/:runId/abort',
				auth: 'device',
				reqType: 'AbortRunBody',
				resType: 'AbortRunResponse',
				errors: ['E_UNAUTHORIZED', 'E_NOT_FOUND', 'E_VALIDATION', 'E_INTERNAL'],
			};

			const response = await client.callRoute<{ runId: string; state: string }>(abortRoute, {
				params: { runId: 'run-987' },
				body: { reason: 'user requested' },
			});

			expect(capturedUrl).toBe('http://127.0.0.1:7817/api/v1/runs/run-987/abort');
			expect(capturedMethod).toBe('POST');
			expect(response).toEqual({ runId: 'run-1', state: 'aborted' });
		});
	});
});
