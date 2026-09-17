/**
 * packages/web/src/app/app.tsx
 *
 * 应用顶层装配组件（M9-T16 / 07 节前端架构）
 *
 * 规范依据（07 节前端架构与 19 节第 7 条）：
 * - app/app.tsx 是路由装配件（main.tsx 只负责挂载 createRoot）
 * - 本任务挂接 #/landing/:taskId 与零运行空态，其余路径由 RouterView 保持占位供后续任务增量接入
 */

import type { ReactNode } from 'react';
import { PairingContainer } from '../features/pairing/pairing-container.tsx';
import { RunDeckContainer } from '../features/run-deck/run-deck-container.tsx';
import { LandingPage } from '../pages/landing-page.tsx';
import { RouterView } from './routes.tsx';

export interface AppProps {
	readonly renderTopbar?: () => ReactNode;
}

export function App({ renderTopbar }: AppProps = {}) {
	return (
		<RouterView
			components={{
				deck: () => <RunDeckContainer lanes={[]} />,
				landing: LandingPage,
				pair: PairingContainer,
			}}
			renderTopbar={renderTopbar}
		/>
	);
}

export default App;
