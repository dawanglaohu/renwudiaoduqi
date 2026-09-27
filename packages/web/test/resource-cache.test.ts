/**
 * packages/web/test/resource-cache.test.ts
 *
 * 服务端态极小资源缓存单元测试（R16-T83723920 / 07 节前端架构 / AC 1, AC 4, E-12, E-333）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearResourceCache,
	getRegisteredKeys,
	invalidate,
	peek,
	read,
	refetchAll,
	unregister,
} from '../src/api/resource-cache.ts';

describe('api/resource-cache (07 节前端架构 / AC 1, AC 4, E-12, E-333)', () => {
	beforeEach(() => {
		clearResourceCache();
		vi.clearAllMocks();
	});

	// ─── 1. 并发 read 去重：共享同 key 在途 Promise ───
	it('deduplicates concurrent reads for the same key to share one in-flight promise (AC 1, AC 4)', async () => {
		let resolveFetch: ((val: string) => void) | undefined;
		const fetcher = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolveFetch = resolve;
				}),
		);

		const p1 = read('settings:pipeline', fetcher);
		const p2 = read('settings:pipeline', fetcher);

		expect(fetcher).toHaveBeenCalledTimes(1);

		resolveFetch?.('pipeline-v1');
		const [r1, r2] = await Promise.all([p1, p2]);

		expect(r1).toBe('pipeline-v1');
		expect(r2).toBe('pipeline-v1');
		expect(peek('settings:pipeline')).toBe('pipeline-v1');
	});

	// ─── 2. 缓存命中：第二次直接返回已缓存数据 ───
	it('returns cached data on subsequent read without calling fetcher again (AC 1)', async () => {
		const fetcher = vi.fn(async () => ({ bughunt: 0, wrapupMode: 'auto' }));

		const first = await read('settings:pipeline', fetcher);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(first).toEqual({ bughunt: 0, wrapupMode: 'auto' });

		const second = await read('settings:pipeline', fetcher);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(second).toEqual({ bughunt: 0, wrapupMode: 'auto' });
	});

	// ─── 3. 登记最新 fetcher：以最后一次传入的 fetcher 为准 ───
	it('registers the latest fetcher on each read and uses it on refetchAll (AC 1, AC 4)', async () => {
		const fetcherA = vi.fn(async () => 'value-A');
		const fetcherB = vi.fn(async () => 'value-B');

		await read('settings:pipeline', fetcherA);
		expect(fetcherA).toHaveBeenCalledTimes(1);

		// 再次传入 fetcherB，登记最新 fetcher
		await read('settings:pipeline', fetcherB);
		expect(fetcherB).toHaveBeenCalledTimes(0); // 缓存命中，此时不发请求

		// 触发 refetchAll，必须调用最新登记的 fetcherB，而非 fetcherA
		await refetchAll();
		expect(fetcherA).toHaveBeenCalledTimes(1);
		expect(fetcherB).toHaveBeenCalledTimes(1);
		expect(peek('settings:pipeline')).toBe('value-B');
	});

	// ─── 4. 前缀失效：invalidate(prefix) 批量失效并清除对应缓存 ───
	it('invalidates matching keys by prefix and forces next read to re-fetch (AC 1, AC 4)', async () => {
		const pipelineFetcher = vi.fn(async () => 'pipeline-data');
		const gatesFetcher = vi.fn(async () => 'gates-data');
		const lanesFetcher = vi.fn(async () => 'lanes-data');

		await read('settings:pipeline', pipelineFetcher);
		await read('settings:gates', gatesFetcher);
		await read('lanes:doc-1', lanesFetcher);

		expect(peek('settings:pipeline')).toBe('pipeline-data');
		expect(peek('settings:gates')).toBe('gates-data');
		expect(peek('lanes:doc-1')).toBe('lanes-data');

		// 失效 'settings' 前缀
		invalidate('settings');

		expect(peek('settings:pipeline')).toBeUndefined();
		expect(peek('settings:gates')).toBeUndefined();
		expect(peek('lanes:doc-1')).toBe('lanes-data'); // lanes 不受影响

		// 再次读取 settings:pipeline，重新触发 fetcher
		const nextPipelineFetcher = vi.fn(async () => 'pipeline-fresh');
		const fresh = await read('settings:pipeline', nextPipelineFetcher);
		expect(nextPipelineFetcher).toHaveBeenCalledTimes(1);
		expect(fresh).toBe('pipeline-fresh');
	});

	// ─── 5. E-333 在途期间失效：在途响应已过时，绝不存入缓存 ───
	it('does not store stale in-flight response into cache when invalidated while in-flight (E-333, AC 2)', async () => {
		let resolveOld: ((val: string) => void) | undefined;
		const slowFetcher = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolveOld = resolve;
				}),
		);

		const inFlightPromise = read('settings:pipeline', slowFetcher);

		// 在在途期间触发失效
		invalidate('settings');

		// 慢速在途请求终于返回旧数据
		resolveOld?.('stale-data');
		const res = await inFlightPromise;
		expect(res).toBe('stale-data');

		// 关键断言：因为在途期间失效，该旧数据绝未被写入缓存
		expect(peek('settings:pipeline')).toBeUndefined();

		// 下一次 read 必须重新发起请求
		const freshFetcher = vi.fn(async () => 'fresh-data');
		const freshRes = await read('settings:pipeline', freshFetcher);
		expect(freshFetcher).toHaveBeenCalledTimes(1);
		expect(freshRes).toBe('fresh-data');
		expect(peek('settings:pipeline')).toBe('fresh-data');
	});

	// ─── 6. 连接恢复：refetchAll 并发重新拉取所有已登记 key ───
	it('refetches all registered keys concurrently on refetchAll (AC 3, E-12)', async () => {
		const fetcher1 = vi.fn(async () => 'res-1');
		const fetcher2 = vi.fn(async () => 'res-2');

		await read('settings:pipeline', fetcher1);
		await read('lanes:doc-1', fetcher2);

		expect(getRegisteredKeys()).toContain('settings:pipeline');
		expect(getRegisteredKeys()).toContain('lanes:doc-1');

		await refetchAll();

		expect(fetcher1).toHaveBeenCalledTimes(2);
		expect(fetcher2).toHaveBeenCalledTimes(2);
		expect(peek('settings:pipeline')).toBe('res-1');
		expect(peek('lanes:doc-1')).toBe('res-2');
	});

	// ─── 7. 架构约束：无 set / put / patch、无轮询或时间型 stale ───
	it('strictly adheres to architecture without set/put/patch or time-based stale (AC 1)', async () => {
		const cacheModule = await import('../src/api/resource-cache.ts');

		expect('set' in cacheModule).toBe(false);
		expect('put' in cacheModule).toBe(false);
		expect('patch' in cacheModule).toBe(false);

		// unregister 可安全注销特定 key
		await read('settings:pipeline', async () => 'test');
		expect(peek('settings:pipeline')).toBe('test');
		unregister('settings:pipeline');
		expect(peek('settings:pipeline')).toBeUndefined();
		expect(getRegisteredKeys()).not.toContain('settings:pipeline');
	});
});
