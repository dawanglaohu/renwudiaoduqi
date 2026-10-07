import { AppError } from '../errors/app-error.ts';
import type { EnvelopeFactory } from './envelope.ts';

/**
 * Retries a bounded, synchronous transaction after event pressure subsides.
 * Each attempt must re-read mutable state and roll back all writes and reservations
 * on failure. External effects and publication belong after this function returns.
 */
export async function retryEventAdmission<T>(
	factory: EnvelopeFactory | undefined,
	transaction: () => T,
): Promise<T> {
	for (;;) {
		try {
			return transaction();
		} catch (error) {
			if (
				!factory ||
				!(error instanceof AppError) ||
				error.code !== 'E_RATE_LIMITED' ||
				typeof error.details?.capacity !== 'number'
			)
				throw error;
			await factory.waitForCapacity();
		}
	}
}
