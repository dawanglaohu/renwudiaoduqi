import { BUILT_IN_AGENT_IDS } from '../config/defaults.ts';

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
 */
export function assertPermissionTier(value: unknown): asserts value is PermissionTier {
	if (!isPermissionTier(value)) {
		throw new TypeError(
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
	readonly styleClass: '--default' | '--down';
}

/**
 * Returns UI and security metadata for the given permission tier.
 * Highest tier requires persistent marker in agent cards and dispatch dialogs (E-136).
 */
export function getPermissionTierSecurityMeta(tier: PermissionTier): PermissionTierSecurityMeta {
	const elevated = isHighestPermissionTier(tier);
	return Object.freeze({
		tier,
		isElevated: elevated,
		requiresPersistentMarker: elevated,
		styleClass: elevated ? '--down' : '--default',
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

const PI_RULES: VendorPermissionRule = Object.freeze({
	flag: '--tools',
	values: Object.freeze({
		[PERMISSION_TIERS.READ_ONLY]: Object.freeze({
			value: 'read,grep,find,ls',
			args: Object.freeze(['--tools', 'read,grep,find,ls']),
		}),
		[PERMISSION_TIERS.WORKSPACE_WRITE]: Object.freeze({
			value: 'read,grep,find,ls,edit,write,bash,powershell',
			args: Object.freeze(['--tools', 'read,grep,find,ls,edit,write,bash,powershell']),
		}),
		[PERMISSION_TIERS.UNRESTRICTED]: Object.freeze({
			value: 'read,grep,find,ls,edit,write,bash,powershell',
			args: Object.freeze(['--tools', 'read,grep,find,ls,edit,write,bash,powershell']),
		}),
	}),
});

const GENERIC_ACP_RULES: VendorPermissionRule = Object.freeze({
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

const KNOWN_VENDOR_RULES: Readonly<Record<string, VendorPermissionRule>> = Object.freeze({
	[BUILT_IN_AGENT_IDS.CODEX]: CODEX_RULES,
	[BUILT_IN_AGENT_IDS.CLAUDE]: CLAUDE_RULES,
	[BUILT_IN_AGENT_IDS.GROK]: GROK_RULES,
	[BUILT_IN_AGENT_IDS.PI]: PI_RULES,
	'generic-acp': GENERIC_ACP_RULES,
});

/**
 * Checks whether the given agent supports permission tier argument mapping.
 */
export function isPermissionSupported(agentId: string): boolean {
	const normalized = agentId.trim().toLowerCase();
	return normalized in KNOWN_VENDOR_RULES;
}

/**
 * Resolves the vendor parameter mapping for an agent and product permission tier (E-137).
 * If unsupported (e.g. DeepSeek Harness), returns unsupported status rather than defaulting.
 */
export function resolvePermissionMapping(
	agentId: string,
	tier: PermissionTier,
): ResolvedPermissionMapping {
	assertPermissionTier(tier);
	const normalized = agentId.trim().toLowerCase();
	const rule = KNOWN_VENDOR_RULES[normalized];

	if (!rule) {
		const isDsh =
			normalized === 'dsh' || normalized === 'deepseek' || normalized === 'deepseek-harness';
		const reason = isDsh
			? 'DeepSeek Harness does not support permission sandbox/mode arguments.'
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
 * Returns empty array if unsupported.
 */
export function getPermissionArgs(agentId: string, tier: PermissionTier): readonly string[] {
	const result = resolvePermissionMapping(agentId, tier);
	return result.supported ? result.args : Object.freeze([]);
}
