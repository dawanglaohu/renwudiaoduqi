import { describe, expect, it } from 'vitest';
import { EFFORT_TIERS } from '../../src/domain/effort-tier.ts';
import {
	type AgentModelDefaults,
	FOLLOW_AGENT_CONFIG_LABEL,
	type ModelResolutionContext,
	type TaskModelEffortState,
	UNSUPPORTED_EFFORT_LABEL,
	applyModelToArgsTemplate,
	buildModelLaunchArgs,
	filterAvailableModelsForAgent,
	resolveTaskModelAndEffort,
	switchTaskAgent,
	validateDispatchModelAndEffort,
	validateEffortTierForModel,
	validateModelSelection,
} from '../../src/domain/model-selection.ts';

describe('domain/model-selection (M4-T6)', () => {
	const codexDefaults: AgentModelDefaults = Object.freeze({
		agentId: 'codex',
		defaultModel: 'gpt-5-codex',
		defaultEffortTier: EFFORT_TIERS.MEDIUM,
		isEffortSupported: true,
		availableModels: Object.freeze([
			{
				id: 'gpt-5-codex',
				name: 'GPT-5 Codex',
				supportedEffortTiers: [EFFORT_TIERS.LOW, EFFORT_TIERS.MEDIUM, EFFORT_TIERS.HIGH] as const,
			},
			{
				id: 'gpt-5.6-mini',
				name: 'GPT-5.6 Mini',
				supportedEffortTiers: [EFFORT_TIERS.LOW, EFFORT_TIERS.MEDIUM] as const,
			},
			{
				id: 'o3-mini',
				name: 'o3-mini',
				supportedEffortTiers: [EFFORT_TIERS.LOW, EFFORT_TIERS.MEDIUM, EFFORT_TIERS.HIGH] as const,
			},
		]),
	});

	const claudeDefaults: AgentModelDefaults = Object.freeze({
		agentId: 'claude',
		defaultModel: 'claude-3-7-sonnet',
		defaultEffortTier: EFFORT_TIERS.LOW,
		isEffortSupported: true,
		availableModels: Object.freeze([
			{ id: 'claude-3-7-sonnet', name: 'Sonnet 3.7' },
			{ id: 'sonnet', name: 'sonnet (alias)' },
			{ id: 'opus', name: 'opus (alias)' },
			{ id: 'claude-3-opus-20240229', name: 'Opus 3 (Full ID)' },
		]),
	});

	const dshDefaults: AgentModelDefaults = Object.freeze({
		agentId: 'dsh',
		defaultModel: 'deepseek-coder-v2',
		defaultEffortTier: null,
		isEffortSupported: false,
		unsupportedEffortReason: 'DeepSeek Harness does not support reasoning effort control.',
		availableModels: Object.freeze([{ id: 'deepseek-coder-v2' }]),
	});

	describe('AC 1: per-agent default and temporary task override', () => {
		it('uses agent default model and effort when task has no overrides', () => {
			const context: ModelResolutionContext = {
				agentDefaults: codexDefaults,
				taskState: null,
			};
			const result = resolveTaskModelAndEffort(context);

			expect(result.model).toBe('gpt-5-codex');
			expect(result.modelSource).toBe('agent_default');
			expect(result.effortTier).toBe('medium');
			expect(result.effortSource).toBe('agent_default');
			expect(result.modelUi.text).toBe('gpt-5-codex');
			expect(result.modelUi.isFollowAgentConfig).toBe(false);
			expect(result.effortUi.text).toBe('medium');
			expect(result.effortUi.isSupported).toBe(true);
		});

		it('allows single-task temporary override without modifying agent configuration', () => {
			const taskState: TaskModelEffortState = {
				agentId: 'codex',
				modelOverride: 'gpt-5.6-mini',
				effortOverride: 'low',
				hasExplicitModelOverride: true,
				hasExplicitEffortOverride: true,
			};
			const context: ModelResolutionContext = {
				agentDefaults: codexDefaults,
				taskState,
			};
			const result = resolveTaskModelAndEffort(context);

			expect(result.model).toBe('gpt-5.6-mini');
			expect(result.modelSource).toBe('task_override');
			expect(result.effortTier).toBe('low');
			expect(result.effortSource).toBe('task_override');

			// Agent defaults remain untouched
			expect(codexDefaults.defaultModel).toBe('gpt-5-codex');
			expect(codexDefaults.defaultEffortTier).toBe('medium');
		});
	});

	describe('AC 2, E-35, E-41: empty model list / unset default allows blank follow-agent-config', () => {
		it('resolves to null and displays follow agent config without blocking dispatch', () => {
			const emptyDefaults: AgentModelDefaults = {
				agentId: 'codex',
				defaultModel: null,
				defaultEffortTier: null,
				availableModels: [],
			};
			const context: ModelResolutionContext = {
				agentDefaults: emptyDefaults,
				taskState: null,
			};
			const result = resolveTaskModelAndEffort(context);

			expect(result.model).toBeNull();
			expect(result.modelSource).toBe('follow_agent_config');
			expect(result.modelUi.text).toBe(FOLLOW_AGENT_CONFIG_LABEL);
			expect(result.modelUi.isFollowAgentConfig).toBe(true);
			expect(result.modelArgs).toEqual([]);
		});

		it('removes --model flag and placeholder from template when model is omitted', () => {
			const template = ['exec', '--json', '--model', '{model}'];
			const result = applyModelToArgsTemplate(template, null);
			expect(result).toEqual(['exec', '--json']);

			const piTemplate = [
				'--print',
				'--mode',
				'rpc',
				'--model',
				'{model}',
				'--session-dir',
				'{session_dir}',
			];
			const piResult = applyModelToArgsTemplate(piTemplate, null);
			expect(piResult).toEqual(['--print', '--mode', 'rpc', '--session-dir', '{session_dir}']);

			const grokTemplate = ['--single', '--output-format', 'streaming-json', '--model', '{model}'];
			const grokResult = applyModelToArgsTemplate(grokTemplate, undefined);
			expect(grokResult).toEqual(['--single', '--output-format', 'streaming-json']);
		});

		it('validates successfully when model is omitted or catalogue is empty (E-41)', () => {
			const validation = validateModelSelection('codex', null, []);
			expect(validation.ok).toBe(true);
			if (validation.ok) {
				expect(validation.model).toBeNull();
			}

			const validationWithEmptyCatalog = validateModelSelection('codex', 'custom-model', []);
			expect(validationWithEmptyCatalog.ok).toBe(true);
		});
	});

	describe('AC 3, E-42: model names with spaces, quotes, and shell metacharacters', () => {
		it('preserves spaces, quotes, and metacharacters in discrete argument array elements', () => {
			const modelName = 'claude-3-opus; rm -rf / & echo "owned" | test';
			const args = buildModelLaunchArgs(modelName);

			expect(args).toEqual(['--model', modelName]);
			expect(args.length).toBe(2);
			expect(args[1]).toBe(modelName);

			const template = ['--print', '--model', '{model}'];
			const rendered = applyModelToArgsTemplate(template, modelName);
			expect(rendered).toEqual(['--print', '--model', modelName]);
		});

		it('does not quote or split multi-word model names', () => {
			const modelName = 'meta llama 3.3 70b instruct';
			const args = buildModelLaunchArgs(modelName);
			expect(args).toEqual(['--model', 'meta llama 3.3 70b instruct']);
		});
	});

	describe('AC 4, E-45, E-30: aliases and full IDs preserved verbatim without mapping', () => {
		it('preserves both aliases and full IDs in model catalogue without deduplication or merging (E-45)', () => {
			const filtered = filterAvailableModelsForAgent(claudeDefaults.availableModels, 'claude');
			expect(filtered.map((m) => m.id)).toEqual([
				'claude-3-7-sonnet',
				'sonnet',
				'opus',
				'claude-3-opus-20240229',
			]);
		});

		it('transparently passes alias verbatim when chosen', () => {
			const context: ModelResolutionContext = {
				agentDefaults: claudeDefaults,
				taskState: {
					agentId: 'claude',
					modelOverride: 'opus',
				},
			};
			const result = resolveTaskModelAndEffort(context);
			expect(result.model).toBe('opus');
			expect(result.modelArgs).toEqual(['--model', 'opus']);
		});

		it('transparently passes full ID verbatim when chosen', () => {
			const context: ModelResolutionContext = {
				agentDefaults: claudeDefaults,
				taskState: {
					agentId: 'claude',
					modelOverride: 'claude-3-opus-20240229',
				},
			};
			const result = resolveTaskModelAndEffort(context);
			expect(result.model).toBe('claude-3-opus-20240229');
			expect(result.modelArgs).toEqual(['--model', 'claude-3-opus-20240229']);
		});

		it('fails pre-dispatch validation when model is not configured for the agent (E-30)', () => {
			const validation = validateModelSelection(
				'claude',
				'gpt-5-codex',
				claudeDefaults.availableModels,
			);
			expect(validation.ok).toBe(false);
			if (!validation.ok) {
				expect(validation.code).toBe('E_VALIDATION');
				expect(validation.reason).toBe('model-not-found');
				expect(validation.message).toContain(
					"Model 'gpt-5-codex' is not configured for agent 'claude'",
				);
				expect(validation.details.agentId).toBe('claude');
				expect(validation.details.selectedModel).toBe('gpt-5-codex');
			}
		});
	});

	describe('AC 5, E-33: retry retains previous actual model unless explicitly cleared', () => {
		it('retains last used model on retry when previous run had an override', () => {
			const taskState: TaskModelEffortState = {
				agentId: 'codex',
				hasExplicitModelOverride: true,
				lastUsedModel: 'o3-mini',
			};
			const context: ModelResolutionContext = {
				agentDefaults: codexDefaults,
				taskState,
				isRetry: true,
			};
			const result = resolveTaskModelAndEffort(context);
			expect(result.model).toBe('o3-mini');
			expect(result.modelSource).toBe('retry_retained');
		});

		it('falls back to agent default model on retry when user explicitly clears override', () => {
			const taskState: TaskModelEffortState = {
				agentId: 'codex',
				hasExplicitModelOverride: true,
				lastUsedModel: 'o3-mini',
			};
			const context: ModelResolutionContext = {
				agentDefaults: codexDefaults,
				taskState,
				isRetry: true,
				clearModelOverride: true,
			};
			const result = resolveTaskModelAndEffort(context);
			expect(result.model).toBe('gpt-5-codex');
			expect(result.modelSource).toBe('agent_default');
		});

		it('uses new override if user explicitly provided a new model for retry', () => {
			const taskState: TaskModelEffortState = {
				agentId: 'codex',
				modelOverride: 'gpt-5.6-mini',
				lastUsedModel: 'o3-mini',
				hasExplicitModelOverride: true,
			};
			const context: ModelResolutionContext = {
				agentDefaults: codexDefaults,
				taskState,
				isRetry: true,
			};
			const result = resolveTaskModelAndEffort(context);
			expect(result.model).toBe('gpt-5.6-mini');
			expect(result.modelSource).toBe('task_override');
		});

		it('uses agent default if previous run used default (no override was set)', () => {
			const taskState: TaskModelEffortState = {
				agentId: 'codex',
				hasExplicitModelOverride: false,
				lastUsedModel: 'gpt-5-codex',
			};
			const context: ModelResolutionContext = {
				agentDefaults: codexDefaults,
				taskState,
				isRetry: true,
			};
			const result = resolveTaskModelAndEffort(context);
			expect(result.model).toBe('gpt-5-codex');
			expect(result.modelSource).toBe('agent_default');
		});
	});

	describe('AC 6, E-34: switching agent clears overrides and falls back to new agent default', () => {
		it('clears model and effort overrides when switching task agent', () => {
			const previousState: TaskModelEffortState = {
				agentId: 'codex',
				modelOverride: 'o3-mini',
				effortOverride: 'high',
				hasExplicitModelOverride: true,
				hasExplicitEffortOverride: true,
				lastUsedModel: 'o3-mini',
				lastUsedEffortTier: 'high',
			};

			const switchedState = switchTaskAgent(previousState, 'claude');

			expect(switchedState.agentId).toBe('claude');
			expect(switchedState.modelOverride).toBeNull();
			expect(switchedState.effortOverride).toBeNull();
			expect(switchedState.hasExplicitModelOverride).toBe(false);
			expect(switchedState.hasExplicitEffortOverride).toBe(false);
			expect(switchedState.lastUsedModel).toBeNull();
			expect(switchedState.lastUsedEffortTier).toBeNull();
		});

		it('resolveTaskModelAndEffort drops to new agent default when targetAgentId differs', () => {
			const taskState: TaskModelEffortState = {
				agentId: 'codex',
				modelOverride: 'o3-mini',
				effortOverride: 'high',
				hasExplicitModelOverride: true,
				hasExplicitEffortOverride: true,
			};

			const context: ModelResolutionContext = {
				agentDefaults: claudeDefaults,
				taskState,
				targetAgentId: 'claude',
			};

			const result = resolveTaskModelAndEffort(context);

			expect(result.agentId).toBe('claude');
			expect(result.model).toBe('claude-3-7-sonnet');
			expect(result.modelSource).toBe('agent_default');
			expect(result.effortTier).toBe('low');
			expect(result.effortSource).toBe('agent_default');
		});
	});

	describe('AC 7: effort tier resolution isomorphic to model chain (决策 52)', () => {
		it('retains last used effort tier on retry when previously overridden', () => {
			const taskState: TaskModelEffortState = {
				agentId: 'codex',
				hasExplicitEffortOverride: true,
				lastUsedEffortTier: 'high',
			};
			const context: ModelResolutionContext = {
				agentDefaults: codexDefaults,
				taskState,
				isRetry: true,
			};
			const result = resolveTaskModelAndEffort(context);
			expect(result.effortTier).toBe('high');
			expect(result.effortSource).toBe('retry_retained');
		});

		it('falls back to agent default effort on retry when explicitly cleared', () => {
			const taskState: TaskModelEffortState = {
				agentId: 'codex',
				hasExplicitEffortOverride: true,
				lastUsedEffortTier: 'high',
			};
			const context: ModelResolutionContext = {
				agentDefaults: codexDefaults,
				taskState,
				isRetry: true,
				clearEffortOverride: true,
			};
			const result = resolveTaskModelAndEffort(context);
			expect(result.effortTier).toBe('medium');
			expect(result.effortSource).toBe('agent_default');
		});

		it('produces valid transport parameters for each vendor', () => {
			// Codex
			const codexRes = resolveTaskModelAndEffort({
				agentDefaults: codexDefaults,
				taskState: { agentId: 'codex', effortOverride: 'high' },
			});
			expect(codexRes.effortTransport.args).toEqual(['-c', 'model_reasoning_effort="high"']);
			expect(codexRes.effortTransport.env).toEqual({});

			// Claude
			const claudeRes = resolveTaskModelAndEffort({
				agentDefaults: claudeDefaults,
				taskState: { agentId: 'claude', effortOverride: 'medium' },
			});
			expect(claudeRes.effortTransport.args).toEqual([]);
			expect(claudeRes.effortTransport.env).toEqual({ MAX_THINKING_TOKENS: '8192' });
		});
	});

	describe('AC 8, E-254: unsupported effort tier agent sets NULL and passes no parameters', () => {
		it('resolves effort to null, shows — in UI, and does not pass parameters for dsh', () => {
			const context: ModelResolutionContext = {
				agentDefaults: dshDefaults,
				taskState: { agentId: 'dsh', effortOverride: 'high' },
			};
			const result = resolveTaskModelAndEffort(context);

			expect(result.effortTier).toBeNull();
			expect(result.effortSource).toBe('unsupported');
			expect(result.effortUi.text).toBe(UNSUPPORTED_EFFORT_LABEL);
			expect(result.effortUi.isSupported).toBe(false);
			expect(result.effortUi.tooltip).toContain(
				'DeepSeek Harness does not support reasoning effort',
			);
			expect(result.effortTransport.args).toEqual([]);
			expect(result.effortTransport.env).toEqual({});
		});

		it('does not fake a default tier like low or medium for unsupported agents', () => {
			const genericAcpDefaults: AgentModelDefaults = {
				agentId: 'generic-acp',
				defaultModel: null,
				defaultEffortTier: null,
				isEffortSupported: false,
			};
			const result = resolveTaskModelAndEffort({
				agentDefaults: genericAcpDefaults,
				taskState: null,
			});
			expect(result.effortTier).toBeNull();
			expect(result.effortUi.text).toBe('—');
		});
	});

	describe('AC 9, E-255: out-of-range effort tier rejected with reason and fix', () => {
		it('rejects effort tier exceeding model capabilities without silent downgrade', () => {
			const capability = {
				isEffortSupported: true,
				supportedEffortTiers: ['low', 'medium'] as const,
			};
			const validation = validateEffortTierForModel('codex', 'gpt-5.6-mini', 'high', capability);

			expect(validation.ok).toBe(false);
			if (!validation.ok) {
				expect(validation.code).toBe('E_VALIDATION');
				expect(validation.reason).toBe('tier-out-of-range');
				expect(validation.details.selectedTier).toBe('high');
				expect(validation.details.allowedTiers).toEqual(['low', 'medium']);
				expect(validation.details.zhMessage).toContain(
					'gpt-5.6-mini 不接受思考强度「高」，可选 低/中',
				);
				expect(validation.message).toContain(
					"Model 'gpt-5.6-mini' does not accept reasoning effort 'high'",
				);
				expect(validation.details.fix).toContain('Change reasoning effort to one of: low, medium');
			}
		});

		it('accepts effort tier within model capability range', () => {
			const capability = {
				isEffortSupported: true,
				supportedEffortTiers: ['low', 'medium'] as const,
			};
			const validation = validateEffortTierForModel('codex', 'gpt-5.6-mini', 'medium', capability);
			expect(validation.ok).toBe(true);
			if (validation.ok) {
				expect(validation.effortTier).toBe('medium');
				expect(validation.isSupported).toBe(true);
			}
		});

		it('rejects effort tier when model does not support reasoning effort at all', () => {
			const capability = {
				isEffortSupported: false,
				supportedEffortTiers: [] as const,
			};
			const validation = validateEffortTierForModel('codex', 'legacy-model', 'medium', capability);
			expect(validation.ok).toBe(false);
			if (!validation.ok) {
				expect(validation.reason).toBe('effort-unsupported');
				expect(validation.details.zhMessage).toContain(
					'legacy-model 不接受思考强度，请清除思考强度设置',
				);
			}
		});

		it('rejects invalid effort tier strings with E_VALIDATION', () => {
			const validation = validateEffortTierForModel('codex', 'gpt-5-codex', 'ultra-max');
			expect(validation.ok).toBe(false);
			if (!validation.ok) {
				expect(validation.code).toBe('E_VALIDATION');
				expect(validation.reason).toBe('invalid-tier');
			}
		});

		it('treats unverifiable model capability as unsupported per E-254 during resolution', () => {
			const context: ModelResolutionContext = {
				agentDefaults: codexDefaults,
				taskState: {
					agentId: 'codex',
					modelOverride: 'unverifiable-model',
					effortOverride: 'high',
				},
				modelCapabilities: {
					'unverifiable-model': {
						isEffortSupported: false,
						unsupportedReason: 'Model probe could not verify reasoning effort capability.',
					},
				},
			};
			const result = resolveTaskModelAndEffort(context);
			expect(result.effortTier).toBeNull();
			expect(result.effortSource).toBe('unsupported');
			expect(result.effortUi.text).toBe('—');
			expect(result.effortTransport.args).toEqual([]);
		});
	});

	describe('validateDispatchModelAndEffort', () => {
		it('validates complete dispatch configuration successfully', () => {
			const context: ModelResolutionContext = {
				agentDefaults: codexDefaults,
				taskState: {
					agentId: 'codex',
					modelOverride: 'o3-mini',
					effortOverride: 'high',
				},
			};
			const result = validateDispatchModelAndEffort(context);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.resolved.model).toBe('o3-mini');
				expect(result.resolved.effortTier).toBe('high');
			}
		});

		it('fails dispatch validation when model is invalid (E-30)', () => {
			const context: ModelResolutionContext = {
				agentDefaults: codexDefaults,
				taskState: {
					agentId: 'codex',
					modelOverride: 'non-existent-model',
				},
			};
			const result = validateDispatchModelAndEffort(context);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errorKind).toBe('model');
				expect(result.message).toContain(
					"Model 'non-existent-model' is not configured for agent 'codex'",
				);
			}
		});

		it('fails dispatch validation when effort tier is out of range for the chosen model (E-255)', () => {
			const context: ModelResolutionContext = {
				agentDefaults: codexDefaults,
				taskState: {
					agentId: 'codex',
					modelOverride: 'gpt-5.6-mini',
					effortOverride: 'high',
				},
				modelCapabilities: {
					'gpt-5.6-mini': {
						isEffortSupported: true,
						supportedEffortTiers: ['low', 'medium'],
					},
				},
			};
			const result = validateDispatchModelAndEffort(context);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errorKind).toBe('effort');
				expect(result.message).toContain(
					"Model 'gpt-5.6-mini' does not accept reasoning effort 'high'",
				);
			}
		});
	});
});
