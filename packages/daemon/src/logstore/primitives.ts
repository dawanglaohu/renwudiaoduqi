import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
	DEFAULT_DISK_WARN_THRESHOLD_BYTES,
	DEFAULT_FREE_DISK_THRESHOLD_BYTES,
	type DeleteResult,
	type DiskUsageReport,
	type LogFileSystem,
	type RunUsage,
	type TruncateResult,
} from './contract.ts';
import { getNodeErrorCode, isEbusy, isEnoent } from './fs-errors.ts';
import { createNodeLogFileSystem } from './node-log-file-system.ts';

/**
 * System and database files that must never be targeted by logstore deletion
 * or truncation primitives even if located under the root directory.
 */
export const PROTECTED_SYSTEM_FILE_NAMES = new Set([
	'app.db',
	'app.db-wal',
	'app.db-shm',
	'daemon.json',
	'pairing-code.txt',
	'instance.lock',
]);

export interface DispatchState {
	readonly isHalted: () => boolean;
	readonly setHalted: (halted: boolean, reason?: string) => void;
	readonly getHaltedReason: () => string | null;
}

export function createDispatchState(): DispatchState {
	let halted = false;
	let reason: string | null = null;
	return Object.freeze({
		isHalted(): boolean {
			return halted;
		},
		setHalted(nextHalted: boolean, nextReason?: string): void {
			halted = nextHalted;
			reason = nextHalted ? (nextReason ?? 'Disk threshold reached or disk is full.') : null;
		},
		getHaltedReason(): string | null {
			return reason;
		},
	});
}

/**
 * Checks whether targetPath is strictly and safely inside the whitelist directory.
 * E-206: candidates outside the whitelist directory are rejected.
 */
export function isPathWithinWhitelist(targetPath: string, whitelistRoot: string): boolean {
	const resolvedRoot = resolve(whitelistRoot);
	const resolvedTarget = resolve(targetPath);

	const rel = relative(resolvedRoot, resolvedTarget);
	// Empty rel means target IS the root itself (deleting the entire root is prohibited)
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
		return false;
	}

	// Reject protected core database/lock/config files
	const base = basename(resolvedTarget);
	if (PROTECTED_SYSTEM_FILE_NAMES.has(base)) {
		return false;
	}

	return true;
}

export interface DeleteByPathOptions {
	readonly whitelistRoot: string;
	readonly fs?: LogFileSystem;
	readonly logViolation?: (message: string) => void;
}

/**
 * E-204, E-205, E-206: Restricted delete primitive without business semantics.
 * - E-206: Refuses any path outside the whitelist directory and logs a security violation.
 * - E-204: Returns a typed retryable error when the target file is locked or currently
 *   being read (EBUSY / EPERM on Windows) instead of throwing an exception.
 */
export async function deleteByPath(
	targetPath: string,
	options: DeleteByPathOptions,
): Promise<DeleteResult> {
	const { whitelistRoot, fs = createNodeLogFileSystem(), logViolation } = options;

	// E-206 whitelist check
	if (!isPathWithinWhitelist(targetPath, whitelistRoot)) {
		const violationMsg = `[SECURITY_VIOLATION] Refused deletion request for path outside whitelist: "${targetPath}" (whitelistRoot: "${whitelistRoot}")`;
		logViolation?.(violationMsg);
		return {
			ok: false,
			retryable: false,
			code: 'E_FORBIDDEN',
			message: 'Path is outside the allowed whitelist directory.',
			path: targetPath,
		};
	}

	// Calculate bytes freed before deleting
	let bytesFreed = 0;
	try {
		const len = fs.fileLenSync(targetPath);
		if (len !== null) {
			bytesFreed = len;
		}
	} catch {
		// Ignore stat error; will be handled during deletion
	}

	try {
		if (typeof fs.deleteFile === 'function') {
			await fs.deleteFile(targetPath);
		} else {
			const { rm } = await import('node:fs/promises');
			await rm(targetPath, { recursive: true, force: false });
		}
		return {
			ok: true,
			path: targetPath,
			bytesFreed,
		};
	} catch (cause) {
		// E-204: target is currently open/read (EBUSY / EPERM on Windows).
		// Return retryable error instead of throwing an exception!
		if (isEbusy(cause)) {
			return {
				ok: false,
				retryable: true,
				code: 'EBUSY',
				message: 'The target file is currently being read or locked by another handle.',
				path: targetPath,
			};
		}
		if (isEnoent(cause) || getNodeErrorCode(cause) === 'E_LOG_FILE_MISSING') {
			return {
				ok: false,
				retryable: false,
				code: 'E_LOG_FILE_MISSING',
				message: 'The target file does not exist.',
				path: targetPath,
			};
		}
		return {
			ok: false,
			retryable: false,
			code: 'E_INTERNAL',
			message: cause instanceof Error ? cause.message : 'File deletion failed.',
			path: targetPath,
		};
	}
}

export interface TruncateOptions {
	readonly whitelistRoot: string;
	readonly fs?: LogFileSystem;
	readonly logViolation?: (message: string) => void;
}

/**
 * Truncates a log file to targetBytes (default 0) within the whitelist directory.
 * E-204: Returns a retryable error on EBUSY instead of throwing.
 * E-206: Refuses paths outside the whitelist and logs a violation.
 */
export async function truncate(
	targetPath: string,
	targetBytes: number,
	options: TruncateOptions,
): Promise<TruncateResult> {
	const { whitelistRoot, fs = createNodeLogFileSystem(), logViolation } = options;

	// E-206 whitelist check
	if (!isPathWithinWhitelist(targetPath, whitelistRoot)) {
		const violationMsg = `[SECURITY_VIOLATION] Refused truncation request for path outside whitelist: "${targetPath}" (whitelistRoot: "${whitelistRoot}")`;
		logViolation?.(violationMsg);
		return {
			ok: false,
			retryable: false,
			code: 'E_FORBIDDEN',
			message: 'Path is outside the allowed whitelist directory.',
			path: targetPath,
		};
	}

	const currentLen = fs.fileLenSync(targetPath);
	if (currentLen === null) {
		return {
			ok: false,
			retryable: false,
			code: 'E_LOG_FILE_MISSING',
			message: 'The target file does not exist.',
			path: targetPath,
		};
	}

	if (currentLen <= targetBytes) {
		return {
			ok: true,
			path: targetPath,
			bytesFreed: 0,
			newSize: currentLen,
		};
	}

	try {
		if (typeof fs.truncateFile === 'function') {
			await fs.truncateFile(targetPath, targetBytes);
		} else {
			const { truncate: truncateFs } = await import('node:fs/promises');
			await truncateFs(targetPath, targetBytes);
		}
		return {
			ok: true,
			path: targetPath,
			bytesFreed: currentLen - targetBytes,
			newSize: targetBytes,
		};
	} catch (cause) {
		// E-204: target is currently open/locked
		if (isEbusy(cause)) {
			return {
				ok: false,
				retryable: true,
				code: 'EBUSY',
				message: 'The target file is currently being read or locked by another handle.',
				path: targetPath,
			};
		}
		if (isEnoent(cause) || getNodeErrorCode(cause) === 'E_LOG_FILE_MISSING') {
			return {
				ok: false,
				retryable: false,
				code: 'E_LOG_FILE_MISSING',
				message: 'The target file does not exist.',
				path: targetPath,
			};
		}
		return {
			ok: false,
			retryable: false,
			code: 'E_INTERNAL',
			message: cause instanceof Error ? cause.message : 'File truncation failed.',
			path: targetPath,
		};
	}
}

export interface UsageOptions {
	readonly whitelistRoot: string;
	readonly fs?: LogFileSystem;
	readonly warnThresholdBytes?: number;
	readonly freeThresholdBytes?: number;
	readonly dispatchState?: DispatchState;
}

/**
 * Calculates log disk usage statistics across all runs in the log root.
 * E-103: Groups usage by run, sorted by bytes descending (top consumers first).
 */
export async function calculateDiskUsage(options: UsageOptions): Promise<DiskUsageReport> {
	const {
		whitelistRoot,
		fs = createNodeLogFileSystem(),
		warnThresholdBytes = DEFAULT_DISK_WARN_THRESHOLD_BYTES,
		freeThresholdBytes = DEFAULT_FREE_DISK_THRESHOLD_BYTES,
		dispatchState,
	} = options;

	const entries = fs.listDirectory(whitelistRoot);
	const byRun: RunUsage[] = [];
	let totalBytes = 0;

	for (const entry of entries) {
		const entryPath = join(whitelistRoot, entry);
		const files = fs.listDirectory(entryPath);
		if (files.length > 0) {
			let runBytes = 0;
			let fileCount = 0;
			for (const file of files) {
				const filePath = join(entryPath, file);
				const len = fs.fileLenSync(filePath);
				if (len !== null) {
					runBytes += len;
					fileCount += 1;
				}
			}
			byRun.push({ runId: entry, bytes: runBytes, fileCount });
			totalBytes += runBytes;
		} else {
			const len = fs.fileLenSync(entryPath);
			if (len !== null) {
				totalBytes += len;
			}
		}
	}

	// Sort runs by bytes descending (E-103: top space-consuming runs first)
	byRun.sort((a, b) => b.bytes - a.bytes);

	let freeBytes: number | undefined;
	let diskCapacityBytes: number | undefined;
	if (typeof fs.statfs === 'function') {
		try {
			const stat = await fs.statfs(whitelistRoot);
			freeBytes = stat.bavail * stat.bsize;
			diskCapacityBytes = stat.blocks * stat.bsize;
		} catch {
			// statfs optional depending on environment
		}
	}

	const isWarnThresholdExceeded =
		totalBytes >= warnThresholdBytes || (freeBytes !== undefined && freeBytes < freeThresholdBytes);

	const isDiskFull = Boolean(
		(freeBytes !== undefined && freeBytes === 0) ||
			(dispatchState?.isHalted() &&
				(dispatchState.getHaltedReason()?.toLowerCase().includes('full') ?? false)),
	);

	return Object.freeze({
		dataDirBytes: totalBytes,
		byRun: Object.freeze(byRun),
		warnThreshold: warnThresholdBytes,
		freeBytes,
		totalBytes: diskCapacityBytes,
		isWarnThresholdExceeded,
		isDiskFull,
	});
}

export interface LogstorePrimitivesDeps {
	readonly whitelistRoot: string;
	readonly fs?: LogFileSystem;
	readonly logViolation?: (message: string) => void;
	readonly warnThresholdBytes?: number;
	readonly freeThresholdBytes?: number;
	readonly dispatchState?: DispatchState;
}

export interface LogstorePrimitives {
	readonly deleteByPath: (targetPath: string) => Promise<DeleteResult>;
	readonly truncate: (targetPath: string, targetBytes?: number) => Promise<TruncateResult>;
	readonly usage: () => Promise<DiskUsageReport>;
	readonly dispatchState: DispatchState;
}

export function createLogstorePrimitives(deps: LogstorePrimitivesDeps): LogstorePrimitives {
	const dispatchState = deps.dispatchState ?? createDispatchState();
	return Object.freeze({
		deleteByPath(targetPath: string): Promise<DeleteResult> {
			return deleteByPath(targetPath, {
				whitelistRoot: deps.whitelistRoot,
				fs: deps.fs,
				logViolation: deps.logViolation,
			});
		},
		truncate(targetPath: string, targetBytes = 0): Promise<TruncateResult> {
			return truncate(targetPath, targetBytes, {
				whitelistRoot: deps.whitelistRoot,
				fs: deps.fs,
				logViolation: deps.logViolation,
			});
		},
		usage(): Promise<DiskUsageReport> {
			return calculateDiskUsage({
				whitelistRoot: deps.whitelistRoot,
				fs: deps.fs,
				warnThresholdBytes: deps.warnThresholdBytes,
				freeThresholdBytes: deps.freeThresholdBytes,
				dispatchState,
			});
		},
		dispatchState,
	});
}
