/**
 * packages/web/src/app/app.tsx
 *
 * 应用顶层装配组件（M9-T16, M9-T13 / 07 节前端架构）
 *
 * 规范依据（07 节前端架构与 19 节第 7 条）：
 * - app/app.tsx 是路由装配件（main.tsx 只负责挂载 createRoot）
 * - 本任务挂接 #/landing/:taskId 与 #/run/:runId，其余路径由 RouterView 保持占位供后续任务增量接入
 */

import type { ReactNode } from 'react';
import { LandingPage } from '../pages/landing-page.tsx';
import { RunDetailPage } from '../pages/run-detail-page.tsx';
import { RouterView } from './routes.tsx';

export interface AppProps {
	readonly renderTopbar?: () => ReactNode;
}

export function App({ renderTopbar }: AppProps = {}) {
	return (
		<RouterView
			components={{
				landing: LandingPage,
				runDetail: RunDetailPage,
			}}
			renderTopbar={renderTopbar}
		/>
	);
}

export default App;
