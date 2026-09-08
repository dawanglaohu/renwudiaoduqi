import { describe, expect, it } from 'vitest';
import {
	EFFORT_TIERS,
	assertEffortTier,
	compareSelectedAndReportedEffort,
	getEffortArgs,
	isEffortSupported,
	isEffortTier,
	normalizeReportedEffort,
	resolveEffortMapping,
} from '../../src/domain/effort-tier.ts';
import { AppError } from '../../src/errors/app-error.ts';

describe('M4-T7 effort tier domain logic', () => {
	describe('three-tier abstraction and validation (决策 52, R4)', () => {
		it('recognizes valid abstract product effort tiers', () => {
			expect(isEffortTier('low')).toBe(true);
			expect(isEffortTier('medium')).toBe(true);
			expect(isEffortTier('high')).toBe(true);
		});

		it('rejects raw vendor flags or arbitrary values with AppError E_VALIDATION (R4)', () => {
			expect(isEffortTier('model_reasoning_effort')).toBe(false);
			expect(isEffortTier('--effort')).toBe(false);
			expect(isEffortTier('--thinking')).toBe(false);
			expect(isEffortTier('minimal')).toBe(false);
			expect(isEffortTier('xhigh')).toBe(false);
			expect(isEffortTier('max')).toBe(false);
			expect(isEffortTier(1024)).toBe(false);
			expect(isEffortTier(null)).toBe(false);
			expect(isEffortTier(undefined)).toBe(false);

			expect(() => assertEffortTier('xhigh')).toThrow(AppError);
			try {
				assertEffortTier('xhigh');
			} catch (error) {
				expect(error).toBeInstanceOf(AppError);
				expect((error as AppError).code).toBe('E_VALIDATION');
			}
			expect(() => assertEffortTier('medium')).not.toThrow();
		});
	});

	describe('vendor parameter mapping and model perception (决策 52, AC 4, R2, R3)', () => {
		it('maps codex effort to model_reasoning_effort and checks non-reasoning models (R3)', () => {
			expect(resolveEffortMapping('codex', 'low')).toEqual({
				supported: true,
				agentId: 'codex',
				tier: 'low',
				vendorParam: 'model_reasoning_effort',
				vendorValue: 'low',
				args: ['-c', 'model_reasoning_effort="low"'],
			});

			expect(resolveEffortMapping('codex', 'medium')).toEqual({
				supported: true,
				agentId: 'codex',
				tier: 'medium',
				vendorParam: 'model_reasoning_effort',
				vendorValue: 'medium',
				args: ['-c', 'model_reasoning_effort="medium"'],
			});

			expect(resolveEffortMapping('codex', 'high', { model: 'o3-mini' })).toEqual({
				supported: true,
				agentId: 'codex',
				tier: 'high',
				vendorParam: 'model_reasoning_effort',
				vendorValue: 'high',
				args: ['-c', 'model_reasoning_effort="high"'],
			});

			// Non-reasoning models like gpt-4o do not support reasoning effort
			expect(isEffortSupported('codex', { model: 'gpt-4o' })).toBe(false);
			const nonReasoning = resolveEffortMapping('codex', 'medium', { model: 'gpt-4o' });
			expect(nonReasoning.supported).toBe(false);
			if (!nonReasoning.supported) {
				expect(nonReasoning.reason).toContain('gpt-4o');
			}
			expect(() => getEffortArgs('codex', 'medium', { model: 'gpt-4o' })).toThrow(AppError);
		});

		it('maps claude effort to thinking budget and rejects haiku models (AC 4, R2, R3)', () => {
			const low = resolveEffortMapping('claude', 'low');
			expect(low).toEqual({
				supported: true,
				agentId: 'claude',
				tier: 'low',
				vendorParam: 'thinking_budget',
				vendorValue: '2048',
				args: ['--settings', '{"maxThinkingTokens":2048}'],
				budgetTokens: 2048,
			});

			const medium = resolveEffortMapping('claude', 'medium');
			expect(medium).toEqual({
				supported: true,
				agentId: 'claude',
				tier: 'medium',
				vendorParam: 'thinking_budget',
				vendorValue: '8192',
				args: ['--settings', '{"maxThinkingTokens":8192}'],
				budgetTokens: 8192,
			});

			const high = resolveEffortMapping('claude', 'high', { model: 'claude-3-7-sonnet' });
			expect(high).toEqual({
				supported: true,
				agentId: 'claude',
				tier: 'high',
				vendorParam: 'thinking_budget',
				vendorValue: '32768',
				args: ['--settings', '{"maxThinkingTokens":32768}'],
				budgetTokens: 32768,
			});

			// Haiku models do not support thinking budget
			expect(isEffortSupported('claude', { model: 'claude-3-5-haiku-20241022' })).toBe(false);
			const haikuResult = resolveEffortMapping('claude', 'low', { model: 'claude-3-5-haiku' });
			expect(haikuResult.supported).toBe(false);
			if (!haikuResult.supported) {
				expect(haikuResult.reason).toContain('haiku');
			}
			expect(() => getEffortArgs('claude', 'low', { model: 'claude-3-5-haiku' })).toThrow(AppError);
		});

		it('maps grok effort to --reasoning-effort argument', () => {
			expect(resolveEffortMapping('grok', 'low')).toEqual({
				supported: true,
				agentId: 'grok',
				tier: 'low',
				vendorParam: '--reasoning-effort',
				vendorValue: 'low',
				args: ['--reasoning-effort', 'low'],
			});

			expect(resolveEffortMapping('grok', 'high')).toEqual({
				supported: true,
				agentId: 'grok',
				tier: 'high',
				vendorParam: '--reasoning-effort',
				vendorValue: 'high',
				args: ['--reasoning-effort', 'high'],
			});
		});

		it('maps pi effort to --thinking argument', () => {
			expect(resolveEffortMapping('pi', 'low')).toEqual({
				supported: true,
				agentId: 'pi',
				tier: 'low',
				vendorParam: '--thinking',
				vendorValue: 'low',
				args: ['--thinking', 'low'],
			});

			expect(resolveEffortMapping('pi', 'high')).toEqual({
				supported: true,
				agentId: 'pi',
				tier: 'high',
				vendorParam: '--thinking',
				vendorValue: 'high',
				args: ['--thinking', 'high'],
			});
		});
	});

	describe('unsupported agent handling and prototype safety (AC 5, E-254, R2, R3)', () => {
		it('returns unsupported for DeepSeek Harness without defaulting to any tier', () => {
			expect(isEffortSupported('dsh')).toBe(false);
			const result = resolveEffortMapping('dsh', 'high');
			expect(result.supported).toBe(false);
			if (!result.supported) {
				expect(result.reason).toContain('DeepSeek Harness');
			}

			// Must throw AppError('E_CAPABILITY_UNSUPPORTED') if effort requested on unsupported agent (R2)
			expect(() => getEffortArgs('dsh', 'high')).toThrow(AppError);
		});

		it('returns unsupported for generic ACP and unknown agents without defaulting', () => {
			expect(isEffortSupported('generic-acp')).toBe(false);
			expect(resolveEffortMapping('generic-acp', 'medium').supported).toBe(false);
			expect(() => getEffortArgs('generic-acp', 'medium')).toThrow(AppError);

			expect(isEffortSupported('unknown-agent')).toBe(false);
			expect(resolveEffortMapping('unknown-agent', 'low').supported).toBe(false);
			expect(() => getEffortArgs('unknown-agent', 'low')).toThrow(AppError);
		});

		it('safely handles prototype property names without crashing (R3)', () => {
			expect(isEffortSupported('constructor')).toBe(false);
			expect(isEffortSupported('__proto__')).toBe(false);
			expect(isEffortSupported('toString')).toBe(false);
			expect(isEffortSupported('valueOf')).toBe(false);

			const ctorMapping = resolveEffortMapping('constructor', 'low');
			expect(ctorMapping.supported).toBe(false);
			expect(() => getEffortArgs('constructor', 'low')).toThrow(AppError);
		});

		it('emits empty arguments when tier is null or undefined (E-254)', () => {
			expect(getEffortArgs('codex', null)).toEqual([]);
			expect(getEffortArgs('codex', undefined)).toEqual([]);
			expect(getEffortArgs('claude', null)).toEqual([]);
			expect(getEffortArgs('dsh', null)).toEqual([]);
		});
	});

	describe('reverse mapping and mismatch reporting (AC 6, E-256, R3)', () => {
		it('reverse maps recognized vendor strings and token counts', () => {
			expect(normalizeReportedEffort('low')).toBe(EFFORT_TIERS.LOW);
			expect(normalizeReportedEffort('minimal')).toBe(EFFORT_TIERS.LOW);
			expect(normalizeReportedEffort('medium')).toBe(EFFORT_TIERS.MEDIUM);
			expect(normalizeReportedEffort('high')).toBe(EFFORT_TIERS.HIGH);
			expect(normalizeReportedEffort('xhigh')).toBe(EFFORT_TIERS.HIGH);
			expect(normalizeReportedEffort('max')).toBe(EFFORT_TIERS.HIGH);

			// Reverse map Claude thinking budget token numbers (R3)
			expect(normalizeReportedEffort('2048')).toBe(EFFORT_TIERS.LOW);
			expect(normalizeReportedEffort('8192')).toBe(EFFORT_TIERS.MEDIUM);
			expect(normalizeReportedEffort('16384')).toBe(EFFORT_TIERS.HIGH);
			expect(normalizeReportedEffort('32768')).toBe(EFFORT_TIERS.HIGH);

			expect(normalizeReportedEffort('unrecognized-effort')).toBeNull();
			expect(normalizeReportedEffort(null)).toBeNull();
			expect(normalizeReportedEffort('')).toBeNull();
		});

		it('reports both values and detects mismatch without silently trusting either (E-256, R3)', () => {
			const mismatch = compareSelectedAndReportedEffort('high', 'medium');
			expect(mismatch.isMismatch).toBe(true);
			expect(mismatch.selectedTier).toBe('high');
			expect(mismatch.reportedRaw).toBe('medium');
			expect(mismatch.reportedNormalized).toBe('medium');

			const matched = compareSelectedAndReportedEffort('high', 'high');
			expect(matched.isMismatch).toBe(false);
			expect(matched.selectedTier).toBe('high');
			expect(matched.reportedRaw).toBe('high');
			expect(matched.reportedNormalized).toBe('high');

			const matchedTokenCount = compareSelectedAndReportedEffort('low', '2048');
			expect(matchedTokenCount.isMismatch).toBe(false);
			expect(matchedTokenCount.selectedTier).toBe('low');
			expect(matchedTokenCount.reportedRaw).toBe('2048');
			expect(matchedTokenCount.reportedNormalized).toBe('low');

			const tokenMismatch = compareSelectedAndReportedEffort('high', '2048');
			expect(tokenMismatch.isMismatch).toBe(true);
			expect(tokenMismatch.selectedTier).toBe('high');
			expect(tokenMismatch.reportedRaw).toBe('2048');
			expect(tokenMismatch.reportedNormalized).toBe('low');

			// Unrecognized reported string triggers mismatch against a selected tier and preserves raw string
			const unrecMismatch = compareSelectedAndReportedEffort('high', 'unknown-tier');
			expect(unrecMismatch.isMismatch).toBe(true);
			expect(unrecMismatch.selectedTier).toBe('high');
			expect(unrecMismatch.reportedRaw).toBe('unknown-tier');
			expect(unrecMismatch.reportedNormalized).toBeNull();
		});

		it('does not flag mismatch when selected or reported is absent', () => {
			const noReported = compareSelectedAndReportedEffort('high', null);
			expect(noReported.isMismatch).toBe(false);
			expect(noReported.selectedTier).toBe('high');
			expect(noReported.reportedRaw).toBeNull();

			const noSelected = compareSelectedAndReportedEffort(null, 'medium');
			expect(noSelected.isMismatch).toBe(false);
			expect(noSelected.selectedTier).toBeNull();
			expect(noSelected.reportedRaw).toBe('medium');
		});
	});
});
