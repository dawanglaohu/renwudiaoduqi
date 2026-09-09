import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type {
	DeleteResult,
	DiskUsageReport,
	LogFileSystem,
	TruncateResult,
} from '../logstore/contract.ts';
import type { LogstorePaths } from '../logstore/paths.ts';
import { createLogstorePrimitives } from '../logstore/primitives.ts';

export type DispatchHaltCause = 'disk_full' | 'disk_threshold';

/** Why new dispatches are stopped; the message is the English developer text carried by the warning event. */
export interface DispatchHalt {
	readonly cause: DispatchHaltCause;
	readonly message: string;
}

export interface SystemServiceDeps {
	readonly paths: LogstorePaths;
	readonly fs: LogFileSystem;
	readonly bus: EventBus;
	readonly envelopeFactory: EnvelopeFactory;
	/** Sink for E-206 violation lines; the composition root points it at the daemon run log. */
	readonly logViolation?: (message: string) => void;
	readonly warnThresholdBytes?: number;
	readonly freeThresholdBytes?: number;
}

export interface DiskWatchCheckResult {
	readonly warningIssued: boolean;
	readonly dispatchHalted: boolean;
	readonly usage: DiskUsageReport;
}

export interface SystemService {
	readonly deleteByPath: (targetPath: string) => Promise<DeleteResult>;
	readonly truncate: (targetPath: string, targetBytes?: number) => Promise<TruncateResult>;
	readonly getUsage: () => Promise<DiskUsageReport>;
	/** Non-null while new dispatches must not start (E-103 / E-104); scheduler-tick consults it before every dispatch. */
	readonly getDispatchHalt: () => DispatchHalt | null;
	readonly isDispatchHalted: () => boolean;
	/** Operator resume, e.g. after archiving; disk-watch also resumes on its own once usage is back under the thresholds. */
	readonly resumeDispatch: () => void;
	/** One disk-watch pass: measure, then halt or resume dispatch and publish `system.disk_warning` while over a threshold. */
	readonly checkDiskWatch: () => Promise<DiskWatchCheckResult>;
	/** E-104: an append hit ENOSPC under `path`; halts dispatch at once and publishes one warning per outage. */
	readonly notifyDiskFull: (path: string) => void;
	readonly getLogstoreRoot: () => string;
}

/**
 * M1's disk responsibilities (E-103, E-104, E-205): report and halt, never
 * delete. The primitives it exposes are the only write path into the run log
 * root, and which files to remove is M6's decision.
 */
export function createSystemService(deps: SystemServiceDeps): SystemService {
	const primitives = createLogstorePrimitives({
		whitelistRoot: deps.paths.rootDir,
		fs: deps.fs,
		logViolation: deps.logViolation,
		warnThresholdBytes: deps.warnThresholdBytes,
		freeThresholdBytes: deps.freeThresholdBytes,
	});
	let halt: DispatchHalt | null = null;

	function publishWarning(message: string, path: string, freeBytes: number | undefined): void {
		deps.bus.publish(
			deps.envelopeFactory.createEnvelope({
				kind: 'system.disk_warning',
				payload: { freeBytes, path, message },
			}),
		);
	}

	async function checkDiskWatch(): Promise<DiskWatchCheckResult> {
		const usage = await primitives.usage();
		if (usage.isDiskFull || usage.isWarnThresholdExceeded) {
			halt = usage.isDiskFull
				? { cause: 'disk_full', message: 'Storage disk is full; new dispatches halted.' }
				: {
						cause: 'disk_threshold',
						message: `Disk usage (${usage.dataDirBytes} bytes) exceeded warning threshold (${usage.warnThreshold} bytes); new dispatches halted.`,
					};
			publishWarning(halt.message, deps.paths.rootDir, usage.freeBytes);
			return { warningIssued: true, dispatchHalted: true, usage };
		}
		halt = null;
		return { warningIssued: false, dispatchHalted: false, usage };
	}

	function notifyDiskFull(path: string): void {
		// Every failed append during an outage lands here; the flag flips once and the bus sees one event.
		if (halt?.cause === 'disk_full') return;
		halt = { cause: 'disk_full', message: 'Storage disk is full (ENOSPC); new dispatches halted.' };
		publishWarning(halt.message, path, undefined);
	}

	return Object.freeze({
		deleteByPath: primitives.deleteByPath,
		truncate: primitives.truncate,
		getUsage: primitives.usage,
		getDispatchHalt: (): DispatchHalt | null => halt,
		isDispatchHalted: (): boolean => halt !== null,
		resumeDispatch: (): void => {
			halt = null;
		},
		checkDiskWatch,
		notifyDiskFull,
		getLogstoreRoot: (): string => deps.paths.rootDir,
	});
}
