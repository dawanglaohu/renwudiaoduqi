import type { RouteComponentProps } from '../app/routes.tsx';
import {
	type SnapshotFetcher,
	TasksPageContainer,
} from '../features/run-deck/mobile-batch-list.tsx';

export interface TasksPageProps extends RouteComponentProps {
	readonly snapshotFetcher?: SnapshotFetcher;
}

export function TasksPage({ snapshotFetcher }: TasksPageProps) {
	return (
		<section
			data-component="tasks-page"
			className="flex min-h-[calc(100vh-var(--topbar-h))] flex-col gap-3 bg-page p-3 text-ink-1"
		>
			<TasksPageContainer snapshotFetcher={snapshotFetcher} />
		</section>
	);
}

export default TasksPage;
