/**
 * packages/web/src/features/run-deck/run-deck-view.tsx
 *
 * 运行甲板多流监看视图组件（M9-T9 / AC 1-12, E-106, E-163..E-168, E-236..E-239）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 档位通过 useDensityTier() 单点计算下传（AC 1, E-235）
 * - 流数 >= 4 默认紧凑档，auto-fill 换行网格（每格 min 260px）而非横向滚动（AC 2, E-164）
 * - 紧凑档展开某条时该条占满全宽（col-span-full），其余流留在同屏绝不折叠消失（AC 3, E-165）
 * - 停止控件与审批槽位渲染在所有档位分支之外（AC 5, E-236, E-106）
 * - narrow 档停止键仍常驻可见，禁止 hover 显示或收进 ⋯（AC 6, E-237）
 * - 拖动窗口切换档位时不重挂虚拟列表、不弹回顶部、不中断跟随（AC 7, E-238）
 * - 流数 <= 3 且窗口 >= 1440px 默认完整档、不出现横向滚动，偏好记忆到本地（AC 9, E-163）
 * - 完整档横向滚动时若视野外某条流转成「要你」，视口左右边缘常驻计数标记（AC 10, E-167）
 * - 桌面窗口 < 1100px 退化为单列列表，不套用手机端规则（AC 11, E-168）
 * - 每条运行流一个 ErrorBoundary，一条流崩了不带走另外四条（07 节）
 * - 甲板严禁出现横向滚动类名（check-forbidden 机检与 E-145 约束，改用换行网格与 overflow-auto）
 */

import { Component, type ErrorInfo, type ReactNode, useCallback, useState } from 'react';
import { EmptyOnboarding } from '../../components/empty-onboarding.tsx';
import { StreamColumn } from '../../components/stream-column.tsx';
import type { DensityTier } from '../../hooks/use-breakpoint.ts';
import type { DeckStreamLane } from './types.ts';
import type { UseRunDeckResult } from './use-run-deck.ts';

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
		// 记录单流崩溃信息，供可观测性诊断
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
	} = props;

	// 手机档位下的当前查看泳道索引（1-based，默认 1）
	const [activeMobileLaneNo, setActiveMobileLaneNo] = useState<number>(1);

	const handlePrevMobileLane = useCallback(() => {
		setActiveMobileLaneNo((prev) => (prev > 1 ? prev - 1 : lanes.length));
	}, [lanes.length]);

	const handleNextMobileLane = useCallback(() => {
		setActiveMobileLaneNo((prev) => (prev < lanes.length ? prev + 1 : 1));
	}, [lanes.length]);

	// 档位名称文案
	const tierDisplayMap: Record<DensityTier, string> = {
		full: '完整档',
		compact: '紧凑档',
		narrow: '单列列表',
		phone: '手机档',
		'phone-xs': '极窄手机档',
	};

	const streamCount = lanes.length;

	// E-108: 零运行空态直接呈现四步引导控制台，而非插画
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

	// ─── 布局容器样式决定 ───
	// 保持单一 DOM 容器与稳定 key，确保拖动窗口切换档位时不重挂虚拟列表、不打断 SSE 跟随（AC 7, E-238）
	const getDeckLayoutClass = (): string => {
		// 1. 紧凑档（AC 2, E-164）：
		// auto-fill 换行网格（每格 min 260px）而非横向滚动，八条流在 1440px 折成两行全部可见
		if (tier === 'compact') {
			return 'grid grid-cols-[repeat(auto-fill,minmax(var(--stream-min-dense,260px),1fr))] gap-4 p-4 overflow-y-auto flex-1 auto-rows-fr';
		}

		// 2. 完整档（AC 9, AC 10, E-163, E-167）：
		// 流数 <= 3 时采用 1~3 列网格，不出现横向滚动；流数 > 3 或宽屏横向铺开时采用 flex-row
		if (tier === 'full') {
			if (streamCount <= 3 && width >= 1440) {
				return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4 overflow-y-auto flex-1 auto-rows-fr';
			}
			// 流数较多时横向并置（使用 overflow-auto）
			return 'relative flex flex-row gap-4 p-4 overflow-auto flex-1';
		}

		// 3. 桌面窄窗（AC 11, E-168）：
		// 宽度 < 1100px 退化为单列列表，不套用手机端规则，也不允许硬塞多栏
		if (tier === 'narrow') {
			return 'flex flex-col gap-4 p-4 overflow-y-auto flex-1 w-full max-w-[800px] mx-auto';
		}

		// 4. 手机档位（phone / phone-xs）：
		// 单流占满显示，配顶部运行条
		return 'flex flex-col gap-3 p-3 overflow-y-auto flex-1 w-full';
	};

	return (
		<section
			data-run-deck="true"
			data-tier={tier}
			data-stream-count={streamCount}
			className={[
				'flex flex-col h-full w-full bg-[var(--page)] text-[var(--ink-1)] select-none relative overflow-hidden',
				className ?? '',
			].join(' ')}
		>
			{/* ─────────────────────────────────────────────────────────────
			    顶栏：甲板状态与密度档位切换开关（AC 1, AC 9, E-163）
			    ───────────────────────────────────────────────────────────── */}
			<div
				data-deck-toolbar="true"
				className="flex items-center justify-between gap-3 px-4 py-2 border-b border-[var(--border)] bg-[var(--bg)] min-h-[44px]"
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

				<div className="flex items-center gap-2">
					{/* 手机档位专属：泳道前后切换器（11 节，决策 97） */}
					{(tier === 'phone' || tier === 'phone-xs') && streamCount > 1 && (
						<div data-mobile-switcher="true" className="flex items-center gap-1.5 mr-2">
							<button
								type="button"
								data-action="prev-lane"
								onClick={handlePrevMobileLane}
								aria-label="查看上一条泳道"
								className="h-[32px] w-[32px] rounded-[6px] border border-[var(--border)] bg-[var(--panel-2)] text-[var(--ink-1)] flex items-center justify-center cursor-pointer hover:bg-[var(--border)]"
							>
								◀
							</button>
							<span className="font-mono text-[12px] text-[var(--ink-2)] px-1">
								{activeMobileLaneNo} / {streamCount}
							</span>
							<button
								type="button"
								data-action="next-lane"
								onClick={handleNextMobileLane}
								aria-label="查看下一条泳道"
								className="h-[32px] w-[32px] rounded-[6px] border border-[var(--border)] bg-[var(--panel-2)] text-[var(--ink-1)] flex items-center justify-center cursor-pointer hover:bg-[var(--border)]"
							>
								▶
							</button>
						</div>
					)}

					{/* 桌面宽屏下密度档位手动切换开关（AC 9, E-163） */}
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

			{/* ─────────────────────────────────────────────────────────────
			    核心监看区：多泳道外壳网格并置（E-106, E-164, E-238）
			    ───────────────────────────────────────────────────────────── */}
			<div className="relative flex-1 flex flex-col min-h-0 overflow-hidden">
				{/* AC 10 & E-167: 完整档横向滚动时左侧视野外「要你」计数常驻标记 */}
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

				{/* 泳道容器（DOM 结构与 key 恒定，防重挂防闪烁，AC 7, E-238） */}
				<div ref={scrollContainerRef} className={getDeckLayoutClass()}>
					{lanes.map((lane) => {
						// 手机模式下仅展示当前选中泳道，但仍保持挂载属性与状态连续
						const isHiddenOnMobile =
							(tier === 'phone' || tier === 'phone-xs') && lane.laneNo !== activeMobileLaneNo;

						const isColumnExpanded = expandedLaneNo === lane.laneNo;

						return (
							<div
								key={lane.laneNo}
								data-lane-deck-slot={lane.laneNo}
								className={[
									// 完整档多流横向滚动时保持各列独立宽度（AC 10）
									tier === 'full' && streamCount > 3 ? 'flex-shrink-0 w-[380px] h-full' : '',
									// 紧凑档展开时占据整行（AC 3, E-165）
									isColumnExpanded ? 'col-span-full' : '',
									// 手机模式下未选中泳道隐藏
									isHiddenOnMobile ? 'hidden' : 'flex flex-col h-full min-h-[360px]',
								]
									.filter(Boolean)
									.join(' ')}
							>
								{/* 单流 ErrorBoundary 隔离保护（07 节） */}
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
										onStop={() => handleStopLane(lane.laneNo, lane.currentRunId)}
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

				{/* AC 10 & E-167: 完整档横向滚动时右侧视野外「要你」计数常驻标记 */}
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
		</section>
	);
}
