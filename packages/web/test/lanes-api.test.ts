import type { LaneView } from '@agent-scheduler/shared/api/lanes';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { httpClient } from '../src/api/http-client.ts';
import { fetchLanes, markLanesCacheInvalidated } from '../src/api/lanes.ts';

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('M9-T21 R4: fetchLanes in-flight request merging and invalidation race condition', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('merges in-flight requests and avoids race condition: 第一次响应前失效 → 第二次在途又失效 → 最终结果与请求数 (E-333, R4)', async () => {
		const docId = 'doc-race-test';
		let callCount = 0;
		const deferredQueue: Array<ReturnType<typeof createDeferred<{ lanes: readonly LaneView[] }>>> =
			[];

		vi.spyOn(httpClient, 'callRoute').mockImplementation(async () => {
			callCount++;
			const def = createDeferred<{ lanes: readonly LaneView[] }>();
			deferredQueue.push(def);
			return def.promise;
		});

		// 1. 发起第 1 次 fetchLanes 请求
		const p1 = fetchLanes(docId);
		expect(callCount).toBe(1);
		expect(deferredQueue.length).toBe(1);

		// 2. 在第 1 次响应返回前，触发失效
		markLanesCacheInvalidated(docId);

		// 3. 第 1 次响应到达，应触发递归发起第 2 次 fetchLanes
		deferredQueue[0]?.resolve({
			lanes: [
				{
					laneNo: 1,
					taskId: 't1',
					currentRunId: 'r1',
					stage: 'implement',
					nextTaskId: null,
					nextBlockedBy: [],
					archivedTaskIds: [],
					archivedWrapupRunId: null,
					overLimit: false,
				},
			],
		});

		// 等待微任务与事件循环，让第 1 个 promise 处理完成并启动第 2 个请求
		await new Promise((r) => setTimeout(r, 10));

		expect(callCount).toBe(2);
		expect(deferredQueue.length).toBe(2);

		// 4. 关键检验：在第 2 次请求在途期间，再次触发失效，且同时有并发调用 fetchLanes(docId)
		markLanesCacheInvalidated(docId);
		const pConcurrent = fetchLanes(docId);

		// 在原错误下，第 1 次请求的 finally 误删除了 inFlightByDoc 中的第 2 次请求条目，
		// 导致 pConcurrent 会立即启动第 3 次并发请求（callCount 变成 3）。
		// 修复后，pConcurrent 必须合并复用第 2 次在途请求，callCount 维持 2！
		expect(callCount).toBe(2);

		// 5. 第 2 次请求响应到达。由于在途期间再次失效，它会启动第 3 次 fetchLanes
		deferredQueue[1]?.resolve({
			lanes: [
				{
					laneNo: 1,
					taskId: 't1',
					currentRunId: 'r2',
					stage: 'review',
					nextTaskId: null,
					nextBlockedBy: [],
					archivedTaskIds: [],
					archivedWrapupRunId: null,
					overLimit: false,
				},
			],
		});

		// 等待第 2 次响应完成并启动第 3 次请求（但第 3 次请求仍在途）
		await new Promise((r) => setTimeout(r, 10));

		expect(callCount).toBe(3);
		expect(deferredQueue.length).toBe(3);

		// 关键检验点：此时第 3 次请求仍在途！在原错误中，第 1 次的 finally 会把第 3 次请求从 inFlightByDoc 误删。
		// 如果此时来了一个新请求，原错误会触发第 4 次请求；正确修复后必须复用第 3 次请求，callCount 必须保持 3！
		const p3Concurrent = fetchLanes(docId);
		expect(callCount).toBe(3);

		// 6. 第 3 次请求响应到达
		const finalLanes: readonly LaneView[] = [
			{
				laneNo: 1,
				taskId: 't1',
				currentRunId: 'r3',
				stage: 'review',
				nextTaskId: null,
				nextBlockedBy: [],
				archivedTaskIds: [],
				archivedWrapupRunId: null,
				overLimit: false,
			},
		];
		deferredQueue[2]?.resolve({ lanes: finalLanes });

		const [res1, resConcurrent, res3] = await Promise.all([p1, pConcurrent, p3Concurrent]);

		expect(res1).toEqual(finalLanes);
		expect(resConcurrent).toEqual(finalLanes);
		expect(res3).toEqual(finalLanes);
		expect(callCount).toBe(3);
	});

	it('throws Error("泳道数据不可用") when lanes key is missing or not an array (E-333)', async () => {
		vi.spyOn(httpClient, 'callRoute').mockResolvedValueOnce({
			tasks: [],
			batches: [],
		} as unknown as SnapshotResponse);

		await expect(fetchLanes('doc-bad')).rejects.toThrow('泳道数据不可用');
	});
});
