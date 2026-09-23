/**
 * packages/web/src/pages/landing-page.tsx
 *
 * 落地清单页面装配件（M9-T16 / AC 3, AC 4, AC 6, E-74, E-19, E-110）
 * 批次级落地清单（M9-T20 / AC 5, E-74 批次侧）
 *
 * 规范依据（07 节前端架构与 R1 / R2）：
 * - pages 仅负责装配与骨架，禁止引入客户端层与状态管理器，禁止副作用取数
 * - 批次级与任务级的取数与呈现都下沉到 features/landing/landing-container.tsx：
 *   批次行由 `buildBatchLandingList()` 从 GET /batches/:id/wrapups 与 runs 拼出
 * - 缺少 taskId 走未知路径（UnknownRouteView），不回落缺省任务 M5-T4
 * - 批次级清单同样**只读、复制而不执行**：每轮收口分支与各修复分支各一行，`inHead` 为真的行打勾
 * - 长时间盯屏下深色为默认、路径/命令/代码/数字一律等宽（AC 6, E-110）
 */

import {
	ROUTE_PATHS,
	type RouteComponentProps,
	UnknownRouteView,
	navigateTo,
} from '../app/routes.tsx';
import {
	LandingContainer,
	type LandingContainerProps,
} from '../features/landing/landing-container.tsx';

export interface LandingPageProps extends Partial<RouteComponentProps>, LandingContainerProps {
	/** 外部自定义 class */
	readonly className?: string;
}

/**
 * 落地清单页面主组件（M9-T16 / AC 3, E-74；M9-T20 / AC 5）。
 * pages 层纯装配：读路由参数、放置顶栏与栏位骨架，把 LandingContainer 摆进去。
 */
export function LandingPage(props: LandingPageProps) {
	const {
		match,
		params,
		taskId: explicitTaskId,
		initialData,
		docChangeNotice,
		onViewAffectedTasks,
		fetcher,
		batchLanding,
		className = '',
	} = props;

	// R2: 路由缺 taskId 走未知路径，严禁默认回落 M5-T4
	const taskId = explicitTaskId ?? params?.taskId ?? match?.params?.taskId;

	if (!taskId) {
		return <UnknownRouteView match={match} />;
	}

	return (
		<div
			data-component="landing-page"
			data-testid="task-landing-page"
			data-task-id={taskId}
			className={[
				'flex min-h-screen flex-col bg-page text-ink-1 font-ui select-none',
				className,
			].join(' ')}
		>
			{/* 顶栏 52px 导航与返回（07 节前端架构） */}
			<header className="h-topbar flex items-center justify-between border-b border-border bg-bg px-4 text-ink-1">
				<div className="flex items-center gap-2">
					<button
						type="button"
						data-action="back-to-deck"
						onClick={() => navigateTo(ROUTE_PATHS.deck)}
						className="h-btn-sm px-2 rounded-sm border border-border bg-panel-2 text-ink-2 hover:text-ink-1 font-ui text-micro"
					>
						← 运行甲板
					</button>
					<span className="text-ink-3">/</span>
					<span className="font-mono text-micro text-ink-3">Landing</span>
					<span className="text-ink-3">/</span>
					<h1 className="font-mono text-dense font-semibold text-ink-1">{taskId} 落地清单</h1>
				</div>

				<div className="flex items-center gap-2">
					<span className="font-mono text-micro text-auto bg-auto-soft border border-auto px-2 py-0.5 rounded-sm">
						只读清单 · 复制而不执行 (E-74)
					</span>
				</div>
			</header>

			{/* 主内容区：批次级清单与任务级清单都由 LandingContainer 取数并拼装 */}
			<main className="flex-1 p-4 sm:p-6 max-w-4xl mx-auto w-full flex flex-col gap-6">
				<LandingContainer
					taskId={taskId}
					initialData={initialData}
					docChangeNotice={docChangeNotice}
					onViewAffectedTasks={onViewAffectedTasks}
					fetcher={fetcher}
					batchLanding={batchLanding}
				/>
			</main>
		</div>
	);
}

export default LandingPage;
