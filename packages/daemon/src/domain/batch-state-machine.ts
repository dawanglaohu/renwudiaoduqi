import type { BatchState } from '@agent-scheduler/shared/api/batches';
import { AppError } from '../errors/app-error.ts';

export type { BatchState } from '@agent-scheduler/shared/api/batches';

/**
 * State transition whitelist for batches (09 节 批次状态机, AC 1).
 *
 * All batch state mutations MUST go through transitionBatch() in service/batch.ts,
 * which validates against this table and emits a batch.advanced event.
 */
export const BATCH_STATE_TRANSITIONS: Readonly<Record<BatchState, readonly BatchState[]>> =
	Object.freeze({
		idle: Object.freeze<readonly BatchState[]>(['running']),
		running: Object.freeze<readonly BatchState[]>(['paused', 'awaiting_landing', 'wrapping']),
		paused: Object.freeze<readonly BatchState[]>(['running']),
		awaiting_landing: Object.freeze<readonly BatchState[]>(['wrapping', 'running']),
		wrapping: Object.freeze<readonly BatchState[]>([
			'done',
			'running',
			'needs_attention',
			'paused',
		]),
		needs_attention: Object.freeze<readonly BatchState[]>(['wrapping', 'done', 'running']),
		done: Object.freeze<readonly BatchState[]>([]),
	});

export function canTransitionBatch(from: BatchState, to: BatchState): boolean {
	const allowed = BATCH_STATE_TRANSITIONS[from];
	if (!allowed) return false;
	return allowed.includes(to);
}

export function assertCanTransitionBatch(from: BatchState, to: BatchState): void {
	if (!canTransitionBatch(from, to)) {
		throw new AppError(
			'E_INVALID_STATE_TRANSITION',
			`Invalid batch state transition from '${from}' to '${to}'`,
			{
				details: {
					from,
					to,
					allowed: BATCH_STATE_TRANSITIONS[from] ?? [],
				},
			},
		);
	}
}

export function isTerminalBatchState(state: BatchState): boolean {
	return state === 'done';
}
