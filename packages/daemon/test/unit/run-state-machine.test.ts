import { describe, expect, it } from 'vitest';
import {
	EXCLUDED_FROM_CONCURRENCY_STATES,
	RUN_STATES,
	RUN_TRANSITION_REASONS,
	TERMINAL_RUN_STATES,
	VALID_RUN_TRANSITIONS,
	assertValidTransition,
	canTransition,
	canTransitionToLanded,
	countsTowardAgentConcurrency,
	createRunStateMachine,
	isReconciliationCandidate,
	isTerminalRunState,
	isValidRunState,
} from '../../src/domain/run-state-machine.ts';
import { AppError } from '../../src/errors/app-error.ts';

describe('domain/run-state-machine (M6-T1, AC 1-4, E-123, E-23, E-55)', () => {
	describe('AC 1: pure function state machine & zero top-level side effects', () => {
		it('exports the complete set of 13 run states (09-数据模型, migrations/0001_init.sql)', () => {
			expect(RUN_STATES).toHaveLength(13);
			expect(RUN_STATES).toEqual([
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
			]);
		});

		it('validates state strings with isValidRunState', () => {
			for (const state of RUN_STATES) {
				expect(isValidRunState(state)).toBe(true);
			}
			expect(isValidRunState('unknown_state')).toBe(false);
			expect(isValidRunState('')).toBe(false);
			expect(isValidRunState(null)).toBe(false);
			expect(isValidRunState(undefined)).toBe(false);
			expect(isValidRunState(123)).toBe(false);
		});

		it('verifies all valid whitelist transitions from 09 section state diagram', () => {
			// queued
			expect(canTransition('queued', 'starting')).toBe(true);
			expect(canTransition('queued', 'failed')).toBe(true);

			// starting
			expect(canTransition('starting', 'running')).toBe(true);
			expect(canTransition('starting', 'failed')).toBe(true);
			expect(canTransition('starting', 'interrupted')).toBe(true);
			expect(canTransition('starting', 'orphaned')).toBe(true);

			// running
			expect(canTransition('running', 'awaiting_reply')).toBe(true);
			expect(canTransition('running', 'exited')).toBe(true);
			expect(canTransition('running', 'aborted')).toBe(true);
			expect(canTransition('running', 'orphaned')).toBe(true);
			expect(canTransition('running', 'interrupted')).toBe(true);

			// awaiting_reply
			expect(canTransition('awaiting_reply', 'running')).toBe(true);
			expect(canTransition('awaiting_reply', 'exited')).toBe(true);
			expect(canTransition('awaiting_reply', 'aborted')).toBe(true);
			expect(canTransition('awaiting_reply', 'orphaned')).toBe(true);
			expect(canTransition('awaiting_reply', 'interrupted')).toBe(true);

			// exited
			expect(canTransition('exited', 'reviewing')).toBe(true);

			// reviewing
			expect(canTransition('reviewing', 'awaiting_human')).toBe(true);
			expect(canTransition('reviewing', 'reworking')).toBe(true);
			expect(canTransition('reviewing', 'landed')).toBe(true);

			// reworking
			expect(canTransition('reworking', 'running')).toBe(true);
			expect(canTransition('reworking', 'awaiting_human')).toBe(true);

			// awaiting_human
			expect(canTransition('awaiting_human', 'landed')).toBe(true);
			expect(canTransition('awaiting_human', 'reworking')).toBe(true);
			expect(canTransition('awaiting_human', 'failed')).toBe(true);

			// orphaned
			expect(canTransition('orphaned', 'aborted')).toBe(true);

			// Terminal states have zero out-edges
			expect(VALID_RUN_TRANSITIONS.landed).toEqual([]);
			expect(VALID_RUN_TRANSITIONS.failed).toEqual([]);
			expect(VALID_RUN_TRANSITIONS.aborted).toEqual([]);
			expect(VALID_RUN_TRANSITIONS.interrupted).toEqual([]);
		});

		it('throws AppError with E_INVALID_STATE_TRANSITION on illegal transition', () => {
			expect(() => {
				assertValidTransition('queued', 'running');
			}).toThrowError(AppError);

			try {
				assertValidTransition('queued', 'running', { reason: 'try_skip_starting' });
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				const appErr = err as AppError;
				expect(appErr.code).toBe('E_INVALID_STATE_TRANSITION');
				expect(appErr.details).toMatchObject({
					from: 'queued',
					to: 'running',
					reason: 'try_skip_starting',
					allowedTargets: ['starting', 'failed'],
				});
			}
		});

		it('rejects self-transitions for all states', () => {
			for (const state of RUN_STATES) {
				expect(canTransition(state, state)).toBe(false);
				expect(() => assertValidTransition(state, state)).toThrowError(AppError);
			}
		});
	});

	describe('AC 2 & E-23: exited -> landed does NOT exist; landing requires review or human confirmation', () => {
		it('strictly forbids exited -> landed direct transition', () => {
			expect(canTransition('exited', 'landed')).toBe(false);
			expect(() => {
				assertValidTransition('exited', 'landed');
			}).toThrowError(AppError);

			try {
				assertValidTransition('exited', 'landed', { reason: 'exit_code_zero' });
			} catch (err) {
				const appErr = err as AppError;
				expect(appErr.code).toBe('E_INVALID_STATE_TRANSITION');
				expect(appErr.details?.from).toBe('exited');
				expect(appErr.details?.to).toBe('landed');
			}
		});

		it('forbids exited from bypassing review to awaiting_human', () => {
			expect(canTransition('exited', 'awaiting_human')).toBe(false);
			expect(() => assertValidTransition('exited', 'awaiting_human')).toThrowError(AppError);
		});

		it('ensures exited has only one single valid destination: reviewing', () => {
			expect(VALID_RUN_TRANSITIONS.exited).toEqual(['reviewing']);
			for (const state of RUN_STATES) {
				if (state === 'reviewing') {
					expect(canTransition('exited', state)).toBe(true);
				} else {
					expect(canTransition('exited', state)).toBe(false);
				}
			}
		});

		it('restricts entry into landed to ONLY reviewing and awaiting_human (canTransitionToLanded)', () => {
			expect(canTransitionToLanded('reviewing')).toBe(true);
			expect(canTransitionToLanded('awaiting_human')).toBe(true);

			for (const state of RUN_STATES) {
				if (state !== 'reviewing' && state !== 'awaiting_human') {
					expect(canTransitionToLanded(state)).toBe(false);
					expect(canTransition(state, 'landed')).toBe(false);
				}
			}
		});
	});

	describe('AC 3 & E-123: interrupted is terminal with ZERO outgoing edges', () => {
		it('marks interrupted as a terminal state', () => {
			expect(isTerminalRunState('interrupted')).toBe(true);
			expect(TERMINAL_RUN_STATES).toContain('interrupted');
		});

		it('ensures interrupted has zero outgoing transitions in the whitelist table', () => {
			expect(VALID_RUN_TRANSITIONS.interrupted).toEqual([]);
		});

		it('rejects any transition attempt originating from interrupted to any state', () => {
			for (const target of RUN_STATES) {
				expect(canTransition('interrupted', target)).toBe(false);
				expect(() => assertValidTransition('interrupted', target)).toThrowError(AppError);
			}
		});

		it('verifies all four terminal states (landed, failed, aborted, interrupted) have zero out-edges', () => {
			for (const terminal of TERMINAL_RUN_STATES) {
				expect(isTerminalRunState(terminal)).toBe(true);
				expect(VALID_RUN_TRANSITIONS[terminal]).toEqual([]);
				for (const target of RUN_STATES) {
					expect(canTransition(terminal, target)).toBe(false);
				}
			}
		});

		it('verifies reconciliation candidates for daemon restart (E-123 / E-02)', () => {
			expect(isReconciliationCandidate('starting')).toBe(true);
			expect(isReconciliationCandidate('running')).toBe(true);
			expect(isReconciliationCandidate('awaiting_reply')).toBe(true);

			expect(isReconciliationCandidate('queued')).toBe(false);
			expect(isReconciliationCandidate('exited')).toBe(false);
			expect(isReconciliationCandidate('reviewing')).toBe(false);
			expect(isReconciliationCandidate('reworking')).toBe(false);
			expect(isReconciliationCandidate('awaiting_human')).toBe(false);
			expect(isReconciliationCandidate('orphaned')).toBe(false);
			expect(isReconciliationCandidate('landed')).toBe(false);
			expect(isReconciliationCandidate('failed')).toBe(false);
			expect(isReconciliationCandidate('aborted')).toBe(false);
			expect(isReconciliationCandidate('interrupted')).toBe(false);

			// Active running states can transition to interrupted on restart when process is gone
			expect(canTransition('starting', 'interrupted', {})).toBe(true);
			expect(canTransition('running', 'interrupted', {})).toBe(true);
			expect(canTransition('awaiting_reply', 'interrupted', {})).toBe(true);
		});
	});

	describe('AC 4: DI clock and id injection with deterministic test reproducibility', () => {
		it('creates state machine via factory with injected clock and id generator', () => {
			const timestamps = ['2026-09-08T10:00:00.000Z', '2026-09-08T10:00:05.000Z'];
			const ids = ['evt-001', 'evt-002'];
			let timeIndex = 0;
			let idIndex = 0;

			const machine = createRunStateMachine({
				clock: { now: () => timestamps[timeIndex++] ?? '2026-09-08T10:00:10.000Z' },
				ids: { newId: () => ids[idIndex++] ?? 'evt-fallback' },
			});

			// Step 1: queued -> starting
			const res1 = machine.transition({
				runId: 'run-100',
				taskId: 'task-M6-T1',
				from: 'queued',
				to: 'starting',
				reason: 'quota_available_and_no_path_clash',
			});

			expect(res1.transitionId).toBe('evt-001');
			expect(res1.occurredAt).toBe('2026-09-08T10:00:00.000Z');
			expect(res1.from).toBe('queued');
			expect(res1.to).toBe('starting');
			expect(res1.isTerminal).toBe(false);
			expect(res1.countsTowardConcurrency).toBe(true);
			expect(res1.event).toEqual({
				id: 'evt-001',
				ts: '2026-09-08T10:00:00.000Z',
				runId: 'run-100',
				taskId: 'task-M6-T1',
				scope: 'run',
				kind: 'run.state_changed',
				actorDeviceId: null,
				payload: {
					from: 'queued',
					to: 'starting',
					reason: 'quota_available_and_no_path_clash',
				},
			});

			// Step 2: starting -> running
			const res2 = machine.transition({
				runId: 'run-100',
				taskId: 'task-M6-T1',
				from: 'starting',
				to: 'running',
				reason: 'first_event_received',
				actorDeviceId: 'dev-client-1',
			});

			expect(res2.transitionId).toBe('evt-002');
			expect(res2.occurredAt).toBe('2026-09-08T10:00:05.000Z');
			expect(res2.event.actorDeviceId).toBe('dev-client-1');
			expect(res2.event.payload).toEqual({
				from: 'starting',
				to: 'running',
				reason: 'first_event_received',
			});
		});

		it('guarantees identical deterministic output when run with identical inputs and DI fixtures', () => {
			function runScenario() {
				let step = 0;
				const machine = createRunStateMachine({
					clock: { now: () => `2026-09-08T12:00:0${step}.000Z` },
					ids: { newId: () => `id-${step}` },
				});

				const r1 = machine.transition({
					runId: 'run-scenario',
					from: 'running',
					to: 'interrupted',
					reason: RUN_TRANSITION_REASONS.DAEMON_RESTART_PROCESS_NOT_FOUND,
				});
				step++;

				return { r1 };
			}

			const runA = runScenario();
			const runB = runScenario();

			expect(runA).toEqual(runB);
			expect(runA.r1.isTerminal).toBe(true);
			expect(runA.r1.event.payload.to).toBe('interrupted');
		});
	});

	describe('agent concurrency quota rules (09-数据模型, E-54, E-115)', () => {
		it('excludes awaiting_human and orphaned from concurrency quota', () => {
			expect(countsTowardAgentConcurrency('awaiting_human')).toBe(false);
			expect(countsTowardAgentConcurrency('orphaned')).toBe(false);
			expect(EXCLUDED_FROM_CONCURRENCY_STATES).toContain('awaiting_human');
			expect(EXCLUDED_FROM_CONCURRENCY_STATES).toContain('orphaned');
		});

		it('ensures awaiting_reply DOES occupy agent concurrency quota (E-115)', () => {
			expect(countsTowardAgentConcurrency('awaiting_reply')).toBe(true);
		});

		it('excludes terminal states from concurrency quota', () => {
			expect(countsTowardAgentConcurrency('landed')).toBe(false);
			expect(countsTowardAgentConcurrency('failed')).toBe(false);
			expect(countsTowardAgentConcurrency('aborted')).toBe(false);
			expect(countsTowardAgentConcurrency('interrupted')).toBe(false);
		});

		it('counts active execution states toward concurrency quota', () => {
			expect(countsTowardAgentConcurrency('queued')).toBe(true);
			expect(countsTowardAgentConcurrency('starting')).toBe(true);
			expect(countsTowardAgentConcurrency('running')).toBe(true);
			expect(countsTowardAgentConcurrency('exited')).toBe(true);
			expect(countsTowardAgentConcurrency('reviewing')).toBe(true);
			expect(countsTowardAgentConcurrency('reworking')).toBe(true);
		});
	});

	describe('rework retry limit (E-55)', () => {
		it('allows reviewing -> reworking when reworkCount < maxReworkCount (default 2)', () => {
			expect(canTransition('reviewing', 'reworking', { reworkCount: 0 })).toBe(true);
			expect(canTransition('reviewing', 'reworking', { reworkCount: 1 })).toBe(true);
		});

		it('blocks reviewing -> reworking when reworkCount >= maxReworkCount (E-55)', () => {
			expect(canTransition('reviewing', 'reworking', { reworkCount: 2 })).toBe(false);
			expect(canTransition('reviewing', 'reworking', { reworkCount: 3 })).toBe(false);

			expect(() => {
				assertValidTransition('reviewing', 'reworking', {
					reworkCount: 2,
					reason: 'retry_review',
				});
			}).toThrowError(AppError);
		});

		it('respects custom maxReworkCount in transition context', () => {
			expect(canTransition('reviewing', 'reworking', { reworkCount: 1, maxReworkCount: 1 })).toBe(
				false,
			);
			expect(canTransition('reviewing', 'reworking', { reworkCount: 2, maxReworkCount: 3 })).toBe(
				true,
			);
		});

		it('allows transitioning to awaiting_human when rework limit is reached', () => {
			expect(canTransition('reviewing', 'awaiting_human', { reworkCount: 2 })).toBe(true);
		});
	});

	describe('human review actions in awaiting_human', () => {
		it('allows landing on human approval', () => {
			expect(canTransition('awaiting_human', 'landed')).toBe(true);
		});

		it('allows human rework with feedback (E-59)', () => {
			expect(canTransition('awaiting_human', 'reworking')).toBe(true);
		});

		it('allows human judging as failed', () => {
			expect(canTransition('awaiting_human', 'failed')).toBe(true);
		});
	});

	describe('orphaned lifecycle', () => {
		it('allows orphaned to transition to aborted when human chooses to kill', () => {
			expect(canTransition('orphaned', 'aborted')).toBe(true);
		});

		it('disallows orphaned to transition directly to running, landed, or failed', () => {
			expect(canTransition('orphaned', 'running')).toBe(false);
			expect(canTransition('orphaned', 'landed')).toBe(false);
			expect(canTransition('orphaned', 'failed')).toBe(false);
		});
	});
});
