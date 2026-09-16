/**
 * packages/web/src/features/run-deck/stop-confirm-dialog.tsx
 *
 * 手机端停止二次确认对话框（M9-T12 / AC 4, E-124, 07 节 Dialog 白名单）
 *
 * 规范依据（07 节前端架构与 11 节 UI）：
 * - 手机端误触中止：与桌面端同权限，但需二次确认防口袋误触（E-124, AC 4）
 * - dialog 用途白名单包含「停止二次确认」（07 节约定第 1 项）
 * - 仅使用 tokens.css 变量，禁止任何颜色字面量（check-forbidden）
 */

import { useEffect, useRef } from 'react';

export interface StopConfirmDialogProps {
	/** 是否处于打开状态 */
	readonly isOpen: boolean;
	/** 待停止的泳道编号 */
	readonly laneNo?: number;
	/** 关联任务代号（如 M9-T12） */
	readonly taskKey?: string;
	/** 关联运行 ID */
	readonly runId?: string | null;
	/** 确认停止回调 */
	readonly onConfirm: () => void;
	/** 取消停止回调 */
	readonly onCancel: () => void;
}

/**
 * 手机端停止运行二次确认弹窗。
 */
export function StopConfirmDialog({
	isOpen,
	laneNo,
	taskKey,
	runId,
	onConfirm,
	onCancel,
}: StopConfirmDialogProps) {
	const cancelButtonRef = useRef<HTMLButtonElement>(null);

	// 初始焦点聚焦到取消按钮，防误触确认
	useEffect(() => {
		if (isOpen) {
			cancelButtonRef.current?.focus();
		}
	}, [isOpen]);
	// 监听 Escape 键取消
	useEffect(() => {
		if (!isOpen) {
			return;
		}

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onCancel();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [isOpen, onCancel]);

	if (!isOpen) {
		return null;
	}

	return (
		<div
			data-stop-confirm-dialog="true"
			// biome-ignore lint/a11y/useSemanticElements: custom dialog
			role="dialog"
			aria-modal="true"
			aria-labelledby="stop-dialog-title"
			aria-describedby="stop-dialog-desc"
			className="fixed inset-0 z-50 flex items-center justify-center p-4 select-none"
		>
			{/* 背景遮罩 */}
			<button
				type="button"
				tabIndex={-1}
				onClick={onCancel}
				aria-label="取消关闭"
				className="fixed inset-0 w-full h-full bg-[var(--page)] opacity-80 transition-opacity border-none cursor-default"
			/>

			{/* 对话框主体 */}
			<div className="relative z-10 w-full max-w-sm rounded-[14px] bg-[var(--bg)] border border-[var(--border-strong)] p-5 shadow-2xl">
				<div className="flex flex-col gap-2">
					<h3
						id="stop-dialog-title"
						className="font-ui text-[16px] font-semibold text-[var(--ink-1)] tracking-tight"
					>
						确认中止运行？
					</h3>
					<p
						id="stop-dialog-desc"
						className="font-ui text-[13px] text-[var(--ink-2)] leading-relaxed"
					>
						手机端为防口袋误触需二次确认。中止后，
						{taskKey ? (
							<span className="font-mono text-[var(--ink-1)] font-medium"> {taskKey} </span>
						) : laneNo !== undefined ? (
							<span> 泳道 {laneNo} </span>
						) : (
							<span> 当前 </span>
						)}
						的 Agent 运行将被强制中断。
					</p>
					{runId && (
						<span className="font-mono text-[11px] text-[var(--ink-3)] truncate">
							运行 ID: {runId}
						</span>
					)}
				</div>

				{/* 动作按钮组（高度 >= 44px 满足触控） */}
				<div className="flex items-center justify-end gap-3 mt-6">
					<button
						ref={cancelButtonRef}
						type="button"
						data-action="cancel-stop"
						onClick={onCancel}
						className="min-h-[44px] h-[44px] px-4 rounded-[9px] border border-[var(--border)] bg-[var(--panel-2)] text-[var(--ink-1)] font-ui text-[13px] font-medium hover:bg-[var(--border)] cursor-pointer transition-colors"
					>
						取消
					</button>
					<button
						type="button"
						data-action="confirm-stop"
						onClick={onConfirm}
						className="min-h-[44px] h-[44px] px-4 rounded-[9px] border border-[var(--down)] bg-[var(--down)] text-[var(--on-down)] font-ui text-[13px] font-semibold hover:brightness-105 active:scale-[0.97] cursor-pointer transition-all shadow-sm"
					>
						确认停止
					</button>
				</div>
			</div>
		</div>
	);
}
