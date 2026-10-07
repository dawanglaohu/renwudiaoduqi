/**
 * packages/web/src/lib/effort-options.ts
 *
 * 思考强度档位、厂商原值组装与支持度告警纯函数（M9-T23 / AC 3, E-254, E-351）
 *
 * 规范依据：
 * - 纯函数：同输入同输出，不 import React，不 import src 下除 lib 外任何目录
 * - 编码往返：''（跟随默认）/ 'tier:x' / 'vendor:y'
 * - vendorMap === null 时不支持思考强度，外层显示只读「—」
 * - 三档组 + 厂商原值组（allowVendor=false 不渲染厂商组）
 * - 配置当前值加「当前配置」chip，effortRecognized === false 再加「无法识别」chip
 * - 没有手填框
 */

import type { EffortTier, EffortValue, EffortVendorMap } from '@agent-scheduler/shared/api/agents';

export interface EffortOptionItem {
	readonly encodedValue: string;
	readonly label: string;
	readonly rawValue: EffortValue;
	readonly isCurrentConfig: boolean;
	readonly isUnrecognized: boolean;
}

export interface EffortOptionGroup {
	readonly id: 'tier' | 'vendor';
	readonly label: string;
	readonly items: readonly EffortOptionItem[];
}

export interface BuildEffortOptionsParams {
	readonly copy: {
		follow: string;
		low: string;
		medium: string;
		high: string;
		groups: { tiers: string; vendor: string };
	};
	readonly vendorMap?: EffortVendorMap | null;
	readonly currentConfigEffort?: EffortValue;
	readonly selectedModelEffortOptions?: readonly string[];
	readonly agentEffortOptions?: readonly string[];
	readonly selectedEffort?: EffortValue;
	readonly allowVendor?: boolean;
	readonly effortRecognized?: boolean;
}

/**
 * 将 EffortValue 编码为字符串（'' | 'tier:low' | 'vendor:max' 等）。
 */
export function encodeEffortValue(value: EffortValue): string {
	if (!value) {
		return '';
	}
	if ('tier' in value) {
		return `tier:${value.tier}`;
	}
	if ('vendor' in value) {
		return `vendor:${value.vendor}`;
	}
	return '';
}

/**
 * 将编码字符串解码为 EffortValue。
 */
export function decodeEffortValue(encoded: string): EffortValue {
	if (!encoded) {
		return null;
	}
	if (encoded.startsWith('tier:')) {
		const tier = encoded.slice(5) as EffortTier;
		return { tier };
	}
	if (encoded.startsWith('vendor:')) {
		const vendor = encoded.slice(7);
		return { vendor };
	}
	return null;
}

/**
 * 组装思考强度下拉选项组。
 */
export function buildEffortOptionGroups({
	vendorMap,
	currentConfigEffort = null,
	selectedModelEffortOptions,
	agentEffortOptions = [],
	selectedEffort = null,
	allowVendor = true,
	effortRecognized = true,
	copy,
}: BuildEffortOptionsParams): readonly EffortOptionGroup[] {
	if (vendorMap === null || vendorMap === undefined) {
		return [];
	}

	const groups: EffortOptionGroup[] = [];
	const availableOptions = selectedModelEffortOptions ?? agentEffortOptions;

	// 1. 三档组（跟随／低／中／高）
	const isCurrentNull = currentConfigEffort === null;
	const currentTier =
		currentConfigEffort && 'tier' in currentConfigEffort ? currentConfigEffort.tier : null;

	const tierItems: EffortOptionItem[] = [
		{
			encodedValue: '',
			label: copy.follow,
			rawValue: null,
			isCurrentConfig: isCurrentNull,
			isUnrecognized: false,
		},
		{
			encodedValue: 'tier:low',
			label: copy.low,
			rawValue: { tier: 'low' },
			isCurrentConfig: currentTier === 'low',
			isUnrecognized: false,
		},
		{
			encodedValue: 'tier:medium',
			label: copy.medium,
			rawValue: { tier: 'medium' },
			isCurrentConfig: currentTier === 'medium',
			isUnrecognized: false,
		},
		{
			encodedValue: 'tier:high',
			label: copy.high,
			rawValue: { tier: 'high' },
			isCurrentConfig: currentTier === 'high',
			isUnrecognized: false,
		},
	];

	groups.push({
		id: 'tier',
		label: copy.groups.tiers,
		items: tierItems,
	});

	// 2. 厂商原值组（配置当前值的 {vendor} + 所选模型 effortOptions 里不等于三档映射值的项）
	if (allowVendor) {
		const vendorItems: EffortOptionItem[] = [];
		const standardVendorValues: readonly string[] = [
			vendorMap.low,
			vendorMap.medium,
			vendorMap.high,
		];

		const addedVendors: string[] = [];

		// 配置当前值为厂商原值
		if (currentConfigEffort && 'vendor' in currentConfigEffort) {
			const currentVendor = currentConfigEffort.vendor;
			addedVendors.push(currentVendor);
			vendorItems.push({
				encodedValue: `vendor:${currentVendor}`,
				label: currentVendor,
				rawValue: { vendor: currentVendor },
				isCurrentConfig: true,
				isUnrecognized: !effortRecognized,
			});
		}

		// 所选模型的 effortOptions 中不等于三档映射值且尚未添加的项
		const nativeOptions = [...availableOptions];
		if (selectedEffort && 'vendor' in selectedEffort) nativeOptions.push(selectedEffort.vendor);
		for (let i = 0; i < nativeOptions.length; i++) {
			const opt = nativeOptions[i];
			if (!opt) continue;
			const isSelectedVendor =
				selectedEffort && 'vendor' in selectedEffort && selectedEffort.vendor === opt;
			if (
				(!standardVendorValues.includes(opt) || isSelectedVendor) &&
				!addedVendors.includes(opt)
			) {
				addedVendors.push(opt);
				vendorItems.push({
					encodedValue: `vendor:${opt}`,
					label: opt,
					rawValue: { vendor: opt },
					isCurrentConfig: false,
					isUnrecognized: false,
				});
			}
		}

		if (vendorItems.length > 0) {
			groups.push({
				id: 'vendor',
				label: copy.groups.vendor,
				items: vendorItems,
			});
		}
	}

	return groups;
}

export interface EffortSupportWarningParams {
	readonly effort: EffortValue;
	readonly effortOptions?: readonly string[];
	readonly vendorMap?: EffortVendorMap | null;
}

/**
 * 校验所选模型的 effortOptions 是否支持当前选中的思考强度值（E-351）。
 * 返回非空时在选择器下方显示「该模型不支持 〈值〉」，不禁用不换值。
 */
export function effortSupportWarning(
	{ effort, effortOptions, vendorMap }: EffortSupportWarningParams,
	format: (value: string) => string,
): string | null {
	if (!effort || !effortOptions) {
		return null;
	}

	if ('tier' in effort) {
		// Legacy CLIs can still map the common tiers to token budgets without named levels.
		if (!vendorMap || effortOptions.length === 0) return null;
		const mappedVendor = vendorMap[effort.tier];
		if (mappedVendor && !effortOptions.includes(mappedVendor)) {
			return format(effort.tier);
		}
		return null;
	}

	if ('vendor' in effort) {
		if (
			effortOptions.length === 0 &&
			vendorMap &&
			Object.values(vendorMap).includes(effort.vendor)
		) {
			return null;
		}
		if (!effortOptions.includes(effort.vendor)) {
			return format(effort.vendor);
		}
		return null;
	}

	return null;
}
