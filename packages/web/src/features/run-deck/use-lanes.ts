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
	/** 外部快照已提供泳道时，跳过独立取数与订阅。 */
	readonly enabled?: boolean;
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
	/** 手机档当前选中的泳道位置序号（1-based 序号，k/N 呈现，R3） */
	readonly currentLanePosition: number;
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
	const { docId, initialLanes, enabled = true } = options;

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
		if (!enabled) return;
		void loadLanes();
	}, [enabled, loadLanes]);

	// 订阅事件：lane.assigned, lane.released, task.sessions_archived, document.settings_changed（E-333）
	useEffect(() => {
		if (!enabled) return;
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
	}, [docId, enabled, loadLanes]);

	// E-324: 手机端单栏切换，窗口数调小后 N 显示现存泳道数，泳道消失后落到仍存在的最近位置（AC 9, E-324, R3）
	const totalLanes = lanes.length;

	// 在已排序的 lanes 列表中找到当前选中的索引位置
	const currentSortedIndex = useMemo(() => {
		if (lanes.length === 0) return -1;
		const exactIdx = lanes.findIndex((l) => l.laneNo === mobileLaneNo);
		if (exactIdx !== -1) return exactIdx;

		// 找不到（例如窗口调小导致原 laneNo 消失，或者稀疏号不匹配）：
		// 落到仍存在的最近位置：若 mobileLaneNo 大于最大 laneNo，落到最后一项；否则找差值最近项
		const first = lanes[0];
		if (!first) return -1;
		let closestIdx = 0;
		let minDiff = Math.abs(first.laneNo - mobileLaneNo);
		for (let i = 1; i < lanes.length; i++) {
			const item = lanes[i];
			if (!item) continue;
			const diff = Math.abs(item.laneNo - mobileLaneNo);
			if (diff < minDiff) {
				minDiff = diff;
				closestIdx = i;
			}
		}
		return closestIdx;
	}, [lanes, mobileLaneNo]);

	// 当泳道发生变化且当前选中的 laneNo 不在列表中时，将最近位置的实际 laneNo 收敛同步回 store
	useEffect(() => {
		if (lanes.length > 0 && currentSortedIndex >= 0) {
			const targetItem = lanes[currentSortedIndex];
			if (targetItem && targetItem.laneNo !== mobileLaneNo) {
				setMobileLaneNoStore(targetItem.laneNo);
			}
		}
	}, [lanes, currentSortedIndex, mobileLaneNo, setMobileLaneNoStore]);

	const currentMobileLane = useMemo(() => {
		if (lanes.length === 0 || currentSortedIndex < 0) return undefined;
		return lanes[currentSortedIndex];
	}, [lanes, currentSortedIndex]);

	// 1-based 序号（1..totalLanes）供 LaneRunStrip 呈现「泳道 k/N」
	const currentLanePosition = currentSortedIndex >= 0 ? currentSortedIndex + 1 : 1;

	const prevMobileLane = useCallback(() => {
		if (currentSortedIndex > 0) {
			const prevLane = lanes[currentSortedIndex - 1];
			if (prevLane) {
				setMobileLaneNoStore(prevLane.laneNo);
			}
		}
	}, [currentSortedIndex, lanes, setMobileLaneNoStore]);

	const nextMobileLane = useCallback(() => {
		if (currentSortedIndex >= 0 && currentSortedIndex < lanes.length - 1) {
			const nextLane = lanes[currentSortedIndex + 1];
			if (nextLane) {
				setMobileLaneNoStore(nextLane.laneNo);
			}
		}
	}, [currentSortedIndex, lanes, setMobileLaneNoStore]);

	return {
		lanes,
		isLoading,
		isUnavailable,
		errorMessage,
		mobileLaneNo: currentMobileLane?.laneNo ?? mobileLaneNo,
		currentLanePosition,
		currentMobileLane,
		setMobileLaneNo: setMobileLaneNoStore,
		prevMobileLane,
		nextMobileLane,
		expandedLaneNo,
		toggleExpandLane: toggleExpandLaneStore,
		refreshLanes: loadLanes,
	};
}
