import type { DatabaseConnection } from '../db/open-database.ts';
import type { HttpServer } from '../http/server.ts';
import type { LockFileHandle, NativeLockAdapter } from '../platform/lock-contract.ts';
import { releaseInstanceLock } from './lock.ts';

export interface ShutdownJob {
	readonly name: string;
	stop(): Promise<void>;
}

export interface ShutdownDependencies {
	readonly jobs?: readonly ShutdownJob[];
	readonly server?: HttpServer;
	readonly database?: DatabaseConnection;
	readonly lock?: LockFileHandle;
	readonly lockAdapter?: NativeLockAdapter;
	readonly writeRunLog?: (line: string) => void;
}

/**
 * Graceful daemon shutdown.
 *
 * Sequence (AC 4, E-01):
 * 1. Stop all background jobs first so no asynchronous ticks remain in flight.
 * 2. Close HTTP server so no incoming network requests are accepted.
 * 3. Close SQLite database connection.
 * 4. Release single-instance lock file handle.
 * 5. CRITICAL (E-01): Does NOT kill agent child processes. Running sessions remain
 *    active across desktop closures or daemon restarts for subsequent reconciliation.
 */
export async function shutdown(dependencies: ShutdownDependencies): Promise<void> {
	const writeLog = dependencies.writeRunLog ?? (() => undefined);

	// 1. Stop background jobs first
	if (dependencies.jobs && dependencies.jobs.length > 0) {
		for (const job of dependencies.jobs) {
			try {
				await job.stop();
			} catch (error) {
				writeLog(`[shutdown] job ${job.name} failed during stop: ${String(error)}`);
			}
		}
	}

	// 2. Close HTTP server
	if (dependencies.server !== undefined) {
		try {
			await dependencies.server.close();
		} catch (error) {
			writeLog(`[shutdown] HTTP server failed to close cleanly: ${String(error)}`);
		}
	}

	// 3. Close database connection
	if (dependencies.database !== undefined) {
		try {
			dependencies.database.close();
		} catch (error) {
			writeLog(`[shutdown] database failed to close cleanly: ${String(error)}`);
		}
	}

	// 4. Release single-instance lock
	if (dependencies.lock !== undefined && dependencies.lockAdapter !== undefined) {
		try {
			releaseInstanceLock(dependencies.lock, dependencies.lockAdapter);
		} catch (error) {
			writeLog(`[shutdown] instance lock failed to release cleanly: ${String(error)}`);
		}
	}

	// 5. Agent child processes are NOT killed (E-01)
}

/**
 * Creates an idempotent shutdown function that ensures shutdown sequence
 * is executed at most once, and concurrent calls share the in-flight promise.
 */
export function createShutdownHandler(dependencies: ShutdownDependencies): () => Promise<void> {
	let stopped = false;
	let inFlight: Promise<void> | null = null;

	return async (): Promise<void> => {
		if (stopped) return;
		if (inFlight !== null) return inFlight;

		const promise = (async () => {
			try {
				await shutdown(dependencies);
				stopped = true;
			} finally {
				inFlight = null;
			}
		})();

		inFlight = promise;
		return promise;
	};
}
