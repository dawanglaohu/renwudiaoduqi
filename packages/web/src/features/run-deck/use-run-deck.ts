/**
 * packages/web/src/features/run-deck/use-run-deck.ts
 *
 * 运行甲板状态管理 Hook（M9-T9 / AC 1, AC 3, AC 7, AC 10, E-165, E-167, E-238）
 *
 * 规范依据：
 * - 档位通过 useDensityTier() 单点计算下传（AC 1, E-235）
 * - 紧凑档支持点开一条细看并占满宽度，其余流留在同屏绝不折叠消失（AC 3, E-165）
 * - 拖动窗口切换档位时不重挂虚拟列表、不弹回顶部、不中断跟随（AC 7, E-238）
 * - 完整档横向滚动时若视野外某条流转成「要你」，视口左右边缘常驻计数标记（AC 10, E-167）
 * - 停止操作支持乐观呈现态（07 节约定）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { type DensityTier, useDensityTier } from '../../hooks/use-breakpoint.ts';
import type { DeckStreamLane, OffScreenWaitingState, RunDeckProps } from './types.ts';

/**
 * 判断流是否处于「要你 / 等你审批」状态（E-167）。
 */
export function isWaitingApproval(lane: DeckStreamLane): boolean {
	if (lane.needsApproval) {
		return true;
	}
	const s = lane.status;
	return s === 'awaiting_input' || s === 'waiting' || s === 'gate_waiting';
}

/**
 * useRunDeck Hook 返回值。
 */
export interface UseRunDeckResult {
	/** 最终生效的密度档位（AC 1, E-235） */
	readonly tier: DensityTier;
	/** 是否为触控环境（E-239） */
	readonly isTouch: boolean;
	/** 视口宽度 */
	readonly width: number;
	/** 当前展开的泳道编号（紧凑档独享，AC 3, E-165） */
	readonly expandedLaneNo: number | null;
	/** 切换指定泳道展开状态 */
	readonly toggleExpandLane: (laneNo: number) => void;
	/** 处于停止中（乐观呈现态）的泳道编号集合 */
	readonly stoppingLanes: ReadonlySet<number>;
	/** 触发停止泳道 */
	readonly handleStopLane: (laneNo: number, runId?: string | null) => Promise<void>;
	/** 用户偏好设置（'full' | 'compact' | 'auto'） */
	readonly userPreference: string;
	/** 切换偏好设置 */
	readonly togglePreference: () => void;
	/** 滚动容器 DOM 引用（用于水平滚动与视野外检测，AC 10, E-167） */
	readonly scrollContainerRef: React.RefObject<HTMLDivElement>;
	/** 视野外待审批流统计（E-167） */
	readonly offScreenWaiting: OffScreenWaitingState;
	/** 滚动至指定泳道 */
	readonly scrollToLane: (laneNo: number) => void;
}

export function useRunDeck(props: RunDeckProps): UseRunDeckResult {
	const { lanes, densityTier: overrideTier, onStopLane } = props;

	// 单点计算密度档位（AC 1, E-235）
	const density = useDensityTier({ streamCount: lanes.length });
	const tier: DensityTier = overrideTier ?? density.tier;

	// 紧凑档展开某条流（AC 3, E-165）
	const [expandedLaneNo, setExpandedLaneNo] = useState<number | null>(null);

	// 乐观停止状态集合（07 节约定）
	const [stoppingLanes, setStoppingLanes] = useState<ReadonlySet<number>>(() => new Set());

	// 滚动容器引用与视野外待审批流统计（AC 10, E-167）
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const [offScreenWaiting, setOffScreenWaiting] = useState<OffScreenWaitingState>({
		left: 0,
		right: 0,
	});

	// 切换展开状态
	const toggleExpandLane = useCallback((laneNo: number) => {
		setExpandedLaneNo((prev) => (prev === laneNo ? null : laneNo));
	}, []);

	// 停止操作触发（带本地乐观呈现态）
	const handleStopLane = useCallback(
		async (laneNo: number, runId?: string | null) => {
			setStoppingLanes((prev) => {
				const next = new Set(prev);
				next.add(laneNo);
				return next;
			});

			try {
				if (onStopLane) {
					await onStopLane(laneNo, runId);
				}
			} finally {
				// 服务端状态或事件到达后解除乐观态，这里保留防御性恢复
				setStoppingLanes((prev) => {
					if (!prev.has(laneNo)) {
						return prev;
					}
					const next = new Set(prev);
					next.delete(laneNo);
					return next;
				});
			}
		},
		[onStopLane],
	);

	// 视野外「要你」检测逻辑（AC 10, E-167）
	const updateOffScreenWaiting = useCallback(() => {
		const container = scrollContainerRef.current;
		if (!container || tier !== 'full') {
			setOffScreenWaiting({ left: 0, right: 0 });
			return;
		}

		const containerRect = container.getBoundingClientRect();
		const laneElements = container.querySelectorAll<HTMLElement>('[data-stream-column="true"]');

		let left = 0;
		let right = 0;
		let firstLeftLaneNo: number | undefined;
		let firstRightLaneNo: number | undefined;

		for (const el of laneElements) {
			const laneNoStr = el.getAttribute('data-lane-no');
			const laneNo = laneNoStr ? Number.parseInt(laneNoStr, 10) : Number.NaN;
			const targetLane = lanes.find((l) => l.laneNo === laneNo);

			if (!targetLane || !isWaitingApproval(targetLane)) {
				continue;
			}

			const rect = el.getBoundingClientRect();
			// el 完全或大部分处于视口左侧（屏幕外）
			if (rect.right < containerRect.left + 20) {
				left += 1;
				if (firstLeftLaneNo === undefined) {
					firstLeftLaneNo = laneNo;
				}
			}
			// el 完全或大部分处于视口右侧（屏幕外）
			else if (rect.left > containerRect.right - 20) {
				right += 1;
				if (firstRightLaneNo === undefined) {
					firstRightLaneNo = laneNo;
				}
			}
		}

		setOffScreenWaiting({
			left,
			right,
			firstLeftLaneNo,
			firstRightLaneNo,
		});
	}, [lanes, tier]);

	// 监听滚动与流状态变更以更新视野外计数
	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container) {
			return;
		}

		updateOffScreenWaiting();

		const handleScroll = () => {
			updateOffScreenWaiting();
		};

		container.addEventListener('scroll', handleScroll, { passive: true });
		window.addEventListener('resize', updateOffScreenWaiting);

		return () => {
			container.removeEventListener('scroll', handleScroll);
			window.removeEventListener('resize', updateOffScreenWaiting);
		};
	}, [updateOffScreenWaiting]);

	// 滚动至指定泳道
	const scrollToLane = useCallback((laneNo: number) => {
		const container = scrollContainerRef.current;
		if (!container) {
			return;
		}
		const target = container.querySelector<HTMLElement>(`[data-lane-no="${laneNo}"]`);
		if (target) {
			target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
		}
	}, []);

	return {
		tier,
		isTouch: density.isTouch,
		width: density.width,
		expandedLaneNo,
		toggleExpandLane,
		stoppingLanes,
		handleStopLane,
		userPreference: density.userPreference,
		togglePreference: density.togglePreference,
		scrollContainerRef,
		offScreenWaiting,
		scrollToLane,
	};
}
