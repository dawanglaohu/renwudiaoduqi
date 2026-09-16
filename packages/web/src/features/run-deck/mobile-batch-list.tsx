/**
 * packages/web/src/features/run-deck/mobile-batch-list.tsx
 *
 * 手机小屏批次可折叠列表组件（M9-T12 / AC 7, E-13, E-145）
 *
 * 规范依据（11 节 UI 与边界 E-13）：
 * - 手机竖屏看批次与并行窗口：降级为可折叠列表，不得让桌面宽表格横向滚动（E-13, AC 7）
 * - 严禁出现 table / 宽网格 / 横向滚动（check-forbidden 与 E-145）
 * - 触摸优化：触控行高 >= 44px（--row-h-touch）
 * - 仅使用 tokens.css 变量，禁止任何颜色字面量
 */

import { useState } from 'react';
import { StatusBadge } from '../../components/status-badge.tsx';
import type { MobileBatchItem, MobileBatchTaskItem } from './types.ts';

export interface MobileBatchListProps {
	/** 批次数据列表 */
	readonly batches?: readonly MobileBatchItem[];
	/** 点击选择具体任务 */
	readonly onSelectTask?: (taskId: string, laneNo?: number) => void;
	/** 自定义类名 */
	readonly className?: string;
}

/**
 * 手机端批次可折叠列表。
 */
export function MobileBatchList({ batches = [], onSelectTask, className }: MobileBatchListProps) {
	// 记录各批次的展开状态（默认按照 item.defaultExpanded 初始化，若未提供则默认展开有在跑或等你的批次）
	const [expandedBatchIds, setExpandedBatchIds] = useState<ReadonlySet<string>>(() => {
		const initial = new Set<string>();
		for (const b of batches) {
			if (b.defaultExpanded || b.runningCount > 0 || b.waitingCount > 0) {
				initial.add(b.id);
			}
		}
		// 若全为空，默认展开第一个
		if (initial.size === 0 && batches.length > 0 && batches[0]) {
			initial.add(batches[0].id);
		}
		return initial;
	});

	const toggleBatch = (batchId: string) => {
		setExpandedBatchIds((prev) => {
			const next = new Set(prev);
			if (next.has(batchId)) {
				next.delete(batchId);
			} else {
				next.add(batchId);
			}
			return next;
		});
	};

	if (batches.length === 0) {
		return (
			<div
				data-mobile-batch-empty="true"
				className="flex flex-col items-center justify-center p-8 text-center text-[var(--ink-3)] font-ui text-[13px] flex-1"
			>
				<span>暂无批次任务数据</span>
			</div>
		);
	}

	return (
		<div
			data-mobile-batch-list="true"
			className={[
				'flex flex-col gap-3 p-3 w-full overflow-y-auto flex-1 select-none',
				className ?? '',
			].join(' ')}
		>
			{batches.map((batch) => {
				const isExpanded = expandedBatchIds.has(batch.id);

				return (
					<div
						key={batch.id}
						data-batch-item={batch.id}
						data-batch-no={batch.batchNo}
						className="flex flex-col rounded-[14px] bg-[var(--bg)] border border-[var(--border)] overflow-hidden shadow-sm"
					>
						{/* ─────────────────────────────────────────────────────────────
						    批次标题折叠栏（触控高度 >= 44px）
						    ───────────────────────────────────────────────────────────── */}
						<button
							type="button"
							data-action="toggle-batch"
							onClick={() => toggleBatch(batch.id)}
							aria-expanded={isExpanded}
							className="flex items-center justify-between gap-2 px-3.5 min-h-[44px] h-[44px] w-full bg-[var(--panel-2)] hover:bg-[var(--border)] cursor-pointer text-left transition-colors focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]"
						>
							<div className="flex items-center gap-2 min-w-0 pr-1">
								<span
									aria-hidden="true"
									className="text-[12px] font-mono text-[var(--ink-3)] transition-transform duration-150 inline-block w-4 text-center"
									style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
								>
									▶
								</span>
								<span className="font-ui font-semibold text-[13px] text-[var(--ink-1)] truncate">
									第 {batch.batchNo} 批 {batch.title ? `· ${batch.title}` : ''}
								</span>
							</div>

							{/* 批次汇总指标（落地 / 在跑 / 等你，E-13, E-272） */}
							<div className="flex items-center gap-2 font-mono text-[11px] text-[var(--ink-3)] flex-shrink-0">
								<span>
									{batch.landedCount}/{batch.taskCount}
								</span>
								{batch.runningCount > 0 && (
									<span className="text-[var(--auto)]">在跑 {batch.runningCount}</span>
								)}
								{batch.waitingCount > 0 && (
									<span className="text-[var(--needs)] font-semibold">
										等你 {batch.waitingCount}
									</span>
								)}
							</div>
						</button>

						{/* ─────────────────────────────────────────────────────────────
						    批次包含的任务垂直列表（降级为可折叠垂直列表，绝不出现横向滚动，E-13）
						    ───────────────────────────────────────────────────────────── */}
						{isExpanded && (
							<div
								data-batch-tasks-container="true"
								className="flex flex-col divide-y divide-[var(--border)] bg-[var(--bg)]"
							>
								{batch.tasks && batch.tasks.length > 0 ? (
									batch.tasks.map((task: MobileBatchTaskItem) => {
										return (
											<button
												key={task.id}
												type="button"
												data-task-row={task.id}
												data-task-key={task.taskKey}
												onClick={() => onSelectTask?.(task.id, task.laneNo)}
												className="flex items-center justify-between gap-3 px-4 min-h-[44px] h-[44px] w-full text-left bg-transparent hover:bg-[var(--panel-2)] cursor-pointer transition-colors focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]"
											>
												<div className="flex items-center gap-2.5 min-w-0 flex-1 pr-2">
													<span className="font-mono text-[12px] text-[var(--ink-2)] font-semibold flex-shrink-0">
														{task.taskKey}
													</span>
													<span className="font-ui text-[13px] text-[var(--ink-1)] truncate">
														{task.title}
													</span>
												</div>

												<div className="flex items-center gap-2 flex-shrink-0">
													{task.isLanded ? (
														<span className="px-1.5 py-0.5 rounded-[4px] bg-[var(--auto-soft)] text-[var(--auto)] font-ui text-[11px] font-semibold">
															已落地
														</span>
													) : task.status ? (
														<StatusBadge state={task.status} />
													) : (
														<span className="text-[11px] font-mono text-[var(--ink-3)]">待派</span>
													)}
												</div>
											</button>
										);
									})
								) : (
									<div className="p-3 text-center text-[var(--ink-3)] font-ui text-[12px]">
										该批次暂无任务项
									</div>
								)}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
