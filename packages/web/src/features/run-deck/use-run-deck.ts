/**
 * packages/web/src/features/run-deck/use-run-deck.ts
 *
 * 运行甲板状态管理 Hook（M9-T9, M9-T12 / AC 1-12, E-13, E-58, E-99, E-107, E-124, E-145, E-240）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 档位通过 useDensityTier() 单点计算下传（AC 1, E-235）
 * - 手机竖屏 < 400px 降级为单栏切换（任务列表 / 运行流 / 详情），不横向滚动（E-145）
 * - 手机窄屏三栏切换走 hash query #/?pane=tasks|stream|detail，不新增路由（07 节）
 * - 手机端中止需二次确认防口袋误触（E-124）
 * - 单栏切换到「任务列表」时若某条流转「等你」，必须有可见的未处理计数徽标（E-240）
 * - app 曾退到后台时重回前台拉未读列表，等待中的确认项不过期、不自动放行（E-58）
 * - 首屏加载量显著更小（尾部 32KB），切后台再回前台不重拉全量（E-99）
 * - 展开的 tool payload 走 bottom sheet 不内联（AC 6）
 * - 停止与批准固定在拇指区（E-107）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { navigateTo } from '../../app/routes.tsx';
import { type DensityTier, useDensityTier } from '../../hooks/use-breakpoint.ts';
import {
	type DeckStreamLane,
	MOBILE_INITIAL_TAIL_BYTES,
	type MobilePane,
	type OffScreenWaitingState,
	type RunDeckProps,
	type ToolPayloadSheetData,
} from './types.ts';

/**
 * 判断流是否处于「要你 / 等你审批」状态（E-167, E-240）。
 */
export function isWaitingApproval(lane: DeckStreamLane): boolean {
	if (lane.needsApproval) {
		return true;
	}
	const s = lane.status;
	return s === 'awaiting_input' || s === 'waiting' || s === 'gate_waiting';
}

/**
 * 从当前 window.location.hash 解析单栏 pane 参数（E-145, 07 节约定）。
 */
export function getPaneFromHash(): MobilePane {
	if (typeof window === 'undefined' || !window.location) {
		return 'stream';
	}
	const hash = window.location.hash || '';
	const questionIndex = hash.indexOf('?');
	if (questionIndex === -1) {
		return 'stream';
	}
	try {
		const searchParams = new URLSearchParams(hash.slice(questionIndex + 1));
		const pane = searchParams.get('pane');
		if (pane === 'tasks' || pane === 'stream' || pane === 'detail') {
			return pane;
		}
	} catch {
		// 忽略异常参数
	}
	return 'stream';
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
	/** 触发停止泳道（桌面直接中止，手机端需二次确认，E-124） */
	readonly handleStopLane: (
		laneNo: number,
		runId?: string | null,
		taskKey?: string,
	) => Promise<void>;
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

	// ─── 手机端布局与拇指区扩展（M9-T12） ───
	/** 当前单栏切换的激活项（'tasks' | 'stream' | 'detail'，E-145） */
	readonly activePane?: MobilePane;
	/** 切换单栏视图（通过 hash query #/?pane=...，E-145） */
	readonly setPane?: (pane: MobilePane) => void;
	/** 手机端当前查看的泳道号（实际 laneNo） */
	readonly activeMobileLaneNo?: number;
	/** 手机端当前查看的泳道在现存排序列表中的 1-based 序号（k/N 呈现用，E-324, R3） */
	readonly activeMobileLanePosition?: number;
	/** 切换到上一条手机泳道 */
	readonly handlePrevMobileLane?: () => void;
	/** 切换到下一条手机泳道 */
	readonly handleNextMobileLane?: () => void;
	/** 选择特定泳道 */
	readonly selectMobileLane?: (laneNo: number) => void;
	/** 当前手机泳道流数据 */
	readonly currentMobileLane?: DeckStreamLane | undefined;

	/** 处于等待审批状态的泳道总计数（E-240） */
	readonly totalWaitingCount?: number;
	/** 当前手机泳道是否处于等待审批状态 */
	readonly isCurrentLaneWaiting?: boolean;

	/** 批准操作处理中状态 */
	readonly isApproving?: boolean;
	/** 触发批准当前泳道 */
	readonly handleApproveLane?: (laneNo?: number, runId?: string | null) => Promise<void>;

	/** 手机端停止二次确认弹窗状态（E-124） */
	readonly stopConfirmOpen?: boolean;
	/** 待二次确认的停止目标信息 */
	readonly stopConfirmTarget?: {
		laneNo: number;
		runId?: string | null;
		taskKey?: string;
	} | null;
	/** 确认停止执行 */
	readonly confirmStop?: () => Promise<void>;
	/** 取消停止执行 */
	readonly cancelStop?: () => void;

	/** 当前展开的 Tool Payload Sheet 数据（AC 6） */
	readonly activeToolPayload?: ToolPayloadSheetData | null;
	/** 打开 Tool Payload Sheet */
	readonly openToolPayloadSheet?: (payload: ToolPayloadSheetData) => void;
	/** 关闭 Tool Payload Sheet */
	readonly closeToolPayloadSheet?: () => void;

	/** 手机端日志加载尾部字节限制（E-99，默认 32KB） */
	readonly tailBytes?: number;
	/** 是否仅拉取尾部切片（E-99） */
	readonly isTailOnly?: boolean;
}

export function useRunDeck(props: RunDeckProps): UseRunDeckResult {
	const {
		lanes,
		densityTier: overrideTier,
		onStopLane,
		onApproveLane,
		activePane: overridePane,
		onPaneChange,
		onFetchUnread,
		tailBytes: overrideTailBytes,
		activeToolPayload: externalPayload,
		onOpenToolPayload,
		onCloseToolPayload,
	} = props;

	// 单点计算密度档位（AC 1, E-235）
	const density = useDensityTier({ streamCount: lanes.length });
	const tier: DensityTier = overrideTier ?? density.tier;

	const isMobileTier = tier === 'phone' || tier === 'phone-xs';

	// 紧凑档展开某条流（AC 3, E-165）
	const [expandedLaneNo, setExpandedLaneNo] = useState<number | null>(null);

	// 乐观停止状态集合（07 节约定）
	const [stoppingLanes, setStoppingLanes] = useState<ReadonlySet<number>>(() => new Set());

	// 批准处理中状态
	const [isApproving, setIsApproving] = useState<boolean>(false);

	// 滚动容器引用与视野外待审批流统计（AC 10, E-167）
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const [offScreenWaiting, setOffScreenWaiting] = useState<OffScreenWaitingState>({
		left: 0,
		right: 0,
	});

	// ─── 手机端单栏切换状态（E-145, 07 节） ───
	const [internalPane, setInternalPane] = useState<MobilePane>(() => getPaneFromHash());
	const activePane: MobilePane = overridePane ?? internalPane;

	// 监听 hashchange 同步 pane
	useEffect(() => {
		if (typeof window === 'undefined') {
			return;
		}

		const handleHashChange = () => {
			const nextPane = getPaneFromHash();
			setInternalPane(nextPane);
		};

		window.addEventListener('hashchange', handleHashChange);
		return () => window.removeEventListener('hashchange', handleHashChange);
	}, []);

	// 切换单栏视图（通过 navigateTo 更新 hash query，实现 Android 返回键天然回上一 pane，07 节）
	const setPane = useCallback(
		(pane: MobilePane) => {
			setInternalPane(pane);
			if (onPaneChange) {
				onPaneChange(pane);
			}
			navigateTo(`#/?pane=${pane}`);
		},
		[onPaneChange],
	);

	// ─── 手机端当前查看的泳道序号与稀疏导航（AC 1, AC 9, E-324, R3） ───
	const [activeMobileLaneNo, setActiveMobileLaneNo] = useState<number>(1);

	// 按 laneNo 升序排列
	const sortedLanes = useMemo(() => [...lanes].sort((a, b) => a.laneNo - b.laneNo), [lanes]);

	// 在已排序列表中找到当前选中的索引位置
	const currentSortedIndex = useMemo(() => {
		if (sortedLanes.length === 0) return -1;
		const exactIdx = sortedLanes.findIndex((l) => l.laneNo === activeMobileLaneNo);
		if (exactIdx !== -1) return exactIdx;

		// 找不到（例如缩窗导致原 laneNo 消失，或稀疏号），落到仍存在的最近位置（E-324, R3）
		const first = sortedLanes[0];
		if (!first) return -1;
		let closestIdx = 0;
		let minDiff = Math.abs(first.laneNo - activeMobileLaneNo);
		for (let i = 1; i < sortedLanes.length; i++) {
			const item = sortedLanes[i];
			if (!item) continue;
			const diff = Math.abs(item.laneNo - activeMobileLaneNo);
			if (diff < minDiff) {
				minDiff = diff;
				closestIdx = i;
			}
		}
		return closestIdx;
	}, [sortedLanes, activeMobileLaneNo]);

	// 当泳道列表变化且当前选中的 laneNo 不在列表中时，自动收敛同步最近位置的真实 laneNo
	useEffect(() => {
		if (sortedLanes.length > 0 && currentSortedIndex >= 0) {
			const targetItem = sortedLanes[currentSortedIndex];
			if (targetItem && targetItem.laneNo !== activeMobileLaneNo) {
				setActiveMobileLaneNo(targetItem.laneNo);
			}
		}
	}, [sortedLanes, currentSortedIndex, activeMobileLaneNo]);

	const currentMobileLane = useMemo(() => {
		if (sortedLanes.length === 0 || currentSortedIndex < 0) return undefined;
		return sortedLanes[currentSortedIndex];
	}, [sortedLanes, currentSortedIndex]);

	// 1-based 序号（1..totalLanes）供呈现「泳道 k/N」
	const activeMobileLanePosition = currentSortedIndex >= 0 ? currentSortedIndex + 1 : 1;

	const handlePrevMobileLane = useCallback(() => {
		if (currentSortedIndex > 0) {
			const prevLane = sortedLanes[currentSortedIndex - 1];
			if (prevLane) {
				setActiveMobileLaneNo(prevLane.laneNo);
			}
		}
	}, [currentSortedIndex, sortedLanes]);

	const handleNextMobileLane = useCallback(() => {
		if (currentSortedIndex >= 0 && currentSortedIndex < sortedLanes.length - 1) {
			const nextLane = sortedLanes[currentSortedIndex + 1];
			if (nextLane) {
				setActiveMobileLaneNo(nextLane.laneNo);
			}
		}
	}, [currentSortedIndex, sortedLanes]);

	const selectMobileLane = useCallback((laneNo: number) => {
		setActiveMobileLaneNo(laneNo);
	}, []);

	// 统计处于等待审批状态的泳道总计数（E-240）
	const totalWaitingCount = useMemo(() => {
		let count = 0;
		for (const lane of lanes) {
			if (isWaitingApproval(lane)) {
				count += 1;
			}
		}
		return count;
	}, [lanes]);

	const isCurrentLaneWaiting = currentMobileLane ? isWaitingApproval(currentMobileLane) : false;

	// ─── 手机端停止二次确认防误触状态（E-124） ───
	const [stopConfirmTarget, setStopConfirmTarget] = useState<{
		laneNo: number;
		runId?: string | null;
		taskKey?: string;
	} | null>(null);

	// 执行实际停止调用（带乐观呈现态）
	const executeStopLane = useCallback(
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
				// 服务端状态或事件到达后解除乐观态
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

	// 触发停止：在手机档下先打开二次确认弹窗（E-124），桌面端直接执行
	const handleStopLane = useCallback(
		async (laneNo: number, runId?: string | null, taskKey?: string) => {
			if (isMobileTier) {
				// 手机端拦截并打开二次确认
				setStopConfirmTarget({ laneNo, runId, taskKey });
				return;
			}
			// 桌面端直接执行
			await executeStopLane(laneNo, runId);
		},
		[isMobileTier, executeStopLane],
	);

	// 确认停止
	const confirmStop = useCallback(async () => {
		if (!stopConfirmTarget) {
			return;
		}
		const { laneNo, runId } = stopConfirmTarget;
		setStopConfirmTarget(null);
		await executeStopLane(laneNo, runId);
	}, [stopConfirmTarget, executeStopLane]);

	// 取消停止
	const cancelStop = useCallback(() => {
		setStopConfirmTarget(null);
	}, []);

	// 触发批准当前泳道
	const handleApproveLane = useCallback(
		async (targetLaneNo?: number, targetRunId?: string | null) => {
			const laneNo = targetLaneNo ?? activeMobileLaneNo;
			const target = lanes.find((l) => l.laneNo === laneNo) ?? currentMobileLane;
			const runId = targetRunId ?? target?.currentRunId;

			setIsApproving(true);
			try {
				if (onApproveLane) {
					await onApproveLane(laneNo, runId);
				}
			} finally {
				setIsApproving(false);
			}
		},
		[activeMobileLaneNo, lanes, currentMobileLane, onApproveLane],
	);

	// ─── Tool Payload 底部抽屉状态（AC 6） ───
	const [internalPayload, setInternalPayload] = useState<ToolPayloadSheetData | null>(null);
	const activeToolPayload = externalPayload !== undefined ? externalPayload : internalPayload;

	const openToolPayloadSheet = useCallback(
		(payload: ToolPayloadSheetData) => {
			if (onOpenToolPayload) {
				onOpenToolPayload(payload);
			} else {
				setInternalPayload(payload);
			}
		},
		[onOpenToolPayload],
	);

	const closeToolPayloadSheet = useCallback(() => {
		if (onCloseToolPayload) {
			onCloseToolPayload();
		} else {
			setInternalPayload(null);
		}
	}, [onCloseToolPayload]);

	// ─── app 曾退到后台时重回前台处理（E-58 & E-99） ───
	const hasBeenBackgroundedRef = useRef<boolean>(false);

	useEffect(() => {
		if (typeof document === 'undefined') {
			return;
		}

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'hidden') {
				hasBeenBackgroundedRef.current = true;
			} else if (document.visibilityState === 'visible' && hasBeenBackgroundedRef.current) {
				// E-58: 重回前台拉未读列表
				if (onFetchUnread) {
					onFetchUnread();
				}
				// E-58 规则硬性约束：等待中的确认项不过期、不自动放行。
				// 前端绝不通过计时器或切前台事件将 awaiting_input / gate_waiting 自动变更为通过。
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
	}, [onFetchUnread]);

	// ─── 手机端首屏尾部加载量限制（E-99） ───
	const tailBytes = overrideTailBytes ?? MOBILE_INITIAL_TAIL_BYTES;
	const isTailOnly = isMobileTier;

	// 切换展开状态
	const toggleExpandLane = useCallback((laneNo: number) => {
		setExpandedLaneNo((prev) => (prev === laneNo ? null : laneNo));
	}, []);

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

		// 手机端能力
		activePane,
		setPane,
		activeMobileLaneNo,
		activeMobileLanePosition,
		handlePrevMobileLane,
		handleNextMobileLane,
		selectMobileLane,
		currentMobileLane,
		totalWaitingCount,
		isCurrentLaneWaiting,
		isApproving,
		handleApproveLane,
		stopConfirmOpen: stopConfirmTarget !== null,
		stopConfirmTarget,
		confirmStop,
		cancelStop,
		activeToolPayload,
		openToolPayloadSheet,
		closeToolPayloadSheet,
		tailBytes,
		isTailOnly,
	};
}
