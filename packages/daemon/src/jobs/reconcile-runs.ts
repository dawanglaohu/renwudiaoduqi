import { type RunState, isReconciliationCandidate } from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';

export interface ReconcileRunRecord {
	readonly id: string;
	readonly taskId: string;
	readonly pid: number | null;
	readonly state: RunState;
}

export type ReconciledState = 'interrupted' | 'orphaned';

export interface ReconciledRunOutcome {
	readonly runId: string;
	readonly taskId: string;
	readonly previousState: RunState;
	readonly nextState: ReconciledState;
	readonly reason: 'process-dead' | 'attach-failed' | 'missing-pid' | 'probe-uncertain';
	readonly detail: string;
}

export type ProcessLiveness = 'alive' | 'dead' | 'uncertain';

export interface ProcessLivenessProbe {
	check(pid: number): ProcessLiveness;
}

export interface ReconcileRunsService {
	readonly findInFlightRuns: () => Promise<readonly ReconcileRunRecord[]>;
	readonly markInterrupted: (
		runId: string,
		details: {
			readonly reason: string;
			readonly endedAt: string;
			readonly actorDeviceId: null;
		},
	) => Promise<void>;
	readonly markOrphaned: (
		runId: string,
		details: {
			readonly reason: string;
			readonly actorDeviceId: null;
		},
	) => Promise<void>;
}

export interface ReconcileRunsJob {
	readonly name: string;
	start(): void;
	stop(): Promise<void>;
	runOnce(): Promise<readonly ReconciledRunOutcome[]>;
}

export interface ReconcileRunsDependencies {
	readonly service: ReconcileRunsService;
	readonly processProbe: ProcessLivenessProbe;
	readonly clock: { readonly now: () => string };
	readonly logFailure?: (error: unknown) => void;
}

/**
 * Startup reconciliation job for in-flight runs (E-02, E-123).
 *
 * Rules:
 * 1. Runs once during daemon startup after listen().
 * 2. Scans active in-flight runs and reconciles against OS process table (runs.pid).
 * 3. Filters non-reconciliation candidate states with isReconciliationCandidate and logs failure.
 * 4. Process check 'dead' (or missing PID) -> mark "interrupted" with reason 'daemon-restart-process-missing' (E-123).
 * 5. Process check 'alive' or 'uncertain' -> mark "orphaned" with reason 'daemon-restart-attach-failed' (E-02).
 * 6. NEVER presumes success (never marks landed / pass / completed).
 * 7. actorDeviceId is strictly null for system-initiated updates.
 * 8. Non-reentrant and catches all errors internally, never triggering unhandled rejections.
 */
export function createReconcileRunsJob(deps: ReconcileRunsDependencies): ReconcileRunsJob {
	const { service, processProbe, clock, logFailure = () => undefined } = deps;

	let inFlight: Promise<readonly ReconciledRunOutcome[]> | null = null;
	let stopRequested = false;

	async function runOnceInternal(): Promise<readonly ReconciledRunOutcome[]> {
		const inFlightRuns = await service.findInFlightRuns();
		const outcomes: ReconciledRunOutcome[] = [];

		for (const run of inFlightRuns) {
			if (stopRequested) break;

			if (!isReconciliationCandidate(run.state)) {
				logFailure(
					new AppError('E_INTERNAL', 'Run state is not a reconciliation candidate.', {
						details: { runId: run.id, state: run.state },
					}),
				);
				continue;
			}

			try {
				const hasValidPid =
					run.pid !== null && run.pid !== undefined && Number.isInteger(run.pid) && run.pid > 0;

				let liveness: ProcessLiveness = 'dead';
				if (hasValidPid) {
					try {
						liveness = processProbe.check(run.pid as number);
					} catch (error) {
						logFailure(error);
						liveness = 'uncertain';
					}
				}

				if (!hasValidPid || liveness === 'dead') {
					// Only 'dead' (or missing pid) marks interrupted (E-123)
					const now = clock.now();
					await service.markInterrupted(run.id, {
						reason: 'daemon-restart-process-missing',
						endedAt: now,
						actorDeviceId: null,
					});
					outcomes.push(
						Object.freeze({
							runId: run.id,
							taskId: run.taskId,
							previousState: run.state,
							nextState: 'interrupted',
							reason: hasValidPid ? 'process-dead' : 'missing-pid',
							detail: hasValidPid
								? `Process ${run.pid} is no longer running on daemon restart.`
								: 'Run has no recorded PID on daemon restart.',
						}),
					);
				} else {
					// Both 'alive' and 'uncertain' mark orphaned (E-02)
					await service.markOrphaned(run.id, {
						reason: 'daemon-restart-attach-failed',
						actorDeviceId: null,
					});
					outcomes.push(
						Object.freeze({
							runId: run.id,
							taskId: run.taskId,
							previousState: run.state,
							nextState: 'orphaned',
							reason: liveness === 'alive' ? 'attach-failed' : 'probe-uncertain',
							detail:
								liveness === 'alive'
									? `Process ${run.pid} is alive but unattachable on daemon restart.`
									: `Process ${run.pid} liveness is uncertain on daemon restart; marking orphaned.`,
						}),
					);
				}
			} catch (error) {
				logFailure(error);
			}
		}

		return Object.freeze(outcomes);
	}

	return Object.freeze({
		name: 'reconcile-runs',
		start(): void {
			if (inFlight !== null) return;
			const task = (async () => {
				try {
					return await runOnceInternal();
				} catch (error) {
					logFailure(error);
					return Object.freeze([]) as readonly ReconciledRunOutcome[];
				} finally {
					inFlight = null;
				}
			})();
			inFlight = task;
			if (stopRequested) {
				void task.catch(() => undefined);
			}
		},
		async stop(): Promise<void> {
			stopRequested = true;
			const running = inFlight;
			if (running !== null) {
				try {
					await running;
				} catch {
					// runOnce catches errors internally; stop never throws
				}
			}
		},
		async runOnce(): Promise<readonly ReconciledRunOutcome[]> {
			const running = inFlight;
			if (running !== null) return running;
			const task = runOnceInternal();
			inFlight = task;
			try {
				return await task;
			} finally {
				if (inFlight === task) inFlight = null;
			}
		},
	});
}
