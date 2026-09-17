import { AppError } from '../errors/app-error.ts';

export const AUTO_WRAPUP_ROUND_LIMIT = 2;
export const HARD_WRAPUP_ROUND_LIMIT = 6;

export interface AssertWrapupRoundOptions {
	readonly validRound: number;
	readonly physicalAttempts: number;
	readonly trigger: 'auto' | 'manual';
}

/**
 * Validates wrap-up round limits (R4, AC 5, E-274, E-276, E-288):
 * - Valid auto rounds are counted strictly from successfully persisted batch_wrapups records.
 *   Failed or unparsable wrapup runs do NOT consume valid auto rounds (E-274).
 * - Automated wrap-up is allowed while validRound < 2.
 * - Manual wrap-up from needs_attention is bounded by the physical hard ceiling of 6 attempts.
 * - If exceeded, throws E_WRAPUP_ROUND_LIMIT with structured details.
 */
export function assertWrapupRoundAllowed(options: AssertWrapupRoundOptions): void {
	const { validRound, physicalAttempts, trigger } = options;

	// Hard physical ceiling applies to both auto and manual
	if (physicalAttempts >= HARD_WRAPUP_ROUND_LIMIT) {
		throw new AppError(
			'E_WRAPUP_ROUND_LIMIT',
			`Hard wrap-up physical ceiling (${HARD_WRAPUP_ROUND_LIMIT}) reached. Total attempts: ${physicalAttempts}.`,
			{
				details: {
					physicalAttempts,
					validRound,
					autoLimit: AUTO_WRAPUP_ROUND_LIMIT,
					hardLimit: HARD_WRAPUP_ROUND_LIMIT,
					trigger,
				},
			},
		);
	}

	// Automated wrap-up bounded by 2 valid rounds (E-274, E-276)
	if (trigger === 'auto' && validRound >= AUTO_WRAPUP_ROUND_LIMIT) {
		throw new AppError(
			'E_WRAPUP_ROUND_LIMIT',
			`Automated wrap-up round limit (${AUTO_WRAPUP_ROUND_LIMIT}) reached. Valid rounds completed: ${validRound}.`,
			{
				details: {
					physicalAttempts,
					validRound,
					autoLimit: AUTO_WRAPUP_ROUND_LIMIT,
					hardLimit: HARD_WRAPUP_ROUND_LIMIT,
					trigger,
				},
			},
		);
	}
}
