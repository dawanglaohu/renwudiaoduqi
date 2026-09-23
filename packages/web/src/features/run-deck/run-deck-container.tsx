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
const DECIDE_GATE_ROUTE = findRouteByTypes('POST', { reqType: 'DecideGateBody' });

/** 占一条泳道的运行状态：非终态的运行才在甲板上跑（M9-T21 的「会话已归档」历史行另算）。 */
export const ACTIVE_LANE_RUN_STATES = [
	'queued',
	'starting',
	'running',
	'awaiting_reply',
	'exited',
	'reviewing',
	'reworking',
	'awaiting_human',
	'orphaned',
	'failed',
] as const;

/** 收口报告面板取数实现（单测注入）。 */
export type DeckWrapupsFetcher = (batchId: string) => Promise<GetBatchWrapupsResponse>;

export interface BuildDeckLanesInput {
	readonly runs: readonly RunDto[];
	readonly tasks?: readonly TaskDto[];
	readonly batches?: readonly BatchDto[];
	readonly gates?: readonly GateDto[];
	/** runId → 收口轮次（来自 daemon 的收口记录或 batch.wrapup_* 事件 payload） */
	readonly wrapupRoundByRunId?: ReadonlyMap<string, number>;
}

/** 泳道呈现顺序：daemon 给了 laneNo 就照它排，否则按开始时间 → 运行 ID 稳定排序。 */
function compareLanes(a: RunDto, b: RunDto): number {
	const laneA = typeof a.laneNo === 'number' ? a.laneNo : Number.POSITIVE_INFINITY;
	const laneB = typeof b.laneNo === 'number' ? b.laneNo : Number.POSITIVE_INFINITY;
	if (laneA !== laneB) {
		return laneA - laneB;
	}
	const startedA = a.startedAt ?? '';
	const startedB = b.startedAt ?? '';
	if (startedA !== startedB) {
		return startedA < startedB ? -1 : 1;
	}
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 由 daemon 的 snapshot / runs / gates 拼出泳道数组（纯函数，便于机检）。
 *
 * 逐字消费 daemon 字段：`kind` 取 `RunDto.kind`，任务号与标题取 `TaskDto`，批次序号取 `BatchDto`，
 * 收口轮次取 `wrapupRoundByRunId`（daemon 的收口记录或事件 payload），能力位取目标运行自己的
 * `capabilities.canReply`。缺失一律留 null，由呈现层显示「—」。
 */
export function buildDeckLanes(input: BuildDeckLanesInput): readonly DeckStreamLane[] {
	const { runs, tasks = [], batches = [], gates = [], wrapupRoundByRunId } = input;

	const taskById = new Map(tasks.map((task) => [task.id, task]));
	const batchById = new Map(batches.map((batch) => [batch.id, batch]));
	const runById = new Map(runs.map((run) => [run.id, run]));
	const gateByRunId = new Map<string, GateDto>();
	for (const gate of gates) {
		if (gate.runId && gate.state === 'waiting' && !gateByRunId.has(gate.runId)) {
			gateByRunId.set(gate.runId, gate);
		}
	}

	const active = runs
		.filter((run) => (ACTIVE_LANE_RUN_STATES as readonly string[]).includes(run.state))
		.sort(compareLanes);

	return active.map((run, index) => {
		const task = run.taskId ? (taskById.get(run.taskId) ?? null) : null;
		const batch = run.batchId ? (batchById.get(run.batchId) ?? null) : null;
		// 审查留「未结构化」时，原文要投回被审的实施会话（E-278）
		const targetRun = run.parentRunId ? (runById.get(run.parentRunId) ?? null) : null;
		const isWrapup = run.kind === 'wrapup';

		return Object.freeze({
			laneNo: index + 1,
			id: `lane-${run.id}`,
			kind: isWrapup ? ('wrapup' as const) : ('task' as const),
			currentRunId: run.id,
			taskId: run.taskId ?? undefined,
			taskKey: task?.taskKey ?? undefined,
			title: task?.title ?? undefined,
			status: run.state,
			batchId: run.batchId ?? null,
			wrapupRound: wrapupRoundByRunId?.get(run.id) ?? null,
			wrapupBatchNo: batch?.batchNo ?? null,
			gateId: gateByRunId.get(run.id)?.id ?? null,
			deliverTargetRunId: run.parentRunId ?? null,
			deliverTargetCanReply: targetRun?.capabilities?.canReply ?? null,
			reworkText: run.reworkText ?? null,
			reviewVerdict: run.reviewVerdict ?? null,
			agentName: run.agentId,
			modelName: run.modelName ?? undefined,
			needsApproval: run.state === 'awaiting_human',
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
	const { pendingBatchId, failureByBatch } = useBatchWrapupOverview();

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
			setRemote({
				lanes: buildDeckLanes({
					runs: runsResponse.runs,
					tasks: snapshot.tasks,
					batches: snapshot.batches,
					gates: gatesResponse.gates,
					wrapupRoundByRunId: wrapupRoundsRef.current,
				}),
				batches: mapSnapshotToBatches(snapshot),
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
				wrapupFailureByBatch={props.wrapupFailureByBatch ?? failureByBatch}
				onDecideGate={props.onDecideGate ?? decideGate}
			/>
		</div>
	);
}
