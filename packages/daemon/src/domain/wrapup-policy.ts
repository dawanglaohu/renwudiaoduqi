import { AppError } from '../errors/app-error.ts';

export const AUTO_WRAPUP_ROUND_LIMIT = 2;
export const HARD_WRAPUP_ROUND_LIMIT = 6;

export interface AssertWrapupRoundOptions {
	readonly currentRound: number;
	readonly trigger: 'auto' | 'manual';
}

/**
 * Validates wrap-up round limits (AC 5, E-276, E-288):
 * - Automated wrap-up allows up to 2 rounds (round 1 & round 2). Once round 2 completes still open, no 3rd auto round is dispatched.
 * - Manual wrap-up from needs_attention is not bounded by the auto limit (2), but bounded by the hard ceiling of 6 rounds.
 * - If exceeded, throws E_WRAPUP_ROUND_LIMIT with structured details.
 */
export function assertWrapupRoundAllowed(options: AssertWrapupRoundOptions): void {
	const { currentRound, trigger } = options;
	const nextRound = currentRound + 1;

	if (trigger === 'auto') {
		if (currentRound >= AUTO_WRAPUP_ROUND_LIMIT) {
			throw new AppError(
				'E_WRAPUP_ROUND_LIMIT',
				`Automated wrap-up round limit (${AUTO_WRAPUP_ROUND_LIMIT}) reached. Current round: ${currentRound}.`,
				{
					details: {
						round: currentRound,
						nextRound,
						autoLimit: AUTO_WRAPUP_ROUND_LIMIT,
						hardLimit: HARD_WRAPUP_ROUND_LIMIT,
						trigger,
					},
				},
			);
		}
	} else {
		if (currentRound >= HARD_WRAPUP_ROUND_LIMIT) {
			throw new AppError(
				'E_WRAPUP_ROUND_LIMIT',
				`Hard wrap-up round ceiling (${HARD_WRAPUP_ROUND_LIMIT}) reached. Current round: ${currentRound}.`,
				{
					details: {
						round: currentRound,
						nextRound,
						autoLimit: AUTO_WRAPUP_ROUND_LIMIT,
						hardLimit: HARD_WRAPUP_ROUND_LIMIT,
						trigger,
					},
				},
			);
		}
	}
}
