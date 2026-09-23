/**
 * packages/web/src/app/app.tsx
 *
 * 应用顶层装配组件（M9-T16, M9-T25 / 07 节前端架构）
 *
 * 规范依据（07 节前端架构与 19 节第 7 条）：
 * - app/app.tsx 是路由装配件（main.tsx 只负责挂载 createRoot）
 * - 七条已登记 hash 路由都由完整的组件表装配，缺键在 TypeScript 阶段失败
 * - deck / tasks / runDetail 静态 import 进入主 chunk；landing 与 settings/* 使用共享 Suspense 懒加载
 */

import { type ComponentType, type ReactNode, lazy } from 'react';
import { DeckPage } from '../pages/deck-page.tsx';
import { PairPage } from '../pages/pair-page.tsx';
import { RunDetailPage } from '../pages/run-detail-page.tsx';
import { TasksPage } from '../pages/tasks-page.tsx';
import { ConnectFailedScreen, useFirstScreenFailure } from './connect-failed.tsx';
import { type RouteComponentProps, type RouteId, RouterView } from './routes.tsx';

const LandingPage = lazy(() => import('../pages/landing-page.tsx'));
const SettingsAgentsPage = lazy(() => import('../pages/settings-agents-page.tsx'));
const SettingsDevicesPage = lazy(() => import('../pages/settings-devices-page.tsx'));

const APP_ROUTE_COMPONENTS: Record<RouteId, ComponentType<RouteComponentProps>> = {
	deck: DeckPage,
	tasks: TasksPage,
	runDetail: RunDetailPage,
	landing: LandingPage,
	settingsAgents: SettingsAgentsPage,
	settingsDevices: SettingsDevicesPage,
	pair: PairPage,
};

export interface AppProps {
	readonly renderTopbar?: () => ReactNode;
}

export function App({ renderTopbar }: AppProps = {}) {
	// 整页失败只有两种：未配对走 #/pair（守卫里），首屏快照拉不到走这一屏（07 节）。
	// 记录由取数方通过 `reportFirstScreenFailure()` 写入，重拉动作也随记录一起交给它。
	const firstScreenFailure = useFirstScreenFailure();
	if (firstScreenFailure) {
		return (
			<ConnectFailedScreen
				code={firstScreenFailure.code}
				requestId={firstScreenFailure.requestId}
				baseUrl={firstScreenFailure.baseUrl}
				onRetry={firstScreenFailure.retry}
			/>
		);
	}

	return <RouterView components={APP_ROUTE_COMPONENTS} renderTopbar={renderTopbar} />;
}

export default App;
