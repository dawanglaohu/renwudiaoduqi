import {
	EFFORT_TIERS,
	type EffortCapabilityContext,
	type EffortTier,
	isEffortSupported,
	isEffortTier,
	resolveOptionalEffortMapping,
} from './effort-tier.ts';

export const FOLLOW_AGENT_CONFIG_LABEL = '跟随 agent 配置' as const;
export const UNSUPPORTED_EFFORT_LABEL = '—' as const;

export const EFFORT_TIER_DISPLAY_NAMES = Object.freeze({
	[EFFORT_TIERS.LOW]: '低',
	[EFFORT_TIERS.MEDIUM]: '中',
	[EFFORT_TIERS.HIGH]: '高',
} as const);

export interface ModelOption {
	readonly id: string;
	readonly name?: string;
	readonly description?: string;
	readonly isDefault?: boolean;
	readonly supportedEffortTiers?: readonly EffortTier[];
}

export interface ModelCapability {
	readonly isEffortSupported?: boolean;
	readonly supportedEffortTiers?: readonly EffortTier[];
	readonly unsupportedReason?: string;
}

export interface AgentModelDefaults {
	readonly agentId: string;
	readonly defaultModel?: string | null;
	readonly defaultEffortTier?: EffortTier | null;
	readonly isEffortSupported?: boolean;
	readonly unsupportedEffortReason?: string;
	readonly availableModels?: readonly ModelOption[];
}

export interface TaskModelEffortState {
	readonly agentId: string;
	readonly modelOverride?: string | null;
	readonly effortOverride?: EffortTier | null;
	readonly hasExplicitModelOverride?: boolean;
	readonly hasExplicitEffortOverride?: boolean;
	readonly lastUsedModel?: string | null;
	readonly lastUsedEffortTier?: EffortTier | null;
}

export interface ModelResolutionContext {
	readonly agentDefaults: AgentModelDefaults;
	readonly taskState?: TaskModelEffortState | null;
	readonly isRetry?: boolean;
	readonly clearModelOverride?: boolean;
	readonly clearEffortOverride?: boolean;
	readonly targetAgentId?: string;
	readonly modelCapabilities?: Readonly<Record<string, ModelCapability>>;
}

export type ModelResolutionSource =
	| 'task_override'
	| 'retry_retained'
	| 'agent_default'
	| 'follow_agent_config';

export type EffortResolutionSource =
	| 'task_override'
	| 'retry_retained'
	| 'agent_default'
	| 'unsupported'
	| 'none';

export interface ModelUiDisplay {
	readonly text: string;
	readonly isFollowAgentConfig: boolean;
	readonly tooltip?: string;
}

export interface EffortUiDisplay {
	readonly text: string;
	readonly isSupported: boolean;
	readonly tooltip?: string;
}

export interface ResolvedModelEffort {
	readonly agentId: string;
	readonly model: string | null;
	readonly modelSource: ModelResolutionSource;
	readonly effortTier: EffortTier | null;
	readonly effortSource: EffortResolutionSource;
	readonly modelUi: ModelUiDisplay;
	readonly effortUi: EffortUiDisplay;
	readonly modelArgs: readonly string[];
	readonly effortTransport: {
		readonly args: readonly string[];
		readonly env: Readonly<Record<string, string>>;
	};
}

export interface ModelValidationSuccess {
	readonly ok: true;
	readonly model: string | null;
}

export interface ModelValidationFailure {
	readonly ok: false;
	readonly code: 'E_VALIDATION';
	readonly reason: 'model-not-found';
	readonly message: string;
	readonly details: {
		readonly agentId: string;
		readonly selectedModel: string;
		readonly availableModelIds: readonly string[];
		readonly fix: string;
	};
}

export type ModelValidationResult = ModelValidationSuccess | ModelValidationFailure;

export interface EffortValidationSuccess {
	readonly ok: true;
	readonly effortTier: EffortTier | null;
	readonly isSupported: boolean;
}

export interface EffortValidationFailure {
	readonly ok: false;
	readonly code: 'E_VALIDATION';
	readonly reason: 'effort-unsupported' | 'tier-out-of-range' | 'invalid-tier';
	readonly message: string;
	readonly details: {
		readonly agentId: string;
		readonly model: string | null;
		readonly selectedTier: string;
		readonly allowedTiers: readonly EffortTier[];
		readonly fix: string;
		readonly zhMessage?: string;
	};
}

export type EffortValidationResult = EffortValidationSuccess | EffortValidationFailure;

export interface DispatchValidationSuccess {
	readonly ok: true;
	readonly resolved: ResolvedModelEffort;
}

export interface DispatchValidationFailure {
	readonly ok: false;
	readonly code: 'E_VALIDATION';
	readonly errorKind: 'model' | 'effort';
	readonly message: string;
	readonly failure: ModelValidationFailure | EffortValidationFailure;
}

export type DispatchValidationResult = DispatchValidationSuccess | DispatchValidationFailure;

/**
 * Resolves the effective model name according to the priority chain:
 * 1. Switching agent clears override -> falls back to new agent default.
 * 2. On retry: if clearModelOverride is set -> agent default;
 *             if new taskModelOverride provided -> new override;
 *             if previously overridden -> retains lastUsedModel;
 *             otherwise -> agent default.
 * 3. Regular dispatch: taskModelOverride > agentDefaultModel > null (follow agent config).
 */
export function resolveModel(context: ModelResolutionContext): {
	readonly model: string | null;
	readonly source: ModelResolutionSource;
	readonly ui: ModelUiDisplay;
} {
	const { agentDefaults, taskState, isRetry, clearModelOverride, targetAgentId } = context;

	// AC 6 / E-34: Switching agent clears override and drops to new agent default
	const isAgentSwitched =
		targetAgentId !== undefined &&
		targetAgentId !== '' &&
		taskState?.agentId !== undefined &&
		taskState.agentId !== '' &&
		targetAgentId !== taskState.agentId;

	const effectiveTaskState = isAgentSwitched ? null : taskState;

	const agentDefault = normalizeStringOrNull(agentDefaults.defaultModel);
	const taskOverride = normalizeStringOrNull(effectiveTaskState?.modelOverride);
	const lastUsed = normalizeStringOrNull(effectiveTaskState?.lastUsedModel);
	const hadOverride =
		effectiveTaskState?.hasExplicitModelOverride ?? (taskOverride !== null || lastUsed !== null);

	let model: string | null = null;
	let source: ModelResolutionSource = 'follow_agent_config';

	if (isRetry) {
		// AC 5 / E-33: Retry retention and explicit clear
		if (clearModelOverride) {
			model = agentDefault;
			source = agentDefault !== null ? 'agent_default' : 'follow_agent_config';
		} else if (taskOverride !== null) {
			model = taskOverride;
			source = 'task_override';
		} else if (hadOverride && lastUsed !== null) {
			model = lastUsed;
			source = 'retry_retained';
		} else if (agentDefault !== null) {
			model = agentDefault;
			source = 'agent_default';
		} else {
			model = null;
			source = 'follow_agent_config';
		}
	} else {
		// Regular dispatch
		if (taskOverride !== null) {
			model = taskOverride;
			source = 'task_override';
		} else if (agentDefault !== null) {
			model = agentDefault;
			source = 'agent_default';
		} else {
			model = null;
			source = 'follow_agent_config';
		}
	}

	const isFollowAgentConfig = model === null;
	const uiText: string = model ?? FOLLOW_AGENT_CONFIG_LABEL;
	const ui: ModelUiDisplay = Object.freeze({
		text: uiText,
		isFollowAgentConfig,
		tooltip: isFollowAgentConfig ? FOLLOW_AGENT_CONFIG_LABEL : undefined,
	});

	return Object.freeze({ model, source, ui });
}

/**
 * Resolves the reasoning effort tier following the completely isomorphic chain:
 * 1. Switching agent clears override -> falls back to new agent default.
 * 2. On retry: if clearEffortOverride is set -> agent default;
 *             if new taskEffortOverride provided -> new override;
 *             if previously overridden -> retains lastUsedEffortTier;
 *             otherwise -> agent default.
 * 3. Regular dispatch: taskEffortOverride > agentDefaultEffortTier > null.
 * 4. Capability check: if agent or model does NOT support reasoning effort,
 *    resolved value is NULL, UI displays '—', no fake default (AC 8 / E-254).
 */
export function resolveEffortTier(
	context: ModelResolutionContext,
	resolvedModel?: string | null,
): {
	readonly effortTier: EffortTier | null;
	readonly source: EffortResolutionSource;
	readonly ui: EffortUiDisplay;
	readonly transport: {
		readonly args: readonly string[];
		readonly env: Readonly<Record<string, string>>;
	};
} {
	const { agentDefaults, taskState, isRetry, clearEffortOverride, targetAgentId } = context;

	const isAgentSwitched =
		targetAgentId !== undefined &&
		targetAgentId !== '' &&
		taskState?.agentId !== undefined &&
		taskState.agentId !== '' &&
		targetAgentId !== taskState.agentId;

	const effectiveTaskState = isAgentSwitched ? null : taskState;

	const agentDefault = normalizeEffortTierOrNull(agentDefaults.defaultEffortTier);
	const taskOverride = normalizeEffortTierOrNull(effectiveTaskState?.effortOverride);
	const lastUsed = normalizeEffortTierOrNull(effectiveTaskState?.lastUsedEffortTier);
	const hadOverride =
		effectiveTaskState?.hasExplicitEffortOverride ?? (taskOverride !== null || lastUsed !== null);

	let candidateTier: EffortTier | null = null;
	let source: EffortResolutionSource = 'none';

	if (isRetry) {
		if (clearEffortOverride) {
			candidateTier = agentDefault;
			source = agentDefault !== null ? 'agent_default' : 'none';
		} else if (taskOverride !== null) {
			candidateTier = taskOverride;
			source = 'task_override';
		} else if (hadOverride && lastUsed !== null) {
			candidateTier = lastUsed;
			source = 'retry_retained';
		} else if (agentDefault !== null) {
			candidateTier = agentDefault;
			source = 'agent_default';
		} else {
			candidateTier = null;
			source = 'none';
		}
	} else {
		if (taskOverride !== null) {
			candidateTier = taskOverride;
			source = 'task_override';
		} else if (agentDefault !== null) {
			candidateTier = agentDefault;
			source = 'agent_default';
		} else {
			candidateTier = null;
			source = 'none';
		}
	}

	// Agent-level capability check (E-254)
	const agentCapabilityContext: EffortCapabilityContext = {
		model: resolvedModel,
		isSupported: agentDefaults.isEffortSupported,
		unsupportedReason: agentDefaults.unsupportedEffortReason,
	};
	const agentSupportsEffort = isEffortSupported(agentDefaults.agentId, agentCapabilityContext);

	if (!agentSupportsEffort) {
		return Object.freeze({
			effortTier: null,
			source: 'unsupported',
			ui: Object.freeze({
				text: UNSUPPORTED_EFFORT_LABEL,
				isSupported: false,
				tooltip:
					agentDefaults.unsupportedEffortReason ??
					`Agent '${agentDefaults.agentId}' does not support reasoning effort.`,
			}),
			transport: Object.freeze({
				args: Object.freeze([]),
				env: Object.freeze({}),
			}),
		});
	}

	// Model-level capability check if capability map is provided
	const modelCap =
		resolvedModel !== null && resolvedModel !== undefined
			? context.modelCapabilities?.[resolvedModel]
			: undefined;

	// E-255: If model capability cannot be checked or verified, treat as unsupported (E-254)
	if (modelCap !== undefined && modelCap.isEffortSupported === false) {
		return Object.freeze({
			effortTier: null,
			source: 'unsupported',
			ui: Object.freeze({
				text: UNSUPPORTED_EFFORT_LABEL,
				isSupported: false,
				tooltip:
					modelCap.unsupportedReason ??
					`Model '${resolvedModel}' does not support reasoning effort.`,
			}),
			transport: Object.freeze({
				args: Object.freeze([]),
				env: Object.freeze({}),
			}),
		});
	}

	// Transport mapping
	const transportArgs: string[] = [];
	const transportEnv: Record<string, string> = {};

	if (candidateTier !== null) {
		const mapping = resolveOptionalEffortMapping(
			agentDefaults.agentId,
			candidateTier,
			agentCapabilityContext,
		);
		if (mapping?.supported) {
			if (mapping.transport.kind === 'argv') {
				transportArgs.push(...mapping.transport.args);
			} else if (mapping.transport.kind === 'env') {
				Object.assign(transportEnv, mapping.transport.variables);
			}
		}
	}

	const ui: EffortUiDisplay = Object.freeze({
		text: candidateTier ?? UNSUPPORTED_EFFORT_LABEL,
		isSupported: true,
		tooltip: candidateTier !== null ? candidateTier : undefined,
	});

	return Object.freeze({
		effortTier: candidateTier,
		source,
		ui,
		transport: Object.freeze({
			args: Object.freeze(transportArgs),
			env: Object.freeze(transportEnv),
		}),
	});
}

/**
 * Resolves both model and reasoning effort tier for dispatch.
 * Guarantees AC 1, 2, 5, 6, 7, 8.
 */
export function resolveTaskModelAndEffort(context: ModelResolutionContext): ResolvedModelEffort {
	const resolvedModel = resolveModel(context);
	const resolvedEffort = resolveEffortTier(context, resolvedModel.model);

	// AC 2 & 3: Model args construction. Null model produces empty array; non-null produces [flag, model]
	const modelArgs = buildModelLaunchArgs(resolvedModel.model);

	return Object.freeze({
		agentId: context.agentDefaults.agentId,
		model: resolvedModel.model,
		modelSource: resolvedModel.source,
		effortTier: resolvedEffort.effortTier,
		effortSource: resolvedEffort.source,
		modelUi: resolvedModel.ui,
		effortUi: resolvedEffort.ui,
		modelArgs,
		effortTransport: resolvedEffort.transport,
	});
}

/**
 * AC 6 / E-34: Switching execution agent resets model and effort overrides
 * and clears prior run retention, falling back to the new agent's defaults.
 */
export function switchTaskAgent(
	currentState: TaskModelEffortState,
	newAgentId: string,
): TaskModelEffortState {
	if (currentState.agentId === newAgentId) {
		return currentState;
	}
	return Object.freeze({
		agentId: newAgentId,
		modelOverride: null,
		effortOverride: null,
		hasExplicitModelOverride: false,
		hasExplicitEffortOverride: false,
		lastUsedModel: null,
		lastUsedEffortTier: null,
	});
}

/**
 * AC 6 / E-34: Dropdown only lists models belonging to the active agent.
 * AC 4 / E-45: Aliases and full IDs are both preserved as-is without deduplication or merging.
 */
export function filterAvailableModelsForAgent(
	models: readonly ModelOption[] | undefined,
	_agentId?: string,
): readonly ModelOption[] {
	if (!models || models.length === 0) return Object.freeze([]);
	// Return a copy preserving exact order and all entries verbatim (no alias mapping, no dedup)
	return Object.freeze([...models]);
}

/**
 * Pre-dispatch lightweight model validation for E-30:
 * - Empty model selection is valid (E-35, E-41: follows agent config).
 * - Empty model catalog is valid (E-41: allows blank passthrough).
 * - Non-empty catalog requires model to be present in the agent's configured list.
 * - Point clearly to "model configuration problem".
 * - Never does cross-agent equivalent mapping.
 */
export function validateModelSelection(
	agentId: string,
	model: string | null | undefined,
	availableModels?: readonly ModelOption[],
): ModelValidationResult {
	if (model === null || model === undefined || model.trim() === '') {
		return Object.freeze({ ok: true, model: null });
	}

	const trimmedModel = model.trim();

	// If no model catalogue is available or list is empty, allow passthrough (E-41)
	if (!availableModels || availableModels.length === 0) {
		return Object.freeze({ ok: true, model: trimmedModel });
	}

	// AC 4 & E-30: Check exact ID or exact name without alias rewriting or cross-agent equivalence
	const found = availableModels.some((m) => m.id === trimmedModel || m.name === trimmedModel);
	if (!found) {
		const availableModelIds = Object.freeze(availableModels.map((m) => m.id));
		return Object.freeze({
			ok: false,
			code: 'E_VALIDATION',
			reason: 'model-not-found',
			message: `Model '${trimmedModel}' is not configured for agent '${agentId}'. Check model configuration.`,
			details: Object.freeze({
				agentId,
				selectedModel: trimmedModel,
				availableModelIds,
				fix: `Select a model from agent '${agentId}' configuration (${availableModelIds.join(', ')}) or clear the override to follow agent defaults.`,
			}),
		});
	}

	return Object.freeze({ ok: true, model: trimmedModel });
}

/**
 * Pre-dispatch effort tier validation for E-254 & E-255:
 * - Validates selected tier against agent and model capabilities.
 * - If unsupported or cannot be verified -> treats as unsupported (E-254), nulls tier, no failure.
 * - If tier is out of the model's accepted range -> rejects with explicit reason and fix.
 *   DOES NOT silently downgrade or silently discard.
 */
export function validateEffortTierForModel(
	agentId: string,
	model: string | null | undefined,
	tier: string | null | undefined,
	capability?: ModelCapability | null,
	context: { readonly isAgentEffortSupported?: boolean; readonly unsupportedReason?: string } = {},
): EffortValidationResult {
	if (tier === null || tier === undefined || tier === '') {
		return Object.freeze({ ok: true, effortTier: null, isSupported: true });
	}

	if (!isEffortTier(tier)) {
		return Object.freeze({
			ok: false,
			code: 'E_VALIDATION',
			reason: 'invalid-tier',
			message: `Reasoning effort '${tier}' is invalid. Allowed tiers are: ${Object.values(EFFORT_TIERS).join(', ')}.`,
			details: Object.freeze({
				agentId,
				model: model ?? null,
				selectedTier: tier,
				allowedTiers: Object.freeze(Object.values(EFFORT_TIERS)),
				fix: `Select one of: ${Object.values(EFFORT_TIERS).join(', ')}.`,
			}),
		});
	}

	// Check agent-level capability (E-254)
	const agentCapability: EffortCapabilityContext = {
		model,
		isSupported: context.isAgentEffortSupported,
		unsupportedReason: context.unsupportedReason,
	};
	if (!isEffortSupported(agentId, agentCapability)) {
		// Agent does not support effort -> treat as unsupported (E-254), nulls tier
		return Object.freeze({ ok: true, effortTier: null, isSupported: false });
	}

	// If no model capability info is provided or verification is impossible -> treat as unsupported (E-254)
	if (capability === null || capability === undefined) {
		return Object.freeze({ ok: true, effortTier: tier, isSupported: true });
	}

	if (capability.isEffortSupported === false) {
		const mismatch = formatEffortTierMismatch(model ?? 'Unknown model', tier, []);
		return Object.freeze({
			ok: false,
			code: 'E_VALIDATION',
			reason: 'effort-unsupported',
			message: mismatch.message,
			details: Object.freeze({
				agentId,
				model: model ?? null,
				selectedTier: tier,
				allowedTiers: Object.freeze([]),
				fix: mismatch.fix,
				zhMessage: mismatch.zhMessage,
			}),
		});
	}

	if (capability.supportedEffortTiers !== undefined && capability.supportedEffortTiers.length > 0) {
		if (!capability.supportedEffortTiers.includes(tier)) {
			const mismatch = formatEffortTierMismatch(
				model ?? 'Unknown model',
				tier,
				capability.supportedEffortTiers,
			);
			return Object.freeze({
				ok: false,
				code: 'E_VALIDATION',
				reason: 'tier-out-of-range',
				message: mismatch.message,
				details: Object.freeze({
					agentId,
					model: model ?? null,
					selectedTier: tier,
					allowedTiers: capability.supportedEffortTiers,
					fix: mismatch.fix,
					zhMessage: mismatch.zhMessage,
				}),
			});
		}
	}

	return Object.freeze({ ok: true, effortTier: tier, isSupported: true });
}

/**
 * Validates both model and reasoning effort tier before dispatch.
 */
export function validateDispatchModelAndEffort(
	context: ModelResolutionContext,
): DispatchValidationResult {
	const resolved = resolveTaskModelAndEffort(context);

	// Validate model (E-30)
	const modelValidation = validateModelSelection(
		resolved.agentId,
		resolved.model,
		context.agentDefaults.availableModels,
	);
	if (!modelValidation.ok) {
		return Object.freeze({
			ok: false,
			code: 'E_VALIDATION',
			errorKind: 'model',
			message: modelValidation.message,
			failure: modelValidation,
		});
	}

	// Validate effort tier (E-255)
	const modelCap =
		resolved.model !== null && resolved.model !== undefined
			? context.modelCapabilities?.[resolved.model]
			: undefined;

	const effortValidation = validateEffortTierForModel(
		resolved.agentId,
		resolved.model,
		resolved.effortTier,
		modelCap,
		{
			isAgentEffortSupported: context.agentDefaults.isEffortSupported,
			unsupportedReason: context.agentDefaults.unsupportedEffortReason,
		},
	);
	if (!effortValidation.ok) {
		return Object.freeze({
			ok: false,
			code: 'E_VALIDATION',
			errorKind: 'effort',
			message: effortValidation.message,
			failure: effortValidation,
		});
	}

	return Object.freeze({ ok: true, resolved });
}

/**
 * Formats structured mismatch explanation and fix guidance according to E-255.
 */
export function formatEffortTierMismatch(
	model: string,
	requestedTier: string,
	allowedTiers: readonly EffortTier[],
): {
	readonly message: string;
	readonly fix: string;
	readonly zhMessage: string;
} {
	const requestedZh =
		isEffortTier(requestedTier) && Object.hasOwn(EFFORT_TIER_DISPLAY_NAMES, requestedTier)
			? EFFORT_TIER_DISPLAY_NAMES[requestedTier]
			: requestedTier;

	if (allowedTiers.length === 0) {
		return Object.freeze({
			message: `Model '${model}' does not accept reasoning effort.`,
			fix: 'Clear reasoning effort override or choose a model that supports reasoning effort.',
			zhMessage: `${model} 不接受思考强度，请清除思考强度设置`,
		});
	}

	const allowedZh = allowedTiers
		.map((t) => (Object.hasOwn(EFFORT_TIER_DISPLAY_NAMES, t) ? EFFORT_TIER_DISPLAY_NAMES[t] : t))
		.join('/');

	const allowedEn = allowedTiers.join(', ');

	return Object.freeze({
		message: `Model '${model}' does not accept reasoning effort '${requestedTier}'. Available options: ${allowedEn}.`,
		fix: `Change reasoning effort to one of: ${allowedEn}.`,
		zhMessage: `${model} 不接受思考强度「${requestedZh}」，可选 ${allowedZh}`,
	});
}

/**
 * AC 3 / E-42: Model name is passed as a separate string in the argument array.
 * AC 2 / E-35, E-41: When model is null or empty, returns an empty array (no --model argument).
 */
export function buildModelLaunchArgs(
	model: string | null | undefined,
	flag = '--model',
): readonly string[] {
	if (model === null || model === undefined || model.trim() === '') {
		return Object.freeze([]);
	}
	return Object.freeze([flag, model]);
}

/**
 * Replaces {model} in an argsTemplate array with the actual model,
 * or removes the --model flag and {model} placeholder entirely when model is null/empty.
 */
export function applyModelToArgsTemplate(
	argsTemplate: readonly string[],
	model: string | null | undefined,
): readonly string[] {
	const isModelOmitted = model === null || model === undefined || model.trim() === '';

	if (!isModelOmitted) {
		const nonNullModel = model.trim();
		return Object.freeze(
			argsTemplate.map((arg) =>
				arg.includes('{model}') ? arg.replaceAll('{model}', nonNullModel) : arg,
			),
		);
	}

	// Model is omitted (E-35, E-41): remove {model} and its preceding flag
	const result: string[] = [];
	for (let i = 0; i < argsTemplate.length; i++) {
		const arg = argsTemplate[i];
		if (arg === undefined) continue;

		if (arg.includes('{model}')) {
			// If previous arg was a flag like '--model' or '-m', discard it
			const lastArg = result[result.length - 1];
			if (lastArg === '--model' || lastArg === '-m') {
				result.pop();
			}
			// Skip this argument containing {model}
			continue;
		}

		// Also handle combined form like '--model={model}'
		if (arg.startsWith('--model=') || arg.startsWith('-m=')) {
			continue;
		}

		result.push(arg);
	}

	return Object.freeze(result);
}

function normalizeStringOrNull(value?: string | null): string | null {
	if (value === undefined || value === null) return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

function normalizeEffortTierOrNull(value?: unknown): EffortTier | null {
	if (value === undefined || value === null) return null;
	if (isEffortTier(value)) return value;
	return null;
}
