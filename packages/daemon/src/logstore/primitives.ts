import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { AppError } from '../errors/app-error.ts';
import {
	DEFAULT_DISK_WARN_THRESHOLD_BYTES,
	DEFAULT_FREE_DISK_THRESHOLD_BYTES,
	type DeleteResult,
	type DiskUsageReport,
	type LogFileSystem,
	type RestrictedOpFailure,
	type RunUsage,
	type TruncateResult,
} from './contract.ts';
import { isBusyCause, isEnoent } from './fs-errors.ts';

/**
 * Names the restricted primitives refuse even inside the whitelist root: the
 * database with its WAL/SHM companions, process config, pairing code and the
 * instance lock. The run log root never legitimately contains them.
 */
export const PROTECTED_SYSTEM_FILE_NAMES = new Set([
	'app.db',
	'app.db-wal',
	'app.db-shm',
	'daemon.json',
	'pairing-code.txt',
	'instance.lock',
]);

/**
 * E-206: `targetPath` must resolve strictly inside `whitelistRoot`. The root
 * itself, traversal above it, another volume and protected names are refused.
 * Pure path arithmetic: symlinks inside the root are not resolved.
 */
export function isPathWithinWhitelist(targetPath: string, whitelistRoot: string): boolean {
	const resolvedRoot = resolve(whitelistRoot);
	const resolvedTarget = resolve(targetPath);

	const rel = relative(resolvedRoot, resolvedTarget);
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
		return false;
	}

	return !PROTECTED_SYSTEM_FILE_NAMES.has(basename(resolvedTarget));
}

export interface RestrictedFsOptions {
	/** Run log root (09 节 `runs/`), the only directory these primitives may modify. */
	readonly whitelistRoot: string;
	readonly fs: LogFileSystem;
	/** Receives one line per refused request (E-206 violation log). */
	readonly logViolation?: (message: string) => void;
}

/**
 * E-204 / E-206: delete a segment file or a whole run directory under the
 * whitelist root. Never throws: a whitelist violation is refused and logged,
 * EBUSY/EPERM comes back as a retryable failure, anything else as a typed
 * non-retryable one. `bytesFreed` sums the files of a run directory.
 */
export async function deleteByPath(
	targetPath: string,
	options: RestrictedFsOptions,
): Promise<DeleteResult> {
	const refused = refuseOutsideWhitelist('deletion', targetPath, options);
	if (refused !== null) return refused;
	try {
		const bytesFreed = measureBytes(options.fs, targetPath);
		await options.fs.deleteFile(targetPath);
		return { ok: true, path: targetPath, bytesFreed };
	} catch (cause) {
		return toOpFailure(cause, targetPath, 'File deletion failed.');
	}
}

/**
 * Same contract as deleteByPath, shrinking one file to `targetBytes`; a file
 * that is already at or below that size is reported as ok with nothing freed.
 */
export async function truncate(
	targetPath: string,
	targetBytes: number,
	options: RestrictedFsOptions,
): Promise<TruncateResult> {
	const refused = refuseOutsideWhitelist('truncation', targetPath, options);
	if (refused !== null) return refused;
	try {
		const currentLen = options.fs.fileLenSync(targetPath);
		if (currentLen === null) return missingFailure(targetPath);
		if (currentLen <= targetBytes) {
			return { ok: true, path: targetPath, bytesFreed: 0, newSize: currentLen };
		}
		await options.fs.truncateFile(targetPath, targetBytes);
		return {
			ok: true,
			path: targetPath,
			bytesFreed: currentLen - targetBytes,
			newSize: targetBytes,
		};
	} catch (cause) {
		return toOpFailure(cause, targetPath, 'File truncation failed.');
	}
}

export interface UsageOptions {
	readonly whitelistRoot: string;
	readonly fs: LogFileSystem;
	readonly warnThresholdBytes?: number;
	readonly freeThresholdBytes?: number;
}

/**
 * E-103: bytes per run directory under the root, largest first, plus the
 * volume's free space when statfs answers. A missing root counts as empty.
 * The thresholds only measure; halting dispatch is SystemService's decision.
 */
export async function calculateDiskUsage(options: UsageOptions): Promise<DiskUsageReport> {
	const {
		whitelistRoot,
		fs,
		warnThresholdBytes = DEFAULT_DISK_WARN_THRESHOLD_BYTES,
		freeThresholdBytes = DEFAULT_FREE_DISK_THRESHOLD_BYTES,
	} = options;

	const byRun: RunUsage[] = [];
	let dataDirBytes = 0;
	for (const runId of fs.listDirectory(whitelistRoot)) {
		const run = sumFiles(fs, join(whitelistRoot, runId));
		byRun.push({ runId, bytes: run.bytes, fileCount: run.fileCount });
		dataDirBytes += run.bytes;
	}
	byRun.sort((a, b) => b.bytes - a.bytes);

	let freeBytes: number | undefined;
	let totalBytes: number | undefined;
	try {
		const stat = await fs.statfs(whitelistRoot);
		freeBytes = stat.bavail * stat.bsize;
		totalBytes = stat.blocks * stat.bsize;
	} catch {
		// A volume that cannot answer statfs still gets the byte-count threshold; free space stays unknown.
	}

	const isWarnThresholdExceeded =
		dataDirBytes >= warnThresholdBytes ||
		(freeBytes !== undefined && freeBytes < freeThresholdBytes);

	return Object.freeze({
		dataDirBytes,
		byRun: Object.freeze(byRun),
		warnThreshold: warnThresholdBytes,
		freeBytes,
		totalBytes,
		isWarnThresholdExceeded,
		isDiskFull: freeBytes === 0,
	});
}

export interface LogstorePrimitivesDeps {
	readonly whitelistRoot: string;
	readonly fs: LogFileSystem;
	readonly logViolation?: (message: string) => void;
	readonly warnThresholdBytes?: number;
	readonly freeThresholdBytes?: number;
}

/** The three business-free primitives M1-T5 hands to the service layer. */
export interface LogstorePrimitives {
	readonly deleteByPath: (targetPath: string) => Promise<DeleteResult>;
	readonly truncate: (targetPath: string, targetBytes?: number) => Promise<TruncateResult>;
	readonly usage: () => Promise<DiskUsageReport>;
}

export function createLogstorePrimitives(deps: LogstorePrimitivesDeps): LogstorePrimitives {
	const fsOptions: RestrictedFsOptions = {
		whitelistRoot: deps.whitelistRoot,
		fs: deps.fs,
		logViolation: deps.logViolation,
	};
	return Object.freeze({
		deleteByPath(targetPath: string): Promise<DeleteResult> {
			return deleteByPath(targetPath, fsOptions);
		},
		truncate(targetPath: string, targetBytes = 0): Promise<TruncateResult> {
			return truncate(targetPath, targetBytes, fsOptions);
		},
		usage(): Promise<DiskUsageReport> {
			return calculateDiskUsage({
				whitelistRoot: deps.whitelistRoot,
				fs: deps.fs,
				warnThresholdBytes: deps.warnThresholdBytes,
				freeThresholdBytes: deps.freeThresholdBytes,
			});
		},
	});
}

function refuseOutsideWhitelist(
	kind: 'deletion' | 'truncation',
	targetPath: string,
	options: RestrictedFsOptions,
): RestrictedOpFailure | null {
	if (isPathWithinWhitelist(targetPath, options.whitelistRoot)) return null;
	options.logViolation?.(
		`[SECURITY_VIOLATION] Refused ${kind} request outside whitelist: "${targetPath}" (whitelistRoot: "${options.whitelistRoot}")`,
	);
	return {
		ok: false,
		retryable: false,
		code: 'E_FORBIDDEN',
		message: 'Path is outside the allowed whitelist directory.',
		path: targetPath,
	};
}

function toOpFailure(cause: unknown, path: string, fallbackMessage: string): RestrictedOpFailure {
	if (isBusyCause(cause)) {
		return {
			ok: false,
			retryable: true,
			code: 'EBUSY',
			message: 'The target file is open elsewhere; retry on a later pass.',
			path,
		};
	}
	if (isEnoent(cause) || (cause instanceof AppError && cause.code === 'E_LOG_FILE_MISSING')) {
		return missingFailure(path);
	}
	return {
		ok: false,
		retryable: false,
		code: 'E_INTERNAL',
		message: cause instanceof Error ? cause.message : fallbackMessage,
		path,
	};
}

function missingFailure(path: string): RestrictedOpFailure {
	return {
		ok: false,
		retryable: false,
		code: 'E_LOG_FILE_MISSING',
		message: 'The target file does not exist.',
		path,
	};
}

/** Bytes of the segment files directly inside a run directory. */
function sumFiles(fs: LogFileSystem, dir: string): { bytes: number; fileCount: number } {
	let bytes = 0;
	let fileCount = 0;
	for (const name of fs.listDirectory(dir)) {
		const len = fs.fileLenSync(join(dir, name));
		if (len !== null) {
			bytes += len;
			fileCount += 1;
		}
	}
	return { bytes, fileCount };
}

/** A run directory measures its files; a single file measures itself. */
function measureBytes(fs: LogFileSystem, path: string): number {
	const run = sumFiles(fs, path);
	if (run.fileCount > 0) return run.bytes;
	return fs.fileLenSync(path) ?? 0;
}
