import {
	chmodSync,
	chownSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import {
	LOCK_DIRECTORY_MODE,
	LOCK_FILE_MODE,
	type NativeLockAdapter,
	type NativeLockError,
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
	return Object.freeze({
		platform: input.platform,
		filePath: input.filePath,
		dirPath: input.dirPath,
		permissionLines: input.permissionLines,
		createExclusive(contents: string): NativeLockWriteResult {
			return writeLockFile(input, permission, contents, 'wx');
		},
		overwrite(contents: string): NativeLockWriteResult {
			return writeLockFile(input, permission, contents, 'w');
		},
		read(): NativeLockReadResult {
			return readLockFile(input.filePath);
		},
		remove(): NativeLockWriteResult {
			return removeLockFile(input.filePath);
		},
		inspectPermissions(): NativeLockReadResult {
			return inspectLockFile(input.filePath, permission);
		},
	});
}

function writeLockFile(
	input: { readonly dirPath: string; readonly filePath: string },
	permission: PosixLockPermissionSpec,
	contents: string,
	flag: 'wx' | 'w',
): NativeLockWriteResult {
	try {
		ensureLockDirectory(input.dirPath, permission);
		writeFileSync(input.filePath, contents, {
			encoding: 'utf8',
			flag,
			mode: permission.fileMode,
		});
		applyFilePermission(input.filePath, permission);
		return { ok: true };
	} catch (cause) {
		if (flag === 'wx') {
			removeLockFile(input.filePath);
		}
		return { ok: false, error: toNativeLockError(cause, input.filePath) };
	}
}

function readLockFile(filePath: string): NativeLockReadResult {
	try {
		return { ok: true, contents: readFileSync(filePath, 'utf8') };
	} catch (cause) {
		return { ok: false, error: toNativeLockError(cause, filePath) };
	}
}

function removeLockFile(filePath: string): NativeLockWriteResult {
	try {
		unlinkSync(filePath);
		return { ok: true };
	} catch (cause) {
		const error = toNativeLockError(cause, filePath);
		if (error.code === 'ENOENT') return { ok: true };
		return { ok: false, error };
	}
}

function inspectLockFile(
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
		return { ok: false, error: toNativeLockError(cause, filePath) };
	}
}

function ensureLockDirectory(dirPath: string, permission: PosixLockPermissionSpec): void {
	mkdirSync(dirPath, { recursive: true, mode: permission.directoryMode });
	chmodSync(dirPath, permission.directoryMode);
	chownSync(dirPath, permission.ownerId, permission.groupId);
}

function applyFilePermission(filePath: string, permission: PosixLockPermissionSpec): void {
	chmodSync(filePath, permission.fileMode);
	chownSync(filePath, permission.ownerId, permission.groupId);
}

function toNativeLockError(cause: unknown, path: string): NativeLockError {
	const code = getErrorCode(cause);
	if (code === 'EEXIST' || code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
		return {
			code,
			message: nativeErrorMessage(code, path),
			cause,
			details: { path },
		};
	}
	return {
		code: 'E_INTERNAL',
		message: nativeErrorMessage('E_INTERNAL', path),
		cause,
		details: { path },
	};
}

function nativeErrorMessage(code: NativeLockError['code'], path: string): string {
	switch (code) {
		case 'EEXIST':
			return `The machine-wide lock already exists at ${path}.`;
		case 'EACCES':
		case 'EPERM':
			return `Insufficient permission to use the machine-wide lock at ${path}.`;
		case 'ENOENT':
			return `The machine-wide lock was not found at ${path}.`;
		case 'E_INTERNAL':
			return `Failed to operate on the machine-wide lock at ${path}.`;
	}
}

function getErrorCode(cause: unknown): string | undefined {
	if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
	return typeof cause.code === 'string' ? cause.code : undefined;
}
