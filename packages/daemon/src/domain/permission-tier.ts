/** Product-level permission choices stored in the agent registry. */
export const PERMISSION_TIERS = {
	READ_ONLY: 'readOnly',
	WORKSPACE_WRITE: 'workspaceWrite',
	UNRESTRICTED: 'unrestricted',
} as const;

export type PermissionTier = (typeof PERMISSION_TIERS)[keyof typeof PERMISSION_TIERS];

export const DEFAULT_PERMISSION_TIER: PermissionTier = PERMISSION_TIERS.WORKSPACE_WRITE;
export const REVIEW_PERMISSION_TIER: PermissionTier = PERMISSION_TIERS.READ_ONLY;
export const HIGHEST_PERMISSION_TIER: PermissionTier = PERMISSION_TIERS.UNRESTRICTED;

const PERMISSION_TIER_SET = new Set<string>(Object.values(PERMISSION_TIERS));

export function isPermissionTier(value: unknown): value is PermissionTier {
	return typeof value === 'string' && PERMISSION_TIER_SET.has(value);
}

export function isHighestPermissionTier(tier: PermissionTier): boolean {
	return tier === HIGHEST_PERMISSION_TIER;
}

export function hasElevatedPermission(tier: PermissionTier): boolean {
	return isHighestPermissionTier(tier);
}

export interface PermissionTierSecurityMeta {
	readonly tier: PermissionTier;
	readonly isElevated: boolean;
	readonly requiresPersistentMarker: boolean;
}

/** The highest tier must remain visibly marked wherever the stored tier is shown. */
export function getPermissionTierSecurityMeta(tier: PermissionTier): PermissionTierSecurityMeta {
	const isElevated = isHighestPermissionTier(tier);
	return Object.freeze({
		tier,
		isElevated,
		requiresPersistentMarker: isElevated,
	});
}

/** Automation mode is independent of the stored per-agent permission choice. */
export function preservePermissionTierOnModeChange(
	currentTier: PermissionTier,
	_isAutoMode: boolean,
): PermissionTier {
	return currentTier;
}

/** Review dispatch always selects the read-only product tier before vendor mapping. */
export function enforceRunPermissionTier(
	runKind: 'implement' | 'review',
	requestedTier?: PermissionTier | null,
): PermissionTier {
	return runKind === 'review' ? REVIEW_PERMISSION_TIER : (requestedTier ?? DEFAULT_PERMISSION_TIER);
}

export interface ArgumentPermissionTransport {
	readonly kind: 'argv';
	readonly flag: string;
	readonly value: string;
	readonly args: readonly string[];
}

export interface EnvironmentPermissionTransport {
	readonly kind: 'env';
	readonly variables: Readonly<Record<string, string>>;
}

export type PermissionTransport = ArgumentPermissionTransport | EnvironmentPermissionTransport;

export interface SupportedPermissionMapping {
	readonly supported: true;
	readonly agentId: string;
	readonly tier: PermissionTier;
	readonly transport: PermissionTransport;
}

export interface UnsupportedPermissionMapping {
	readonly supported: false;
	readonly agentId: string;
	readonly tier: PermissionTier;
	readonly reason: string;
}

export type ResolvedPermissionMapping = SupportedPermissionMapping | UnsupportedPermissionMapping;

type VendorPermissionRule = Readonly<Record<PermissionTier, PermissionTransport | null>>;

function argv(
	flag: string,
	value: string,
	...extraArgs: readonly string[]
): ArgumentPermissionTransport {
	return Object.freeze({
		kind: 'argv',
		flag,
		value,
		args: Object.freeze([flag, value, ...extraArgs]),
	});
}

function env(name: string, value: string): EnvironmentPermissionTransport {
	return Object.freeze({ kind: 'env', variables: Object.freeze({ [name]: value }) });
}

const CODEX_RULES: VendorPermissionRule = Object.freeze({
	[PERMISSION_TIERS.READ_ONLY]: argv('--sandbox', 'read-only'),
	[PERMISSION_TIERS.WORKSPACE_WRITE]: argv('--sandbox', 'workspace-write'),
	[PERMISSION_TIERS.UNRESTRICTED]: argv('--sandbox', 'danger-full-access'),
});

const CLAUDE_RULES: VendorPermissionRule = Object.freeze({
	[PERMISSION_TIERS.READ_ONLY]: argv('--permission-mode', 'plan'),
	[PERMISSION_TIERS.WORKSPACE_WRITE]: argv('--permission-mode', 'acceptEdits'),
	[PERMISSION_TIERS.UNRESTRICTED]: argv('--permission-mode', 'bypassPermissions'),
});

const GROK_RULES: VendorPermissionRule = Object.freeze({
	[PERMISSION_TIERS.READ_ONLY]: argv('--permission-mode', 'plan'),
	[PERMISSION_TIERS.WORKSPACE_WRITE]: argv('--permission-mode', 'acceptEdits'),
	[PERMISSION_TIERS.UNRESTRICTED]: argv('--permission-mode', 'bypassPermissions'),
});

const PI_RULES: VendorPermissionRule = Object.freeze({
	[PERMISSION_TIERS.READ_ONLY]: argv('--tools', 'read,grep,find,ls'),
	// Pi's edit and write tools accept absolute paths, so its built-in tool list cannot enforce a
	// workspace boundary. The middle tier stays unsupported until an external sandbox owns it.
	[PERMISSION_TIERS.WORKSPACE_WRITE]: null,
	[PERMISSION_TIERS.UNRESTRICTED]: argv('--tools', 'read,grep,find,ls,edit,write,bash,powershell'),
});

const DSH_RULES: VendorPermissionRule = Object.freeze({
	[PERMISSION_TIERS.READ_ONLY]: env('DSH_PERMISSION_MODE', 'read-only'),
	[PERMISSION_TIERS.WORKSPACE_WRITE]: env('DSH_PERMISSION_MODE', 'workspace-write'),
	[PERMISSION_TIERS.UNRESTRICTED]: env('DSH_PERMISSION_MODE', 'danger-full-access'),
});

const KNOWN_VENDOR_RULES: Readonly<Record<string, VendorPermissionRule>> = Object.freeze({
	codex: CODEX_RULES,
	claude: CLAUDE_RULES,
	grok: GROK_RULES,
	pi: PI_RULES,
	dsh: DSH_RULES,
	deepseek: DSH_RULES,
	'deepseek-harness': DSH_RULES,
});

export function isPermissionSupported(agentId: string, tier?: PermissionTier): boolean {
	const normalized = agentId.trim().toLowerCase();
	const rule = Object.hasOwn(KNOWN_VENDOR_RULES, normalized)
		? KNOWN_VENDOR_RULES[normalized]
		: undefined;
	return rule !== undefined && (tier === undefined || rule[tier] !== null);
}

/**
 * Resolve one product tier without erasing transport or failure information. Generic ACP is
 * unsupported here because ACP does not define a portable CLI permission flag.
 */
export function resolvePermissionMapping(
	agentId: string,
	tier: PermissionTier,
): ResolvedPermissionMapping {
	const normalized = agentId.trim().toLowerCase();
	const rule = Object.hasOwn(KNOWN_VENDOR_RULES, normalized)
		? KNOWN_VENDOR_RULES[normalized]
		: undefined;
	const transport = rule?.[tier];

	if (transport === undefined) {
		const reason =
			normalized === 'generic-acp'
				? 'Generic ACP does not define a portable CLI permission mapping.'
				: `Agent '${agentId}' has no permission mapping.`;
		return Object.freeze({ supported: false, agentId, tier, reason });
	}
	if (transport === null) {
		return Object.freeze({
			supported: false,
			agentId,
			tier,
			reason: `Agent '${agentId}' cannot enforce permission tier '${tier}'.`,
		});
	}
	return Object.freeze({ supported: true, agentId, tier, transport });
}
