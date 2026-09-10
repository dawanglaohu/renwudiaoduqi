import { describe, expect, it } from 'vitest';
import {
	CONCURRENCY_BOTTLENECKS,
	allocateConcurrencySlots,
	calculateBatchConcurrency,
	calculateConcurrencyLimit,
	canIncreaseWithoutUnlock,
	countActiveRunsForAgent,
	isConcurrencyBottleneck,
} from '../../src/domain/concurrency.ts';
import { isAppError } from '../../src/errors/app-error.ts';

describe('domain/concurrency (M8-T1)', () => {
	describe('AC 1 & E-52: Nominal concurrency calculation and bottleneck attribution', () => {
		it('calculates effective concurrency as min(windowCount, agentLimit, userSetting) when userSetting is bottleneck', () => {
			const result = calculateConcurrencyLimit({
				userSetting: 2,
				windowCount: 4,
				agentLimit: 3,
			});

			expect(result.effectiveConcurrency).toBe(2);
			expect(result.bottleneck).toBe(CONCURRENCY_BOTTLENECKS.USER_SETTING);
			expect(result.bottlenecks).toEqual([CONCURRENCY_BOTTLENECKS.USER_SETTING]);
			expect(result.userSetting).toBe(2);
			expect(result.isDegradedToSerial).toBe(false);
			expect(result.exceedsWindowCount).toBe(false);
		});

		it('calculates effective concurrency and identifies agent_limit as bottleneck', () => {
			const result = calculateConcurrencyLimit({
				userSetting: 4,
				windowCount: 4,
				agentLimit: 1,
			});

			expect(result.effectiveConcurrency).toBe(1);
			expect(result.bottleneck).toBe(CONCURRENCY_BOTTLENECKS.AGENT_LIMIT);
			expect(result.bottlenecks).toEqual([CONCURRENCY_BOTTLENECKS.AGENT_LIMIT]);
			expect(result.isDegradedToSerial).toBe(true);
		});

		it('calculates effective concurrency and identifies window_count as bottleneck', () => {
			const result = calculateConcurrencyLimit({
				userSetting: 4,
				windowCount: 2,
				agentLimit: 3,
			});

			expect(result.effectiveConcurrency).toBe(2);
			expect(result.bottleneck).toBe(CONCURRENCY_BOTTLENECKS.WINDOW_COUNT);
			expect(result.bottlenecks).toEqual([CONCURRENCY_BOTTLENECKS.WINDOW_COUNT]);
			expect(result.exceedsWindowCount).toBe(true);
		});

		it('records all tied factors in bottlenecks when multiple values equal the minimum', () => {
			const result = calculateConcurrencyLimit({
				userSetting: 2,
				windowCount: 2,
				agentLimit: 2,
			});

			expect(result.effectiveConcurrency).toBe(2);
			expect(result.bottlenecks).toContain(CONCURRENCY_BOTTLENECKS.USER_SETTING);
			expect(result.bottlenecks).toContain(CONCURRENCY_BOTTLENECKS.WINDOW_COUNT);
			expect(result.bottlenecks).toContain(CONCURRENCY_BOTTLENECKS.AGENT_LIMIT);
			expect(isConcurrencyBottleneck(result.bottleneck)).toBe(true);
		});

		it('indicates exceedsWindowCount when userSetting exceeds windowCount (E-52 explicit unlock rule)', () => {
			const result = calculateConcurrencyLimit({
				userSetting: 5,
				windowCount: 2,
				agentLimit: 4,
			});

			expect(result.exceedsWindowCount).toBe(true);
			expect(canIncreaseWithoutUnlock(5, 2)).toBe(false);
			expect(canIncreaseWithoutUnlock(1, 2)).toBe(true);
		});
	});

	describe('AC 2 & E-47: Ceding open slots when single agent reaches limit', () => {
		it('cedes open window slots to other agents when one agent is saturated without blocking or spinning', () => {
			const candidates = [
				{ id: 'task-1', agentId: 'codex' },
				{ id: 'task-2', agentId: 'codex' },
				{ id: 'task-3', agentId: 'claude' },
				{ id: 'task-4', agentId: 'codex' },
				{ id: 'task-5', agentId: 'pi' },
			];

			const allocation = allocateConcurrencySlots({
				candidates,
				availableSlots: 3,
				agentLimits: {
					codex: 1,
					claude: 1,
					pi: 2,
				},
				activeRunsByAgent: {
					codex: 0,
					claude: 0,
					pi: 0,
				},
			});

			// Task 1 takes Codex's 1 slot
			// Task 2 skipped (Codex full), slot given to Task 3 (Claude)
			// Task 4 skipped (Codex full), slot given to Task 5 (Pi)
			expect(allocation.admitted.map((t) => t.id)).toEqual(['task-1', 'task-3', 'task-5']);
			expect(allocation.remainingSlots).toBe(0);
			expect(allocation.allocatedByAgent).toEqual({
				codex: 1,
				claude: 1,
				pi: 1,
			});

			// Verify deferred tasks and reasons
			expect(allocation.deferred).toHaveLength(2);
			expect(allocation.deferred[0]).toEqual({
				task: candidates[1],
				reason: 'agent_limit_reached',
				agentId: 'codex',
			});
			expect(allocation.deferred[1]).toEqual({
				task: candidates[3],
				reason: 'agent_limit_reached',
				agentId: 'codex',
			});
		});

		it('cedes slots to other agents when an agent was already full from active runs', () => {
			const candidates = [
				{ id: 'task-10', agentId: 'codex' },
				{ id: 'task-11', agentId: 'claude' },
			];

			const allocation = allocateConcurrencySlots({
				candidates,
				availableSlots: 1,
				agentLimits: {
					codex: 1,
					claude: 1,
				},
				activeRunsByAgent: {
					codex: 1, // Codex already at capacity
					claude: 0,
				},
			});

			expect(allocation.admitted.map((t) => t.id)).toEqual(['task-11']);
			expect(allocation.deferred[0]?.reason).toBe('agent_limit_reached');
			expect(allocation.deferred[0]?.agentId).toBe('codex');
		});

		it('marks remaining candidates as window_exhausted when available window slots run out', () => {
			const candidates = [
				{ id: 'task-a', agentId: 'claude' },
				{ id: 'task-b', agentId: 'pi' },
				{ id: 'task-c', agentId: 'grok' },
			];

			const allocation = allocateConcurrencySlots({
				candidates,
				availableSlots: 1,
				agentLimits: { claude: 2, pi: 2, grok: 2 },
			});

			expect(allocation.admitted.map((t) => t.id)).toEqual(['task-a']);
			expect(allocation.deferred).toEqual([
				{ task: candidates[1], reason: 'window_exhausted', agentId: 'pi' },
				{ task: candidates[2], reason: 'window_exhausted', agentId: 'grok' },
			]);
		});

		it('supports functional lookups for agent limits and active runs', () => {
			const candidates = [
				{ id: 't-1', agentId: 'dynamic-agent' },
				{ id: 't-2', agentId: 'dynamic-agent' },
			];

			const allocation = allocateConcurrencySlots({
				candidates,
				availableSlots: 2,
				agentLimits: (id) => (id === 'dynamic-agent' ? 1 : 2),
				activeRunsByAgent: () => 0,
			});

			expect(allocation.admitted.map((t) => t.id)).toEqual(['t-1']);
			expect(allocation.deferred[0]?.reason).toBe('agent_limit_reached');
		});
	});

	describe('AC 3 & E-48: Serial execution degradation without errors', () => {
		it('degrades to sequential dispatch when windowCount is 1 without error or warning', () => {
			const result = calculateConcurrencyLimit({
				userSetting: 4,
				windowCount: 1,
				agentLimit: 4,
			});

			expect(result.effectiveConcurrency).toBe(1);
			expect(result.isDegradedToSerial).toBe(true);
			expect(result.bottleneck).toBe(CONCURRENCY_BOTTLENECKS.WINDOW_COUNT);
		});

		it('admits one candidate at a time when availableSlots is 1 without error', () => {
			const candidates = [
				{ id: 'seq-1', agentId: 'codex' },
				{ id: 'seq-2', agentId: 'codex' },
			];

			const allocation = allocateConcurrencySlots({
				candidates,
				availableSlots: 1,
				agentLimits: { codex: 2 },
			});

			expect(allocation.admitted).toHaveLength(1);
			expect(allocation.admitted[0]?.id).toBe('seq-1');
			expect(allocation.deferred[0]?.reason).toBe('window_exhausted');
		});

		it('handles windowCount = 0 safely and reports 0 effective concurrency without error', () => {
			const result = calculateConcurrencyLimit({
				userSetting: 2,
				windowCount: 0,
				agentLimit: 2,
			});

			expect(result.effectiveConcurrency).toBe(0);
			expect(result.isDegradedToSerial).toBe(true);
			expect(result.bottleneck).toBe(CONCURRENCY_BOTTLENECKS.WINDOW_COUNT);
		});
	});

	describe('AC 5 & E-245: Machine resources, path conflicts, and user setting preservation', () => {
		it('E-245: limits concurrency to machine capacity and preserves userSetting without silent rewrite', () => {
			const result = calculateConcurrencyLimit({
				userSetting: 6,
				windowCount: 6,
				agentLimit: 4,
				machineResource: 2,
			});

			expect(result.effectiveConcurrency).toBe(2);
			expect(result.bottleneck).toBe(CONCURRENCY_BOTTLENECKS.MACHINE_RESOURCE);
			expect(result.bottlenecks).toEqual([CONCURRENCY_BOTTLENECKS.MACHINE_RESOURCE]);
			// Setting value is NEVER mutated by runtime
			expect(result.userSetting).toBe(6);
			expect(result.factors.userSetting).toBe(6);
			expect(result.factors.machineResource).toBe(2);
		});

		it('limits concurrency by pathConflictLimit when path conflicts constrain execution', () => {
			const result = calculateConcurrencyLimit({
				userSetting: 4,
				windowCount: 4,
				agentLimit: 4,
				machineResource: 3,
				pathConflictLimit: 1,
			});

			expect(result.effectiveConcurrency).toBe(1);
			expect(result.bottleneck).toBe(CONCURRENCY_BOTTLENECKS.PATH_CONFLICT);
			expect(result.bottlenecks).toEqual([CONCURRENCY_BOTTLENECKS.PATH_CONFLICT]);
			expect(result.userSetting).toBe(4);
			expect(result.isDegradedToSerial).toBe(true);
		});

		it('prefers physical constraints in tie-breaking order', () => {
			const result = calculateConcurrencyLimit({
				userSetting: 2,
				windowCount: 2,
				agentLimit: 2,
				machineResource: 2,
				pathConflictLimit: 2,
			});

			expect(result.effectiveConcurrency).toBe(2);
			expect(result.bottlenecks).toHaveLength(5);
			expect(result.bottleneck).toBe(CONCURRENCY_BOTTLENECKS.PATH_CONFLICT);
		});
	});

	describe('Batch concurrency calculation with multi-agent assignments', () => {
		it('computes aggregate agent capacity and identifies agent_limit when all tasks use codex (limit 1)', () => {
			const assignments = [
				{ taskId: 'm8-t1', agentId: 'codex' },
				{ taskId: 'm8-t2', agentId: 'codex' },
				{ taskId: 'm8-t3', agentId: 'codex' },
			];

			const result = calculateBatchConcurrency({
				userSetting: 3,
				windowCount: 3,
				assignments,
				agentLimits: { codex: 1 },
			});

			expect(result.aggregateAgentCapacity).toBe(1);
			expect(result.effectiveConcurrency).toBe(1);
			expect(result.bottleneck).toBe(CONCURRENCY_BOTTLENECKS.AGENT_LIMIT);
			expect(result.agentCapacities.codex).toEqual({
				assignedCount: 3,
				maxConcurrency: 1,
				effectiveLimit: 1,
			});
		});

		it('computes aggregate agent capacity across diverse agents allowing full window utilization', () => {
			const assignments = [
				{ taskId: 't-1', agentId: 'codex' },
				{ taskId: 't-2', agentId: 'claude' },
				{ taskId: 't-3', agentId: 'pi' },
			];

			const result = calculateBatchConcurrency({
				userSetting: 3,
				windowCount: 3,
				assignments,
				agentLimits: { codex: 1, claude: 1, pi: 1 },
			});

			expect(result.aggregateAgentCapacity).toBe(3);
			expect(result.effectiveConcurrency).toBe(3);
			expect(result.agentCapacities.codex?.effectiveLimit).toBe(1);
			expect(result.agentCapacities.claude?.effectiveLimit).toBe(1);
			expect(result.agentCapacities.pi?.effectiveLimit).toBe(1);
		});
	});

	describe('Active runs filtering and counting helper', () => {
		it('excludes awaiting_human, orphaned, and terminal states while counting active runs (E-54, E-115)', () => {
			const states = [
				'running',
				'starting',
				'awaiting_reply', // counts per E-115
				'awaiting_human', // does NOT count per E-54
				'orphaned', // does NOT count
				'landed', // terminal, does NOT count
				'failed', // terminal, does NOT count
				'reviewing',
			];

			const count = countActiveRunsForAgent(states);
			expect(count).toBe(4); // running, starting, awaiting_reply, reviewing
		});
	});

	describe('Input validation with AppError(E_VALIDATION)', () => {
		it('rejects invalid userSetting', () => {
			expect(() =>
				calculateConcurrencyLimit({
					userSetting: 0,
					windowCount: 2,
					agentLimit: 2,
				}),
			).toThrowError();

			try {
				calculateConcurrencyLimit({
					userSetting: -1,
					windowCount: 2,
					agentLimit: 2,
				});
			} catch (err) {
				expect(isAppError(err)).toBe(true);
				if (isAppError(err)) {
					expect(err.code).toBe('E_VALIDATION');
				}
			}
		});

		it('rejects negative windowCount or agentLimit', () => {
			expect(() =>
				calculateConcurrencyLimit({
					userSetting: 2,
					windowCount: -1,
					agentLimit: 2,
				}),
			).toThrowError();

			expect(() =>
				calculateConcurrencyLimit({
					userSetting: 2,
					windowCount: 2,
					agentLimit: 0,
				}),
			).toThrowError();
		});

		it('rejects invalid machineResource or pathConflictLimit', () => {
			expect(() =>
				calculateConcurrencyLimit({
					userSetting: 2,
					windowCount: 2,
					agentLimit: 2,
					machineResource: -1,
				}),
			).toThrowError();

			expect(() =>
				calculateConcurrencyLimit({
					userSetting: 2,
					windowCount: 2,
					agentLimit: 2,
					pathConflictLimit: -5,
				}),
			).toThrowError();
		});
	});
});
