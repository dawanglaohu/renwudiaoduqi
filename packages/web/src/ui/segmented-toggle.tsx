import type { HTMLAttributes } from 'react';

/**
 * packages/web/src/ui/segmented-toggle.tsx
 *
 * 二段/分段开关基础 UI 原语（M9-T22 / 07 节前端架构、11 节 UI 规范）。
 *
 * 规范依据：
 * - ui 目录禁止出现 task / run / agent / gate / batch / spine 等业务词。
 * - 高度固定为 --h-btn-sm（26px），圆角 --r-sm（9px，外层 rounded-sm / 内层 rounded-[3px]）。
 * - 纯受控组件，无内部状态，受控 value 驱动。
 * - 当 value 为 null / undefined 且提供了 placeholder（例如「—」）时，显示置灰占位符（E-26）。
 */

export interface SegmentedToggleOption<T extends string | number> {
	readonly value: T;
	readonly label: string;
	readonly disabled?: boolean;
}

export interface SegmentedToggleProps<T extends string | number>
	extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
	readonly value?: T | null;
	readonly options: readonly SegmentedToggleOption<T>[];
	readonly disabled?: boolean;
	readonly placeholder?: string;
	readonly ariaLabel?: string;
	readonly onChange?: (nextValue: T) => void;
	readonly className?: string;
}

export function SegmentedToggle<T extends string | number>({
	value,
	options,
	disabled = false,
	placeholder,
	ariaLabel,
	onChange,
	className = '',
	...rest
}: SegmentedToggleProps<T>) {
	const isNullValue = value === null || value === undefined;

	// E-26: 当缺少生效值且指定了占位符时，渲染置灰不可点的「—」占位块，锁死 --h-btn-sm
	if (isNullValue && placeholder !== undefined) {
		return (
			<div
				aria-label={ariaLabel}
				aria-disabled="true"
				data-disabled="true"
				className={[
					'inline-flex items-center justify-center px-3 rounded-sm bg-bg border border-border h-btn-sm shrink-0',
					'text-ink-3 font-ui text-micro opacity-50 cursor-not-allowed select-none',
					className,
				]
					.filter(Boolean)
					.join(' ')}
				{...rest}
			>
				{placeholder}
			</div>
		);
	}

	return (
		<div
			aria-label={ariaLabel}
			className={[
				'inline-flex items-center p-0.5 rounded-sm bg-bg border border-border h-btn-sm shrink-0 select-none',
				className,
			]
				.filter(Boolean)
				.join(' ')}
			{...rest}
		>
			{options.map((option) => {
				const isSelected = !isNullValue && value === option.value;
				const isBtnDisabled = disabled || option.disabled || isNullValue;

				return (
					<button
						key={String(option.value)}
						type="button"
						aria-pressed={isSelected}
						disabled={isBtnDisabled}
						data-state={isSelected ? 'active' : 'inactive'}
						onClick={() => {
							if (!isBtnDisabled && !isSelected) {
								onChange?.(option.value);
							}
						}}
						className={[
							'px-2 h-full inline-flex items-center justify-center rounded-[3px] font-ui text-micro font-medium transition-colors cursor-pointer border-0',
							'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]',
							isSelected
								? 'bg-panel-2 text-ink-1 font-semibold shadow-sm'
								: 'bg-transparent text-ink-3 hover:text-ink-2',
							isBtnDisabled ? 'opacity-50 cursor-not-allowed' : '',
						]
							.filter(Boolean)
							.join(' ')}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

export default SegmentedToggle;
