/**
 * packages/web/src/components/pipeline-toggles.tsx
 *
 * 顶栏流水线开关展示层组件（M9-T22 / AC 1, AC 2, AC 3, E-26, E-306, E-312）
 *
 * 规范依据（07 节前端架构、11 节 UI 与边界 E-26、E-306、E-312）：
 * - 纯 props in / callback out，受控无内部 state，状态等回流不乐观翻转（AC 2, E-157, E-318）
 * - 两个开关同一形态（二段、高 --h-btn-sm，查 bug 与收口模式）
 * - value === null 时显示「—」并 disabled（AC 2, E-26）
 * - 只 import ui/segmented-toggle，严禁 import gate-toggles，不复制 markup（AC 1 机检）
 * - 「查 bug」切开（bughunt === 1）常驻一行说明，不弹 dialog（AC 3, E-306）
 * - 「收口」切手动（wrapupMode === 'manual'）常驻一行说明，不弹 dialog（AC 3, E-312）
 * - onChange 永远给出包含 bughunt 与 wrapupMode 的全量两值（AC 2）
 */

import type { HTMLAttributes } from 'react';
import { UI_STRINGS } from '../i18n/ui-strings.ts';
import { SegmentedToggle, type SegmentedToggleOption } from '../ui/segmented-toggle.tsx';

export interface PipelineTogglesValues {
	readonly bughunt: 0 | 1;
	readonly wrapupMode: 'auto' | 'manual';
}

export interface PipelineTogglesProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
	/** 流水线设置的当前生效值（由 daemon 下发） */
	readonly value?: PipelineTogglesValues | null;
	/** 是否有在途 PATCH 请求 */
	readonly isPending?: boolean;
	/** 布局方向：topbar 紧凑横排（默认）或 settings 坚排卡片 */
	readonly layout?: 'topbar' | 'settings';
	/** 用户点击切换回调（必须携带全量两值，AC 2） */
	readonly onChange?: (nextValues: PipelineTogglesValues) => void;
	/** 外部自定义类名 */
	readonly className?: string;
}

const BUGHUNT_OPTIONS: readonly SegmentedToggleOption<0 | 1>[] = [
	{ value: 0, label: '关' },
	{ value: 1, label: '开' },
];

const WRAPUP_MODE_OPTIONS: readonly SegmentedToggleOption<'auto' | 'manual'>[] = [
	{ value: 'auto', label: '自动' },
	{ value: 'manual', label: '手动' },
];

export function PipelineToggles({
	value,
	isPending = false,
	layout = 'topbar',
	onChange,
	className = '',
	...rest
}: PipelineTogglesProps) {
	const isTopbar = layout === 'topbar';
	const isBughuntOn = value?.bughunt === 1;
	const isWrapupManual = value?.wrapupMode === 'manual';

	const handleBughuntChange = (target: 0 | 1) => {
		if (!value || isPending) return;
		if (value.bughunt === target) return;
		onChange?.({
			bughunt: target,
			wrapupMode: value.wrapupMode,
		});
	};

	const handleWrapupModeChange = (target: 'auto' | 'manual') => {
		if (!value || isPending) return;
		if (value.wrapupMode === target) return;
		onChange?.({
			bughunt: value.bughunt,
			wrapupMode: target,
		});
	};

	return (
		<div
			data-component="pipeline-toggles"
			data-layout={layout}
			data-pending={isPending ? 'true' : 'false'}
			className={['flex flex-col gap-1.5 select-none', className].filter(Boolean).join(' ')}
			{...rest}
		>
			<div
				className={[
					'flex items-center gap-3',
					isTopbar ? 'flex-row flex-wrap' : 'flex-col sm:flex-row gap-4',
				].join(' ')}
			>
				{/* 开关 1：查 bug（bughunt: 0 | 1） */}
				<div data-pipeline-toggle="bughunt" className="flex items-center gap-2">
					<span className="font-ui text-dense text-ink-2 text-xs shrink-0">
						{UI_STRINGS.pipeline.bughuntLabel}
					</span>
					<SegmentedToggle<0 | 1>
						ariaLabel="查 bug 设置"
						value={value ? value.bughunt : null}
						options={BUGHUNT_OPTIONS}
						disabled={!value || isPending}
						placeholder={UI_STRINGS.pipeline.fallback}
						onChange={handleBughuntChange}
					/>
				</div>

				{/* 开关 2：收口模式（wrapupMode: auto | manual） */}
				<div data-pipeline-toggle="wrapupMode" className="flex items-center gap-2">
					<span className="font-ui text-dense text-ink-2 text-xs shrink-0">
						{UI_STRINGS.pipeline.wrapupModeLabel}
					</span>
					<SegmentedToggle<'auto' | 'manual'>
						ariaLabel="收口模式设置"
						value={value ? value.wrapupMode : null}
						options={WRAPUP_MODE_OPTIONS}
						disabled={!value || isPending}
						placeholder={UI_STRINGS.pipeline.fallback}
						onChange={handleWrapupModeChange}
					/>
				</div>
			</div>

			{/* ─────────────────────────────────────────────────────────────
			    「查 bug」切开常驻一行说明，不弹 dialog（AC 3, E-306）
			    ───────────────────────────────────────────────────────────── */}
			{isBughuntOn && (
				<div
					data-testid="bughunt-auto-note"
					className="text-[12px] font-ui text-ink-3 tracking-tight"
				>
					{UI_STRINGS.pipeline.bughuntAutoNote}
				</div>
			)}

			{/* ─────────────────────────────────────────────────────────────
			    「收口」切手动常驻一行说明，不弹 dialog（AC 3, E-312）
			    ───────────────────────────────────────────────────────────── */}
			{isWrapupManual && (
				<div
					data-testid="wrapup-manual-note"
					className="text-[12px] font-ui text-ink-3 tracking-tight"
				>
					{UI_STRINGS.pipeline.wrapupManualNote}
				</div>
			)}
		</div>
	);
}

export default PipelineToggles;
