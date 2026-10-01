/**
 * packages/web/src/ui/shadcn/select.tsx
 *
 * Radix Select 基元封装（07 节前端架构 / 唯一允许 import @radix-ui/* 的目录）
 *
 * 规范依据：
 * - 纯 UI 原语：禁止出现业务词汇
 * - 样式一律使用 tokens.css 的 CSS 变量
 */

import * as SelectPrimitive from '@radix-ui/react-select';
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react';

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<
	ElementRef<typeof SelectPrimitive.Trigger>,
	ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className = '', children, ...props }, ref) => (
	<SelectPrimitive.Trigger
		ref={ref}
		className={`flex h-[var(--h-input)] w-full items-center justify-between rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg)] px-3 text-[13px] text-[var(--ink-1)] placeholder:text-[var(--ink-3)] focus:border-[var(--needs)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
		{...props}
	>
		{children}
		<SelectPrimitive.Icon asChild>
			<svg
				className="ml-2 h-4 w-4 shrink-0 text-[var(--ink-3)]"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				aria-hidden="true"
			>
				<path d="M4 6l4 4 4-4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		</SelectPrimitive.Icon>
	</SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

export const SelectContent = forwardRef<
	ElementRef<typeof SelectPrimitive.Content>,
	ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className = '', children, position = 'popper', ...props }, ref) => (
	<SelectPrimitive.Portal>
		<SelectPrimitive.Content
			ref={ref}
			className={`relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-strong)] bg-[var(--bg)] text-[var(--ink-1)] shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 ${className}`}
			position={position}
			{...props}
		>
			<SelectPrimitive.Viewport
				className={`p-1 ${position === 'popper' ? 'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]' : ''}`}
			>
				{children}
			</SelectPrimitive.Viewport>
		</SelectPrimitive.Content>
	</SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

export const SelectLabel = forwardRef<
	ElementRef<typeof SelectPrimitive.Label>,
	ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className = '', ...props }, ref) => (
	<SelectPrimitive.Label
		ref={ref}
		className={`px-2 py-1.5 font-mono text-[11px] font-semibold text-[var(--ink-3)] ${className}`}
		{...props}
	/>
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

export const SelectItem = forwardRef<
	ElementRef<typeof SelectPrimitive.Item>,
	ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className = '', children, ...props }, ref) => (
	<SelectPrimitive.Item
		ref={ref}
		className={`relative flex w-full cursor-default select-none items-center rounded-[4px] py-1.5 pl-2 pr-8 font-mono text-[12.5px] outline-none hover:bg-[var(--panel-2)] focus:bg-[var(--panel-2)] focus:text-[var(--ink-1)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${className}`}
		{...props}
	>
		<span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
			<SelectPrimitive.ItemIndicator>
				<svg
					className="h-4 w-4 text-[var(--needs)]"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					aria-hidden="true"
				>
					<path
						d="M3.5 8.5l3 3 6-6"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</SelectPrimitive.ItemIndicator>
		</span>
		<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
	</SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export const SelectSeparator = forwardRef<
	ElementRef<typeof SelectPrimitive.Separator>,
	ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className = '', ...props }, ref) => (
	<SelectPrimitive.Separator
		ref={ref}
		className={`-mx-1 my-1 h-px bg-[var(--border)] ${className}`}
		{...props}
	/>
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;
