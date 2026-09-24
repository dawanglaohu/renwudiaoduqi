/**
 * packages/web/src/api/lanes.ts
 *
 * 泳道数据客户端（M9-T21 / AC 7b, E-317, E-333 / 07 节前端架构）
 *
 * 规范依据：
 * - 唯一 fetch 出口是 src/api/http-client.ts，本文件只做资源封装，禁止 URL 字面量
 * - 调既有 GET /snapshot?docId 只取 .lanes，latestEventId 与其余键一律丢弃、不写 connection-store.lastEventId（E-333）
 * - 快照缺 lanes 键或不是数组 → 抛出异常，运行甲板呈现「泳道数据不可用」，按 E-26 不自算槽位（E-333）
 * - 同一 tick 内连续到达 lane.released 与 lane.assigned → 对同一 key 的在途请求合并只发一次，
 *   失效发生在请求已发出之后则响应到达后必须再拉一次（E-333）
 */

import type { LaneView } from '@agent-scheduler/shared/api/lanes';
import { ROUTES, type RouteDefinition } from '@agent-scheduler/shared/api/routes';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import { httpClient } from './http-client.ts';

export const SNAPSHOT_PATH = '/api/v1/snapshot' as const;

function findSnapshotRoute(): RouteDefinition {
	const route = ROUTES.find((entry) => entry.method === 'GET' && entry.path === SNAPSHOT_PATH);
	if (!route) {
		throw new Error(`GET ${SNAPSHOT_PATH} is missing from the shared ROUTES table`);
	}
	return route;
}

const GET_SNAPSHOT_ROUTE = findSnapshotRoute();

interface InFlightLanesRequest {
	promise: Promise<readonly LaneView[]>;
	invalidatedWhileInFlight: boolean;
}

const inFlightByDoc = new Map<string, InFlightLanesRequest>();

/**
 * 标记指定文档的泳道缓存失效（E-333）。
 * 若当前有在途请求，将其标记为需要在响应到达后重新拉取最新数据。
 */
export function markLanesCacheInvalidated(docId?: string | null): void {
	const key = docId ?? '';
	const inFlight = inFlightByDoc.get(key);
	if (inFlight) {
		inFlight.invalidatedWhileInFlight = true;
	}
}

/**
 * 拉取泳道数据列表（E-333, AC 7b）。
 * - 调既有 GET /snapshot?docId 只取 .lanes
 * - latestEventId 与其余键一律丢弃、不写 connection-store.lastEventId
 * - 快照缺 lanes 键或不是数组 → 抛出 Error('泳道数据不可用')
 * - 合并在途请求，若在途期间发生失效则自动再拉一次
 */
export function fetchLanes(docId?: string | null): Promise<readonly LaneView[]> {
	const key = docId ?? '';
	const existing = inFlightByDoc.get(key);
	if (existing) {
		return existing.promise;
	}

	let invalidatedWhileInFlight = false;
	const promise = (async () => {
		try {
			const res = await httpClient.callRoute<SnapshotResponse>(GET_SNAPSHOT_ROUTE, {
				query: docId ? { docId } : undefined,
			});

			// E-333: 快照缺 lanes 键或不是数组 → 抛出异常，甲板呈现「泳道数据不可用」
			if (!res || !Array.isArray(res.lanes)) {
				throw new Error('泳道数据不可用');
			}

			// E-333: latestEventId 与其余键一律丢弃，不写 connection-store
			const lanes = res.lanes;

			// 若在请求在途期间到达了失效事件，响应到达后必须再拉一次（E-333）
			if (invalidatedWhileInFlight) {
				inFlightByDoc.delete(key);
				return await fetchLanes(docId);
			}

			return lanes;
		} finally {
			inFlightByDoc.delete(key);
		}
	})();

	const reqState: InFlightLanesRequest = {
		promise,
		get invalidatedWhileInFlight() {
			return invalidatedWhileInFlight;
		},
		set invalidatedWhileInFlight(val: boolean) {
			invalidatedWhileInFlight = val;
		},
	};

	inFlightByDoc.set(key, reqState);
	return promise;
}
