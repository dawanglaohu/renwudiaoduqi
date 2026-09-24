/**
 * packages/web/src/features/run-deck/lanes-container.tsx
 *
 * 流水线泳道甲板容器（M9-T21 / AC 1, AC 2, AC 7b, AC 8, AC 9, E-106, E-145, E-164, E-315, E-324, E-325, E-333 / 07 节前端架构）
 *
 * 规范依据：
 * - 容器层只组织布局排布，只许写 grid/flex/gap，禁止写颜色字号圆角（07 节）
 * - 泳道数与顺序只来自 lanes[]，前端不算槽位、不算下一个任务、不推断阶段（AC 1, E-317）
 * - 快照缺 lanes 键或不是数组 → 运行甲板显示「泳道数据不可用」，按 E-26 不自算槽位（E-333）
 * - 手机档一次只看一条泳道，顶部 44px lane-run-strip ◀ ▶ 切换，按排序位置导航（AC 9, E-324, R3）
 * - 停止键与审批槽位常驻渲染在所有分支之外（AC 8, E-236）
 * - 绑定当前及历史运行至实际 run ID 与泳道归属，同任务换道重派不混淆历史（R2, E-325）
 * - 把当前运行的事件步骤传给 LaneStepsContainer，紧凑档只显示最后一步、展开后显示全部（R1, AC 2, E-315）
 */

import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { type LaneView, PIPELINE_STAGES } from '@agent-scheduler/shared/api/lanes';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import { Component, type ErrorInfo, type HTMLAttributes, type ReactNode, useMemo } from 'react';
import { useRunStreamBuffer } from '../../api/event-bus.ts';
import { LaneRunStrip } from '../../components/lane-run-strip.tsx';
import { PipelineLane } from '../../components/pipeline-lane.tsx';
import { type DensityTier, useDensityTier } from '../../hooks/use-breakpoint.ts';
import type { StatusState } from '../../lib/spine-shape.ts';
import {
	type StageRow,
	findLatestRun,
	getRunTimestamp,
	isLaneIdle,
	isLaneWrapup,
} from '../../lib/stage-rows.ts';
import { type LaneStepItem, LaneStepsContainer } from './lane-steps-container.tsx';
import type { DeckStreamLane } from './types.ts';
import { useLanes } from './use-lanes.ts';

/**
 * 单流异常隔离边界（07 节：每条运行流一个 ErrorBoundary，一条流崩了不许带走另外四条）。
 */
export interface StreamErrorBoundaryProps {
	readonly laneNo: number;
	readonly children: ReactNode;
}

export interface StreamErrorBoundaryState {
	readonly hasError: boolean;
	readonly errorMessage?: string;
}

export class StreamErrorBoundary extends Component<
	StreamErrorBoundaryProps,
	StreamErrorBoundaryState
> {
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
 * 将 run scope 事件流映射为展示步骤列表（R1, AC 2, E-315）。
 */
export function mapEventsToLaneSteps(events: readonly EventEnvelope[]): readonly LaneStepItem[] {
	const steps: LaneStepItem[] = [];
	for (let i = 0; i < events.length; i++) {
		const ev = events[i];
		if (!ev) continue;
		const rawEv = ev as unknown as { id?: number | string; eventId?: string; payload?: unknown };
		const p = (rawEv.payload ?? {}) as Record<string, unknown>;
		const stepId = String(rawEv.id ?? rawEv.eventId ?? `step-${i}`);

		if (ev.kind === 'tool_call' || ev.kind === 'tool_call_update') {
			const tool =
				typeof p.tool === 'string' ? p.tool : typeof p.name === 'string' ? p.name : 'tool';
			const target =
				typeof p.target === 'string'
					? p.target
					: typeof p.callId === 'string'
						? p.callId
						: undefined;
			const isError = Boolean(p.isError || p.status === 'failed');
			const status = isError ? 'failed' : ((p.status as StatusState) ?? 'succeeded');
			steps.push({
				id: stepId,
				tool,
				target,
				status,
				duration: typeof p.durationMs === 'number' ? p.durationMs : undefined,
				isFailed: isError,
				errorMessage: typeof p.errorMessage === 'string' ? p.errorMessage : undefined,
				detail: typeof p.detail === 'string' ? p.detail : undefined,
				payload: p,
			});
		} else if (ev.kind === 'agent_thought_chunk') {
			steps.push({
				id: stepId,
				tool: 'think',
				status: 'running',
				detail: typeof p.chunk === 'string' ? p.chunk : undefined,
			});
		} else if (ev.kind === 'plan') {
			steps.push({
				id: stepId,
				tool: 'plan',
				target: typeof p.title === 'string' ? p.title : undefined,
				status: 'succeeded',
				payload: p,
			});
		}
	}
	return steps;
}

/**
 * 泳道阶段步骤实时容器包装（连接 event-bus 与 LaneStepsContainer，R1）。
 */
function LaneStageSteps({
	runId,
	stageRow,
	tier,
	isExpanded,
	isTouch,
	steps: explicitSteps,
}: {
	readonly runId?: string | null;
	readonly stageRow: StageRow;
	readonly tier?: DensityTier;
	readonly isExpanded?: boolean;
	readonly isTouch?: boolean;
	readonly steps?: readonly LaneStepItem[];
}) {
	const stream = useRunStreamBuffer(runId ?? '');
	const events = stream.items;

	const derivedSteps = useMemo(() => {
		if (explicitSteps && explicitSteps.length > 0) return explicitSteps;
		if (!runId || events.length === 0) return [];
		return mapEventsToLaneSteps(events);
	}, [explicitSteps, runId, events]);

	return (
		<LaneStepsContainer
			stageRow={stageRow}
			steps={derivedSteps}
			tier={tier}
			isExpanded={isExpanded}
			isTouch={isTouch}
		/>
	);
}

export interface LaneContainerItem extends LaneView {
	readonly taskKey?: string;
	readonly title?: string;
	readonly bodySlot?: ReactNode;
}

export interface LanesContainerProps extends HTMLAttributes<HTMLDivElement> {
	/** 文档 ID */
	readonly docId?: string | null;
	/** 外部直接传入的泳道列表（可选，若提供则优先使用外部泳道） */
	readonly lanes?: readonly (LaneView | DeckStreamLane)[];
	/** 全部任务清单（用于匹配 taskId 得到任务对象） */
	readonly tasks?: readonly TaskDto[];
	/** 全部运行清单（用于提取当前与历史运行） */
	readonly runs?: readonly RunDto[];
	/** 是否处于不可用态（E-333） */
	readonly isUnavailable?: boolean;
	/** 错误信息 */
	readonly errorMessage?: string | null;
	/** 点击打开运行详情回调（E-313） */
	readonly onOpenRun?: (runId: string) => void;
	/** 停止某条泳道回调 */
	readonly onStopLane?: (laneNo: number, runId?: string | null) => void;
	/** 正在执行停止的泳道号集合 */
	readonly stoppingLanes?: ReadonlySet<number>;
	/** 外部指定的密度档位覆盖 */
	readonly overrideTier?: DensityTier;
	/** 审批槽位生成函数 */
	readonly renderApprovalSlot?: (laneNo: number, taskId?: string | null) => ReactNode;
	/** 获取泳道步骤回调（单测或定制注入，R1） */
	readonly getLaneSteps?: (laneNo: number, runId?: string | null) => readonly LaneStepItem[];
	/** 自定义步骤槽位渲染 */
	readonly renderSteps?: (laneNo: number, stageRow: StageRow, runId?: string | null) => ReactNode;
	/** 外部受控模式：手机当前查看的泳道序号（1-based 序号，k/N 呈现） */
	readonly activeMobileLanePosition?: number;
	/** 外部受控模式：手机当前查看的实际泳道号 */
	readonly activeMobileLaneNo?: number;
	/** 外部受控模式：切换上一条手机泳道 */
	readonly onPrevMobileLane?: () => void;
	/** 外部受控模式：切换下一条手机泳道 */
	readonly onNextMobileLane?: () => void;
	/** 外部受控模式：是否隐藏内置手机顶部运行条（当外部已渲染时） */
	readonly hideMobileRunStrip?: boolean;
	/** 桌面端当前展开的泳道号 */
	readonly expandedLaneNo?: number | null;
	/** 桌面端切换展开泳道回调 */
	readonly onToggleExpandLane?: (laneNo: number) => void;
	/** 滚动容器 ref */
	readonly scrollContainerRef?: React.RefObject<HTMLDivElement>;
	/** 桌面端网格外层 class */
	readonly layoutClassName?: string;
}

export function LanesContainer({
	docId,
	lanes: propLanes,
	tasks = [],
	runs = [],
	isUnavailable: propIsUnavailable,
	errorMessage: propErrorMessage,
	onOpenRun,
	onStopLane,
	stoppingLanes,
	overrideTier,
	renderApprovalSlot,
	getLaneSteps,
	renderSteps,
	activeMobileLanePosition: propActiveMobileLanePosition,
	activeMobileLaneNo: propActiveMobileLaneNo,
	onPrevMobileLane,
	onNextMobileLane,
	hideMobileRunStrip,
	expandedLaneNo: propExpandedLaneNo,
	onToggleExpandLane,
	scrollContainerRef,
	layoutClassName,
	className,
	...rest
}: LanesContainerProps) {
	const internalLanes = useLanes({ docId });

	const hasPropLanes = propLanes !== undefined;
	const isUnavailable = propIsUnavailable ?? (!hasPropLanes && internalLanes.isUnavailable);
	const errorMessage = propErrorMessage ?? (!hasPropLanes ? internalLanes.errorMessage : null);

	// 归一化为 LaneContainerItem 列表
	const lanes: readonly LaneContainerItem[] = useMemo(() => {
		const raw = hasPropLanes ? propLanes : internalLanes.lanes;
		const sorted = [...raw].sort((a, b) => a.laneNo - b.laneNo);
		return sorted.map((l) => {
			if ('stage' in l && l.stage) {
				return l as LaneContainerItem;
			}
			const streamLane = l as DeckStreamLane;
			return {
				laneNo: streamLane.laneNo,
				stage:
					streamLane.kind === 'wrapup'
						? 'wrapup'
						: streamLane.kind === 'idle'
							? 'idle'
							: 'executing',
				taskId: streamLane.taskId,
				currentRunId: streamLane.currentRunId,
				archivedTaskIds: streamLane.archivedTaskIds,
				archivedWrapupRunId: streamLane.archivedWrapupRunId,
				taskKey: streamLane.taskKey,
				title: streamLane.title,
				bodySlot: streamLane.bodySlot,
			} as LaneContainerItem;
		});
	}, [hasPropLanes, propLanes, internalLanes.lanes]);

	const { tier: computedTier, isTouch } = useDensityTier({ streamCount: lanes.length });
	const tier = overrideTier ?? computedTier;

	// 任务索引字典
	const tasksById = useMemo(() => {
		const map = new Map<string, TaskDto>();
		for (const t of tasks) {
			map.set(t.id, t);
		}
		return map;
	}, [tasks]);

	// 运行索引字典（按 taskId 归类）
	const runsByTaskId = useMemo(() => {
		const map = new Map<string, RunDto[]>();
		for (const r of runs) {
			if (r.taskId) {
				const list = map.get(r.taskId) ?? [];
				list.push(r);
				map.set(r.taskId, list);
			}
		}
		return map;
	}, [runs]);

	// 收口运行字典（按 runId）
	const runsById = useMemo(() => {
		const map = new Map<string, RunDto>();
		for (const r of runs) {
			map.set(r.id, r);
		}
		return map;
	}, [runs]);

	// 提取指定泳道当前活动运行（R2, E-317）
	const getActiveRunsForLane = (lane: LaneView): readonly RunDto[] => {
		if (!lane.taskId) {
			if (lane.currentRunId) {
				const r = runsById.get(lane.currentRunId);
				return r ? [r] : [];
			}
			return [];
		}
		const allTaskRuns = runsByTaskId.get(lane.taskId) ?? [];
		return allTaskRuns
			.filter((r) => {
				if (
					typeof r.laneNo === 'number' &&
					r.laneNo !== lane.laneNo &&
					r.id !== lane.currentRunId
				) {
					return false;
				}
				return true;
			})
			.sort((a, b) => getRunTimestamp(a) - getRunTimestamp(b));
	};

	// 提取指定泳道历史归档运行（R2, E-325）
	const getHistoryRunsForLane = (
		lane: LaneView,
		historyWrapupRun: RunDto | null,
	): readonly RunDto[] => {
		if (lane.archivedWrapupRunId) {
			return historyWrapupRun ? [historyWrapupRun] : [];
		}
		const historyTaskId = lane.archivedTaskIds?.[0];
		if (!historyTaskId) return [];

		const allHistoryRuns = runsByTaskId.get(historyTaskId) ?? [];
		return allHistoryRuns
			.filter((r) => {
				if (typeof r.laneNo === 'number' && r.laneNo !== lane.laneNo) {
					return false;
				}
				return true;
			})
			.sort((a, b) => getRunTimestamp(a) - getRunTimestamp(b));
	};

	// E-333: 快照缺 lanes 键或不是数组 → 运行甲板显示「泳道数据不可用」
	if (isUnavailable) {
		return (
			<div
				data-container="lanes-deck"
				data-state="unavailable"
				className={[
					'flex items-center justify-center p-8 w-full min-h-[200px]',
					className ?? '',
				].join(' ')}
				{...rest}
			>
				<div data-field="lanes-unavailable" className="flex flex-col items-center gap-2">
					<span className="font-ui text-[14px] text-[var(--down)]">
						{errorMessage ?? '泳道数据不可用'}
					</span>
				</div>
			</div>
		);
	}

	const isMobile = tier === 'phone' || tier === 'phone-xs';

	// 手机档：一次一条泳道 + 顶部 44px lane-run-strip ◀ ▶ 切换（AC 9, E-324, R3）
	if (isMobile) {
		const currentLanePosition = propActiveMobileLanePosition ?? internalLanes.currentLanePosition;
		const currentMobileLane: LaneContainerItem | undefined =
			(propActiveMobileLaneNo !== undefined
				? lanes.find((l) => l.laneNo === propActiveMobileLaneNo)
				: undefined) ??
			lanes[currentLanePosition - 1] ??
			lanes[0];

		const prevMobileLane = onPrevMobileLane ?? internalLanes.prevMobileLane;
		const nextMobileLane = onNextMobileLane ?? internalLanes.nextMobileLane;

		const lane = currentMobileLane;
		const task = lane?.taskId ? tasksById.get(lane.taskId) : null;
		const taskRuns = lane ? getActiveRunsForLane(lane) : [];
		const historyTaskId = lane?.archivedTaskIds?.[0];
		const historyTask = historyTaskId ? tasksById.get(historyTaskId) : null;
		const historyWrapupRun = lane?.archivedWrapupRunId
			? (runsById.get(lane.archivedWrapupRunId) ?? null)
			: null;
		const historyRuns = lane ? getHistoryRunsForLane(lane, historyWrapupRun) : [];

		const currentRun = taskRuns.find((r) => r.id === lane?.currentRunId) ?? findLatestRun(taskRuns);
		const status = currentRun?.state ?? task?.state ?? 'queued';

		return (
			<div
				data-container="lanes-deck"
				data-mode="mobile"
				className={['flex flex-col w-full min-h-0 flex-1 overflow-hidden', className ?? ''].join(
					' ',
				)}
				{...rest}
			>
				{/* 顶部 44px 运行条（AC 9, E-324, R3：使用 1-based 位置序号与总现存泳道数） */}
				{!hideMobileRunStrip && (
					<LaneRunStrip
						currentIndex={currentLanePosition}
						totalLanes={lanes.length}
						taskKey={task?.taskKey ?? lane?.taskKey}
						title={task?.title ?? lane?.title}
						status={status}
						isIdle={isLaneIdle(lane?.stage)}
						isWrapup={isLaneWrapup(lane?.stage)}
						onPrev={prevMobileLane}
						onNext={nextMobileLane}
					/>
				)}

				{/* 当前单一泳道 */}
				<div className="flex-1 min-h-0 overflow-y-auto">
					{lane && (
						<StreamErrorBoundary laneNo={lane.laneNo}>
							<PipelineLane
								key={lane.laneNo}
								lane={lane}
								task={task}
								runs={taskRuns}
								stageOrder={PIPELINE_STAGES}
								tier={tier}
								isTouch={isTouch}
								onStop={() => onStopLane?.(lane.laneNo, lane.currentRunId)}
								isStopping={stoppingLanes?.has(lane.laneNo)}
								onOpenRun={onOpenRun}
								approvalSlot={renderApprovalSlot?.(lane.laneNo, lane.taskId)}
								historyTask={historyTask}
								historyRuns={historyRuns}
								historyWrapupRun={historyWrapupRun}
								bodySlot={lane.bodySlot}
								renderSteps={(stageRow) => {
									if (renderSteps) {
										return renderSteps(lane.laneNo, stageRow, lane.currentRunId);
									}
									const customSteps = getLaneSteps?.(lane.laneNo, lane.currentRunId);
									return (
										<LaneStageSteps
											runId={lane.currentRunId}
											stageRow={stageRow}
											tier={tier}
											isExpanded={true}
											isTouch={isTouch}
											steps={customSteps}
										/>
									);
								}}
							/>
						</StreamErrorBoundary>
					)}
				</div>
			</div>
		);
	}

	const expandedLaneNo =
		propExpandedLaneNo !== undefined ? propExpandedLaneNo : internalLanes.expandedLaneNo;
	const toggleExpandLane = onToggleExpandLane ?? internalLanes.toggleExpandLane;

	// 桌面档：多流并置换行网格，绝不横向滚动（E-106, E-145, E-164）
	return (
		<div
			ref={scrollContainerRef}
			data-container="lanes-deck"
			data-mode="desktop"
			className={[
				layoutClassName ??
					'flex flex-row flex-wrap gap-4 w-full min-h-0 flex-1 overflow-y-auto items-stretch p-2',
				className ?? '',
			].join(' ')}
			{...rest}
		>
			{lanes.map((lane) => {
				const task = lane.taskId ? tasksById.get(lane.taskId) : null;
				const taskRuns = getActiveRunsForLane(lane);
				const historyTaskId = lane.archivedTaskIds?.[0];
				const historyTask = historyTaskId ? tasksById.get(historyTaskId) : null;
				const historyWrapupRun = lane.archivedWrapupRunId
					? (runsById.get(lane.archivedWrapupRunId) ?? null)
					: null;
				const historyRuns = getHistoryRunsForLane(lane, historyWrapupRun);
				const isExpanded = expandedLaneNo === lane.laneNo;

				return (
					<div
						key={lane.laneNo}
						data-lane-deck-slot={lane.laneNo}
						className={[
							tier === 'full' && lanes.length > 3 ? 'flex-shrink-0 w-[380px] h-full' : '',
							isExpanded ? 'col-span-full' : '',
							'flex flex-col h-full min-h-[360px]',
						]
							.filter(Boolean)
							.join(' ')}
					>
						<StreamErrorBoundary laneNo={lane.laneNo}>
							<PipelineLane
								lane={lane}
								task={task}
								runs={taskRuns}
								stageOrder={PIPELINE_STAGES}
								tier={tier}
								isTouch={isTouch}
								isExpanded={isExpanded}
								onToggleExpand={() => toggleExpandLane(lane.laneNo)}
								onStop={() => onStopLane?.(lane.laneNo, lane.currentRunId)}
								isStopping={stoppingLanes?.has(lane.laneNo)}
								onOpenRun={onOpenRun}
								approvalSlot={renderApprovalSlot?.(lane.laneNo, lane.taskId)}
								historyTask={historyTask}
								historyRuns={historyRuns}
								historyWrapupRun={historyWrapupRun}
								bodySlot={lane.bodySlot}
								renderSteps={(stageRow) => {
									if (renderSteps) {
										return renderSteps(lane.laneNo, stageRow, lane.currentRunId);
									}
									const customSteps = getLaneSteps?.(lane.laneNo, lane.currentRunId);
									return (
										<LaneStageSteps
											runId={lane.currentRunId}
											stageRow={stageRow}
											tier={tier}
											isExpanded={isExpanded}
											isTouch={isTouch}
											steps={customSteps}
										/>
									);
								}}
							/>
						</StreamErrorBoundary>
					</div>
				);
			})}
		</div>
	);
}
