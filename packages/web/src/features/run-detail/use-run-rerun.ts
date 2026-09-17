/**
 * packages/web/src/features/run-detail/use-run-rerun.ts
 *
 * 手机原样重跑 React Hook（M9-T13 / AC 1, AC 3, E-177, E-181, R2, R3）
 *
 * 规范依据（07 节前端架构与 M8-T5 接口契约）：
 * - features 层唯一允许 import src/api 与发起写请求（07 节）
 * - 仅对终态失败/已中止的运行可用（AC 1）
 * - 严格复用原派发载荷、不出现任何选择器，需一次确认（AC 1, E-177）
 * - 识别同任务已有 active run 并预先置灰（E-177, R2）
 * - rerun POST 返回 200 + 既有 active run 时不得当作新运行成功或替换当前详情/日志，接受后置灰并等待 SSE/REST（R2）
 * - 手机端不提供「全部重跑」，批量留在桌面端（AC 4, E-181）
 * - 错误按 code 经 src/i18n/error-messages.ts 映射，英文 message 只进带 requestId 的技术详情（R3）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROUTES } from '../../../../shared/src/api/routes.ts';
import type {
	GetRunResponse,
	ListRunsResponse,
	RerunRunResponse,
	RunDto,
} from '../../../../shared/src/api/runs.ts';
import { generateIdempotencyKey, httpClient, isApiError } from '../../api/http-client.ts';
import { getErrorMessage } from '../../i18n/error-messages.ts';

const getRunRoute = ROUTES.find((r) => r.method === 'GET' && r.path === '/api/v1/runs/:runId');

const listRunsRoute = ROUTES.find((r) => r.method === 'GET' && r.path === '/api/v1/runs');

const rerunRunRoute = ROUTES.find(
	(r) => r.method === 'POST' && r.path === '/api/v1/runs/:runId/rerun',
);

/**
 * 判定给定的运行状态是否属于「终态失败」或「已中止」（AC 1）。
 * 只有 failed, aborted, interrupted, stopped 视为可用。
 * landed/succeeded（成功终态）以及 running, queued, starting 等（进行中）不可重跑。
 */
export function isTerminalFailureOrAborted(rawState: string | undefined | null): boolean {
	if (!rawState) {
		return false;
	}
	const s = rawState.trim().toLowerCase();
	return s === 'failed' || s === 'aborted' || s === 'interrupted' || s === 'stopped';
}

/**
 * 判定给定的运行状态是否正在活跃运行中（E-177）。
 */
export function isActiveRunState(rawState: string | undefined | null): boolean {
	if (!rawState) {
		return false;
	}
	const s = rawState.trim().toLowerCase();
	return (
		s === 'starting' ||
		s === 'running' ||
		s === 'reviewing' ||
		s === 'reworking' ||
		s === 'queued' ||
		s === 'awaiting_reply' ||
		s === 'awaiting_human'
	);
}

export interface RerunErrorState {
	readonly code: string;
	readonly userMessage: string;
	readonly techMessage?: string;
	readonly requestId?: string;
}

export interface UseRunRerunOptions {
	/** 运行编号 */
	readonly runId: string;
	/** 初始运行 DTO（可选，由外部传入避免初次闪烁） */
	readonly initialRun?: RunDto | null;
	/** 初始运行状态（可选，由外部传入避免初次闪烁） */
	readonly initialStatus?: string;
}

export interface UseRunRerunReturn {
	/** 当前运行信息 */
	readonly run: RunDto | null;
	/** 是否处于加载运行详情中 */
	readonly isLoadingRun: boolean;
	/** 当前状态是否为终态失败或已中止（AC 1） */
	readonly isTerminalFailureOrAborted: boolean;
	/** 是否允许触发重跑（终态失败/中止 且 未在跑 且 未在处理中） */
	readonly canRerun: boolean;
	/** 是否正在执行重跑网络请求（防重复点击，E-177） */
	readonly isRerunning: boolean;
	/** 任务是否已有活跃运行（按钮置灰拦截，E-177, R2） */
	readonly hasActiveRun: boolean;
	/** 二次确认对话框是否打开（AC 1, E-177） */
	readonly isConfirmOpen: boolean;
	/** 结构化错误状态 */
	readonly errorState: RerunErrorState | null;
	/** 用户友好错误中文文案（经 i18n 映射，R3） */
	readonly error: string | null;
	/** 英文技术详情错误信息（只进技术详情，R3） */
	readonly techError: string | null;
	/** 请求编号（供技术详情一键复制，R3） */
	readonly requestId: string | null;
	/** 错误码 */
	readonly errorCode: string | null;
	/** 当前使用的幂等键（防重复派发测试与核验） */
	readonly idempotencyKey: string;
	/** 打开二次确认对话框 */
	readonly openConfirm: () => void;
	/** 关闭二次确认对话框 */
	readonly closeConfirm: () => void;
	/** 执行原样重跑（严格复用原载荷，携带幂等键） */
	readonly executeRerun: () => Promise<RunDto | null>;
	/** 刷新当前运行状态 */
	readonly refreshRun: () => Promise<void>;
}

export function useRunRerun({
	runId,
	initialRun = null,
	initialStatus,
}: UseRunRerunOptions): UseRunRerunReturn {
	const [run, setRun] = useState<RunDto | null>(initialRun);
	const [isLoadingRun, setIsLoadingRun] = useState<boolean>(false);
	const [isRerunning, setIsRerunning] = useState<boolean>(false);
	const [hasActiveRun, setHasActiveRun] = useState<boolean>(false);
	const [isConfirmOpen, setIsConfirmOpen] = useState<boolean>(false);
	const [errorState, setErrorState] = useState<RerunErrorState | null>(null);

	// 稳定持有重跑幂等键，同一操作多次确认复用同一幂等键（E-177 / R2）
	const currentIdempotencyKeyRef = useRef<string>(generateIdempotencyKey());

	// 当前有效状态：优先使用实时 run.state，次选 initialStatus
	const effectiveState = run?.state ?? initialStatus ?? null;

	const terminalFailureOrAborted = useMemo(() => {
		return isTerminalFailureOrAborted(effectiveState);
	}, [effectiveState]);

	// 检查同任务是否有其他活跃运行并预先置灰（R2 / E-177）
	const checkActiveRunForTask = useCallback(async (taskId: string, currentRunId: string) => {
		if (!taskId || !listRunsRoute) {
			return;
		}
		try {
			const res = await httpClient.callRoute<ListRunsResponse>(listRunsRoute);
			if (res?.runs) {
				const active = res.runs.find(
					(r) => r.taskId === taskId && r.id !== currentRunId && isActiveRunState(r.state),
				);
				if (active) {
					setHasActiveRun(true);
				}
			}
		} catch {
			// 静默处理，避免网络抖动打断界面
		}
	}, []);

	// 拉取当前运行状态
	const refreshRun = useCallback(async () => {
		if (!runId || !getRunRoute) {
			return;
		}
		setIsLoadingRun(true);
		try {
			const res = await httpClient.callRoute<GetRunResponse>(getRunRoute, {
				params: { runId },
			});
			if (res?.run) {
				setRun(res.run);
				if (isActiveRunState(res.run.state)) {
					setHasActiveRun(true);
				} else if (res.run.taskId) {
					void checkActiveRunForTask(res.run.taskId, runId);
				}
			}
		} catch {
			// 若初次取不到，保持现状不阻断呈现
		} finally {
			setIsLoadingRun(false);
		}
	}, [runId, checkActiveRunForTask]);

	// 监听 runId 或 initialRun 切换
	useEffect(() => {
		currentIdempotencyKeyRef.current = generateIdempotencyKey();
		setErrorState(null);
		setHasActiveRun(false);
		setIsConfirmOpen(false);

		if (initialRun) {
			setRun(initialRun);
			if (isActiveRunState(initialRun.state)) {
				setHasActiveRun(true);
			} else if (initialRun.taskId) {
				void checkActiveRunForTask(initialRun.taskId, runId);
			}
		} else {
			void refreshRun();
		}
	}, [initialRun, refreshRun, checkActiveRunForTask, runId]);

	// 判断是否允许点击重跑按钮（AC 1, E-177）
	const canRerun = useMemo(() => {
		return terminalFailureOrAborted && !hasActiveRun && !isRerunning;
	}, [terminalFailureOrAborted, hasActiveRun, isRerunning]);

	const openConfirm = useCallback(() => {
		if (!canRerun) {
			return;
		}
		setErrorState(null);
		setIsConfirmOpen(true);
	}, [canRerun]);

	const closeConfirm = useCallback(() => {
		setIsConfirmOpen(false);
	}, []);

	// 执行实际重跑调用
	const executeRerun = useCallback(async (): Promise<RunDto | null> => {
		if (!runId || !rerunRunRoute) {
			return null;
		}
		if (!canRerun) {
			return null;
		}

		setIsRerunning(true);
		setErrorState(null);

		const idempotencyKey = currentIdempotencyKeyRef.current;

		try {
			const res = await httpClient.callRoute<RerunRunResponse>(rerunRunRoute, {
				params: { runId },
				body: { idempotencyKey },
			});

			setIsConfirmOpen(false);

			if (res?.run) {
				// 写请求响应只表示服务端已接受。无论它是新建运行还是返回既有 active run，
				// 都保留当前终态详情与日志，仅置灰入口，等待 SSE/REST 权威状态回流（R2 / E-157）。
				setHasActiveRun(true);
				return res.run;
			}
			return null;
		} catch (err) {
			if (isApiError(err)) {
				const userMsg = getErrorMessage(err.code);
				if (err.code === 'E_RUN_ALREADY_EXISTS') {
					// E-177: 手机重跑撞上已在跑，按钮置灰拦截
					setHasActiveRun(true);
				}
				setErrorState({
					code: err.code,
					userMessage: userMsg,
					techMessage: err.message,
					requestId: err.requestId,
				});
			} else {
				const rawMsg = err instanceof Error ? err.message : String(err);
				setErrorState({
					code: 'E_NETWORK',
					userMessage: getErrorMessage('E_NETWORK'),
					techMessage: rawMsg,
				});
			}
			return null;
		} finally {
			setIsRerunning(false);
		}
	}, [runId, canRerun]);

	return {
		run,
		isLoadingRun,
		isTerminalFailureOrAborted: terminalFailureOrAborted,
		canRerun,
		isRerunning,
		hasActiveRun,
		isConfirmOpen,
		errorState,
		error: errorState?.userMessage ?? null,
		techError: errorState?.techMessage ?? null,
		requestId: errorState?.requestId ?? null,
		errorCode: errorState?.code ?? null,
		idempotencyKey: currentIdempotencyKeyRef.current,
		openConfirm,
		closeConfirm,
		executeRerun,
		refreshRun,
	};
}
