/**
 * packages/web/src/pages/deck-page.tsx
 *
 * 运行甲板页面装配件（07 节前端架构）
 */

import type { RouteComponentProps } from '../app/routes.tsx';
import { RunDeckContainer } from '../features/run-deck/run-deck-container.tsx';

export function DeckPage(_props?: Partial<RouteComponentProps>) {
	return <RunDeckContainer lanes={[]} />;
}

export default DeckPage;
