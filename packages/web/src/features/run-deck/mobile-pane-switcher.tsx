/**
 * packages/web/src/features/run-deck/mobile-pane-switcher.tsx
 *
 * 手机端单栏切换器组件（M9-T12 / AC 1, AC 3, E-145, E-240）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 手机竖屏 < 400px 降级为单栏切换（任务列表 / 运行流 / 详情），不得横向滚动或并排三栏（E-145）
 * - 单栏切换走 hash query #/?pane=tasks|stream|detail，不新增路由，Android 返回键天然回上一 pane
 * - 当切换到「任务列表」或「详情」时，若某条流处于「等你」状态，必须有可见的未处理计数徽标（E-240）
 * - 纯 props 驱动展示，只使用 tokens.css 变量，禁止任何颜色字面量
 */

import type { HTMLAttributes } from 'react';
import type { MobilePane } from './types.ts';

export interface MobilePaneSwitcherProps extends HTMLAttributes<HTMLElement> {
	/** 当前选中的单栏（'tasks' | 'stream' | 'detail'） */
	readonly activePane: MobilePane;
	/** 切换栏位回调 */
	readonly onPaneChange: (pane: MobilePane) => void;
	/** 处于等待审批（等你）状态的泳道流总计数（E-240） */
	readonly waitingCount?: number;
	/** 自定义类名 */
	readonly className?: string;
}

/**
 * 手机端单栏切换器。
 */
export function MobilePaneSwitcher({
	activePane,
	onPaneChange,
	waitingCount = 0,
	className,
	...rest
}: MobilePaneSwitcherProps) {
	// 标签页列表
	const tabs: Array<{ id: MobilePane; label: string }> = [
		{ id: 'tasks', label: '任务列表' },
		{ id: 'stream', label: '运行流' },
		{ id: 'detail', label: '详情' },
	];

	return (
		<nav
			data-mobile-pane-switcher="true"
			data-active-pane={activePane}
			aria-label="单栏视图导航"
			className={[
				'grid grid-cols-3 w-full bg-[var(--bg)] border-b border-[var(--border)] select-none z-30 flex-shrink-0',
				className ?? '',
			].join(' ')}
			{...rest}
		>
			{tabs.map((tab) => {
				const isActive = activePane === tab.id;
				// E-240: 单栏切换到「任务列表」或「详情」时，若某条流转「等你」，必须在「运行流」栏上有可见的未处理计数徽标
				const showWaitingBadge = tab.id === 'stream' && waitingCount > 0 && !isActive;

				return (
					<button
						key={tab.id}
						type="button"
						data-pane-tab={tab.id}
						data-active={isActive ? 'true' : 'false'}
						onClick={() => onPaneChange(tab.id)}
						aria-current={isActive ? 'page' : undefined}
						className={`
							relative flex items-center justify-center gap-1.5
							min-h-[44px] h-[44px] px-2 py-1
							font-ui text-[13px] transition-colors cursor-pointer
							focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]
							${
								isActive
									? 'text-[var(--ink-1)] font-semibold bg-[var(--panel-2)] shadow-sm'
									: 'text-[var(--ink-3)] font-normal hover:text-[var(--ink-2)] hover:bg-[var(--panel-2)]'
							}
						`}
					>
						{/* 底部高亮指示条 */}
						{isActive && (
							<span
								aria-hidden="true"
								className="absolute bottom-0 left-2 right-2 h-[2px] bg-[var(--needs)] rounded-full"
							/>
						)}

						<span className="truncate">{tab.label}</span>

						{/* E-240: 可见的未处理计数徽标（暖色 --needs 醒目标记，绝不藏住提醒） */}
						{showWaitingBadge && (
							<span
								data-indicator="unhandled-waiting-badge"
								data-waiting-count={waitingCount}
								aria-label={`有 ${waitingCount} 项运行流正在等待审批`}
								className="inline-flex items-center justify-center px-1.5 py-0.2 min-w-[18px] h-[18px] rounded-[6px] bg-[var(--needs)] text-[var(--on-needs)] font-mono text-[11px] font-bold leading-none animate-pulse flex-shrink-0 shadow-sm"
							>
								{waitingCount}
							</span>
						)}
					</button>
				);
			})}
		</nav>
	);
}
