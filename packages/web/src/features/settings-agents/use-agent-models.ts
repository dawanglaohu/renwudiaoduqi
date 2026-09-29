/**
 * packages/web/src/features/settings-agents/use-agent-models.ts
 *
 * Agent 模型清单唯一获取 Hook（M9-T23 / AC 4, E-338, E-339 / 07 节前端架构）
 *
 * 规范依据：
 * - 本 Hook 是全仓唯一调 GET /agents/:id/models 的地方
 * - 首读走普通 fetcher（无 query）
 * - refresh() 走 invalidate(exactKey) → read(exactKey, refreshFetcher)（query 精确为 refresh=1）
 * - 同一 agent 在途时后续 refresh() 直接返回，且两个面板看到同一个 refreshPending
 * - settle 后再 read(key, normalFetcher) 换回普通 fetcher（避免 refetchAll 触发子进程）
 * - 在途或响应 isRefreshing: true 时返回 useRef 里最近一次完整清单
 * - refresh=1 只在用户点击时发，挂载／重连／事件到达严禁发送
 */

import type {
	AgentCurrentConfigDto,
	AgentModelItem,
	ListAgentModelsResponse,
} from '@agent-scheduler/shared/api/agents';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { listModels } from '../../api/agents.ts';
import { CACHE_KEYS } from '../../api/cache-keys.ts';
import { invalidate, read } from '../../api/resource-cache.ts';

export interface UseAgentModelsResult {
	readonly catalog: ListAgentModelsResponse | null;
	readonly models: readonly AgentModelItem[];
	readonly modelNames: readonly string[];
	readonly isComplete: boolean;
	readonly isLoading: boolean;
	readonly isRefreshing: boolean;
	readonly error: Error | null;
	readonly currentConfig: AgentCurrentConfigDto | null;
	readonly refresh: () => Promise<void>;
	readonly addCustomModel: (modelName: string) => void;
}

// 模块级在途 refresh 协调器：同一 agentId 共享同一个在途 Promise 与 pending 状态
const inflightRefreshes = new Map<string, Promise<void>>();
const refreshListeners = new Set<() => void>();

function notifyRefreshListeners(): void {
	for (const listener of refreshListeners) {
		try {
			listener();
		} catch {
			// 忽略
		}
	}
}

function subscribeRefreshState(listener: () => void): () => void {
	refreshListeners.add(listener);
	return () => {
		refreshListeners.delete(listener);
	};
}

let refreshStateVersion = 0;
function getRefreshStateSnapshot(): number {
	return refreshStateVersion;
}

export function useAgentModels(agentId?: string | null): UseAgentModelsResult {
	// 订阅全局 refreshPending 状态
	useSyncExternalStore(subscribeRefreshState, getRefreshStateSnapshot, getRefreshStateSnapshot);

	const isRefreshInflight = Boolean(agentId && inflightRefreshes.has(agentId));

	const [catalog, setCatalog] = useState<ListAgentModelsResponse | null>(null);
	const [isLoading, setIsLoading] = useState<boolean>(false);
	const [error, setError] = useState<Error | null>(null);

	// 在途或响应 isRefreshing: true 时沿用最近一次完整清单
	const lastCompleteCatalogRef = useRef<ListAgentModelsResponse | null>(null);

	// 注入手动填写的自定义模型
	const [customModels, setCustomModels] = useState<readonly AgentModelItem[]>([]);

	// 普通 fetcher（首读与 refetchAll 备用，无 query）
	const getNormalFetcher = useCallback(() => {
		if (!agentId) return async () => Promise.reject(new Error('Missing agentId'));
		return () => listModels(agentId);
	}, [agentId]);

	// 刷新 fetcher（用户手动点击 refresh 时使用，query 为 refresh=1）
	const getRefreshFetcher = useCallback(() => {
		if (!agentId) return async () => Promise.reject(new Error('Missing agentId'));
		return () => listModels(agentId, { refresh: true });
	}, [agentId]);

	// 首次挂载或 agentId 变化拉取
	useEffect(() => {
		if (!agentId) {
			setCatalog(null);
			setIsLoading(false);
			setError(null);
			setCustomModels([]);
			lastCompleteCatalogRef.current = null;
			return;
		}

		let isCurrent = true;
		const exactKey = CACHE_KEYS.agentModels(agentId);

		setIsLoading(true);
		setError(null);

		void (async () => {
			try {
				const normalFetcher = getNormalFetcher();
				const res = await read(exactKey, normalFetcher);
				if (!isCurrent) return;

				setCatalog(res);
				if (!res.isRefreshing) {
					lastCompleteCatalogRef.current = res;
				}
				setIsLoading(false);
			} catch (err) {
				if (!isCurrent) return;
				const e = err instanceof Error ? err : new Error(String(err));
				setError(e);
				setIsLoading(false);
			}
		})();

		return () => {
			isCurrent = false;
		};
	}, [agentId, getNormalFetcher]);

	// 用户手动触发 refresh
	const refresh = useCallback(async (): Promise<void> => {
		if (!agentId) return;

		// 若该 agentId 正在刷新中，直接复用在途请求
		const existingPromise = inflightRefreshes.get(agentId);
		if (existingPromise) {
			await existingPromise;
			return;
		}

		const exactKey = CACHE_KEYS.agentModels(agentId);
		const refreshFetcher = getRefreshFetcher();
		const normalFetcher = getNormalFetcher();

		const execute = async () => {
			try {
				// 1. 失效缓存
				invalidate(exactKey);
				// 2. 发送带 refresh=1 的请求
				const res = await read(exactKey, refreshFetcher);
				setCatalog(res);
				if (!res.isRefreshing) {
					lastCompleteCatalogRef.current = res;
				}
				setError(null);
			} catch (err) {
				const e = err instanceof Error ? err : new Error(String(err));
				setError(e);
			} finally {
				// 3. settle 后立刻换回普通 fetcher（避免重连 refetchAll 触发子进程）
				try {
					await read(exactKey, normalFetcher);
				} catch {
					// 仅登记 normalFetcher，忽略换回时的重复异常
				}
				inflightRefreshes.delete(agentId);
				refreshStateVersion++;
				notifyRefreshListeners();
			}
		};

		const refreshPromise = execute();
		inflightRefreshes.set(agentId, refreshPromise);
		refreshStateVersion++;
		notifyRefreshListeners();

		await refreshPromise;
	}, [agentId, getNormalFetcher, getRefreshFetcher]);

	const addCustomModel = useCallback((modelName: string) => {
		const trimmed = modelName.trim();
		if (!trimmed) return;
		setCustomModels((prev) => {
			if (prev.some((m) => m.name === trimmed)) return prev;
			return [
				...prev,
				{
					name: trimmed,
					source: 'manual',
					isCurrentConfig: false,
				},
			];
		});
	}, []);

	// 当前有效的 catalog：如果在途或响应为 isRefreshing，优先返回最近一次完整清单
	const effectiveCatalog =
		(isRefreshInflight || catalog?.isRefreshing) && lastCompleteCatalogRef.current
			? lastCompleteCatalogRef.current
			: catalog;

	const baseModels = effectiveCatalog?.models ?? [];
	const allModels = [...baseModels, ...customModels];
	const modelNames = allModels.map((m) => m.name);
	const isComplete = effectiveCatalog?.isComplete ?? true;
	const isRefreshing = isRefreshInflight || Boolean(catalog?.isRefreshing);

	return {
		catalog: effectiveCatalog,
		models: allModels,
		modelNames,
		isComplete,
		isLoading,
		isRefreshing,
		error,
		currentConfig: effectiveCatalog?.currentConfig ?? null,
		refresh,
		addCustomModel,
	};
}
