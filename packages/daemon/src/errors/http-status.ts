import { ERROR_CODES, type ErrorCode } from '@agent-scheduler/shared/errors/codes';

/**
 * Resolves the default HTTP status code configured in shared/errors/codes.
 * Does NOT declare any independent status code table.
 */
export function getHttpStatusForErrorCode(code: string): number | null {
	if (code in ERROR_CODES) {
		return ERROR_CODES[code as ErrorCode].defaultHttpStatus;
	}
	return null;
}
