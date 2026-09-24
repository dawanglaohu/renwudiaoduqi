/**
 * packages/web/src/store/selection-store.ts
 *
 * 选择与派发草稿 slice（M9-T18 / 07 节前端架构：selection 放当前文档批次与派发草稿）
 *
 * 规范依据：
 * - zustand 只放低频状态；本 slice 只存「当前选中文档 / 批次」与 daemon 下发的逐任务草稿
 * - 草稿字段全部来自 `GET/POST /api/v1/batches/:batchId/assignments` 的 `drafts[]`，前端不推导、不自算
 * - 不存派生值：并发预览（有效并发、瓶颈、agent 占用）属于请求返回值，由 feature 层按批次持有，
 *   不复制一份进 store，避免一份数据两处缓存
 */

import { create } from 'zustand';
import type { TaskAssignmentSelection } from '../components/assign-panel.tsx';

export type { TaskAssignmentSelection };

export interface SelectionState {
	/** 当前选中文档（daemon `documents[].id`） */
	readonly selectedDocId: string | null;
	/** 当前选中批次（daemon `batches[].id`） */
	readonly selectedBatchId: string | null;
	/** 逐任务草稿，key 为 taskId（daemon 下发值，非前端草稿） */
	readonly assignments: Readonly<Record<string, TaskAssignmentSelection>>;
	/** 手机档当前查看的泳道序号（1-based 内存状态，不进 URL、不持久化，AC 9, E-324） */
	readonly mobileLaneNo: number;
}

export interface SelectionActions {
	setSelectedDocId(docId: string | null): void;
	setSelectedBatchId(batchId: string | null): void;
	/** 用 daemon 返回值整批替换本地草稿视图 */
	setAssignments(assignments: Readonly<Record<string, TaskAssignmentSelection>>): void;
	/** 切换手机档当前泳道 */
	setMobileLaneNo(laneNo: number): void;
	reset(): void;
}

export type SelectionStore = SelectionState & SelectionActions;

const INITIAL_STATE: SelectionState = {
	selectedDocId: null,
	selectedBatchId: null,
	assignments: {},
	mobileLaneNo: 1,
};

export const useSelectionStore = create<SelectionStore>((set) => ({
	...INITIAL_STATE,

	setSelectedDocId: (docId) => {
		set({ selectedDocId: docId });
	},

	setSelectedBatchId: (batchId) => {
		// 换批次即丢弃上一批的草稿视图；新批次的草稿等 daemon 返回值到达后再写入
		set({ selectedBatchId: batchId, assignments: {} });
	},

	setAssignments: (assignments) => {
		set({ assignments });
	},

	setMobileLaneNo: (laneNo) => {
		set({ mobileLaneNo: Math.max(1, laneNo) });
	},

	reset: () => {
		set(INITIAL_STATE);
	},
}));
