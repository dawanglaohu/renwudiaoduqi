/**
 * packages/web/src/features/task-list/task-list-container.tsx
 *
 * 任务列表页容器组件（M9-T19 / AC 2, AC 5, E-13, E-284, R2）
 *
 * 规范依据（07 节前端架构）：
 * - features 容器层：只许写 grid/flex/gap，禁止写颜色字号圆角
 * - 任务列表页与左栏共用同一 BatchTree 组件与同一 batch-expansion 展开集（AC 2, 11 节 UI）
 * - 手机档批次树是任务列表 pane 的顶层结构并取代 M9-T12 的折叠列表（E-13, AC 5）
 */

import { BatchTree, type BatchTreeItem } from '../../components/batch-tree.tsx';
import { useTaskList } from './use-task-list.ts';

export interface TaskListContainerProps {
	/** 全部批次列表（可选，未传入时自动从快照获取） */
	readonly batches?: readonly BatchTreeItem[];
	/** 当前文档 ID */
	readonly docId?: string;
	/** 当前选中任务 ID */
	readonly selectedTaskId?: string | null;
	/** 密度档位 */
	readonly densityTier?: 'full' | 'compact' | 'single' | 'narrow' | 'phone' | 'phone-xs';
	/** 是否为触摸档 */
	readonly isTouch?: boolean;
	/** 选择任务回调 */
	readonly onSelectTask?: (taskId: string, batchId?: string) => void;
	/** 收口按钮回调 */
	readonly onWrapup?: (batchId: string) => void;
	/** 打开收口运行详情回调 */
	readonly onOpenWrapupRun?: (runId: string, batchId: string) => void;
	/** 外部自定义类名 */
	readonly className?: string;
}

/**
 * 任务列表容器组件。
 */
export function TaskListContainer(props: TaskListContainerProps) {
	const {
		batches: explicitBatches,
		docId,
		selectedTaskId,
		densityTier,
		isTouch,
		onSelectTask,
		onWrapup,
		onOpenWrapupRun,
		className = '',
	} = props;

	const { batches, expandedIds, toggleBatch } = useTaskList({
		batches: explicitBatches,
		docId,
	});

	return (
		<div className={['flex flex-col gap-3 w-full', className].filter(Boolean).join(' ')}>
			<BatchTree
				batches={batches}
				expandedIds={expandedIds}
				selectedTaskId={selectedTaskId}
				densityTier={densityTier}
				isTouch={isTouch}
				onToggleBatch={toggleBatch}
				onSelectTask={onSelectTask}
				onWrapup={onWrapup}
				onOpenWrapupRun={onOpenWrapupRun}
			/>
		</div>
	);
}

export default TaskListContainer;
