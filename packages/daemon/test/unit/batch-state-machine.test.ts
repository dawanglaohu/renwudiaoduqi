import { describe, expect, it } from 'vitest';
import {
	BATCH_STATE_TRANSITIONS,
	type BatchState,
	assertCanTransitionBatch,
	canTransitionBatch,
	isTerminalBatchState,
} from '../../src/domain/batch-state-machine.ts';
import { AppError } from '../../src/errors/app-error.ts';

describe('domain/batch-state-machine (AC 1, 09 节 批次状态机)', () => {
	it('allows all defined transitions in the whitelist', () => {
		for (const [from, allowedList] of Object.entries(BATCH_STATE_TRANSITIONS)) {
			for (const to of allowedList) {
				expect(canTransitionBatch(from as BatchState, to)).toBe(true);
				expect(() => assertCanTransitionBatch(from as BatchState, to)).not.toThrow();
			}
		}
	});

	it('disallows transitions outside the whitelist and throws E_INVALID_STATE_TRANSITION', () => {
		const allStates: BatchState[] = [
			'idle',
			'running',
			'paused',
			'awaiting_landing',
			'wrapping',
			'needs_attention',
			'done',
		];

		for (const from of allStates) {
			const allowed = BATCH_STATE_TRANSITIONS[from];
			for (const to of allStates) {
				if (!allowed.includes(to)) {
					expect(canTransitionBatch(from, to)).toBe(false);
					expect(() => assertCanTransitionBatch(from, to)).toThrowError(AppError);
					try {
						assertCanTransitionBatch(from, to);
					} catch (err) {
						expect(err instanceof AppError && err.code === 'E_INVALID_STATE_TRANSITION').toBe(true);
					}
				}
			}
		}
	});

	it('done state has zero outbound transitions (terminal)', () => {
		expect(BATCH_STATE_TRANSITIONS.done).toEqual([]);
		expect(isTerminalBatchState('done')).toBe(true);
		expect(isTerminalBatchState('running')).toBe(false);
	});
});
