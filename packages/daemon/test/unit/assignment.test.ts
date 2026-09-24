import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	type AgentDefaultInfo,
	type AgentDefaultsLookup,
	type TaskAssignmentValue,
	resolveAssignment,
} from '../../src/domain/assignment.ts';

const mockAgentDefaults = (agentId: string): AgentDefaultInfo | null => {
	switch (agentId) {
		case 'codex':
			return {
				agentId: 'codex',
				defaultModel: 'gpt-5-codex',
				defaultEffortTier: { tier: 'medium' },
				effortVendorMap: { low: 'low', medium: 'medium', high: 'high' },
			};
		case 'claude':
			return {
				agentId: 'claude',
				defaultModel: 'claude-3-7-sonnet',
				defaultEffortTier: null,
				effortVendorMap: { low: '2048', medium: '8192', high: '32768' },
			};
		case 'dsh':
			return {
				agentId: 'dsh',
				defaultModel: 'deepseek-chat',
				defaultEffortTier: null,
				effortVendorMap: null, // does not support effort
			};
		default:
			return null;
	}
};

describe('domain/assignment (AC 1, AC 3, E-341, E-342, E-344, E-347, E-93)', () => {
	// Case 1: implement body 全给 → task
	it('1. implement stage: when body supplies both model and effort, source is "task"', () => {
		const result = resolveAssignment({
			stage: 'implement',
			body: {
				agentId: 'codex',
				model: 'custom-model',
				effort: { tier: 'high' },
			},
			agentDefaults: mockAgentDefaults,
		});

		expect(result).toEqual({
			success: true,
			agentId: 'codex',
			modelName: 'custom-model',
			effortTier: 'high',
			effortVendor: null,
			source: 'task',
			followedTaskId: null,
			warnings: [],
		});
	});

	// Case 2: implement 只给 agent → agent_default
	it('2. implement stage: when body only gives agentId, both model and effort fall back to agent_default', () => {
		const result = resolveAssignment({
			stage: 'implement',
			body: {
				agentId: 'codex',
			},
			agentDefaults: mockAgentDefaults,
		});

		expect(result).toEqual({
			success: true,
			agentId: 'codex',
			modelName: 'gpt-5-codex',
			effortTier: 'medium',
			effortVendor: null,
			source: 'agent_default',
			followedTaskId: null,
			warnings: [],
		});
	});

	// Case 3: review 无覆盖逐字
	it('3. review stage: with no reviewOverride, verbatim copies task assignment with source "task"', () => {
		const taskAssignment: TaskAssignmentValue = {
			agentId: 'codex',
			modelName: 'gpt-5-codex',
			effortTier: 'high',
			effortVendor: null,
			source: 'task',
			followedTaskId: null,
		};

		const result = resolveAssignment({
			stage: 'review',
			taskAssignment,
			reviewOverride: null,
			agentDefaults: mockAgentDefaults,
		});

		expect(result).toEqual({
			success: true,
			agentId: 'codex',
			modelName: 'gpt-5-codex',
			effortTier: 'high',
			effortVendor: null,
			source: 'task',
			followedTaskId: null,
			warnings: [],
		});
	});

	// Case 4: review 同家覆盖只给 agentId → 沿用任务 model/effort、source:'review_override'
	it('4. review stage: same family override giving only agentId inherits task model and effort with source "review_override"', () => {
		const taskAssignment: TaskAssignmentValue = {
			agentId: 'codex',
			modelName: 'gpt-5-codex',
			effortTier: 'high',
			effortVendor: null,
			source: 'task',
		};

		const result = resolveAssignment({
			stage: 'review',
			taskAssignment,
			reviewOverride: {
				agentId: 'codex',
			},
			agentDefaults: mockAgentDefaults,
		});

		expect(result).toEqual({
			success: true,
			agentId: 'codex',
			modelName: 'gpt-5-codex',
			effortTier: 'high',
			effortVendor: null,
			source: 'review_override',
			followedTaskId: null,
			warnings: [],
		});
	});

	// Case 5: review 跨家覆盖（codex→claude）任务 effort {tier:'high'} → {tier:'high'}（三档跨家保留）+ model null + model_dropped_cross_family
	it('5. review stage: cross-family override preserves tier, sets model to null with model_dropped_cross_family warning', () => {
		const taskAssignment: TaskAssignmentValue = {
			agentId: 'codex',
			modelName: 'gpt-5-codex',
			effortTier: 'high',
			effortVendor: null,
			source: 'task',
		};

		const result = resolveAssignment({
			stage: 'review',
			taskAssignment,
			reviewOverride: {
				agentId: 'claude',
			},
			agentDefaults: mockAgentDefaults,
		});

		expect(result).toEqual({
			success: true,
			agentId: 'claude',
			modelName: null,
			effortTier: 'high',
			effortVendor: null,
			source: 'review_override',
			followedTaskId: null,
			warnings: ['model_dropped_cross_family'],
		});
	});

	// Case 6: review 跨家 {vendor:'xhigh'}（不在 codex 出厂 map 值域）→ null + effort_unmappable，{vendor:'medium'} 反查命中 → {tier:'medium'}
	it('6. review stage: cross-family remapping vendor values: unmappable vendor yields null + effort_unmappable; matching reverse lookup yields mapped tier', () => {
		// 6a: { vendor: 'xhigh' } not in codex map
		const unmappableTask: TaskAssignmentValue = {
			agentId: 'codex',
			modelName: 'gpt-5-codex',
			effortTier: null,
			effortVendor: 'xhigh',
			source: 'task',
		};

		const resultUnmappable = resolveAssignment({
			stage: 'review',
			taskAssignment: unmappableTask,
			reviewOverride: {
				agentId: 'claude',
			},
			agentDefaults: mockAgentDefaults,
		});

		expect(resultUnmappable).toEqual({
			success: true,
			agentId: 'claude',
			modelName: null,
			effortTier: null,
			effortVendor: null,
			source: 'review_override',
			followedTaskId: null,
			warnings: ['model_dropped_cross_family', 'effort_unmappable'],
		});

		// 6b: { vendor: 'medium' } reverses to tier 'medium'
		const mappableTask: TaskAssignmentValue = {
			agentId: 'codex',
			modelName: 'gpt-5-codex',
			effortTier: null,
			effortVendor: 'medium',
			source: 'task',
		};

		const resultMappable = resolveAssignment({
			stage: 'review',
			taskAssignment: mappableTask,
			reviewOverride: {
				agentId: 'claude',
			},
			agentDefaults: mockAgentDefaults,
		});

		expect(resultMappable).toEqual({
			success: true,
			agentId: 'claude',
			modelName: null,
			effortTier: 'medium',
			effortVendor: null,
			source: 'review_override',
			followedTaskId: null,
			warnings: ['model_dropped_cross_family'],
		});
	});

	// Case 7: review 覆盖到 dsh → effort null
	it('7. review stage: overriding to agent with no effort support (dsh) results in effort null + effort_unmappable', () => {
		const taskAssignment: TaskAssignmentValue = {
			agentId: 'codex',
			modelName: 'gpt-5-codex',
			effortTier: 'high',
			effortVendor: null,
			source: 'task',
		};

		const result = resolveAssignment({
			stage: 'review',
			taskAssignment,
			reviewOverride: {
				agentId: 'dsh',
			},
			agentDefaults: mockAgentDefaults,
		});

		expect(result).toEqual({
			success: true,
			agentId: 'dsh',
			modelName: null,
			effortTier: null,
			effortVendor: null,
			source: 'review_override',
			followedTaskId: null,
			warnings: ['model_dropped_cross_family', 'effort_unmappable'],
		});
	});

	// Case 8: rework / bughunt / wrapup-fix 三例输出 === 输入且传入的 stageOverride / manualOverride 被忽略
	it('8. rework, bughunt, wrapup-fix stages: output === input (identity) and overrides are strictly ignored', () => {
		const taskAssignment: TaskAssignmentValue = Object.freeze({
			agentId: 'codex',
			modelName: 'gpt-5-codex',
			effortTier: 'high',
			effortVendor: null,
			source: 'task',
			followedTaskId: null,
		});

		const reworkResult = resolveAssignment({
			stage: 'rework',
			taskAssignment,
			stageOverride: { agentId: 'claude' },
			manualOverride: { model: 'other' },
			agentDefaults: mockAgentDefaults,
		});
		expect(reworkResult).toBe(taskAssignment);

		const bughuntResult = resolveAssignment({
			stage: 'bughunt',
			taskAssignment,
			stageOverride: { agentId: 'claude' },
			manualOverride: { model: 'other' },
			agentDefaults: mockAgentDefaults,
		});
		expect(bughuntResult).toBe(taskAssignment);

		const wrapupFixResult = resolveAssignment({
			stage: 'wrapup-fix',
			taskAssignment,
			stageOverride: { agentId: 'claude' },
			manualOverride: { model: 'other' },
			agentDefaults: mockAgentDefaults,
		});
		expect(wrapupFixResult).toBe(taskAssignment);
	});

	// Case 9: wrapup follow → followedTaskId
	it('9. wrapup stage: follow mode returns followedTaskId from followed landed implementation run', () => {
		const result = resolveAssignment({
			stage: 'wrapup',
			wrapupSettings: { mode: 'follow' },
			followAssignment: {
				taskId: 'task-123',
				assignment: {
					agentId: 'codex',
					modelName: 'gpt-5-codex',
					effortTier: 'medium',
					effortVendor: null,
				},
			},
			agentDefaults: mockAgentDefaults,
		});

		expect(result).toEqual({
			success: true,
			agentId: 'codex',
			modelName: 'gpt-5-codex',
			effortTier: 'medium',
			effortVendor: null,
			source: 'wrapup_settings',
			followedTaskId: 'task-123',
			warnings: [],
		});
	});

	// Case 10: fixed 只给 agentId 回落 follow 值
	it('10. wrapup stage: fixed mode with only agentId falls back to follow values (model & effort)', () => {
		const result = resolveAssignment({
			stage: 'wrapup',
			wrapupSettings: {
				mode: 'fixed',
				agentId: 'codex',
			},
			followAssignment: {
				taskId: 'task-123',
				assignment: {
					agentId: 'codex',
					modelName: 'gpt-5-codex',
					effortTier: 'high',
					effortVendor: null,
				},
			},
			agentDefaults: mockAgentDefaults,
		});

		expect(result).toEqual({
			success: true,
			agentId: 'codex',
			modelName: 'gpt-5-codex',
			effortTier: 'high',
			effortVendor: null,
			source: 'wrapup_settings',
			followedTaskId: 'task-123',
			warnings: [],
		});
	});

	// Case 11: wrapup follow 且 followAssignment:null → follow_source_missing
	it('11. wrapup stage: follow mode with null followAssignment returns failure follow_source_missing', () => {
		const result = resolveAssignment({
			stage: 'wrapup',
			wrapupSettings: { mode: 'follow' },
			followAssignment: null,
			agentDefaults: mockAgentDefaults,
		});

		expect(result).toEqual({
			success: false,
			agentId: '',
			modelName: null,
			effortTier: null,
			effortVendor: null,
			source: 'wrapup_settings',
			followedTaskId: null,
			warnings: [],
			failureReason: 'follow_source_missing',
		});
	});

	// Case 12: manual body 优先
	it('12. wrapup stage: manual body override takes highest priority over fixed or follow', () => {
		const result = resolveAssignment({
			stage: 'wrapup',
			body: {
				agentId: 'claude',
				model: 'claude-3-7-sonnet',
				effortTier: 'high',
			},
			wrapupSettings: { mode: 'fixed', agentId: 'codex' },
			followAssignment: {
				taskId: 'task-123',
				assignment: {
					agentId: 'codex',
					modelName: 'gpt-5-codex',
					effortTier: 'medium',
				},
			},
			agentDefaults: mockAgentDefaults,
		});

		expect(result).toEqual({
			success: true,
			agentId: 'claude',
			modelName: 'claude-3-7-sonnet',
			effortTier: 'high',
			effortVendor: null,
			source: 'wrapup_settings',
			followedTaskId: null,
			warnings: [],
		});
	});

	// Case 13 (Bonus from E-93): 改 agentDefaults 不影响 review / rework / bughunt / wrapup-fix 输出
	it('13. E-93 guarantee: modifying agentDefaults does not affect review, rework, bughunt, or wrapup-fix outputs', () => {
		const taskAssignment: TaskAssignmentValue = Object.freeze({
			agentId: 'codex',
			modelName: 'snapshot-model',
			effortTier: 'medium',
			effortVendor: null,
			source: 'task',
			followedTaskId: null,
		});

		const alteredDefaults: AgentDefaultsLookup = () => ({
			agentId: 'codex',
			defaultModel: 'altered-model',
			defaultEffortTier: { tier: 'high' },
		});

		// Review without override
		const reviewRes = resolveAssignment({
			stage: 'review',
			taskAssignment,
			reviewOverride: null,
			agentDefaults: alteredDefaults,
		});
		expect(reviewRes.modelName).toBe('snapshot-model');
		expect(reviewRes.effortTier).toBe('medium');

		// Rework
		const reworkRes = resolveAssignment({
			stage: 'rework',
			taskAssignment,
			agentDefaults: alteredDefaults,
		});
		expect(reworkRes).toBe(taskAssignment);

		// Bughunt
		const bughuntRes = resolveAssignment({
			stage: 'bughunt',
			taskAssignment,
			agentDefaults: alteredDefaults,
		});
		expect(bughuntRes).toBe(taskAssignment);

		// Wrapup-fix
		const wrapupFixRes = resolveAssignment({
			stage: 'wrapup-fix',
			taskAssignment,
			agentDefaults: alteredDefaults,
		});
		expect(wrapupFixRes).toBe(taskAssignment);
	});

	// Case 14 (AC 2 Architecture Assertion): assignment_json literal is strictly isolated
	it('14. AC 2 architecture assertion: assignment_json literal only appears in repo/dispatch-snapshots.ts and service/assignment-reader.ts', () => {
		const currentFile = fileURLToPath(import.meta.url);
		const srcDir = resolve(dirname(currentFile), '../../src');
		const files: string[] = [];

		function scanDir(dir: string) {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					scanDir(full);
				} else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
					files.push(full);
				}
			}
		}
		scanDir(srcDir);

		const allowedFiles = new Set([
			resolve(srcDir, 'repo/dispatch-snapshots.ts'),
			resolve(srcDir, 'service/assignment-reader.ts'),
		]);

		const violatingFiles: string[] = [];
		for (const file of files) {
			const content = readFileSync(file, 'utf8');
			if (content.includes('assignment_json') && !allowedFiles.has(file)) {
				violatingFiles.push(file);
			}
		}

		expect(violatingFiles).toEqual([]);
	});
});
