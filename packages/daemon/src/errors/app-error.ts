import { ERROR_CODES, type ErrorCode } from '@agent-scheduler/shared/errors/codes';

export interface AppErrorOptions {
	readonly details?: Record<string, unknown>;
	readonly cause?: unknown;
}

export class AppError extends Error {
	readonly code: ErrorCode;
	readonly details?: Record<string, unknown>;
	readonly retryable: boolean;

	constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
		super(message, { cause: options.cause });
		this.name = 'AppError';
		this.code = code;
		this.details = options.details;
		this.retryable = ERROR_CODES[code].retryable;
	}
}
