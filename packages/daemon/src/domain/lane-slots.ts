import type { RunState } from '@agent-scheduler/shared/api/runs';
import { isTerminalRunState } from './run-state-machine.ts';

export interface TaskSlotItem {
	readonly id?: string;
	readonly lane_no?: number | null;
	readonly [key: string]: unknown;
}

export interface RunSlotItem {
	readonly id?: string;
	readonly kind: string;
	readonly state: string;
	readonly lane_no?: number | null;
	readonly [key: string]: unknown;
}

export interface CountLaneSlotsInput {
	readonly tasks?: readonly TaskSlotItem[];
	readonly runs?: readonly RunSlotItem[];
}

/**
 * Counts occupied lane slots (AC 2, AC 3, E-311):
 * - Slots are counted strictly by task (tasks.lane_no IS NOT NULL).
 *   Implementation, review, bughunt runs of the same task share the SAME lane slot.
 * - Active (non-terminal) wrapup runs with runs.lane_no IS NOT NULL each occupy 1 lane slot.
 * - Never counts runs.state to calculate slots (E-311).
 */
export function countLaneSlots(input: CountLaneSlotsInput): number {
	const taskSlots = (input.tasks ?? []).filter(
		(t) => t.lane_no !== null && t.lane_no !== undefined,
	).length;

	const wrapupSlots = (input.runs ?? []).filter(
		(r) =>
			r.kind === 'wrapup' &&
			r.lane_no !== null &&
			r.lane_no !== undefined &&
			!isTerminalRunState(r.state as RunState) &&
			r.state !== 'awaiting_human' &&
			r.state !== 'orphaned',
	).length;

	return taskSlots + wrapupSlots;
}

/**
 * Derives available ascending lane numbers from 1 to laneCount (AC 2, E-309, E-310):
 * - Returns numbers in range 1..laneCount that are not present in occupiedLanes.
 * - Result is strictly sorted ascending.
 * - If laneCount is reduced below the number of occupied slots, returns empty array.
 */
export function freeLaneNumbers(
	laneCount: number,
	occupiedLanes: Iterable<number | null | undefined>,
): number[] {
	if (laneCount < 1) {
		return [];
	}

	const occupied = new Set<number>();
	for (const laneNo of occupiedLanes) {
		if (typeof laneNo === 'number' && Number.isInteger(laneNo) && laneNo >= 1) {
			occupied.add(laneNo);
		}
	}

	const free: number[] = [];
	for (let i = 1; i <= laneCount; i++) {
		if (!occupied.has(i)) {
			free.push(i);
		}
	}

	return free;
}
