/**
 * packages/web/src/components/lane-history-row.tsx
 *
 * 泳道已归档历史任务行（M9-T21 / AC 6, E-314, E-325 / 11 节 UI）
 *
 * 规范依据：
 * - 纯展示组件（components 纯 props in / callback out），禁止 import api/store/features/shell（07 节）
 * - 历史行只有一条、绑定 archivedTaskIds[0]（收口泳道用 archivedWrapupRunId）（AC 6, E-325）
 * - 折叠一行的内容固定六段顺序（AC 6, E-325）：
 *   taskKey · 标题截断 · 终态徽标（字形+文字）· 第 N 轮（N≥2 才显示）· 总耗时 · 「会话已归档」chip
 * - 收口运行历史行显示：批次收口 · 第 N 轮 · 第 M 批 + 收口裁定徽标 + 总耗时 + 「会话已归档」chip（E-325）
 * - 展开渲染只读阶段链、零 pulse-dot、props 无任何动作 callback（AC 6, E-314）
 * - 节点点击仍可调用 onOpenRun(runId) 打开该运行详情（E-313, E-314）
 */

import { type HTMLAttributes, useState } from 'react';
import type { StatusState } from '../lib/spine-shape.ts';
import type { StageRow } from '../lib/stage-rows.ts';
import { StageChain } from './stage-chain.tsx';
import { StatusBadge } from './status-badge.tsx';

export interface LaneHistoryRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
	/** 任务标识符（如 M9-T9） */
	readonly taskKey?: string | null;
	/** 任务标题 */
	readonly title?: string | null;
	/** 终态运行状态（如 succeeded, failed, stopped） */
	readonly status?: StatusState | string;
	/** 返工轮次（reworkCount，>=1 时显示「第 N 轮」= reworkCount + 1） */
	readonly reworkCount?: number;
	/** 历史总耗时（毫秒数值或已格式化字符串） */
	readonly duration?: number | string | null;
	/** 历史运行对应的阶段行数据 */
	readonly stageRows?: readonly StageRow[];
	/** 点击阶段节点打开运行详情回调（E-313, E-314） */
	readonly onOpenRun?: (runId: string) => void;
	/** 是否为收口历史运行（E-325） */
	readonly isWrapup?: boolean;
	/** 收口轮次 */
	readonly wrapupRound?: number | null;
	/** 收口批次序号 */
	readonly wrapupBatchNo?: number | null;
	/** 收口裁定终态 */
	readonly wrapupVerdict?: 'clean' | 'fixed' | 'open' | null;
	/** 是否为触摸档 */
	readonly isTouch?: boolean;
	/** 默认是否展开 */
	readonly defaultExpanded?: boolean;
}

export function LaneHistoryRow({
	taskKey,
	title,
	status = 'succeeded',
	reworkCount = 0,
	duration,
	stageRows = [],
	onOpenRun,
	isWrapup = false,
	wrapupRound,
	wrapupBatchNo,
	wrapupVerdict,
	isTouch = false,
	defaultExpanded = false,
	className,
	...rest
}: LaneHistoryRowProps) {
	const [isExpanded, setIsExpanded] = useState(defaultExpanded);

	const rowHeightClass = isTouch ? 'min-h-[44px]' : 'min-h-[30px]';
	const displayRoundNumber = reworkCount + 1;
	const shouldShowRound = !isWrapup && displayRoundNumber >= 2;

	const displayDuration = formatHistoryDuration(duration);

	const toggleExpand = () => {
		setIsExpanded((prev) => !prev);
	};

	return (
		<div
			data-component="lane-history-row"
			data-history-expanded={isExpanded ? 'true' : 'false'}
			className={['flex flex-col w-full text-[12px] font-ui', className ?? ''].join(' ')}
			{...rest}
		>
			{/* 折叠标题行：点击可展开/收起只读阶段链 */}
			<button
				type="button"
				data-action="toggle-history"
				onClick={toggleExpand}
				aria-expanded={isExpanded}
				className={[
					'flex items-center justify-between gap-2 px-2 py-1 w-full rounded-[6px]',
					'bg-[var(--bg)] hover:bg-[var(--panel-2)] transition-colors cursor-pointer select-none text-left',
					'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]',
					rowHeightClass,
				].join(' ')}
			>
				{/* 六段固定顺序展示（AC 6, E-325） */}
				<div className="flex items-center gap-2 min-w-0 flex-1 truncate">
					{/* 展开/折叠三角指示 */}
					<span
						data-glyph="chevron"
						className={`text-[10px] text-[var(--ink-3)] transition-transform duration-fast shrink-0 ${
							isExpanded ? 'rotate-90' : ''
						}`}
						aria-hidden="true"
					>
						▶
					</span>

					{isWrapup ? (
						<>
							{/* 收口历史运行呈现：批次收口 · 第 N 轮 · 第 M 批 */}
							<span
								data-field="history-wrapup-title"
								className="font-ui text-[12px] font-medium text-[var(--ink-1)] truncate shrink-0"
							>
								批次收口 · 第 {wrapupRound ?? '—'} 轮 · 第 {wrapupBatchNo ?? '—'} 批
							</span>
							<StatusBadge
								state={
									wrapupVerdict === 'clean' || wrapupVerdict === 'fixed'
										? 'succeeded'
										: wrapupVerdict === 'open'
											? 'failed'
											: status
								}
								text={
									wrapupVerdict === 'clean'
										? '干净'
										: wrapupVerdict === 'fixed'
											? '已修'
											: wrapupVerdict === 'open'
												? '有遗留'
												: undefined
								}
								className="shrink-0"
							/>
						</>
					) : (
						<>
							{/* 1. taskKey */}
							{taskKey && (
								<span
									data-field="history-task-key"
									className="font-mono text-[12px] font-semibold text-[var(--ink-1)] shrink-0"
								>
									{taskKey}
								</span>
							)}

							{/* 2. 标题截断 */}
							{title && (
								<span
									data-field="history-task-title"
									title={title}
									className="text-[12px] text-[var(--ink-2)] truncate max-w-[140px]"
								>
									{title}
								</span>
							)}

							{/* 3. 终态徽标（字形 + 文字） */}
							<StatusBadge state={status} className="shrink-0" />

							{/* 4. 第 N 轮（仅当 N >= 2 时显示，AC 6, E-325） */}
							{shouldShowRound && (
								<span
									data-field="history-round"
									className="text-[11px] text-[var(--ink-3)] font-mono shrink-0"
								>
									第 {displayRoundNumber} 轮
								</span>
							)}
						</>
					)}

					{/* 5. 总耗时 */}
					<span
						data-field="history-duration"
						className="font-mono text-[11px] text-[var(--ink-3)] tabular-nums shrink-0"
					>
						{displayDuration}
					</span>
				</div>

				{/* 6. 「会话已归档」chip */}
				<span
					data-chip="session-archived"
					className="px-1.5 py-0.5 rounded-[4px] bg-[var(--panel-2)] text-[var(--ink-3)] border border-[var(--border)] font-mono text-[10px] shrink-0"
				>
					会话已归档
				</span>
			</button>

			{/* 展开态：只读阶段链，零 pulse-dot，无任何回话/停止/重跑动作（AC 6, E-314） */}
			{isExpanded && (
				<div
					data-slot="history-stage-chain"
					className="pl-3 pr-1 py-1.5 border-l-2 border-[var(--border-strong)] ml-2.5 my-1"
				>
					<StageChain
						stageRows={stageRows}
						onOpenRun={onOpenRun}
						readOnly={true}
						isTouch={isTouch}
					/>
				</div>
			)}
		</div>
	);
}

function formatHistoryDuration(raw: number | string | null | undefined): string {
	if (raw === null || raw === undefined) {
		return '—';
	}
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : '—';
	}
	if (!Number.isFinite(raw) || raw <= 0) {
		return '—';
	}
	const totalSecs = Math.floor(raw / 1000);
	if (totalSecs < 1) return `${Math.round(raw)}ms`;
	if (totalSecs < 60) return `${totalSecs}s`;
	const mins = Math.floor(totalSecs / 60);
	const secs = totalSecs % 60;
	if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
	const hrs = Math.floor(mins / 60);
	const remMins = mins % 60;
	return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}
