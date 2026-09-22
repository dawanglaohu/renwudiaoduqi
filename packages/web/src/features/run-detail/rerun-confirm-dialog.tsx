/**
 * packages/web/src/features/run-detail/rerun-confirm-dialog.tsx
 *
 * 手机端原样重跑二次确认对话框（M9-T13 / AC 1, E-177, 07 节 Dialog 白名单）
 *
 * 规范依据（07 节前端架构与 11 节 UI）：
 * - dialog 用途白名单包含「手机原样重跑确认」（07 节 Dialog 白名单第 4 项）
 * - 严格复用原派发载荷、不出现任何选择器，需一次确认（AC 1, E-177）
 * - 仅使用 tokens.css 变量，禁止任何颜色字面量（check-forbidden）
 * - 初始焦点聚焦到取消按钮，防误触（11 节）
 * - 触控按钮高度 >= 44px（--h-btn-lg）
 */

import { useEffect, useRef } from 'react';

export interface RerunConfirmDialogProps {
	/** 是否处于打开状态 */
	readonly isOpen: boolean;
	/** 关联任务代号（如 M9-T13） */
	readonly taskKey?: string;
	/** 关联运行 ID */
	readonly runId?: string | null;
	/** 原派发 Agent 标识 */
	readonly agentName?: string | null;
	/** 是否正在提交重跑请求 */
	readonly isSubmitting?: boolean;
	/** 确认原样重跑回调 */
	readonly onConfirm: () => unknown;
	/** 取消重跑回调 */
	readonly onCancel: () => void;
}

/**
 * 手机原样重跑二次确认弹窗组件。
 */
export function RerunConfirmDialog({
	isOpen,
	taskKey,
	runId,
	agentName,
	isSubmitting = false,
	onConfirm,
	onCancel,
}: RerunConfirmDialogProps) {
	const cancelButtonRef = useRef<HTMLButtonElement>(null);

	// 初始焦点聚焦到取消按钮，防误触
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
			if (e.key === 'Escape' && !isSubmitting) {
				onCancel();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [isOpen, isSubmitting, onCancel]);

	if (!isOpen) {
		return null;
	}

	return (
		<div
			data-rerun-confirm-dialog="true"
			// biome-ignore lint/a11y/useSemanticElements: custom dialog
			role="dialog"
			aria-modal="true"
			aria-labelledby="rerun-dialog-title"
			aria-describedby="rerun-dialog-desc"
			className="fixed inset-0 z-50 flex items-center justify-center p-4 select-none"
		>
			{/* 背景遮罩 */}
			<button
				type="button"
				tabIndex={-1}
				onClick={() => {
					if (!isSubmitting) {
						onCancel();
					}
				}}
				aria-label="取消关闭"
				className="fixed inset-0 w-full h-full bg-[var(--page)] opacity-80 transition-opacity border-none cursor-default"
			/>

			{/* 对话框主体 */}
			<div className="relative z-10 w-full max-w-sm rounded-[14px] bg-[var(--bg)] border border-[var(--border-strong)] p-5 shadow-2xl">
				<div className="flex flex-col gap-2">
					<h3
						id="rerun-dialog-title"
						className="font-ui text-[16px] font-semibold text-[var(--ink-1)] tracking-tight"
					>
						确认原样重跑？
					</h3>
					<p
						id="rerun-dialog-desc"
						className="font-ui text-[13px] text-[var(--ink-2)] leading-relaxed"
					>
						将严格复用原派发载荷
						{agentName ? (
							<>
								（Agent: <span className="font-mono text-[var(--ink-1)]">{agentName}</span>）
							</>
						) : null}
						重新运行，
						<span className="font-semibold text-[var(--ink-1)]">
							不修改任何配置且不提供任何选择器
						</span>
						。
						{taskKey ? (
							<>
								确认要重新执行任务 <span className="font-mono text-[var(--ink-1)]">{taskKey}</span>{' '}
								吗？
							</>
						) : null}
					</p>
					{runId && (
						<span className="font-mono text-[11px] text-[var(--ink-3)] truncate">
							当前运行 ID: {runId}
						</span>
					)}
				</div>

				{/* 动作按钮组（高度 >= 44px 满足触控） */}
				<div className="flex items-center justify-end gap-3 mt-6">
					<button
						ref={cancelButtonRef}
						type="button"
						data-action="cancel-rerun"
						disabled={isSubmitting}
						onClick={onCancel}
						className="min-h-[44px] h-[44px] px-4 rounded-[9px] border border-[var(--border)] bg-[var(--panel-2)] text-[var(--ink-1)] font-ui text-[13px] font-medium hover:bg-[var(--border)] disabled:opacity-50 cursor-pointer transition-colors"
					>
						取消
					</button>
					<button
						type="button"
						data-action="confirm-rerun"
						disabled={isSubmitting}
						onClick={() => void onConfirm()}
						className="min-h-[44px] h-[44px] px-5 rounded-[9px] border border-[var(--needs)] bg-[var(--needs)] text-[var(--on-needs)] font-ui text-[13px] font-semibold hover:brightness-105 active:scale-[0.97] disabled:opacity-50 cursor-pointer transition-all shadow-sm"
					>
						{isSubmitting ? '派发中...' : '确认重跑'}
					</button>
				</div>
			</div>
		</div>
	);
}
