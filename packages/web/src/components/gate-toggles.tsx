/**
 * packages/web/src/components/gate-toggles.tsx
 *
 * 顶栏闸门开关组件（M9-T19, M9-T22 / AC 1, AC 6, E-299）
 *
 * 规范依据（07 节前端架构、11 节 UI 与边界 E-299）：
 * - 纯 props in / callback out，受控无内部 state，状态等回流不乐观翻转（E-299）
 * - 三个开关同一形态（派发前、审查前、落地前），高 --h-btn-sm，两段「等我确认 | 自动」
 * - 落地前开关完全可切，不再置灰（E-299）
 * - 落地开关切到自动时不弹 dialog、不二次确认，开关行下常驻一行提示：
 *   「审查 pass 后直接标记已验收，仍不执行任何 git 操作」（E-299）
 * - value === null 时展示加载占位或置灰
 * - 二段开关基元统一从 ui/segmented-toggle 导入，严禁 import pipeline-toggles（AC 1 机检）
 */

import type { GateSettings } from '@agent-scheduler/shared/api/settings';
import type { HTMLAttributes } from 'react';
import { SegmentedToggle, type SegmentedToggleOption } from '../ui/segmented-toggle.tsx';

export type GateMode = 'auto' | 'manual';
export type GateSettingsValues = GateSettings;

export interface GateTogglesProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
	/** 三个闸门当前生效值（由 daemon 下发） */
	readonly value?: GateSettingsValues | null;
	/** 是否有在途 PATCH 请求 */
	readonly isPending?: boolean;
	/** 布局方向：topbar 紧凑横排（默认）或 settings 坚排卡片 */
	readonly layout?: 'topbar' | 'settings';
	/** 用户点击切换回调（必须携带全量三值，AC 6） */
	readonly onChange?: (nextValues: GateSettingsValues) => void;
	/** 外部自定义类名 */
	readonly className?: string;
}

interface GateConfig {
	readonly key: keyof GateSettingsValues;
	readonly label: string;
}

const GATES: readonly GateConfig[] = [
	{ key: 'dispatch', label: '派发前' },
	{ key: 'review', label: '审查前' },
	{ key: 'landing', label: '落地前' },
];

const GATE_OPTIONS: readonly SegmentedToggleOption<GateMode>[] = [
	{ value: 'manual', label: '等我确认' },
	{ value: 'auto', label: '自动' },
];

/**
 * 闸门开关纯 props 组件。
 */
export function GateToggles({
	value,
	isPending = false,
	layout = 'topbar',
	onChange,
	className = '',
	...rest
}: GateTogglesProps) {
	const isTopbar = layout === 'topbar';
	const isLandingAuto = value?.landing === 'auto';

	const handleToggle = (key: keyof GateSettingsValues, targetMode: GateMode) => {
		if (!value || isPending) return;
		if (value[key] === targetMode) return;

		// 触发全量三值回调（自身不翻转，等待服务端回流，E-299）
		onChange?.({
			...value,
			[key]: targetMode,
		});
	};

	return (
		<div
			data-component="gate-toggles"
			data-layout={layout}
			data-pending={isPending ? 'true' : 'false'}
			className={['flex flex-col gap-1.5 select-none', className].filter(Boolean).join(' ')}
			{...rest}
		>
			{/* 三个开关行：同一形态，第三个不再置灰（AC 6, E-299） */}
			<div
				className={[
					'flex items-center gap-3',
					isTopbar ? 'flex-row flex-wrap' : 'flex-col sm:flex-row gap-4',
				].join(' ')}
			>
				{GATES.map((gate) => (
					<div key={gate.key} data-gate-toggle={gate.key} className="flex items-center gap-2">
						<span className="font-ui text-dense text-ink-2 text-xs shrink-0">{gate.label}</span>

						{/* 二段开关基元（高 --h-btn-sm，26px，封装无业务词的 segmented-toggle 结构） */}
						<SegmentedToggle<GateMode>
							ariaLabel={`${gate.label}闸门设置`}
							value={value ? value[gate.key] : null}
							options={GATE_OPTIONS}
							disabled={!value || isPending}
							onChange={(targetMode) => handleToggle(gate.key, targetMode)}
						/>
					</div>
				))}
			</div>

			{/* ─────────────────────────────────────────────────────────────
			    切到自动不弹 dialog 而常驻一句提示（E-299）
			    ───────────────────────────────────────────────────────────── */}
			{isLandingAuto && (
				<div
					data-testid="landing-auto-note"
					className="text-[12px] font-ui text-ink-3 tracking-tight"
				>
					审查 pass 后直接标记已验收，仍不执行任何 git 操作
				</div>
			)}
		</div>
	);
}

export default GateToggles;
