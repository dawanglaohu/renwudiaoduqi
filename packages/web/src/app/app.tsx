import type { ReactNode } from 'react';
import { PairPage } from '../features/pairing/pairing-container.tsx';
import { GateTogglesContainer } from '../features/run-deck/gate-toggles-container.tsx';
import { DeckPage } from '../pages/deck-page.tsx';
import { LandingPage } from '../pages/landing-page.tsx';
import { TasksPage } from '../pages/tasks-page.tsx';
import { RouterView } from './routes.tsx';

export interface AppProps {
	readonly renderTopbar?: () => ReactNode;
}

export function App({ renderTopbar }: AppProps = {}) {
	return (
		<RouterView
			components={{
				deck: DeckPage,
				landing: LandingPage,
				tasks: TasksPage,
				pair: PairPage,
			}}
			renderTopbar={
				renderTopbar ??
				(() => (
					<header className="h-topbar flex items-center justify-between border-b border-border bg-bg px-4 text-ink-1">
						<div className="flex items-center gap-3">
							<span className="font-mono text-dense font-semibold text-ink-1">
								Agent 任务调度器
							</span>
						</div>
						<div className="flex items-center gap-3">
							<GateTogglesContainer layout="topbar" />
						</div>
					</header>
				))
			}
		/>
	);
}

export default App;
