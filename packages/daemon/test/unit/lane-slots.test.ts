import { describe, expect, it } from 'vitest';
import { countLaneSlots, freeLaneNumbers } from '../../src/domain/lane-slots.ts';

describe('M8-T8 Lane Slots Unit Tests (AC 2, AC 3, E-311)', () => {
	it('counts occupied slots strictly by tasks.lane_no and active wrapup runs (AC 3, E-311)', () => {
		// Task with implement, review, and bughunt runs shares the same tasks.lane_no slot
		const tasks = [
			{ id: 't1', lane_no: 1 },
			{ id: 't2', lane_no: 2 },
			{ id: 't3', lane_no: null }, // unassigned or awaiting_human
		];

		// Multiple runs for t1 and t2 do not increase slot count; only active wrapup occupies a slot
		const runs = [
			{ id: 'r1', kind: 'implement', state: 'reviewing', lane_no: 1 },
			{ id: 'r2', kind: 'review', state: 'running', lane_no: 1 },
			{ id: 'r3', kind: 'bughunt', state: 'running', lane_no: 2 },
			{ id: 'r4', kind: 'wrapup', state: 'running', lane_no: 3 }, // active wrapup holds slot 3
			{ id: 'r5', kind: 'wrapup', state: 'landed', lane_no: 4 }, // terminal wrapup does not hold slot
		];

		const used = countLaneSlots({ tasks, runs });
		// t1 (lane 1) + t2 (lane 2) + r4 wrapup (lane 3) = 3 occupied slots
		expect(used).toBe(3);
	});

	it('freeLaneNumbers derives ascending free numbers and returns empty array when reduced below occupied', () => {
		// Normal case: laneCount=4, lanes 1 and 3 occupied -> [2, 4]
		expect(freeLaneNumbers(4, [1, 3])).toEqual([2, 4]);

		// Completely empty
		expect(freeLaneNumbers(3, [])).toEqual([1, 2, 3]);

		// Completely full
		expect(freeLaneNumbers(3, [1, 2, 3])).toEqual([]);

		// Window size reduced below occupied count (E-309): laneCount=2, occupied 1..4 -> []
		expect(freeLaneNumbers(2, [1, 2, 3, 4])).toEqual([]);

		// Ignores null, undefined, or out-of-range numbers
		expect(freeLaneNumbers(3, [null, undefined, 0, 5, 2])).toEqual([1, 3]);
	});
});
