import { useEffect, useRef, useState } from 'react';
import type { RouteComponentProps } from '../app/routes.tsx';
import { RunDeckContainer } from '../features/run-deck/run-deck-container.tsx';
import type { DeckStreamLane } from '../features/run-deck/types.ts';

export interface DeckPageProps extends Partial<RouteComponentProps> {
	readonly lanes?: readonly DeckStreamLane[];
}

export function DeckPage({ lanes }: DeckPageProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState('calc(100dvh - var(--topbar-h))');

	useEffect(() => {
		const updateHeight = () => {
			if (!containerRef.current) return;
			const top = containerRef.current.getBoundingClientRect().top;
			setHeight(`${Math.max(window.innerHeight - top, 0)}px`);
		};

		updateHeight();
		const observer =
			typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateHeight);
		// 顶栏可换行或出现提示，页面高度按实际起点扣除。
		const shell = containerRef.current?.parentElement?.parentElement;
		if (shell) {
			observer?.observe(shell);
			// 连接提示变高或变矮时，壳层总高可能不变，但页面起点已经移动。
			for (const child of shell.children) {
				if (child !== containerRef.current?.parentElement) observer?.observe(child);
			}
		}
		window.addEventListener('resize', updateHeight);

		return () => {
			window.removeEventListener('resize', updateHeight);
			observer?.disconnect();
		};
	}, []);

	return (
		<div
			ref={containerRef}
			data-component="deck-page"
			style={{ height }}
			className="flex min-h-0 flex-col overflow-hidden w-full"
		>
			<RunDeckContainer lanes={lanes ?? []} />
		</div>
	);
}

export default DeckPage;
