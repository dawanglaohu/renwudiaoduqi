/**
 * packages/web/src/features/run-deck/types.ts
 *
 * 运行甲板多流监看类型定义（M9-T9, M9-T12 / 07 节前端架构与 11 节 UI 规范）
 */

import type { ReactNode } from 'react';
import type { BatchTreeItem } from '../../components/batch-tree.tsx';
import type { BatchWrapupFailureView } from '../../components/wrapup-report.tsx';
import type { DensityTier } from '../../hooks/use-breakpoint.ts';
import type { ToolPayloadSheetData } from '../../hooks/use-payload-sheet.ts';
import type { StatusState } from '../../lib/spine-shape.ts';

export type { ToolPayloadSheetData } from '../../hooks/use-payload-sheet.ts';

/**
 * 手机端单栏切换的栏位定义（E-145）。
 * 走 hash query #/?pane=tasks|stream|detail，不新增路由。
 */
export type MobilePane = 'tasks' | 'stream' | 'detail';

/**
 * 手机端日志/会话首屏加载量限制：尾部 32KB（E-99, AC 5）。
 */
export const MOBILE_INITIAL_TAIL_BYTES = 32 * 1024;

/**
 * 批次可折叠列表中的任务项（E-13）。
 */
export interface MobileBatchTaskItem {
	/** 任务唯一标识 */
	readonly id: string;
	/** 任务代号（如 M9-T12） */
	readonly taskKey: string;
	/** 任务标题 */
	readonly title: string;
	/** 任务运行状态 */
	readonly status?: StatusState | string;
	/** 是否已落地进主干 */
	readonly isLanded?: boolean;
	/** 对应分配的泳道号（若已在道） */
	readonly laneNo?: number;
}

/**
 * 手机端批次折叠列表的分组数据（E-13）。
 */
export interface MobileBatchItem {
	/** 批次编号唯一标识 */
	readonly id: string;
	/** 批次序号（如 1, 2） */
	readonly batchNo: number;
	/** 批次标题/说明 */
	readonly title?: string;
	/** 任务总数 */
	readonly taskCount: number;
	/** 已落地任务数 */
	readonly landedCount: number;
	/** 在跑任务数 */
	readonly runningCount: number;
	/** 等待/等你任务数 */
	readonly waitingCount: number;
	/** 批次下的任务列表 */
	readonly tasks?: readonly MobileBatchTaskItem[];
	/** 是否默认展开 */
	readonly defaultExpanded?: boolean;
}

/**
 * 泳道流数据模型（对应 daemon snapshot 中的 lanes[] 元素，AC 12, E-311, E-317）。
 *
 * M9-T20 补充：收口运行（`RunDto.kind === 'wrapup'`、没有 task_id）占一条普通泳道，
 * `kind` 只换来头部文案与主体内容，停止键/参照条/运行轨槽位的存在性不由它决定（E-297、E-236）。
 */
export interface DeckStreamLane {
	/** 泳道编号（1-based 整数） */
	readonly laneNo: number;
	/** 泳道类型：任务流水线 / 批次收口运行 / 空闲（缺失按 task 呈现） */
	readonly kind?: 'task' | 'wrapup' | 'idle';
	/** 泳道唯一标识（可选） */
	readonly id?: string;
	/** 当前运行 ID（E-311） */
	readonly currentRunId?: string | null;
	/** 关联任务 ID */
	readonly taskId?: string;
	/** 关联批次 ID（收口泳道挂收口报告面板用，来自 daemon 的 RunDto.batchId） */
	readonly batchId?: string | null;
	/** 收口轮次（kind='wrapup' 头部用；来自 daemon 的收口记录或事件 payload，缺失显示「—」） */
	readonly wrapupRound?: number | null;
	/** 收口所属批次序号（kind='wrapup' 头部用，缺失显示「—」） */
	readonly wrapupBatchNo?: number | null;
	/** 该运行关联的待处理闸门 ID（来自 daemon 的 GET /gates；缺失时不渲染审批卡而不是画一颗假按钮） */
	readonly gateId?: string | null;
	/**
	 * 投递原文的目标运行 ID（E-278：审查留「未结构化」时把原文投回**实施会话**）。
	 * 审查运行的 parentRunId 即被审的实施运行；没有它就没有可投递的目标。
	 */
	readonly deliverTargetRunId?: string | null;
	/** 目标运行的能力位 canReply（E-117，取的是实施运行而不是审查运行那一份） */
	readonly deliverTargetCanReply?: boolean | null;
	/** 审查返工原文（E-278，来自 daemon 的 RunDto.reworkText） */
	readonly reworkText?: string | null;
	/** 审查裁定（只有 'incomplete' 才出投递原文条件动作） */
	readonly reviewVerdict?: string | null;
	/** 归档任务 ID 列表（支持跨泳道重派与历史行，M9-T21 / R2） */
	readonly archivedTaskIds?: readonly string[];
	/** 归档收口运行 ID（M9-T21 / R2） */
	readonly archivedWrapupRunId?: string | null;
	/** 任务编号/代号（如 M9-T9） */
	readonly taskKey?: string;
	/** 任务标题 */
	readonly title?: string;
	/** 当前运行状态 */
	readonly status?: StatusState | string;
	/** Agent 双字符缩写 */
	readonly agentMonogram?: string;
	/** Agent 显示名 */
	readonly agentName?: string;
	/** 模型名 */
	readonly modelName?: string;
	/** 来源说明 */
	readonly refSource?: string;
	/** 运行耗时（毫秒数值或已格式化文本） */
	readonly duration?: number | string | null;
	/** Token 消耗计数 */
	readonly tokenCount?: number | string | null;
	/** 费用收据 */
	readonly cost?: string | number | null;
	/** 是否处于等待人工审批/放行状态（要你） */
	readonly needsApproval?: boolean;
	/** 错误信息 */
	readonly errorMessage?: string;
	/** 扩展插槽：阶段链 / 运行条目（由 M9-T21 注入） */
	readonly bodySlot?: ReactNode;
	/** 扩展插槽：就地审批卡（AC 5, E-236） */
	readonly gateSlot?: ReactNode;
	/** 扩展插槽：参照条 */
	readonly refBarSlot?: ReactNode;
	/** 扩展插槽：底栏 */
	readonly footSlot?: ReactNode;
	/** 扩展插槽：详情会话流（供 detail pane 呈现） */
	readonly detailSlot?: ReactNode;
}

/**
 * 视野外待审批流统计（E-167）。
 */
export interface OffScreenWaitingState {
	/** 视口左侧视野外待处理流计数 */
	readonly left: number;
	/** 视口右侧视野外待处理流计数 */
	readonly right: number;
	/** 左侧第一个待处理泳道号（供一键滚入） */
	readonly firstLeftLaneNo?: number;
	/** 右侧第一个待处理泳道号（供一键滚入） */
	readonly firstRightLaneNo?: number;
}

/**
 * RunDeck 容器与视图属性。
 */
export interface RunDeckProps {
	/** 泳道列表（流数恒等于 lanes.length，AC 12） */
	readonly lanes: readonly DeckStreamLane[];
	/** 外部指定的密度档位覆盖（可选，默认由 useDensityTier 计算） */
	readonly densityTier?: DensityTier;
	/** 停止运行回调 */
	readonly onStopLane?: (laneNo: number, runId?: string | null) => void | Promise<void>;
	/** 批准并继续回调（供拇指区与审批卡触发） */
	readonly onApproveLane?: (laneNo: number, runId?: string | null) => void | Promise<void>;
	/** 头部扩展插槽 */
	readonly toolbarSlot?: ReactNode;
	/** 容器自定义 class */
	readonly className?: string;

	// ─── 批次收口（M9-T20 / AC 3, E-157） ───
	/** 点击批次树「收口」按钮回调（发起 POST，不在响应体上改状态） */
	readonly onWrapup?: (batchId: string) => void;
	/** 点击批次树收口运行行回调 */
	readonly onOpenWrapupRun?: (runId: string, batchId: string) => void;
	/** 正在收口的批次 ID（该批按钮禁用，等 batch.wrapup_started 回流） */
	readonly wrapupPendingBatchId?: string | null;
	readonly wrapupPendingBatchIds?: ReadonlySet<string>;
	/** 每批最近一次收口被拒的具名原因（贴在批次标题下） */
	readonly wrapupFailureByBatch?: ReadonlyMap<string, BatchWrapupFailureView>;
	/**
	 * 闸门裁定回调（审批卡的批准 / 拒绝走这个）。
	 * 只判是否被接受，界面状态一律等回流事件（E-157）。
	 */
	readonly onDecideGate?: (
		gateId: string,
		decision: 'pass' | 'reject',
		comment?: string,
	) => void | Promise<void>;

	// ─── 手机端扩展属性（M9-T12 / E-145, E-13, E-58, E-99） ───
	/** 显式受控的手机栏位切换（可选，默认从 hash query 解析） */
	readonly activePane?: MobilePane;
	/** 手机栏位切换回调 */
	readonly onPaneChange?: (pane: MobilePane) => void;
	/** 批次折叠列表数据（小屏降级为可折叠列表，E-13, R2） */
	readonly batches?: readonly (BatchTreeItem | MobileBatchItem)[];
	/** 选择任务项回调 */
	readonly onSelectTask?: (taskId: string, laneNo?: number) => void;
	/** 切回前台拉取未读列表回调（E-58） */
	readonly onFetchUnread?: () => void | Promise<void>;
	/** 手机端首屏尾部加载字节数限制（E-99，默认 32KB） */
	readonly tailBytes?: number;
	/** 当前打开的 tool payload 抽屉（AC 6） */
	readonly activeToolPayload?: ToolPayloadSheetData | null;
	/** 打开 tool payload 抽屉回调 */
	readonly onOpenToolPayload?: (payload: ToolPayloadSheetData) => void;
	/** 关闭 tool payload 抽屉回调 */
	readonly onCloseToolPayload?: () => void;
}
