/**
 * packages/web/src/app/app.tsx
 *
 * 应用顶层装配组件（M9-T16, M9-T19, M9-T25 / 07 节前端架构）
 *
 * 规范依据（07 节前端架构与 19 节第 7 条）：
 * - app/app.tsx 是路由装配件（main.tsx 只负责挂载 createRoot）
 * - 七条已登记 hash 路由都由完整的组件表装配，缺键在 TypeScript 阶段失败
 * - deck / tasks / runDetail 静态 import 进入主 chunk；landing 与 settings/* 使用共享 Suspense 懒加载
 * - 已配对的桌面顶栏挂唯一一组闸门开关；配对前不发鉴权请求
 */

import { type ComponentType, type ReactNode, lazy } from 'react';
import { GateTogglesContainer } from '../features/run-deck/gate-toggles-container.tsx';
import { DeckPage } from '../pages/deck-page.tsx';
import { PairPage } from '../pages/pair-page.tsx';
import { RunDetailPage } from '../pages/run-detail-page.tsx';
import { TasksPage } from '../pages/tasks-page.tsx';
import { hasDeviceToken } from './route-guard.tsx';
import { type RouteComponentProps, type RouteId, type RouteMatch, RouterView } from './routes.tsx';

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

function AppTopbar({ match, banner }: { readonly match: RouteMatch; readonly banner: ReactNode }) {
	const showGates = match.id !== 'pair' && hasDeviceToken();
	return (
		<>
			{banner}
			<header
				data-testid="app-topbar"
				className="h-topbar flex items-center justify-between border-b border-border bg-bg px-4 text-ink-1"
			>
				<span className="font-mono text-dense font-semibold text-ink-1">Agent 任务调度器</span>
				<div className="hidden min-[600px]:flex items-center gap-3">
					{showGates && <GateTogglesContainer layout="topbar" />}
				</div>
			</header>
		</>
	);
}

export function App({ renderTopbar }: AppProps = {}) {
	return (
		<RouterView
			components={APP_ROUTE_COMPONENTS}
			renderTopbar={(match) => <AppTopbar match={match} banner={renderTopbar?.()} />}
		/>
	);
}

export default App;
