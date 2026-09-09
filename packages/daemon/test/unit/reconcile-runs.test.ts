import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.ts';
import {
	type ReconcileRunRecord,
	type ReconcileRunsService,
	createReconcileRunsJob,
} from '../../src/jobs/reconcile-runs.ts';

const MOCK_CLOCK = Object.freeze({
	now: () => '2026-09-09T00:00:00.000Z',
});

describe('jobs/reconcile-runs', () => {
	it('AC 5 & E-123: marks in-flight run with dead PID as interrupted with actorDeviceId null and daemon-restart-process-missing', async () => {
		const inFlightRuns: ReconcileRunRecord[] = [
			{ id: 'run-dead-1', taskId: 'M1-T1', pid: 10001, state: 'running' },
			{ id: 'run-no-pid', taskId: 'M1-T2', pid: null, state: 'starting' },
		];

		const interruptedCalls: Array<{ runId: string; details: unknown }> = [];
		const orphanedCalls: Array<{ runId: string; details: unknown }> = [];

		const service: ReconcileRunsService = {
			findInFlightRuns: async () => inFlightRuns,
			markInterrupted: async (runId, details) => {
				interruptedCalls.push({ runId, details });
			},
			markOrphaned: async (runId, details) => {
				orphanedCalls.push({ runId, details });
			},
		};

		const job = createReconcileRunsJob({
			service,
			processProbe: { check: () => 'dead' },
			clock: MOCK_CLOCK,
		});

		const outcomes = await job.runOnce();

		expect(outcomes).toHaveLength(2);
		expect(outcomes[0]).toMatchObject({
			runId: 'run-dead-1',
			taskId: 'M1-T1',
			previousState: 'running',
			nextState: 'interrupted',
			reason: 'process-dead',
		});
		expect(outcomes[1]).toMatchObject({
			runId: 'run-no-pid',
			taskId: 'M1-T2',
			previousState: 'starting',
			nextState: 'interrupted',
			reason: 'missing-pid',
		});

		expect(interruptedCalls).toHaveLength(2);
		expect(interruptedCalls[0]?.details).toEqual({
			reason: 'daemon-restart-process-missing',
			endedAt: '2026-09-09T00:00:00.000Z',
			actorDeviceId: null,
		});
		expect(orphanedCalls).toHaveLength(0);
	});

	it('AC 5 & E-02: marks in-flight run with alive PID as orphaned with actorDeviceId null and daemon-restart-attach-failed', async () => {
		const inFlightRuns: ReconcileRunRecord[] = [
			{ id: 'run-alive-1', taskId: 'M1-T3', pid: 20002, state: 'running' },
			{
				id: 'run-alive-2',
				taskId: 'M1-T4',
				pid: 20003,
				state: 'awaiting_reply',
			},
		];

		const interruptedCalls: Array<{ runId: string; details: unknown }> = [];
		const orphanedCalls: Array<{ runId: string; details: unknown }> = [];

		const service: ReconcileRunsService = {
			findInFlightRuns: async () => inFlightRuns,
			markInterrupted: async (runId, details) => {
				interruptedCalls.push({ runId, details });
			},
			markOrphaned: async (runId, details) => {
				orphanedCalls.push({ runId, details });
			},
		};

		const job = createReconcileRunsJob({
			service,
			processProbe: { check: () => 'alive' },
			clock: MOCK_CLOCK,
		});

		const outcomes = await job.runOnce();

		expect(outcomes).toHaveLength(2);
		expect(outcomes[0]).toMatchObject({
			runId: 'run-alive-1',
			taskId: 'M1-T3',
			previousState: 'running',
			nextState: 'orphaned',
			reason: 'attach-failed',
		});
		expect(outcomes[1]).toMatchObject({
			runId: 'run-alive-2',
			taskId: 'M1-T4',
			previousState: 'awaiting_reply',
			nextState: 'orphaned',
			reason: 'attach-failed',
		});

		expect(orphanedCalls).toHaveLength(2);
		expect(orphanedCalls[0]?.details).toEqual({
			reason: 'daemon-restart-attach-failed',
			actorDeviceId: null,
		});
		expect(interruptedCalls).toHaveLength(0);
	});

	it('AC 5 & R2: marks in-flight run with uncertain PID as orphaned', async () => {
		const inFlightRuns: ReconcileRunRecord[] = [
			{ id: 'run-uncertain-1', taskId: 'M1-T5', pid: 30003, state: 'running' },
		];

		const interruptedCalls: Array<{ runId: string; details: unknown }> = [];
		const orphanedCalls: Array<{ runId: string; details: unknown }> = [];

		const service: ReconcileRunsService = {
			findInFlightRuns: async () => inFlightRuns,
			markInterrupted: async (runId, details) => {
				interruptedCalls.push({ runId, details });
			},
			markOrphaned: async (runId, details) => {
				orphanedCalls.push({ runId, details });
			},
		};

		const job = createReconcileRunsJob({
			service,
			processProbe: { check: () => 'uncertain' },
			clock: MOCK_CLOCK,
		});

		const outcomes = await job.runOnce();

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			runId: 'run-uncertain-1',
			taskId: 'M1-T5',
			previousState: 'running',
			nextState: 'orphaned',
			reason: 'probe-uncertain',
		});

		expect(orphanedCalls).toHaveLength(1);
		expect(orphanedCalls[0]?.details).toEqual({
			reason: 'daemon-restart-attach-failed',
			actorDeviceId: null,
		});
		expect(interruptedCalls).toHaveLength(0);
	});

	it('filters non-reconciliation candidate states with isReconciliationCandidate and logs failure', async () => {
		const inFlightRuns: ReconcileRunRecord[] = [
			{ id: 'run-landed', taskId: 'M1-T6', pid: 40001, state: 'landed' },
			{ id: 'run-valid', taskId: 'M1-T7', pid: 40002, state: 'starting' },
		];

		const failures: unknown[] = [];
		const service: ReconcileRunsService = {
			findInFlightRuns: async () => inFlightRuns,
			markInterrupted: async () => undefined,
			markOrphaned: async () => undefined,
		};

		const job = createReconcileRunsJob({
			service,
			processProbe: { check: () => 'dead' },
			clock: MOCK_CLOCK,
			logFailure: (err) => failures.push(err),
		});

		const outcomes = await job.runOnce();

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]?.runId).toBe('run-valid');
		expect(failures).toHaveLength(1);
		expect(failures[0]).toBeInstanceOf(AppError);
		expect((failures[0] as AppError).code).toBe('E_INTERNAL');
		expect((failures[0] as AppError).details).toEqual({ runId: 'run-landed', state: 'landed' });
	});

	it('AC 5: NEVER presumes success (never transitions to landed or pass)', async () => {
		const inFlightRuns: ReconcileRunRecord[] = [
			{ id: 'run-1', taskId: 'M1-T1', pid: 30001, state: 'running' },
		];

		const statesTransitionedTo: string[] = [];

		const service: ReconcileRunsService = {
			findInFlightRuns: async () => inFlightRuns,
			markInterrupted: async () => {
				statesTransitionedTo.push('interrupted');
			},
			markOrphaned: async () => {
				statesTransitionedTo.push('orphaned');
			},
		};

		const job = createReconcileRunsJob({
			service,
			processProbe: { check: () => 'dead' },
			clock: MOCK_CLOCK,
		});

		const outcomes = await job.runOnce();

		for (const outcome of outcomes) {
			expect(outcome.nextState).not.toBe('landed');
			expect(outcome.nextState).not.toBe('pass');
			expect(outcome.nextState).not.toBe('completed');
			expect(['interrupted', 'orphaned']).toContain(outcome.nextState);
		}

		expect(statesTransitionedTo.every((s) => s === 'interrupted' || s === 'orphaned')).toBe(true);
	});

	it('non-reentrancy: concurrent start() calls run at most once', async () => {
		let findCalls = 0;
		let releaseGate: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});

		const service: ReconcileRunsService = {
			findInFlightRuns: async () => {
				findCalls++;
				await gate;
				return [];
			},
			markInterrupted: async () => undefined,
			markOrphaned: async () => undefined,
		};

		const job = createReconcileRunsJob({
			service,
			processProbe: { check: () => 'dead' },
			clock: MOCK_CLOCK,
		});
		job.start();
		job.start(); // second start must be ignored

		releaseGate();
		await job.stop();

		expect(findCalls).toBe(1);
	});

	it('catches and logs errors without unhandled rejections', async () => {
		const failures: unknown[] = [];
		const service: ReconcileRunsService = {
			findInFlightRuns: async () => {
				throw new Error('Database locked');
			},
			markInterrupted: async () => undefined,
			markOrphaned: async () => undefined,
		};

		const job = createReconcileRunsJob({
			service,
			processProbe: { check: () => 'dead' },
			clock: MOCK_CLOCK,
			logFailure: (err) => failures.push(err),
		});

		job.start();
		await job.stop();

		expect(failures).toHaveLength(1);
	});
});
