/**
 * packages/web/src/features/run-detail/run-detail-container.tsx
 *
 * 运行详情与日志窗口容器（M9-T8 / AC 1, AC 2, AC 3, E-98, E-100, E-143）
 *
 * 规范依据（07 节前端架构）：
 * - features 容器层：只负责拼装展示组件与连接数据源
 * - 容器里只许写 grid/flex/gap，禁止写颜色字号圆角（07 节架构硬性规则）
 * - 虚拟滚动经 components/virtual-rows.tsx 使用（AC 6）
 * - 贴底时行数增长自动跟随；中部时绝不跳底（AC 3 / E-100 / R1）
 * - 透传 refreshCount 与折叠状态给 LogLine（AC 4 / E-101 / R3）
 * - 连接 loadNewer 触发点供滚出重拉（AC 2 / R5 e）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ROUTES } from '../../../../shared/src/api/routes.ts';
import type {
	GetRunResponse,
	RunDto,
	SearchRunLogResponse,
} from '../../../../shared/src/api/runs.ts';
import { httpClient, isApiError } from '../../api/http-client.ts';
import {
	LogBottomNotice,
	LogLine,
	LogLoadNewerBar,
	LogThresholdBanner,
} from '../../components/log-lines.tsx';
import { SessionSearchEntrance } from '../../components/session-search-entrance.tsx';
import { VirtualRows, type VirtualRowsHandle } from '../../components/virtual-rows.tsx';
import { useDensityTier } from '../../hooks/use-breakpoint.ts';
import { MobileRerunBar } from './mobile-rerun-bar.tsx';
import { RerunConfirmDialog } from './rerun-confirm-dialog.tsx';
import { type PermissionBlockedInfo, useLogWindow } from './use-log-window.ts';
import { useRunRerun } from './use-run-rerun.ts';

const searchRunRoute = ROUTES.find(
	(r) => r.method === 'GET' && r.path === '/api/v1/runs/:runId/search',
);
const createRunMessageRoute = ROUTES.find(
	(r) => r.method === 'POST' && r.path === '/api/v1/runs/:runId/messages',
);

export interface RunDetailContainerProps {
	/** 运行编号 */
	readonly runId: string;
	/** 容器布局外层类名（只许包含 flex/grid/gap/尺寸，不包含颜色圆角） */
	readonly className?: string;
	/** 用系统默认程序打开原始文件的外部回调（E-98） */
	readonly onOpenOriginalFile?: (filePath: string) => void;
	/** 运行状态（可选覆盖，如已从外部获取） */
	readonly runStatus?: string;
	/** 运行详情 DTO（可选覆盖） */
	readonly run?: RunDto | null;
	/** 关联任务代号（可选） */
	readonly taskKey?: string;
	/** 是否强制使用手机端模式（可选覆盖） */
	readonly isMobile?: boolean;
	/** 权限受阻事件覆盖（供测试或上层显式指定，E-133） */
	readonly permissionBlocked?: PermissionBlockedInfo | null;
	/** 临时提升回调覆盖（供测试模拟，E-133） */
	readonly onElevateOnce?: () => Promise<void> | void;
}

/**
 * 运行详情与日志窗口容器组件。
 */
export function RunDetailContainer({
	runId,
	className,
	onOpenOriginalFile,
	runStatus,
	run,
	taskKey,
	isMobile,
	permissionBlocked: propPermissionBlocked,
	onElevateOnce,
}: RunDetailContainerProps) {
	const virtualRef = useRef<VirtualRowsHandle | null>(null);
	const [expandedIndices, setExpandedIndices] = useState<ReadonlySet<number>>(() => new Set());
	const [expandedProgressIndices, setExpandedProgressIndices] = useState<ReadonlySet<number>>(
		() => new Set(),
	);

	// E-99：手机档首屏只拉尾部轻量窗口（32KB 量级），桌面档保持 2000 行。
	// 档位仍由单点计算器 useDensityTier() 给出（E-235），这里只是消费它，不另立判定。
	const { tier } = useDensityTier();
	const isMobileTier = isMobile ?? (tier === 'phone' || tier === 'phone-xs');

	// M9-T13: 手机原样重跑逻辑与状态连接（AC 1, AC 3, E-177, E-181, R2, R3）
	const {
		run: currentRun,
		isTerminalFailureOrAborted,
		canRerun,
		isRerunning,
		hasActiveRun,
		isConfirmOpen,
		error: rerunError,
		techError: rerunTechError,
		requestId: rerunRequestId,
		openConfirm,
		closeConfirm,
		executeRerun,
	} = useRunRerun({
		runId,
		initialRun: run,
		initialStatus: runStatus,
	});

	// E-218: 会话视图显式全会话检索状态（AC 5, M6-T9）
	const [searchResult, setSearchResult] = useState<SearchRunLogResponse | null>(null);
	const [isSearching, setIsSearching] = useState<boolean>(false);
	const [searchError, setSearchError] = useState<string | null>(null);

	const handleSearch = useCallback(
		async (query: string) => {
			if (!query.trim() || !searchRunRoute) return;
			setIsSearching(true);
			setSearchError(null);
			try {
				const res = await httpClient.callRoute<SearchRunLogResponse>(searchRunRoute, {
					params: { runId },
					query: { q: query },
				});
				setSearchResult(res);
			} catch (err) {
				setSearchError(err instanceof Error ? err.message : String(err));
			} finally {
				setIsSearching(false);
			}
		},
		[runId],
	);

	const [isElevating, setIsElevating] = useState(false);
	const [isElevated, setIsElevated] = useState(false);
	const [elevateError, setElevateError] = useState<string | null>(null);

	const {
		state,
		permissionBlocked: windowPermissionBlocked,
		isLoadingOlder,
		isLoadingNewer,
		loadOlder,
		loadNewer,
		handleScroll,
		handleResetUnread,
	} = useLogWindow({ runId, isMobile: isMobileTier });

	const effectivePermissionBlocked =
		propPermissionBlocked !== undefined ? propPermissionBlocked : windowPermissionBlocked;

	const handleElevateOnce = useCallback(async () => {
		if (isElevating || isElevated) return;
		setIsElevating(true);
		setElevateError(null);
		try {
			if (onElevateOnce) {
				await onElevateOnce();
			} else if (createRunMessageRoute) {
				await httpClient.callRoute(createRunMessageRoute, {
					params: { runId },
					body: { kind: 'elevate_once' },
				});
			}
			setIsElevated(true);
		} catch (err) {
			const code = isApiError(err)
				? err.code
				: typeof (err as { code?: unknown })?.code === 'string'
					? String((err as { code: unknown }).code)
					: err instanceof Error
						? err.message
						: String(err);
			setElevateError(code);
		} finally {
			setIsElevating(false);
		}
	}, [runId, isElevating, isElevated, onElevateOnce]);

	// R1 (AC 3 / E-100): 贴底且尾部增长时自动跟随；isAtBottom 为 false 时绝不跳底。
	// 审查方修正：增长信号取 state.totalLines——它单调递增且把被折叠的刷新行也计进去；
	// 原先用 retainedLinesCount 时，进度条刷新行折叠不增计数、满 6 段驱逐头部还会让计数下降，
	// 两种情况都会漏掉尾部跟随。
	const prevTotalRef = useRef(-1);
	useEffect(() => {
		const hasGrown = state.totalLines > prevTotalRef.current;
		prevTotalRef.current = state.totalLines;
		if (hasGrown && state.isAtBottom) {
			virtualRef.current?.scrollToBottom();
		}
	}, [state.totalLines, state.isAtBottom]);

	const handleScrollToBottom = useCallback(() => {
		virtualRef.current?.scrollToBottom();
		handleResetUnread();
	}, [handleResetUnread]);

	const handleToggleExpand = useCallback((index: number) => {
		setExpandedIndices((prev) => {
			const next = new Set(prev);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			return next;
		});
	}, []);

	const handleToggleProgressCollapse = useCallback((index: number) => {
		setExpandedProgressIndices((prev) => {
			const next = new Set(prev);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			return next;
		});
	}, []);

	const handleOpenOriginal = useCallback(() => {
		if (state.originalFilePath) {
			onOpenOriginalFile?.(state.originalFilePath);
		}
	}, [state.originalFilePath, onOpenOriginalFile]);

	return (
		<div
			data-component="run-detail-container"
			className={`flex flex-col h-full gap-2 relative ${className ?? ''}`}
		>
			{/* E-218 顶部显式「在整个会话中查找」入口 */}
			<SessionSearchEntrance
				onSearch={handleSearch}
				isSearching={isSearching}
				searchResult={searchResult}
				error={searchError}
			/>

			{/* E-98 顶部体积警告与历史分段加载栏 */}
			<LogThresholdBanner
				hasOlder={state.hasOlder}
				isExceedsThreshold={state.isExceedsThreshold}
				originalFilePath={state.originalFilePath}
				isLoadingOlder={isLoadingOlder}
				onLoadOlder={loadOlder}
				onOpenOriginal={state.originalFilePath ? handleOpenOriginal : undefined}
			/>

			{/* E-133 权限受阻横幅与一次性临时提升按钮 */}
			{effectivePermissionBlocked && (
				<PermissionBlockedBanner
					info={effectivePermissionBlocked}
					isElevating={isElevating}
					isElevated={isElevated}
					error={elevateError}
					onElevateOnce={handleElevateOnce}
				/>
			)}

			{/* 虚拟滚动列表展示区（AC 1, AC 6, E-143） */}
			<div className="flex-1 min-h-0 relative">
				<VirtualRows
					ref={virtualRef}
					count={state.lines.length}
					estimateSize={22}
					renderItem={({ index }) => {
						const line = state.lines[index];
						if (!line) {
							return null;
						}
						return (
							<LogLine
								index={index}
								lineNumber={line.globalIndex + 1}
								text={line.text}
								isExpanded={expandedIndices.has(index)}
								onToggleExpand={handleToggleExpand}
								refreshCount={line.refreshCount}
								isProgressCollapsed={!expandedProgressIndices.has(index)}
								onToggleProgressCollapse={handleToggleProgressCollapse}
								collapsedLines={line.collapsedLines}
							/>
						);
					}}
					onScroll={handleScroll}
					className="h-full w-full"
				/>

				{/* AC 3 / E-100: 滚到中部时新事件到达不自动跳底，显示浮动未读提示 */}
				{state.unreadNewCount > 0 && !state.isAtBottom && (
					<LogBottomNotice unreadCount={state.unreadNewCount} onClick={handleScrollToBottom} />
				)}
			</div>

			{/* R5 e: 底部向下重新加载较新分段触发点（AC 2 滚出重拉） */}
			{state.hasNewer && <LogLoadNewerBar isLoading={isLoadingNewer} onClick={loadNewer} />}

			{/* M9-T13 / AC 1-5, E-177, E-181, R3: 流详情页日志末尾整宽重跑入口（仅限手机端，不进拇指条） */}
			{isMobileTier && isTerminalFailureOrAborted && (
				<MobileRerunBar
					isTerminalFailureOrAborted={isTerminalFailureOrAborted}
					canRerun={canRerun}
					isRerunning={isRerunning}
					hasActiveRun={hasActiveRun}
					isMobile={isMobileTier}
					onTriggerRerun={openConfirm}
					error={rerunError}
					techError={rerunTechError}
					requestId={rerunRequestId}
				/>
			)}

			{/* 手机原样重跑二次确认弹窗（07 节 Dialog 白名单，需一次确认） */}
			<RerunConfirmDialog
				isOpen={isConfirmOpen}
				taskKey={taskKey ?? currentRun?.taskId ?? undefined}
				runId={runId}
				agentName={currentRun?.agentId}
				isSubmitting={isRerunning}
				onConfirm={executeRerun}
				onCancel={closeConfirm}
			/>
		</div>
	);
}

// 同时导出别名 LogWindowContainer 以便按语境调用
export { RunDetailContainer as LogWindowContainer };

const getRunRoute = ROUTES.find(
	(route) => route.method === 'GET' && route.path === '/api/v1/runs/:runId',
);

export type RunFetcher = (runId: string) => Promise<GetRunResponse>;

interface RunDetailPageState {
	readonly isLoading: boolean;
	readonly isMissing: boolean;
	readonly error: string | null;
}

async function fetchRun(runId: string): Promise<GetRunResponse> {
	if (!getRunRoute) throw new Error('Get run route is missing from shared ROUTES');
	return httpClient.callRoute<GetRunResponse>(getRunRoute, { params: { runId } });
}

export function useRunDetailPage(
	runId: string,
	fetcher: RunFetcher = fetchRun,
	skipInitialLoad = false,
): RunDetailPageState {
	const [state, setState] = useState<RunDetailPageState>({
		isLoading: !skipInitialLoad,
		isMissing: false,
		error: null,
	});

	useEffect(() => {
		if (skipInitialLoad) {
			setState({ isLoading: false, isMissing: false, error: null });
			return;
		}

		let isCancelled = false;
		setState({ isLoading: true, isMissing: false, error: null });

		void (async () => {
			try {
				await fetcher(runId);
				if (!isCancelled) {
					setState({ isLoading: false, isMissing: false, error: null });
				}
			} catch (error) {
				if (!isCancelled) {
					if (isApiError(error) && error.code === 'E_NOT_FOUND') {
						setState({ isLoading: false, isMissing: true, error: null });
						return;
					}
					setState({
						isLoading: false,
						isMissing: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		})();

		return () => {
			isCancelled = true;
		};
	}, [fetcher, runId, skipInitialLoad]);

	return state;
}

export function RunDetailPageContainer({
	runId,
	runFetcher,
	...containerProps
}: {
	readonly runId: string;
	readonly runFetcher?: RunFetcher;
} & Omit<RunDetailContainerProps, 'runId'>) {
	const hasInitialRun = Boolean(containerProps.run);
	const state = useRunDetailPage(runId, runFetcher, hasInitialRun);
	if (!hasInitialRun && state.isLoading) return <p className="p-4 text-ink-3">正在加载运行…</p>;
	if (state.isMissing) {
		return (
			<output
				data-run-missing="true"
				className="flex flex-col items-center justify-center p-8 text-center text-ink-2 gap-2"
			>
				<h1 className="text-lead font-semibold text-ink-1">该运行不存在或已被清理</h1>
				<p className="font-mono text-meta text-ink-3">{runId || '—'}</p>
			</output>
		);
	}
	if (!hasInitialRun && state.error)
		return (
			<p role="alert" className="p-4 text-warn">
				加载运行失败：{state.error}
			</p>
		);
	return (
		<RunDetailContainer
			runId={runId}
			{...containerProps}
			className={`min-h-0 flex-1 ${containerProps.className ?? ''}`}
		/>
	);
}

export interface PermissionBlockedBannerProps {
	readonly info: PermissionBlockedInfo;
	readonly isElevating?: boolean;
	readonly isElevated?: boolean;
	readonly error?: string | null;
	readonly onElevateOnce?: () => void;
}

/**
 * 权限受阻横幅展示组件（E-133 / AC 4）。
 *
 * 遵循 07 节前端架构规范：
 * - 纯展示组件，内部使用 CSS 变量与 design tokens
 * - 以 needs 暖色高亮展示，警示权限阻断
 * - 提供一次性「仅本次运行临时提升」操作按钮
 */
export function PermissionBlockedBanner({
	info,
	isElevating = false,
	isElevated = false,
	error = null,
	onElevateOnce,
}: PermissionBlockedBannerProps) {
	return (
		<div
			data-permission-blocked-banner="true"
			className="flex items-center justify-between gap-3 px-3 py-2 border border-[var(--needs)] bg-[var(--needs-soft)] text-[var(--ink-1)] rounded-[var(--r-sm)] text-[length:var(--fs-dense)] leading-[var(--lh-ui)]"
		>
			<div className="flex flex-col gap-0.5 min-w-0">
				<div className="flex items-center gap-1.5 font-medium text-[var(--needs-ink)]">
					<span>权限受阻 (E-133)</span>
					{info.tool ? <span className="opacity-80">· 工具: {info.tool}</span> : null}
				</div>
				<div className="text-[length:var(--fs-meta)] text-[var(--ink-2)] truncate">
					{info.reason || 'Agent 试图访问或修改沙箱工作区外的资源'}
				</div>
				{error ? (
					<div
						data-elevate-error="true"
						className="text-[length:var(--fs-meta)] text-[var(--down)] font-mono font-medium"
					>
						{error}
					</div>
				) : null}
			</div>
			<div className="shrink-0 flex items-center">
				<button
					type="button"
					data-elevate-button="true"
					disabled={isElevated || isElevating}
					onClick={onElevateOnce}
					className={`h-[var(--h-btn-sm)] px-3 text-[length:var(--fs-meta)] font-medium rounded-[var(--r-sm)] border transition-colors ${
						isElevated
							? 'border-[var(--border)] bg-[var(--panel-2)] text-[var(--ink-3)] cursor-not-allowed'
							: 'border-[var(--needs)] bg-[var(--needs)] text-[var(--on-needs)] hover:opacity-90 active:opacity-80'
					}`}
				>
					{isElevated ? '已临时提升' : '仅本次运行临时提升'}
				</button>
			</div>
		</div>
	);
}
