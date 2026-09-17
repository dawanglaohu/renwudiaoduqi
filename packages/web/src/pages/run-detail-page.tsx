/**
 * packages/web/src/pages/run-detail-page.tsx
 *
 * 运行详情页面装配件（M9-T13 / R1, 07 节前端架构）
 *
 * 规范依据（07 节前端架构）：
 * - pages 仅负责装配与骨架，禁止 import src/api 与 src/store，禁止副作用取数
 * - 页面只接 props，数据获取与拼装下沉至 features/run-detail/
 * - 缺少 runId 时走未知路径（UnknownRouteView）
 * - 统一通过 RouterView 进行路由挂载
 */

import {
	ROUTE_PATHS,
	type RouteComponentProps,
	UnknownRouteView,
	navigateTo,
} from '../app/routes.tsx';
import {
	RunDetailContainer,
	type RunDetailContainerProps,
} from '../features/run-detail/run-detail-container.tsx';

export interface RunDetailPageProps
	extends Partial<RouteComponentProps>,
		Partial<RunDetailContainerProps> {
	/** 外部自定义 class */
	readonly className?: string;
}

/**
 * 运行详情页面主组件。
 */
export function RunDetailPage(props: RunDetailPageProps) {
	const {
		match,
		params,
		runId: explicitRunId,
		className = '',
		onOpenOriginalFile,
		runStatus,
		run,
		taskKey,
		onRerunSuccess,
		isMobile,
	} = props;

	const runId = explicitRunId ?? params?.runId ?? match?.params?.runId;

	if (!runId) {
		return <UnknownRouteView match={match} />;
	}

	return (
		<div
			data-testid="run-detail-page"
			className={`flex min-h-screen flex-col bg-[var(--page)] text-[var(--ink-1)] font-ui ${className}`}
		>
			{/* 顶栏 52px 面包屑与导航 */}
			<header className="h-[var(--topbar-h,52px)] flex items-center justify-between px-4 border-b border-[var(--border)] bg-[var(--bg)] text-[var(--ink-1)] select-none shrink-0">
				<div className="flex items-center gap-2 truncate">
					<button
						type="button"
						onClick={() => navigateTo(ROUTE_PATHS.deck)}
						className="font-mono text-[13px] font-semibold tracking-tight hover:text-[var(--needs)] cursor-pointer transition-colors"
					>
						Agent 任务调度器
					</button>
					<span className="text-[var(--ink-3)]">/</span>
					<span className="text-[12px] text-[var(--ink-2)]">运行详情</span>
					<span className="text-[var(--ink-3)]">/</span>
					<span className="font-mono text-[11px] text-[var(--ink-3)] truncate max-w-[180px]">
						{runId}
					</span>
				</div>

				<button
					type="button"
					onClick={() => navigateTo(ROUTE_PATHS.deck)}
					className="h-[32px] px-3 rounded-[9px] border border-[var(--border)] bg-[var(--panel-2)] text-[var(--ink-2)] font-ui text-[12px] hover:text-[var(--ink-1)] hover:border-[var(--border-strong)] transition-colors cursor-pointer"
				>
					返回甲板
				</button>
			</header>

			{/* 主内容区：装配运行详情容器 */}
			<main className="flex-1 min-h-0 flex flex-col p-3 overflow-hidden">
				<RunDetailContainer
					runId={runId}
					onOpenOriginalFile={onOpenOriginalFile}
					runStatus={runStatus}
					run={run}
					taskKey={taskKey}
					onRerunSuccess={onRerunSuccess}
					isMobile={isMobile}
					className="h-full w-full"
				/>
			</main>
		</div>
	);
}

export default RunDetailPage;
