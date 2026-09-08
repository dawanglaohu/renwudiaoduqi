import { AppError } from '../errors/app-error.ts';

/**
 * Known built-in agent identifiers.
 * Defined here in domain to avoid backward dependency on config layer (R4).
 */
export const BUILT_IN_AGENT_IDS = {
	CODEX: 'codex',
	CLAUDE: 'claude',
	PI: 'pi',
	GROK: 'grok',
} as const;

export type BuiltInAgentId = (typeof BUILT_IN_AGENT_IDS)[keyof typeof BUILT_IN_AGENT_IDS];

/**
 * Three-tier permission abstraction used across the product.
 * Stored in database/registry as pure abstract values:
 * - `readOnly`: Read-only / plan mode, code modification disallowed (E-135).
 * - `workspaceWrite`: Modifications allowed only within the designated task workspace (default).
 * - `unrestricted`: Full unrestricted access outside the workspace sandbox (E-136).
 */
export const PERMISSION_TIERS = {
	READ_ONLY: 'readOnly',
	WORKSPACE_WRITE: 'workspaceWrite',
	UNRESTRICTED: 'unrestricted',
} as const;

export type PermissionTier = (typeof PERMISSION_TIERS)[keyof typeof PERMISSION_TIERS];

/**
 * Default permission tier across the product (middle tier: workspaceWrite).
 */
export const DEFAULT_PERMISSION_TIER: PermissionTier = PERMISSION_TIERS.WORKSPACE_WRITE;

/**
 * Mandatory permission tier for review agents (readOnly, E-135).
 */
export const REVIEW_PERMISSION_TIER: PermissionTier = PERMISSION_TIERS.READ_ONLY;

/**
 * Highest permission tier that triggers persistent warnings (unrestricted, E-136).
 */
export const HIGHEST_PERMISSION_TIER: PermissionTier = PERMISSION_TIERS.UNRESTRICTED;

const PERMISSION_TIER_SET = new Set<string>(Object.values(PERMISSION_TIERS));

/**
 * Type guard for product-level PermissionTier.
 * Explicitly rejects raw vendor arguments like `--sandbox` or `acceptEdits` (E-137).
 */
export function isPermissionTier(value: unknown): value is PermissionTier {
	return typeof value === 'string' && PERMISSION_TIER_SET.has(value);
}

/**
 * Assertion function ensuring value is a valid PermissionTier.
 * Throws AppError('E_VALIDATION') instead of bare TypeError (R4).
 */
export function assertPermissionTier(value: unknown): asserts value is PermissionTier {
	if (!isPermissionTier(value)) {
		throw new AppError(
			'E_VALIDATION',
			`Invalid permission tier: expected one of 'readOnly', 'workspaceWrite', 'unrestricted', got ${String(value)}`,
		);
	}
}

/**
 * Checks whether the given tier is the highest (unrestricted) tier (E-136).
 */
export function isHighestPermissionTier(tier: PermissionTier): boolean {
	return tier === HIGHEST_PERMISSION_TIER;
}

/**
 * Semantic alias for elevated permission detection (E-136).
 */
export function hasElevatedPermission(tier: PermissionTier): boolean {
	return isHighestPermissionTier(tier);
}

export interface PermissionTierSecurityMeta {
	readonly tier: PermissionTier;
	readonly isElevated: boolean;
	readonly requiresPersistentMarker: boolean;
	readonly alertSeverity: 'none' | 'warning';
}

/**
 * Returns security metadata for the given permission tier.
 * Does not emit UI CSS tokens in daemon domain (R4).
 * Highest tier requires persistent marker in agent cards and dispatch confirmation (E-136).
 */
export function getPermissionTierSecurityMeta(tier: PermissionTier): PermissionTierSecurityMeta {
	const elevated = isHighestPermissionTier(tier);
	return Object.freeze({
		tier,
		isElevated: elevated,
		requiresPersistentMarker: elevated,
		alertSeverity: elevated ? 'warning' : 'none',
	});
}

/**
 * Ensures permission tier is NOT implicitly changed when switching to auto mode (E-136).
 */
export function preservePermissionTierOnModeChange(
	currentTier: PermissionTier,
	_isAutoMode: boolean,
): PermissionTier {
	return currentTier;
}

/**
 * Enforces permission tier based on execution kind (E-135).
 * Review agents are strictly constrained to readOnly tier regardless of requested override.
 */
export function enforceRunPermissionTier(
	runKind: 'implement' | 'review',
	requestedTier?: PermissionTier | null,
): PermissionTier {
	if (runKind === 'review') {
		return REVIEW_PERMISSION_TIER;
	}
	return requestedTier ?? DEFAULT_PERMISSION_TIER;
}

export interface SupportedPermissionMapping {
	readonly supported: true;
	readonly agentId: string;
	readonly tier: PermissionTier;
	readonly flag: string;
	readonly vendorValue: string;
	readonly args: readonly string[];
}

export interface UnsupportedPermissionMapping {
	readonly supported: false;
	readonly agentId: string;
	readonly tier: PermissionTier;
	readonly reason: string;
}

export type ResolvedPermissionMapping = SupportedPermissionMapping | UnsupportedPermissionMapping;

interface VendorPermissionRule {
	readonly flag: string;
	readonly values: Readonly<
		Record<PermissionTier, { readonly value: string; readonly args: readonly string[] }>
	>;
}

const CODEX_RULES: VendorPermissionRule = Object.freeze({
	flag: '--sandbox',
	values: Object.freeze({
		[PERMISSION_TIERS.READ_ONLY]: Object.freeze({
			value: 'read-only',
			args: Object.freeze(['--sandbox', 'read-only']),
		}),
		[PERMISSION_TIERS.WORKSPACE_WRITE]: Object.freeze({
			value: 'workspace-write',
			args: Object.freeze(['--sandbox', 'workspace-write']),
		}),
		[PERMISSION_TIERS.UNRESTRICTED]: Object.freeze({
			value: 'danger-full-access',
			args: Object.freeze(['--sandbox', 'danger-full-access']),
		}),
	}),
});

const CLAUDE_RULES: VendorPermissionRule = Object.freeze({
	flag: '--permission-mode',
	values: Object.freeze({
		[PERMISSION_TIERS.READ_ONLY]: Object.freeze({
			value: 'plan',
			args: Object.freeze(['--permission-mode', 'plan']),
		}),
		[PERMISSION_TIERS.WORKSPACE_WRITE]: Object.freeze({
			value: 'acceptEdits',
			args: Object.freeze(['--permission-mode', 'acceptEdits']),
		}),
		[PERMISSION_TIERS.UNRESTRICTED]: Object.freeze({
			value: 'bypassPermissions',
			args: Object.freeze(['--permission-mode', 'bypassPermissions']),
		}),
	}),
});

const GROK_RULES: VendorPermissionRule = Object.freeze({
	flag: '--permission-mode',
	values: Object.freeze({
		[PERMISSION_TIERS.READ_ONLY]: Object.freeze({
			value: 'plan',
			args: Object.freeze(['--permission-mode', 'plan']),
		}),
		[PERMISSION_TIERS.WORKSPACE_WRITE]: Object.freeze({
			value: 'acceptEdits',
			args: Object.freeze(['--permission-mode', 'acceptEdits']),
		}),
		[PERMISSION_TIERS.UNRESTRICTED]: Object.freeze({
			value: 'bypassPermissions',
			args: Object.freeze(['--permission-mode', 'bypassPermissions']),
		}),
	}),
});

/**
 * Pi tools permission mapping.
 * In readOnly: strictly inspection tools (no file write/edit, no shell).
 * In workspaceWrite: file edit/write tools only; bash/powershell are excluded to prevent out-of-bounds writes (R2).
 * In unrestricted: full tools including bash and powershell, with --approve (R2).
 */
const PI_RULES: VendorPermissionRule = Object.freeze({
	flag: '--tools',
	values: Object.freeze({
		[PERMISSION_TIERS.READ_ONLY]: Object.freeze({
			value: 'read,grep,find,ls',
			args: Object.freeze(['--tools', 'read,grep,find,ls']),
		}),
		[PERMISSION_TIERS.WORKSPACE_WRITE]: Object.freeze({
			value: 'read,grep,find,ls,edit,write',
			args: Object.freeze(['--tools', 'read,grep,find,ls,edit,write']),
		}),
		[PERMISSION_TIERS.UNRESTRICTED]: Object.freeze({
			value: 'read,grep,find,ls,edit,write,bash,powershell',
			args: Object.freeze(['--tools', 'read,grep,find,ls,edit,write,bash,powershell', '--approve']),
		}),
	}),
});

const KNOWN_VENDOR_RULES: Readonly<Record<string, VendorPermissionRule>> = Object.freeze({
	[BUILT_IN_AGENT_IDS.CODEX]: CODEX_RULES,
	[BUILT_IN_AGENT_IDS.CLAUDE]: CLAUDE_RULES,
	[BUILT_IN_AGENT_IDS.GROK]: GROK_RULES,
	[BUILT_IN_AGENT_IDS.PI]: PI_RULES,
});

/**
 * Checks whether the given agent supports permission tier argument mapping.
 * Uses Object.hasOwn to prevent prototype property pollution crashes (R3).
 */
export function isPermissionSupported(agentId: string): boolean {
	if (typeof agentId !== 'string') {
		return false;
	}
	const normalized = agentId.trim().toLowerCase();
	return Object.hasOwn(KNOWN_VENDOR_RULES, normalized);
}

/**
 * Resolves the vendor parameter mapping for an agent and product permission tier (E-137).
 * - DSH has no sandbox/read-only mode, so it returns supported: false (R2).
 * - Generic ACP negotiates permissions in-protocol and has no CLI permission flags, returning supported: false (R2).
 * - Unknown agents or prototype property names return supported: false (R3).
 */
export function resolvePermissionMapping(
	agentId: string,
	tier: PermissionTier,
): ResolvedPermissionMapping {
	assertPermissionTier(tier);
	const normalized = typeof agentId === 'string' ? agentId.trim().toLowerCase() : '';
	const rule = Object.hasOwn(KNOWN_VENDOR_RULES, normalized)
		? KNOWN_VENDOR_RULES[normalized]
		: undefined;

	if (!rule) {
		const isDsh =
			normalized === 'dsh' || normalized === 'deepseek' || normalized === 'deepseek-harness';
		const isGenericAcp = normalized === 'generic-acp';
		const reason = isDsh
			? 'DeepSeek Harness does not support permission sandbox/mode arguments.'
			: isGenericAcp
				? 'Generic ACP does not use CLI flags for permissions; permissions are negotiated in-protocol.'
				: `Agent '${agentId}' does not support permission tier parameter mapping.`;
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
		flag: rule.flag,
		vendorValue: mapping.value,
		args: mapping.args,
	});
}

/**
 * Retrieves the CLI arguments to be appended for the given agent and tier.
 * Throws AppError('E_CAPABILITY_UNSUPPORTED') if unsupported (R2).
 * Unsupported permissions must never silently degrade to empty args or continue unconstrained (R2).
 */
export function getPermissionArgs(agentId: string, tier: PermissionTier): readonly string[] {
	const result = resolvePermissionMapping(agentId, tier);
	if (!result.supported) {
		throw new AppError(
			'E_CAPABILITY_UNSUPPORTED',
			`Agent '${agentId}' does not support permission tier '${tier}': ${result.reason}`,
			{ details: { agentId, tier, reason: result.reason } },
		);
	}
	return result.args;
}
