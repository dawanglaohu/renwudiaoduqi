// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listModels } from '../src/api/agents.ts';
import { registerShellHostHint } from '../src/api/base-url.ts';
import { clearCachedToken, registerTokenProvider } from '../src/api/http-client.ts';

beforeEach(() => {
	vi.useFakeTimers();
	registerShellHostHint(() => 'http://127.0.0.1:7817');
	registerTokenProvider(() => 'unit-device-token');
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	registerShellHostHint(null);
	registerTokenProvider(null);
	clearCachedToken();
});

it('waits for a 10-second explicit refresh without aborting and sending a second subprocess request', async () => {
	const fetcher = vi.fn(
		(_url: string, options: RequestInit) =>
			new Promise<Response>((resolve, reject) => {
				const timer = setTimeout(
					() =>
						resolve(
							new Response(JSON.stringify({ models: [], isRefreshing: false }), { status: 200 }),
						),
					10000,
				);
				options.signal?.addEventListener('abort', () => {
					clearTimeout(timer);
					reject(new DOMException('aborted', 'AbortError'));
				});
			}),
	);
	vi.stubGlobal('fetch', fetcher);
	const refresh = listModels('codex', { refresh: true });
	await vi.advanceTimersByTimeAsync(10000);
	expect(fetcher).toHaveBeenCalledTimes(1);
	await expect(refresh).resolves.toMatchObject({ isRefreshing: false });
});

it('never retries an explicit refresh after network failure', async () => {
	const fetcher = vi.fn().mockRejectedValue(new TypeError('network disconnected'));
	vi.stubGlobal('fetch', fetcher);
	const refresh = listModels('codex', { refresh: true }).catch((error) => error);
	await vi.runAllTimersAsync();
	expect((await refresh).code).toBe('E_NETWORK');
	expect(fetcher).toHaveBeenCalledTimes(1);
});
