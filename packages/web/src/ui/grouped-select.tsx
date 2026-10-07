/**
 * packages/web/src/ui/grouped-select.tsx
 *
 * 分组选择器通用组件（M9-T23 / AC 2 / 07 节前端架构 UI 二封）
 *
 * 规范依据：
 * - 纯 UI 原语：禁止出现任何业务词汇（task/run/agent/gate/batch/spine）
 * - 基于 radix Select 二次封装
 * - 严禁引入 cmdk 或 command
 * - 手填项激活时展开等宽输入框（Enter/失焦提交，Escape 回退）
 * - 底部 footer 使用 role="note" 不进键盘导航
 * - 窄屏/手机端全屏模式，行高使用 --row-h-touch，break-all 避免截断
 */

import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from './shadcn/select.tsx';

export interface GroupedSelectOption {
	readonly value: string;
	readonly label: string;
	readonly chip?: string;
	readonly badge?: ReactNode;
	readonly isCustomAction?: boolean;
	readonly note?: string;
}

export interface GroupedSelectSubgroup {
	readonly id?: string;
	readonly label?: string;
	readonly badge?: ReactNode;
	readonly items: readonly GroupedSelectOption[];
}

export interface GroupedSelectGroup {
	readonly id: string;
	readonly label: string;
	readonly subgroups: readonly GroupedSelectSubgroup[];
}

export interface GroupedSelectProps {
	readonly labels?: {
		readonly confirm: string;
		readonly cancel: string;
		readonly close: string;
		readonly placeholder?: string;
		readonly customActionPlaceholder?: string;
	};
	readonly value: string | null;
	readonly onValueChange: (value: string) => void;
	readonly groups: readonly GroupedSelectGroup[];
	readonly placeholder?: string;
	readonly disabled?: boolean;
	readonly noteFooter?: ReactNode;
	readonly customActionKey?: string;
	readonly onCustomActionSubmit?: (value: string) => void;
	readonly customActionPlaceholder?: string;
	readonly className?: string;
	readonly triggerClassName?: string;
	readonly triggerTestId?: string;
	readonly id?: string;
}

export function GroupedSelect({
	value,
	onValueChange,
	groups,
	placeholder,
	disabled = false,
	noteFooter,
	customActionKey = '__manual_custom_model__',
	onCustomActionSubmit,
	customActionPlaceholder,
	className = '',
	triggerClassName = '',
	triggerTestId = 'grouped-select-trigger',
	id,
	labels = { confirm: 'Confirm', cancel: 'Cancel', close: 'Close' },
}: GroupedSelectProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [isCustomMode, setIsCustomMode] = useState(false);
	const [customInputValue, setCustomInputValue] = useState('');
	const [isMobile, setIsMobile] = useState(false);

	const customInputRef = useRef<HTMLInputElement>(null);
	const customGroupRef = useRef<HTMLDivElement>(null);

	// 响应式检查：phone / phone-xs (< 640px)
	useEffect(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
		const mql = window.matchMedia('(max-width: 639px)');
		setIsMobile(mql.matches);
		const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
		mql.addEventListener('change', handler);
		return () => mql.removeEventListener('change', handler);
	}, []);

	useEffect(() => {
		if (isCustomMode && customInputRef.current) {
			customInputRef.current.focus();
		}
	}, [isCustomMode]);

	const handleSelectChange = (newVal: string) => {
		if (newVal === customActionKey) {
			setIsCustomMode(true);
			setCustomInputValue('');
			setIsOpen(false);
			return;
		}
		onValueChange(newVal);
		setIsOpen(false);
	};

	const handleCustomSubmit = () => {
		const trimmed = customInputValue.trim();
		if (trimmed) {
			if (onCustomActionSubmit) {
				onCustomActionSubmit(trimmed);
			}
			onValueChange(trimmed);
		}
		setIsCustomMode(false);
	};

	const handleCustomKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleCustomSubmit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			setIsCustomMode(false);
		}
	};

	// 如果处于手填展开输入框状态，渲染等宽输入框
	if (isCustomMode) {
		return (
			<div ref={customGroupRef} className={`flex items-center gap-1.5 w-full ${className}`}>
				<input
					ref={customInputRef}
					type="text"
					value={customInputValue}
					onChange={(e) => setCustomInputValue(e.target.value)}
					onBlur={(event) => {
						if (!customGroupRef.current?.contains(event.relatedTarget)) handleCustomSubmit();
					}}
					onKeyDown={handleCustomKeyDown}
					placeholder={customActionPlaceholder ?? labels.customActionPlaceholder}
					data-testid="grouped-select-custom-input"
					className="min-w-0 h-[var(--h-input)] min-h-[var(--h-input-touch)] sm:min-h-0 flex-1 rounded-[var(--r-sm)] border border-[var(--needs)] bg-[var(--panel-2)] px-2.5 font-mono text-[12.5px] text-[var(--ink-1)] placeholder:text-[var(--ink-3)] focus:outline-none"
				/>
				<button
					type="button"
					onClick={handleCustomSubmit}
					className="h-[var(--h-input)] min-h-[var(--h-btn-lg)] sm:min-h-0 px-2.5 rounded-[var(--r-sm)] bg-[var(--needs)] font-ui text-[12px] font-medium text-[var(--on-needs)] hover:opacity-90"
				>
					{labels.confirm}
				</button>
				<button
					type="button"
					onClick={() => setIsCustomMode(false)}
					className="h-[var(--h-input)] min-h-[var(--h-btn-lg)] sm:min-h-0 px-2 rounded-[var(--r-sm)] border border-[var(--border)] text-[var(--ink-2)] text-[12px] font-ui hover:bg-[var(--panel-2)]"
				>
					{labels.cancel}
				</button>
			</div>
		);
	}

	// 查找当前选中项的标签
	let selectedLabel: ReactNode = null;
	if (value) {
		for (let g = 0; g < groups.length; g++) {
			const group = groups[g];
			if (!group) continue;
			for (let sg = 0; sg < group.subgroups.length; sg++) {
				const subgroup = group.subgroups[sg];
				if (!subgroup) continue;
				const found = subgroup.items.find((i) => i.value === value);
				if (found) {
					selectedLabel = (
						<span className="flex items-center gap-2 truncate">
							<span className="truncate">{found.label}</span>
							{found.chip && (
								<span className="px-1.5 py-0.2 rounded-[3px] bg-[var(--panel-2)] border border-[var(--border)] font-mono text-[10px] text-[var(--ink-2)]">
									{found.chip}
								</span>
							)}
						</span>
					);
					break;
				}
			}
			if (selectedLabel) break;
		}
		if (!selectedLabel) {
			selectedLabel = value;
		}
	}

	return (
		<div className={`relative w-full ${className}`}>
			<Select
				open={isOpen}
				onOpenChange={setIsOpen}
				value={value ?? ''}
				onValueChange={handleSelectChange}
				disabled={disabled}
			>
				<SelectTrigger
					id={id}
					data-testid="grouped-select-trigger"
					className={`h-[var(--h-input)] min-h-[var(--h-input-touch)] sm:min-h-0 font-mono text-[12.5px] ${triggerClassName}`}
				>
					<SelectValue placeholder={placeholder ?? labels.placeholder}>
						{selectedLabel || <span className="font-ui text-[var(--ink-3)]">{placeholder}</span>}
					</SelectValue>
				</SelectTrigger>

				<SelectContent
					data-testid="grouped-select-content"
					fullScreen={isMobile}
					className={
						isMobile
							? 'flex flex-col rounded-none border-none bg-[var(--bg)] p-4'
							: 'max-h-80 w-[var(--radix-select-trigger-width)] min-w-[260px]'
					}
				>
					{isMobile && (
						<div className="flex items-center justify-between pb-3 mb-2 border-b border-[var(--border)]">
							<span className="font-ui text-[14px] font-semibold text-[var(--ink-1)]">
								{placeholder}
							</span>
							<button
								type="button"
								onClick={() => setIsOpen(false)}
								className="h-[var(--h-btn-lg)] px-3 rounded-[var(--r-sm)] bg-[var(--panel-2)] text-[var(--ink-2)] text-dense"
							>
								{labels.close}
							</button>
						</div>
					)}

					{groups.map((group, gIndex) => (
						<SelectGroup key={group.id} data-group={group.id}>
							{gIndex > 0 && <SelectSeparator />}
							<SelectLabel>{group.label}</SelectLabel>

							{group.subgroups.map((subgroup, sgIndex) => (
								<div key={subgroup.id ?? `${group.id}-sg-${sgIndex}`} className="flex flex-col">
									{subgroup.label && (
										<div className="flex items-center gap-1.5 px-3 py-1 font-mono text-[11px] text-[var(--ink-3)]">
											{subgroup.badge}
											<span>{subgroup.label}</span>
										</div>
									)}

									{subgroup.items.map((item, itemIndex) => (
										<SelectItem
											key={`${subgroup.id ?? sgIndex}-${itemIndex}`}
											value={item.value}
											data-testid={`select-option-${item.value}`}
											className={`break-all whitespace-normal ${
												isMobile ? 'min-h-[var(--row-h-touch)] py-2.5 text-[13px]' : 'py-1.5'
											}`}
										>
											<div className="flex items-center justify-between gap-2 w-full pr-2">
												<span className="min-w-0 break-all">{item.label}</span>
												{item.chip && (
													<span className="px-1 py-0.2 rounded-[3px] bg-[var(--panel-2)] border border-[var(--border)] text-[9.5px] font-mono text-[var(--ink-2)] shrink-0">
														{item.chip}
													</span>
												)}
											</div>
											{item.note && (
												<span className="block text-micro text-[var(--ink-3)] break-all">
													{item.note}
												</span>
											)}
										</SelectItem>
									))}
								</div>
							))}
						</SelectGroup>
					))}

					{noteFooter && (
						<div
							role="note"
							tabIndex={-1}
							data-testid="select-note-footer"
							className="mt-2 pt-2 border-t border-[var(--border)] px-2.5 py-1.5 font-ui text-[11.5px] text-[var(--ink-3)] select-none pointer-events-none"
						>
							{noteFooter}
						</div>
					)}
				</SelectContent>
			</Select>
		</div>
	);
}
