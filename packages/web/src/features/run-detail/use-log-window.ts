/**
 * packages/web/src/features/run-detail/use-log-window.ts
 *
 * 日志窗口 React Hook（M9-T8 / AC 1, AC 2, AC 3, E-98, E-100, E-143）
 *
 * 规范依据（07 节前端架构）：
 * - features 层唯一允许 import src/api 与订阅 event-bus（07 节）
 * - 串联 LogWindowManager（内存 6 段管理）与后台 REST 分段接口、SSE 实时事件流
 * - 向上滚动时通过 prevCursor 向 daemon 按段请求历史片段（E-143）
 * - 处于中部时不自动跳底，累加 unreadNewCount（E-100）
 * - 单会话体积超阈值时提供尾部片段加载与原始文件打开能力（E-98）
 * - 请求改走 ROUTES + httpClient.callRoute，禁止硬编码 URL 字面量（R5 d）
 * - 按已消费水位顺序追加所有新增事件正文，杜绝 flush 漏丢中间事件（R4）
 */

import type { GetRunLogResponse } from '@agent-scheduler/shared/api/runs';
import {
	type UIEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { ROUTES } from '../../../../shared/src/api/routes.ts';
import { eventBus } from '../../api/event-bus.ts';
import { httpClient } from '../../api/http-client.ts';
import type { VirtualScrollInfo } from '../../components/virtual-rows.tsx';
import { LogWindowManager, type LogWindowState } from './log-window.ts';

const getRunLogRoute = ROUTES.find(
	(r) => r.method === 'GET' && r.path === '/api/v1/runs/:runId/log',
);

export interface UseLogWindowOptions {
	/** 运行编号 */
	readonly runId: string;
	/** 是否自动订阅 SSE 事件总线实时推流（默认 true） */
	readonly autoSubscribeEvents?: boolean;
	/** 初始每段请求行数限制（默认 2000） */
	readonly segmentLimit?: number;
}

export interface UseLogWindowReturn {
	/** 当前日志窗口快照状态 */
	readonly state: LogWindowState;
	/** 首次加载中 */
	readonly isLoadingInitial: boolean;
	/** 向上拉取更早片段中 */
	readonly isLoadingOlder: boolean;
	/** 向下拉取较新片段中 */
	readonly isLoadingNewer: boolean;
	/** 错误信息文案 */
	readonly error: string | null;
	/** 向上加载更早历史分段 */
	readonly loadOlder: () => Promise<void>;
	/** 向下重新加载较新分段 */
	readonly loadNewer: () => Promise<void>;
	/** 虚拟列表滚动回调 */
	readonly handleScroll: (event: UIEvent<HTMLDivElement>, info: VirtualScrollInfo) => void;
	/** 用户主动点击「回到底部」 */
	readonly handleResetUnread: () => void;
	/** 允许直接追加实时行（供事件处理或测试使用） */
	readonly appendLiveLines: (lines: readonly string[]) => void;
}

export function useLogWindow({
	runId,
	autoSubscribeEvents = true,
	segmentLimit = 2000,
}: UseLogWindowOptions): UseLogWindowReturn {
	const managerRef = useRef<LogWindowManager | null>(null);
	if (!managerRef.current) {
		managerRef.current = new LogWindowManager();
	}
	const manager = managerRef.current;

	const [isLoadingInitial, setIsLoadingInitial] = useState(false);
	const [isLoadingOlder, setIsLoadingOlder] = useState(false);
	const [isLoadingNewer, setIsLoadingNewer] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// 水位记录，保证多条 chunk 在一次 flush 内不漏且不重（R4）
	const lastConsumedIdRef = useRef<number | null>(null);
	const lastConsumedSeqRef = useRef<number | null>(null);

	// 通过 useSyncExternalStore 订阅 LogWindowManager 状态变化（R2: 返回同一引用快照）
	const getSnapshot = useCallback(() => manager.getState(), [manager]);
	const state = useSyncExternalStore(
		useCallback((notify) => manager.subscribe(notify), [manager]),
		getSnapshot,
		getSnapshot,
	);

	// 1. 首屏加载（R5 d: callRoute）
	useEffect(() => {
		if (!getRunLogRoute) {
			throw new Error('getRunLogRoute missing from ROUTES');
		}

		let isCurrent = true;
		setIsLoadingInitial(true);
		setError(null);

		httpClient
			.callRoute<GetRunLogResponse>(getRunLogRoute, {
				params: { runId },
				query: { limit: segmentLimit },
			})
			.then((res) => {
				if (!isCurrent) {
					return;
				}
				manager.loadInitial(res);
				setIsLoadingInitial(false);
			})
			.catch((err) => {
				if (!isCurrent) {
					return;
				}
				const message = err instanceof Error ? err.message : String(err);
				setError(message);
				setIsLoadingInitial(false);
			});

		return () => {
			isCurrent = false;
		};
	}, [runId, segmentLimit, manager]);

	// 2. 实时流事件订阅（AC 3 / E-100 / R4）
	useEffect(() => {
		if (!autoSubscribeEvents) {
			return;
		}

		// 订阅 eventBus 针对本 runId 的事件更新
		const unsubscribe = eventBus.subscribe(runId, () => {
			const buffer = eventBus.getBuffer(runId);
			if (!buffer) {
				return;
			}

			// 读取所有事件并在水位之后顺序提取（R4）
			const events = buffer.getItems();
			if (events.length === 0) {
				return;
			}

			const newLines: string[] = [];
			for (const event of events) {
				const id = typeof event.id === 'number' ? event.id : null;
				const seq = typeof event.seq === 'number' ? event.seq : null;

				const isNew =
					id !== null
						? lastConsumedIdRef.current === null || id > lastConsumedIdRef.current
						: seq !== null
							? lastConsumedSeqRef.current === null || seq > lastConsumedSeqRef.current
							: true;

				if (isNew) {
					if (id !== null) {
						lastConsumedIdRef.current = Math.max(lastConsumedIdRef.current ?? -1, id);
					}
					if (seq !== null) {
						lastConsumedSeqRef.current = Math.max(lastConsumedSeqRef.current ?? -1, seq);
					}

					if (
						event.kind === 'agent_message_chunk' ||
						event.kind === 'agent_thought_chunk' ||
						event.kind === 'run.stderr_line'
					) {
						const payload = event.payload as
							| { chunk?: string; text?: string; line?: string }
							| undefined;
						const chunk = payload?.chunk ?? payload?.text ?? payload?.line;
						if (typeof chunk === 'string' && chunk.length > 0) {
							const splitLines = chunk.split('\n');
							newLines.push(...splitLines);
						}
					}
				}
			}

			if (newLines.length > 0) {
				manager.appendLiveLines(newLines);
			}
		});

		return () => {
			unsubscribe();
		};
	}, [runId, autoSubscribeEvents, manager]);

	// 3. 向上加载更多（E-143 / E-98 / AC 2 / R5 d）
	const loadOlder = useCallback(async () => {
		if (!getRunLogRoute) {
			throw new Error('getRunLogRoute missing from ROUTES');
		}

		const cursor = manager.getOldestCursor();
		if (!cursor || isLoadingOlder) {
			return;
		}

		setIsLoadingOlder(true);
		try {
			const res = await httpClient.callRoute<GetRunLogResponse>(getRunLogRoute, {
				params: { runId },
				query: {
					fromSeq: cursor,
					direction: 'backward',
					limit: segmentLimit,
				},
			});
			manager.prependOlderSegment(res);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
		} finally {
			setIsLoadingOlder(false);
		}
	}, [runId, segmentLimit, manager, isLoadingOlder]);

	// 4. 向下重拉已驱逐的较新片段（AC 2 滚出重拉 / R5 d）
	const loadNewer = useCallback(async () => {
		if (!getRunLogRoute) {
			throw new Error('getRunLogRoute missing from ROUTES');
		}

		const cursor = manager.getNewestCursor();
		if (!cursor || isLoadingNewer) {
			return;
		}

		setIsLoadingNewer(true);
		try {
			const res = await httpClient.callRoute<GetRunLogResponse>(getRunLogRoute, {
				params: { runId },
				query: {
					fromSeq: cursor,
					direction: 'forward',
					limit: segmentLimit,
				},
			});
			manager.appendNewerSegment(res);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
		} finally {
			setIsLoadingNewer(false);
		}
	}, [runId, segmentLimit, manager, isLoadingNewer]);

	// 5. 滚动位置跟踪（AC 3 / E-100）
	const handleScroll = useCallback(
		(_event: UIEvent<HTMLDivElement>, info: VirtualScrollInfo) => {
			manager.setAtBottom(info.isAtBottom);
		},
		[manager],
	);

	// 6. 重置未读并贴底
	const handleResetUnread = useCallback(() => {
		manager.resetUnreadCount();
	}, [manager]);

	// 7. 直接追加实时行
	const appendLiveLines = useCallback(
		(lines: readonly string[]) => {
			manager.appendLiveLines(lines);
		},
		[manager],
	);

	return {
		state,
		isLoadingInitial,
		isLoadingOlder,
		isLoadingNewer,
		error,
		loadOlder,
		loadNewer,
		handleScroll,
		handleResetUnread,
		appendLiveLines,
	};
}
