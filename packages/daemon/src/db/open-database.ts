import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { AppError } from '../errors/app-error.ts';

const require = createRequire(import.meta.url);

const PRAGMAS = [
	'journal_mode = WAL',
	'busy_timeout = 5000',
	'foreign_keys = ON',
	'synchronous = NORMAL',
] as const;

const NATIVE_MODULE_ERROR_CODES = ['ERR_DLOPEN_FAILED', 'MODULE_NOT_FOUND'] as const;

export type DatabaseConnection = Database.Database;

export interface DatabaseOpener {
	readonly open: (path: string) => DatabaseConnection;
}

const NATIVE_DATABASE_OPENER: DatabaseOpener = Object.freeze({
	open(path: string): DatabaseConnection {
		const DatabaseConstructor = require('better-sqlite3') as typeof Database;
		return new DatabaseConstructor(path);
	},
});

export function openDatabase(
	path: string,
	opener: DatabaseOpener = NATIVE_DATABASE_OPENER,
): DatabaseConnection {
	let database: DatabaseConnection | undefined;
	try {
		database = opener.open(path);
		for (const pragma of PRAGMAS) {
			database.pragma(pragma);
		}
		return database;
	} catch (cause) {
		throw toDatabaseError(closeAfterFailedOpen(database, cause), 'Failed to open SQLite database.');
	}
}

export function toDatabaseError(cause: unknown, fallbackMessage: string): AppError {
	if (cause instanceof AppError) return cause;

	const code = getErrorCode(cause);
	if (code?.startsWith('SQLITE_BUSY')) {
		return new AppError('E_DB_BUSY', 'SQLite remained busy after the configured timeout.', {
			cause,
		});
	}
	if (code !== undefined && NATIVE_MODULE_ERROR_CODES.some((nativeCode) => nativeCode === code)) {
		return new AppError(
			'E_INTERNAL',
			'SQLite native module failed to load. Run `pnpm rebuild` and restart the daemon.',
			{ cause, details: { remediation: 'pnpm rebuild' } },
		);
	}

	return new AppError('E_INTERNAL', fallbackMessage, { cause });
}

function closeAfterFailedOpen(
	database: DatabaseConnection | undefined,
	initializationCause: unknown,
): unknown {
	if (database === undefined) return initializationCause;
	try {
		database.close();
		return initializationCause;
	} catch (cleanupCause) {
		return { initializationCause, cleanupCause };
	}
}

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
	return typeof error.code === 'string' ? error.code : undefined;
}
