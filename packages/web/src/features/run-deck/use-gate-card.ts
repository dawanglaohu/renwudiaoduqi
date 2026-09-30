/**
 * packages/web/src/features/run-deck/use-gate-card.ts
 *
 * 审批卡「投递原文到实施会话」与零产出退出重跑/换 agent 重派数据写操作（M9-T20 / M9-T23 / AC 4, AC 6, E-278, E-117, E-113, E-157, E-348, E-359）
 *
 * 规范依据（07 节前端架构）：
 * - features 层是唯一允许 import src/api 的一层；路径与鉴权取自 shared ROUTES 表，不拼 URL 字面量
 * - `POST /runs/:runId/messages` 只判是否被接受；不拿响应体改任何运行状态，最终状态一律等回流事件（E-157）
 * - onApprove 映射为 POST /runs/:runId/rerun（AC 6, E-348）
 * - onEdit 由 use-gate-card.ts 先调 features/run-deck/batch-expansion.ts 展开所在批次、再调 selection-store.openReassign(taskId)（AC 6, E-359）
 * - store/ 不 import features/
 * - 中文文案一律来自 src/i18n/error-messages.ts，本文件不写中文错误字符串
 */

import { ROUTES, type RouteDefinition } from '@agent-scheduler/shared/api/routes';
import type {
	CreateRunMessageBody,
	CreateRunMessageResponse,
} from '@agent-scheduler/shared/api/runs';
import { useCallback, useState } from 'react';
import { httpClient, isApiError } from '../../api/http-client.ts';
import { rerunRun } from '../../api/runs.ts';
import type { GateDeliveryNotice } from '../../components/gate-card.tsx';
import {
	DELIVERY_NOTICE_MESSAGES,
	type DeliveryNoticeKind,
	getErrorMessage,
} from '../../i18n/error-messages.ts';
import { useSelectionStore } from '../../store/selection-store.ts';
import { expandBatch } from './batch-expansion.ts';

/**
 * 按共享路由表自身的字段取路由定义（R5）：不重复写 URL 字面量。
 */
function findRouteByTypes(
	method: 'POST',
	types: { readonly resType?: string; readonly reqType?: string },
): RouteDefinition {
	const route = ROUTES.find(
		(entry) =>
			entry.method === method &&
			(types.resType === undefined || entry.resType === types.resType) &&
			(types.reqType === undefined || entry.reqType === types.reqType),
	);
	if (!route) {
		throw new Error(
			`${method} route with ${JSON.stringify(types)} is missing from the shared ROUTES table`,
		);
	}
	return route;
}

const POST_RUN_MESSAGE_ROUTE = findRouteByTypes('POST', { reqType: 'CreateRunMessageBody' });

/** 投递实现（单测注入假实现，生产走默认实现）。 */
export type DeliverRawSender = (
	runId: string,
	body: CreateRunMessageBody,
) => Promise<CreateRunMessageResponse>;

const defaultSender: DeliverRawSender = (runId, body) =>
	httpClient.callRoute<CreateRunMessageResponse, CreateRunMessageBody>(POST_RUN_MESSAGE_ROUTE, {
		params: { runId },
		body,
	});

/**
 * 错误 → 卡内投递提示。
 */
export function toDeliveryNotice(error: unknown): GateDeliveryNotice {
	if (isApiError(error)) {
		const kind: DeliveryNoticeKind =
			error.code === 'E_MESSAGE_UNDELIVERED'
				? 'undelivered'
				: error.code === 'E_CAPABILITY_UNSUPPORTED'
					? 'unsupported'
					: 'failed';
		return {
			kind,
			message: DELIVERY_NOTICE_MESSAGES[kind],
			technical: `${error.code} · ${error.message}${error.requestId ? ` · requestId=${error.requestId}` : ''}`,
		};
	}
	return {
		kind: 'failed',
		message: DELIVERY_NOTICE_MESSAGES.failed,
		technical: error instanceof Error ? error.message : String(error),
	};
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

export interface UseGateCardOptions {
	/** 目标实施运行 ID（投递目标或重跑目标，daemon 下发） */
	readonly runId?: string | null;
	/** 关联任务 ID（用于换 agent 重派定位） */
	readonly taskId?: string | null;
	/** 关联批次 ID（用于换 agent 重派展开所在批次） */
	readonly batchId?: string | null;
	/** 当前快照的 agentId（用于重派时预选） */
	readonly snapshotAgentId?: string | null;
	/** 审查返工原文（`review_verdict=incomplete` 时的全文，daemon 下发） */
	readonly reworkText?: string | null;
	/** 审查裁定（只有 'incomplete' 才出条件动作） */
	readonly reviewVerdict?: string | null;
	/** 目标运行的能力位 `capabilities.canReply`；缺失 / null 一律按不可回话处理（E-117） */
	readonly canReply?: boolean | null;
	/** 可注入的投递实现（单测用） */
	readonly sender?: DeliverRawSender;
	/** 自定义重跑动作回调（可选注入） */
	readonly onApproveRerun?: () => Promise<void>;
	/** 自定义重派动作回调（可选注入） */
	readonly onReassign?: () => void;
}

export interface UseGateCardResult {
	/** 解析后的能力位（缺失即 false，UI 据此灰掉按钮，E-117） */
	readonly canReply: boolean;
	/** 是否应出现第 4 个条件动作（reviewVerdict='incomplete' 且原文非空） */
	readonly shouldShowDeliverRaw: boolean;
	/** 投递请求是否在途 */
	readonly isDeliverPending: boolean;
	/** 卡内投递结果提示 */
	readonly deliveryNotice: GateDeliveryNotice | null;
	/** 原文是否刚复制过 */
	readonly isReworkTextCopied: boolean;
	/** 投递原文到实施会话（不返回响应体已改的状态，只返回是否被接受） */
	readonly deliverRaw: () => Promise<boolean>;
	/** 复制原文全文 */
	readonly copyReworkText: () => Promise<boolean>;
	/** 清掉当前提示 */
	readonly dismissNotice: () => void;
	/** 零产出退出 [重跑] 动作（POST /runs/:runId/rerun，AC 6, E-348） */
	readonly isRerunPending: boolean;
	readonly actionError: string | null;
	readonly handleApproveRerun: () => Promise<void>;
	/** 零产出退出 [换 agent 重派] 动作（展开批次 + openReassign，AC 6, E-359） */
	readonly handleReassign: () => void;
}

/**
 * 审批卡的投递动作与零产出退出操作 hook。
 */
export function useGateCard(options: UseGateCardOptions = {}): UseGateCardResult {
	const {
		runId,
		taskId,
		batchId,
		snapshotAgentId,
		reworkText,
		reviewVerdict,
		canReply,
		sender,
		onApproveRerun,
		onReassign,
	} = options;

	// 能力位缺失即视为不可回话：UI 先灰掉，而不是点了才报错（E-117）
	const resolvedCanReply = canReply === true;
	const rawText = typeof reworkText === 'string' ? reworkText : '';
	const shouldShowDeliverRaw = reviewVerdict === 'incomplete' && rawText.trim().length > 0;

	const [isDeliverPending, setIsDeliverPending] = useState(false);
	const [deliveryNotice, setDeliveryNotice] = useState<GateDeliveryNotice | null>(null);
	const [isReworkTextCopied, setIsReworkTextCopied] = useState(false);

	const deliverRaw = useCallback(async (): Promise<boolean> => {
		if (!resolvedCanReply) {
			setDeliveryNotice({
				kind: 'unsupported',
				message: DELIVERY_NOTICE_MESSAGES.unsupported,
				technical: 'capabilities.canReply=false',
			});
			return false;
		}

		if (!runId || rawText.trim().length === 0) {
			setDeliveryNotice({
				kind: 'failed',
				message: DELIVERY_NOTICE_MESSAGES.failed,
				technical: getErrorMessage('E_VALIDATION'),
			});
			return false;
		}

		setIsDeliverPending(true);
		setDeliveryNotice(null);
		try {
			const response = await (sender ?? defaultSender)(runId, {
				text: rawText,
				kind: 'reply',
			});

			if (response.delivered) {
				setDeliveryNotice({
					kind: 'delivered',
					message: DELIVERY_NOTICE_MESSAGES.delivered,
					technical: `messageId=${response.messageId}`,
				});
				return true;
			}

			setDeliveryNotice({
				kind: 'undelivered',
				message: DELIVERY_NOTICE_MESSAGES.undelivered,
				technical: `messageId=${response.messageId}`,
			});
			return false;
		} catch (cause: unknown) {
			setDeliveryNotice(toDeliveryNotice(cause));
			return false;
		} finally {
			setIsDeliverPending(false);
		}
	}, [resolvedCanReply, runId, rawText, sender]);

	const copyReworkText = useCallback(async (): Promise<boolean> => {
		if (rawText.length === 0) {
			return false;
		}
		const ok = await copyTextToClipboard(rawText);
		if (ok) {
			setIsReworkTextCopied(true);
			setTimeout(() => setIsReworkTextCopied(false), 2000);
		}
		return ok;
	}, [rawText]);

	const [isRerunPending, setRerunPending] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const dismissNotice = useCallback(() => setDeliveryNotice(null), []);

	// AC 6 / E-348: 零产出 [重跑] 映射为 POST /runs/:runId/rerun
	const handleApproveRerun = useCallback(async (): Promise<void> => {
		if (isRerunPending) return;
		setRerunPending(true);
		setActionError(null);
		try {
			if (onApproveRerun) await onApproveRerun();
			else if (runId) await rerunRun(runId);
		} catch (cause) {
			setActionError(
				isApiError(cause) ? getErrorMessage(cause.code) : getErrorMessage('E_INTERNAL'),
			);
		} finally {
			setRerunPending(false);
		}
	}, [onApproveRerun, runId, isRerunPending]);

	// AC 6 / E-359: 零产出 [换 agent 重派] 先展开批次再 openReassign
	const handleReassign = useCallback((): void => {
		if (onReassign) {
			onReassign();
			return;
		}
		if (batchId) {
			expandBatch(batchId);
		}
		if (taskId) {
			useSelectionStore.getState().openReassign(taskId, snapshotAgentId ?? null);
		}
	}, [batchId, taskId, snapshotAgentId, onReassign]);

	return {
		canReply: resolvedCanReply,
		shouldShowDeliverRaw,
		isDeliverPending,
		deliveryNotice,
		isReworkTextCopied,
		deliverRaw,
		copyReworkText,
		dismissNotice,
		isRerunPending,
		actionError,
		handleApproveRerun,
		handleReassign,
	};
}

export default useGateCard;
