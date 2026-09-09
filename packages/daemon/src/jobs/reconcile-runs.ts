export interface ReconcileRunRecord {
	readonly id: string;
	readonly taskId: string;
	readonly pid: number | null;
	readonly state: string;
}

export type ReconciledState = 'interrupted' | 'orphaned';

export interface ReconciledRunOutcome {
	readonly runId: string;
	readonly taskId: string;
	readonly previousState: string;
	readonly nextState: ReconciledState;
	readonly reason: 'process-dead' | 'attach-failed' | 'missing-pid';
	readonly detail: string;
}

export interface ReconcileRunsService {
	readonly findInFlightRuns?: () => Promise<readonly ReconcileRunRecord[]>;
	readonly markInterrupted?: (
		runId: string,
		details: {
			readonly reason: string;
			readonly endedAt: string;
			readonly actorDeviceId: null;
		},
	) => Promise<void>;
	readonly markOrphaned?: (
		runId: string,
		details: {
			readonly reason: string;
			readonly actorDeviceId: null;
		},
	) => Promise<void>;
	readonly reconcile?: (
		isProcessAlive: (pid: number) => boolean | Promise<boolean>,
	) => Promise<readonly ReconciledRunOutcome[]>;
}

export interface ReconcileRunsJob {
	readonly name: string;
	start(): void;
	stop(): Promise<void>;
	runOnce(): Promise<readonly ReconciledRunOutcome[]>;
}

export interface ReconcileRunsDependencies {
	readonly service: ReconcileRunsService;
	readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
	readonly clock?: { readonly now: () => string };
	readonly logFailure?: (error: unknown) => void;
}

function defaultProcessLivenessProbe(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Startup reconciliation job for in-flight runs (E-02, E-123).
 *
 * Rules:
 * 1. Runs once during daemon startup after listen().
 * 2. Scans active in-flight runs and reconciles against OS process table (runs.pid).
 * 3. Process does NOT exist -> mark "interrupted" (异常终止) (E-123).
 * 4. Process DOES exist but unattachable -> mark "orphaned" (失联) (E-02).
 * 5. NEVER presumes success (never marks landed / pass / completed).
 * 6. actorDeviceId is strictly null for system-initiated updates.
 * 7. Non-reentrant and catches all errors internally, never triggering unhandled rejections.
 */
export function createReconcileRunsJob(deps: ReconcileRunsDependencies): ReconcileRunsJob {
	const {
		service,
		isProcessAlive = defaultProcessLivenessProbe,
		clock = Object.freeze({ now: () => new Date().toISOString() }),
		logFailure = () => undefined,
	} = deps;

	let inFlight: Promise<readonly ReconciledRunOutcome[]> | null = null;
	let stopRequested = false;

	async function runOnceInternal(): Promise<readonly ReconciledRunOutcome[]> {
		if (typeof service.reconcile === 'function') {
			return await service.reconcile(isProcessAlive);
		}

		if (typeof service.findInFlightRuns !== 'function') {
			return Object.freeze([]);
		}

		const inFlightRuns = await service.findInFlightRuns();
		const outcomes: ReconciledRunOutcome[] = [];

		for (const run of inFlightRuns) {
			if (stopRequested) break;

			try {
				const hasValidPid =
					run.pid !== null && run.pid !== undefined && Number.isInteger(run.pid) && run.pid > 0;

				let alive = false;
				if (hasValidPid) {
					try {
						alive = await isProcessAlive(run.pid as number);
					} catch {
						alive = false;
					}
				}

				if (!alive) {
					// E-123: Process is dead / missing -> interrupted ("异常终止（daemon 重启）")
					const now = clock.now();
					if (typeof service.markInterrupted === 'function') {
						await service.markInterrupted(run.id, {
							reason: '异常终止（daemon 重启）',
							endedAt: now,
							actorDeviceId: null,
						});
					}
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
					// E-02: Process is alive but cannot re-attach -> orphaned ("失联")
					if (typeof service.markOrphaned === 'function') {
						await service.markOrphaned(run.id, {
							reason: 'daemon 重启会话失联',
							actorDeviceId: null,
						});
					}
					outcomes.push(
						Object.freeze({
							runId: run.id,
							taskId: run.taskId,
							previousState: run.state,
							nextState: 'orphaned',
							reason: 'attach-failed',
							detail: `Process ${run.pid} is alive but unattachable on daemon restart.`,
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
