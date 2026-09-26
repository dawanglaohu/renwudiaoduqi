import { LANE_STAGES } from '@agent-scheduler/shared/api/lanes';
import { describe, expect, it } from 'vitest';
import { type DeriveLanesInput, deriveLanes } from '../../src/domain/lanes.ts';

describe('M8-T8 deriveLanes Unit & Arch Tests (AC 1, E-317, E-319, E-332)', () => {
	it('AC 1: derives continuous laneNo, calculates overLimit, and handles nextTaskId without duplicates', () => {
		const tasks = [
			{ id: 't1', task_key: 'M1-T1', doc_id: 'doc-1', lane_no: 1, manual_state: null },
			{
				id: 't2',
				task_key: 'M1-T2',
				doc_id: 'doc-1',
				lane_no: null,
				manual_state: null,
				deps_json: '[]',
			},
			{
				id: 't3',
				task_key: 'M1-T3',
				doc_id: 'doc-1',
				lane_no: null,
				manual_state: null,
				deps_json: '["M1-T4"]',
			},
			{
				id: 't4',
				task_key: 'M1-T4',
				doc_id: 'doc-1',
				lane_no: null,
				manual_state: null,
				deps_json: '["M1-T1"]',
			},
		];

		const runs = [
			{ id: 'r1', task_id: 't1', kind: 'implement', state: 'running', attempt_no: 1, lane_no: 1 },
		];

		const lanes = deriveLanes({
			laneCount: 3,
			tasks,
			runs,
		});

		expect(lanes).toHaveLength(3);
		expect(lanes.map((l) => l.laneNo)).toEqual([1, 2, 3]);
		expect(lanes.map((l) => l.overLimit)).toEqual([false, false, false]);

		// Lane 1 is occupied by t1
		expect(lanes[0]?.taskId).toBe('t1');
		expect(lanes[0]?.stage).toBe('implement');
		expect(lanes[0]?.currentRunId).toBe('r1');
		expect(lanes[0]?.nextTaskId).toBeNull();
		expect(lanes[0]?.nextBlockedBy).toEqual([]);

		// Lane 2 is idle: picks available candidate t2
		expect(lanes[1]?.stage).toBe('idle');
		expect(lanes[1]?.nextTaskId).toBe('t2');
		expect(lanes[1]?.nextBlockedBy).toEqual([]);

		// Lane 3 is idle: candidate t2 consumed, blocked tasks remaining (t3, t4)
		// Sorted by task_key, M1-T3 comes before M1-T4. M1-T3 is blocked by M1-T4.
		expect(lanes[2]?.stage).toBe('idle');
		expect(lanes[2]?.nextTaskId).toBe('t3');
		expect(lanes[2]?.nextBlockedBy).toEqual(['M1-T4']);

		// Distinct nextTaskId across all lanes
		const nextIds = lanes.map((l) => l.nextTaskId).filter((id): id is string => id !== null);
		expect(new Set(nextIds).size).toBe(nextIds.length);
	});

	it('calculates overLimit correctly when laneCount is reduced below occupied lanes (E-309)', () => {
		const tasks = [
			{ id: 't1', task_key: 'M1-T1', doc_id: 'doc-1', lane_no: 1 },
			{ id: 't2', task_key: 'M1-T2', doc_id: 'doc-1', lane_no: 2 },
			{ id: 't3', task_key: 'M1-T3', doc_id: 'doc-1', lane_no: 3 },
		];
		const runs = [
			{ id: 'r1', task_id: 't1', kind: 'implement', state: 'running', lane_no: 1 },
			{ id: 'r2', task_id: 't2', kind: 'implement', state: 'running', lane_no: 2 },
			{ id: 'r3', task_id: 't3', kind: 'implement', state: 'running', lane_no: 3 },
		];

		// User reduced laneCount to 1, but lanes 1, 2, 3 are occupied
		const lanes = deriveLanes({
			laneCount: 1,
			tasks,
			runs,
		});

		expect(lanes).toHaveLength(3);
		expect(lanes[0]?.overLimit).toBe(false);
		expect(lanes[1]?.overLimit).toBe(true);
		expect(lanes[2]?.overLimit).toBe(true);
	});

	it('archivedTaskIds and archivedWrapupRunId contain at most 1 recent historical entity', () => {
		const tasks = [
			{ id: 't1', task_key: 'M1-T1', doc_id: 'doc-1', lane_no: null },
			{ id: 't2', task_key: 'M1-T2', doc_id: 'doc-1', lane_no: null },
		];
		const runs = [
			// t1 archived earlier on lane 1
			{
				id: 'r1',
				task_id: 't1',
				kind: 'implement',
				state: 'landed',
				lane_no: 1,
				session_archived_at: '2026-09-17T10:00:00.000Z',
			},
			// t2 archived later on lane 1
			{
				id: 'r2',
				task_id: 't2',
				kind: 'implement',
				state: 'landed',
				lane_no: 1,
				session_archived_at: '2026-09-17T11:00:00.000Z',
			},
			// wrapup archived on lane 2
			{
				id: 'w1',
				task_id: null,
				kind: 'wrapup',
				state: 'landed',
				lane_no: 2,
				session_archived_at: '2026-09-17T12:00:00.000Z',
			},
		];

		const lanes = deriveLanes({
			laneCount: 2,
			tasks,
			runs,
		});

		// Lane 1's most recent archived task is t2
		expect(lanes[0]?.archivedTaskIds).toEqual(['t2']);
		expect(lanes[0]?.archivedWrapupRunId).toBeNull();

		// Lane 2's archived wrapup is w1
		expect(lanes[1]?.archivedTaskIds).toEqual([]);
		expect(lanes[1]?.archivedWrapupRunId).toBe('w1');
	});

	it('E-325: a later task replaces an older wrapup in the same lane history', () => {
		const lanes = deriveLanes({
			laneCount: 1,
			tasks: [{ id: 'later-task', task_key: 'M9-T21', doc_id: 'doc-1', lane_no: null }],
			runs: [
				{
					id: 'wrapup',
					task_id: null,
					kind: 'wrapup',
					state: 'landed',
					lane_no: 1,
					session_archived_at: '2026-09-25T10:00:00.000Z',
				},
				{
					id: 'task-run',
					task_id: 'later-task',
					kind: 'implement',
					state: 'landed',
					lane_no: 1,
					session_archived_at: '2026-09-25T11:00:00.000Z',
				},
			],
		});
		expect(lanes[0]?.archivedTaskIds).toEqual(['later-task']);
		expect(lanes[0]?.archivedWrapupRunId).toBeNull();
	});

	it('E-325: a later wrapup replaces an older task in the same lane history', () => {
		const lanes = deriveLanes({
			laneCount: 1,
			tasks: [{ id: 'old-task', task_key: 'M9-T20', doc_id: 'doc-1', lane_no: null }],
			runs: [
				{
					id: 'task-run',
					task_id: 'old-task',
					kind: 'implement',
					state: 'landed',
					lane_no: 1,
					session_archived_at: '2026-09-25T10:00:00.000Z',
				},
				{
					id: 'wrapup',
					task_id: null,
					kind: 'wrapup',
					state: 'landed',
					lane_no: 1,
					session_archived_at: '2026-09-25T11:00:00.000Z',
				},
			],
		});
		expect(lanes[0]?.archivedTaskIds).toEqual([]);
		expect(lanes[0]?.archivedWrapupRunId).toBe('wrapup');
	});

	it('produces byte-identical JSON on shuffled input collections (E-317, E-319)', () => {
		const baseTasks = [
			{ id: 't-b', task_key: 'B', doc_id: 'doc-1', lane_no: 1 },
			{ id: 't-a', task_key: 'A', doc_id: 'doc-1', lane_no: 2 },
			{ id: 't-c', task_key: 'C', doc_id: 'doc-1', lane_no: null, deps_json: '[]' },
		];
		const baseRuns = [
			{ id: 'r-2', task_id: 't-a', kind: 'implement', state: 'running', lane_no: 2 },
			{ id: 'r-1', task_id: 't-b', kind: 'implement', state: 'running', lane_no: 1 },
		];

		const input1: DeriveLanesInput = {
			laneCount: 3,
			tasks: baseTasks,
			runs: baseRuns,
		};

		// Shuffled inputs
		const input2: DeriveLanesInput = {
			laneCount: 3,
			tasks: [baseTasks[2], baseTasks[0], baseTasks[1]].filter(
				(x): x is (typeof baseTasks)[number] => x !== undefined,
			),
			runs: [baseRuns[1], baseRuns[0]].filter(
				(x): x is (typeof baseRuns)[number] => x !== undefined,
			),
		};

		const json1 = JSON.stringify(deriveLanes(input1));
		const json2 = JSON.stringify(deriveLanes(input2));
		expect(json1).toBe(json2);
	});

	it('E-332 Arch test: deriveLanes is capable of producing every stage in shared LANE_STAGES exactly', () => {
		// Verify that all 7 stages ('idle' | 'queued' | 'implement' | 'rework' | 'review' | 'bughunt' | 'wrapup')
		// can be derived from possible system states.
		const tasks = [
			{ id: 't-queued', task_key: 'Q', doc_id: 'doc-1', lane_no: 1 },
			{ id: 't-implement', task_key: 'I', doc_id: 'doc-1', lane_no: 2 },
			{ id: 't-rework', task_key: 'RW', doc_id: 'doc-1', lane_no: 3 },
			{ id: 't-review', task_key: 'RV', doc_id: 'doc-1', lane_no: 4 },
			{ id: 't-bughunt', task_key: 'BH', doc_id: 'doc-1', lane_no: 5 },
		];

		const runs = [
			{ id: 'r-q', task_id: 't-queued', kind: 'implement', state: 'queued', lane_no: 1 },
			{ id: 'r-i', task_id: 't-implement', kind: 'implement', state: 'running', lane_no: 2 },
			{ id: 'r-rw', task_id: 't-rework', kind: 'implement', state: 'reworking', lane_no: 3 },
			{ id: 'r-rv', task_id: 't-review', kind: 'review', state: 'running', lane_no: 4 },
			{ id: 'r-bh', task_id: 't-bughunt', kind: 'bughunt', state: 'running', lane_no: 5 },
			{ id: 'r-w', task_id: null, kind: 'wrapup', state: 'running', lane_no: 6 },
		];

		// lane 7 will be idle
		const lanes = deriveLanes({
			laneCount: 7,
			tasks,
			runs,
		});

		const derivedStages = new Set(lanes.map((l) => l.stage));
		expect(derivedStages).toEqual(new Set(LANE_STAGES));
		expect(derivedStages.size).toBe(7);
	});
});
