/**
 * packages/web/src/api/resource-cache.ts
 *
 * 服务端态极小资源缓存（07 节前端架构 / E-12, E-333）
 *
 * 规范依据（07 节前端架构）：
 * - 不引第三个库，极小实现 read(key, fetcher) / invalidate(prefix) / refetchAll()
 * - read() 对同 key 的并发调用共享同一在途 promise，并以最后一次传入的 fetcher 为 refetchAll() 的登记 fetcher
 * - 绝对没有 set / put / patch 方法，严禁客户端轮询、严禁时间型 stale 窗口
 * - 失效只由事件驱动（cache-invalidation.ts 一张常量表映射）
 * - E-333: 同一 key 在途期间如果发生失效，响应到达后必须使用最新登记的 fetcher 自动再拉取一次
 * - 断线重连后调一次 refetchAll() 补拉
 */

interface InFlightEntry<T> {
	promise: Promise<T>;
	invalidatedWhileInFlight: boolean;
}

const dataCache = new Map<string, unknown>();
const inFlightRequests = new Map<string, InFlightEntry<unknown>>();
const registeredFetchers = new Map<string, () => Promise<unknown>>();

/**
 * 判断缓存 key 是否匹配指定失效前缀。
 * 规则：key 全等，或者形如 `${prefix}:...`。
 * 例如 prefix 为 'settings' 会匹配 'settings' 和 'settings:pipeline'，但不会误伤其他前缀。
 */
function matchesPrefix(key: string, prefix: string): boolean {
	return key === prefix || key.startsWith(`${prefix}:`);
}

/**
 * 读取指定 key 的资源。
 * - 登记传入的 fetcher 为最新 fetcher（用于失效后重拉与 refetchAll）
 * - 若已有缓存且未失效，直接返回已缓存数据
 * - 若已有在途请求，共享同一个在途 Promise（并发去重）
 * - 若在途期间该 key 被标记失效（E-333），在途请求完成后自动使用最新 fetcher 重新拉取一次
 */
export async function read<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
	registeredFetchers.set(key, fetcher as () => Promise<unknown>);

	// 缓存命中且无在途请求时，直接返回缓存数据
	if (dataCache.has(key) && !inFlightRequests.has(key)) {
		return dataCache.get(key) as T;
	}

	const existing = inFlightRequests.get(key);
	if (existing) {
		return existing.promise as Promise<T>;
	}

	const entry: InFlightEntry<T> = {
		promise: Promise.resolve() as Promise<T>,
		invalidatedWhileInFlight: false,
	};

	const execute = async (): Promise<T> => {
		try {
			while (true) {
				entry.invalidatedWhileInFlight = false;
				const currentFetcher = (registeredFetchers.get(key) ?? fetcher) as () => Promise<T>;
				const data = await currentFetcher();

				// 注销或重新登记期间，旧请求不得重新写入缓存，也不再重试。
				if (inFlightRequests.get(key) !== (entry as InFlightEntry<unknown>)) {
					return data;
				}

				// 若在途期间到达了失效事件（E-333），旧响应已过时，必须使用最新登记的 fetcher 自动再拉一次
				if (entry.invalidatedWhileInFlight) {
					continue;
				}

				dataCache.set(key, data);
				return data;
			}
		} finally {
			if (inFlightRequests.get(key) === (entry as InFlightEntry<unknown>)) {
				inFlightRequests.delete(key);
			}
		}
	};

	entry.promise = execute();
	inFlightRequests.set(key, entry as InFlightEntry<unknown>);
	return entry.promise;
}

/**
 * 按前缀使已缓存的数据失效（E-333, 07 节前端架构）。
 * - 清空所有匹配该前缀的已缓存数据
 * - 若存在正在进行中的在途请求，标记为 invalidatedWhileInFlight = true
 */
export function invalidate(prefix: string): void {
	for (const key of dataCache.keys()) {
		if (matchesPrefix(key, prefix)) {
			dataCache.delete(key);
		}
	}

	for (const [key, entry] of inFlightRequests.entries()) {
		if (matchesPrefix(key, prefix)) {
			entry.invalidatedWhileInFlight = true;
		}
	}
}

/**
 * 重新拉取所有已登记 key 的资源（E-12, 07 节前端架构）。
 * 对每一个登记了 fetcher 的 key：清空缓存并使用最新登记的 fetcher 重新拉取。
 */
export async function refetchAll(): Promise<void> {
	const keys = Array.from(registeredFetchers.keys());
	if (keys.length === 0) return;

	for (const key of keys) {
		dataCache.delete(key);
		const inFlight = inFlightRequests.get(key);
		if (inFlight) {
			inFlight.invalidatedWhileInFlight = true;
		}
	}

	await Promise.allSettled(
		keys.map(async (key) => {
			const fetcher = registeredFetchers.get(key);
			if (fetcher) {
				await read(key, fetcher);
			}
		}),
	);
}

/**
 * 测试与调试辅助：直接查看当前缓存中的数据，不触发网络请求。
 */
export function peek<T = unknown>(key: string): T | undefined {
	return dataCache.get(key) as T | undefined;
}

/**
 * 获取当前所有已登记 fetcher 的 key 列表。
 */
export function getRegisteredKeys(): readonly string[] {
	return Array.from(registeredFetchers.keys());
}

/**
 * 注销特定 key 的登记和缓存（用于组件彻底注销或清理）。
 */
export function unregister(key: string): void {
	dataCache.delete(key);
	registeredFetchers.delete(key);
	inFlightRequests.delete(key);
}

/**
 * 测试环境重置：清空全部缓存、在途与已登记的 fetcher。
 */
export function clearResourceCache(): void {
	dataCache.clear();
	inFlightRequests.clear();
	registeredFetchers.clear();
}
