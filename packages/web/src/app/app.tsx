/**
 * packages/web/src/app/app.tsx
 *
 * 应用顶层装配组件（M9-T16, M9-T13, M9-T25 / 07 节前端架构）
 *
 * 规范依据（07 节前端架构与 19 节第 7 条）：
 * - app/app.tsx 是路由装配件（main.tsx 只负责挂载 createRoot）
 * - 本文件挂接 #/landing/:taskId、#/run/:runId，并装配运行甲板 #/ 与配对 #/pair：
 *   零运行四步引导（M9-T16）与逐任务指派面板（M9-T18）必须经真实服务可达；
 *   M9-T25 落地时把这里补齐为七键必填表
 */

import type { ReactNode } from 'react';
import { PairingContainer } from '../features/pairing/pairing-container.tsx';
import { RunDeckContainer } from '../features/run-deck/run-deck-container.tsx';
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
				deck: () => <RunDeckContainer lanes={[]} />,
				landing: LandingPage,
				pair: PairingContainer,
				runDetail: RunDetailPage,
			}}
			renderTopbar={renderTopbar}
		/>
	);
}

export default App;
