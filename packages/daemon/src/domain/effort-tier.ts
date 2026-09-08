/** Product-level reasoning-effort choices stored independently of vendor parameters. */
export const EFFORT_TIERS = {
	LOW: 'low',
	MEDIUM: 'medium',
	HIGH: 'high',
} as const;

export type EffortTier = (typeof EFFORT_TIERS)[keyof typeof EFFORT_TIERS];

const EFFORT_TIER_SET = new Set<string>(Object.values(EFFORT_TIERS));

export function isEffortTier(value: unknown): value is EffortTier {
	return typeof value === 'string' && EFFORT_TIER_SET.has(value);
}

export interface EffortCapabilityContext {
	readonly model?: string | null;
	readonly agentVersion?: string | null;
	/** False means the adapter or model probe established that this run cannot accept effort. */
	readonly isSupported?: boolean;
	readonly unsupportedReason?: string;
}

export interface ArgumentEffortTransport {
	readonly kind: 'argv';
	readonly parameter: string;
	readonly value: string;
	readonly args: readonly string[];
}

export interface EnvironmentEffortTransport {
	readonly kind: 'env';
	readonly variables: Readonly<Record<string, string>>;
}

export type EffortTransport = ArgumentEffortTransport | EnvironmentEffortTransport;

export interface SupportedEffortMapping {
	readonly supported: true;
	readonly agentId: string;
	readonly tier: EffortTier;
	readonly transport: EffortTransport;
}

export interface UnsupportedEffortMapping {
	readonly supported: false;
	readonly agentId: string;
	readonly tier: EffortTier;
	readonly reason: string;
}

export type ResolvedEffortMapping = SupportedEffortMapping | UnsupportedEffortMapping;

type VendorEffortRule = Readonly<Record<EffortTier, EffortTransport>>;

function argv(
	parameter: string,
	value: string,
	...prefix: readonly string[]
): ArgumentEffortTransport {
	return Object.freeze({
		kind: 'argv',
		parameter,
		value,
		args: Object.freeze([...prefix, parameter, value]),
	});
}

function env(name: string, value: string): EnvironmentEffortTransport {
	return Object.freeze({ kind: 'env', variables: Object.freeze({ [name]: value }) });
}

function codexConfig(value: EffortTier): ArgumentEffortTransport {
	return Object.freeze({
		kind: 'argv',
		parameter: 'model_reasoning_effort',
		value,
		args: Object.freeze(['-c', `model_reasoning_effort="${value}"`]),
	});
}

const CODEX_EFFORT_RULES: VendorEffortRule = Object.freeze({
	[EFFORT_TIERS.LOW]: codexConfig(EFFORT_TIERS.LOW),
	[EFFORT_TIERS.MEDIUM]: codexConfig(EFFORT_TIERS.MEDIUM),
	[EFFORT_TIERS.HIGH]: codexConfig(EFFORT_TIERS.HIGH),
});

// Claude Code 1.0.67 reads this process variable when constructing maxThinkingTokens. Keeping
// the transport explicit lets proc/env apply it without treating a JSON object as a file path.
const CLAUDE_EFFORT_RULES: VendorEffortRule = Object.freeze({
	[EFFORT_TIERS.LOW]: env('MAX_THINKING_TOKENS', '2048'),
	[EFFORT_TIERS.MEDIUM]: env('MAX_THINKING_TOKENS', '8192'),
	[EFFORT_TIERS.HIGH]: env('MAX_THINKING_TOKENS', '32768'),
});

const GROK_EFFORT_RULES: VendorEffortRule = Object.freeze({
	[EFFORT_TIERS.LOW]: argv('--reasoning-effort', 'low'),
	[EFFORT_TIERS.MEDIUM]: argv('--reasoning-effort', 'medium'),
	[EFFORT_TIERS.HIGH]: argv('--reasoning-effort', 'high'),
});

const PI_EFFORT_RULES: VendorEffortRule = Object.freeze({
	[EFFORT_TIERS.LOW]: argv('--thinking', 'low'),
	[EFFORT_TIERS.MEDIUM]: argv('--thinking', 'medium'),
	[EFFORT_TIERS.HIGH]: argv('--thinking', 'high'),
});

const KNOWN_EFFORT_RULES: Readonly<Record<string, VendorEffortRule>> = Object.freeze({
	codex: CODEX_EFFORT_RULES,
	claude: CLAUDE_EFFORT_RULES,
	grok: GROK_EFFORT_RULES,
	pi: PI_EFFORT_RULES,
});

export function isEffortSupported(agentId: string, context: EffortCapabilityContext = {}): boolean {
	return (
		context.isSupported !== false && Object.hasOwn(KNOWN_EFFORT_RULES, agentId.trim().toLowerCase())
	);
}

/** Resolve a selected tier while preserving an adapter or model probe's unsupported result. */
export function resolveEffortMapping(
	agentId: string,
	tier: EffortTier,
	context: EffortCapabilityContext = {},
): ResolvedEffortMapping {
	const normalized = agentId.trim().toLowerCase();
	const rule = Object.hasOwn(KNOWN_EFFORT_RULES, normalized)
		? KNOWN_EFFORT_RULES[normalized]
		: undefined;
	if (context.isSupported === false || rule === undefined) {
		const subject = [context.model, context.agentVersion].filter(Boolean).join(' / ');
		const reason =
			context.unsupportedReason ??
			(rule === undefined
				? `Agent '${agentId}' has no reasoning-effort mapping.`
				: `${subject || `Agent '${agentId}'`} does not support reasoning effort.`);
		return Object.freeze({ supported: false, agentId, tier, reason });
	}
	return Object.freeze({ supported: true, agentId, tier, transport: rule[tier] });
}

/** A null stored tier means no effort transport is emitted for this run. */
export function resolveOptionalEffortMapping(
	agentId: string,
	tier: EffortTier | null | undefined,
	context: EffortCapabilityContext = {},
): ResolvedEffortMapping | null {
	return tier == null ? null : resolveEffortMapping(agentId, tier, context);
}

export interface ReportedEffortContext {
	readonly agentId: string;
}

/** Reverse-map only values documented for the reporting agent; unknown values remain unknown. */
export function normalizeReportedEffort(
	rawReported: string | null | undefined,
	context: ReportedEffortContext,
): EffortTier | null {
	if (rawReported == null) return null;
	const normalized = rawReported.trim().toLowerCase();
	if (normalized === '') return null;
	if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
		return normalized;
	}

	const agentId = context.agentId.trim().toLowerCase();
	if ((agentId === 'codex' || agentId === 'pi') && normalized === 'minimal') {
		return EFFORT_TIERS.LOW;
	}
	if (
		(agentId === 'codex' || agentId === 'pi') &&
		(normalized === 'xhigh' || normalized === 'max')
	) {
		return EFFORT_TIERS.HIGH;
	}
	if (agentId === 'claude') {
		if (normalized === '2048') return EFFORT_TIERS.LOW;
		if (normalized === '8192') return EFFORT_TIERS.MEDIUM;
		if (normalized === '32768') return EFFORT_TIERS.HIGH;
	}
	return null;
}

export interface EffortComparisonResult {
	readonly isMismatch: boolean;
	readonly selectedTier: EffortTier | null;
	readonly reportedRaw: string | null;
	readonly reportedNormalized: EffortTier | null;
}

/** Preserve both facts; normalization is auxiliary and never overwrites the reported value. */
export function compareSelectedAndReportedEffort(
	selectedTier: EffortTier | null | undefined,
	reportedRaw: string | null | undefined,
	context: ReportedEffortContext,
): EffortComparisonResult {
	const selected = selectedTier ?? null;
	const raw = reportedRaw ?? null;
	const hasReportedValue = raw !== null && raw.trim() !== '';
	const reportedNormalized = normalizeReportedEffort(raw, context);
	return Object.freeze({
		isMismatch: selected !== null && hasReportedValue && reportedNormalized !== selected,
		selectedTier: selected,
		reportedRaw: raw,
		reportedNormalized,
	});
}
