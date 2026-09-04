import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export interface LockHandle {
	readonly pid: number;
	readonly lockFilePath: string;
	release(): void;
}

export type AcquireInstanceLockResult =
	| { readonly ok: true; readonly lock: LockHandle }
	| {
			readonly ok: false;
			readonly lockFilePath: string;
			readonly existingPid: number | null;
	  };

export function acquireInstanceLock(lockFilePath: string, pid: number): AcquireInstanceLockResult {
	try {
		writeFileSync(lockFilePath, `${pid}\n`, { encoding: 'utf8', flag: 'wx' });
	} catch (error) {
		if (hasErrorCode(error, 'EEXIST')) {
			return {
				ok: false,
				lockFilePath,
				existingPid: readPidFromLock(lockFilePath),
			};
		}
		throw error;
	}

	let released = false;
	return {
		ok: true,
		lock: {
			pid,
			lockFilePath,
			release(): void {
				if (released) return;
				released = true;
				releaseLockFile(lockFilePath);
			},
		},
	};
}

export function readPidFromLock(lockFilePath: string): number | null {
	try {
		const text = readFileSync(lockFilePath, 'utf8').trim();
		const pid = Number.parseInt(text, 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function releaseLockFile(lockFilePath: string): void {
	try {
		unlinkSync(lockFilePath);
	} catch (error) {
		if (!hasErrorCode(error, 'ENOENT')) throw error;
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { readonly code?: unknown }).code === code
	);
}
