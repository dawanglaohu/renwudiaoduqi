import type { EffortVendorMap, ListAgentModelsResponse } from '@agent-scheduler/shared/api/agents';

/** CLI-level fallback choices; a model's advertised effortOptions take precedence in the picker. */
const NATIVE_EFFORT_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	// https://learn.chatgpt.com/docs/config-file/config-reference#model_reasoning_effort
	codex: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
	// https://code.claude.com/docs/en/model-config#adjust-effort-level
	claude: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
	// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md#models
	pi: Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
	// https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md#headless-mode
	grok: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
});

interface EffortAgentConfig {
	readonly adapterKind?: string;
	readonly effortVendorMap?: EffortVendorMap;
}

/** Only advertise named levels explicitly listed by the detected Claude executable. */
export function parseClaudeEffortOptions(help: string): readonly string[] {
	const section = help.match(
		/(?:^|\n)[ \t]*--effort(?:[ =]|\s)[\s\S]*?(?=\n[ \t]*--[a-z]|\nCommands:|$)/,
	)?.[0];
	if (!section) return [];
	return (NATIVE_EFFORT_OPTIONS.claude ?? []).filter((level) =>
		new RegExp(`\\b${level}\\b`).test(section),
	);
}

export function nativeEffortOptions(
	agentId: string,
	config: EffortAgentConfig,
	probedOptions?: readonly string[],
): readonly string[] {
	if (config.effortVendorMap === null || config.adapterKind === 'generic-acp') return [];
	if (agentId === 'claude') {
		return probedOptions ?? [];
	}
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
	probedOptions?: readonly string[],
): readonly string[] {
	if (config.effortVendorMap === null) return [];
	const values = new Set([
		...Object.values(config.effortVendorMap ?? {}),
		...nativeEffortOptions(agentId, config, probedOptions),
	]);
	const current = catalog?.currentConfig.effort;
	if (current && 'vendor' in current) values.add(current.vendor);
	for (const model of catalog?.models ?? []) {
		for (const option of model.effortOptions ?? []) values.add(option);
	}
	return Array.from(values);
}
