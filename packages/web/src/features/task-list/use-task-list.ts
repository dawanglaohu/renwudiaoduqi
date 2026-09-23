/**
 * packages/web/src/features/task-list/use-task-list.ts
 *
 * 任务列表页数据与展开状态 hook（M9-T19 / AC 2, E-284）
 *
 * 规范依据（07 节前端架构与边界 E-284）：
 * - run-deck/batch-expansion.ts 是批次树展开集的唯一存放点，任务列表页与左栏共用同一模块级 Set
 * - 取数、seed 与订阅逻辑只在 run-deck/use-batch-tree.ts 写一遍，这里按 07 节的 use-<域> 命名委托过去，
 *   不复制第二份快照拉取
 */

import { mapSnapshotToBatches } from '../run-deck/batch-expansion.ts';
import {
	type UseBatchTreeOptions,
	type UseBatchTreeResult,
	useBatchTree,
} from '../run-deck/use-batch-tree.ts';

export { mapSnapshotToBatches };

export type UseTaskListOptions = UseBatchTreeOptions;
export type UseTaskListResult = UseBatchTreeResult;

/**
 * 任务列表页 hook：与左栏批次树共用同一份展开集与快照归组逻辑。
 */
export function useTaskList(options: UseTaskListOptions = {}): UseTaskListResult {
	return useBatchTree(options);
}

export default useTaskList;
