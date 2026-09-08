import { AppError } from '../errors/app-error.ts';
import { BUILT_IN_AGENT_IDS } from './permission-tier.ts';

/**
 * Three-tier reasoning effort abstraction used across the product (决策 52).
 * Stored in database/registry as pure abstract values:
 * - `low`: Low reasoning effort / budget.
 * - `medium`: Medium reasoning effort / budget.
 * - `high`: High reasoning effort / budget.
 * - `null`: Unsupported or follow agent configuration (E-254).
 */
export const EFFORT_TIERS = {
	LOW: 'low',
	MEDIUM: 'medium',
	HIGH: 'high',
} as const;

export type EffortTier = (typeof EFFORT_TIERS)[keyof typeof EFFORT_TIERS];

const EFFORT_TIER_SET = new Set<string>(Object.values(EFFORT_TIERS));

/**
 * Type guard for product-level EffortTier.
 * Explicitly rejects vendor-specific names like `model_reasoning_effort` or arbitrary numbers.
 */
export function isEffortTier(value: unknown): value is EffortTier {
	return typeof value === 'string' && EFFORT_TIER_SET.has(value);
}

/**
 * Assertion function ensuring value is a valid EffortTier.
 * Throws AppError('E_VALIDATION') instead of bare TypeError (R4).
 */
export function assertEffortTier(value: unknown): asserts value is EffortTier {
	if (!isEffortTier(value)) {
		throw new AppError(
			'E_VALIDATION',
			`Invalid effort tier: expected one of 'low', 'medium', 'high', got ${String(value)}`,
		);
	}
}

export interface EffortContextOptions {
	readonly model?: string | null;
	readonly agentVersion?: string | null;
}

export interface SupportedEffortMapping {
	readonly supported: true;
	readonly agentId: string;
	readonly tier: EffortTier;
	readonly vendorParam: string;
	readonly vendorValue: string;
	readonly args: readonly string[];
	readonly budgetTokens?: number;
}

export interface UnsupportedEffortMapping {
	readonly supported: false;
	readonly agentId: string;
	readonly tier: EffortTier;
	readonly reason: string;
}

export type ResolvedEffortMapping = SupportedEffortMapping | UnsupportedEffortMapping;

interface VendorEffortRule {
	readonly vendorParam: string;
	readonly values: Readonly<
		Record<
			EffortTier,
			{
				readonly value: string;
				readonly args: readonly string[];
				readonly budgetTokens?: number;
			}
		>
	>;
}

const CODEX_EFFORT_RULES: VendorEffortRule = Object.freeze({
	vendorParam: 'model_reasoning_effort',
	values: Object.freeze({
		[EFFORT_TIERS.LOW]: Object.freeze({
			value: 'low',
			args: Object.freeze(['-c', 'model_reasoning_effort="low"']),
		}),
		[EFFORT_TIERS.MEDIUM]: Object.freeze({
			value: 'medium',
			args: Object.freeze(['-c', 'model_reasoning_effort="medium"']),
		}),
		[EFFORT_TIERS.HIGH]: Object.freeze({
			value: 'high',
			args: Object.freeze(['-c', 'model_reasoning_effort="high"']),
		}),
	}),
});

/**
 * Claude thinking budget mapping (AC 4: "claude 思考预算", 决策 52).
 * Uses --settings with maxThinkingTokens to configure reasoning budget tokens on thinking-capable models.
 */
const CLAUDE_EFFORT_RULES: VendorEffortRule = Object.freeze({
	vendorParam: 'thinking_budget',
	values: Object.freeze({
		[EFFORT_TIERS.LOW]: Object.freeze({
			value: '2048',
			args: Object.freeze(['--settings', '{"maxThinkingTokens":2048}']),
			budgetTokens: 2048,
		}),
		[EFFORT_TIERS.MEDIUM]: Object.freeze({
			value: '8192',
			args: Object.freeze(['--settings', '{"maxThinkingTokens":8192}']),
			budgetTokens: 8192,
		}),
		[EFFORT_TIERS.HIGH]: Object.freeze({
			value: '32768',
			args: Object.freeze(['--settings', '{"maxThinkingTokens":32768}']),
			budgetTokens: 32768,
		}),
	}),
});

const GROK_EFFORT_RULES: VendorEffortRule = Object.freeze({
	vendorParam: '--reasoning-effort',
	values: Object.freeze({
		[EFFORT_TIERS.LOW]: Object.freeze({
			value: 'low',
			args: Object.freeze(['--reasoning-effort', 'low']),
		}),
		[EFFORT_TIERS.MEDIUM]: Object.freeze({
			value: 'medium',
			args: Object.freeze(['--reasoning-effort', 'medium']),
		}),
		[EFFORT_TIERS.HIGH]: Object.freeze({
			value: 'high',
			args: Object.freeze(['--reasoning-effort', 'high']),
		}),
	}),
});

const PI_EFFORT_RULES: VendorEffortRule = Object.freeze({
	vendorParam: '--thinking',
	values: Object.freeze({
		[EFFORT_TIERS.LOW]: Object.freeze({
			value: 'low',
			args: Object.freeze(['--thinking', 'low']),
		}),
		[EFFORT_TIERS.MEDIUM]: Object.freeze({
			value: 'medium',
			args: Object.freeze(['--thinking', 'medium']),
		}),
		[EFFORT_TIERS.HIGH]: Object.freeze({
			value: 'high',
			args: Object.freeze(['--thinking', 'high']),
		}),
	}),
});

const KNOWN_EFFORT_RULES: Readonly<Record<string, VendorEffortRule>> = Object.freeze({
	[BUILT_IN_AGENT_IDS.CODEX]: CODEX_EFFORT_RULES,
	[BUILT_IN_AGENT_IDS.CLAUDE]: CLAUDE_EFFORT_RULES,
	[BUILT_IN_AGENT_IDS.GROK]: GROK_EFFORT_RULES,
	[BUILT_IN_AGENT_IDS.PI]: PI_EFFORT_RULES,
});

/**
 * Checks whether a model is incapable of reasoning effort / thinking budget.
 * Non-reasoning models (e.g. haiku, gpt-4o) do not support thinking/reasoning effort parameters (R3).
 */
function isModelIncapableOfEffort(agentId: string, model: string): boolean {
	const lower = model.toLowerCase();
	if (agentId === BUILT_IN_AGENT_IDS.CLAUDE) {
		// Claude haiku models do not support extended thinking
		if (lower.includes('haiku')) {
			return true;
		}
	} else if (agentId === BUILT_IN_AGENT_IDS.CODEX) {
		// Standard non-reasoning GPT-4o / GPT-3.5 models do not support reasoning effort
		if (
			lower.includes('gpt-4o') ||
			lower.includes('gpt-4-') ||
			lower === 'gpt-4' ||
			lower.includes('gpt-3.5')
		) {
			return true;
		}
	}
	return false;
}

/**
 * Checks whether the given agent supports reasoning effort configuration.
 * Uses Object.hasOwn to prevent prototype property lookup crashes (R3).
 * DeepSeek Harness (dsh) and generic-acp return false (E-254).
 */
export function isEffortSupported(agentId: string, options: EffortContextOptions = {}): boolean {
	if (typeof agentId !== 'string') {
		return false;
	}
	const normalized = agentId.trim().toLowerCase();
	if (!Object.hasOwn(KNOWN_EFFORT_RULES, normalized)) {
		return false;
	}
	if (options.model && isModelIncapableOfEffort(normalized, options.model)) {
		return false;
	}
	return true;
}

/**
 * Resolves the vendor parameter mapping for an agent and product effort tier (决策 52).
 * Context-aware: perceives agent version and model capability (R3).
 * When an agent or model does not support reasoning effort, returns unsupported status
 * rather than a fake default tier (AC 5, E-254).
 */
export function resolveEffortMapping(
	agentId: string,
	tier: EffortTier,
	options: EffortContextOptions = {},
): ResolvedEffortMapping {
	assertEffortTier(tier);
	const normalized = typeof agentId === 'string' ? agentId.trim().toLowerCase() : '';
	const rule = Object.hasOwn(KNOWN_EFFORT_RULES, normalized)
		? KNOWN_EFFORT_RULES[normalized]
		: undefined;

	if (!rule) {
		const isDsh =
			normalized === 'dsh' || normalized === 'deepseek' || normalized === 'deepseek-harness';
		const isGenericAcp = normalized === 'generic-acp';
		const reason = isDsh
			? 'DeepSeek Harness does not support reasoning effort configuration.'
			: isGenericAcp
				? 'Generic ACP does not standardize reasoning effort configuration.'
				: `Agent '${agentId}' does not support reasoning effort configuration.`;
		return Object.freeze({
			supported: false,
			agentId,
			tier,
			reason,
		});
	}

	if (options.model && isModelIncapableOfEffort(normalized, options.model)) {
		return Object.freeze({
			supported: false,
			agentId,
			tier,
			reason: `Model '${options.model}' under agent '${agentId}' does not support reasoning effort or thinking budget.`,
		});
	}

	const mapping = rule.values[tier];
	return Object.freeze({
		supported: true,
		agentId,
		tier,
		vendorParam: rule.vendorParam,
		vendorValue: mapping.value,
		args: mapping.args,
		budgetTokens: mapping.budgetTokens,
	});
}

/**
 * Retrieves the CLI arguments to be passed for reasoning effort.
 * If tier is null or undefined, returns empty array (E-254: NULL tier passes no args).
 * If tier is specified but unsupported, throws AppError('E_CAPABILITY_UNSUPPORTED')
 * to ensure unsupported settings never silently proceed to launch (R2).
 */
export function getEffortArgs(
	agentId: string,
	tier: EffortTier | null | undefined,
	options: EffortContextOptions = {},
): readonly string[] {
	if (!tier) {
		return Object.freeze([]);
	}
	const result = resolveEffortMapping(agentId, tier, options);
	if (!result.supported) {
		throw new AppError(
			'E_CAPABILITY_UNSUPPORTED',
			`Agent '${agentId}' does not support effort tier '${tier}': ${result.reason}`,
			{ details: { agentId, tier, reason: result.reason } },
		);
	}
	return result.args;
}

/**
 * Normalizes self-reported vendor effort strings to product EffortTier when recognized (R3).
 * Performs reverse-mapping for token counts (e.g. Claude budget tokens) and level aliases.
 * Returns normalized EffortTier, or null if empty / unrecognized.
 */
export function normalizeReportedEffort(
	rawReported: string | null | undefined,
	_options: EffortContextOptions = {},
): EffortTier | null {
	if (rawReported === null || rawReported === undefined) {
		return null;
	}
	const trimmed = rawReported.trim();
	if (trimmed.length === 0) {
		return null;
	}

	const lower = trimmed.toLowerCase();
	if (lower === 'low' || lower === 'minimal') {
		return EFFORT_TIERS.LOW;
	}
	if (lower === 'medium') {
		return EFFORT_TIERS.MEDIUM;
	}
	if (lower === 'high' || lower === 'xhigh' || lower === 'max') {
		return EFFORT_TIERS.HIGH;
	}

	// Numerical token budget normalization (e.g. Claude thinking budget tokens)
	const numericBudget = Number(trimmed);
	if (!Number.isNaN(numericBudget) && numericBudget > 0) {
		if (numericBudget <= 2048) {
			return EFFORT_TIERS.LOW;
		}
		if (numericBudget <= 8192) {
			return EFFORT_TIERS.MEDIUM;
		}
		return EFFORT_TIERS.HIGH;
	}

	return null;
}

export interface EffortComparisonResult {
	readonly isMismatch: boolean;
	readonly selectedTier: EffortTier | null;
	readonly reportedRaw: string | null;
	readonly reportedNormalized: EffortTier | null;
}

/**
 * Compares the user-selected effort tier with the agent self-reported value (E-256).
 * Exactly preserves the original reported string and selected tier without silent coercion.
 * Accurately detects mismatch when reported value diverges from selected tier (R3).
 */
export function compareSelectedAndReportedEffort(
	selectedTier: EffortTier | null | undefined,
	reportedRaw: string | null | undefined,
	options: EffortContextOptions = {},
): EffortComparisonResult {
	const selected = selectedTier ?? null;
	const reported = reportedRaw ? reportedRaw.trim() : null;
	const normalized = normalizeReportedEffort(reported, options);

	if (!selected || !reported) {
		return Object.freeze({
			isMismatch: false,
			selectedTier: selected,
			reportedRaw: reported,
			reportedNormalized: normalized,
		});
	}

	// Mismatch occurs if reported value cannot be normalized to match the selected tier
	const isMismatch = normalized !== selected;
	return Object.freeze({
		isMismatch,
		selectedTier: selected,
		reportedRaw: reported,
		reportedNormalized: normalized,
	});
}
