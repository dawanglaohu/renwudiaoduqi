import type { EffortVendorMap, ListAgentModelsResponse } from '@agent-scheduler/shared/api/agents';

/** CLI-level fallback choices; a model's advertised effortOptions take precedence in the picker. */
const NATIVE_EFFORT_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	// https://learn.chatgpt.com/docs/config-file/config-reference#model_reasoning_effort
	codex: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
	// https://code.claude.com/docs/en/model-config#adjust-effort-level
	claude: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
	// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md#models
	pi: Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
	// https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/slash/commands/effort.rs
	grok: Object.freeze(['low', 'medium', 'high', 'xhigh']),
});

interface EffortAgentConfig {
	readonly adapterKind?: string;
	readonly effortVendorMap?: EffortVendorMap;
}

export function nativeEffortOptions(agentId: string, config: EffortAgentConfig): readonly string[] {
	if (config.effortVendorMap === null || config.adapterKind === 'generic-acp') return [];
	return Object.hasOwn(NATIVE_EFFORT_OPTIONS, agentId)
		? (NATIVE_EFFORT_OPTIONS[agentId] ?? [])
		: [];
}

export function vendorEffortDomain(
	agentId: string,
	config: EffortAgentConfig,
	catalog?: {
		readonly models: readonly Pick<ListAgentModelsResponse['models'][number], 'effortOptions'>[];
		readonly currentConfig: Pick<ListAgentModelsResponse['currentConfig'], 'effort'>;
	},
): readonly string[] {
	if (config.effortVendorMap === null) return [];
	const values = new Set([
		...Object.values(config.effortVendorMap ?? {}),
		...nativeEffortOptions(agentId, config),
	]);
	const current = catalog?.currentConfig.effort;
	if (current && 'vendor' in current) values.add(current.vendor);
	for (const model of catalog?.models ?? []) {
		for (const option of model.effortOptions ?? []) values.add(option);
	}
	return Array.from(values);
}
