/**
 * packages/web/src/features/run-deck/lane-steps-container.tsx
 *
 * 阶段展开步骤容器（M9-T21 / AC 2, E-315 / 07 节前端架构：容器层只管组织布局，无颜色字号样式）
 *
 * 规范依据：
 * - 紧凑档当前阶段只保留最后一行步骤，五档都不折、不换表示（AC 2, E-315）
 * - 按 E-165 展开某条泳道时，该泳道各阶段内步骤全部展开（E-315）
 */

import type { HTMLAttributes } from 'react';
import { StreamRow } from '../../components/stream-row.tsx';
import type { DensityTier } from '../../hooks/use-breakpoint.ts';
import type { StatusState } from '../../lib/spine-shape.ts';
import type { StageRow } from '../../lib/stage-rows.ts';

export interface LaneStepItem {
	readonly id: string | number;
	readonly tool?: string;
	readonly target?: string;
	readonly status?: StatusState | string;
	readonly duration?: number | string | null;
	readonly isFailed?: boolean;
	readonly errorMessage?: string;
	readonly detail?: string;
	readonly payload?: unknown;
}

export interface LaneStepsContainerProps extends HTMLAttributes<HTMLDivElement> {
	/** 当前阶段行数据 */
	readonly stageRow: StageRow;
	/** 外部传入的步骤列表（由会话事件流衍生） */
	readonly steps?: readonly LaneStepItem[];
	/** 密度档位 */
	readonly tier?: DensityTier;
	/** 是否在紧凑档中展开（E-165, E-315） */
	readonly isExpanded?: boolean;
	/** 是否为触摸档 */
	readonly isTouch?: boolean;
	/** 从某一步重试回调 */
	readonly onRetryStep?: (stepIndex: number, step: LaneStepItem) => void;
}

export function LaneStepsContainer({
	stageRow,
	steps = [],
	tier,
	isExpanded = false,
	isTouch = false,
	onRetryStep,
	className,
	...rest
}: LaneStepsContainerProps) {
	// AC 2 & E-315: 紧凑档且未展开时，当前阶段只保留最后一行步骤
	const isCompactCollapsed = tier === 'compact' && !isExpanded;
	const visibleSteps = isCompactCollapsed && steps.length > 0 ? steps.slice(-1) : steps;

	if (visibleSteps.length === 0) {
		return null;
	}

	return (
		<div
			data-container="lane-steps"
			data-compact-collapsed={isCompactCollapsed ? 'true' : 'false'}
			className={['flex flex-col w-full pl-3 gap-0.5', className ?? ''].join(' ')}
			{...rest}
		>
			{visibleSteps.map((step, idx) => {
				const originalIndex = isCompactCollapsed ? steps.length - 1 : idx;
				return (
					<StreamRow
						key={step.id ?? idx}
						tool={step.tool}
						target={step.target}
						status={step.status ?? (step.isFailed ? 'failed' : undefined)}
						duration={step.duration}
						errorMessage={step.errorMessage}
						detail={step.detail}
						payload={step.payload}
						isTouch={isTouch}
						onRetry={onRetryStep ? () => onRetryStep(originalIndex, step) : undefined}
					/>
				);
			})}
		</div>
	);
}
