/**
 * packages/web/src/features/run-deck/lanes-container.tsx
 *
 * 流水线泳道甲板容器（M9-T21 / AC 1, AC 7b, AC 8, AC 9, E-106, E-145, E-164, E-324, E-333 / 07 节前端架构）
 *
 * 规范依据：
 * - 容器层只组织布局排布，只许写 grid/flex/gap，禁止写颜色字号圆角（07 节）
 * - 泳道数与顺序只来自 lanes[]，前端不算槽位、不算下一个任务、不推断阶段（AC 1, E-317）
 * - 快照缺 lanes 键或不是数组 → 运行甲板显示「泳道数据不可用」，按 E-26 不自算槽位（E-333）
 * - 手机档一次只看一条泳道，顶部 44px lane-run-strip ◀ ▶ 切换（AC 9, E-324）
 * - 停止键与审批槽位常驻渲染在所有分支之外（AC 8, E-236）
 */

import { PIPELINE_STAGES } from '@agent-scheduler/shared/api/lanes';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import { type HTMLAttributes, type ReactNode, useMemo } from 'react';
import { LaneRunStrip } from '../../components/lane-run-strip.tsx';
import { PipelineLane } from '../../components/pipeline-lane.tsx';
import { type DensityTier, useDensityTier } from '../../hooks/use-breakpoint.ts';
import { isLaneIdle, isLaneWrapup } from '../../lib/stage-rows.ts';
import { useLanes } from './use-lanes.ts';

export interface LanesContainerProps extends HTMLAttributes<HTMLDivElement> {
	/** 文档 ID */
	readonly docId?: string | null;
	/** 全部任务清单（用于匹配 taskId 得到任务对象） */
	readonly tasks?: readonly TaskDto[];
	/** 全部运行清单（用于提取当前与历史运行） */
	readonly runs?: readonly RunDto[];
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
}

export function LanesContainer({
	docId,
	tasks = [],
	runs = [],
	onOpenRun,
	onStopLane,
	stoppingLanes,
	overrideTier,
	renderApprovalSlot,
	className,
	...rest
}: LanesContainerProps) {
	const {
		lanes,
		isUnavailable,
		errorMessage,
		mobileLaneNo,
		currentMobileLane,
		prevMobileLane,
		nextMobileLane,
		expandedLaneNo,
		toggleExpandLane,
	} = useLanes({ docId });

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

	// 手机档：一次一条泳道 + 顶部 44px lane-run-strip ◀ ▶ 切换（AC 9, E-324）
	if (isMobile) {
		const lane = currentMobileLane;
		const task = lane?.taskId ? tasksById.get(lane.taskId) : null;
		const taskRuns = lane?.taskId ? (runsByTaskId.get(lane.taskId) ?? []) : [];
		const historyTaskId = lane?.archivedTaskIds?.[0];
		const historyTask = historyTaskId ? tasksById.get(historyTaskId) : null;
		const historyRuns = historyTaskId ? (runsByTaskId.get(historyTaskId) ?? []) : [];
		const historyWrapupRun = lane?.archivedWrapupRunId
			? runsById.get(lane.archivedWrapupRunId)
			: null;

		const currentRun = taskRuns.find((r) => r.id === lane?.currentRunId);
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
				{/* 顶部 44px 运行条（AC 9, E-324） */}
				<LaneRunStrip
					currentIndex={lane?.laneNo ?? mobileLaneNo}
					totalLanes={lanes.length}
					taskKey={task?.taskKey}
					title={task?.title}
					status={status}
					isIdle={isLaneIdle(lane?.stage)}
					isWrapup={isLaneWrapup(lane?.stage)}
					onPrev={prevMobileLane}
					onNext={nextMobileLane}
				/>

				{/* 当前单一泳道 */}
				<div className="flex-1 min-h-0 overflow-y-auto">
					{lane && (
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
						/>
					)}
				</div>
			</div>
		);
	}

	// 桌面档：多流并置换行网格，绝不横向滚动（E-106, E-145, E-164）
	return (
		<div
			data-container="lanes-deck"
			data-mode="desktop"
			className={[
				'flex flex-row flex-wrap gap-4 w-full min-h-0 flex-1 overflow-y-auto items-stretch p-2',
				className ?? '',
			].join(' ')}
			{...rest}
		>
			{lanes.map((lane) => {
				const task = lane.taskId ? tasksById.get(lane.taskId) : null;
				const taskRuns = lane.taskId ? (runsByTaskId.get(lane.taskId) ?? []) : [];
				const historyTaskId = lane.archivedTaskIds?.[0];
				const historyTask = historyTaskId ? tasksById.get(historyTaskId) : null;
				const historyRuns = historyTaskId ? (runsByTaskId.get(historyTaskId) ?? []) : [];
				const historyWrapupRun = lane.archivedWrapupRunId
					? runsById.get(lane.archivedWrapupRunId)
					: null;

				return (
					<PipelineLane
						key={lane.laneNo}
						lane={lane}
						task={task}
						runs={taskRuns}
						stageOrder={PIPELINE_STAGES}
						tier={tier}
						isTouch={isTouch}
						isExpanded={expandedLaneNo === lane.laneNo}
						onToggleExpand={() => toggleExpandLane(lane.laneNo)}
						onStop={() => onStopLane?.(lane.laneNo, lane.currentRunId)}
						isStopping={stoppingLanes?.has(lane.laneNo)}
						onOpenRun={onOpenRun}
						approvalSlot={renderApprovalSlot?.(lane.laneNo, lane.taskId)}
						historyTask={historyTask}
						historyRuns={historyRuns}
						historyWrapupRun={historyWrapupRun}
					/>
				);
			})}
		</div>
	);
}
