/**
 * packages/web/src/components/effort-picker.tsx
 *
 * 思考强度选择器展示组件（M9-T23 / AC 3, E-254, E-351）
 *
 * 规范依据：
 * - 纯展示层组件：纯 props in / callback out
 * - Agent 或模型明确不支持时只读显示「—」+ title 说明，不渲染选择器、不禁用整行（E-254）
 * - 否则渲染「标准档位」组 +「厂商原值」组（allowVendor=false 时不渲染厂商组）
 * - 没有手填框
 * - 配置当前值加「当前配置」chip，effortRecognized === false 再加「无法识别」chip
 * - effortSupportWarning 返回非空时下方显示「该模型不支持 〈值〉」（aria-live="polite"），不禁用不换值
 * - value 与 onChange 的 '' / 'tier:x' / 'vendor:y' 编解码在组件内往返
 */

import type { EffortValue, EffortVendorMap } from '@agent-scheduler/shared/api/agents';
import { useMemo } from 'react';
import { UI_STRINGS } from '../i18n/ui-strings.ts';
import {
	buildEffortOptionGroups,
	decodeEffortValue,
	effortSupportWarning,
	encodeEffortValue,
} from '../lib/effort-options.ts';
import {
	GroupedSelect,
	type GroupedSelectGroup,
	type GroupedSelectOption,
} from '../ui/grouped-select.tsx';

export interface EffortPickerProps {
	readonly vendorMap?: EffortVendorMap | null;
	readonly value: EffortValue;
	readonly onChange: (value: EffortValue) => void;
	readonly currentConfigEffort?: EffortValue;
	readonly selectedModelEffortOptions?: readonly string[];
	readonly agentEffortOptions?: readonly string[];
	readonly allowVendor?: boolean;
	readonly effortRecognized?: boolean;
	readonly disabled?: boolean;
	readonly className?: string;
	readonly id?: string;
}

export function EffortPicker({
	vendorMap,
	value,
	onChange,
	currentConfigEffort = null,
	selectedModelEffortOptions,
	agentEffortOptions,
	allowVendor = true,
	effortRecognized = true,
	disabled = false,
	className = '',
	id,
}: EffortPickerProps) {
	const rawGroups = useMemo(() => {
		return buildEffortOptionGroups({
			vendorMap,
			currentConfigEffort,
			selectedModelEffortOptions,
			agentEffortOptions,
			selectedEffort: value,
			allowVendor,
			effortRecognized,
			copy: UI_STRINGS.effortPicker,
		});
	}, [
		vendorMap,
		currentConfigEffort,
		selectedModelEffortOptions,
		agentEffortOptions,
		value,
		allowVendor,
		effortRecognized,
	]);

	const selectGroups = useMemo<readonly GroupedSelectGroup[]>(() => {
		return rawGroups.map((group) => {
			const items: GroupedSelectOption[] = group.items.map((it) => {
				let chip: string | undefined;
				if (it.isCurrentConfig) {
					chip = UI_STRINGS.effortPicker.currentConfigChip;
				}
				if (it.isUnrecognized) {
					chip = chip
						? `${chip} · ${UI_STRINGS.effortPicker.unrecognizedChip}`
						: UI_STRINGS.effortPicker.unrecognizedChip;
				}

				return {
					value: it.encodedValue,
					label: it.label,
					chip,
				};
			});

			return {
				id: group.id,
				label: group.label,
				subgroups: [
					{
						items,
					},
				],
			};
		});
	}, [rawGroups]);

	const encodedCurrentValue = encodeEffortValue(value);

	const handleValueChange = (newEncoded: string) => {
		const decoded = decodeEffortValue(newEncoded);
		onChange(decoded);
	};

	const warningText = effortSupportWarning(
		{
			effort: value,
			effortOptions: selectedModelEffortOptions ?? agentEffortOptions,
			vendorMap,
		},
		UI_STRINGS.effortPicker.unsupportedWarning,
	);

	// E-254: Agent 或所选模型不支持思考强度时，只读显示「—」。
	const modelUnsupported = selectedModelEffortOptions?.length === 0;
	if (vendorMap === null || vendorMap === undefined || modelUnsupported) {
		return (
			<div className={`flex flex-col gap-0.5 w-full ${className}`}>
				<div
					data-testid="effort-unsupported-display"
					title={
						modelUnsupported
							? UI_STRINGS.effortPicker.unsupportedModelTitle
							: UI_STRINGS.effortPicker.unsupportedAgentTitle
					}
					className="flex h-[var(--h-input)] items-center px-2.5 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--panel-2)] text-[var(--ink-3)] font-mono text-[13px] select-none"
				>
					{UI_STRINGS.effortPicker.unsupportedFallback}
				</div>
			</div>
		);
	}

	return (
		<div data-testid="effort-picker" className={`flex flex-col gap-0.5 w-full ${className}`}>
			<GroupedSelect
				labels={UI_STRINGS.groupedSelect}
				id={id}
				value={encodedCurrentValue}
				onValueChange={handleValueChange}
				groups={selectGroups}
				placeholder={UI_STRINGS.effortPicker.selectPlaceholder}
				disabled={disabled}
			/>

			{/* 模型不支持该思考强度档位时就地警示（aria-live="polite"，不禁用不换值，E-351） */}
			{warningText && (
				<output
					data-testid="effort-support-warning"
					aria-live="polite"
					className="text-micro font-ui text-[var(--needs)] px-1 mt-0.5 select-none block"
				>
					{warningText}
				</output>
			)}
		</div>
	);
}
