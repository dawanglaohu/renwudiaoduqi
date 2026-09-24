/**
 * packages/web/src/components/stage-chain.tsx
 *
 * 流水线阶段链展示组件（M9-T21 / AC 2..5, E-306, E-307, E-313, E-314, E-315 / 11 节 UI）
 *
 * 规范依据：
 * - 纯 props in / callback out，禁止 import api/store/features/shell（07 节）
 * - 阶段链每阶段一行 30px（触摸 44px），已过阶段折一行带总耗时、当前阶段展开步骤、未来阶段虚线且耗时列留空（AC 2, E-315）
 * - 网格沿用运行流条目：20px minmax(0,1fr) auto 16px（AC 2, E-315）
 * - 标签 13px font-ui，阶段耗时等宽 12px font-mono（E-315）
 * - 返工回环由 LOOP_PIECES 画在 20px 轨列内，reworkCount=0 不画（AC 3）
 * - 阶段行 Enter 或点击 → onOpenRun(runId) 打开最近一次运行详情（AC 5, E-313）
 * - readOnly 或 runId=null 的行无 tabIndex（AC 5, E-313）
 * - 轨不测量 DOM：禁止 getBoundingClientRect / offsetHeight（07 节, AC 3）
 */

import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import type { DensityTier } from '../hooks/use-breakpoint.ts';
import { type StageRow, formatStageDuration } from '../lib/stage-rows.ts';
import { SpineSegmentView } from './spine.tsx';

export interface StageChainProps extends HTMLAttributes<HTMLDivElement> {
	/** 阶段行列表（来自 deriveStageRows 纯函数） */
	readonly stageRows: readonly StageRow[];
	/** 点击或回车打开运行详情回调（E-313） */
	readonly onOpenRun?: (runId: string) => void;
	/** 是否处于只读模式（历史行展开时为 true，AC 6, E-314） */
	readonly readOnly?: boolean;
	/** 是否为触摸档 */
	readonly isTouch?: boolean;
	/** 密度档位 */
	readonly tier?: DensityTier;
	/** 是否在紧凑档中展开（E-165） */
	readonly isExpanded?: boolean;
	/** 步骤渲染槽位（由容器层注入步骤列表） */
	readonly renderSteps?: (stageRow: StageRow) => ReactNode;
}

export function StageChain({
	stageRows,
	onOpenRun,
	readOnly = false,
	isTouch = false,
	tier,
	isExpanded = false,
	renderSteps,
	className,
	...rest
}: StageChainProps) {
	const rowHeight = isTouch ? 44 : 30;

	return (
		<div
			data-component="stage-chain"
			data-readonly={readOnly ? 'true' : 'false'}
			className={['flex flex-col w-full select-none', className ?? ''].join(' ')}
			{...rest}
		>
			{stageRows.map((row) => {
				const isClickable = Boolean(row.runId && onOpenRun);
				// AC 5 & E-313: readOnly 或 runId=null 的行无 tabIndex
				const isFocusable = !readOnly && isClickable;

				const handleRowClick = () => {
					if (isClickable && row.runId) {
						onOpenRun?.(row.runId);
					}
				};

				const handleRowKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
					if (!isFocusable) return;
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						if (row.runId) {
							onOpenRun?.(row.runId);
						}
					}
				};

				const spineKind = readOnly && row.spineKind === 'live' ? 'done' : row.spineKind;
				const displayDuration = formatStageDuration(row.durationMs);

				return (
					<div
						key={row.id}
						data-stage-row={row.id}
						data-stage-status={row.status}
						className="flex flex-col w-full"
					>
						{/* 阶段主行：30px（触控 44px），网格 20px minmax(0,1fr) auto 16px */}
						<div
							role={isClickable ? 'button' : undefined}
							tabIndex={isFocusable ? 0 : undefined}
							aria-label={`${row.label}${displayDuration ? ` · ${displayDuration}` : ''}`}
							onClick={isClickable ? handleRowClick : undefined}
							onKeyDown={isFocusable ? handleRowKeyDown : undefined}
							className={[
								'grid grid-cols-[20px_minmax(0,1fr)_auto_16px] items-center gap-x-2 w-full px-1 rounded-[6px] transition-colors',
								isClickable ? 'cursor-pointer hover:bg-[var(--panel-2)]' : 'cursor-default',
								isFocusable
									? 'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]'
									: 'focus:outline-none',
							].join(' ')}
							style={{ height: `${rowHeight}px`, minHeight: `${rowHeight}px` }}
						>
							{/* 第 1 列：20px 轨列（包含 12px 阶段大节点与返工回环片段） */}
							<div
								data-slot="stage-spine"
								className="w-[20px] h-full flex items-center justify-center shrink-0"
							>
								<SpineSegmentView
									segment={{
										kind: spineKind,
										shape: 'tool',
										level: 'stage',
										loop: row.loop,
									}}
									rowHeight={rowHeight}
									isTouch={isTouch}
								/>
							</div>

							{/* 第 2 列：minmax(0,1fr) 阶段标签（13px font-ui） */}
							<div className="min-w-0 flex items-center">
								<span
									data-field="stage-label"
									title={row.label}
									className="font-ui text-[13px] text-[var(--ink-1)] truncate leading-none select-none"
								>
									{row.label}
								</span>
							</div>

							{/* 第 3 列：auto 阶段耗时（12px font-mono 等宽，未来阶段留空） */}
							<div className="shrink-0 flex items-center justify-end pl-1">
								<span
									data-field="stage-duration"
									className="font-mono text-[12px] text-[var(--ink-3)] tabular-nums leading-none select-none"
								>
									{displayDuration}
								</span>
							</div>

							{/* 第 4 列：16px 展开与状态指示槽位 */}
							<div className="w-[16px] h-full flex items-center justify-center shrink-0">
								{isClickable && !readOnly && (
									<span
										data-action-hint="open-run"
										className="text-[11px] text-[var(--ink-3)] opacity-0 group-hover:opacity-100 select-none"
										aria-hidden="true"
									>
										›
									</span>
								)}
							</div>
						</div>

						{/* 当前阶段展开步骤（AC 2, E-315）：已过阶段折叠，当前阶段展示步骤 */}
						{row.isCurrent && renderSteps && (
							<div data-slot="stage-steps" className="w-full">
								{renderSteps(row)}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
