import type {
	AgentCurrentConfigDto,
	AgentModelItem,
	ListAgentModelsResponse,
} from '@agent-scheduler/shared/api/agents';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { listModels } from '../../api/agents.ts';
import { CACHE_KEYS } from '../../api/cache-keys.ts';
import { eventBus } from '../../api/event-bus.ts';
import {
	getResourceCacheVersion,
	invalidate,
	peek,
	read,
	subscribeResourceCache,
} from '../../api/resource-cache.ts';
import { groupModelsBySource } from '../../lib/model-groups.ts';

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
const inflightRefreshes = new Map<string, Promise<void>>();
const refreshListeners = new Set<() => void>();
let refreshVersion = 0;
function notifyRefresh(): void {
	refreshVersion++;
	for (const listener of refreshListeners) listener();
}
function subscribeRefresh(listener: () => void): () => void {
	refreshListeners.add(listener);
	return () => {
		refreshListeners.delete(listener);
	};
}
function getRefreshVersion(): number {
	return refreshVersion;
}

/** Restore ordinary reads before an event or reconnect can reuse the temporary fetcher. */
async function refreshAgent(agentId: string): Promise<void> {
	const existing = inflightRefreshes.get(agentId);
	if (existing) return existing;
	const key = CACHE_KEYS.agentModels(agentId);
	const operation = Promise.resolve()
		.then(async () => {
			if (!peek(key)) await read(key, () => listModels(agentId)).catch(() => {});
			invalidate(key);
			const request = read(key, () => listModels(agentId, { refresh: true }));
			// read registers its fetcher synchronously and shares the existing request.
			const normalRead = read(key, () => listModels(agentId));
			try {
				await request;
			} finally {
				await normalRead;
			}
		})
		.finally(() => {
			inflightRefreshes.delete(agentId);
			notifyRefresh();
		});
	inflightRefreshes.set(agentId, operation);
	notifyRefresh();
	return operation;
}

/** Assignment rows and settings share the cache, catalog and refresh state. */
export function useAgentModelCatalogs(
	agentIds: readonly string[],
): Readonly<Record<string, UseAgentModelsResult>> {
	useSyncExternalStore(subscribeResourceCache, getResourceCacheVersion, getResourceCacheVersion);
	useSyncExternalStore(subscribeRefresh, getRefreshVersion, getRefreshVersion);
	const idsKey = JSON.stringify(agentIds);
	const ids = useMemo<readonly string[]>(() => JSON.parse(idsKey), [idsKey]);
	const lastComplete = useRef<Record<string, ListAgentModelsResponse>>({});
	const [errors, setErrors] = useState<Record<string, Error | null>>({});
	useEffect(() => {
		let current = true;
		const loadMissing = () => {
			for (const id of ids) {
				if (peek(CACHE_KEYS.agentModels(id))) continue;
				void read(CACHE_KEYS.agentModels(id), () => listModels(id)).catch((cause: unknown) => {
					if (current)
						setErrors((prev) => ({
							...prev,
							[id]: cause instanceof Error ? cause : new Error(String(cause)),
						}));
				});
			}
		};
		loadMissing();
		const unsubscribe = subscribeResourceCache(() => {
			queueMicrotask(() => {
				if (current) loadMissing();
			});
		});
		return () => {
			current = false;
			unsubscribe();
		};
	}, [ids]);
	useEffect(
		() =>
			eventBus.subscribeAll((envelope) => {
				if (envelope.kind === 'agent.availability_changed') invalidate('agentModels');
			}),
		[],
	);
	const results: Record<string, UseAgentModelsResult> = {};
	for (const id of ids) {
		const response = peek<ListAgentModelsResponse>(CACHE_KEYS.agentModels(id)) ?? null;
		const pending = inflightRefreshes.has(id) || Boolean(response?.isRefreshing);
		if (response && !pending) lastComplete.current[id] = response;
		const catalog = pending
			? (lastComplete.current[id] ?? response)
			: (response ?? lastComplete.current[id] ?? null);
		results[id] = {
			catalog,
			models: catalog?.models ?? [],
			modelNames: catalog?.models.map((item) => item.name) ?? [],
			isComplete: catalog?.isComplete ?? true,
			isLoading: !catalog && !errors[id],
			isRefreshing: pending,
			error: response ? null : (errors[id] ?? null),
			currentConfig: catalog?.currentConfig ?? null,
			refresh: async () => {
				try {
					await refreshAgent(id);
					setErrors((prev) => ({ ...prev, [id]: null }));
				} catch (cause) {
					setErrors((prev) => ({
						...prev,
						[id]: cause instanceof Error ? cause : new Error(String(cause)),
					}));
				}
			},
			// Manual names are assignment intents; the daemon owns catalog entries and history.
			addCustomModel: () => {},
		};
	}
	useEffect(() => {
		const warnUnknown = () => {
			for (const id of ids) {
				const catalog = peek<ListAgentModelsResponse>(CACHE_KEYS.agentModels(id));
				if (!catalog) continue;
				const { unknownSources } = groupModelsBySource(catalog.models);
				if (unknownSources.length)
					console.warn('Unknown model catalog sources', id, unknownSources);
			}
		};
		warnUnknown();
		return subscribeResourceCache(warnUnknown);
	}, [ids]);
	return results;
}
export function useAgentModels(agentId?: string | null): UseAgentModelsResult {
	const catalogs = useAgentModelCatalogs(agentId ? [agentId] : []);
	return (
		(agentId && catalogs[agentId]) || {
			catalog: null,
			models: [],
			modelNames: [],
			isComplete: true,
			isLoading: false,
			isRefreshing: false,
			error: null,
			currentConfig: null,
			refresh: async () => {},
			addCustomModel: () => {},
		}
	);
}
