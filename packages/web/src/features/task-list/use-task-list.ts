/**
 * packages/web/src/features/task-list/use-task-list.ts
 *
 * 任务列表页数据与展开状态 hook（M9-T19 / AC 2, E-284）
 *
 * 规范依据（07 节前端架构与边界 E-284）：
 * - run-deck/batch-expansion.ts 是批次树展开集的唯一存放点，也是唯一允许被 task-list 跨 feature import 的文件
 * - 任务列表页与左栏批次树完全共用同一模块级 Set 展开集
 * - 纯内存暂存，使用 useSyncExternalStore 统一订阅
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { BatchTreeItem } from '../../components/batch-tree.tsx';
import {
	clearBatchExpansion,
	collapseBatch,
	expandBatch,
	expandBatches,
	getExpandedBatchIds,
	seedBatchExpansion,
	subscribeBatchExpansion,
	toggleBatchExpansion,
} from '../run-deck/batch-expansion.ts';

export interface UseTaskListOptions {
	readonly batches?: readonly BatchTreeItem[];
	readonly docId?: string;
}

export interface UseTaskListResult {
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
	const { batches, docId } = options;

	// 订阅 run-deck/batch-expansion 模块级展开集（左栏与任务列表页共用，AC 2）
	const expandedIds = useSyncExternalStore(subscribeBatchExpansion, getExpandedBatchIds);

	// 若提供了批次数据，首次按 defaultExpanded 进行 seed
	useEffect(() => {
		if (batches && batches.length > 0) {
			seedBatchExpansion(batches, docId);
		}
	}, [batches, docId]);

	return {
		expandedIds,
		toggleBatch: toggleBatchExpansion,
		expandBatch,
		expandBatches,
		collapseBatch,
		clearExpansion: clearBatchExpansion,
	};
}

export default useTaskList;
