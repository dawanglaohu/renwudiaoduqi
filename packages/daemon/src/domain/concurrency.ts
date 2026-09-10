import { AppError } from '../errors/app-error.ts';
import { type RunState, countsTowardAgentConcurrency } from './run-state-machine.ts';

/**
 * Concurrency bottleneck categories (E-52, E-245).
 */
export const CONCURRENCY_BOTTLENECKS = {
	USER_SETTING: 'user_setting',
	WINDOW_COUNT: 'window_count',
	AGENT_LIMIT: 'agent_limit',
	MACHINE_RESOURCE: 'machine_resource',
	PATH_CONFLICT: 'path_conflict',
} as const;

export type ConcurrencyBottleneck =
	(typeof CONCURRENCY_BOTTLENECKS)[keyof typeof CONCURRENCY_BOTTLENECKS];

export const CONCURRENCY_BOTTLENECK_LIST: readonly ConcurrencyBottleneck[] = Object.freeze([
	CONCURRENCY_BOTTLENECKS.USER_SETTING,
	CONCURRENCY_BOTTLENECKS.WINDOW_COUNT,
	CONCURRENCY_BOTTLENECKS.AGENT_LIMIT,
	CONCURRENCY_BOTTLENECKS.MACHINE_RESOURCE,
	CONCURRENCY_BOTTLENECKS.PATH_CONFLICT,
]);

/**
 * Validates whether a value is a recognised ConcurrencyBottleneck.
 */
export function isConcurrencyBottleneck(value: unknown): value is ConcurrencyBottleneck {
	return (
		typeof value === 'string' && (CONCURRENCY_BOTTLENECK_LIST as readonly string[]).includes(value)
	);
}

/**
 * Breakdown of numerical limits contributing to the concurrency calculation.
 */
export interface ConcurrencyFactorBreakdown {
	readonly userSetting: number;
	readonly windowCount: number;
	readonly agentLimit: number;
	readonly machineResource?: number;
	readonly pathConflictLimit?: number;
}

/**
 * Input for calculating nominal concurrency limit and bottleneck attribution (E-52, E-245).
 */
export interface ConcurrencyInputs {
	/**
	 * User configured concurrency / lane count (e.g. 1-6).
	 * Acts as an upper bound and is never mutated by the runtime (E-245).
	 */
	readonly userSetting: number;

	/**
	 * Parallel window count derived from dependencies / batch (E-48, E-52).
	 * Serial dependency chains or single-task batches evaluate to 1.
	 */
	readonly windowCount: number;

	/**
	 * Per-agent concurrency limit (M4-T1, E-47, E-52).
	 */
	readonly agentLimit: number;

	/**
	 * Machine resource capacity constraint (E-245).
	 */
	readonly machineResource?: number;

	/**
	 * Available concurrency bound imposed by non-conflicting task paths (E-245).
	 */
	readonly pathConflictLimit?: number;
}

/**
 * Result of the concurrency calculation.
 */
export interface ConcurrencyResult {
	/**
	 * Actual effective concurrency allowed:
	 * min(userSetting, windowCount, agentLimit, machineResource?, pathConflictLimit?)
	 */
	readonly effectiveConcurrency: number;

	/**
	 * Primary bottleneck identifier causing the limitation.
	 */
	readonly bottleneck: ConcurrencyBottleneck;

	/**
	 * All bottleneck identifiers that tie for the minimum limiting factor.
	 */
	readonly bottlenecks: readonly ConcurrencyBottleneck[];

	/**
	 * The user setting value, preserved untouched without silent runtime mutation (E-245).
	 */
	readonly userSetting: number;

	/**
	 * True if effective concurrency is <= 1 or windowCount <= 1 (E-48).
	 * Degrades gracefully to sequential dispatch without error or "cannot parallelize" warning.
	 */
	readonly isDegradedToSerial: boolean;

	/**
	 * True if userSetting strictly exceeds windowCount.
	 * Helps UI prompt for explicit user confirmation per E-52.
	 */
	readonly exceedsWindowCount: boolean;

	/**
	 * Snapshot of input factors evaluated.
	 */
	readonly factors: ConcurrencyFactorBreakdown;
}

/**
 * Priority ordering for selecting a primary bottleneck when multiple factors tie for minimum.
 * External/physical constraints take precedence over user preference:
 * 1. Path conflict (hard lock on modified files)
 * 2. Machine resource (system resource limits)
 * 3. Agent limit (per-agent quota)
 * 4. Window count (dependency graph limit)
 * 5. User setting (configured ceiling)
 */
const PRIORITY_ORDER: readonly ConcurrencyBottleneck[] = Object.freeze([
	CONCURRENCY_BOTTLENECKS.PATH_CONFLICT,
	CONCURRENCY_BOTTLENECKS.MACHINE_RESOURCE,
	CONCURRENCY_BOTTLENECKS.AGENT_LIMIT,
	CONCURRENCY_BOTTLENECKS.WINDOW_COUNT,
	CONCURRENCY_BOTTLENECKS.USER_SETTING,
]);

/**
 * Computes the actual concurrency limit and identifies the bottleneck factor(s).
 *
 * Acceptance Criteria & Boundaries:
 * - AC 1 & E-52: Actual concurrency = min(windowCount, agentLimit, userSetting);
 *   indicates which factor is the bottleneck.
 * - AC 3 & E-48: If windowCount is 1 or dependencies are serial, gracefully degrades
 *   to sequential dispatch without throwing errors or displaying "cannot parallelize".
 * - AC 4: Pure function implementation, directly unit testable.
 * - AC 5 & E-245: userSetting serves solely as an upper bound. Actual concurrency is
 *   min(setting, agentLimit, machineResource, pathConflict). The setting value is
 *   never silently overwritten by runtime.
 */
export function calculateConcurrencyLimit(inputs: ConcurrencyInputs): ConcurrencyResult {
	if (
		typeof inputs.userSetting !== 'number' ||
		!Number.isFinite(inputs.userSetting) ||
		inputs.userSetting < 1
	) {
		throw new AppError('E_VALIDATION', 'userSetting must be a positive integer >= 1');
	}
	if (
		typeof inputs.windowCount !== 'number' ||
		!Number.isFinite(inputs.windowCount) ||
		inputs.windowCount < 0
	) {
		throw new AppError('E_VALIDATION', 'windowCount must be a non-negative integer >= 0');
	}
	if (
		typeof inputs.agentLimit !== 'number' ||
		!Number.isFinite(inputs.agentLimit) ||
		inputs.agentLimit < 1
	) {
		throw new AppError('E_VALIDATION', 'agentLimit must be a positive integer >= 1');
	}
	if (
		inputs.machineResource !== undefined &&
		(typeof inputs.machineResource !== 'number' ||
			!Number.isFinite(inputs.machineResource) ||
			inputs.machineResource < 0)
	) {
		throw new AppError('E_VALIDATION', 'machineResource must be a non-negative integer >= 0');
	}
	if (
		inputs.pathConflictLimit !== undefined &&
		(typeof inputs.pathConflictLimit !== 'number' ||
			!Number.isFinite(inputs.pathConflictLimit) ||
			inputs.pathConflictLimit < 0)
	) {
		throw new AppError('E_VALIDATION', 'pathConflictLimit must be a non-negative integer >= 0');
	}

	const userSetting = Math.floor(inputs.userSetting);
	const windowCount = Math.floor(inputs.windowCount);
	const agentLimit = Math.floor(inputs.agentLimit);
	const machineResource =
		inputs.machineResource !== undefined ? Math.floor(inputs.machineResource) : undefined;
	const pathConflictLimit =
		inputs.pathConflictLimit !== undefined ? Math.floor(inputs.pathConflictLimit) : undefined;

	const factorEntries: Array<{ kind: ConcurrencyBottleneck; value: number }> = [
		{ kind: CONCURRENCY_BOTTLENECKS.USER_SETTING, value: userSetting },
		{ kind: CONCURRENCY_BOTTLENECKS.WINDOW_COUNT, value: windowCount },
		{ kind: CONCURRENCY_BOTTLENECKS.AGENT_LIMIT, value: agentLimit },
	];
	if (machineResource !== undefined) {
		factorEntries.push({
			kind: CONCURRENCY_BOTTLENECKS.MACHINE_RESOURCE,
			value: machineResource,
		});
	}
	if (pathConflictLimit !== undefined) {
		factorEntries.push({
			kind: CONCURRENCY_BOTTLENECKS.PATH_CONFLICT,
			value: pathConflictLimit,
		});
	}

	let minVal = Number.POSITIVE_INFINITY;
	for (const entry of factorEntries) {
		if (entry.value < minVal) {
			minVal = entry.value;
		}
	}
	const effectiveConcurrency = minVal === Number.POSITIVE_INFINITY ? 0 : minVal;

	const tiedBottlenecks: ConcurrencyBottleneck[] = factorEntries
		.filter((entry) => entry.value === minVal)
		.map((entry) => entry.kind);

	let primaryBottleneck: ConcurrencyBottleneck =
		tiedBottlenecks[0] ?? CONCURRENCY_BOTTLENECKS.USER_SETTING;
	for (const priority of PRIORITY_ORDER) {
		if (tiedBottlenecks.includes(priority)) {
			primaryBottleneck = priority;
			break;
		}
	}

	const isDegradedToSerial = windowCount <= 1 || effectiveConcurrency <= 1;
	const exceedsWindowCount = userSetting > windowCount;

	const factors: ConcurrencyFactorBreakdown = Object.freeze({
		userSetting,
		windowCount,
		agentLimit,
		...(machineResource !== undefined ? { machineResource } : {}),
		...(pathConflictLimit !== undefined ? { pathConflictLimit } : {}),
	});

	return Object.freeze({
		effectiveConcurrency,
		bottleneck: primaryBottleneck,
		bottlenecks: Object.freeze(tiedBottlenecks),
		userSetting,
		isDegradedToSerial,
		exceedsWindowCount,
		factors,
	});
}

export interface TaskAssignment {
	readonly taskId: string;
	readonly agentId: string;
}

export interface AgentCapacityDetail {
	readonly assignedCount: number;
	readonly maxConcurrency: number;
	readonly effectiveLimit: number;
}

export interface BatchConcurrencyInputs {
	readonly userSetting: number;
	readonly windowCount: number;
	readonly assignments: readonly TaskAssignment[];
	readonly agentLimits?: Record<string, number> | ((agentId: string) => number);
	readonly machineResource?: number;
	readonly pathConflictLimit?: number;
}

export interface BatchConcurrencyResult extends ConcurrencyResult {
	readonly aggregateAgentCapacity: number;
	readonly agentCapacities: Readonly<Record<string, AgentCapacityDetail>>;
}

/**
 * Calculates concurrency for a batch of tasks assigned to specific agents.
 * Evaluates the aggregate agent concurrency across all assigned agents and detects
 * whether agent capacity, window count, or user setting acts as the bottleneck.
 */
export function calculateBatchConcurrency(inputs: BatchConcurrencyInputs): BatchConcurrencyResult {
	const agentLimits = inputs.agentLimits;
	const getLimit =
		typeof agentLimits === 'function'
			? agentLimits
			: (agentId: string) => (agentLimits ? (agentLimits[agentId] ?? 1) : 1);

	const countsByAgent: Record<string, number> = {};
	for (const assignment of inputs.assignments) {
		countsByAgent[assignment.agentId] = (countsByAgent[assignment.agentId] ?? 0) + 1;
	}

	const agentCapacities: Record<string, AgentCapacityDetail> = {};
	let aggregateAgentCapacity = 0;

	for (const [agentId, assignedCount] of Object.entries(countsByAgent)) {
		const maxConcurrency = Math.max(1, Math.floor(getLimit(agentId)));
		const effectiveLimit = Math.min(assignedCount, maxConcurrency);
		agentCapacities[agentId] = Object.freeze({
			assignedCount,
			maxConcurrency,
			effectiveLimit,
		});
		aggregateAgentCapacity += effectiveLimit;
	}

	const effectiveAgentLimit = inputs.assignments.length === 0 ? 1 : aggregateAgentCapacity;

	const baseResult = calculateConcurrencyLimit({
		userSetting: inputs.userSetting,
		windowCount: inputs.windowCount,
		agentLimit: effectiveAgentLimit,
		machineResource: inputs.machineResource,
		pathConflictLimit: inputs.pathConflictLimit,
	});

	return Object.freeze({
		...baseResult,
		aggregateAgentCapacity,
		agentCapacities: Object.freeze(agentCapacities),
	});
}

export interface CandidateTask {
	readonly id: string;
	readonly agentId: string;
	readonly [key: string]: unknown;
}

export type SlotDeferReason = 'agent_limit_reached' | 'window_exhausted';

export interface DeferredTask<T extends CandidateTask = CandidateTask> {
	readonly task: T;
	readonly reason: SlotDeferReason;
	readonly agentId: string;
}

export interface SlotAllocationOptions<T extends CandidateTask = CandidateTask> {
	readonly candidates: readonly T[];
	readonly availableSlots: number;
	readonly agentLimits?: Record<string, number> | ((agentId: string) => number);
	readonly activeRunsByAgent?: Record<string, number> | ((agentId: string) => number);
}

export interface SlotAllocationResult<T extends CandidateTask = CandidateTask> {
	readonly admitted: readonly T[];
	readonly deferred: readonly DeferredTask<T>[];
	readonly remainingSlots: number;
	readonly allocatedByAgent: Readonly<Record<string, number>>;
}

/**
 * Allocates available window slots among candidate tasks (E-47, E-48).
 *
 * AC 2 & E-47: When a single agent's concurrency is saturated but the window
 * still has available slots, the open slots are ceded to tasks assigned to other
 * agents without blocking or spinning.
 *
 * AC 3 & E-48: When availableSlots is 1 or dependency is serial, sequentially
 * admits 1 task at a time without errors or "cannot parallelize" warnings.
 */
export function allocateConcurrencySlots<T extends CandidateTask = CandidateTask>(
	options: SlotAllocationOptions<T>,
): SlotAllocationResult<T> {
	const availableSlots = Math.max(0, Math.floor(options.availableSlots));
	const agentLimits = options.agentLimits;
	const getLimit =
		typeof agentLimits === 'function'
			? agentLimits
			: (agentId: string) => (agentLimits ? (agentLimits[agentId] ?? 1) : 1);
	const activeRunsByAgent = options.activeRunsByAgent;
	const getActiveRuns =
		typeof activeRunsByAgent === 'function'
			? activeRunsByAgent
			: (agentId: string) => (activeRunsByAgent ? (activeRunsByAgent[agentId] ?? 0) : 0);

	const agentCurrentActive: Record<string, number> = {};
	const allocatedByAgent: Record<string, number> = {};
	const admitted: T[] = [];
	const deferred: DeferredTask<T>[] = [];
	let openSlots = availableSlots;

	for (const candidate of options.candidates) {
		const agentId = candidate.agentId;
		if (agentCurrentActive[agentId] === undefined) {
			agentCurrentActive[agentId] = Math.max(0, Math.floor(getActiveRuns(agentId)));
		}
		const limit = Math.max(1, Math.floor(getLimit(agentId)));

		if (openSlots <= 0) {
			deferred.push(
				Object.freeze({
					task: candidate,
					reason: 'window_exhausted',
					agentId,
				}),
			);
			continue;
		}

		if (agentCurrentActive[agentId] < limit) {
			admitted.push(candidate);
			agentCurrentActive[agentId]++;
			allocatedByAgent[agentId] = (allocatedByAgent[agentId] ?? 0) + 1;
			openSlots--;
		} else {
			// Agent concurrency is saturated!
			// Cede open slots to other agents' tasks and DO NOT wait or spin (AC 2, E-47).
			deferred.push(
				Object.freeze({
					task: candidate,
					reason: 'agent_limit_reached',
					agentId,
				}),
			);
		}
	}

	return Object.freeze({
		admitted: Object.freeze(admitted),
		deferred: Object.freeze(deferred),
		remainingSlots: openSlots,
		allocatedByAgent: Object.freeze(allocatedByAgent),
	});
}

/**
 * Counts active runs for an agent that occupy concurrency slots (E-54, E-115).
 * awaiting_human and orphaned states do not count; awaiting_reply still counts.
 */
export function countActiveRunsForAgent(states: readonly (RunState | string)[]): number {
	return states.filter((state) => countsTowardAgentConcurrency(state as RunState)).length;
}

/**
 * Checks whether user setting is strictly within window count capacity without needing unlock.
 */
export function canIncreaseWithoutUnlock(userSetting: number, windowCount: number): boolean {
	return userSetting < windowCount;
}
