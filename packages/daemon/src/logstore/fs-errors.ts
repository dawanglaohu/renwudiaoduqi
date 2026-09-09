import { AppError } from '../errors/app-error.ts';

export function isEnoent(cause: unknown): boolean {
	return getNodeErrorCode(cause) === 'ENOENT';
}

export function isEnospc(cause: unknown): boolean {
	return getNodeErrorCode(cause) === 'ENOSPC';
}

/** EBUSY, or the EPERM Windows reports for a file another handle holds open. */
export function isEbusy(cause: unknown): boolean {
	const code = getNodeErrorCode(cause);
	return code === 'EBUSY' || code === 'EPERM';
}

/** True for a raw busy error or for an AppError from this module wrapping one. */
export function isBusyCause(cause: unknown): boolean {
	return isEbusy(cause) || (cause instanceof AppError && isEbusy(cause.cause));
}

export function toLogFileMissing(cause: unknown, path: string): AppError {
	return new AppError('E_LOG_FILE_MISSING', 'Log file is missing on disk.', {
		cause,
		details: { path },
	});
}

export function toDiskFullError(cause: unknown, path: string): AppError {
	return new AppError('E_DISK_FULL', 'Storage disk is full; new dispatches halted.', {
		cause,
		details: { path },
	});
}

/**
 * Wrap a native fs error at the module boundary (R4): ENOENT → E_LOG_FILE_MISSING
 * (E-151), ENOSPC → E_DISK_FULL (E-104), everything else → E_INTERNAL with the original error as `cause`.
 */
export function toFilesystemError(cause: unknown, fallbackMessage: string): AppError {
	if (cause instanceof AppError) return cause;
	if (isEnoent(cause)) return toLogFileMissing(cause, getNodeErrorPath(cause) ?? '');
	if (isEnospc(cause)) return toDiskFullError(cause, getNodeErrorPath(cause) ?? '');
	return new AppError('E_INTERNAL', fallbackMessage, { cause });
}

export function getNodeErrorCode(cause: unknown): string | undefined {
	if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
	return typeof cause.code === 'string' ? cause.code : undefined;
}

function getNodeErrorPath(cause: unknown): string | undefined {
	if (typeof cause !== 'object' || cause === null || !('path' in cause)) return undefined;
	return typeof cause.path === 'string' ? cause.path : undefined;
}
