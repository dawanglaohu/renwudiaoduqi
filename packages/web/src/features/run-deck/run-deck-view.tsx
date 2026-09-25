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

import type { BatchWrapupDto } from '@agent-scheduler/shared/api/batches';
import type { LaneView } from '@agent-scheduler/shared/api/lanes';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import { type ReactNode, useCallback } from 'react';
import { navigateTo } from '../../app/routes.tsx';
import { AssignPanel } from '../../components/assign-panel.tsx';
import { BatchTree, type BatchTreeItem } from '../../components/batch-tree.tsx';
import { EmptyOnboarding } from '../../components/empty-onboarding.tsx';
import { GateCard } from '../../components/gate-card.tsx';
import { InlineNotice } from '../../components/inline-notice.tsx';
import { LaneRunStrip } from '../../components/lane-run-strip.tsx';
import { ThumbBar } from '../../components/thumb-bar.tsx';
import type { BatchWrapupFailureView } from '../../components/wrapup-report.tsx';
import type { DensityTier } from '../../hooks/use-breakpoint.ts';
import { PayloadSheetProvider } from '../../hooks/use-payload-sheet.ts';
import { useSelectionStore } from '../../store/selection-store.ts';
import type { LaneStepItem } from './lane-steps-container.tsx';
import { LanesContainer } from './lanes-container.tsx';
import { MobileBottomSheet } from './mobile-bottom-sheet.tsx';
import { MobilePaneSwitcher } from './mobile-pane-switcher.tsx';
import { StopConfirmDialog } from './stop-confirm-dialog.tsx';
import type { DeckStreamLane, MobileBatchItem } from './types.ts';
import { useAssignPanel } from './use-assign-panel.ts';
import { useBatchTree } from './use-batch-tree.ts';
import { useGateCard } from './use-gate-card.ts';
import { type UseRunDeckResult, isWaitingApproval } from './use-run-deck.ts';
import { WrapupPanelContainer } from './wrapup-panel-container.tsx';

/**
 * 就地审批卡（M9-T20 / R3, AC 4, E-278, E-117, E-113）。
 *
 * 挂在该泳道的审批槽位里。只有 daemon 真的下发了待处理闸门才渲染这一层，
 * 「投递原文到实施会话」走 features 层的 use-gate-card（POST /runs/:id/messages），
 * 能力位取**目标实施运行**的 `capabilities.canReply`，缺失即灰掉并带 title。
 */
interface LaneGateCardProps {
	readonly lane: DeckStreamLane;
	readonly tier: DensityTier;
	readonly isTouch: boolean;
	readonly onDecideGate?: (
		gateId: string,
		decision: 'pass' | 'reject',
		comment?: string,
	) => void | Promise<void>;
}

function LaneGateCard(props: LaneGateCardProps) {
	const { lane, tier, isTouch, onDecideGate } = props;
	const gateId = lane.gateId ?? null;
	const targetRunId = lane.deliverTargetRunId ?? null;

	const gateCard = useGateCard({
		runId: targetRunId,
		reworkText: lane.reworkText,
		reviewVerdict: lane.reviewVerdict,
		canReply: lane.deliverTargetCanReply,
	});

	const canDecide = Boolean(gateId && onDecideGate);

	return (
		<GateCard
			gateKind="review"
			taskKey={lane.taskKey}
			taskTitle={lane.title}
			reviewVerdict={lane.reviewVerdict ?? undefined}
			reworkText={lane.reworkText ?? undefined}
			canReply={gateCard.canReply}
			deliveryNotice={gateCard.deliveryNotice}
			isReworkTextCopied={gateCard.isReworkTextCopied}
			onCopyReworkText={() => {
				void gateCard.copyReworkText();
			}}
			disabled={!canDecide}
			onApprove={() => {
				if (gateId) void onDecideGate?.(gateId, 'pass');
			}}
			onReject={() => {
				if (gateId) void onDecideGate?.(gateId, 'reject');
			}}
			onEdit={() => {
				if (gateId) void onDecideGate?.(gateId, 'reject', '改一下');
			}}
			tier={tier}
			isTouch={isTouch}
			isMobile={tier === 'phone' || tier === 'phone-xs'}
			{...(gateCard.shouldShowDeliverRaw
				? {
						onDeliverRaw: () => {
							void gateCard.deliverRaw();
						},
					}
				: {})}
		/>
	);
}

/**
 * 泳道主体：收口运行挂收口报告面板，任务运行留给 M9-T21 的阶段链（E-297、E-312）。
 */
function laneBodySlot(lane: DeckStreamLane, tier: DensityTier, isTouch: boolean): ReactNode {
	if (lane.kind === 'wrapup' && lane.batchId) {
		return <WrapupPanelContainer batchId={lane.batchId} tier={tier} isTouch={isTouch} />;
	}
	return lane.bodySlot ?? null;
}

/**
 * 泳道审批槽：只在 daemon 下发了待处理闸门时画审批卡（不画假按钮）。
 */
function laneGateSlot(
	lane: DeckStreamLane,
	tier: DensityTier,
	isTouch: boolean,
	onDecideGate: LaneGateCardProps['onDecideGate'],
): ReactNode {
	if (lane.gateId) {
		return <LaneGateCard lane={lane} tier={tier} isTouch={isTouch} onDecideGate={onDecideGate} />;
	}
	return lane.gateSlot ?? null;
}

/**
 * 运行甲板视图属性。
 */
export interface RunDeckViewProps extends UseRunDeckResult {
	/** 泳道数组（流数恒等于 lanes.length，AC 12） */
	readonly lanes: readonly DeckStreamLane[];
	/** 批次数据（E-13, R2） */
	readonly batches?: readonly (BatchTreeItem | MobileBatchItem)[];
	/** 选择任务项回调 */
	readonly onSelectTask?: (taskId: string, laneNo?: number) => void;
	/** 顶部工具栏自定扩展 */
	readonly toolbarSlot?: ReactNode;
	/** 外部自定义 class */
	readonly className?: string;
	/** 点击批次树「收口」按钮回调（M9-T20 / AC 3） */
	readonly onWrapup?: (batchId: string) => void;
	/** 点击批次树收口运行行回调 */
	readonly onOpenWrapupRun?: (runId: string, batchId: string) => void;
	/** 正在收口的批次 ID（该批按钮禁用，等 batch.wrapup_started 回流） */
	readonly wrapupPendingBatchId?: string | null;
	readonly wrapupPendingBatchIds?: ReadonlySet<string>;
	/** 每批最近一次收口被拒的具名原因 */
	readonly wrapupFailureByBatch?: ReadonlyMap<string, BatchWrapupFailureView>;
	/** 错误信息（若为 '泳道数据不可用' 触发 E-333 展示） */
	readonly error?: string | null;
	/** 任务清单 */
	readonly tasks?: readonly TaskDto[];
	/** 运行清单 */
	readonly runs?: readonly RunDto[];
	/** 原始 LaneView 清单（若可用） */
	readonly rawLanes?: readonly LaneView[];
	readonly wrapups?: readonly BatchWrapupDto[];
	/** 泳道步骤获取回调（R1） */
	readonly getLaneSteps?: (laneNo: number, runId?: string | null) => readonly LaneStepItem[];
	/** 审批决定回调（M9-T20 审批卡放行/拒绝） */
	readonly onDecideGate?: (
		gateId: string,
		decision: 'pass' | 'reject',
		comment?: string,
	) => Promise<void> | void;
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
		error,
		tasks = [],
		runs = [],
		rawLanes,
		wrapups,
		getLaneSteps,

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
		batches,
		onSelectTask,
		onWrapup,
		onOpenWrapupRun,
		wrapupPendingBatchId = null,
		wrapupPendingBatchIds,
		wrapupFailureByBatch,
		onDecideGate,
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
	// Keep the daemon's stage and archive fields alongside the deck's gate and wrapup data.
	const pipelineLanes = rawLanes
		? rawLanes.map((rawLane) => {
				const deckLane = lanes.find((lane) => lane.laneNo === rawLane.laneNo);
				return {
					...rawLane,
					...deckLane,
					taskId: rawLane.taskId,
					currentRunId: rawLane.currentRunId,
					stage: rawLane.stage,
					archivedTaskIds: rawLane.archivedTaskIds,
					archivedWrapupRunId: rawLane.archivedWrapupRunId,
					nextTaskId: rawLane.nextTaskId,
					nextBlockedBy: rawLane.nextBlockedBy,
					overLimit: rawLane.overLimit,
					bodySlot: deckLane ? laneBodySlot(deckLane, tier, isTouch) : null,
				};
			})
		: lanes.map((lane) => ({
				...lane,
				bodySlot: laneBodySlot(lane, tier, isTouch),
			}));

	const selectedDocId = useSelectionStore((state) => state.selectedDocId);
	// Both trees follow the document selected in the dispatch console.
	const {
		batches: treeBatches,
		expandedIds,
		error: batchTreeError,
		toggleBatch,
	} = useBatchTree({
		batches: batches as readonly BatchTreeItem[] | undefined,
		docId: selectedDocId ?? undefined,
	});

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

	// E-108: 零运行空态呈现四步引导控制台，而非插画（M9-T16, M9-T18 接入真实零运行流程）。
	// 零流与有流都保留左栏批次树与顶栏（M9-T19 R2），所以这里不再提前 return，只准备空态控制台节点。
	const assignPanel = useAssignPanel({ enabled: streamCount === 0 });

	const emptyConsole = (
		<>
			{/* 取数失败就地提示，不整页替换（07 节错误体系） */}
			{assignPanel.error && (
				<div className="mb-3 w-full max-w-4xl mx-auto">
					<InlineNotice
						tone="down"
						testId="assign-panel-error"
						message={assignPanel.error.message}
						technical={assignPanel.error.technical}
					/>
				</div>
			)}
			<EmptyOnboarding
				documents={assignPanel.documents}
				batches={assignPanel.batches}
				tasks={assignPanel.tasks}
				selectedDocId={assignPanel.selectedDocId ?? undefined}
				selectedBatchId={assignPanel.selectedBatchId ?? undefined}
				onSelectDoc={assignPanel.selectDoc}
				onSelectBatch={assignPanel.selectBatch}
				step3Summary={assignPanel.step3Summary}
				step3Slot={
					<AssignPanel
						mode="step3"
						tasks={assignPanel.tasks}
						agents={assignPanel.agents}
						assignments={assignPanel.assignments}
						agentCapacities={assignPanel.agentCapacities}
						onAssignTask={(taskId, selection) => {
							void assignPanel.assignTask(taskId, selection);
						}}
						onResetAssignment={(taskId) => {
							void assignPanel.resetAssignment(taskId);
						}}
					/>
				}
				step4Slot={
					<AssignPanel
						mode="step4"
						audit={assignPanel.audit}
						isUnlockedAboveWindow={assignPanel.isUnlockedAboveWindow}
						canIncreaseUserSetting={assignPanel.canIncreaseUserSetting}
						canDecreaseUserSetting={assignPanel.canDecreaseUserSetting}
						onChangeUserSetting={(laneCount) => {
							void assignPanel.changeUserSetting(laneCount);
						}}
						onToggleUnlockAboveWindow={assignPanel.toggleUnlockAboveWindow}
					/>
				}
			/>
		</>
	);

	// ─── 桌面/宽屏布局容器样式 ───
	const getDeckLayoutClass = (): string => {
		// 1. 紧凑档（AC 2, E-164）
		if (tier === 'compact') {
			return 'grid grid-cols-[repeat(auto-fill,minmax(var(--stream-min-dense,260px),1fr))] gap-4 p-4 overflow-y-auto flex-1 auto-rows-fr';
		}

		// 2. 完整档（AC 9, AC 10, E-163, E-167）
		if (tier === 'full') {
			if (streamCount <= 3) {
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
							<LaneRunStrip
								currentIndex={props.activeMobileLanePosition ?? 1}
								totalLanes={streamCount || 1}
								taskKey={currentMobileLane?.taskKey}
								title={currentMobileLane?.title}
								status={currentMobileLane?.status}
								isIdle={currentMobileLane?.kind === 'idle'}
								isWrapup={currentMobileLane?.kind === 'wrapup'}
								onPrev={handlePrevMobileLane}
								onNext={handleNextMobileLane}
							/>
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
									{batchTreeError && (
										<InlineNotice
											tone="down"
											testId="batch-tree-error"
											message={batchTreeError.message}
											technical={batchTreeError.technical}
										/>
									)}
									<BatchTree
										batches={treeBatches}
										expandedIds={expandedIds}
										densityTier={tier}
										isTouch={isTouch}
										onToggleBatch={toggleBatch}
										onSelectTask={(taskId) => handleSelectTaskAndJump(taskId)}
										onWrapup={onWrapup}
										onOpenWrapupRun={onOpenWrapupRun}
										renderWrapupPanel={(batchId) =>
											lanes.some(
												(lane) => lane.kind === 'wrapup' && lane.batchId === batchId,
											) ? null : (
												<WrapupPanelContainer batchId={batchId} tier={tier} isTouch={isTouch} />
											)
										}
										wrapupPendingBatchId={wrapupPendingBatchId}
										wrapupPendingBatchIds={wrapupPendingBatchIds}
										wrapupFailureByBatch={wrapupFailureByBatch}
									/>
								</div>
							)}

							{/* 栏位 2：运行流（单流全屏，一次一条泳道，E-107, E-145） */}
							{activePane === 'stream' && (
								<div
									data-pane-view="stream"
									className="flex flex-col h-full w-full overflow-y-auto flex-1 p-3 gap-3"
								>
									{streamCount === 0 && !error ? (
										emptyConsole
									) : (
										<LanesContainer
											lanes={pipelineLanes}
											tasks={tasks}
											runs={runs}
											wrapups={wrapups}
											isUnavailable={error === '泳道数据不可用'}
											errorMessage={error}
											overrideTier={tier}
											hideMobileRunStrip={true}
											activeMobileLanePosition={props.activeMobileLanePosition}
											activeMobileLaneNo={activeMobileLaneNo}
											onPrevMobileLane={handlePrevMobileLane}
											onNextMobileLane={handleNextMobileLane}
											onOpenRun={(runId) => navigateTo(`#/run/${runId}`)}
											onStopLane={(laneNo, runId) => {
												const lane = lanes.find((l) => l.laneNo === laneNo);
												void handleStopLane(laneNo, runId, lane?.taskKey);
											}}
											stoppingLanes={stoppingLanes}
											renderApprovalSlot={(laneNo) => {
												const lane = lanes.find((l) => l.laneNo === laneNo);
												return lane ? laneGateSlot(lane, tier, true, onDecideGate) : null;
											}}
											getLaneSteps={getLaneSteps}
										/>
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
								{batchTreeError && (
									<InlineNotice
										tone="down"
										testId="batch-tree-error"
										message={batchTreeError.message}
										technical={batchTreeError.technical}
									/>
								)}
								<BatchTree
									batches={treeBatches}
									expandedIds={expandedIds}
									densityTier={tier}
									isTouch={isTouch}
									onToggleBatch={toggleBatch}
									onSelectTask={(taskId) => handleSelectTaskAndJump(taskId)}
									onWrapup={onWrapup}
									onOpenWrapupRun={onOpenWrapupRun}
									renderWrapupPanel={(batchId) =>
										lanes.some(
											(lane) => lane.kind === 'wrapup' && lane.batchId === batchId,
										) ? null : (
											<WrapupPanelContainer batchId={batchId} tier={tier} isTouch={isTouch} />
										)
									}
									wrapupPendingBatchId={wrapupPendingBatchId}
									wrapupPendingBatchIds={wrapupPendingBatchIds}
									wrapupFailureByBatch={wrapupFailureByBatch}
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

								{streamCount === 0 && !error ? (
									<div className="flex flex-col flex-1 p-4 overflow-y-auto">{emptyConsole}</div>
								) : (
									<LanesContainer
										lanes={pipelineLanes}
										tasks={tasks}
										runs={runs}
										wrapups={wrapups}
										isUnavailable={error === '泳道数据不可用'}
										errorMessage={error}
										overrideTier={tier}
										onOpenRun={(runId) => navigateTo(`#/run/${runId}`)}
										onStopLane={(laneNo, runId) => {
											const lane = lanes.find((l) => l.laneNo === laneNo);
											void handleStopLane(laneNo, runId, lane?.taskKey);
										}}
										stoppingLanes={stoppingLanes}
										renderApprovalSlot={(laneNo) => {
											const lane = lanes.find((l) => l.laneNo === laneNo);
											return lane ? laneGateSlot(lane, tier, isTouch, onDecideGate) : null;
										}}
										getLaneSteps={getLaneSteps}
										expandedLaneNo={expandedLaneNo}
										onToggleExpandLane={toggleExpandLane}
										scrollContainerRef={scrollContainerRef}
										layoutClassName={getDeckLayoutClass()}
									/>
								)}

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
