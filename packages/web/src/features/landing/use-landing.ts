/**
 * packages/web/src/features/landing/use-landing.ts
 *
 * 落地清单数据加载 Hook（M9-T16 / 07 节前端架构）
 *
 * 规范依据（07 节与 R1 / R2）：
 * - features 层承担数据获取与状态管理
 * - 请求走 shared ROUTES 表与 httpClient.callRoute，禁止硬编码 URL 字面量
 * - 失败时不伪造 mock 数据，保留真实错误与 requestId 供就地提示
 */

import { useCallback, useEffect, useState } from 'react';
import { ROUTES } from '../../../../shared/src/api/routes.ts';
import type { GetTaskLandingResponse } from '../../../../shared/src/api/tasks.ts';
import { type ApiError, httpClient } from '../../api/http-client.ts';

const getLandingRoute = ROUTES.find(
	(r) => r.method === 'GET' && r.path === '/api/v1/tasks/:taskId/landing',
);

export type LandingFetcher = (taskId: string) => Promise<GetTaskLandingResponse>;

export interface UseLandingOptions {
	readonly taskId?: string;
	readonly initialData?: GetTaskLandingResponse;
	readonly initialError?: Error | ApiError | null;
	readonly initialRequestId?: string;
	readonly fetcher?: LandingFetcher;
}

export interface UseLandingResult {
	readonly data: GetTaskLandingResponse | null;
	readonly isLoading: boolean;
	readonly error: Error | ApiError | null;
	readonly requestId?: string;
	readonly refetch: () => Promise<GetTaskLandingResponse | null>;
}

export function useLanding({
	taskId,
	initialData,
	initialError,
	initialRequestId,
	fetcher,
}: UseLandingOptions = {}): UseLandingResult {
	const [data, setData] = useState<GetTaskLandingResponse | null>(initialData ?? null);
	const [isLoading, setIsLoading] = useState<boolean>(
		!initialData && !initialError && Boolean(taskId),
	);
	const [error, setError] = useState<Error | ApiError | null>(initialError ?? null);
	const [requestId, setRequestId] = useState<string | undefined>(initialRequestId);

	const executeFetch = useCallback(async (): Promise<GetTaskLandingResponse | null> => {
		if (initialData) {
			setData(initialData);
			setIsLoading(false);
			setError(null);
			return initialData;
		}

		if (!taskId) {
			setData(null);
			setIsLoading(false);
			setError(null);
			return null;
		}

		setIsLoading(true);
		setError(null);
		setRequestId(undefined);

		try {
			if (fetcher) {
				const res = await fetcher(taskId);
				setData(res);
				setIsLoading(false);
				return res;
			}

			if (!getLandingRoute) {
				throw new Error('Route GET /api/v1/tasks/:taskId/landing is missing in ROUTES');
			}

			const res = await httpClient.callRoute<GetTaskLandingResponse>(getLandingRoute, {
				params: { taskId },
			});
			setData(res);
			setIsLoading(false);
			return res;
		} catch (err) {
			// R2: 严禁伪造 mock 数据，保留真实错误与 requestId
			const errRequestId =
				(err as { requestId?: string })?.requestId ??
				(err as { details?: { requestId?: string } })?.details?.requestId;
			setRequestId(errRequestId);
			setError(err instanceof Error ? err : new Error(String(err)));
			setData(null);
			setIsLoading(false);
			return null;
		}
	}, [taskId, initialData, fetcher]);

	useEffect(() => {
		let isCurrent = true;
		if (initialData) {
			setData(initialData);
			setIsLoading(false);
			setError(null);
			return;
		}

		if (!taskId) {
			setData(null);
			setIsLoading(false);
			setError(null);
			return;
		}

		setIsLoading(true);
		setError(null);
		setRequestId(undefined);

		const run = async () => {
			try {
				if (fetcher) {
					const res = await fetcher(taskId);
					if (isCurrent) {
						setData(res);
						setIsLoading(false);
					}
					return;
				}

				if (!getLandingRoute) {
					throw new Error('Route GET /api/v1/tasks/:taskId/landing is missing in ROUTES');
				}

				const res = await httpClient.callRoute<GetTaskLandingResponse>(getLandingRoute, {
					params: { taskId },
				});
				if (isCurrent) {
					setData(res);
					setIsLoading(false);
				}
			} catch (err) {
				if (isCurrent) {
					const errRequestId =
						(err as { requestId?: string })?.requestId ??
						(err as { details?: { requestId?: string } })?.details?.requestId;
					setRequestId(errRequestId);
					setError(err instanceof Error ? err : new Error(String(err)));
					setData(null);
					setIsLoading(false);
				}
			}
		};

		void run();

		return () => {
			isCurrent = false;
		};
	}, [taskId, initialData, fetcher]);

	return {
		data,
		isLoading,
		error,
		requestId,
		refetch: executeFetch,
	};
}
