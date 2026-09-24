/**
 * packages/web/src/features/run-deck/use-batch-tree.ts
 *
 * 批次树容器 hook（M9-T19 / AC 1, AC 2, E-284）
 *
 * 规范依据（07 节前端架构）：
 * - features 层唯一允许 import src/api 与订阅 event-bus；快照经 shared ROUTES 表 + httpClient.callRoute 取，禁止 URL 字面量
 * - 展开集只在 run-deck/batch-expansion.ts 一处，useSyncExternalStore 的 getSnapshot 只返回整数 version，
 *   集合本身按 version 另行读取；左栏与任务列表页共用同一份
 * - 批次树数据只把快照里的 BatchDto / TaskDto 原样按 batchId 归组，不推导任何计数、展开默认值或进 HEAD
 * - 取数失败只交给调用方就地提示（InlineNotice），不 toast、不整页替换
 */

import { ROUTES, type RouteDefinition } from '@agent-scheduler/shared/api/routes';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { resolveBaseUrl } from '../../api/base-url.ts';
import { httpClient, isApiError } from '../../api/http-client.ts';
import { reportFirstScreenFailure } from '../../app/bootstrap.ts';
import type { BatchTreeItem } from '../../components/batch-tree.tsx';
import { getErrorMessage } from '../../i18n/error-messages.ts';
import {
	clearBatchExpansion,
	expandBatch,
	expandBatches,
	getBatchExpansionVersion,
	getExpandedBatchIds,
	mapSnapshotToBatches,
	seedBatchExpansion,
	subscribeBatchExpansion,
	toggleBatchExpansion,
} from './batch-expansion.ts';

function findRoute(method: 'GET', path: string): RouteDefinition {
	const route = ROUTES.find((entry) => entry.method === method && entry.path === path);
	if (!route) {
		// 契约表缺失时立刻暴露，而不是退回硬编码 URL（07 节：禁止 URL 字面量）
		throw new Error(`${method} ${path} is missing from the shared ROUTES table`);
	}
	return route;
}

const GET_SNAPSHOT_ROUTE = findRoute('GET', '/api/v1/snapshot');

/** 就地提示用的错误：中文文案 + 可展开的技术详情（07 节错误体系）。 */
export interface BatchTreeError {
	readonly message: string;
	readonly technical: string;
}

function toBatchTreeError(error: unknown): BatchTreeError {
	if (isApiError(error)) {
		return {
			message: getErrorMessage(error.code),
			technical: `${error.code} · ${error.message}${error.requestId ? ` · requestId=${error.requestId}` : ''}`,
		};
	}
	return {
		message: '加载批次与任务失败，请稍后重试',
		technical: error instanceof Error ? error.message : String(error),
	};
}

export interface UseBatchTreeOptions {
	/** 批次数据列表（可选，未提供时经 GET /snapshot 拉取） */
	readonly batches?: readonly BatchTreeItem[];
	/** 文档唯一标识（切文档时整体清空展开集并重新 seed） */
	readonly docId?: string;
}

export interface UseBatchTreeResult {
	/** 批次数据列表 */
	readonly batches: readonly BatchTreeItem[];
	/** 当前展开的批次 ID 只读集合 */
	readonly expandedIds: ReadonlySet<string>;
	/** 快照拉取失败时的就地提示内容，成功为 null */
	readonly error: BatchTreeError | null;
	/** 开合指定批次（用户手动 toggle，是唯一会从集合删元素的入口） */
	readonly toggleBatch: (batchId: string) => void;
	/** 展开指定批次 */
	readonly expandBatch: (batchId: string) => void;
	/** 批量展开批次 */
	readonly expandBatches: (batchIds: readonly string[]) => void;
	/** 整体清空展开集合（切换文档） */
	readonly clearExpansion: () => void;
}

/**
 * 批次树展开状态 hook。
 */
export function useBatchTree(options: UseBatchTreeOptions = {}): UseBatchTreeResult {
	const { batches: explicitBatches, docId } = options;
	const [fetchedBatches, setFetchedBatches] = useState<readonly BatchTreeItem[]>([]);
	const [error, setError] = useState<BatchTreeError | null>(null);

	// 订阅模块级展开集：快照只是整数 version，集合按 version 重读（07 节）
	const version = useSyncExternalStore(
		subscribeBatchExpansion,
		getBatchExpansionVersion,
		getBatchExpansionVersion,
	);
	const expandedIds = useMemo(() => {
		void version;
		return getExpandedBatchIds();
	}, [version]);

	const hasExplicitBatches = Boolean(explicitBatches && explicitBatches.length > 0);

	// 未提供批次时，经 shared 路由拉取快照并按 batchId 归组（R2）
	useEffect(() => {
		if (hasExplicitBatches) return;

		let isMounted = true;
		const fetchSnapshot = async () => {
			try {
				const snapshot = await httpClient.callRoute<SnapshotResponse>(GET_SNAPSHOT_ROUTE);
				reportFirstScreenFailure(null);
				if (!isMounted) return;
				const items = mapSnapshotToBatches(snapshot);
				setFetchedBatches(items);
				setError(null);
				// 未显式给 docId 时用快照里批次所属的文档：每个 docId 只 seed 一次，切文档整体清空重 seed（07 节）
				seedBatchExpansion(items, docId ?? items[0]?.docId);
			} catch (cause: unknown) {
				if (isMounted) {
					const isNetwork =
						(isApiError(cause) && (cause.code === 'E_NETWORK' || cause.code === 'E_TIMEOUT')) ||
						(typeof cause === 'object' &&
							cause !== null &&
							'code' in cause &&
							((cause as { code: unknown }).code === 'E_NETWORK' ||
								(cause as { code: unknown }).code === 'E_TIMEOUT'));

					if (isNetwork) {
						let baseUrl = '';
						if (
							isApiError(cause) &&
							typeof cause.details === 'object' &&
							cause.details &&
							'baseUrl' in cause.details &&
							typeof (cause.details as Record<string, unknown>).baseUrl === 'string'
						) {
							baseUrl = (cause.details as Record<string, unknown>).baseUrl as string;
						}
						if (!baseUrl) {
							try {
								baseUrl = await resolveBaseUrl();
							} catch {
								baseUrl = '';
							}
						}
						const code = isApiError(cause)
							? cause.code
							: ((cause as { code?: string }).code ?? 'E_NETWORK');
						const requestId = isApiError(cause) ? cause.requestId : null;
						reportFirstScreenFailure({
							code,
							requestId,
							baseUrl,
							retry: () => fetchSnapshot(),
						});
					}
					setError(toBatchTreeError(cause));
				}
			}
		};

		void fetchSnapshot();
		return () => {
			isMounted = false;
		};
	}, [hasExplicitBatches, docId]);

	// 提供了 batches 时，按 defaultExpanded 进行首次 seed（或切文档重 seed）
	useEffect(() => {
		if (explicitBatches && explicitBatches.length > 0) {
			seedBatchExpansion(explicitBatches, docId);
		}
	}, [explicitBatches, docId]);

	const finalBatches =
		explicitBatches && explicitBatches.length > 0 ? explicitBatches : fetchedBatches;

	return {
		batches: finalBatches,
		expandedIds,
		error,
		toggleBatch: toggleBatchExpansion,
		expandBatch,
		expandBatches,
		clearExpansion: clearBatchExpansion,
	};
}

export default useBatchTree;
