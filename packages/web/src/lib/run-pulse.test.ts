import { describe, expect, it } from 'vitest';
import { RUN_PULSE, type RunState, pulseForRun } from './run-pulse.ts';

describe('lib/run-pulse (M9-T19, AC 3, E-282)', () => {
	const all13States: readonly RunState[] = [
		'queued',
		'starting',
		'running',
		'awaiting_reply',
		'exited',
		'reviewing',
		'reworking',
		'awaiting_human',
		'orphaned',
		'landed',
		'failed',
		'aborted',
		'interrupted',
	];

	it('covers exactly 13 states in RUN_PULSE dictionary with satisfies', () => {
		expect(Object.keys(RUN_PULSE).sort()).toEqual([...all13States].sort());
		expect(Object.keys(RUN_PULSE)).toHaveLength(13);
	});

	it('maps live to starting, running, reviewing, reworking exactly', () => {
		const liveStates = all13States.filter((s) => RUN_PULSE[s] === 'live');
		expect(liveStates.sort()).toEqual(['starting', 'running', 'reviewing', 'reworking'].sort());

		for (const state of liveStates) {
			expect(pulseForRun(state)).toBe('live');
		}
	});

	it('maps awaiting_* and orphaned to waiting static warm dot', () => {
		const waitingStates = all13States.filter((s) => RUN_PULSE[s] === 'waiting');
		expect(waitingStates.sort()).toEqual(['awaiting_human', 'awaiting_reply', 'orphaned'].sort());

		for (const state of waitingStates) {
			expect(pulseForRun(state)).toBe('waiting');
		}
	});

	it('maps terminal states, queued, and exited to none (no dot)', () => {
		const noneStates = all13States.filter((s) => RUN_PULSE[s] === 'none');
		expect(noneStates.sort()).toEqual(
			['queued', 'exited', 'landed', 'failed', 'aborted', 'interrupted'].sort(),
		);

		for (const state of noneStates) {
			expect(pulseForRun(state)).toBe('none');
		}
	});

	it('returns none for null, undefined, empty string, or unrecognized states', () => {
		expect(pulseForRun(null)).toBe('none');
		expect(pulseForRun(undefined)).toBe('none');
		expect(pulseForRun('')).toBe('none');
		expect(pulseForRun('unknown_state')).toBe('none');
		expect(pulseForRun('some_random_text')).toBe('none');
	});
});
