/**
 * packages/web/src/features/run-deck/use-batch-tree.ts
 *
 * 批次树状态挂钩（M9-T19 / AC 1, AC 2, E-284, R2, R3, R5）
 *
 * 规范依据（07 节前端架构）：
 * - features 层容器 hook：统一订阅模块级 batch-expansion 展开集
 * - 纯内存状态响应，使用 useSyncExternalStore 确保高效无撕裂更新
 * - 组件内不存局部展开 state，统一向 batch-expansion 委派
 * - 未显式传入 batches 时自动拉取 /api/v1/snapshot（保证零流状态下真实 #/ 正常渲染批次树，R2）
 */

import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { httpClient } from '../../api/http-client.ts';
import type { BatchTreeItem } from '../../components/batch-tree.tsx';
import {
	clearBatchExpansion,
	collapseBatch,
	expandBatch,
	expandBatches,
	getExpandedBatchIds,
	mapSnapshotToBatches,
	seedBatchExpansion,
	subscribeBatchExpansion,
	toggleBatchExpansion,
} from './batch-expansion.ts';

export interface UseBatchTreeOptions {
	/** 批次数据列表（可选，未提供时拉取快照） */
	readonly batches?: readonly BatchTreeItem[];
	/** 文档唯一标识（用于切换文档时清空旧展开集） */
	readonly docId?: string;
}

export interface UseBatchTreeResult {
	/** 批次数据列表 */
	readonly batches: readonly BatchTreeItem[];
	/** 当前展开的批次 ID 只读集合 */
	readonly expandedIds: ReadonlySet<string>;
	/** 开合指定批次 */
	readonly toggleBatch: (batchId: string) => void;
	/** 展开指定批次 */
	readonly expandBatch: (batchId: string) => void;
	/** 批量展开批次 */
	readonly expandBatches: (batchIds: readonly string[]) => void;
	/** 折叠指定批次 */
	readonly collapseBatch: (batchId: string) => void;
	/** 整体清空展开集合 */
	readonly clearExpansion: () => void;
}

/**
 * 批次树展开状态 hook。
 */
export function useBatchTree(options: UseBatchTreeOptions = {}): UseBatchTreeResult {
	const { batches: explicitBatches, docId } = options;
	const [fetchedBatches, setFetchedBatches] = useState<readonly BatchTreeItem[]>([]);

	// 订阅模块级 Set，保持与全应用（左栏 + 任务列表页）状态同步
	const expandedIds = useSyncExternalStore(
		subscribeBatchExpansion,
		getExpandedBatchIds,
		getExpandedBatchIds,
	);

	// 未提供批次时，拉取快照并组装任务树数据（R2）
	useEffect(() => {
		if (explicitBatches && explicitBatches.length > 0) return;

		let isMounted = true;
		const fetchSnapshot = async () => {
			try {
				const snapshot = await httpClient.get<SnapshotResponse>('/api/v1/snapshot');
				if (isMounted && snapshot) {
					const items = mapSnapshotToBatches(snapshot);
					setFetchedBatches(items);
					seedBatchExpansion(items, docId);
				}
			} catch {
				// 静默
			}
		};

		void fetchSnapshot();
		return () => {
			isMounted = false;
		};
	}, [explicitBatches, docId]);

	// 若提供了 batches，按 defaultExpanded 进行首次 seed（或切文档 seed）
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
		toggleBatch: toggleBatchExpansion,
		expandBatch,
		expandBatches,
		collapseBatch,
		clearExpansion: clearBatchExpansion,
	};
}

export default useBatchTree;
