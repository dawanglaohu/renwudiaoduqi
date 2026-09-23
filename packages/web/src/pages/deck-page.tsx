import type { RouteComponentProps } from '../app/routes.tsx';
import { RunDeckContainer } from '../features/run-deck/run-deck-container.tsx';
import type { DeckStreamLane } from '../features/run-deck/types.ts';

export interface DeckPageProps extends RouteComponentProps {
	readonly lanes?: readonly DeckStreamLane[];
}

export function DeckPage({ lanes = [] }: DeckPageProps) {
	return (
		<div data-component="deck-page" className="flex min-h-[calc(100vh-var(--topbar-h))] flex-col">
			<RunDeckContainer lanes={lanes} />
		</div>
	);
}

export default DeckPage;
