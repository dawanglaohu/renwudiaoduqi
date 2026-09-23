/**
 * packages/web/src/features/run-deck/wrapup-panel-container.tsx
 *
 * 收口报告面板容器与批次收口动作（M9-T20 / AC 2, AC 3, AC 5, E-157, E-297, E-74 批次侧）
 *
 * 规范依据（07 节前端架构）：
 * - features 层是唯一允许 import src/api、订阅 event-bus 的一层；路径与鉴权一律取自
 *   `@agent-scheduler/shared/api/routes` 的 ROUTES 表，本文件不拼 URL 字面量
 * - **写操作不拿响应体改状态**：`POST /batches/:id/wrapup` 只判是否被接受，随后把控件置为
 *   「已接受、等回流」，批次状态一律等 `batch.wrapup_started` / `batch.wrapup_finished` 事件（E-157）
 * - 收口被拒按 `details.reason` 取具名中文文案（E_BATCH_NOT_WRAPPABLE / E_WRAPUP_ROUND_LIMIT），
 *   文案唯一定义在 src/i18n/error-messages.ts，本文件不写中文错误字符串
 * - 解析失败的一轮不来自「前端解析 reportText」：daemon 在 `batch.wrapup_finished` 里明写
 *   `verdict='unparsed'`，本容器只据该字段记一条「解析失败」条目并给直链原文（E-274 / E-297）
 * - 批次级落地清单的行由 daemon 的收口记录与运行行拼出（`inHead` 逐字取 RunDto.isInHead），
 *   复制而不执行（E-74）
 * - 展示层只吃 daemon 字段；本文件里不出现颜色字号圆角，只写 flex/grid/gap 布局类
 */

import type {
	BatchWrapupDto,
	GetBatchWrapupsResponse,
	WrapupBatchBody,
	WrapupBatchResponse,
} from '@agent-scheduler/shared/api/batches';
import type {
	BatchWrapupFinishedPayload,
	BatchWrapupStartedPayload,
	EventEnvelope,
} from '@agent-scheduler/shared/api/events';
import { ROUTES, type RouteDefinition } from '@agent-scheduler/shared/api/routes';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type EventBus, eventBus as defaultEventBus } from '../../api/event-bus.ts';
import { generateIdempotencyKey, httpClient, isApiError } from '../../api/http-client.ts';
import { InlineNotice } from '../../components/inline-notice.tsx';
import {
	BatchWrapupControl,
	type BatchWrapupFailureView,
	WrapupReport,
	type WrapupReportEntry,
	type WrapupUnparsableEntry,
} from '../../components/wrapup-report.tsx';
import type { DensityTier } from '../../hooks/use-breakpoint.ts';
import {
	getErrorMessage,
	getWrapupFailureMessage,
	resolveWrapupFailureReason,
} from '../../i18n/error-messages.ts';

const WRAPUP_PATH = '/api/v1/batches/:batchId/wrapup' as const;
const WRAPUPS_PATH = '/api/v1/batches/:batchId/wrapups' as const;

function findRoute(method: 'GET' | 'POST', path: string): RouteDefinition {
	const route = ROUTES.find((entry) => entry.method === method && entry.path === path);
	if (!route) {
		// 契约表缺失时立刻暴露，而不是退回硬编码 URL（07 节：禁止 URL 字面量）
		throw new Error(`${method} ${path} is missing from the shared ROUTES table`);
	}
	return route;
}

const GET_WRAPUPS_ROUTE = findRoute('GET', WRAPUPS_PATH);
const POST_WRAPUP_ROUTE = findRoute('POST', WRAPUP_PATH);

// ─────────────────────────────────────────────────────────────────────────────
// 取数与写操作的可注入实现（单测注入假实现，生产走默认实现）
// ─────────────────────────────────────────────────────────────────────────────

export type WrapupsFetcher = (batchId: string) => Promise<GetBatchWrapupsResponse>;
export type WrapupPoster = (batchId: string, body: WrapupBatchBody) => Promise<WrapupBatchResponse>;

const defaultFetcher: WrapupsFetcher = (batchId) =>
	httpClient.callRoute<GetBatchWrapupsResponse>(GET_WRAPUPS_ROUTE, { params: { batchId } });

const defaultPoster: WrapupPoster = (batchId, body) =>
	httpClient.callRoute<WrapupBatchResponse, WrapupBatchBody>(POST_WRAPUP_ROUTE, {
		params: { batchId },
		body,
	});

/**
 * 收口被拒 → 就地提示内容。文案与原因判定都在 i18n/error-messages.ts，
 * 这里只拼技术详情（错误码 + requestId + daemon 英文短句）。
 */
export function toWrapupFailureView(error: unknown): BatchWrapupFailureView {
	if (isApiError(error)) {
		return {
			reason: resolveWrapupFailureReason(error.code, error.details),
			message: getWrapupFailureMessage(error.code, error.details),
			technical: `${error.code} · ${error.message}${error.requestId ? ` · requestId=${error.requestId}` : ''}`,
		};
	}
	return {
		reason: null,
		message: getErrorMessage('E_INTERNAL'),
		technical: error instanceof Error ? error.message : String(error),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// 批次级落地清单（E-74 批次侧）
// ─────────────────────────────────────────────────────────────────────────────

/** 批次级落地清单的一行：一轮收口分支，或该轮的一个修复分支。 */
export interface BatchLandingRow {
	readonly id: string;
	readonly kind: 'wrapup' | 'fix';
	readonly round: number;
	/** 行首标签（「第 N 轮收口」/「第 N 轮修复 · 任务号」） */
	readonly label: string;
	readonly branchName: string | null;
	readonly worktreePath: string | null;
	readonly diffStat: string | null;
	/** daemon 的 RunDto.isInHead，缺失一律 null（不在前端推断是否进 HEAD） */
	readonly inHead: boolean | null;
	/** 可一键复制的命令文本（复制而不执行，E-74） */
	readonly command: string;
	readonly runId: string | null;
}

export interface BatchLandingList {
	readonly batchId: string;
	readonly batchNo: number | null;
	readonly rows: readonly BatchLandingRow[];
}

/**
 * 拼一条可复制命令：优先在该收口 worktree 里推栈分支（与 daemon 生成落地命令用的
 * gh stack push 同一形态）；没有 worktree 时退回按分支显式 push；两者都缺时给裸命令。
 * 只生成文本，绝不执行。
 */
export function composeBatchLandingCommand(
	worktreePath: string | null | undefined,
	branchName: string | null | undefined,
): string {
	const hasWorktree = Boolean(worktreePath && worktreePath.length > 0);
	const hasBranch = Boolean(branchName && branchName.length > 0);
	if (hasWorktree) {
		return `cd "${worktreePath}" && gh stack push`;
	}
	if (hasBranch) {
		return `git push -u origin "${branchName}"`;
	}
	return 'gh stack push';
}

/**
 * 由收口记录与运行行拼出批次级落地清单：每轮收口一行 + 该轮各修复分支一行。
 * `inHead` 逐字取对应 RunDto.isInHead；取不到运行行时留 null 显示「—」。
 */
export function buildBatchLandingList(input: {
	readonly batchId: string;
	readonly batchNo?: number | null;
	readonly wrapups: readonly BatchWrapupDto[];
	readonly runs?: readonly RunDto[];
}): BatchLandingList {
	const { batchId, batchNo, wrapups, runs = [] } = input;
	const runById = new Map(runs.map((run) => [run.id, run]));
	const rows: BatchLandingRow[] = [];

	const ordered = [...wrapups].sort((a, b) => a.round - b.round);

	for (const wrapup of ordered) {
		const wrapupRun = runById.get(wrapup.runId) ?? null;
		const wrapupWorktree = wrapup.landing?.worktreePath ?? wrapupRun?.worktreePath ?? null;
		const wrapupBranch = wrapup.landing?.branchName ?? wrapupRun?.branchName ?? null;
		rows.push({
			id: `wrapup:${wrapup.id}`,
			kind: 'wrapup',
			round: wrapup.round,
			label: `第 ${wrapup.round} 轮收口`,
			branchName: wrapupBranch,
			worktreePath: wrapupWorktree,
			diffStat: wrapup.landing?.diffStat ?? null,
			inHead: wrapupRun?.isInHead ?? null,
			command: composeBatchLandingCommand(wrapupWorktree, wrapupBranch),
			runId: wrapup.runId,
		});

		for (const fixRunId of wrapup.fixRunIds) {
			const fixRun = runById.get(fixRunId) ?? null;
			rows.push({
				id: `fix:${fixRunId}`,
				kind: 'fix',
				round: wrapup.round,
				label: `第 ${wrapup.round} 轮修复${fixRun?.taskId ? ` · ${fixRun.taskId}` : ''}`,
				branchName: fixRun?.branchName ?? null,
				worktreePath: fixRun?.worktreePath ?? null,
				diffStat: null,
				inHead: fixRun?.isInHead ?? null,
				command: composeBatchLandingCommand(fixRun?.worktreePath, fixRun?.branchName),
				runId: fixRunId,
			});
		}
	}

	return Object.freeze({
		batchId,
		batchNo: batchNo ?? wrapups[0]?.batchNo ?? null,
		rows: Object.freeze(rows),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// 容器
// ─────────────────────────────────────────────────────────────────────────────

export interface WrapupPanelResult {
	readonly entries: readonly WrapupReportEntry[];
	readonly wrapups: readonly BatchWrapupDto[];
	readonly isLoading: boolean;
	readonly error: { readonly message: string; readonly technical?: string } | null;
	/** 请求在途 / 已接受、等 `batch.wrapup_started` 回流（E-157） */
	readonly isWrapupPending: boolean;
	readonly failure: BatchWrapupFailureView | null;
	readonly copiedToken: string | null;
	readonly refetch: () => Promise<void>;
}

export interface WrapupPanelContainerProps {
	/** 批次唯一标识 */
	readonly batchId: string;
	/** 批次序号（呈现用） */
	readonly batchNo?: number | null;
	/** daemon 下发的能否收口 */
	readonly canWrapup?: boolean;
	/** 密度档位 */
	readonly tier?: DensityTier;
	/** 粗指针触控环境 */
	readonly isTouch?: boolean;
	/** 是否手机档（不出「收口」按钮，E-297） */
	readonly isPhoneTier?: boolean;
	/** 预填收口记录（单测或静态装配，给了就不发首次请求） */
	readonly initialWrapups?: readonly BatchWrapupDto[];
	/** 初始拒绝提示（单测用） */
	readonly initialFailure?: BatchWrapupFailureView | null;
	/** 外部已知的解析失败轮次（daemon 事件里带着 round/runId） */
	readonly unparsableEntries?: readonly WrapupUnparsableEntry[];
	/** 该批运行行（拼落地清单的 inHead / 分支用） */
	readonly runs?: readonly RunDto[];
	/** 收口请求体（agentId / model / effortTier 由调用方按 daemon 字段下传；idempotencyKey 缺省时本容器生成） */
	readonly wrapupRequest?: WrapupBatchBody | null;
	/** 可注入的取数实现（单测用） */
	readonly fetcher?: WrapupsFetcher;
	/** 可注入的写操作实现（单测用） */
	readonly wrapupPoster?: WrapupPoster;
	/** 可注入的事件总线（单测用） */
	readonly bus?: EventBus;
	/** findings 整行点击：跳该任务 */
	readonly onOpenTask?: (taskKey: string) => void;
	/** 直链原文：跳该收口运行 */
	readonly onOpenRun?: (runId: string) => void;
	/** `batch.wrapup_started` 回流回调（调用方据此刷新批次树，不在响应体上改状态） */
	readonly onWrapupStarted?: (payload: BatchWrapupStartedPayload) => void;
	/** 状态回调（单测捕获 hook 状态用） */
	readonly onResult?: (result: WrapupPanelResult) => void;
	/** 自定义 class（只加布局类） */
	readonly className?: string;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
	try {
		if (
			typeof navigator !== 'undefined' &&
			navigator.clipboard &&
			typeof navigator.clipboard.writeText === 'function'
		) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// 回落至传统复制模式
	}

	try {
		if (typeof document !== 'undefined') {
			const textarea = document.createElement('textarea');
			textarea.value = text;
			textarea.style.position = 'fixed';
			textarea.style.opacity = '0';
			document.body.appendChild(textarea);
			textarea.select();
			const success = document.execCommand('copy');
			document.body.removeChild(textarea);
			return success;
		}
	} catch {
		// 剪贴板均不可用
	}
	return false;
}

/**
 * 收口报告面板容器：取数、写操作在途态、事件回流、复制。
 *
 * 直接摆在该批标题之下：`BatchWrapupControl` 的拒绝文案因此天然贴在该批标题下（AC 3）。
 */
export function WrapupPanelContainer(props: WrapupPanelContainerProps) {
	const {
		batchId,
		batchNo,
		canWrapup = false,
		tier,
		isTouch = false,
		isPhoneTier = false,
		initialWrapups,
		initialFailure = null,
		unparsableEntries,
		runs,
		wrapupRequest,
		fetcher,
		wrapupPoster,
		bus,
		onOpenTask,
		onOpenRun,
		onWrapupStarted,
		onResult,
		className,
	} = props;

	const hasInitial = Boolean(initialWrapups);
	const [wrapups, setWrapups] = useState<readonly BatchWrapupDto[]>(initialWrapups ?? []);
	const [isLoading, setIsLoading] = useState(!hasInitial);
	const [error, setError] = useState<WrapupPanelResult['error']>(null);
	const [isWrapupPending, setIsWrapupPending] = useState(false);
	const [failure, setFailure] = useState<BatchWrapupFailureView | null>(initialFailure);
	const [copiedToken, setCopiedToken] = useState<string | null>(null);
	const [unparsable, setUnparsable] = useState<readonly WrapupUnparsableEntry[]>(
		unparsableEntries ?? [],
	);

	// 最新实现与回调放 ref，事件订阅只在 batchId / bus 变化时重挂
	const fetcherRef = useRef<WrapupsFetcher>(fetcher ?? defaultFetcher);
	fetcherRef.current = fetcher ?? defaultFetcher;
	const posterRef = useRef<WrapupPoster>(wrapupPoster ?? defaultPoster);
	posterRef.current = wrapupPoster ?? defaultPoster;
	const onWrapupStartedRef = useRef(onWrapupStarted);
	onWrapupStartedRef.current = onWrapupStarted;
	const requestRef = useRef<WrapupBatchBody | null>(wrapupRequest ?? null);
	requestRef.current = wrapupRequest ?? null;
	// 同一次收口的重试必须复用同一个幂等键（07 节：写请求重试复用同一个 key）
	const idempotencyKeyRef = useRef<string | null>(null);

	const refetch = useCallback(async () => {
		try {
			const response = await fetcherRef.current(batchId);
			setWrapups(response.wrapups);
			setError(null);
		} catch (cause: unknown) {
			setError(
				isApiError(cause)
					? {
							message: getErrorMessage(cause.code),
							technical: `${cause.code} · ${cause.message}`,
						}
					: {
							message: getErrorMessage('E_INTERNAL'),
							technical: cause instanceof Error ? cause.message : String(cause),
						},
			);
		} finally {
			setIsLoading(false);
		}
	}, [batchId]);

	// 首次取数：给了 initialWrapups 就不发请求（静态装配与单测路径）
	useEffect(() => {
		if (hasInitial) {
			setIsLoading(false);
			return;
		}
		let isCurrent = true;
		setIsLoading(true);
		const run = async () => {
			try {
				const response = await fetcherRef.current(batchId);
				if (isCurrent) {
					setWrapups(response.wrapups);
					setError(null);
				}
			} catch (cause: unknown) {
				if (isCurrent) {
					setError(
						isApiError(cause)
							? {
									message: getErrorMessage(cause.code),
									technical: `${cause.code} · ${cause.message}`,
								}
							: {
									message: getErrorMessage('E_INTERNAL'),
									technical: cause instanceof Error ? cause.message : String(cause),
								},
					);
				}
			} finally {
				if (isCurrent) {
					setIsLoading(false);
				}
			}
		};
		void run();
		return () => {
			isCurrent = false;
		};
	}, [batchId, hasInitial]);

	// 事件回流：接受后不改状态，等 batch.wrapup_started / _finished（E-157）
	useEffect(() => {
		const busInstance = bus ?? defaultEventBus;
		const unsubscribe = busInstance.subscribeMilestone((envelope: EventEnvelope) => {
			if (envelope.kind === 'batch.wrapup_started') {
				const payload = envelope.payload as BatchWrapupStartedPayload | undefined;
				if (payload?.batchId !== batchId) return;
				setIsWrapupPending(false);
				setFailure(null);
				void refetch();
				onWrapupStartedRef.current?.(payload);
				return;
			}
			if (envelope.kind === 'batch.wrapup_finished') {
				const payload = envelope.payload as BatchWrapupFinishedPayload | undefined;
				if (payload?.batchId !== batchId) return;
				setIsWrapupPending(false);
				if (payload.verdict === 'unparsed') {
					// daemon 明写「解析不出八段」，不是前端解析结论：只据该字段记一条解析失败条目
					setUnparsable((prev) =>
						prev.some((item) => item.runId === payload.runId)
							? prev
							: [...prev, { kind: 'unparsable', round: payload.round, runId: payload.runId }],
					);
				}
				void refetch();
			}
		});
		return unsubscribe;
	}, [batchId, bus, refetch]);

	// 外部新给的解析失败轮次并入（去重，不覆盖已有原始全文）
	useEffect(() => {
		if (!unparsableEntries || unparsableEntries.length === 0) return;
		setUnparsable((prev) => {
			const known = new Set(prev.map((item) => item.runId));
			const merged = [...prev];
			for (const item of unparsableEntries) {
				if (!known.has(item.runId)) {
					merged.push(item);
				}
			}
			return merged.length === prev.length ? prev : merged;
		});
	}, [unparsableEntries]);

	const startWrapup = useCallback(async () => {
		if (!batchId || isWrapupPending) return;
		setIsWrapupPending(true);
		setFailure(null);
		idempotencyKeyRef.current ??= generateIdempotencyKey();
		const body: WrapupBatchBody = {
			...requestRef.current,
			idempotencyKey: requestRef.current?.idempotencyKey ?? idempotencyKeyRef.current,
		};
		try {
			// 只判是否被接受；批次状态一律等回流事件（E-157）
			await posterRef.current(batchId, body);
		} catch (cause: unknown) {
			setIsWrapupPending(false);
			setFailure(toWrapupFailureView(cause));
		}
	}, [batchId, isWrapupPending]);

	const copy = useCallback(async (token: string, text: string) => {
		if (!text || text === '—') return;
		const ok = await copyTextToClipboard(text);
		if (!ok) return;
		setCopiedToken(token);
		setTimeout(() => {
			setCopiedToken((prev) => (prev === token ? null : prev));
		}, 2000);
	}, []);

	const entries: readonly WrapupReportEntry[] = useMemo(() => {
		const parsed: WrapupReportEntry[] = wrapups.map((wrapup) => ({ kind: 'parsed', wrapup }));
		const failed: WrapupReportEntry[] = [...unparsable];
		return [...parsed, ...failed].sort((a, b) => {
			const roundA = a.kind === 'parsed' ? a.wrapup.round : a.round;
			const roundB = b.kind === 'parsed' ? b.wrapup.round : b.round;
			return roundA - roundB;
		});
	}, [wrapups, unparsable]);

	const landingList = useMemo(
		() => buildBatchLandingList({ batchId, batchNo, wrapups, runs }),
		[batchId, batchNo, wrapups, runs],
	);

	onResult?.({
		entries,
		wrapups,
		isLoading,
		error,
		isWrapupPending,
		failure,
		copiedToken,
		refetch,
	});

	return (
		<div
			data-component="wrapup-panel"
			data-batch-id={batchId}
			data-landing-row-count={landingList.rows.length}
			className={['flex flex-col gap-3', className ?? ''].join(' ').trim()}
		>
			<BatchWrapupControl
				canWrapup={canWrapup}
				isPhoneTier={isPhoneTier}
				isPending={isWrapupPending}
				failure={failure}
				onWrapup={() => {
					void startWrapup();
				}}
				isTouch={isTouch}
			/>

			{error && (
				<div className="flex flex-col gap-2">
					<InlineNotice
						tone="down"
						testId="wrapup-fetch-error"
						message={error.message}
						technical={error.technical}
					/>
				</div>
			)}

			{!isLoading && entries.length > 0 && (
				<div className="flex flex-col gap-3">
					{entries.map((entry) => (
						<WrapupReport
							key={
								entry.kind === 'parsed' ? `wrapup:${entry.wrapup.id}` : `unparsable:${entry.runId}`
							}
							entry={entry}
							tier={tier}
							isTouch={isTouch}
							copiedToken={copiedToken}
							onCopyField={(token, text) => {
								void copy(token, text);
							}}
							onOpenTask={onOpenTask}
							onOpenRun={onOpenRun}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export default WrapupPanelContainer;
