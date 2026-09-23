/**
 * packages/web/src/features/run-deck/use-gate-card.ts
 *
 * 审批卡「投递原文到实施会话」的数据与写操作（M9-T20 / AC 4, E-278, E-117, E-113, E-157）
 *
 * 规范依据（07 节前端架构）：
 * - features 层是唯一允许 import src/api 的一层；路径与鉴权取自 shared ROUTES 表，不拼 URL 字面量
 * - `POST /runs/:runId/messages` 只判是否被接受；**不拿响应体改任何运行状态**，最终状态一律等回流事件（E-157）
 * - 「可回话」是能力位：`capabilities.canReply` 缺失时按不可回话处理并带 title 说明，
 *   绝不放行到点了才报错（E-117）
 * - 未送达 / 失败时保留原文可复制，绝不静默丢弃或假装已发出（E-113）
 * - 中文文案一律来自 src/i18n/error-messages.ts，本文件不写中文错误字符串
 */

import { ROUTES, type RouteDefinition } from '@agent-scheduler/shared/api/routes';
import type {
	CreateRunMessageBody,
	CreateRunMessageResponse,
} from '@agent-scheduler/shared/api/runs';
import { useCallback, useState } from 'react';
import { httpClient, isApiError } from '../../api/http-client.ts';
import type { GateDeliveryNotice } from '../../components/gate-card.tsx';
import {
	DELIVERY_NOTICE_MESSAGES,
	type DeliveryNoticeKind,
	getErrorMessage,
} from '../../i18n/error-messages.ts';

const RUN_MESSAGES_PATH = '/api/v1/runs/:runId/messages' as const;

function findRoute(method: 'POST', path: string): RouteDefinition {
	const route = ROUTES.find((entry) => entry.method === method && entry.path === path);
	if (!route) {
		// 契约表缺失时立刻暴露，而不是退回硬编码 URL（07 节：禁止 URL 字面量）
		throw new Error(`${method} ${path} is missing from the shared ROUTES table`);
	}
	return route;
}

const POST_RUN_MESSAGE_ROUTE = findRoute('POST', RUN_MESSAGES_PATH);

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
 * 错误 → 卡内投递提示。E_MESSAGE_UNDELIVERED / E_CAPABILITY_UNSUPPORTED 各有具名种类，
 * 其余一律 failed；技术详情里带上错误码与 requestId。
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
	/** 目标实施运行 ID（投递目标，daemon 下发） */
	readonly runId?: string | null;
	/** 审查返工原文（`review_verdict=incomplete` 时的全文，daemon 下发） */
	readonly reworkText?: string | null;
	/** 审查裁定（只有 'incomplete' 才出条件动作） */
	readonly reviewVerdict?: string | null;
	/** 目标运行的能力位 `capabilities.canReply`；缺失 / null 一律按不可回话处理（E-117） */
	readonly canReply?: boolean | null;
	/** 可注入的投递实现（单测用） */
	readonly sender?: DeliverRawSender;
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
}

/**
 * 审批卡的投递动作 hook。
 */
export function useGateCard(options: UseGateCardOptions = {}): UseGateCardResult {
	const { runId, reworkText, reviewVerdict, canReply, sender } = options;

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
				// 原文逐字投递，不裁剪、不改写（E-278）
				text: rawText,
				kind: 'reply',
			});

			if (response.delivered) {
				// 只报「已送达」：运行状态以回流事件为准，不拿响应体改状态（E-157）
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

	const dismissNotice = useCallback(() => setDeliveryNotice(null), []);

	return {
		canReply: resolvedCanReply,
		shouldShowDeliverRaw,
		isDeliverPending,
		deliveryNotice,
		isReworkTextCopied,
		deliverRaw,
		copyReworkText,
		dismissNotice,
	};
}

export default useGateCard;
