/**
 * packages/web/src/features/run-deck/mobile-bottom-sheet.tsx
 *
 * 手机端 Tool Payload 底部抽屉（M9-T12 / AC 6, 11 节 UI 规范）
 *
 * 规范依据（11 节 UI）：
 * - 展开的 tool payload 走 bottom sheet 不内联（AC 6）
 * - 手机竖屏下避免大段 JSON 挤爆垂直阅读流，采用弹层呈现并提供单手关闭入口
 * - 等宽字体 --font-mono，入参/出参原样展示，max-height 约束并支持垂直滚动
 * - 仅使用 tokens.css 变量，禁止任何颜色字面量（check-forbidden）
 */

import { useCallback, useEffect } from 'react';
import { usePayloadSheet } from '../../hooks/use-payload-sheet.ts';
import type { ToolPayloadSheetData } from './types.ts';

export interface MobileBottomSheetProps {
	/** 是否处于打开状态 */
	readonly isOpen?: boolean;
	/** 当前展示的 Payload 数据 */
	readonly payload?: ToolPayloadSheetData | null;
	/** 关闭抽屉回调 */
	readonly onClose?: () => void;
	/** 自定义类名 */
	readonly className?: string;
}

/**
 * 手机端 Tool Payload 底部抽屉组件。
 */
export function MobileBottomSheet({ isOpen, payload, onClose, className }: MobileBottomSheetProps) {
	const payloadSheet = usePayloadSheet();
	const activePayload =
		payload !== undefined
			? payload
			: (payloadSheet?.getPayload?.() ?? payloadSheet?.activePayload ?? null);

	const activeIsOpen =
		isOpen !== undefined
			? Boolean(isOpen && activePayload !== null)
			: Boolean(activePayload !== null);

	const handleClose = useCallback(() => {
		onClose?.();
		payloadSheet?.closePayloadSheet();
	}, [onClose, payloadSheet]);

	// 键盘 Escape 键关闭支持
	useEffect(() => {
		if (!activeIsOpen) {
			return;
		}

		const handleKeyDown = (e: globalThis.KeyboardEvent) => {
			if (e.key === 'Escape') {
				handleClose();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [activeIsOpen, handleClose]);

	if (!activeIsOpen || !activePayload) {
		return null;
	}

	return (
		<div
			data-mobile-bottom-sheet="true"
			aria-label={activePayload.title || '工具入参和出参详情'}
			className="fixed inset-0 z-50 flex flex-col justify-end"
		>
			{/* ─────────────────────────────────────────────────────────────
			    背景遮罩（点击关闭）
			    ───────────────────────────────────────────────────────────── */}
			<button
				type="button"
				data-action="close-backdrop"
				tabIndex={-1}
				onClick={handleClose}
				aria-label="关闭抽屉遮罩"
				className="fixed inset-0 w-full h-full bg-[var(--page)] opacity-80 transition-opacity border-none cursor-default"
			/>

			{/* ─────────────────────────────────────────────────────────────
			    抽屉主体（自底向上滑入，max-h-[80vh]）
			    ───────────────────────────────────────────────────────────── */}
			<div
				data-sheet-content="true"
				className={[
					'relative z-10 flex flex-col w-full max-h-[80vh]',
					'bg-[var(--bg)] border-t border-[var(--border-strong)] rounded-t-[14px] shadow-2xl',
					'overflow-hidden flex-shrink-0 transition-transform duration-fast',
					className ?? '',
				].join(' ')}
				style={{
					paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)',
				}}
			>
				{/* 顶部把手（drag handle 指示条） */}
				<div className="flex items-center justify-center pt-2.5 pb-1 flex-shrink-0">
					<div aria-hidden="true" className="w-10 h-1 rounded-full bg-[var(--border-strong)]" />
				</div>

				{/* 抽屉头部 */}
				<div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] flex-shrink-0 min-h-[44px]">
					<div className="flex items-center gap-2 min-w-0 pr-2">
						{activePayload.toolName && (
							<span className="px-2 py-0.5 rounded-[4px] bg-[var(--panel-2)] text-[var(--ink-1)] font-mono text-[11px] font-semibold flex-shrink-0">
								{activePayload.toolName}
							</span>
						)}
						<h3 className="font-ui text-[14px] font-semibold text-[var(--ink-1)] truncate">
							{activePayload.title}
						</h3>
						{activePayload.durationText && (
							<span className="text-[12px] font-mono text-[var(--ink-3)] flex-shrink-0">
								{activePayload.durationText}
							</span>
						)}
					</div>

					<button
						type="button"
						data-action="close-sheet"
						onClick={handleClose}
						aria-label="关闭工具详情抽屉"
						className="min-h-[44px] min-w-[44px] h-[44px] w-[44px] rounded-[9px] text-[var(--ink-3)] hover:text-[var(--ink-1)] flex items-center justify-center cursor-pointer transition-colors"
					>
						<span aria-hidden="true" className="text-[16px] leading-none">
							✕
						</span>
					</button>
				</div>

				{/* 抽屉内容区（等宽字体展示逐字原样入参/出参，AC 6） */}
				<div className="p-4 overflow-y-auto flex-1 flex flex-col gap-3 font-mono text-[12px] select-text">
					{/* 输入参数 */}
					{activePayload.inputPayload !== undefined && (
						<div className="flex flex-col gap-1.5">
							<span className="text-[11px] font-ui font-semibold text-[var(--ink-2)]">
								输入参数 (Input Payload)
							</span>
							<pre className="p-3 rounded-[9px] bg-[var(--panel-2)] border border-[var(--border)] text-[var(--ink-1)] whitespace-pre-wrap break-all overflow-hidden leading-relaxed">
								{activePayload.inputPayload || '—'}
							</pre>
						</div>
					)}

					{/* 执行结果 / 输出 */}
					{activePayload.outputPayload !== undefined && (
						<div className="flex flex-col gap-1.5">
							<span className="text-[11px] font-ui font-semibold text-[var(--ink-2)]">
								执行输出 (Output Payload)
							</span>
							<pre className="p-3 rounded-[9px] bg-[var(--panel-2)] border border-[var(--border)] text-[var(--ink-1)] whitespace-pre-wrap break-all overflow-hidden leading-relaxed">
								{activePayload.outputPayload || '—'}
							</pre>
						</div>
					)}

					{activePayload.inputPayload === undefined &&
						activePayload.outputPayload === undefined && (
							<div className="p-4 text-center text-[var(--ink-3)] font-ui text-[13px]">
								无工具负载内容
							</div>
						)}
				</div>

				{/* 底部固定关闭按钮（44px 触控高度） */}
				<div className="px-4 pt-2 border-t border-[var(--border)] flex-shrink-0">
					<button
						type="button"
						onClick={handleClose}
						className="w-full h-[44px] min-h-[44px] rounded-[9px] bg-[var(--panel-2)] border border-[var(--border-strong)] text-[var(--ink-1)] font-ui text-[13px] font-medium hover:bg-[var(--border)] cursor-pointer transition-colors"
					>
						关闭
					</button>
				</div>
			</div>
		</div>
	);
}
