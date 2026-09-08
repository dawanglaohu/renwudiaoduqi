import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	EFFORT_TIERS,
	compareSelectedAndReportedEffort,
	isEffortSupported,
	isEffortTier,
	normalizeReportedEffort,
	resolveEffortMapping,
	resolveOptionalEffortMapping,
} from '../../src/domain/effort-tier.ts';

describe('effort tier domain', () => {
	it('accepts only the three product-level values', () => {
		expect(Object.values(EFFORT_TIERS)).toEqual(['low', 'medium', 'high']);
		for (const value of ['model_reasoning_effort', '--thinking', 'minimal', 'xhigh', 2048, null]) {
			expect(isEffortTier(value)).toBe(false);
		}
	});

	it('keeps the transport channel distinct for each verified vendor mapping', () => {
		expect(resolveEffortMapping('codex', 'medium')).toEqual({
			supported: true,
			agentId: 'codex',
			tier: 'medium',
			transport: {
				kind: 'argv',
				parameter: 'model_reasoning_effort',
				value: 'medium',
				args: ['-c', 'model_reasoning_effort="medium"'],
			},
		});
		expect(resolveEffortMapping('claude', 'low')).toEqual({
			supported: true,
			agentId: 'claude',
			tier: 'low',
			transport: { kind: 'env', variables: { MAX_THINKING_TOKENS: '2048' } },
		});
		expect(resolveEffortMapping('grok', 'high')).toMatchObject({
			supported: true,
			transport: { kind: 'argv', args: ['--reasoning-effort', 'high'] },
		});
		expect(resolveEffortMapping('pi', 'low')).toMatchObject({
			supported: true,
			transport: { kind: 'argv', args: ['--thinking', 'low'] },
		});
	});

	it('propagates an adapter or model capability probe instead of guessing from names', () => {
		const context = {
			model: 'future-model',
			agentVersion: '1.2.3',
			isSupported: false,
			unsupportedReason: 'probe reported no reasoning-effort capability',
		} as const;
		expect(isEffortSupported('codex', context)).toBe(false);
		expect(resolveEffortMapping('codex', 'high', context)).toEqual({
			supported: false,
			agentId: 'codex',
			tier: 'high',
			reason: 'probe reported no reasoning-effort capability',
		});
	});

	it('returns explicit unsupported results and emits nothing for a null stored tier', () => {
		for (const agentId of ['dsh', 'generic-acp', 'unknown-agent', 'constructor', '__proto__']) {
			expect(isEffortSupported(agentId)).toBe(false);
			expect(resolveEffortMapping(agentId, 'medium').supported).toBe(false);
		}
		expect(resolveOptionalEffortMapping('codex', null)).toBeNull();
		expect(resolveOptionalEffortMapping('dsh', undefined)).toBeNull();
	});

	it('reverse maps only exact values documented for the reporting agent', () => {
		expect(normalizeReportedEffort('minimal', { agentId: 'codex' })).toBe('low');
		expect(normalizeReportedEffort('max', { agentId: 'pi' })).toBe('high');
		expect(normalizeReportedEffort('2048', { agentId: 'claude' })).toBe('low');
		expect(normalizeReportedEffort('8192', { agentId: 'claude' })).toBe('medium');
		expect(normalizeReportedEffort('32768', { agentId: 'claude' })).toBe('high');
		for (const value of ['3000', '8193', 'Infinity', 'custom-budget-42']) {
			expect(normalizeReportedEffort(value, { agentId: 'claude' })).toBeNull();
		}
		expect(normalizeReportedEffort('2048', { agentId: 'codex' })).toBeNull();
	});

	it('preserves both selected and raw reported facts and highlights unknown mismatches', () => {
		expect(compareSelectedAndReportedEffort('high', ' medium ', { agentId: 'claude' })).toEqual({
			isMismatch: true,
			selectedTier: 'high',
			reportedRaw: ' medium ',
			reportedNormalized: 'medium',
		});
		expect(compareSelectedAndReportedEffort('medium', '3000', { agentId: 'claude' })).toEqual({
			isMismatch: true,
			selectedTier: 'medium',
			reportedRaw: '3000',
			reportedNormalized: null,
		});
		expect(compareSelectedAndReportedEffort('medium', '8192', { agentId: 'claude' })).toEqual({
			isMismatch: false,
			selectedTier: 'medium',
			reportedRaw: '8192',
			reportedNormalized: 'medium',
		});
		expect(compareSelectedAndReportedEffort('low', '   ', { agentId: 'codex' })).toEqual({
			isMismatch: false,
			selectedTier: 'low',
			reportedRaw: '   ',
			reportedNormalized: null,
		});
	});

	it('has no dependency on outer daemon layers', () => {
		const currentDir = dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(join(currentDir, '../../src/domain/effort-tier.ts'), 'utf8');
		expect(source).not.toMatch(/^import /mu);
	});
});
