/**
 * packages/web/src/features/run-deck/use-batch-tree.ts
 *
 * 批次树状态挂钩（M9-T19 / AC 1, AC 2, E-284）
 *
 * 规范依据（07 节前端架构）：
 * - features 层容器 hook：统一订阅模块级 batch-expansion 展开集
 * - 纯内存状态响应，使用 useSyncExternalStore 确保高效无撕裂更新
 * - 组件内不存局部展开 state，统一向 batch-expansion 委派
 */

import { useEffect, useSyncExternalStore } from 'react';
import {
	clearBatchExpansion,
	collapseBatch,
	expandBatch,
	expandBatches,
	getExpandedBatchIds,
	seedBatchExpansion,
	subscribeBatchExpansion,
	toggleBatchExpansion,
} from './batch-expansion.ts';

export interface UseBatchTreeOptions {
	/** 批次数据列表（用于首次 defaultExpanded seed） */
	readonly batches?: readonly { readonly id: string; readonly defaultExpanded?: boolean }[];
	/** 文档唯一标识（用于切换文档时清空旧展开集） */
	readonly docId?: string;
}

export interface UseBatchTreeResult {
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
	const { batches, docId } = options;

	// 订阅模块级 Set，保持与全应用（左栏 + 任务列表页）状态同步
	const expandedIds = useSyncExternalStore(
		subscribeBatchExpansion,
		getExpandedBatchIds,
		getExpandedBatchIds,
	);

	// 若提供了 batches，按 defaultExpanded 进行首次 seed（或切文档 seed）
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

export default useBatchTree;
