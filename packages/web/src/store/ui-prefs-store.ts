/**
 * packages/web/src/store/ui-prefs-store.ts
 *
 * UI 偏好低频状态 slice（M9-T21 / 07 节前端架构）
 *
 * 规范依据：
 * - zustand 只放四类低频状态之一的 ui-prefs（07 节）
 * - expandedLaneNo: 紧凑档下用户手动展开的泳道号（E-165, E-315）
 */

import { create } from 'zustand';

export interface UiPrefsState {
	/** 紧凑档展开单列的泳道序号（null 表示所有列保持默认紧凑列宽，E-165） */
	readonly expandedLaneNo: number | null;
}

export interface UiPrefsActions {
	setExpandedLaneNo(laneNo: number | null): void;
	toggleExpandedLaneNo(laneNo: number): void;
	reset(): void;
}

export type UiPrefsStore = UiPrefsState & UiPrefsActions;

const INITIAL_STATE: UiPrefsState = {
	expandedLaneNo: null,
};

export const useUiPrefsStore = create<UiPrefsStore>((set) => ({
	...INITIAL_STATE,

	setExpandedLaneNo: (laneNo) => {
		set({ expandedLaneNo: laneNo });
	},

	toggleExpandedLaneNo: (laneNo) => {
		set((state) => ({
			expandedLaneNo: state.expandedLaneNo === laneNo ? null : laneNo,
		}));
	},

	reset: () => {
		set(INITIAL_STATE);
	},
}));
