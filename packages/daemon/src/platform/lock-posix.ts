import {
	chmodSync,
	chownSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { AppError } from '../errors/app-error.ts';
import {
	LOCK_DIRECTORY_MODE,
	LOCK_FILE_MODE,
	type NativeLockAdapter,
	type NativeLockFailure,
	type NativeLockReadResult,
	type NativeLockWriteResult,
	type PosixLockPermissionSpec,
} from './lock-contract.ts';

export const LINUX_LOCK_PERMISSION: PosixLockPermissionSpec = Object.freeze({
	ownerName: 'root',
	groupName: 'root',
	ownerId: 0,
	groupId: 0,
	fileMode: LOCK_FILE_MODE,
	directoryMode: LOCK_DIRECTORY_MODE,
});

export const DARWIN_LOCK_PERMISSION: PosixLockPermissionSpec = Object.freeze({
	ownerName: 'root',
	groupName: 'admin',
	ownerId: 0,
	groupId: 80,
	fileMode: LOCK_FILE_MODE,
	directoryMode: LOCK_DIRECTORY_MODE,
});

export function posixLockPermission(platform: 'darwin' | 'linux'): PosixLockPermissionSpec {
	return platform === 'darwin' ? DARWIN_LOCK_PERMISSION : LINUX_LOCK_PERMISSION;
}

export function createPosixLockAdapter(input: {
	readonly platform: 'darwin' | 'linux';
	readonly dirPath: string;
	readonly filePath: string;
	readonly permissionLines: readonly string[];
}): NativeLockAdapter {
	const permission = posixLockPermission(input.platform);
	const reclaimPath = `${input.filePath}.reclaim`;
	return Object.freeze({
		platform: input.platform,
		filePath: input.filePath,
		dirPath: input.dirPath,
		reclaimPath,
		permissionLines: input.permissionLines,
		createExclusive: (contents: string) =>
			writeProtectedFile(input.dirPath, input.filePath, permission, contents),
		read: () => readProtectedFile(input.filePath),
		remove: () => removeProtectedFile(input.filePath),
		verifyPermissions: () => verifyPosixPermissions(input.filePath, permission),
		createReclaimGuard: (contents: string) =>
			writeProtectedFile(input.dirPath, reclaimPath, permission, contents),
		readReclaimGuard: () => readProtectedFile(reclaimPath),
		removeReclaimGuard: () => removeProtectedFile(reclaimPath),
		inspectPermissions: () => inspectPosixPermissions(input.filePath, permission),
	});
}

function writeProtectedFile(
	dirPath: string,
	filePath: string,
	permission: PosixLockPermissionSpec,
	contents: string,
): NativeLockWriteResult {
	let created = false;
	try {
		ensureLockDirectory(dirPath, permission);
		writeFileSync(filePath, contents, {
			encoding: 'utf8',
			flag: 'wx',
			mode: permission.fileMode,
		});
		created = true;
		chmodSync(filePath, permission.fileMode);
		chownSync(filePath, permission.ownerId, permission.groupId);
		const verification = verifyPosixPermissions(filePath, permission);
		if (!verification.ok) {
			unlinkIfPresent(filePath);
			return verification;
		}
		return { ok: true };
	} catch (cause) {
		if (created) unlinkIfPresent(filePath);
		return { ok: false, failure: toNativeLockFailure(cause, filePath) };
	}
}

function readProtectedFile(filePath: string): NativeLockReadResult {
	try {
		return { ok: true, contents: readFileSync(filePath, 'utf8') };
	} catch (cause) {
		return { ok: false, failure: toNativeLockFailure(cause, filePath) };
	}
}

function removeProtectedFile(filePath: string): NativeLockWriteResult {
	try {
		unlinkSync(filePath);
		return { ok: true };
	} catch (cause) {
		const failure = toNativeLockFailure(cause, filePath);
		if (failure.kind === 'not-found') return { ok: true };
		return { ok: false, failure };
	}
}

function verifyPosixPermissions(
	filePath: string,
	permission: PosixLockPermissionSpec,
): NativeLockWriteResult {
	try {
		const stats = statSync(filePath);
		const mode = stats.mode & 0o777;
		if (
			stats.uid === permission.ownerId &&
			stats.gid === permission.groupId &&
			mode === permission.fileMode
		) {
			return { ok: true };
		}
		return {
			ok: false,
			failure: {
				kind: 'invalid-permissions',
				error: new AppError('E_INTERNAL', 'The machine-wide lock has unsafe POSIX permissions.', {
					details: {
						path: filePath,
						expectedUid: permission.ownerId,
						expectedGid: permission.groupId,
						expectedMode: permission.fileMode,
						actualUid: stats.uid,
						actualGid: stats.gid,
						actualMode: mode,
					},
				}),
			},
		};
	} catch (cause) {
		return { ok: false, failure: toNativeLockFailure(cause, filePath) };
	}
}

function inspectPosixPermissions(
	filePath: string,
	permission: PosixLockPermissionSpec,
): NativeLockReadResult {
	try {
		const stats = statSync(filePath);
		return {
			ok: true,
			contents: `${permission.ownerName}:${permission.groupName} uid=${stats.uid} gid=${stats.gid} mode=${(stats.mode & 0o777).toString(8).padStart(3, '0')}`,
		};
	} catch (cause) {
		return { ok: false, failure: toNativeLockFailure(cause, filePath) };
	}
}

function ensureLockDirectory(dirPath: string, permission: PosixLockPermissionSpec): void {
	mkdirSync(dirPath, { recursive: true, mode: permission.directoryMode });
	chmodSync(dirPath, permission.directoryMode);
	chownSync(dirPath, permission.ownerId, permission.groupId);
}

function toNativeLockFailure(cause: unknown, path: string): NativeLockFailure {
	const nativeCode = getErrorCode(cause);
	const kind =
		nativeCode === 'EEXIST'
			? 'already-exists'
			: nativeCode === 'EACCES' || nativeCode === 'EPERM'
				? 'permission-denied'
				: nativeCode === 'ENOENT'
					? 'not-found'
					: 'internal';
	return {
		kind,
		error: new AppError('E_INTERNAL', nativeErrorMessage(kind, path), {
			cause,
			details: { path, nativeCode },
		}),
	};
}

function nativeErrorMessage(kind: NativeLockFailure['kind'], path: string): string {
	switch (kind) {
		case 'already-exists':
			return `The machine-wide lock already exists at ${path}.`;
		case 'permission-denied':
			return `Insufficient permission to use the machine-wide lock at ${path}.`;
		case 'not-found':
			return `The machine-wide lock was not found at ${path}.`;
		case 'invalid-permissions':
			return `The machine-wide lock has unsafe permissions at ${path}.`;
		case 'internal':
			return `Failed to operate on the machine-wide lock at ${path}.`;
	}
}

function getErrorCode(cause: unknown): string | undefined {
	if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
	return typeof cause.code === 'string' ? cause.code : undefined;
}

function unlinkIfPresent(path: string): void {
	try {
		unlinkSync(path);
	} catch (cause) {
		if (getErrorCode(cause) !== 'ENOENT') throw cause;
	}
}
