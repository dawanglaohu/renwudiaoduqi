/**
 * packages/web/src/features/run-detail/mobile-rerun-bar.tsx
 *
 * 手机端流详情页日志末尾整宽重跑操作栏（M9-T13 / AC 1, AC 2, AC 3, AC 4, AC 5, E-177, E-181）
 *
 * 规范依据（07 节前端架构与 11 节 UI）：
 * - 仅对终态失败/已中止的运行可用，严格复用原派发载荷、不出现任何选择器（AC 1, E-177）
 * - 入口在流详情页日志末尾的整宽按钮，不进拇指条；拇指区仍只有停止与审批（AC 2）
 * - 「换 agent／换模型重派」保持桌面端独占，手机上只显示一行「请到桌面端」，不做半截表单（AC 3）
 * - 手机端不提供「全部重跑」，批量属编排留在桌面端（AC 4, E-181）
 * - 竖屏 <400px 时该按钮整宽独占一行，与拇指条保持间距防误触（AC 5）
 * - 撞上已在跑时按钮置灰 + 幂等键拦截，绝不产生第二次运行（E-177）
 * - 仅使用 tokens.css 变量，禁止任何颜色字面量（check-forbidden）
 */

import type { HTMLAttributes } from 'react';

export interface MobileRerunBarProps extends HTMLAttributes<HTMLDivElement> {
	/** 是否属于终态失败或已中止（AC 1） */
	readonly isTerminalFailureOrAborted: boolean;
	/** 是否满足触发重跑的条件（终态失败/中止 且 未在跑 且 未在处理中） */
	readonly canRerun: boolean;
	/** 是否处于请求重跑派发处理中（E-177） */
	readonly isRerunning: boolean;
	/** 任务是否已经有活跃运行在跑（E-177 按钮置灰拦截） */
	readonly hasActiveRun: boolean;
	/** 是否处于手机端模式（影响间距与提示） */
	readonly isMobile?: boolean;
	/** 触发重跑回调（打开二次确认弹窗） */
	readonly onTriggerRerun: () => void;
	/** 错误提示文案（如有） */
	readonly error?: string | null;
	/** 自定义类名 */
	readonly className?: string;
}

/**
 * 流详情页日志末尾原样重跑操作条组件。
 */
export function MobileRerunBar({
	isTerminalFailureOrAborted,
	canRerun,
	isRerunning,
	hasActiveRun,
	isMobile = true,
	onTriggerRerun,
	error,
	className,
	...rest
}: MobileRerunBarProps) {
	// AC 1: 仅对终态失败/已中止的运行可用；成功或未终态运行不呈现
	if (!isTerminalFailureOrAborted) {
		return null;
	}

	// 按钮置灰拦截文案判定 (E-177)
	const buttonText = isRerunning ? '重跑派发中...' : hasActiveRun ? '任务已在运行中' : '原样重跑';

	return (
		<div
			data-mobile-rerun-bar="true"
			data-has-active-run={hasActiveRun ? 'true' : 'false'}
			data-can-rerun={canRerun ? 'true' : 'false'}
			className={[
				// 容器整宽流式布局，在日志末尾独占底部区域 (AC 2, AC 5)
				'w-full flex flex-col items-center gap-2 pt-3 px-3',
				// AC 5: 竖屏 <400px 与固定在底部的拇指条保持足够防误触间距（thumbbar-h 60px + 16px 安全边距）
				isMobile ? 'pb-[calc(var(--thumbbar-h,60px)+16px)] sm:pb-6' : 'pb-4',
				className ?? '',
			].join(' ')}
			{...rest}
		>
			{/* AC 1, AC 5: 竖屏 <400px 时整宽独占一行，触控高度 44px（--h-btn-lg），圆角 9px */}
			<button
				type="button"
				data-action="rerun-run"
				disabled={!canRerun}
				onClick={onTriggerRerun}
				aria-disabled={!canRerun}
				className={[
					'w-full min-h-[44px] h-[44px] px-4 rounded-[9px]',
					'flex items-center justify-center gap-2',
					'font-ui font-semibold text-[14px]',
					'transition-all select-none',
					// E-177: 撞上已在跑时按钮置灰拦截，禁止点击
					canRerun
						? 'bg-[var(--needs)] text-[var(--on-needs)] hover:brightness-105 active:scale-[0.98] cursor-pointer shadow-sm'
						: 'bg-[var(--panel-2)] text-[var(--ink-3)] border border-[var(--border)] cursor-not-allowed opacity-60',
				].join(' ')}
			>
				{canRerun && (
					<svg
						className="w-4 h-4 shrink-0"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M2 8a6 6 0 1 0 2-4.5L2 5" />
						<path d="M2 1v4h4" />
					</svg>
				)}
				<span>{buttonText}</span>
			</button>

			{/* AC 3: 「换 agent／换模型重派」保持桌面端独占，手机上只显示一行「请到桌面端」，不做半截表单 */}
			<p
				data-testid="desktop-dispatch-notice"
				className="font-ui text-[12px] text-[var(--ink-3)] text-center tracking-tight my-0"
			>
				换 agent／换模型重派请到桌面端操作
			</p>

			{/* 错误提示横幅（E-177, E-178, E-180） */}
			{error && (
				<div
					data-testid="rerun-error-notice"
					role="alert"
					className="w-full text-center font-ui text-[12px] text-[var(--down)] bg-[var(--down-soft)] border border-[var(--border-strong)] rounded-[9px] px-3 py-2"
				>
					{error}
				</div>
			)}
		</div>
	);
}
