import { MAX_LANE_COUNT, MIN_LANE_COUNT } from './types.ts';

export interface LaneCountSettingProps {
	readonly laneCount: number;
	readonly onChangeLaneCount: (count: number) => void;
	readonly error?: string | null;
	readonly disabled?: boolean;
}

/**
 * 任务并行窗口数设置组件（AC 8 & E-248 呈现侧）
 * - 默认 2，值域 1–6；
 * - 设置项旁注明「此值只属于调度器，与阅读器互不影响」；
 * - 防止用户以为改一边等于改两边。
 */
export function LaneCountSetting({
	laneCount,
	onChangeLaneCount,
	error,
	disabled = false,
}: LaneCountSettingProps) {
	return (
		<div
			data-testid="lane-count-setting-card"
			className="flex flex-col gap-3 rounded border border-border bg-bg p-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h3 className="font-ui text-lead font-semibold text-ink-1">任务并行窗口数</h3>
					{/* AC 8 & E-248: 注明文案 */}
					<p data-testid="lane-count-notice" className="mt-0.5 text-meta text-ink-2">
						此值只属于调度器，与阅读器互不影响
					</p>
				</div>

				<div className="flex items-center gap-3">
					{/* 步进器调节 1-6 */}
					<div className="flex items-center rounded-sm border border-border bg-panel-2">
						<button
							type="button"
							onClick={() => onChangeLaneCount(Math.max(MIN_LANE_COUNT, laneCount - 1))}
							disabled={disabled || laneCount <= MIN_LANE_COUNT}
							aria-label="减少窗口数"
							data-testid="lane-count-decrease-btn"
							className="flex h-btn w-btn items-center justify-center font-mono text-lead text-ink-2 hover:text-ink-1 disabled:opacity-30"
						>
							-
						</button>
						<span
							data-testid="lane-count-value"
							className="flex h-btn w-12 items-center justify-center font-mono text-lead font-semibold text-ink-1 select-none"
						>
							{laneCount}
						</span>
						<button
							type="button"
							onClick={() => onChangeLaneCount(Math.min(MAX_LANE_COUNT, laneCount + 1))}
							disabled={disabled || laneCount >= MAX_LANE_COUNT}
							aria-label="增加窗口数"
							data-testid="lane-count-increase-btn"
							className="flex h-btn w-btn items-center justify-center font-mono text-lead text-ink-2 hover:text-ink-1 disabled:opacity-30"
						>
							+
						</button>
					</div>

					<span className="text-dense text-ink-3">（范围 1–6，默认 2）</span>
				</div>
			</div>

			{error && (
				<div data-testid="lane-count-error" className="text-micro text-down">
					{error}
				</div>
			)}
		</div>
	);
}
