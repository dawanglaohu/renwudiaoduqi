/**
 * packages/web/src/features/run-deck/run-deck-container.tsx
 *
 * 运行甲板多流监看与手机单栏容器组件（M9-T9, M9-T12 / 07 节前端架构）
 * 收口泳道与审批卡的真实取数接线（M9-T20 / R1, R3, E-297, E-106, E-117）
 *
 * 规范依据（07 节前端架构与 11 节 UI）：
 * - features 是容器层：唯一允许 import src/api 与订阅 event-bus 的一层；路由按共享表字段取，不写 URL 字面量
 * - 容器里只许写 grid/flex/gap，禁止写颜色字号圆角
 * - **不新造泳道分配算法**：泳道号逐字取 `RunDto.laneNo`（daemon 已下发时），否则按
 *   「开始时间 → 运行 ID」这个稳定只读顺序编号，纯为呈现；真正的泳道分配与 `GET /lanes` 归
 *   M9-T21（E-317、E-333）。这里只是让甲板在 daemon 还没有 lanes 端点时能显示真实运行
 * - 收口运行（`RunDto.kind === 'wrapup'`、无 task_id）与实施运行走同一条泳道外壳（E-297）
 * - 审批卡只在 daemon 真的下发待处理闸门时渲染；能力位取目标运行自己的 `capabilities.canReply`（E-117）
 */

import type { BatchDto, GetBatchWrapupsResponse } from '@agent-scheduler/shared/api/batches';
import type { GateDto, ListGatesResponse } from '@agent-scheduler/shared/api/gates';
import type { LaneView } from '@agent-scheduler/shared/api/lanes';
import { ROUTES, type RouteDefinition } from '@agent-scheduler/shared/api/routes';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import { useCallback, useEffect, useRef, useState } from 'react';
import { eventBus } from '../../api/event-bus.ts';
import { httpClient } from '../../api/http-client.ts';
import { navigateTo } from '../../app/routes.tsx';
import type { BatchTreeItem } from '../../components/batch-tree.tsx';
import { mapSnapshotToBatches } from './batch-expansion.ts';
import { RunDeckView } from './run-deck-view.tsx';
import type { DeckStreamLane, RunDeckProps } from './types.ts';
import { useRunDeck } from './use-run-deck.ts';
import { startBatchWrapup, useBatchWrapupOverview } from './wrapup-panel-container.tsx';

/** 按共享路由表自身的字段取路由定义（R5）：不重复写 URL 字面量。 */
function findRouteByTypes(
	method: 'GET' | 'POST',
	types: { readonly resType?: string; readonly reqType?: string },
): RouteDefinition {
	const route = ROUTES.find(
		(entry) =>
			entry.method === method &&
			(types.resType === undefined || entry.resType === types.resType) &&
			(types.reqType === undefined || entry.reqType === types.reqType),
	);
	if (!route) {
		throw new Error(
			`${method} route with ${JSON.stringify(types)} is missing from the shared ROUTES table`,
		);
	}
	return route;
}

const SNAPSHOT_ROUTE = findRouteByTypes('GET', { resType: 'SnapshotResponse' });
const RUNS_ROUTE = findRouteByTypes('GET', { resType: 'ListRunsResponse' });
const GATES_ROUTE = findRouteByTypes('GET', { resType: 'ListGatesResponse' });
const BATCH_WRAPUPS_ROUTE = findRouteByTypes('GET', { resType: 'GetBatchWrapupsResponse' });
const DECIDE_GATE_ROUTE = findRouteByTypes('POST', { reqType: 'DecideGateBody' });

/** 收口报告面板取数实现（单测注入）。 */
export type DeckWrapupsFetcher = (batchId: string) => Promise<GetBatchWrapupsResponse>;

export interface BuildDeckLanesInput {
	/**
	 * daemon 算出的泳道列表（M8-T8 / E-317）。**泳道分配只有这一个来源**：
	 * 前端不重排、不补号、不合并，`laneNo` 逐字取 `LaneView.laneNo`。
	 */
	readonly lanes: readonly LaneView[];
	/** 运行行（取 `GET /runs` 的那一份：快照里的运行没有 capabilities） */
	readonly runs?: readonly RunDto[];
	readonly tasks?: readonly TaskDto[];
	readonly batches?: readonly BatchDto[];
	readonly gates?: readonly GateDto[];
	/** runId → 收口轮次（来自 daemon 的收口记录或 batch.wrapup_* 事件 payload） */
	readonly wrapupRoundByRunId?: ReadonlyMap<string, number>;
}

/**
 * 把 daemon 的泳道列表映射成甲板泳道（纯函数，便于机检）。
 *
 * 逐字消费 daemon 字段：泳道号取 `LaneView.laneNo`，收口泳道由 `LaneView.stage === 'wrapup'` 判定，
 * 任务号与标题取 `TaskDto`，批次序号取 `BatchDto`，收口轮次取 `wrapupRoundByRunId`，
 * 能力位取**目标实施运行**自己的 `capabilities.canReply`。缺失一律留 null，由呈现层显示「—」。
 */
export function buildDeckLanes(input: BuildDeckLanesInput): readonly DeckStreamLane[] {
	const { lanes, runs = [], tasks = [], batches = [], gates = [], wrapupRoundByRunId } = input;

	const taskById = new Map(tasks.map((task) => [task.id, task]));
	const batchById = new Map(batches.map((batch) => [batch.id, batch]));
	const runById = new Map(runs.map((run) => [run.id, run]));
	const latestReviewByParent = new Map<string, RunDto>();
	for (const candidate of runs) {
		if (candidate.kind !== 'review' || !candidate.parentRunId) continue;
		const previous = latestReviewByParent.get(candidate.parentRunId);
		if (!previous || candidate.attemptNo > previous.attemptNo) {
			latestReviewByParent.set(candidate.parentRunId, candidate);
		}
	}
	const gateByRunId = new Map<string, GateDto>();
	for (const gate of gates) {
		if (
			gate.runId &&
			gate.kind === 'review' &&
			gate.state === 'waiting' &&
			!gateByRunId.has(gate.runId)
		) {
			gateByRunId.set(gate.runId, gate);
		}
	}

	return lanes.map((lane) => {
		const run = lane.currentRunId ? (runById.get(lane.currentRunId) ?? null) : null;
		const task = lane.taskId ? (taskById.get(lane.taskId) ?? null) : null;
		const batchId = task?.batchId ?? run?.batchId ?? null;
		const batch = batchId ? (batchById.get(batchId) ?? null) : null;
		// daemon 的泳道在审查行退出后会回指实施行；原文仍在最新审查行上。
		const reviewRun =
			run?.kind === 'review' ? run : run ? (latestReviewByParent.get(run.id) ?? null) : null;
		const targetRun = reviewRun?.parentRunId ? (runById.get(reviewRun.parentRunId) ?? null) : null;

		return Object.freeze({
			laneNo: lane.laneNo,
			id: `lane-${lane.laneNo}`,
			kind:
				lane.stage === 'wrapup' ? ('wrapup' as const) : run ? ('task' as const) : ('idle' as const),
			currentRunId: lane.currentRunId,
			taskId: lane.taskId ?? undefined,
			taskKey: task?.taskKey,
			title: task?.title,
			status: run?.state,
			batchId,
			wrapupRound: run ? (wrapupRoundByRunId?.get(run.id) ?? null) : null,
			wrapupBatchNo: batch?.batchNo ?? null,
			gateId: run
				? (gateByRunId.get(run.id)?.id ?? gateByRunId.get(reviewRun?.id ?? '')?.id ?? null)
				: null,
			deliverTargetRunId: targetRun?.id ?? null,
			deliverTargetCanReply: targetRun?.capabilities?.canReply ?? null,
			reworkText: reviewRun?.reworkText ?? null,
			reviewVerdict: reviewRun?.reviewVerdict ?? null,
			agentName: run?.agentId,
			modelName: run?.modelName ?? undefined,
			needsApproval: run?.state === 'awaiting_human',
		} satisfies DeckStreamLane);
	});
}

interface RemoteDeckData {
	readonly lanes: readonly DeckStreamLane[];
	readonly batches: readonly BatchTreeItem[];
	readonly error: string | null;
}

const INITIAL_REMOTE: RemoteDeckData = Object.freeze({
	lanes: Object.freeze([]) as readonly DeckStreamLane[],
	batches: Object.freeze([]) as readonly BatchTreeItem[],
	error: null,
});

export function RunDeckContainer(props: RunDeckProps) {
	const deckState = useRunDeck(props);
	const { pendingBatchId, pendingBatchIds, failureByBatch } = useBatchWrapupOverview();

	const [remote, setRemote] = useState<RemoteDeckData>(INITIAL_REMOTE);
	const hasLocalLanes = props.lanes.length > 0;
	const hasLocalBatches = Boolean(props.batches && props.batches.length > 0);
	const wrapupRoundsRef = useRef<Map<string, number>>(new Map());

	const load = useCallback(async () => {
		try {
			const [snapshot, runsResponse, gatesResponse] = await Promise.all([
				httpClient.callRoute<SnapshotResponse>(SNAPSHOT_ROUTE),
				httpClient.callRoute<{ runs: readonly RunDto[] }>(RUNS_ROUTE),
				httpClient.callRoute<ListGatesResponse>(GATES_ROUTE),
			]);
			// 完成的收口运行已离开活动泳道；从 daemon 持久记录恢复轮次，刷新后批次树仍有报告入口。
			const wrapupBatchIds = [
				...new Set(
					runsResponse.runs
						.filter(
							(run) => run.kind === 'wrapup' && run.batchId && !wrapupRoundsRef.current.has(run.id),
						)
						.map((run) => run.batchId as string),
				),
			];
			await Promise.allSettled(
				wrapupBatchIds.map(async (batchId) => {
					const response = await httpClient.callRoute<GetBatchWrapupsResponse>(
						BATCH_WRAPUPS_ROUTE,
						{ params: { batchId } },
					);
					for (const wrapup of response.wrapups)
						wrapupRoundsRef.current.set(wrapup.runId, wrapup.round);
				}),
			);
			setRemote({
				lanes: buildDeckLanes({
					// 泳道列表只有 daemon 这一个来源（M8-T8 / E-317）；没有它就渲染空甲板而不自己分泳道
					lanes: snapshot.lanes ?? [],
					// 快照里的运行没有 capabilities，能力位取 GET /runs 的那一份（E-117）
					runs: runsResponse.runs,
					tasks: snapshot.tasks,
					batches: snapshot.batches,
					gates: gatesResponse.gates,
					wrapupRoundByRunId: wrapupRoundsRef.current,
				}),
				batches: mapSnapshotToBatches(snapshot, wrapupRoundsRef.current, runsResponse.runs),
				error: null,
			});
		} catch (cause: unknown) {
			setRemote({
				lanes: Object.freeze([]) as readonly DeckStreamLane[],
				batches: Object.freeze([]) as readonly BatchTreeItem[],
				error: cause instanceof Error ? cause.message : String(cause),
			});
		}
	}, []);

	// 首屏取数；之后只在运行/批次事件到达时重取（07 节：失效由事件驱动，禁止轮询）
	useEffect(() => {
		if (hasLocalLanes && hasLocalBatches) return;
		void load();
		const unsubscribe = eventBus.subscribeMilestone((envelope) => {
			if (envelope.kind === 'batch.wrapup_started') {
				const payload = envelope.payload as { runId?: string; round?: number } | undefined;
				if (payload?.runId && typeof payload.round === 'number') {
					wrapupRoundsRef.current.set(payload.runId, payload.round);
				}
				void load();
				return;
			}
			if (
				envelope.kind === 'run.started' ||
				envelope.kind === 'run.state_changed' ||
				envelope.kind === 'run.exited' ||
				envelope.kind === 'task.gate_waiting' ||
				envelope.kind === 'task.gate_passed' ||
				envelope.kind === 'batch.wrapup_finished'
			) {
				void load();
			}
		});
		return unsubscribe;
	}, [hasLocalLanes, hasLocalBatches, load]);

	/** 闸门裁定：走 POST /gates/:gateId/decide，界面状态一律等回流事件（E-157）。 */
	const decideGate = useCallback(
		async (gateId: string, decision: 'pass' | 'reject', comment?: string) => {
			await httpClient.callRoute(DECIDE_GATE_ROUTE, {
				params: { gateId },
				body: { decision, comment },
			});
			await load();
		},
		[load],
	);

	/**
	 * 收口按钮的默认动作：POST /batches/:id/wrapup（只判接受，状态等回流事件，E-157）。
	 * 收口运行行的默认动作是跳到该运行详情。
	 */
	const startWrapup = useCallback((batchId: string) => {
		void startBatchWrapup(batchId);
	}, []);

	const openWrapupRun = useCallback((runId: string) => {
		navigateTo(`#/run/${runId}`);
	}, []);

	const lanes = hasLocalLanes ? props.lanes : remote.lanes;
	const batches = hasLocalBatches ? (props.batches as readonly BatchTreeItem[]) : remote.batches;

	return (
		<div data-component="run-deck-container" className="flex flex-col h-full w-full gap-2">
			<RunDeckView
				{...deckState}
				lanes={lanes}
				batches={batches}
				onSelectTask={props.onSelectTask}
				toolbarSlot={props.toolbarSlot}
				className={props.className}
				onWrapup={props.onWrapup ?? startWrapup}
				onOpenWrapupRun={props.onOpenWrapupRun ?? openWrapupRun}
				wrapupPendingBatchId={props.wrapupPendingBatchId ?? pendingBatchId}
				wrapupPendingBatchIds={props.wrapupPendingBatchIds ?? pendingBatchIds}
				wrapupFailureByBatch={props.wrapupFailureByBatch ?? failureByBatch}
				onDecideGate={props.onDecideGate ?? decideGate}
			/>
		</div>
	);
}
