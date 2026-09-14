import { useCallback, useEffect, useState } from 'react';
import type { ListAgentModelsResponse } from '../../../../shared/src/api/agents.ts';
import { ROUTES } from '../../../../shared/src/api/routes.ts';
import { httpClient } from '../../api/http-client.ts';

export interface UseAgentModelsResult {
	readonly models: readonly string[];
	readonly source: string;
	readonly isComplete: boolean;
	readonly isLoading: boolean;
	readonly isRefreshing: boolean;
	readonly error: Error | null;
	readonly refresh: () => Promise<void>;
	readonly addCustomModel: (modelName: string) => void;
}

// In-memory cache per agentId (07-前端架构)
const modelsCache = new Map<string, ListAgentModelsResponse>();

const listAgentModelsRoute = ROUTES.find(
	(r) => r.method === 'GET' && r.path === '/api/v1/agents/:agentId/models',
);

export function useAgentModels(agentId?: string | null): UseAgentModelsResult {
	const cached = agentId ? modelsCache.get(agentId) : undefined;
	const [models, setModels] = useState<readonly string[]>(cached?.models ?? []);
	const [source, setSource] = useState<string>(cached?.source ?? '');
	const [isComplete, setIsComplete] = useState<boolean>(cached?.isComplete ?? true);
	const [isLoading, setIsLoading] = useState<boolean>(false);
	const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
	const [error, setError] = useState<Error | null>(null);

	const fetchModels = useCallback(async (id: string, isRefresh = false) => {
		if (isRefresh) {
			setIsRefreshing(true);
		} else {
			setIsLoading(true);
		}
		setError(null);

		if (!listAgentModelsRoute) {
			const missingErr = new Error('Route GET /api/v1/agents/:agentId/models is not in ROUTES');
			setError(missingErr);
			setIsLoading(false);
			setIsRefreshing(false);
			return;
		}

		try {
			// R7: 请求改走 ROUTES/callRoute
			const response = await httpClient.callRoute<ListAgentModelsResponse>(listAgentModelsRoute, {
				params: { agentId: id },
				query: isRefresh ? { refresh: 'true' } : undefined,
			});
			modelsCache.set(id, response);
			setModels(response.models);
			setSource(response.source);
			setIsComplete(response.isComplete);
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			setError(e);
			// On failure, preserve existing models if available, but flag as incomplete (E-38)
			setIsComplete(false);
		} finally {
			setIsLoading(false);
			setIsRefreshing(false);
		}
	}, []);

	useEffect(() => {
		if (!agentId) {
			setModels([]);
			setSource('');
			setIsComplete(true);
			setError(null);
			return;
		}

		const currentCached = modelsCache.get(agentId);
		if (currentCached) {
			setModels(currentCached.models);
			setSource(currentCached.source);
			setIsComplete(currentCached.isComplete);
		} else {
			void fetchModels(agentId, false);
		}
	}, [agentId, fetchModels]);

	const refresh = useCallback(async () => {
		if (!agentId) return;
		await fetchModels(agentId, true);
	}, [agentId, fetchModels]);

	const addCustomModel = useCallback(
		(modelName: string) => {
			const trimmed = modelName.trim();
			if (!trimmed) return;
			setModels((prev) => {
				if (prev.includes(trimmed)) return prev;
				const next = [trimmed, ...prev];
				if (agentId) {
					const prevCached = modelsCache.get(agentId);
					modelsCache.set(agentId, {
						models: next,
						source: prevCached?.source ?? 'custom',
						isComplete: prevCached?.isComplete ?? false,
					});
				}
				return next;
			});
		},
		[agentId],
	);

	return {
		models,
		source,
		isComplete,
		isLoading,
		isRefreshing,
		error,
		refresh,
		addCustomModel,
	};
}
