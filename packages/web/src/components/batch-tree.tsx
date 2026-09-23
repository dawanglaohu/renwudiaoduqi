/**
 * packages/web/src/components/batch-tree.tsx
 *
 * 批次树组件（M9-T19 / AC 1, AC 4, AC 5, E-13, E-272, E-282, E-284, E-298）
 *
 * 规范依据（07 节前端架构、11 节 UI、12 节 UX 与返工要求 R1, R5）：
 * - 只消费 shared/daemon 的 BatchDto 与 TaskDto 字段，不自造冗余模型，不进行业务判定
 * - 纯 props in / callback out 组件，禁止内部使用 useState 存展开集，禁止内部计算任何计数
 * - 折叠的批不渲染子行（不是 display:none，DOM 中根本不创建子节点）
 * - 标题计数「已落地 x/n · 在跑 y · 等你 z」，字段缺失显示「—」，绝不猜测默认值
 * - waitingCount > 0 时只有「等你 z」一段转 --needs
 * - 批次标题行网格：16px minmax(0,1fr) auto auto（开合槽 · 「第 N 批」+ 计数 · 收口徽标 · 收口按钮槽）
 * - 任务行网格：20px minmax(0,1fr) auto 7ch（呼吸点槽 · taskKey + 标题截断 · 状态徽标 · 进 HEAD 标记）
 * - 行高：桌面 30px（--row-h），phone/phone-xs/touch 44px（--row-h-touch）；开合槽在触摸档撑到 44×44
 * - 呼吸点：任务行第 1 列放 PulseDot，live 呼吸、waiting 静态暖点、终态与 queued 无点；标题行不放呼吸点
 * - 进 HEAD 标记：三态同色（--ink-3）、固定 7ch，false 时 title 显示判定方法（无方法不猜测默认）
 * - 跨批修复：任务行标题后 20px 高矩形 chip「跨批修复」，批次标题追加「· 含跨批修复」
 * - 收口行：批次标题下第一行「批次收口 · 第 N 轮」，第 1 列按收口运行状态呼吸，点击进该运行详情
 * - 收口按钮：.btn-ghost 高 --h-btn-sm 在第 4 槽，只在 canWrapup 且非手机档时渲染
 * - role="tree" 键盘可达：Enter/Space 开合，Arrow 键在可见项间导航，焦点使用内嵌 2px 环
 */

import type { BatchDto } from '@agent-scheduler/shared/api/batches';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import type { KeyboardEvent, MouseEvent } from 'react';
import { pulseForRun } from '../lib/run-pulse.ts';
import { PulseDot } from './pulse-dot.tsx';
import { StatusBadge } from './status-badge.tsx';

/**
 * 任务行条目：TaskDto 之上按 07 节字段名声明尚未进入 shared 的可选字段（inHead / inHeadMethod / crossBatchFix），
 * 由 M8-T7 在 daemon 侧产出；缺失时本组件显示「—」，不推断。
 */
export interface BatchTreeTaskItem extends TaskDto {
	readonly inHead?: boolean | null;
	readonly inHeadMethod?: string | null;
	readonly crossBatchFix?: boolean;
}

/**
 * 收口运行行数据模型。
 */
export interface BatchTreeWrapupRow {
	readonly runId?: string;
	readonly round?: number;
	readonly state?: string;
	readonly title?: string;
}

/**
 * 收口徽标数据模型。
 */
export interface BatchTreeWrapupBadge {
	readonly kind:
		| 'wrapping'
		| 'done_clean'
		| 'done_fixed'
		| 'open'
		| 'needs_attention'
		| 'awaiting_landing';
	readonly text?: string;
	readonly round?: number;
	readonly remainingCount?: number;
	readonly notInHeadCount?: number;
}

/**
 * 批次树单个批次数据模型（继承 BatchDto，数据字段全部来自 shared/daemon，R1）。
 */
export interface BatchTreeItem extends Partial<BatchDto> {
	/** 批次唯一标识 */
	readonly id: string;
	/** 批次序号 */
	readonly batchNo: number;
	/** 批次标题（可选） */
	readonly title?: string;
	/** 任务总数（daemon 下发，缺失显示「—」） */
	readonly taskCount?: number;
	/** 已落地任务数（daemon 下发，缺失显示「—」） */
	readonly landedCount?: number;
	/** 在跑任务数（daemon 下发，缺失显示「—」） */
	readonly runningCount?: number;
	/** 等待/等你任务数（daemon 下发，缺失显示「—」） */
	readonly waitingCount?: number;
	/** 未进 HEAD 任务数（daemon 下发，E-272） */
	readonly notInHeadCount?: number;
	/** 默认展开（daemon 计算） */
	readonly defaultExpanded?: boolean;
	/** 能否收口（daemon 下发，AC 1） */
	readonly canWrapup?: boolean;
	/** 收口徽标规格 */
	readonly wrapupBadge?: BatchTreeWrapupBadge | null;
	/** 是否含有跨批修复任务 */
	readonly hasCrossBatchFix?: boolean;
	/** 关联的收口运行行 */
	readonly wrapupRow?: BatchTreeWrapupRow | null;
	/** 任务列表 */
	readonly tasks?: readonly BatchTreeTaskItem[];
}

/**
 * 批次树组件属性。
 */
export interface BatchTreeProps {
	/** 全部批次列表 */
	readonly batches: readonly BatchTreeItem[];
	/** 当前已展开的批次 ID 集合（只读，来自外部 batch-expansion 模块） */
	readonly expandedIds: ReadonlySet<string>;
	/** 当前选中的任务 ID（可选） */
	readonly selectedTaskId?: string | null;
	/** 密度档位（可选） */
	readonly densityTier?: 'full' | 'compact' | 'single' | 'narrow' | 'phone' | 'phone-xs';
	/** 是否为触摸模式（默认根据 densityTier 判定） */
	readonly isTouch?: boolean;
	/** 点击切换批次展开状态回调 */
	readonly onToggleBatch?: (batchId: string) => void;
	/** 点击选择任务回调 */
	readonly onSelectTask?: (taskId: string, batchId?: string) => void;
	/** 点击收口按钮回调 */
	readonly onWrapup?: (batchId: string) => void;
	/** 点击收口运行行回调 */
	readonly onOpenWrapupRun?: (runId: string, batchId: string) => void;
	/** 外部自定义类名 */
	readonly className?: string;
}

/**
 * 渲染收口徽标（E-272, 决策 85）。
 * 不猜测任何默认值，缺失数字显示「—」（R5）。
 */
function renderWrapupBadge(batch: BatchTreeItem) {
	const badge = batch.wrapupBadge;
	// 若无直接 wrapupBadge，但 batch.state === 'awaiting_landing'，根据 daemon 状态派生徽标呈现
	const kind = badge?.kind ?? (batch.state === 'awaiting_landing' ? 'awaiting_landing' : null);
	if (!kind && !badge) return null;

	const roundText = badge?.round && badge.round >= 2 ? ` · 第 ${badge.round} 轮` : '';
	const roundTitle = badge?.round && badge.round >= 2 ? `第 ${badge.round} 轮收口` : undefined;

	switch (kind) {
		case 'wrapping': {
			const label = badge?.text ?? `收口中${roundText}`;
			return (
				<span
					data-badge="wrapping"
					title={roundTitle}
					aria-label={label}
					className="h-[20px] px-2 inline-flex items-center rounded-[6px] bg-panel-2 border border-border text-micro text-ink-2 select-none"
				>
					{label}
				</span>
			);
		}
		case 'done_clean': {
			const label = badge?.text ?? `已收口 · 干净${roundText}`;
			return (
				<StatusBadge
					state="succeeded"
					text={label}
					title={roundTitle}
					aria-label={label}
					data-badge="done_clean"
				/>
			);
		}
		case 'done_fixed': {
			const label = badge?.text ?? `已收口 · 已修${roundText}`;
			return (
				<StatusBadge
					state="succeeded"
					text={label}
					title={roundTitle}
					aria-label={label}
					data-badge="done_fixed"
				/>
			);
		}
		case 'open': {
			const count = badge?.remainingCount;
			const countText = count != null ? `${count}` : '—';
			const label = badge?.text ?? `有遗留 · ${countText} 条${roundText}`;
			return (
				<StatusBadge
					state="partial"
					text={label}
					title={roundTitle}
					aria-label={label}
					data-badge="open"
				/>
			);
		}
		case 'needs_attention': {
			const label = badge?.text ?? `收口等你${roundText}`;
			return (
				<StatusBadge
					state="awaiting_input"
					text={label}
					title={roundTitle}
					aria-label={label}
					data-badge="needs_attention"
				/>
			);
		}
		case 'awaiting_landing': {
			// notInHeadCount 优先读 badge，其次读 batch.notInHeadCount，缺失严格显示「—」（R5）
			const count = badge?.notInHeadCount ?? batch.notInHeadCount;
			const countText = count != null ? `${count}` : '—';
			const label = badge?.text ?? `等你落地 ${countText} 个${roundText}`;
			return (
				<StatusBadge
					state="awaiting_input"
					text={label}
					title={roundTitle}
					aria-label={label}
					data-badge="awaiting_landing"
				/>
			);
		}
		default:
			return null;
	}
}

/**
 * 批次树主组件（纯 props 展示层组件）。
 */
export function BatchTree({
	batches,
	expandedIds,
	selectedTaskId,
	densityTier,
	isTouch: isTouchProp,
	onToggleBatch,
	onSelectTask,
	onWrapup,
	onOpenWrapupRun,
	className = '',
}: BatchTreeProps) {
	const isPhoneTier = densityTier === 'phone' || densityTier === 'phone-xs';
	const isTouch = isTouchProp ?? isPhoneTier;
	const rowHeightClass = isTouch ? 'h-[44px] min-h-[44px]' : 'h-[30px] min-h-[30px]';

	// 键盘可达性处理（role="tree" 规范）
	const handleBatchHeaderKeyDown = (
		e: KeyboardEvent<HTMLElement>,
		batch: BatchTreeItem,
		isExpanded: boolean,
	) => {
		switch (e.key) {
			case 'Enter':
			case ' ': {
				e.preventDefault();
				onToggleBatch?.(batch.id);
				break;
			}
			case 'ArrowRight': {
				e.preventDefault();
				if (!isExpanded) {
					onToggleBatch?.(batch.id);
				} else {
					const target = e.currentTarget
						.closest('[role="treeitem"]')
						?.querySelector('button[data-task-btn="true"]') as HTMLElement | null;
					target?.focus();
				}
				break;
			}
			case 'ArrowLeft': {
				e.preventDefault();
				if (isExpanded) {
					onToggleBatch?.(batch.id);
				}
				break;
			}
			case 'ArrowDown': {
				e.preventDefault();
				const currentItem = e.currentTarget.closest('[role="treeitem"]');
				const allTreeItems = Array.from(
					currentItem?.closest('[role="tree"]')?.querySelectorAll('[role="treeitem"]') ?? [],
				);
				const index = allTreeItems.indexOf(currentItem as HTMLElement);
				if (index >= 0 && index < allTreeItems.length - 1) {
					const nextItem = allTreeItems[index + 1];
					const focusable = (nextItem?.querySelector('button, [tabindex="0"]') ??
						nextItem) as HTMLElement | null;
					focusable?.focus();
				}
				break;
			}
			case 'ArrowUp': {
				e.preventDefault();
				const currentItem = e.currentTarget.closest('[role="treeitem"]');
				const allTreeItems = Array.from(
					currentItem?.closest('[role="tree"]')?.querySelectorAll('[role="treeitem"]') ?? [],
				);
				const index = allTreeItems.indexOf(currentItem as HTMLElement);
				if (index > 0) {
					const prevItem = allTreeItems[index - 1];
					const focusable = (prevItem?.querySelector('button, [tabindex="0"]') ??
						prevItem) as HTMLElement | null;
					focusable?.focus();
				}
				break;
			}
		}
	};

	const handleTaskRowKeyDown = (
		e: KeyboardEvent<HTMLElement>,
		task: BatchTreeTaskItem,
		batchId: string,
	) => {
		switch (e.key) {
			case 'Enter':
			case ' ': {
				e.preventDefault();
				onSelectTask?.(task.id, batchId);
				break;
			}
			case 'ArrowLeft': {
				e.preventDefault();
				const parentItem = e.currentTarget
					.closest('[data-batch-id]')
					?.querySelector('button[data-action="toggle-batch"]') as HTMLElement | null;
				parentItem?.focus();
				break;
			}
			case 'ArrowDown': {
				e.preventDefault();
				const allButtons = Array.from(
					e.currentTarget
						.closest('[role="tree"]')
						?.querySelectorAll('button[data-task-btn="true"], button[data-wrapup-btn="true"]') ??
						[],
				);
				const index = allButtons.indexOf(e.currentTarget as HTMLButtonElement);
				if (index >= 0 && index < allButtons.length - 1) {
					(allButtons[index + 1] as HTMLElement | undefined)?.focus();
				}
				break;
			}
			case 'ArrowUp': {
				e.preventDefault();
				const allButtons = Array.from(
					e.currentTarget
						.closest('[role="tree"]')
						?.querySelectorAll('button[data-task-btn="true"], button[data-wrapup-btn="true"]') ??
						[],
				);
				const index = allButtons.indexOf(e.currentTarget as HTMLButtonElement);
				if (index > 0) {
					(allButtons[index - 1] as HTMLElement | undefined)?.focus();
				}
				break;
			}
		}
	};

	return (
		<div
			role="tree"
			aria-label="批次任务树"
			data-testid="batch-tree"
			data-component="batch-tree"
			data-density-tier={densityTier}
			className={['flex flex-col gap-1 w-full select-none m-0 p-0', className]
				.filter(Boolean)
				.join(' ')}
		>
			{batches.map((batch) => {
				const isExpanded = expandedIds.has(batch.id);
				const hasWaiting = typeof batch.waitingCount === 'number' && batch.waitingCount > 0;
				const hasCrossBatchFix = Boolean(batch.hasCrossBatchFix);

				// R5: 删除计数的猜测默认值，缺失严格显示「—」
				const landedText = batch.landedCount != null ? batch.landedCount : '—';
				const totalText = batch.taskCount != null ? batch.taskCount : '—';
				const runningText = batch.runningCount != null ? batch.runningCount : '—';
				const waitingText = batch.waitingCount != null ? batch.waitingCount : '—';

				return (
					<div
						key={batch.id}
						role="treeitem"
						aria-expanded={isExpanded}
						aria-level={1}
						data-batch-id={batch.id}
						data-batch-no={batch.batchNo}
						className="flex flex-col rounded-[9px] bg-panel-2/40 border border-border/70 overflow-hidden"
					>
						{/* ─────────────────────────────────────────────────────────────
						    批次标题行网格：16px minmax(0,1fr) auto auto
						    开合槽 · 「第 N 批」+ 计数 · 收口徽标 · 收口按钮槽
						    ───────────────────────────────────────────────────────────── */}
						<div
							className={[
								'grid items-center gap-2 px-2 transition-colors hover:bg-panel-2/80',
								rowHeightClass,
								isTouch
									? 'grid-cols-[44px_minmax(0,1fr)_auto_auto]'
									: 'grid-cols-[16px_minmax(0,1fr)_auto_auto]',
							].join(' ')}
						>
							{/* 第 1 列：开合指示槽（触摸档撑满 44×44） */}
							<button
								type="button"
								data-action="toggle-batch"
								aria-label={`第 ${batch.batchNo} 批折叠切换`}
								onClick={() => onToggleBatch?.(batch.id)}
								onKeyDown={(e) => handleBatchHeaderKeyDown(e, batch, isExpanded)}
								className={[
									'flex items-center justify-center p-0 m-0 bg-transparent border-0 text-ink-3 hover:text-ink-1 cursor-pointer focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)] rounded-sm',
									isTouch ? 'w-[44px] h-[44px] min-w-[44px] min-h-[44px]' : 'w-[16px] min-w-[16px]',
								].join(' ')}
							>
								<svg
									width="10"
									height="10"
									viewBox="0 0 10 10"
									fill="currentColor"
									aria-hidden="true"
									className="transition-transform duration-150 shrink-0"
									style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
								>
									<path d="M3 1.5 L7.5 5 L3 8.5 Z" />
								</svg>
							</button>

							{/* 第 2 列：「第 N 批」+ 固定格式标题计数（tabular monospace, R5 缺失显示「—」） */}
							<button
								type="button"
								onClick={() => onToggleBatch?.(batch.id)}
								onKeyDown={(e) => handleBatchHeaderKeyDown(e, batch, isExpanded)}
								className="flex items-center gap-2 min-w-0 p-0 m-0 bg-transparent border-0 text-left cursor-pointer overflow-hidden focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)] rounded-sm"
							>
								<span className="font-mono text-dense font-semibold text-ink-1 shrink-0">
									第 {batch.batchNo} 批{hasCrossBatchFix ? ' · 含跨批修复' : ''}
								</span>
								<span className="font-mono text-[12px] tabular-nums text-ink-3 truncate">
									已落地 {landedText}/{totalText} · 在跑 {runningText} ·{' '}
									<span className={hasWaiting ? 'text-needs' : 'text-ink-3'}>
										等你 {waitingText}
									</span>
								</span>
							</button>

							{/* 第 3 列：收口徽标（E-272, 决策 85） */}
							<div className="flex items-center shrink-0">{renderWrapupBadge(batch)}</div>

							{/* 第 4 列：收口按钮（非手机档且 canWrapup 为真时渲染，决策 32） */}
							<div className="flex items-center shrink-0">
								{batch.canWrapup && !isPhoneTier && (
									<button
										type="button"
										data-action="wrapup-batch"
										onClick={(e: MouseEvent) => {
											e.stopPropagation();
											onWrapup?.(batch.id);
										}}
										className="h-btn-sm px-2 rounded-sm border border-border bg-panel-2 text-ink-2 hover:text-ink-1 hover:border-border-strong font-ui text-micro font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]"
									>
										收口
									</button>
								)}
							</div>
						</div>

						{/* ─────────────────────────────────────────────────────────────
						    子行区：折叠的批不渲染子行（AC 1 硬指标：非 display:none）
						    ───────────────────────────────────────────────────────────── */}
						{isExpanded && (
							// biome-ignore lint/a11y/useSemanticElements: WAI-ARIA tree group container
							<div
								role="group"
								data-testid="batch-children"
								className="flex flex-col m-0 p-0 border-t border-border/50 bg-bg/50"
							>
								{/* 批次收口行（批次标题下第一行，若有收口运行） */}
								{batch.wrapupRow && (
									<div
										role="treeitem"
										aria-level={2}
										data-wrapup-row="true"
										data-run-id={batch.wrapupRow.runId}
										className="w-full"
									>
										<button
											type="button"
											data-wrapup-btn="true"
											onClick={() => {
												if (batch.wrapupRow?.runId) {
													onOpenWrapupRun?.(batch.wrapupRow.runId, batch.id);
												}
											}}
											onKeyDown={(e) => {
												if ((e.key === 'Enter' || e.key === ' ') && batch.wrapupRow?.runId) {
													e.preventDefault();
													onOpenWrapupRun?.(batch.wrapupRow.runId, batch.id);
												}
											}}
											className={[
												'w-full grid grid-cols-[20px_minmax(0,1fr)_auto_7ch] items-center gap-2 px-2 transition-colors cursor-pointer border-0 border-b border-border/30 bg-transparent text-left hover:bg-panel-2/60 focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]',
												rowHeightClass,
											].join(' ')}
										>
											{/* 第 1 列：呼吸点槽（按收口运行状态呼吸） */}
											<div className="w-[20px] flex items-center justify-center">
												{pulseForRun(batch.wrapupRow.state) !== 'none' && (
													<PulseDot
														variant={pulseForRun(batch.wrapupRow.state) as 'live' | 'waiting'}
														label={batch.wrapupRow.title ?? '批次收口运行'}
													/>
												)}
											</div>

											{/* 第 2 列：收口行标题 */}
											<div className="flex items-center gap-2 min-w-0">
												<span className="font-ui text-[13px] text-ink-1 font-medium truncate">
													{batch.wrapupRow.title ??
														(batch.wrapupRow.round
															? `批次收口 · 第 ${batch.wrapupRow.round} 轮`
															: '批次收口')}
												</span>
											</div>

											{/* 第 3 列：收口状态徽标 */}
											<div className="flex items-center shrink-0">
												<StatusBadge state={batch.wrapupRow.state ?? 'running'} />
											</div>

											{/* 第 4 列：固定 7ch 占位 */}
											<div className="w-[7ch] min-w-[7ch] text-right font-mono text-[11px] text-ink-3">
												—
											</div>
										</button>
									</div>
								)}

								{/* 任务子行列表 */}
								{(batch.tasks ?? []).map((task) => {
									const pulse = pulseForRun(task.state);
									const isSelected = selectedTaskId === task.id;

									// 进 HEAD 标记三态判定（E-298, R5: 绝不猜测默认 inHeadMethod）
									let inHeadText = '—';
									let inHeadTitle: string | undefined;
									if (task.inHead === true) {
										inHeadText = '进 HEAD';
									} else if (task.inHead === false) {
										inHeadText = '未进 HEAD';
										inHeadTitle = task.inHeadMethod ? task.inHeadMethod : undefined;
									}

									return (
										<div
											key={task.id}
											role="treeitem"
											aria-level={2}
											aria-selected={isSelected}
											data-task-id={task.id}
											data-task-key={task.taskKey}
											className="w-full"
										>
											<button
												type="button"
												data-task-btn="true"
												onClick={() => onSelectTask?.(task.id, batch.id)}
												onKeyDown={(e) => handleTaskRowKeyDown(e, task, batch.id)}
												className={[
													'w-full grid grid-cols-[20px_minmax(0,1fr)_auto_7ch] items-center gap-2 px-2 transition-colors cursor-pointer border-0 bg-transparent text-left hover:bg-panel-2/60 focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]',
													rowHeightClass,
													isSelected ? 'bg-panel-2/80 font-medium' : '',
												].join(' ')}
											>
												{/* 第 1 列：呼吸点槽（20px 宽） */}
												<div className="w-[20px] flex items-center justify-center">
													{pulse !== 'none' && (
														<PulseDot variant={pulse} label={`${task.taskKey} 状态`} />
													)}
												</div>

												{/* 第 2 列：taskKey 等宽 12px + 标题 13px 截断 + 跨批修复 chip */}
												<div className="flex items-center gap-2 min-w-0 overflow-hidden">
													<span className="font-mono text-[12px] text-ink-2 shrink-0">
														{task.taskKey}
													</span>
													<span className="font-ui text-[13px] text-ink-1 truncate">
														{task.title}
													</span>
													{task.crossBatchFix && (
														<span
															data-chip="cross-batch-fix"
															className="h-[20px] px-1.5 inline-flex items-center rounded-sm bg-panel-2 border border-border text-[11px] text-ink-3 shrink-0 select-none"
														>
															跨批修复
														</span>
													)}
												</div>

												{/* 第 3 列：状态徽标 */}
												<div className="flex items-center shrink-0">
													<StatusBadge state={task.state ?? 'queued'} />
												</div>

												{/* 第 4 列：固定 7ch 进 HEAD 标记（三态同色 --ink-3，E-298） */}
												<div
													data-in-head={
														task.inHead === true ? 'true' : task.inHead === false ? 'false' : 'null'
													}
													title={inHeadTitle}
													className="w-[7ch] min-w-[7ch] text-right font-mono text-[11px] text-ink-3 select-none"
												>
													{inHeadText}
												</div>
											</button>
										</div>
									);
								})}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

export default BatchTree;
