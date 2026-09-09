import { describe, expect, it } from 'vitest';
import {
	type ReconcileRunRecord,
	type ReconcileRunsService,
	createReconcileRunsJob,
} from '../../src/jobs/reconcile-runs.ts';

describe('jobs/reconcile-runs', () => {
	it('AC 5 & E-123: marks in-flight run with dead PID as interrupted (异常终止) with actorDeviceId null', async () => {
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
			isProcessAlive: () => false, // all processes are dead
			clock: { now: () => '2026-09-09T00:00:00.000Z' },
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
			reason: '异常终止（daemon 重启）',
			endedAt: '2026-09-09T00:00:00.000Z',
			actorDeviceId: null,
		});
		expect(orphanedCalls).toHaveLength(0);
	});

	it('AC 5 & E-02: marks in-flight run with alive PID as orphaned (失联) with actorDeviceId null', async () => {
		const inFlightRuns: ReconcileRunRecord[] = [
			{ id: 'run-alive-1', taskId: 'M1-T3', pid: 20002, state: 'running' },
			{ id: 'run-alive-2', taskId: 'M1-T4', pid: 20003, state: 'awaiting_reply' },
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
			isProcessAlive: () => true, // processes are still alive in OS
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
			reason: 'daemon 重启会话失联',
			actorDeviceId: null,
		});
		expect(interruptedCalls).toHaveLength(0);
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
			isProcessAlive: () => false,
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
		};

		const job = createReconcileRunsJob({ service });
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
		};

		const job = createReconcileRunsJob({
			service,
			logFailure: (err) => failures.push(err),
		});

		job.start();
		await job.stop();

		expect(failures).toHaveLength(1);
	});

	it('supports delegate service.reconcile if provided by full run service', async () => {
		const customOutcome = [
			{
				runId: 'run-custom',
				taskId: 'M1-T10',
				previousState: 'starting',
				nextState: 'interrupted' as const,
				reason: 'process-dead' as const,
				detail: 'custom delegate',
			},
		];

		const service: ReconcileRunsService = {
			reconcile: async () => customOutcome,
		};

		const job = createReconcileRunsJob({ service });
		const outcomes = await job.runOnce();
		expect(outcomes).toEqual(customOutcome);
	});
});
