/**
 * packages/web/src/features/run-deck/wrapup-panel-container.tsx
 *
 * 批次收口状态与收口报告面板容器（M9-T20 / AC 2, AC 3, AC 5, E-157, E-297, E-74 批次侧）
 *
 * 规范依据（07 节前端架构）：
 * - features 是唯一允许 import src/api、订阅 event-bus 的一层；路由一律按共享路由表自身的
 *   `reqType`/`resType` 取（R5），本文件不出现 API URL 字面量
 * - **写操作不拿响应体改状态**：`POST /batches/:id/wrapup` 只判是否被接受，随后该批控件置为
 *   「已接受、等回流」，批次状态一律等 `batch.wrapup_started` / `batch.wrapup_finished`（E-157）
 * - 收口按钮只有一颗，长在批次树第 4 槽；本模块只提供该按钮的状态与动作，并渲染报告卡片，
 *   绝不另画一颗按钮（R2）
 * - 状态按批次放在模块级 store，运行甲板与任务列表页共用同一份；订阅快照是整数 version（07 节）
 * - 解析失败的一轮不来自「前端解析 reportText」：daemon 在 `batch.wrapup_finished` 里明写
 *   `verdict='unparsed'`，本模块只据该字段记一条「解析失败」条目并给直链原文（E-274 / E-297）
 * - 批次级落地清单的行由 daemon 的收口记录与运行行拼出（`inHead` 逐字取 RunDto.isInHead），
 *   复制而不执行（E-74）
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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { type EventBus, eventBus as defaultEventBus } from '../../api/event-bus.ts';
import { generateIdempotencyKey, httpClient, isApiError } from '../../api/http-client.ts';
import { InlineNotice } from '../../components/inline-notice.tsx';
import {
	type BatchLandingChecklistRow,
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

/**
 * 按共享路由表自身的字段取路由定义（R5）：不重复写 URL 字面量，也不另建一张路径表。
 * 契约表里 `resType`/`reqType` 与 shared 的类型名同名且唯一，改了契约这里会立刻抛错而不是静默走错路径。
 */
function findRouteByTypes(
	method: 'GET' | 'POST',
	types: { readonly resType?: string; readonly reqType?: string },
): RouteDefinition {
	const route = ROUTES.find(
		(entry) =>
			entry.method === method &&
			(types.resType === undefined || entry.resType === types.resType) &&
			(types.reqType === undefined || entry.reqType === types.reqType),
	);
	if (!route) {
		// 契约表缺失时立刻暴露，而不是退回硬编码 URL（07 节：禁止 URL 字面量）
		throw new Error(
			`${method} route with ${JSON.stringify(types)} is missing from the shared ROUTES table`,
		);
	}
	return route;
}

const GET_WRAPUPS_ROUTE = findRouteByTypes('GET', { resType: 'GetBatchWrapupsResponse' });
const POST_WRAPUP_ROUTE = findRouteByTypes('POST', { reqType: 'WrapupBatchBody' });

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

export interface BatchLandingList {
	readonly batchId: string;
	readonly batchNo: number | null;
	readonly rows: readonly BatchLandingChecklistRow[];
}

/**
 * 可复制的栈命令在清单所列 worktree 内执行。路径和分支单独显示，避免把来自
 * daemon 的路径插进 shell 命令；缺路径时也绝不退化成普通 git push（E-74）。
 */
export function composeBatchLandingCommand(
	_worktreePath: string | null | undefined,
	_branchName: string | null | undefined,
): string {
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
	const rows: BatchLandingChecklistRow[] = [];

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
// 模块级批次收口 store（运行甲板与任务列表页共用同一份，R2）
// ─────────────────────────────────────────────────────────────────────────────

/** 单个批次的收口状态。 */
export interface BatchWrapupEntry {
	/** 请求在途 / 已接受、等 `batch.wrapup_started` 回流（E-157） */
	readonly isPending: boolean;
	/** 最近一次收口被拒的具名原因 */
	readonly failure: BatchWrapupFailureView | null;
	/** 已解析的收口记录（每轮一条） */
	readonly wrapups: readonly BatchWrapupDto[];
	/** daemon 明写解析不出八段的轮次 */
	readonly unparsable: readonly WrapupUnparsableEntry[];
	/** 取数失败的就地提示 */
	readonly error: { readonly message: string; readonly technical?: string } | null;
	readonly isLoading: boolean;
}

const EMPTY_ENTRY: BatchWrapupEntry = Object.freeze({
	isPending: false,
	failure: null,
	wrapups: Object.freeze([]),
	unparsable: Object.freeze([]),
	error: null,
	isLoading: false,
});

const entries = new Map<string, BatchWrapupEntry>();
const roundByRunId = new Map<string, number>();
const idempotencyKeyByBatch = new Map<string, string>();
const listeners = new Set<() => void>();
let storeVersion = 0;

function emit(): void {
	storeVersion += 1;
	for (const listener of Array.from(listeners)) {
		try {
			listener();
		} catch {
			// 忽略监听器内部非预期异常
		}
	}
}

/** 读取某批当前状态（引用稳定，未变过则返回同一个对象）。 */
export function getBatchWrapupEntry(batchId: string | undefined | null): BatchWrapupEntry {
	if (!batchId) return EMPTY_ENTRY;
	return entries.get(batchId) ?? EMPTY_ENTRY;
}

function patchEntry(
	batchId: string,
	patch: Partial<BatchWrapupEntry>,
	force = false,
): BatchWrapupEntry {
	const current = entries.get(batchId) ?? EMPTY_ENTRY;
	const next = Object.freeze({ ...current, ...patch });
	// 无字段变化时不发通知，避免事件回流引起空转重渲染
	const changed =
		force ||
		Object.keys(patch).some((key) => !Object.is(current[key as never], patch[key as never]));
	if (changed) {
		entries.set(batchId, next);
		emit();
	}
	return next;
}

/** store 的整数 version（useSyncExternalStore 的 getSnapshot 只返回数字，07 节）。 */
export function getBatchWrapupVersion(): number {
	return storeVersion;
}

export function subscribeBatchWrapup(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** 收口轮次：只认 daemon 给的 round（事件 payload 或收口记录的 runId→round），标签缺失显示「—」。 */
export function getWrapupRoundForRun(runId: string | undefined | null): number | null {
	if (!runId) return null;
	return roundByRunId.get(runId) ?? null;
}

function recordRounds(wrapups: readonly BatchWrapupDto[]): void {
	for (const wrapup of wrapups) {
		roundByRunId.set(wrapup.runId, wrapup.round);
	}
}

function toFetchError(cause: unknown): { message: string; technical?: string } {
	if (isApiError(cause)) {
		return {
			message: getErrorMessage(cause.code),
			technical: `${cause.code} · ${cause.message}`,
		};
	}
	return {
		message: getErrorMessage('E_INTERNAL'),
		technical: cause instanceof Error ? cause.message : String(cause),
	};
}

/** 重新拉取某批的收口记录。 */
export async function refetchBatchWrapups(
	batchId: string,
	fetcher?: WrapupsFetcher,
): Promise<void> {
	if (!batchId) return;
	patchEntry(batchId, { isLoading: true });
	try {
		const response = await (fetcher ?? defaultFetcher)(batchId);
		recordRounds(response.wrapups);
		patchEntry(batchId, { wrapups: response.wrapups, error: null, isLoading: false });
	} catch (cause: unknown) {
		patchEntry(batchId, { error: toFetchError(cause), isLoading: false });
	}
}

function addUnparsable(batchId: string, entry: WrapupUnparsableEntry): void {
	const current = getBatchWrapupEntry(batchId);
	if (current.unparsable.some((item) => item.runId === entry.runId)) {
		return;
	}
	patchEntry(batchId, { unparsable: [...current.unparsable, entry] });
}

/**
 * 发起一轮收口（E-157）。
 *
 * 只判是否被接受：成功后**不改任何批次状态**，控件保持禁用等 `batch.wrapup_started` 回流；
 * 失败把具名原因记进该批状态。同一次收口的重试复用同一个幂等键。
 */
export async function startBatchWrapup(
	batchId: string,
	body?: WrapupBatchBody | null,
	poster?: WrapupPoster,
): Promise<boolean> {
	if (!batchId) return false;
	if (getBatchWrapupEntry(batchId).isPending) return false;

	patchEntry(batchId, { isPending: true, failure: null });
	const key =
		body?.idempotencyKey ?? idempotencyKeyByBatch.get(batchId) ?? generateIdempotencyKey();
	idempotencyKeyByBatch.set(batchId, key);

	try {
		await (poster ?? defaultPoster)(batchId, { ...body, idempotencyKey: key });
		return true;
	} catch (cause: unknown) {
		patchEntry(batchId, { isPending: false, failure: toWrapupFailureView(cause) });
		return false;
	}
}

/** 清掉某批的拒绝提示（用户重试前调用）。 */
export function clearBatchWrapupFailure(batchId: string): void {
	if (getBatchWrapupEntry(batchId).failure) {
		patchEntry(batchId, { failure: null });
	}
}

/**
 * 清空全部批次收口状态（解除配对、切换文档或整表重置时调用）。
 * 展开集也有一份同样用途的 `clearBatchExpansion`，两者在切文档时应当一起清。
 */
export function clearBatchWrapupState(): void {
	if (entries.size === 0 && roundByRunId.size === 0) {
		return;
	}
	entries.clear();
	roundByRunId.clear();
	idempotencyKeyByBatch.clear();
	emit();
}

/**
 * 订阅 `batch.wrapup_started` / `batch.wrapup_finished`：清在途、重取收口记录，
 * 并在 daemon 明写 `verdict='unparsed'` 时记一条解析失败条目（E-274、E-297）。
 */
export function initBatchWrapupEvents(
	bus: EventBus = defaultEventBus,
	fetcher?: WrapupsFetcher,
): () => void {
	return bus.subscribeMilestone((envelope: EventEnvelope) => {
		if (envelope.kind === 'batch.wrapup_started') {
			const payload = envelope.payload as BatchWrapupStartedPayload | undefined;
			if (!payload?.batchId) return;
			roundByRunId.set(payload.runId, payload.round);
			patchEntry(payload.batchId, { isPending: false, failure: null });
			void refetchBatchWrapups(payload.batchId, fetcher);
			return;
		}
		if (envelope.kind === 'batch.wrapup_finished') {
			const payload = envelope.payload as BatchWrapupFinishedPayload | undefined;
			if (!payload?.batchId) return;
			roundByRunId.set(payload.runId, payload.round);
			patchEntry(payload.batchId, { isPending: false });
			if (payload.verdict === 'unparsed') {
				addUnparsable(payload.batchId, {
					kind: 'unparsable',
					round: payload.round,
					runId: payload.runId,
				});
			}
			void refetchBatchWrapups(payload.batchId, fetcher);
		}
	});
}

// 浏览器与生产环境下默认自动接上事件回流（与 batch-expansion 同一写法）
if (typeof window !== 'undefined') {
	initBatchWrapupEvents(defaultEventBus);
}

// ─────────────────────────────────────────────────────────────────────────────
// hooks
// ─────────────────────────────────────────────────────────────────────────────

/** 批次树的收口总览：哪一批在途、各批的具名拒绝原因。 */
export interface BatchWrapupOverview {
	readonly pendingBatchId: string | null;
	readonly pendingBatchIds: ReadonlySet<string>;
	readonly failureByBatch: ReadonlyMap<string, BatchWrapupFailureView>;
}

/**
 * 订阅收口总览。`getSnapshot` 只返回整数 version，映射按 version 重算（07 节）。
 */
export function useBatchWrapupOverview(): BatchWrapupOverview {
	const version = useSyncExternalStore(
		subscribeBatchWrapup,
		getBatchWrapupVersion,
		getBatchWrapupVersion,
	);
	return useMemo(() => {
		void version;
		let pendingBatchId: string | null = null;
		const pendingBatchIds = new Set<string>();
		const failureByBatch = new Map<string, BatchWrapupFailureView>();
		for (const [batchId, entry] of entries) {
			if (entry.isPending) pendingBatchIds.add(batchId);
			if (entry.isPending && pendingBatchId === null) {
				pendingBatchId = batchId;
			}
			if (entry.failure) {
				failureByBatch.set(batchId, entry.failure);
			}
		}
		return { pendingBatchId, pendingBatchIds, failureByBatch };
	}, [version]);
}

/** 订阅某一批的收口状态（面板用）。 */
export function useBatchWrapupEntry(batchId: string | undefined): BatchWrapupEntry {
	const version = useSyncExternalStore(
		subscribeBatchWrapup,
		getBatchWrapupVersion,
		getBatchWrapupVersion,
	);
	return useMemo(() => {
		void version;
		return getBatchWrapupEntry(batchId);
	}, [batchId, version]);
}

/** 订阅某个收口运行的轮次（泳道头部用）。 */
export function useWrapupRoundForRun(runId: string | undefined | null): number | null {
	const version = useSyncExternalStore(
		subscribeBatchWrapup,
		getBatchWrapupVersion,
		getBatchWrapupVersion,
	);
	return useMemo(() => {
		void version;
		return getWrapupRoundForRun(runId);
	}, [runId, version]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 收口报告面板容器
// ─────────────────────────────────────────────────────────────────────────────

export interface WrapupPanelContainerProps {
	/** 批次唯一标识 */
	readonly batchId: string;
	/** 密度档位 */
	readonly tier?: DensityTier;
	/** 粗指针触控环境 */
	readonly isTouch?: boolean;
	/** 预填收口记录：只当一次性种子（单测或静态装配），给了就不发首次请求 */
	readonly initialWrapups?: readonly BatchWrapupDto[];
	/** 可注入的取数实现（单测用） */
	readonly fetcher?: WrapupsFetcher;
	/** findings 整行点击：跳该任务 */
	readonly onOpenTask?: (taskKey: string) => void;
	/** 直链原文：跳该收口运行 */
	readonly onOpenRun?: (runId: string) => void;
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
 * 收口报告面板容器：按批次取收口记录，逐轮渲染报告卡片。
 *
 * 不在这里画「收口」按钮——那颗按钮归批次树（R2），本容器只负责面板与状态。
 */
export function WrapupPanelContainer(props: WrapupPanelContainerProps) {
	const {
		batchId,
		tier,
		isTouch = false,
		initialWrapups,
		fetcher,
		onOpenTask,
		onOpenRun,
		className,
	} = props;

	const hasInitial = Boolean(initialWrapups);
	const entry = useBatchWrapupEntry(batchId);
	const [copiedToken, setCopiedToken] = useState<string | null>(null);
	const seededRef = useRef(false);

	// 一次性种子：单测与静态装配路径不发请求
	if (hasInitial && !seededRef.current) {
		seededRef.current = true;
		recordRounds(initialWrapups ?? []);
		patchEntry(batchId, { wrapups: initialWrapups ?? [], isLoading: false });
	}

	// 首次取数（种子里没有的批次走这里）
	useEffect(() => {
		if (hasInitial) return;
		void refetchBatchWrapups(batchId, fetcher);
	}, [batchId, hasInitial, fetcher]);

	const copy = useCallback(async (token: string, text: string) => {
		if (!text || text === '—') return;
		const ok = await copyTextToClipboard(text);
		if (!ok) return;
		setCopiedToken(token);
		setTimeout(() => {
			setCopiedToken((prev) => (prev === token ? null : prev));
		}, 2000);
	}, []);

	const reportEntries: readonly WrapupReportEntry[] = useMemo(() => {
		const parsed: WrapupReportEntry[] = entry.wrapups.map((wrapup) => ({ kind: 'parsed', wrapup }));
		const failed: WrapupReportEntry[] = [...entry.unparsable];
		return [...parsed, ...failed].sort((a, b) => {
			const roundA = a.kind === 'parsed' ? a.wrapup.round : a.round;
			const roundB = b.kind === 'parsed' ? b.wrapup.round : b.round;
			return roundA - roundB;
		});
	}, [entry.wrapups, entry.unparsable]);

	return (
		<div
			data-component="wrapup-panel"
			data-batch-id={batchId}
			className={['flex flex-col gap-3', className ?? ''].join(' ').trim()}
		>
			{entry.error && (
				<InlineNotice
					tone="down"
					testId="wrapup-fetch-error"
					message={entry.error.message}
					technical={entry.error.technical}
				/>
			)}

			{reportEntries.length > 0 && (
				<div className="flex flex-col gap-3">
					{reportEntries.map((reportEntry) => (
						<WrapupReport
							key={
								reportEntry.kind === 'parsed'
									? `wrapup:${reportEntry.wrapup.id}`
									: `unparsable:${reportEntry.runId}`
							}
							entry={reportEntry}
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
