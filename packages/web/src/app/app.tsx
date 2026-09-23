/**
 * packages/web/src/app/app.tsx
 *
 * 应用顶层装配组件（M9-T16, M9-T13, M9-T19, M9-T25 / 07 节前端架构）
 *
 * 规范依据（07 节前端架构、11 节 UI 与 19 节第 7 条）：
 * - app/app.tsx 是路由装配件（main.tsx 只负责挂载 createRoot）
 * - 本文件挂接 #/、#/tasks、#/landing/:taskId、#/run/:runId 与 #/pair：
 *   零运行四步引导（M9-T16）、逐任务指派面板（M9-T18）、批次树与任务列表页（M9-T19）必须经真实服务可达；
 *   M9-T25 落地时把这里补齐为七键必填表
 * - 顶栏由这里统一装配：调用方给的 renderTopbar（连接状态横幅）叠在 52px 顶栏之上，
 *   顶栏右侧常驻唯一一组闸门开关（M9-T19 AC 6）；#/pair 是唯一免守卫路由，尚无令牌时不挂闸门容器，
 *   避免在配对前发起鉴权请求
 */

import type { ReactNode } from 'react';
import { PairingContainer } from '../features/pairing/pairing-container.tsx';
import { GateTogglesContainer } from '../features/run-deck/gate-toggles-container.tsx';
import { RunDeckContainer } from '../features/run-deck/run-deck-container.tsx';
import { LandingPage } from '../pages/landing-page.tsx';
import { RunDetailPage } from '../pages/run-detail-page.tsx';
import { TaskListPage } from '../pages/task-list-page.tsx';
import { type RouteMatch, RouterView } from './routes.tsx';

export interface AppProps {
	readonly renderTopbar?: () => ReactNode;
}

interface AppTopbarProps {
	readonly match: RouteMatch;
	readonly banner: ReactNode;
}

function AppTopbar({ match, banner }: AppTopbarProps) {
	const isPairRoute = !match.isUnknown && match.id === 'pair';
	return (
		<>
			{banner}
			<header
				data-testid="app-topbar"
				className="h-topbar flex items-center justify-between border-b border-border bg-bg px-4 text-ink-1"
			>
				<div className="flex items-center gap-3">
					<span className="font-mono text-dense font-semibold text-ink-1">Agent 任务调度器</span>
				</div>
				<div className="flex items-center gap-3">
					{!isPairRoute && <GateTogglesContainer layout="topbar" />}
				</div>
			</header>
		</>
	);
}

export function App({ renderTopbar }: AppProps = {}) {
	return (
		<RouterView
			components={{
				deck: () => <RunDeckContainer lanes={[]} />,
				landing: LandingPage,
				pair: PairingContainer,
				runDetail: RunDetailPage,
				tasks: TaskListPage,
			}}
			renderTopbar={(match) => <AppTopbar match={match} banner={renderTopbar?.()} />}
		/>
	);
}

export default App;
