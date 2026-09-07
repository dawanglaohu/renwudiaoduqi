import type { LogstoreService, RepairRunReport } from '../service/logstore.ts';

export interface LogIndexRepairJob {
	readonly name: string;
	start(): void;
	stop(): Promise<void>;
	runOnce(): Promise<readonly RepairRunReport[]>;
}

/**
 * Startup job: every run's events.ndjson is scanned from its last indexed
 * `byte_offset + byte_len` (or the file start for unregistered tail files) up
 * to EOF, and missing index rows are back-filled — file-ahead-of-index is the
 * normal crash window (E-24), index-ahead-of-file is corruption and surfaces
 * as an error entry, never silent (E-24).
 *
 * Strict layering (R2 / R5): this job ONLY calls the logstore service. It
 * never imports `repo` or `db`.
 */
export function createLogIndexRepairJob(deps: {
	readonly service: LogstoreService;
	readonly logFailure: (error: unknown) => void;
}): LogIndexRepairJob {
	const { service, logFailure } = deps;
	let inFlight: Promise<readonly RepairRunReport[]> | null = null;
	let stopRequested = false;

	async function runOnceInternal(): Promise<readonly RepairRunReport[]> {
		return service.repairAll();
	}

	return Object.freeze({
		name: 'log-index-repair',
		start(): void {
			if (inFlight !== null) return;
			const task = (async () => {
				try {
					return await runOnceInternal();
				} catch (error) {
					logFailure(error);
					return [] as readonly RepairRunReport[];
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
					// runOnce already catches and logs; stop() never throws.
				}
			}
		},
		async runOnce(): Promise<readonly RepairRunReport[]> {
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
