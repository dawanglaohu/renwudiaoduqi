import type { DiskWatchCheckResult, SystemService } from '../service/system.ts';

export interface DiskWatchJobDeps {
	readonly service: SystemService;
	readonly intervalMs?: number;
	readonly logFailure?: (error: unknown) => void;
}

export interface DiskWatchJob {
	readonly name: string;
	start(): void;
	stop(): Promise<void>;
	runOnce(): Promise<DiskWatchCheckResult | null>;
}

const DEFAULT_DISK_WATCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Background job running every 5 minutes:
 * E-103, E-104: Checks disk usage against warning threshold.
 * If exceeded, marks dispatch halted and issues `system.disk_warning`.
 * E-205: M1 only reports warning/halt, NEVER deletes any text files.
 */
export function createDiskWatchJob(deps: DiskWatchJobDeps): DiskWatchJob {
	const { service, intervalMs = DEFAULT_DISK_WATCH_INTERVAL_MS, logFailure } = deps;
	let timer: NodeJS.Timeout | null = null;
	let inFlight: Promise<DiskWatchCheckResult | null> | null = null;
	let stopRequested = false;

	async function runOnceInternal(): Promise<DiskWatchCheckResult | null> {
		try {
			return await service.checkDiskWatch();
		} catch (error) {
			logFailure?.(error);
			return null;
		}
	}

	function tick(): void {
		if (inFlight !== null || stopRequested) return;
		inFlight = (async () => {
			try {
				return await runOnceInternal();
			} finally {
				inFlight = null;
			}
		})();
		void inFlight.catch(() => undefined);
	}

	return Object.freeze({
		name: 'disk-watch',
		start(): void {
			stopRequested = false;
			if (timer !== null) return;
			tick();
			timer = setInterval(tick, intervalMs);
			if (typeof timer.unref === 'function') {
				timer.unref();
			}
		},
		async stop(): Promise<void> {
			stopRequested = true;
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
			const running = inFlight;
			if (running !== null) {
				try {
					await running;
				} catch {
					// runOnce catches errors; stop never throws
				}
			}
		},
		async runOnce(): Promise<DiskWatchCheckResult | null> {
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
