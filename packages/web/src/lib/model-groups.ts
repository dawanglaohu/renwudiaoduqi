/**
 * packages/web/src/lib/model-groups.ts
 *
 * 模型按来源切组与子组切分纯函数（M9-T23 / AC 2, E-338, E-339, E-350 / 决策 134）
 *
 * 规范依据：
 * - 按 shared MODEL_SOURCES 顺序出五组：['live', 'config', 'builtin', 'history', 'manual']
 * - 空组不渲染，但 manual 组恒有一项「手填模型名…」
 * - 不去重、不排序、不改名（严禁使用 new Set(、dedupe、uniq）
 * - 带 provider 的条目按首次出现顺序切子组
 * - source 不在 MODEL_SOURCES 的条目归末尾「其他」组按原串标注，返回 unknownSources 由容器 warn
 */

import {
	type AgentModelItem,
	MODEL_SOURCES,
	type ModelSource,
} from '@agent-scheduler/shared/api/agents';

export const MANUAL_MODEL_ACTION_KEY = '__manual_custom_model__' as const;

export interface ModelPickerItem {
	readonly name: string;
	readonly source: string;
	readonly provider?: string;
	readonly effortOptions?: readonly string[];
	readonly isCurrentConfig: boolean;
	readonly isDefault?: boolean;
	readonly note?: string;
	readonly isManualAction?: boolean;
}

export interface ModelSubgroup {
	readonly provider?: string;
	readonly items: readonly ModelPickerItem[];
}

export interface ModelGroup {
	readonly source: string;
	readonly label: string;
	readonly subgroups: readonly ModelSubgroup[];
}

export interface GroupedModelsResult {
	readonly groups: readonly ModelGroup[];
	readonly unknownSources: readonly string[];
	readonly defaultSelectedModel: string | null;
}

export const SOURCE_LABELS: Readonly<Record<ModelSource | 'other', string>> = {
	live: '实时清单',
	config: '配置文件',
	builtin: '内置推荐',
	history: '近期使用',
	manual: '手动指定',
	other: '其他',
};

/**
 * 将模型列表按来源顺序切分为展示组，带 provider 按首次出现切子组。
 */
export function groupModelsBySource(
	models: readonly AgentModelItem[] = [],
	currentModelName?: string | null,
): GroupedModelsResult {
	const sourceBucket: Record<string, ModelPickerItem[]> = {};
	for (const src of MODEL_SOURCES) {
		sourceBucket[src] = [];
	}
	const otherItems: ModelPickerItem[] = [];
	const unknownSources: string[] = [];

	let defaultSelectedModel: string | null = null;

	for (let i = 0; i < models.length; i++) {
		const item = models[i];
		if (!item) continue;

		const pickerItem: ModelPickerItem = {
			name: item.name,
			source: item.source,
			provider: item.provider,
			effortOptions: item.effortOptions,
			isCurrentConfig: Boolean(item.isCurrentConfig),
			isDefault: item.isDefault,
			note: item.note,
		};

		if (pickerItem.isCurrentConfig && defaultSelectedModel === null) {
			defaultSelectedModel = pickerItem.name;
		}

		if (sourceBucket[item.source]) {
			sourceBucket[item.source].push(pickerItem);
		} else {
			otherItems.push(pickerItem);
			if (!unknownSources.includes(item.source)) {
				unknownSources.push(item.source);
			}
		}
	}

	// 如果没有当前配置项，但传入了 currentModelName，匹配它
	if (defaultSelectedModel === null && currentModelName) {
		defaultSelectedModel = currentModelName;
	}

	const groups: ModelGroup[] = [];

	// 1. 按 shared MODEL_SOURCES 顺序装配五组
	for (let sIdx = 0; sIdx < MODEL_SOURCES.length; sIdx++) {
		const src = MODEL_SOURCES[sIdx];
		if (!src) continue;

		if (src === 'manual') {
			// manual 组恒一项「手填模型名…」
			const manualItem: ModelPickerItem = {
				name: '手填模型名…',
				source: 'manual',
				isCurrentConfig: false,
				isManualAction: true,
			};
			groups.push({
				source: 'manual',
				label: SOURCE_LABELS.manual,
				subgroups: [
					{
						items: [manualItem],
					},
				],
			});
			continue;
		}

		const bucketItems = sourceBucket[src] ?? [];
		if (bucketItems.length === 0) {
			// 空组不渲染
			continue;
		}

		// 切子组：带 provider 的条目按首次出现顺序切子组
		const subgroups: { provider?: string; items: ModelPickerItem[] }[] = [];
		for (let bIdx = 0; bIdx < bucketItems.length; bIdx++) {
			const it = bucketItems[bIdx];
			if (!it) continue;

			let existingSg: { provider?: string; items: ModelPickerItem[] } | undefined;
			for (let sgIdx = 0; sgIdx < subgroups.length; sgIdx++) {
				if (subgroups[sgIdx]?.provider === it.provider) {
					existingSg = subgroups[sgIdx];
					break;
				}
			}

			if (existingSg) {
				existingSg.items.push(it);
			} else {
				subgroups.push({
					provider: it.provider,
					items: [it],
				});
			}
		}

		groups.push({
			source: src,
			label: SOURCE_LABELS[src] ?? src,
			subgroups,
		});
	}

	// 2. 未知来源归末尾「其他」组
	if (otherItems.length > 0) {
		const subgroups: { provider?: string; items: ModelPickerItem[] }[] = [];
		for (let oIdx = 0; oIdx < otherItems.length; oIdx++) {
			const it = otherItems[oIdx];
			if (!it) continue;

			let existingSg: { provider?: string; items: ModelPickerItem[] } | undefined;
			for (let sgIdx = 0; sgIdx < subgroups.length; sgIdx++) {
				if (subgroups[sgIdx]?.provider === it.provider) {
					existingSg = subgroups[sgIdx];
					break;
				}
			}

			if (existingSg) {
				existingSg.items.push(it);
			} else {
				subgroups.push({
					provider: it.provider,
					items: [it],
				});
			}
		}

		groups.push({
			source: 'other',
			label: SOURCE_LABELS.other,
			subgroups,
		});
	}

	return {
		groups,
		unknownSources,
		defaultSelectedModel,
	};
}
