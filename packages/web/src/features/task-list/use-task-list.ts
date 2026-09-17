/**
 * packages/web/src/features/task-list/use-task-list.ts
 *
 * 任务列表页数据与展开状态 hook（M9-T19 / AC 2, E-284, R2）
 *
 * 规范依据（07 节前端架构与边界 E-284）：
 * - run-deck/batch-expansion.ts 是批次树展开集的唯一存放点，也是唯一允许被 task-list 跨 feature import 的文件
 * - 任务列表页与左栏批次树完全共用同一模块级 Set 展开集
 * - 纯内存暂存，使用 useSyncExternalStore 统一订阅
 * - 未显式传入 batches 时，自动调用 /api/v1/snapshot 拉取批次与任务数据
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
} from '../run-deck/batch-expansion.ts';

export { mapSnapshotToBatches };

export interface UseTaskListOptions {
	readonly batches?: readonly BatchTreeItem[];
	readonly docId?: string;
}

export interface UseTaskListResult {
	readonly batches: readonly BatchTreeItem[];
	readonly expandedIds: ReadonlySet<string>;
	readonly toggleBatch: (batchId: string) => void;
	readonly expandBatch: (batchId: string) => void;
	readonly expandBatches: (batchIds: readonly string[]) => void;
	readonly collapseBatch: (batchId: string) => void;
	readonly clearExpansion: () => void;
}

/**
 * 任务列表页 hook。
 */
export function useTaskList(options: UseTaskListOptions = {}): UseTaskListResult {
	const { batches: explicitBatches, docId } = options;
	const [fetchedBatches, setFetchedBatches] = useState<readonly BatchTreeItem[]>([]);

	// 订阅 run-deck/batch-expansion 模块级展开集（左栏与任务列表页共用，AC 2）
	const expandedIds = useSyncExternalStore(
		subscribeBatchExpansion,
		getExpandedBatchIds,
		getExpandedBatchIds,
	);

	// 未提供批次时，拉取快照并组装任务树数据
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

	// 若提供了批次数据，首次按 defaultExpanded 进行 seed
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

export default useTaskList;
