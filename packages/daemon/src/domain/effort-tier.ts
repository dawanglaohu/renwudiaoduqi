import { BUILT_IN_AGENT_IDS } from '../config/defaults.ts';

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
 */
export function assertEffortTier(value: unknown): asserts value is EffortTier {
	if (!isEffortTier(value)) {
		throw new TypeError(
			`Invalid effort tier: expected one of 'low', 'medium', 'high', got ${String(value)}`,
		);
	}
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

const CLAUDE_EFFORT_RULES: VendorEffortRule = Object.freeze({
	vendorParam: '--effort',
	values: Object.freeze({
		[EFFORT_TIERS.LOW]: Object.freeze({
			value: 'low',
			args: Object.freeze(['--effort', 'low']),
			budgetTokens: 2048,
		}),
		[EFFORT_TIERS.MEDIUM]: Object.freeze({
			value: 'medium',
			args: Object.freeze(['--effort', 'medium']),
			budgetTokens: 8192,
		}),
		[EFFORT_TIERS.HIGH]: Object.freeze({
			value: 'high',
			args: Object.freeze(['--effort', 'high']),
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
 * Checks whether the given agent supports reasoning effort configuration.
 * DeepSeek Harness (dsh) and generic-acp return false (E-254).
 */
export function isEffortSupported(agentId: string): boolean {
	const normalized = agentId.trim().toLowerCase();
	return normalized in KNOWN_EFFORT_RULES;
}

/**
 * Resolves the vendor parameter mapping for an agent and product effort tier (决策 52).
 * When an agent does not support reasoning effort, returns unsupported status rather
 * than a fake default tier (AC 5, E-254).
 */
export function resolveEffortMapping(agentId: string, tier: EffortTier): ResolvedEffortMapping {
	assertEffortTier(tier);
	const normalized = agentId.trim().toLowerCase();
	const rule = KNOWN_EFFORT_RULES[normalized];

	if (!rule) {
		const isDsh =
			normalized === 'dsh' || normalized === 'deepseek' || normalized === 'deepseek-harness';
		const reason = isDsh
			? 'DeepSeek Harness does not support reasoning effort configuration.'
			: `Agent '${agentId}' does not support reasoning effort configuration.`;
		return Object.freeze({
			supported: false,
			agentId,
			tier,
			reason,
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
 * If the agent does not support reasoning effort or the tier is null/undefined,
 * returns an empty array to avoid passing any arguments (E-254).
 */
export function getEffortArgs(
	agentId: string,
	tier: EffortTier | null | undefined,
): readonly string[] {
	if (!tier) {
		return Object.freeze([]);
	}
	const result = resolveEffortMapping(agentId, tier);
	return result.supported ? result.args : Object.freeze([]);
}

/**
 * Normalizes self-reported vendor effort strings to product EffortTier when recognized.
 * Preserves unrecognized non-empty strings as-is for logging and receipts (E-256).
 */
export function normalizeReportedEffort(
	rawReported: string | null | undefined,
): EffortTier | string | null {
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

	// Numerical token budget normalization (e.g. Claude thinking tokens)
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

	return trimmed;
}

export interface EffortComparisonResult {
	readonly isMismatch: boolean;
	readonly selectedTier: EffortTier | null;
	readonly reportedRaw: string | null;
	readonly reportedNormalized: EffortTier | string | null;
}

/**
 * Compares the user-selected effort tier with the agent self-reported value (E-256).
 * Neither side is silently discarded or overwritten.
 */
export function compareSelectedAndReportedEffort(
	selectedTier: EffortTier | null | undefined,
	reportedRaw: string | null | undefined,
): EffortComparisonResult {
	const selected = selectedTier ?? null;
	const reported = reportedRaw ? reportedRaw.trim() : null;
	const normalized = normalizeReportedEffort(reported);

	if (!selected || !reported) {
		return Object.freeze({
			isMismatch: false,
			selectedTier: selected,
			reportedRaw: reported,
			reportedNormalized: normalized,
		});
	}

	const isMismatch = normalized !== selected;
	return Object.freeze({
		isMismatch,
		selectedTier: selected,
		reportedRaw: reported,
		reportedNormalized: normalized,
	});
}
