import { AppError } from '../errors/app-error.ts';
import type { DatabaseConnection } from './open-database.ts';
import { toDatabaseError } from './open-database.ts';

export interface UnitOfWork {
	readonly run: <Result>(work: () => Result) => Result;
}

export interface TransactionLifecycle {
	readonly begin: () => { readonly commit: () => void; readonly rollback: () => void };
}

export function createUnitOfWork(
	database: DatabaseConnection,
	lifecycle?: TransactionLifecycle,
): UnitOfWork {
	let depth = 0;

	return Object.freeze({
		run<Result>(work: () => Result): Result {
			if (depth > 0) {
				throw new AppError('E_TX_NESTED', 'Nested database transactions are not allowed.');
			}

			const transaction = database.transaction(() => {
				depth += 1;
				try {
					return work();
				} finally {
					depth -= 1;
				}
			});

			const scope = lifecycle?.begin();
			let result: Result;
			try {
				result = transaction.immediate();
			} catch (cause) {
				scope?.rollback();
				throw toDatabaseError(cause, 'Failed to execute SQLite transaction.');
			}
			scope?.commit();
			return result;
		},
	});
}
