import { AppError } from '../errors/app-error.ts';

export function isEnoent(cause: unknown): boolean {
	return getNodeErrorCode(cause) === 'ENOENT';
}

export function toLogFileMissing(cause: unknown, path: string): AppError {
	return new AppError('E_LOG_FILE_MISSING', 'Log file is missing on disk.', {
		cause,
		details: { path },
	});
}

export function toFilesystemError(cause: unknown, fallbackMessage: string): AppError {
	if (cause instanceof AppError) return cause;
	if (isEnoent(cause)) return toLogFileMissing(cause, getNodeErrorPath(cause) ?? '');
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
