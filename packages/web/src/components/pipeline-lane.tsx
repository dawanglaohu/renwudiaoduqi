/**
 * packages/web/src/components/pipeline-lane.tsx
 *
 * 单条任务流水线泳道呈现组件（M9-T21 / AC 1..8, E-106, E-166, E-236, E-309, E-313, E-314, E-315, E-319, E-325, E-332 / 11 节 UI）
 *
 * 规范依据：
 * - 纯展示组件（components 纯 props in / callback out），禁止 import api/store/features/shell（07 节）
 * - 泳道数与顺序只来自 lanes[]，前端不算槽位、不算下一个任务、不推断阶段（AC 1, E-317）
 * - 本文件禁止直接比较阶段字面量，一律使用 lib/stage-rows.ts 导出的纯函数（AC 1, E-317）
 * - 历史行只有一条、绑定 archivedTaskIds[0]（收口泳道用 archivedWrapupRunId）（AC 6, E-325）
 * - 泳道第一个任务不渲染历史行与分隔线（AC 6, E-314, E-325）
 * - 空闲泳道渲染 idleText（含 nextBlockedBy），不画假链，停止键置灰保持原位（AC 7, E-319）
 * - overLimit 泳道头部 chip「超出窗口数」（AC 7, E-309）
 * - 停止键与审批槽位只在 stream-column.tsx 里、所有 kind / densityTier 分支之外渲染（AC 8, E-106, E-236）
 */

import type { LaneView, PipelineStage } from '@agent-scheduler/shared/api/lanes';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import type { HTMLAttributes, ReactNode } from 'react';
import type { DensityTier } from '../hooks/use-breakpoint.ts';
import {
	type StageRow,
	deriveStageRows,
	formatIdleText,
	getLaneKind,
	getRunDurationMs,
} from '../lib/stage-rows.ts';
import { LaneHistoryRow } from './lane-history-row.tsx';
import { StageChain } from './stage-chain.tsx';
import { StreamColumn } from './stream-column.tsx';

export interface PipelineLaneProps extends HTMLAttributes<HTMLElement> {
	/** 泳道数据对象（来自 daemon lanes[]，E-317） */
	readonly lane: LaneView;
	/** 当前运行任务对象（若当前正在跑任务） */
	readonly task?: TaskDto | null;
	/** 当前任务或收口运行关联的全部 runs */
	readonly runs?: readonly RunDto[];
	/** 核心阶段定义顺序（来自 shared PIPELINE_STAGES，E-332） */
	readonly stageOrder: readonly PipelineStage[];
	/** 密度档位 */
	readonly tier?: DensityTier;
	/** 是否处于粗指针触控环境 */
	readonly isTouch?: boolean;
	/** 是否在紧凑档中展开（E-165） */
	readonly isExpanded?: boolean;
	/** 切换展开状态回调 */
	readonly onToggleExpand?: () => void;
	/** 停止按钮点击回调 */
	readonly onStop?: () => void;
	/** 是否处于停止中（乐观呈现态） */
	readonly isStopping?: boolean;
	/** 是否允许停止操作（空闲时置灰保持原位） */
	readonly canStop?: boolean;
	/** 点击阶段节点打开运行详情回调（E-313） */
	readonly onOpenRun?: (runId: string) => void;
	/** 审批卡槽位内容（AC 8, E-236） */
	readonly approvalSlot?: ReactNode;
	/** 历史任务对象（若本泳道之前跑过任务，绑定 archivedTaskIds[0]） */
	readonly historyTask?: TaskDto | null;
	/** 历史任务关联的 runs 列表 */
	readonly historyRuns?: readonly RunDto[];
	/** 历史收口运行对象（若为收口泳道且之前跑过收口） */
	readonly historyWrapupRun?: RunDto | null;
	/** 收口所属批次序号 */
	readonly wrapupBatchNo?: number | null;
	/** 收口轮次 */
	readonly wrapupRound?: number | null;
	/** 返工轮次 */
	readonly reworkCount?: number;
	/** 自定义渲染步骤槽位 */
	readonly renderSteps?: (stageRow: StageRow) => ReactNode;
	/** 外部自定义类名 */
	readonly className?: string;
}

export function PipelineLane({
	lane,
	task,
	runs = [],
	stageOrder,
	tier,
	isTouch = false,
	isExpanded = false,
	onToggleExpand,
	onStop,
	isStopping = false,
	canStop = true,
	onOpenRun,
	approvalSlot,
	historyTask,
	historyRuns = [],
	historyWrapupRun,
	wrapupBatchNo,
	wrapupRound,
	reworkCount,
	renderSteps,
	className,
	...rest
}: PipelineLaneProps) {
	// 泳道外壳类型：通过 pure helper 判断，不直接比较阶段字面量（AC 1, E-317）
	const kind = getLaneKind(lane.stage);
	const isIdle = kind === 'idle';
	const isWrapup = kind === 'wrapup';

	// 空闲提示文案（AC 7, E-319）
	const idleText = isIdle ? formatIdleText(lane.nextTaskId, lane.nextBlockedBy) : undefined;

	// 历史行判定（AC 6, E-325）：
	// 历史行只有一条，绑定 archivedTaskIds[0]（收口泳道用 archivedWrapupRunId）
	// 泳道第一个任务不渲染历史行与分隔线（E-314、E-325）
	const hasArchivedTask = Boolean(lane.archivedTaskIds && lane.archivedTaskIds.length > 0);
	const hasArchivedWrapup = Boolean(lane.archivedWrapupRunId);
	const hasHistory = hasArchivedTask || hasArchivedWrapup;

	const taskReworkCount =
		reworkCount ?? runs.find((r) => (r.reworkCount ?? 0) > 0)?.reworkCount ?? 0;
	const historyReworkCount = historyRuns.find((r) => (r.reworkCount ?? 0) > 0)?.reworkCount ?? 0;

	// 衍生历史行的阶段链（若存在历史任务）
	const historyStageRows = hasHistory
		? deriveStageRows({
				currentStage: hasArchivedWrapup ? 'wrapup' : 'landing',
				stageOrder,
				runs: historyRuns,
				reworkCount: historyReworkCount,
				readOnly: true,
				isWrapup: hasArchivedWrapup,
				wrapupRound: historyWrapupRun?.attemptNo ?? 1,
			})
		: [];

	// 衍生当前活动任务的阶段链（空闲时不画假链，AC 7）
	const activeStageRows = !isIdle
		? deriveStageRows({
				currentStage: lane.stage,
				stageOrder,
				runs,
				reworkCount: taskReworkCount,
				readOnly: false,
				isWrapup,
			})
		: [];

	// 耗时与状态提取
	const currentRun = runs.find((r) => r.id === lane.currentRunId) ?? runs[runs.length - 1];
	const laneStatus = currentRun?.state ?? task?.state ?? 'queued';

	return (
		<StreamColumn
			laneNo={lane.laneNo}
			kind={kind}
			laneId={`lane-${lane.laneNo}`}
			currentRunId={lane.currentRunId}
			taskKey={task?.taskKey}
			title={task?.title}
			wrapupRound={isWrapup ? (wrapupRound ?? currentRun?.attemptNo ?? 1) : null}
			wrapupBatchNo={isWrapup ? wrapupBatchNo : null}
			status={laneStatus}
			tier={tier}
			isTouch={isTouch}
			isExpanded={isExpanded}
			onToggleExpand={onToggleExpand}
			onStop={onStop}
			isStopping={isStopping}
			canStop={!isIdle && canStop}
			overLimit={lane.overLimit}
			idleText={idleText}
			duration={currentRun ? getRunDurationMs(currentRun) : null}
			approvalSlot={approvalSlot}
			className={className}
			{...rest}
		>
			<div className="flex flex-col w-full gap-3">
				{/* 历史行（AC 6, E-314, E-325）：仅在非首个任务且存在历史归档时渲染 */}
				{hasHistory && (
					<div data-slot="lane-history" className="flex flex-col w-full">
						<LaneHistoryRow
							taskKey={historyTask?.taskKey}
							title={historyTask?.title}
							status={historyWrapupRun ? 'succeeded' : (historyTask?.state ?? 'succeeded')}
							reworkCount={historyReworkCount}
							duration={historyRuns.reduce((acc, r) => acc + (getRunDurationMs(r) ?? 0), 0)}
							stageRows={historyStageRows}
							onOpenRun={onOpenRun}
							isWrapup={hasArchivedWrapup}
							wrapupRound={historyWrapupRun?.attemptNo ?? 1}
							wrapupBatchNo={wrapupBatchNo}
							isTouch={isTouch}
						/>
						{/* 历史行与活动阶段链之间的分隔线（泳道第一个任务无历史无此线，E-325） */}
						<div
							data-history-divider="true"
							className="w-full my-2 border-b border-[var(--border)] border-dashed"
						/>
					</div>
				)}

				{/* 当前活动阶段链（空闲时不画假链，AC 7） */}
				{!isIdle && (
					<StageChain
						stageRows={activeStageRows}
						onOpenRun={onOpenRun}
						readOnly={false}
						isTouch={isTouch}
						tier={tier}
						isExpanded={isExpanded}
						renderSteps={renderSteps}
					/>
				)}

				{/* 空闲提示（无历史且无任务，或空闲状态展示） */}
				{isIdle && !hasHistory && (
					<div
						data-field="idle-placeholder"
						className="flex items-center justify-center min-h-[80px] text-[13px] text-[var(--ink-3)] font-ui select-none text-center px-2"
					>
						{idleText}
					</div>
				)}
			</div>
		</StreamColumn>
	);
}
