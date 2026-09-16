/**
 * packages/web/src/components/thumb-bar.tsx
 *
 * 手机端底部拇指栏组件（M9-T12 / AC 2, E-107, 11 节 UI 规范）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 纯展示层组件：纯 props in / callback out，禁止 import api/store/features/shell，禁止内部 useEffect（07 节）
 * - 停止与批准固定在拇指区、分置两端或间距 >= 24px、各 >= 44x44px，不随日志滚动移出视野（E-107, AC 2）
 * - 底部内边距：padding-bottom: calc(env(safe-area-inset-bottom) + 11px)
 * - 停止按钮采用 .btn-stop 规范：前置 ■，边框 1.5px --border-strong，不为红色；保持原位与边框（11 节）
 * - 批准按钮采用 .btn-primary 规范：实底 --needs，文字 --on-needs，>= 44x44px（11 节）
 * - 界面不含业务判定，所有数据均由 props 传入
 * - 仅使用 CSS 变量，禁止任何颜色字面量（check-forbidden）
 */

import type { HTMLAttributes, ReactNode } from 'react';

export interface ThumbBarProps extends HTMLAttributes<HTMLElement> {
	/** 是否允许停止操作（默认 true） */
	readonly canStop?: boolean;
	/** 是否处于停止处理中（乐观呈现态） */
	readonly isStopping?: boolean;
	/** 停止按钮文案（默认「停止」） */
	readonly stopLabel?: string;
	/** 停止按钮点击回调 */
	readonly onStop?: () => void;

	/** 是否有待批准事项（为 true 时高亮批准按钮） */
	readonly canApprove?: boolean;
	/** 是否处于批准处理中 */
	readonly isApproving?: boolean;
	/** 批准按钮文案（默认「批准并继续」） */
	readonly approveLabel?: string;
	/** 批准按钮点击回调 */
	readonly onApprove?: () => void;

	/** 当前待处理/审批流计数（> 0 时显示微标记） */
	readonly waitingCount?: number;
	/** 中间自定义扩展插槽（如泳道切换或状态指示） */
	readonly middleSlot?: ReactNode;
	/** 自定义类名 */
	readonly className?: string;
}

/**
 * 手机端底部拇指栏展示组件。
 */
export function ThumbBar({
	canStop = true,
	isStopping = false,
	stopLabel = '停止',
	onStop,
	canApprove = false,
	isApproving = false,
	approveLabel = '批准并继续',
	onApprove,
	waitingCount = 0,
	middleSlot,
	className,
	...rest
}: ThumbBarProps) {
	return (
		<footer
			data-thumb-bar="true"
			data-has-approval={canApprove ? 'true' : 'false'}
			data-waiting-count={waitingCount}
			className={[
				// 手机端常驻底部拇指区，不随日志或流内容滚动移出视野 (E-107, AC 2)
				'fixed bottom-0 left-0 right-0 z-40',
				'flex items-center justify-between gap-6 px-4',
				'min-h-[var(--thumbbar-h,60px)]',
				'bg-[var(--bg)] border-t border-[var(--border-strong)] shadow-lg',
				'select-none',
				className ?? '',
			].join(' ')}
			style={{
				paddingBottom: 'calc(env(safe-area-inset-bottom) + 11px)',
			}}
			{...rest}
		>
			{/* ─────────────────────────────────────────────────────────────
			    左端：停止按钮（.btn-stop 规范，>= 44x44px，前置 ■，非红，E-107）
			    ───────────────────────────────────────────────────────────── */}
			<div className="flex items-center flex-shrink-0">
				<button
					type="button"
					data-action="stop"
					data-stopping={isStopping ? 'true' : 'false'}
					disabled={!canStop || isStopping}
					onClick={onStop}
					aria-label={isStopping ? '正在停止运行' : `${stopLabel}当前运行`}
					className={`
						btn-stop inline-flex items-center justify-center gap-2
						min-h-[44px] min-w-[44px] h-[44px] px-4 rounded-[9px]
						font-ui text-[13px] font-semibold tracking-tight
						border-[1.5px] border-[var(--border-strong)] bg-transparent
						text-[var(--ink-1)] cursor-pointer transition-colors
						hover:brightness-105 active:brightness-95 active:scale-[0.97]
						focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--needs-soft)]
						disabled:opacity-45 disabled:cursor-not-allowed
					`}
				>
					<span
						aria-hidden="true"
						className="inline-block text-[11px] leading-none text-[var(--ink-1)]"
					>
						■
					</span>
					<span>{isStopping ? '停止中...' : stopLabel}</span>
				</button>
			</div>

			{/* ─────────────────────────────────────────────────────────────
			    中间区域：中间扩展插槽或待处理计数指示
			    ───────────────────────────────────────────────────────────── */}
			<div className="flex-1 flex items-center justify-center min-w-0 px-1 text-center">
				{middleSlot ? (
					middleSlot
				) : waitingCount > 0 ? (
					<div
						data-thumb-waiting-pill="true"
						className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] bg-[var(--needs-soft)] text-[var(--needs)] font-ui text-[12px] font-semibold truncate"
					>
						<span className="w-2 h-2 rounded-full bg-[var(--needs)]" />
						<span>{waitingCount} 项待处理</span>
					</div>
				) : (
					<span className="text-[12px] font-mono text-[var(--ink-3)] truncate">就绪</span>
				)}
			</div>

			{/* ─────────────────────────────────────────────────────────────
			    右端：批准按钮（.btn-primary 规范，>= 44x44px，实底 --needs，E-107）
			    分置两端保持间距 >= 24px（gap-6）
			    ───────────────────────────────────────────────────────────── */}
			<div className="flex items-center flex-shrink-0">
				<button
					type="button"
					data-action="approve"
					data-approving={isApproving ? 'true' : 'false'}
					disabled={!canApprove || isApproving}
					onClick={onApprove}
					aria-label={isApproving ? '正在提交批准' : `${approveLabel}`}
					className={`
						btn-primary inline-flex items-center justify-center gap-1.5
						min-h-[44px] min-w-[44px] h-[44px] px-4 rounded-[9px]
						font-ui text-[13px] font-semibold tracking-tight
						transition-colors cursor-pointer
						focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--needs-soft)]
						active:brightness-95 active:scale-[0.97]
						${
							canApprove
								? 'bg-[var(--needs)] text-[var(--on-needs)] hover:brightness-105 shadow-sm'
								: 'bg-[var(--panel-2)] text-[var(--ink-3)] border border-[var(--border)] cursor-not-allowed opacity-50'
						}
					`}
				>
					<span>{isApproving ? '批准中...' : approveLabel}</span>
				</button>
			</div>
		</footer>
	);
}
