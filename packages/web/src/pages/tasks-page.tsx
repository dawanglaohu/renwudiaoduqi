import type { RouteComponentProps } from '../app/routes.tsx';
import { TaskListContainer } from '../features/task-list/task-list-container.tsx';

export interface TasksPageProps extends RouteComponentProps {}

export function TasksPage(_props: TasksPageProps) {
	return (
		<section
			data-component="tasks-page"
			className="flex min-h-[calc(100vh-var(--topbar-h))] flex-col gap-3 bg-page p-3 text-ink-1"
		>
			<TaskListContainer />
		</section>
	);
}

export default TasksPage;
