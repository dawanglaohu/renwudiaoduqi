/**
 * packages/web/src/pages/tasks-page.tsx
 *
 * 任务列表页面装配件（M9-T19 / R2, 07 节前端架构, 11 节 UI）
 *
 * 规范依据：
 * - pages 层只做装配，不直接取数，不引入 store 或 http-client
 * - 与左栏共用同一套 BatchTree 组件与 batch-expansion 展开集（AC 2, 11 节 UI）
 */

import { ROUTE_PATHS, navigateTo } from '../app/routes.tsx';
import { TaskListContainer } from '../features/task-list/task-list-container.tsx';

export function TasksPage() {
	return (
		<div className="flex flex-col bg-page text-ink-1 font-ui select-none">
			<div className="flex items-center justify-between px-6 py-3 border-b border-border bg-panel-2/30">
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => navigateTo(ROUTE_PATHS.deck)}
						className="h-btn-sm px-2 rounded-sm border border-border bg-panel-2 text-ink-2 hover:text-ink-1 font-ui text-micro cursor-pointer"
					>
						← 运行甲板
					</button>
					<span className="text-ink-3">/</span>
					<h1 className="font-mono text-dense font-semibold text-ink-1">任务列表</h1>
				</div>
			</div>

			{/* 主内容区：由 TaskListContainer 承担拼装 */}
			<main className="flex-1 p-4 sm:p-6 max-w-5xl mx-auto w-full flex flex-col gap-6">
				<TaskListContainer />
			</main>
		</div>
	);
}

export default TasksPage;
