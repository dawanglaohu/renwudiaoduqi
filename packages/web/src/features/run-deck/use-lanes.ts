/**
 * packages/web/src/features/run-deck/use-lanes.ts
 *
 * 泳道状态与事件驱动 Hook（M9-T21 / AC 1, AC 7b, AC 9, E-309, E-317, E-324, E-333 / 07 节前端架构）
 *
 * 规范依据：
 * - 泳道数与顺序只来自 lanes[]（按 laneNo 升序、不补洞），前端不算槽位、不算下一个任务、不推断阶段（AC 1, E-317）
 * - 快照缺 lanes 键或不是数组 → 运行甲板显示「泳道数据不可用」，按 E-26 不自算槽位（E-333）
 * - 订阅 lane.assigned / lane.released / task.sessions_archived / document.settings_changed 事件刷新（E-333）
 * - 手机档当前泳道序号存 selection-store 内存、不进 URL、不持久化（AC 9, E-324）
 * - 窗口数调小后落到 min(k, N')（E-324）
 */

import type { LaneView } from '@agent-scheduler/shared/api/lanes';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { eventBus } from '../../api/event-bus.ts';
import { fetchLanes, markLanesCacheInvalidated } from '../../api/lanes.ts';
import { useSelectionStore } from '../../store/selection-store.ts';
import { useUiPrefsStore } from '../../store/ui-prefs-store.ts';

export interface UseLanesOptions {
	/** 指定的文档 ID */
	readonly docId?: string | null;
	/** 初始泳道数据（如已随首屏拉取） */
	readonly initialLanes?: readonly LaneView[];
}

export interface UseLanesResult {
	/** 严格按 laneNo 升序排列的泳道列表（AC 1） */
	readonly lanes: readonly LaneView[];
	/** 是否正在加载 */
	readonly isLoading: boolean;
	/** 泳道数据是否不可用（E-333） */
	readonly isUnavailable: boolean;
	/** 错误信息文案 */
	readonly errorMessage: string | null;
	/** 手机档当前选中的泳道序号（1-based 整数） */
	readonly mobileLaneNo: number;
	/** 手机档当前选中的泳道对象 */
	readonly currentMobileLane: LaneView | undefined;
	/** 切换手机档泳道回调 */
	readonly setMobileLaneNo: (laneNo: number) => void;
	/** 手机档上一泳道 */
	readonly prevMobileLane: () => void;
	/** 手机档下一泳道 */
	readonly nextMobileLane: () => void;
	/** 紧凑档展开单列的泳道序号（E-165, E-315） */
	readonly expandedLaneNo: number | null;
	/** 切换紧凑档展开泳道 */
	readonly toggleExpandLane: (laneNo: number) => void;
	/** 手动刷新泳道 */
	readonly refreshLanes: () => Promise<void>;
}

export function useLanes(options: UseLanesOptions = {}): UseLanesResult {
	const { docId, initialLanes } = options;

	const [lanes, setLanes] = useState<readonly LaneView[]>(() => {
		if (initialLanes && Array.isArray(initialLanes)) {
			return [...initialLanes].sort((a, b) => a.laneNo - b.laneNo);
		}
		return [];
	});
	const [isLoading, setIsLoading] = useState<boolean>(!initialLanes);
	const [isUnavailable, setIsUnavailable] = useState<boolean>(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const mobileLaneNo = useSelectionStore((s) => s.mobileLaneNo);
	const setMobileLaneNoStore = useSelectionStore((s) => s.setMobileLaneNo);
	const expandedLaneNo = useUiPrefsStore((s) => s.expandedLaneNo);
	const toggleExpandLaneStore = useUiPrefsStore((s) => s.toggleExpandedLaneNo);

	const loadLanes = useCallback(async () => {
		try {
			setIsLoading(true);
			const rawLanes = await fetchLanes(docId);
			if (!Array.isArray(rawLanes)) {
				setIsUnavailable(true);
				setErrorMessage('泳道数据不可用');
				setLanes([]);
				return;
			}
			// AC 1: 按 laneNo 升序排列、不补洞
			const sorted = [...rawLanes].sort((a, b) => a.laneNo - b.laneNo);
			setLanes(sorted);
			setIsUnavailable(false);
			setErrorMessage(null);
		} catch (err) {
			setIsUnavailable(true);
			setErrorMessage('泳道数据不可用');
			setLanes([]);
		} finally {
			setIsLoading(false);
		}
	}, [docId]);

	// 首次挂载或 docId 变化时拉取
	useEffect(() => {
		void loadLanes();
	}, [loadLanes]);

	// 订阅事件：lane.assigned, lane.released, task.sessions_archived, document.settings_changed（E-333）
	useEffect(() => {
		const unsubscribe = eventBus.subscribeAll((event) => {
			if (
				event.kind === 'lane.assigned' ||
				event.kind === 'lane.released' ||
				event.kind === 'task.sessions_archived' ||
				event.kind === 'document.settings_changed'
			) {
				markLanesCacheInvalidated(docId);
				void loadLanes();
			}
		});

		return () => {
			unsubscribe();
		};
	}, [docId, loadLanes]);

	// E-324: 窗口数调小后 N 显示现存泳道数，泳道消失后落到 min(k, N')
	const totalLanes = lanes.length;
	const clampedMobileLaneNo = useMemo(() => {
		if (totalLanes <= 0) return 1;
		return Math.min(mobileLaneNo, totalLanes);
	}, [mobileLaneNo, totalLanes]);

	// 当泳道数改变导致超出时，同步收敛回 store（E-324）
	useEffect(() => {
		if (totalLanes > 0 && mobileLaneNo > totalLanes) {
			setMobileLaneNoStore(totalLanes);
		}
	}, [totalLanes, mobileLaneNo, setMobileLaneNoStore]);

	const currentMobileLane = useMemo(() => {
		if (lanes.length === 0) return undefined;
		return (
			lanes.find((l) => l.laneNo === clampedMobileLaneNo) ??
			lanes[clampedMobileLaneNo - 1] ??
			lanes[0]
		);
	}, [lanes, clampedMobileLaneNo]);

	const prevMobileLane = useCallback(() => {
		if (clampedMobileLaneNo > 1) {
			setMobileLaneNoStore(clampedMobileLaneNo - 1);
		}
	}, [clampedMobileLaneNo, setMobileLaneNoStore]);

	const nextMobileLane = useCallback(() => {
		if (clampedMobileLaneNo < totalLanes) {
			setMobileLaneNoStore(clampedMobileLaneNo + 1);
		}
	}, [clampedMobileLaneNo, totalLanes, setMobileLaneNoStore]);

	return {
		lanes,
		isLoading,
		isUnavailable,
		errorMessage,
		mobileLaneNo: clampedMobileLaneNo,
		currentMobileLane,
		setMobileLaneNo: setMobileLaneNoStore,
		prevMobileLane,
		nextMobileLane,
		expandedLaneNo,
		toggleExpandLane: toggleExpandLaneStore,
		refreshLanes: loadLanes,
	};
}
