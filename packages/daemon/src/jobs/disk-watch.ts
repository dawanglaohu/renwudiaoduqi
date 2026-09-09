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
	/** One pass outside the timer; joins an in-flight pass instead of starting a second one. */
	runOnce(): Promise<DiskWatchCheckResult | null>;
}

const DEFAULT_DISK_WATCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * disk-watch (08 节 jobs table): every 5 minutes ask SystemService to measure
 * the run log root and halt or resume new dispatches (E-103 / E-104). The job
 * owns only the timer and re-entrancy; it never touches the filesystem and
 * never deletes anything (E-205). A failing pass is handed to `logFailure`.
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

	function runGuarded(): Promise<DiskWatchCheckResult | null> {
		if (inFlight !== null) return inFlight;
		const pass = runOnceInternal().finally(() => {
			if (inFlight === pass) inFlight = null;
		});
		inFlight = pass;
		return pass;
	}

	function tick(): void {
		if (stopRequested) return;
		void runGuarded();
	}

	return Object.freeze({
		name: 'disk-watch',
		start(): void {
			stopRequested = false;
			if (timer !== null) return;
			tick();
			timer = setInterval(tick, intervalMs);
			timer.unref();
		},
		async stop(): Promise<void> {
			stopRequested = true;
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
			if (inFlight !== null) await inFlight;
		},
		runOnce(): Promise<DiskWatchCheckResult | null> {
			return runGuarded();
		},
	});
}
