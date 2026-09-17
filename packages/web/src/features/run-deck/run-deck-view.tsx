/**
 * packages/web/src/features/run-deck/run-deck-view.tsx
 *
 * 运行甲板多流监看与手机单栏视图组件（M9-T9, M9-T12 / AC 1-12, E-13, E-58, E-99, E-106, E-107, E-124, E-145, E-240）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 档位通过 useDensityTier() 单点计算下传（AC 1, E-235）
 * - 手机竖屏 < 400px 降级为单栏切换（任务列表 / 运行流 / 详情），不得横向滚动或并排三栏（AC 1, E-145）
 * - 停止与批准固定在拇指区、分置两端或间距 >= 24px、各 >= 44x44px，不随日志滚动移出视野（AC 2, E-107）
 * - 单栏切换到「任务列表」时若某条流转「等你」，必须有可见的未处理计数徽标（AC 3, E-240）
 * - 手机端中止需二次确认防口袋误触（AC 4, E-124）
 * - 首屏加载量显著更小（尾部 32KB），不预取全量；切后台回前台不重拉全量（AC 5, E-99）
 * - 展开的 tool payload 走 bottom sheet 不内联（AC 6）
 * - 批次表格在小屏降级为可折叠列表（AC 7, E-13）
 * - app 曾退到后台时重回前台拉未读列表，等待中的确认项不过期、不自动放行（AC 8, E-58）
 * - 每条运行流一个 ErrorBoundary，一条流崩了不带走另外四条（07 节）
 * - 甲板严禁出现横向滚动类名（check-forbidden 与 E-145）
 */

import { Component, type ErrorInfo, type ReactNode, useCallback } from 'react';
import { BatchTree, type BatchTreeItem } from '../../components/batch-tree.tsx';
import { EmptyOnboarding } from '../../components/empty-onboarding.tsx';
import { StreamColumn } from '../../components/stream-column.tsx';
import { ThumbBar } from '../../components/thumb-bar.tsx';
import type { DensityTier } from '../../hooks/use-breakpoint.ts';
import { PayloadSheetProvider } from '../../hooks/use-payload-sheet.ts';
import { GateTogglesContainer } from './gate-toggles-container.tsx';
import { MobileBottomSheet } from './mobile-bottom-sheet.tsx';
import { MobilePaneSwitcher } from './mobile-pane-switcher.tsx';
import { StopConfirmDialog } from './stop-confirm-dialog.tsx';
import type { DeckStreamLane, MobileBatchItem } from './types.ts';
import { useBatchTree } from './use-batch-tree.ts';
import { type UseRunDeckResult, isWaitingApproval } from './use-run-deck.ts';

/**
 * 单流异常隔离边界（07 节：每条运行流一个 ErrorBoundary，一条流崩了不许带走另外四条）。
 */
interface StreamErrorBoundaryProps {
	readonly laneNo: number;
	readonly children: ReactNode;
}

interface StreamErrorBoundaryState {
	readonly hasError: boolean;
	readonly errorMessage?: string;
}

class StreamErrorBoundary extends Component<StreamErrorBoundaryProps, StreamErrorBoundaryState> {
	override state: StreamErrorBoundaryState = { hasError: false };

	static getDerivedStateFromError(error: unknown): StreamErrorBoundaryState {
		return {
			hasError: true,
			errorMessage: error instanceof Error ? error.message : '未知运行流渲染异常',
		};
	}

	override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
		console.error(
			`[StreamErrorBoundary] 泳道 ${this.props.laneNo} 发生渲染异常:`,
			error,
			errorInfo,
		);
	}

	override render(): ReactNode {
		if (this.state.hasError) {
			return (
				<div
					data-stream-error-fallback="true"
					data-lane-no={this.props.laneNo}
					className="flex flex-col items-center justify-center p-4 rounded-[14px] border border-[var(--down)] bg-[var(--bg)] text-[var(--down)] font-mono text-[12px] min-h-[200px]"
				>
					<span className="font-bold mb-1">泳道 {this.props.laneNo} 界面故障</span>
					<span className="text-[11px] text-[var(--ink-3)] text-center">
						{this.state.errorMessage}
					</span>
					<button
						type="button"
						onClick={() => this.setState({ hasError: false })}
						className="mt-3 px-3 py-1 rounded-[6px] border border-[var(--border)] bg-[var(--panel-2)] text-[var(--ink-1)] hover:bg-[var(--border)] cursor-pointer text-[11px]"
					>
						重试重挂本流
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}

/**
 * 运行甲板视图属性。
 */
export interface RunDeckViewProps extends UseRunDeckResult {
	/** 泳道数组（流数恒等于 lanes.length，AC 12） */
	readonly lanes: readonly DeckStreamLane[];
	/** 批次折叠列表数据（E-13） */
	readonly batches?: readonly MobileBatchItem[];
	/** 选择任务项回调 */
	readonly onSelectTask?: (taskId: string, laneNo?: number) => void;
	/** 顶部工具栏自定扩展 */
	readonly toolbarSlot?: ReactNode;
	/** 外部自定义 class */
	readonly className?: string;
}

export function RunDeckView(props: RunDeckViewProps) {
	const {
		lanes,
		tier,
		isTouch,
		width,
		expandedLaneNo,
		toggleExpandLane,
		stoppingLanes,
		handleStopLane,
		userPreference,
		togglePreference,
		scrollContainerRef,
		offScreenWaiting,
		scrollToLane,
		toolbarSlot,
		className,

		// 手机端能力（M9-T12）
		activePane = 'stream',
		setPane,
		activeMobileLaneNo = 1,
		handlePrevMobileLane,
		handleNextMobileLane,
		selectMobileLane,
		currentMobileLane = lanes[0],
		totalWaitingCount,
		isCurrentLaneWaiting,
		isApproving = false,
		handleApproveLane,
		stopConfirmOpen = false,
		stopConfirmTarget = null,
		confirmStop,
		cancelStop,
		activeToolPayload = null,
		openToolPayloadSheet,
		closeToolPayloadSheet,
		tailBytes = 32768,
		isTailOnly = false,
		batches = [],
		onSelectTask,
	} = props;

	// 若未显式下发 waiting 统计，由 lanes 自行兜底计算
	const effectiveIsCurrentLaneWaiting =
		isCurrentLaneWaiting ?? (currentMobileLane ? isWaitingApproval(currentMobileLane) : false);
	const effectiveTotalWaitingCount = totalWaitingCount ?? lanes.filter(isWaitingApproval).length;

	// 档位名称文案
	const tierDisplayMap: Record<DensityTier, string> = {
		full: '完整档',
		compact: '紧凑档',
		narrow: '单列列表',
		phone: '手机档',
		'phone-xs': '极窄手机档',
	};

	const streamCount = lanes.length;

	// 批次数据映射至 BatchTreeItem (R1, R2)
	const treeBatches: readonly BatchTreeItem[] = batches.map((b) => ({
		id: b.id,
		batchNo: b.batchNo,
		title: b.title,
		taskCount: b.taskCount,
		landedCount: b.landedCount,
		runningCount: b.runningCount,
		waitingCount: b.waitingCount,
		defaultExpanded: b.defaultExpanded,
		tasks: (b.tasks ?? []).map((t) => ({
			id: t.id,
			docId: 'current',
			moduleKey: 'M9',
			deps: [],
			estDays: null,
			batchId: b.id,
			taskKey: t.taskKey,
			title: t.title,
			state: typeof t.status === 'string' ? t.status : 'pending',
			inHead: t.isLanded === true ? true : null,
			laneNo: t.laneNo,
		})),
	}));

	const { expandedIds, toggleBatch } = useBatchTree({ batches: treeBatches });

	// 是否为手机档位（phone 或极窄 phone-xs，或者宽度 < 600px 且触控）
	const isMobileMode = tier === 'phone-xs' || tier === 'phone';

	// 切换任务并联动切换到运行流 pane
	const handleSelectTaskAndJump = useCallback(
		(taskId: string, laneNo?: number) => {
			if (laneNo !== undefined) {
				selectMobileLane?.(laneNo);
			}
			if (onSelectTask) {
				onSelectTask(taskId, laneNo);
			}
			// 在手机单栏模式下，选完任务自动跳到运行流查看
			if (isMobileMode) {
				setPane?.('stream');
			}
		},
		[selectMobileLane, onSelectTask, isMobileMode, setPane],
	);

	// E-108: 零运行空态直接呈现四步引导控制台，而非插画（M9-T16）。
	// 必须放在全部 hook 之后：泳道数在 0 与非 0 之间变化时 hook 数量不能变。
	if (streamCount === 0) {
		return (
			<section
				data-run-deck="true"
				data-tier={tier}
				data-stream-count={0}
				className={[
					'flex flex-col h-full w-full bg-[var(--page)] text-[var(--ink-1)] select-none overflow-y-auto p-4',
					className ?? '',
				].join(' ')}
			>
				<EmptyOnboarding />
			</section>
		);
	}

	// ─── 桌面/宽屏布局容器样式 ───
	const getDeckLayoutClass = (): string => {
		// 1. 紧凑档（AC 2, E-164）
		if (tier === 'compact') {
			return 'grid grid-cols-[repeat(auto-fill,minmax(var(--stream-min-dense,260px),1fr))] gap-4 p-4 overflow-y-auto flex-1 auto-rows-fr';
		}

		// 2. 完整档（AC 9, AC 10, E-163, E-167）
		if (tier === 'full') {
			if (streamCount <= 3 && width >= 1440) {
				return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4 overflow-y-auto flex-1 auto-rows-fr';
			}
			return 'relative flex flex-row gap-4 p-4 overflow-auto flex-1';
		}

		// 3. 桌面窄窗（AC 11, E-168）
		if (tier === 'narrow') {
			return 'flex flex-col gap-4 p-4 overflow-y-auto flex-1 w-full max-w-[800px] mx-auto';
		}

		// 4. 手机档位（在单流模式下占满垂直容器）
		return 'flex flex-col gap-3 p-3 overflow-y-auto flex-1 w-full';
	};

	return (
		<PayloadSheetProvider
			isMobile={isMobileMode || isTouch}
			activePayload={activeToolPayload}
			onOpenPayload={openToolPayloadSheet}
			onClosePayload={closeToolPayloadSheet}
		>
			<section
				data-run-deck="true"
				data-tier={tier}
				data-stream-count={streamCount}
				data-tail-bytes={tailBytes}
				data-tail-only={isTailOnly ? 'true' : 'false'}
				className={[
					'flex flex-col h-full w-full bg-[var(--page)] text-[var(--ink-1)] select-none relative overflow-hidden',
					className ?? '',
				].join(' ')}
			>
				{/* ─────────────────────────────────────────────────────────────
			    顶栏：在手机模式下渲染单栏切换器（E-145, E-240）；
			    在桌面模式下渲染状态与密度切换（AC 1, AC 9）
			    ───────────────────────────────────────────────────────────── */}
				{isMobileMode ? (
					<header className="flex flex-col w-full flex-shrink-0 z-30">
						{/* 单栏切换器（任务列表 / 运行流 / 详情，E-145），带未处理计数徽标（E-240） */}
						<MobilePaneSwitcher
							activePane={activePane}
							onPaneChange={setPane ?? (() => {})}
							waitingCount={effectiveTotalWaitingCount}
						/>

						{/* 手机运行条（--runstrip-h Token 高度）：单流全屏时常驻，显示当前泳道与 ◀ ▶ 切换器（11 节 UI / 决策 97） */}
						{activePane === 'stream' && (
							<div
								data-lane-run-strip="true"
								className="flex items-center justify-between gap-2 px-3 min-h-[var(--runstrip-h,44px)] h-[var(--runstrip-h,44px)] bg-[var(--panel-2)] border-b border-[var(--border)] font-ui text-[13px]"
							>
								<button
									type="button"
									data-action="prev-lane"
									disabled={streamCount <= 1}
									onClick={handlePrevMobileLane}
									aria-label="查看上一条泳道"
									className="min-h-[44px] min-w-[44px] h-[44px] w-[44px] rounded-[6px] text-[var(--ink-2)] hover:text-[var(--ink-1)] flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
								>
									◀
								</button>

								<div className="flex items-center gap-2 min-w-0 px-1 truncate">
									<span className="font-mono text-[12px] text-[var(--ink-3)] flex-shrink-0">
										泳道 {activeMobileLaneNo}/{streamCount || 1}
									</span>
									<span className="font-mono font-semibold text-[var(--ink-1)] truncate">
										{currentMobileLane?.taskKey ?? '—'}
									</span>
									{currentMobileLane?.title && (
										<span className="text-[var(--ink-2)] truncate">
											· {currentMobileLane.title}
										</span>
									)}
								</div>

								<button
									type="button"
									data-action="next-lane"
									disabled={streamCount <= 1}
									onClick={handleNextMobileLane}
									aria-label="查看下一条泳道"
									className="min-h-[44px] min-w-[44px] h-[44px] w-[44px] rounded-[6px] text-[var(--ink-2)] hover:text-[var(--ink-1)] flex items-center justify-center cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
								>
									▶
								</button>
							</div>
						)}
					</header>
				) : (
					// 桌面顶栏
					<div
						data-deck-toolbar="true"
						className="flex items-center justify-between gap-3 px-4 py-2 border-b border-[var(--border)] bg-[var(--bg)] min-h-[44px] flex-shrink-0"
					>
						<div className="flex items-center gap-3 text-[12px] font-mono text-[var(--ink-2)]">
							<span data-indicator="stream-count" className="font-semibold text-[var(--ink-1)]">
								并行流数: {streamCount}
							</span>
							<span className="text-[var(--border-strong)]">|</span>
							<span data-indicator="current-tier">当前档位: {tierDisplayMap[tier]}</span>
							{isTouch && (
								<span
									data-indicator="touch-mode"
									className="px-1.5 py-0.5 rounded-[4px] bg-[var(--panel-2)] text-[var(--ink-3)] text-[11px]"
								>
									触控优化 (44px)
								</span>
							)}
							{toolbarSlot}
						</div>

						<div className="flex items-center gap-3">
							<GateTogglesContainer layout="topbar" />
							{(tier === 'full' || tier === 'compact') && (
								<button
									type="button"
									data-action="toggle-density"
									onClick={togglePreference}
									title={`切换至${tier === 'compact' ? '完整档' : '紧凑档'}`}
									className={`
									inline-flex items-center gap-1.5 px-3 rounded-[9px]
									font-ui text-[12px] font-medium transition-colors
									border border-[var(--border-strong)] bg-[var(--panel-2)]
									text-[var(--ink-1)] hover:brightness-105 active:brightness-95
									focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--needs-soft)]
									cursor-pointer ${isTouch ? 'h-[44px]' : 'h-[32px]'}
								`}
								>
									<span className="text-[var(--ink-3)] font-mono text-[11px]">档位:</span>
									<span>{tier === 'compact' ? '切换完整档' : '切换紧凑档'}</span>
								</button>
							)}
						</div>
					</div>
				)}

				{/* ─────────────────────────────────────────────────────────────
			    主体内容区：
			    手机模式下根据 activePane 渲染单栏，绝不横向滚动或并排三栏（E-145）；
			    桌面模式下渲染完整/紧凑/单列列表（E-163, E-164, E-168）。
			    ───────────────────────────────────────────────────────────── */}
				<div
					className={[
						'relative flex-1 flex flex-col min-h-0 overflow-hidden',
						// 在手机端为底部拇指栏留出固定间距（60px + safe-area），确保内容不被遮盖 (E-107)
						isMobileMode
							? 'pb-[calc(var(--thumbbar-h,60px)+env(safe-area-inset-bottom)+12px)]'
							: '',
					].join(' ')}
				>
					{/* 手机模式分支 */}
					{isMobileMode ? (
						<>
							{/* 栏位 1：任务列表（批次树在小屏降级为可折叠列表，E-13, E-145, R2 取代 MobileBatchList） */}
							{activePane === 'tasks' && (
								<div
									data-pane-view="tasks"
									className="flex flex-col h-full w-full overflow-y-auto flex-1 p-3 gap-3 select-none"
								>
									<BatchTree
										batches={treeBatches}
										expandedIds={expandedIds}
										densityTier={tier}
										isTouch={isTouch}
										onToggleBatch={toggleBatch}
										onSelectTask={(taskId) => handleSelectTaskAndJump(taskId)}
									/>
								</div>
							)}

							{/* 栏位 2：运行流（单流全屏，一次一条泳道，E-107, E-145） */}
							{activePane === 'stream' && (
								<div
									data-pane-view="stream"
									className="flex flex-col h-full w-full overflow-y-auto flex-1 p-3 gap-3"
								>
									{currentMobileLane ? (
										<StreamErrorBoundary laneNo={currentMobileLane.laneNo}>
											<StreamColumn
												laneNo={currentMobileLane.laneNo}
												laneId={currentMobileLane.id}
												currentRunId={currentMobileLane.currentRunId}
												taskKey={currentMobileLane.taskKey}
												title={currentMobileLane.title}
												status={currentMobileLane.status}
												tier={tier}
												isExpanded={true}
												onStop={() =>
													handleStopLane(
														currentMobileLane.laneNo,
														currentMobileLane.currentRunId,
														currentMobileLane.taskKey,
													)
												}
												isStopping={stoppingLanes.has(currentMobileLane.laneNo)}
												agentMonogram={currentMobileLane.agentMonogram}
												agentName={currentMobileLane.agentName}
												modelName={currentMobileLane.modelName}
												refSource={currentMobileLane.refSource}
												duration={currentMobileLane.duration}
												tokenCount={currentMobileLane.tokenCount}
												cost={currentMobileLane.cost}
												errorMessage={currentMobileLane.errorMessage}
												isTouch={true}
												bodySlot={currentMobileLane.bodySlot}
												gateSlot={currentMobileLane.gateSlot}
												refBarSlot={currentMobileLane.refBarSlot}
												footSlot={currentMobileLane.footSlot}
											/>
										</StreamErrorBoundary>
									) : (
										<div className="flex flex-col items-center justify-center p-8 text-center text-[var(--ink-3)] font-ui text-[13px] flex-1">
											当前无可用泳道流
										</div>
									)}
								</div>
							)}

							{/* 栏位 3：运行详情（包含尾部 32KB 会话/日志，E-99, E-145） */}
							{activePane === 'detail' && (
								<div
									data-pane-view="detail"
									className="flex flex-col h-full w-full overflow-y-auto flex-1 p-3"
								>
									{currentMobileLane?.detailSlot ? (
										currentMobileLane.detailSlot
									) : (
										<div className="flex flex-col gap-3 rounded-[14px] bg-[var(--bg)] border border-[var(--border)] p-4 font-ui text-[13px]">
											<div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
												<span className="font-semibold text-[var(--ink-1)]">
													会话详情 · {currentMobileLane?.taskKey ?? '—'}
												</span>
												{currentMobileLane?.currentRunId && (
													<span className="font-mono text-[11px] text-[var(--ink-3)]">
														运行 ID: {currentMobileLane.currentRunId}
													</span>
												)}
											</div>
											<p className="text-[var(--ink-3)] text-[12px] leading-relaxed">
												暂无详情内容
											</p>
										</div>
									)}
								</div>
							)}
						</>
					) : (
						// 桌面端监看区（左栏 272px 批次树 + 泳道流监看区，R2, 11 节 UI）
						<div className="flex flex-row flex-1 min-h-0 overflow-hidden">
							{/* 左栏 272px 批次树（AC 1, AC 5, 11 节 UI, R2） */}
							<aside
								data-testid="deck-rail"
								className="w-[var(--rail-w,272px)] min-w-[var(--rail-w,272px)] shrink-0 border-r border-[var(--border)] bg-[var(--bg)] flex flex-col overflow-y-auto p-3 gap-3 select-none"
							>
								<div className="font-ui text-dense font-semibold text-[var(--ink-1)] px-1">
									批次与任务
								</div>
								<BatchTree
									batches={treeBatches}
									expandedIds={expandedIds}
									densityTier={tier}
									isTouch={isTouch}
									onToggleBatch={toggleBatch}
									onSelectTask={(taskId) => handleSelectTaskAndJump(taskId)}
								/>
							</aside>

							{/* 泳道监看区 */}
							<div className="relative flex-1 flex flex-col min-h-0 overflow-hidden">
								{tier === 'full' && offScreenWaiting.left > 0 && (
									<button
										type="button"
										data-offscreen="left"
										data-waiting-count={offScreenWaiting.left}
										onClick={() => {
											if (offScreenWaiting.firstLeftLaneNo !== undefined) {
												scrollToLane(offScreenWaiting.firstLeftLaneNo);
											}
										}}
										aria-label={`左侧有 ${offScreenWaiting.left} 条待处理泳道，点击滚入查看`}
										className="absolute left-3 top-6 z-20 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[9px] bg-[var(--needs)] text-[var(--on-needs)] font-ui font-semibold text-[12.5px] shadow-lg cursor-pointer hover:brightness-105 active:scale-98 transition-transform"
									>
										<span>←</span>
										<span>{offScreenWaiting.left} 条待处理</span>
									</button>
								)}

								<div ref={scrollContainerRef} className={getDeckLayoutClass()}>
									{lanes.map((lane) => {
										const isColumnExpanded = expandedLaneNo === lane.laneNo;

										return (
											<div
												key={lane.laneNo}
												data-lane-deck-slot={lane.laneNo}
												className={[
													tier === 'full' && streamCount > 3
														? 'flex-shrink-0 w-[380px] h-full'
														: '',
													isColumnExpanded ? 'col-span-full' : '',
													'flex flex-col h-full min-h-[360px]',
												]
													.filter(Boolean)
													.join(' ')}
											>
												<StreamErrorBoundary laneNo={lane.laneNo}>
													<StreamColumn
														laneNo={lane.laneNo}
														laneId={lane.id}
														currentRunId={lane.currentRunId}
														taskKey={lane.taskKey}
														title={lane.title}
														status={lane.status}
														tier={tier}
														isExpanded={isColumnExpanded}
														onToggleExpand={() => toggleExpandLane(lane.laneNo)}
														onStop={() =>
															handleStopLane(lane.laneNo, lane.currentRunId, lane.taskKey)
														}
														isStopping={stoppingLanes.has(lane.laneNo)}
														agentMonogram={lane.agentMonogram}
														agentName={lane.agentName}
														modelName={lane.modelName}
														refSource={lane.refSource}
														duration={lane.duration}
														tokenCount={lane.tokenCount}
														cost={lane.cost}
														errorMessage={lane.errorMessage}
														isTouch={isTouch}
														bodySlot={lane.bodySlot}
														gateSlot={lane.gateSlot}
														refBarSlot={lane.refBarSlot}
														footSlot={lane.footSlot}
													/>
												</StreamErrorBoundary>
											</div>
										);
									})}
								</div>

								{tier === 'full' && offScreenWaiting.right > 0 && (
									<button
										type="button"
										data-offscreen="right"
										data-waiting-count={offScreenWaiting.right}
										onClick={() => {
											if (offScreenWaiting.firstRightLaneNo !== undefined) {
												scrollToLane(offScreenWaiting.firstRightLaneNo);
											}
										}}
										aria-label={`右侧有 ${offScreenWaiting.right} 条待处理泳道，点击滚入查看`}
										className="absolute right-3 top-6 z-20 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[9px] bg-[var(--needs)] text-[var(--on-needs)] font-ui font-semibold text-[12.5px] shadow-lg cursor-pointer hover:brightness-105 active:scale-98 transition-transform"
									>
										<span>{offScreenWaiting.right} 条待处理</span>
										<span>→</span>
									</button>
								)}
							</div>
						</div>
					)}
				</div>

				{/* ─────────────────────────────────────────────────────────────
			    手机端常驻底部拇指栏（AC 2, E-107）：
			    停止与批准固定在拇指区、分置两端或间距 >= 24px、各 >= 44x44px，不随日志滚动移出视野
			    ───────────────────────────────────────────────────────────── */}
				{isMobileMode && (
					<ThumbBar
						canStop={Boolean(currentMobileLane)}
						isStopping={currentMobileLane ? stoppingLanes.has(currentMobileLane.laneNo) : false}
						onStop={() => {
							if (currentMobileLane) {
								void handleStopLane(
									currentMobileLane.laneNo,
									currentMobileLane.currentRunId,
									currentMobileLane.taskKey,
								);
							}
						}}
						canApprove={effectiveIsCurrentLaneWaiting && Boolean(handleApproveLane)}
						isApproving={isApproving}
						onApprove={() => {
							if (currentMobileLane && handleApproveLane) {
								void handleApproveLane(currentMobileLane.laneNo, currentMobileLane.currentRunId);
							}
						}}
						waitingCount={effectiveTotalWaitingCount}
						middleSlot={
							<span className="font-mono text-[11px] text-[var(--ink-3)] truncate">
								{currentMobileLane?.taskKey ?? ''}
							</span>
						}
					/>
				)}

				{/* ─────────────────────────────────────────────────────────────
			    手机端中止二次确认对话框（AC 4, E-124 口袋防误触）
			    ───────────────────────────────────────────────────────────── */}
				<StopConfirmDialog
					isOpen={stopConfirmOpen}
					laneNo={stopConfirmTarget?.laneNo}
					taskKey={stopConfirmTarget?.taskKey}
					runId={stopConfirmTarget?.runId}
					onConfirm={() => {
						confirmStop?.();
					}}
					onCancel={() => {
						cancelStop?.();
					}}
				/>

				{/* ─────────────────────────────────────────────────────────────
			    展开的 Tool Payload 底部抽屉（AC 6 不内联）
			    ───────────────────────────────────────────────────────────── */}
				<MobileBottomSheet
					isOpen={activeToolPayload !== null && activeToolPayload !== undefined ? true : undefined}
					payload={activeToolPayload ?? undefined}
					onClose={closeToolPayloadSheet}
				/>
			</section>
		</PayloadSheetProvider>
	);
}
