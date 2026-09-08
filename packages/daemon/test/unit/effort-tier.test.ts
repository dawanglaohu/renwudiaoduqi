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

describe('M4-T7 effort tier domain logic', () => {
	describe('three-tier abstraction and validation (决策 52)', () => {
		it('recognizes valid abstract product effort tiers', () => {
			expect(isEffortTier('low')).toBe(true);
			expect(isEffortTier('medium')).toBe(true);
			expect(isEffortTier('high')).toBe(true);
		});

		it('rejects raw vendor flags or arbitrary values', () => {
			expect(isEffortTier('model_reasoning_effort')).toBe(false);
			expect(isEffortTier('--effort')).toBe(false);
			expect(isEffortTier('--thinking')).toBe(false);
			expect(isEffortTier('minimal')).toBe(false);
			expect(isEffortTier('xhigh')).toBe(false);
			expect(isEffortTier('max')).toBe(false);
			expect(isEffortTier(1024)).toBe(false);
			expect(isEffortTier(null)).toBe(false);
			expect(isEffortTier(undefined)).toBe(false);

			expect(() => assertEffortTier('xhigh')).toThrow(TypeError);
			expect(() => assertEffortTier('medium')).not.toThrow();
		});
	});

	describe('vendor parameter mapping (决策 52, AC 4)', () => {
		it('maps codex effort to model_reasoning_effort config arguments', () => {
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

			expect(resolveEffortMapping('codex', 'high')).toEqual({
				supported: true,
				agentId: 'codex',
				tier: 'high',
				vendorParam: 'model_reasoning_effort',
				vendorValue: 'high',
				args: ['-c', 'model_reasoning_effort="high"'],
			});

			expect(getEffortArgs('codex', 'high')).toEqual(['-c', 'model_reasoning_effort="high"']);
		});

		it('maps claude effort to --effort argument and tracks budget tokens', () => {
			expect(resolveEffortMapping('claude', 'low')).toEqual({
				supported: true,
				agentId: 'claude',
				tier: 'low',
				vendorParam: '--effort',
				vendorValue: 'low',
				args: ['--effort', 'low'],
				budgetTokens: 2048,
			});

			expect(resolveEffortMapping('claude', 'medium')).toEqual({
				supported: true,
				agentId: 'claude',
				tier: 'medium',
				vendorParam: '--effort',
				vendorValue: 'medium',
				args: ['--effort', 'medium'],
				budgetTokens: 8192,
			});

			expect(resolveEffortMapping('claude', 'high')).toEqual({
				supported: true,
				agentId: 'claude',
				tier: 'high',
				vendorParam: '--effort',
				vendorValue: 'high',
				args: ['--effort', 'high'],
				budgetTokens: 32768,
			});
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

			expect(resolveEffortMapping('grok', 'medium')).toEqual({
				supported: true,
				agentId: 'grok',
				tier: 'medium',
				vendorParam: '--reasoning-effort',
				vendorValue: 'medium',
				args: ['--reasoning-effort', 'medium'],
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

	describe('unsupported agent handling (AC 5, E-254)', () => {
		it('returns unsupported for DeepSeek Harness without defaulting to any tier', () => {
			expect(isEffortSupported('dsh')).toBe(false);
			const result = resolveEffortMapping('dsh', 'high');
			expect(result.supported).toBe(false);
			if (!result.supported) {
				expect(result.reason).toContain('DeepSeek Harness');
			}
			expect(getEffortArgs('dsh', 'high')).toEqual([]);
		});

		it('returns unsupported for generic ACP and unknown agents without defaulting', () => {
			expect(isEffortSupported('generic-acp')).toBe(false);
			expect(resolveEffortMapping('generic-acp', 'medium').supported).toBe(false);
			expect(getEffortArgs('generic-acp', 'medium')).toEqual([]);

			expect(isEffortSupported('unknown-agent')).toBe(false);
			expect(resolveEffortMapping('unknown-agent', 'low').supported).toBe(false);
			expect(getEffortArgs('unknown-agent', 'low')).toEqual([]);
		});

		it('emits no CLI arguments when tier is null or undefined (E-254)', () => {
			expect(getEffortArgs('codex', null)).toEqual([]);
			expect(getEffortArgs('codex', undefined)).toEqual([]);
			expect(getEffortArgs('claude', null)).toEqual([]);
			expect(getEffortArgs('dsh', null)).toEqual([]);
		});
	});

	describe('reported effort comparison and mismatch reporting (AC 6, E-256)', () => {
		it('normalizes recognized vendor strings and token counts', () => {
			expect(normalizeReportedEffort('low')).toBe(EFFORT_TIERS.LOW);
			expect(normalizeReportedEffort('minimal')).toBe(EFFORT_TIERS.LOW);
			expect(normalizeReportedEffort('medium')).toBe(EFFORT_TIERS.MEDIUM);
			expect(normalizeReportedEffort('high')).toBe(EFFORT_TIERS.HIGH);
			expect(normalizeReportedEffort('xhigh')).toBe(EFFORT_TIERS.HIGH);
			expect(normalizeReportedEffort('max')).toBe(EFFORT_TIERS.HIGH);

			expect(normalizeReportedEffort('2048')).toBe(EFFORT_TIERS.LOW);
			expect(normalizeReportedEffort('8192')).toBe(EFFORT_TIERS.MEDIUM);
			expect(normalizeReportedEffort('16384')).toBe(EFFORT_TIERS.HIGH);

			expect(normalizeReportedEffort('custom-budget-42')).toBe('custom-budget-42');
			expect(normalizeReportedEffort(null)).toBeNull();
			expect(normalizeReportedEffort('')).toBeNull();
		});

		it('reports both values and detects mismatch without silently trusting either (E-256)', () => {
			const mismatch = compareSelectedAndReportedEffort('high', 'medium');
			expect(mismatch.isMismatch).toBe(true);
			expect(mismatch.selectedTier).toBe('high');
			expect(mismatch.reportedRaw).toBe('medium');
			expect(mismatch.reportedNormalized).toBe('medium');

			const matched = compareSelectedAndReportedEffort('high', 'high');
			expect(matched.isMismatch).toBe(false);
			expect(matched.selectedTier).toBe('high');
			expect(matched.reportedRaw).toBe('high');

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
