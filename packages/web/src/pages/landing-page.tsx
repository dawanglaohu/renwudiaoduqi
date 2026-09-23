/**
 * packages/web/src/pages/landing-page.tsx
 *
 * 落地清单页面装配件（M9-T16 / AC 3, AC 4, AC 6, E-74, E-19, E-110）
 * 批次级落地清单（M9-T20 / AC 5, E-74 批次侧）
 *
 * 规范依据（07 节前端架构与 R1 / R2）：
 * - pages 仅负责装配与骨架，禁止引入客户端层与状态管理器，禁止副作用取数
 * - 页面只接 props，数据获取与拼装下沉至 features（任务级 → LandingContainer，批次级 → 行由上层拼好）
 * - 缺少 taskId 走未知路径（UnknownRouteView），不回落缺省任务 M5-T4
 * - 批次级清单同样**只读、复制而不执行**：每轮收口分支与各修复分支各一行，`inHead` 为真的行打勾
 * - 长时间盯屏下深色为默认、路径/命令/代码/数字一律等宽（AC 6, E-110）
 */

import { useCallback, useState } from 'react';
import {
	ROUTE_PATHS,
	type RouteComponentProps,
	UnknownRouteView,
	navigateTo,
} from '../app/routes.tsx';
import {
	LandingContainer,
	type LandingContainerProps,
	copyToClipboard,
} from '../features/landing/landing-container.tsx';
import type { BatchLandingList } from '../features/run-deck/wrapup-panel-container.tsx';

export interface LandingPageProps extends Partial<RouteComponentProps>, LandingContainerProps {
	/**
	 * 批次级落地清单（daemon 的收口记录与运行行拼好下传；缺失时不渲染该段）。
	 * 行由 `buildBatchLandingList()` 从 GET /batches/:id/wrapups 与 runs 拼出，本页只呈现。
	 */
	readonly batchLanding?: BatchLandingList | null;
	/** 外部自定义 class */
	readonly className?: string;
}

/**
 * 落地清单页面主组件（M9-T16 / AC 3, E-74；M9-T20 / AC 5）。
 * pages 层纯装配：读路由参数、放置顶栏与栏位骨架，把批次级清单与 LandingContainer 摆进去。
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

	const [copiedToken, setCopiedToken] = useState<string | null>(null);

	const handleCopy = useCallback(async (token: string, text: string) => {
		if (!text || text === '—') return;
		const ok = await copyToClipboard(text);
		if (!ok) return;
		setCopiedToken(token);
		setTimeout(() => {
			setCopiedToken((prev) => (prev === token ? null : prev));
		}, 2000);
	}, []);

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

			{/* 主内容区：批次级清单 + 由 LandingContainer 承担的任务级拼装 */}
			<main className="flex-1 p-4 sm:p-6 max-w-4xl mx-auto w-full flex flex-col gap-6">
				{batchLanding && (
					<section
						data-component="batch-landing-list"
						data-batch-id={batchLanding.batchId}
						data-batch-no={batchLanding.batchNo ?? 'null'}
						data-row-count={batchLanding.rows.length}
						className="flex flex-col gap-3"
					>
						<div className="flex flex-col gap-1 border-b border-border pb-2">
							<div className="flex items-center gap-2">
								<span className="font-mono text-dense font-bold text-needs">
									{batchLanding.batchNo !== null ? `第 ${batchLanding.batchNo} 批` : '—'}
								</span>
								<span className="text-ink-3">·</span>
								<span className="text-dense text-ink-2">批次级落地清单</span>
							</div>
							<p className="text-meta text-ink-3">
								每轮收口分支与各修复分支各一行，命令只供复制、系统不代为执行（E-74）。
							</p>
						</div>

						{batchLanding.rows.length === 0 ? (
							<div
								data-testid="batch-landing-empty"
								className="rounded border border-border bg-bg p-4 font-mono text-meta text-ink-3"
							>
								该批还没有可落地的收口分支
							</div>
						) : (
							<ul className="flex flex-col gap-2 list-none m-0 p-0">
								{batchLanding.rows.map((row) => {
									const inHeadText =
										row.inHead === true ? '✓ 已进 HEAD' : row.inHead === false ? '未进 HEAD' : '—';
									const commandToken = `batch-landing:${row.id}`;
									return (
										<li
											key={row.id}
											data-batch-landing-row={row.kind}
											data-round={row.round}
											data-in-head={
												row.inHead === true ? 'true' : row.inHead === false ? 'false' : 'null'
											}
											className="flex flex-col gap-2 rounded border border-border bg-bg p-3"
										>
											<div className="flex items-center gap-2 flex-wrap">
												<span className="font-ui text-dense font-semibold text-ink-1">
													{row.label}
												</span>
												<span
													data-field="batch-landing-in-head"
													className={
														row.inHead === true
															? 'font-mono text-micro text-auto'
															: 'font-mono text-micro text-ink-3'
													}
												>
													{inHeadText}
												</span>
											</div>

											<div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-log">
												<div data-field="batch-landing-branch" className="truncate text-ink-1">
													<span className="text-ink-3 font-ui text-micro">分支 </span>
													{row.branchName ?? '—'}
												</div>
												<div data-field="batch-landing-worktree" className="truncate text-ink-2">
													<span className="text-ink-3 font-ui text-micro">worktree </span>
													{row.worktreePath ?? '—'}
												</div>
												<div data-field="batch-landing-diff" className="truncate text-ink-2">
													<span className="text-ink-3 font-ui text-micro">diff </span>
													{row.diffStat ?? '—'}
												</div>
											</div>

											<div className="flex items-center gap-2">
												<pre
													data-field="batch-landing-command"
													className="flex-1 m-0 rounded bg-panel-2 border border-border p-2 font-mono text-log text-ink-1 overflow-x-auto select-all"
												>
													{row.command}
												</pre>
												<button
													type="button"
													data-copy-token={commandToken}
													onClick={() => {
														void handleCopy(commandToken, row.command);
													}}
													className="h-btn-sm shrink-0 px-3 rounded-sm border border-border-strong bg-panel-2 text-micro font-mono text-ink-1 hover:border-needs active:scale-98 transition-all"
												>
													{copiedToken === commandToken ? '✓ 已复制' : '复制命令'}
												</button>
											</div>
										</li>
									);
								})}
							</ul>
						)}
					</section>
				)}

				<LandingContainer
					taskId={taskId}
					initialData={initialData}
					docChangeNotice={docChangeNotice}
					onViewAffectedTasks={onViewAffectedTasks}
					fetcher={fetcher}
				/>
			</main>
		</div>
	);
}

export default LandingPage;
