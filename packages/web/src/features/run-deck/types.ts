/**
 * packages/web/src/features/run-deck/types.ts
 *
 * 运行甲板多流监看类型定义（M9-T9 / 07 节前端架构）
 */

import type { ReactNode } from 'react';
import type { DensityTier } from '../../hooks/use-breakpoint.ts';
import type { StatusState } from '../../lib/spine-shape.ts';

/**
 * 泳道流数据模型（对应 daemon snapshot 中的 lanes[] 元素，AC 12, E-311, E-317）。
 */
export interface DeckStreamLane {
	/** 泳道编号（1-based 整数） */
	readonly laneNo: number;
	/** 泳道唯一标识（可选） */
	readonly id?: string;
	/** 当前运行 ID（E-311） */
	readonly currentRunId?: string | null;
	/** 关联任务 ID */
	readonly taskId?: string;
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
	/** 头部扩展插槽 */
	readonly toolbarSlot?: ReactNode;
	/** 容器自定义 class */
	readonly className?: string;
}
