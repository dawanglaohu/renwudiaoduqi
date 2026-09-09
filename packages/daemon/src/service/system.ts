import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type {
	DeleteResult,
	DiskUsageReport,
	LogFileSystem,
	TruncateResult,
} from '../logstore/contract.ts';
import type { LogstorePaths } from '../logstore/paths.ts';
import {
	type DispatchState,
	createDispatchState,
	createLogstorePrimitives,
} from '../logstore/primitives.ts';

export interface SystemServiceDeps {
	readonly paths: LogstorePaths;
	readonly fs: LogFileSystem;
	readonly bus: EventBus;
	readonly envelopeFactory: EnvelopeFactory;
	readonly logViolation?: (message: string) => void;
	readonly warnThresholdBytes?: number;
	readonly freeThresholdBytes?: number;
	readonly dispatchState?: DispatchState;
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
	readonly isDispatchHalted: () => boolean;
	readonly setDispatchHalted: (halted: boolean, reason?: string) => void;
	readonly getHaltedReason: () => string | null;
	readonly checkDiskWatch: () => Promise<DiskWatchCheckResult>;
	readonly notifyDiskFull: (path: string) => void;
	readonly getLogstoreRoot: () => string;
}

export function createSystemService(deps: SystemServiceDeps): SystemService {
	const dispatchState = deps.dispatchState ?? createDispatchState();
	const primitives = createLogstorePrimitives({
		whitelistRoot: deps.paths.rootDir,
		fs: deps.fs,
		logViolation: deps.logViolation,
		warnThresholdBytes: deps.warnThresholdBytes,
		freeThresholdBytes: deps.freeThresholdBytes,
		dispatchState,
	});

	/**
	 * E-103, E-205: Check disk usage against warning threshold.
	 * - When exceeded or full: sets dispatch halted and emits `system.disk_warning`.
	 * - M1 NEVER automatically deletes any log files (E-205).
	 */
	async function checkDiskWatch(): Promise<DiskWatchCheckResult> {
		const usage = await primitives.usage();
		let warningIssued = false;

		if (usage.isWarnThresholdExceeded || usage.isDiskFull) {
			dispatchState.setHalted(
				true,
				usage.isDiskFull
					? 'Storage disk is full.'
					: `Disk usage (${usage.dataDirBytes} bytes) exceeded warning threshold (${usage.warnThreshold} bytes).`,
			);

			const envelope = deps.envelopeFactory.createEnvelope({
				kind: 'system.disk_warning',
				payload: {
					freeBytes: usage.freeBytes,
					path: deps.paths.rootDir,
					message: usage.isDiskFull
						? 'Storage disk is full; new dispatches halted.'
						: `Disk usage (${usage.dataDirBytes} bytes) exceeded warning threshold (${usage.warnThreshold} bytes); new dispatches halted.`,
				},
			});
			deps.bus.publish(envelope);
			warningIssued = true;
		} else if (dispatchState.isHalted()) {
			// Space recovered below warning threshold and not full
			dispatchState.setHalted(false);
		}

		return {
			warningIssued,
			dispatchHalted: dispatchState.isHalted(),
			usage,
		};
	}

	/**
	 * E-104: Storage disk write full notification.
	 * Sets dispatch halted immediately and emits `system.disk_warning`.
	 */
	function notifyDiskFull(path: string): void {
		dispatchState.setHalted(true, `Disk full on path: ${path}`);
		const envelope = deps.envelopeFactory.createEnvelope({
			kind: 'system.disk_warning',
			payload: {
				freeBytes: 0,
				path,
				message: 'Storage disk is full (ENOSPC); new dispatches halted.',
			},
		});
		deps.bus.publish(envelope);
	}

	return Object.freeze({
		deleteByPath: primitives.deleteByPath,
		truncate: primitives.truncate,
		getUsage: primitives.usage,
		isDispatchHalted: dispatchState.isHalted,
		setDispatchHalted: dispatchState.setHalted,
		getHaltedReason: dispatchState.getHaltedReason,
		checkDiskWatch,
		notifyDiskFull,
		getLogstoreRoot: () => deps.paths.rootDir,
	});
}
