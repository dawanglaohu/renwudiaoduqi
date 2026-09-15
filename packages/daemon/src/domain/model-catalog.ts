import type { AgentModelItem, BuiltinModelDto } from '@agent-scheduler/shared/api/agents';

export interface LiveModelSourceItem {
	readonly name: string;
	readonly provider?: string;
	readonly effortOptions?: readonly string[];
	readonly isDefault?: boolean;
	readonly note?: string;
}

export interface MergeModelSourcesInput {
	readonly live?: {
		readonly ok: boolean;
		readonly models: readonly LiveModelSourceItem[];
	} | null;
	readonly currentConfigModel?: string | null;
	readonly builtinModels?: readonly BuiltinModelDto[];
	readonly historyModels?: readonly string[];
}

/**
 * Merges models from four tiers: live -> config -> builtin -> history (Criterion 1, E-338, E-350).
 * - Exact name comparison; earlier source wins on duplicate name.
 * - Daemon never outputs 'manual' source.
 * - If currentConfigModel is not present in live, it is included as source: 'config',
 *   marked isCurrentConfig: true, isDefault: true, and note: '当前配置 · 清单未列' (if live was ok).
 * - If currentConfigModel is already present in live, it remains source: 'live' and isCurrentConfig: true.
 * - Deduplication is done on daemon; frontend does not need to deduplicate.
 */
export function mergeModelSources(input: MergeModelSourcesInput): readonly AgentModelItem[] {
	const result: AgentModelItem[] = [];
	const seen = new Set<string>();

	const currentConfigModel = input.currentConfigModel ?? null;
	const liveOk = input.live?.ok === true;

	// 1. Live tier
	if (input.live && Array.isArray(input.live.models)) {
		for (const m of input.live.models) {
			if (!m.name || seen.has(m.name)) continue;
			seen.add(m.name);
			const isCurrentConfig = currentConfigModel !== null && m.name === currentConfigModel;
			result.push(
				Object.freeze({
					name: m.name,
					source: 'live',
					...(m.provider !== undefined ? { provider: m.provider } : {}),
					...(m.effortOptions !== undefined ? { effortOptions: m.effortOptions } : {}),
					isCurrentConfig,
					...(m.isDefault !== undefined ? { isDefault: m.isDefault } : {}),
					...(m.note !== undefined ? { note: m.note } : {}),
				}),
			);
		}
	}

	// 2. Config tier (if currentConfigModel was not already in live)
	if (currentConfigModel !== null && !seen.has(currentConfigModel)) {
		seen.add(currentConfigModel);
		// Check if builtin has a note for this model (e.g. claude opus[1m])
		const builtinMatch = input.builtinModels?.find((b) => b.name === currentConfigModel);
		const note = liveOk ? '当前配置 · 清单未列' : (builtinMatch?.note ?? undefined);

		result.push(
			Object.freeze({
				name: currentConfigModel,
				source: 'config',
				isCurrentConfig: true,
				isDefault: true,
				...(note !== undefined ? { note } : {}),
			}),
		);
	}

	// 3. Builtin tier
	if (Array.isArray(input.builtinModels)) {
		for (const b of input.builtinModels) {
			if (!b.name || seen.has(b.name)) continue;
			seen.add(b.name);
			result.push(
				Object.freeze({
					name: b.name,
					source: 'builtin',
					isCurrentConfig: false,
					...(b.note !== undefined ? { note: b.note } : {}),
				}),
			);
		}
	}

	// 4. History tier
	if (Array.isArray(input.historyModels)) {
		for (const h of input.historyModels) {
			if (!h || seen.has(h)) continue;
			seen.add(h);
			result.push(
				Object.freeze({
					name: h,
					source: 'history',
					isCurrentConfig: false,
				}),
			);
		}
	}

	return Object.freeze(result);
}
