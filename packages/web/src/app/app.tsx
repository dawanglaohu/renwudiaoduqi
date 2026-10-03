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

import { type ComponentType, type ReactNode, lazy, useState } from 'react';
import { GateTogglesContainer } from '../features/run-deck/gate-toggles-container.tsx';
import { PipelineTogglesContainer } from '../features/run-deck/pipeline-toggles-container.tsx';
import { UI_STRINGS } from '../i18n/ui-strings.ts';
import { DeckPage } from '../pages/deck-page.tsx';
import { PairPage } from '../pages/pair-page.tsx';
import { RunDetailPage } from '../pages/run-detail-page.tsx';
import { TasksPage } from '../pages/tasks-page.tsx';
import { ConnectFailedScreen, useFirstScreenFailure } from './connect-failed.tsx';
import { hasDeviceToken } from './route-guard.tsx';
import {
	ROUTE_PATHS,
	type RouteComponentProps,
	type RouteId,
	type RouteMatch,
	RouterView,
	navigateTo,
} from './routes.tsx';

const LandingPage = lazy(() => import('../pages/landing-page.tsx'));
const SettingsAgentsPage = lazy(() => import('../pages/settings-agents-page.tsx'));
const SettingsDevicesPage = lazy(() => import('../pages/settings-devices-page.tsx'));
const SettingsPipelinePage = lazy(() => import('../pages/settings-pipeline-page.tsx'));

const APP_ROUTE_COMPONENTS: Record<RouteId, ComponentType<RouteComponentProps>> = {
	deck: DeckPage,
	tasks: TasksPage,
	runDetail: RunDetailPage,
	landing: LandingPage,
	settingsAgents: SettingsAgentsPage,
	settingsDevices: SettingsDevicesPage,
	settingsPipeline: SettingsPipelinePage,
	pair: PairPage,
};

export interface AppProps {
	readonly renderTopbar?: () => ReactNode;
}

const SETTINGS_NAVIGATION = [
	{ id: 'settingsAgents', label: UI_STRINGS.settings.agentsTab },
	{ id: 'settingsDevices', label: UI_STRINGS.settings.devicesTab },
	{ id: 'settingsPipeline', label: UI_STRINGS.settings.pipelineTab },
] as const;

const NAV_BUTTON_CLASS =
	'inline-flex h-btn min-w-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-3 text-dense font-medium text-ink-2 hover:bg-row-hover hover:text-ink-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs max-[599px]:h-btn-lg [@media(pointer:coarse)]:h-btn-lg';

function AppTopbar({ match, banner }: { readonly match: RouteMatch; readonly banner: ReactNode }) {
	const showGates = match.id !== 'pair' && hasDeviceToken();
	const isSettings = SETTINGS_NAVIGATION.some(({ id }) => id === match.id);
	const [pipelineNotesHost, setPipelineNotesHost] = useState<HTMLDivElement | null>(null);
	return (
		<>
			{banner}
			<div className="relative">
				<header
					data-testid="app-topbar"
					className="h-topbar flex items-center gap-3 border-b border-border bg-bg px-4 text-ink-1"
				>
					<span className="font-mono text-dense font-semibold text-ink-1">Agent 任务调度器</span>
					<div className="flex h-topbar items-center">
						{showGates && (
							<button
								type="button"
								data-testid="settings-entry"
								aria-current={isSettings ? 'location' : undefined}
								className={NAV_BUTTON_CLASS}
								onClick={() => {
									if (!isSettings) navigateTo(ROUTE_PATHS.settingsAgents);
								}}
							>
								{UI_STRINGS.settings.title}
							</button>
						)}
					</div>
				</header>
				<div className="hidden min-[600px]:flex flex-wrap items-center gap-3 border-b border-border bg-bg px-4 py-2 min-[1280px]:absolute min-[1280px]:top-0 min-[1280px]:right-4 min-[1280px]:h-topbar min-[1280px]:flex-nowrap min-[1280px]:border-0 min-[1280px]:p-0">
					{showGates && (
						<>
							<GateTogglesContainer layout="topbar" />
							<div
								className="h-px w-full bg-border shrink-0 min-[1280px]:h-4 min-[1280px]:w-px"
								aria-hidden="true"
							/>
							<PipelineTogglesContainer layout="topbar" notesHost={pipelineNotesHost} />
						</>
					)}
				</div>

				<div
					ref={setPipelineNotesHost}
					data-testid="topbar-pipeline-notes"
					className="hidden min-[600px]:flex empty:hidden flex-wrap gap-x-4 gap-y-1 border-b border-border bg-bg px-4 py-1"
				/>
			</div>
			{showGates && isSettings && (
				<nav
					aria-label={UI_STRINGS.settings.navigation}
					className="flex flex-wrap items-center gap-2 border-b border-border bg-bg px-4 py-2"
				>
					<button
						type="button"
						data-testid="settings-back"
						className={NAV_BUTTON_CLASS}
						onClick={() => navigateTo(ROUTE_PATHS.deck)}
					>
						{UI_STRINGS.settings.backToDeck}
					</button>
					{SETTINGS_NAVIGATION.map(({ id, label }) => (
						<button
							key={id}
							type="button"
							aria-current={match.id === id ? 'page' : undefined}
							className={`${NAV_BUTTON_CLASS} aria-[current=page]:bg-row-hover aria-[current=page]:text-ink-1`}
							onClick={() => navigateTo(ROUTE_PATHS[id])}
						>
							{label}
						</button>
					))}
				</nav>
			)}
		</>
	);
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

	return (
		<RouterView
			components={APP_ROUTE_COMPONENTS}
			renderTopbar={(match) => <AppTopbar match={match} banner={renderTopbar?.()} />}
		/>
	);
}

export default App;
