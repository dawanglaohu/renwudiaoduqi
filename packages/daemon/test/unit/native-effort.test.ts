import { describe, expect, it } from 'vitest';
import { buildClaudeLaunchSpec } from '../../src/adapters/claude/build-launch-spec.ts';
import { buildCodexLaunchSpec } from '../../src/adapters/codex/build-launch-spec.ts';
import { buildGrokLaunchSpec } from '../../src/adapters/grok/build-launch-spec.ts';
import { buildPiLaunchSpec } from '../../src/adapters/pi/build-launch-spec.ts';
import {
	nativeEffortOptions,
	parseClaudeEffortOptions,
} from '../../src/domain/agent-effort-options.ts';
import { resolveAssignment } from '../../src/domain/assignment.ts';
import {
	isValidReviewOverride,
	isValidWrapupAssignment,
} from '../../src/domain/pipeline-settings.ts';
import { buildReviewLaunchSpec } from '../../src/service/review-agent.ts';

describe('native reasoning effort reaches the CLI', () => {
	it('accepts and resolves native effort in review and fixed wrapup settings', () => {
		const override = { agentId: 'codex', effortVendor: 'ultra' };
		const fixed = { ...override, mode: 'fixed' as const };
		expect(isValidReviewOverride(override)).toBe(true);
		expect(isValidWrapupAssignment(fixed)).toBe(true);
		const source = { agentId: 'codex', modelName: 'gpt-6.1-sol', effortTier: 'medium' as const };
		expect(
			resolveAssignment({ stage: 'review', taskAssignment: source, reviewOverride: override }),
		).toMatchObject({ effortTier: null, effortVendor: 'ultra' });
		expect(resolveAssignment({ stage: 'wrapup', wrapupSettings: fixed })).toMatchObject({
			effortTier: null,
			effortVendor: 'ultra',
		});
		expect(isValidReviewOverride({ ...override, effortTier: 'high' })).toBe(false);
	});

	it.each(['app-server', 'exec'] as const)('passes Codex ultra through %s', (mode) => {
		const options = { runId: 'effort', cwd: '/workspace', effortVendor: 'ultra', mode };
		expect(buildCodexLaunchSpec(options).args).toContain('model_reasoning_effort="ultra"');
	});

	it('uses Claude named effort for a tier and a native level', () => {
		const base = {
			runId: 'effort',
			cwd: '/workspace',
			effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
		};
		expect(buildClaudeLaunchSpec({ ...base, effortTier: 'high' }).args).toEqual(
			expect.arrayContaining(['--effort', 'high']),
		);
		const options = { ...base, effortVendor: 'max' };
		expect(buildClaudeLaunchSpec(options).args).toEqual(
			expect.arrayContaining(['--effort', 'max']),
		);
	});

	it.each([[], undefined])(
		'preserves legacy Claude budgets without named capability %s',
		(effortOptions) => {
			const spec = buildClaudeLaunchSpec({
				runId: 'legacy',
				cwd: '/workspace',
				effortTier: 'high',
				effortOptions,
			});
			expect(spec.args).not.toContain('--effort');
			expect(spec.envOverrides).toMatchObject({ MAX_THINKING_TOKENS: '32768' });
			const native = buildClaudeLaunchSpec({
				runId: 'legacy',
				cwd: '/workspace',
				effortVendor: 'max',
				effortOptions,
			});
			expect(native.args).not.toContain('--effort');
			expect(native.envOverrides).not.toHaveProperty('MAX_THINKING_TOKENS');
			expect(
				nativeEffortOptions(
					'claude',
					{ effortVendorMap: { low: 'low', medium: 'medium', high: 'high' } },
					effortOptions,
				),
			).toEqual([]);
		},
	);

	it('passes detected Claude capability to the review launch', () => {
		const spec = buildReviewLaunchSpec({
			runId: 'legacy-review',
			taskId: 'task-1',
			worktreePath: '/workspace',
			effortOptions: [],
			assignment: { agentId: 'claude', modelName: 'sonnet', effortTier: 'medium' },
			prompt: 'Review',
		});
		expect(spec.args).not.toContain('--effort');
		expect(spec.envOverrides).toMatchObject({ MAX_THINKING_TOKENS: '8192' });
	});

	it('uses the probed Claude executable and native options for a modern review', () => {
		const spec = buildReviewLaunchSpec({
			runId: 'native-review',
			taskId: 'task-1',
			worktreePath: '/workspace',
			execPath: '/opt/custom-claude',
			effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
			assignment: { agentId: 'claude', modelName: 'opus', effortTier: null, effortVendor: 'max' },
			prompt: 'Review',
		});
		expect(spec.file).toBe('/opt/custom-claude');
		expect(spec.args).toEqual(expect.arrayContaining(['--effort', 'max']));
	});

	it('reads only Claude effort choices advertised by its help flag', () => {
		expect(
			parseClaudeEffortOptions(
				'  --effort <level>  Effort for this session\n                      (low, medium, high, max)\n  --model <model>  Model',
			),
		).toEqual(['low', 'medium', 'high', 'max']);
		expect(parseClaudeEffortOptions('  --model <model>  Use max effort')).toEqual([]);
		expect(parseClaudeEffortOptions('  --effort <level>  Effort for this session')).toEqual([]);
	});

	it('passes Grok xhigh and Pi off without replacing them with a three-level tier', () => {
		const grok = { runId: 'effort', cwd: '/workspace', execPath: 'grok', effortVendor: 'xhigh' };
		const pi = { runId: 'effort', cwd: '/workspace', effortVendor: 'off' };
		expect(buildGrokLaunchSpec(grok).args).toEqual(
			expect.arrayContaining(['--reasoning-effort', 'xhigh']),
		);
		expect(buildPiLaunchSpec(pi).args).toEqual(expect.arrayContaining(['--thinking', 'off']));
	});

	it('retains the implementation native effort when building a review launch', () => {
		const spec = buildReviewLaunchSpec({
			runId: 'review',
			taskId: 'task-1',
			worktreePath: '/workspace',
			assignment: {
				agentId: 'codex',
				modelName: 'gpt-6.1-sol',
				effortTier: null,
				effortVendor: 'max',
			},
			prompt: 'Review the change',
		});
		expect(spec.args).toContain('model_reasoning_effort="max"');
	});
});
