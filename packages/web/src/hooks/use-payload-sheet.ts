/**
 * packages/web/src/hooks/use-payload-sheet.ts
 *
 * 手机端 Tool Payload 底部抽屉转接 Context 与 Hook（M9-T12 / AC 6, 07 节分层约束）
 *
 * 规范依据：
 * - 展开的 tool payload 走 bottom sheet 不内联（AC 6）
 * - components 禁止 import features，转接点位于 hooks（07 节前端架构）
 * - 甲板在手机档（phone / phone-xs 或 isTouch）提供 Provider，任何经 lane.bodySlot
 *   传进来的真实 StreamRow 都能把 payload 送进同一张 sheet（R1 审查修复）
 */

import {
	type ReactNode,
	createContext,
	createElement,
	useCallback,
	useContext,
	useRef,
	useState,
} from 'react';

/**
 * Tool Payload 底部抽屉载荷模型（AC 6）。
 */
export interface ToolPayloadSheetData {
	/** 步骤/工具标题 */
	readonly title: string;
	/** 工具名称（如 bash / read / edit） */
	readonly toolName?: string;
	/** 耗时说明 */
	readonly durationText?: string;
	/** 输入参数（JSON 或文本内容） */
	readonly inputPayload?: string | null;
	/** 输出结果（JSON 或文本内容） */
	readonly outputPayload?: string | null;
	/** 原始载荷对象 */
	readonly raw?: unknown;
}

export interface PayloadSheetContextValue {
	/** 是否处于手机/触控模式（展开时应走 bottom sheet） */
	readonly isMobile: boolean;
	/** 当前活动的 payload 数据 */
	readonly activePayload: ToolPayloadSheetData | null;
	/** 打开 Tool Payload 抽屉 */
	readonly openPayloadSheet: (data: ToolPayloadSheetData) => void;
	/** 关闭 Tool Payload 抽屉 */
	readonly closePayloadSheet: () => void;
	/** 供 SSR 或子组件渲染后即时读取当前挂载的 payload */
	readonly getPayload?: () => ToolPayloadSheetData | null;
}

const PayloadSheetContext = createContext<PayloadSheetContextValue | null>(null);

export interface PayloadSheetProviderProps {
	/** 是否处于手机/触控档位 */
	readonly isMobile: boolean;
	/** 外部受控 activePayload（可选） */
	readonly activePayload?: ToolPayloadSheetData | null;
	/** 外部打开回调（可选） */
	readonly onOpenPayload?: (data: ToolPayloadSheetData) => void;
	/** 外部关闭回调（可选） */
	readonly onClosePayload?: () => void;
	/** 子节点 */
	readonly children?: ReactNode;
}

export function PayloadSheetProvider({
	isMobile,
	activePayload: externalPayload,
	onOpenPayload,
	onClosePayload,
	children,
}: PayloadSheetProviderProps) {
	const [internalPayload, setInternalPayload] = useState<ToolPayloadSheetData | null>(null);
	const renderedPayloadRef = useRef<ToolPayloadSheetData | null>(null);

	const openPayloadSheet = useCallback(
		(data: ToolPayloadSheetData) => {
			renderedPayloadRef.current = data;
			if (onOpenPayload) {
				onOpenPayload(data);
			} else {
				setInternalPayload(data);
			}
		},
		[onOpenPayload],
	);

	const closePayloadSheet = useCallback(() => {
		renderedPayloadRef.current = null;
		if (onClosePayload) {
			onClosePayload();
		} else {
			setInternalPayload(null);
		}
	}, [onClosePayload]);

	const effectivePayload =
		externalPayload !== undefined
			? externalPayload
			: (internalPayload ?? renderedPayloadRef.current);

	const value: PayloadSheetContextValue = {
		isMobile,
		activePayload: effectivePayload,
		openPayloadSheet,
		closePayloadSheet,
		getPayload: () => renderedPayloadRef.current ?? effectivePayload,
	};

	return createElement(PayloadSheetContext.Provider, { value }, children);
}

/**
 * 获取 Tool Payload Sheet 转接上下文。
 */
export function usePayloadSheet(): PayloadSheetContextValue | null {
	return useContext(PayloadSheetContext);
}
