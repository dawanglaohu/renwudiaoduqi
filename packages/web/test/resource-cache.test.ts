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

	// ─── 5. E-333 在途期间失效：自动使用最新登记的 fetcher 重拉，调用方拿到新值 ───
	it('automatically re-fetches with latest fetcher and resolves caller with fresh value on in-flight invalidation (E-333, AC 1, AC 2)', async () => {
		let resolveOld: ((val: string) => void) | undefined;
		let fetchCallCount = 0;

		const fetcher = vi.fn(async () => {
			fetchCallCount++;
			if (fetchCallCount === 1) {
				return new Promise<string>((resolve) => {
					resolveOld = resolve;
				});
			}
			return 'fresh-data-v2';
		});

		// 发起初次读取（在途）
		const inFlightPromise = read('settings:pipeline', fetcher);

		// 在途期间收到失效事件
		invalidate('settings');

		// 旧请求返回旧值
		resolveOld?.('stale-data-v1');

		// 等待 read() 的调用方应得到自动重拉后的新值
		const res = await inFlightPromise;
		expect(res).toBe('fresh-data-v2');
		expect(fetchCallCount).toBe(2);
		expect(peek('settings:pipeline')).toBe('fresh-data-v2');
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

	// ─── 8. E-333 受控并发：同一 tick 连续到达 lane.released / lane.assigned ───
	it('handles consecutive lane.released and lane.assigned in-flight, re-fetching lanes only once on resolution (E-333)', async () => {
		let resolveOldLanes: ((val: string) => void) | undefined;
		let lanesCalls = 0;

		const lanesFetcher = vi.fn(async () => {
			lanesCalls++;
			if (lanesCalls === 1) {
				return new Promise<string>((resolve) => {
					resolveOldLanes = resolve;
				});
			}
			return 'lanes-re-fetched';
		});

		// 请求已发出（在途）
		const lanesPromise = read('lanes:doc-1', lanesFetcher);

		// 同一 tick 内连续到达 lane.released 与 lane.assigned
		// lane.released 失效 lanes, tasks
		invalidate('lanes');
		invalidate('tasks');
		// lane.assigned 失效 lanes, runs
		invalidate('lanes');
		invalidate('runs');

		// 响应到达
		resolveOldLanes?.('lanes-stale');

		// 响应到达后自动再拉一次并 resolve 新值
		const result = await lanesPromise;
		expect(result).toBe('lanes-re-fetched');
		expect(lanesCalls).toBe(2); // 连续失效合并为完成后的单次重拉
		expect(peek('lanes:doc-1')).toBe('lanes-re-fetched');
	});

	// ─── 9. E-333 受控并发：lanes 与 runs 分别使用各自的 fetcher ───
	it('keeps lanes and runs fetchers separate and independent when both invalidated (E-333)', async () => {
		const lanesFetcher = vi.fn(async () => [{ id: 'lane-1' }]);
		const runsFetcher = vi.fn(async () => [{ id: 'run-1' }]);

		await read('lanes:doc-1', lanesFetcher);
		await read('runs:doc-1', runsFetcher);

		expect(lanesFetcher).toHaveBeenCalledTimes(1);
		expect(runsFetcher).toHaveBeenCalledTimes(1);

		// lane.assigned 同时失效 lanes 与 runs
		invalidate('lanes');
		invalidate('runs');

		// 两个 fetcher 各自请求，不从对方或快照取
		const nextLanes = vi.fn(async () => [{ id: 'lane-2' }]);
		const nextRuns = vi.fn(async () => [{ id: 'run-2' }]);

		const [lanesData, runsData] = await Promise.all([
			read('lanes:doc-1', nextLanes),
			read('runs:doc-1', nextRuns),
		]);

		expect(nextLanes).toHaveBeenCalledTimes(1);
		expect(nextRuns).toHaveBeenCalledTimes(1);
		expect(lanesData).toEqual([{ id: 'lane-2' }]);
		expect(runsData).toEqual([{ id: 'run-2' }]);
	});
});
