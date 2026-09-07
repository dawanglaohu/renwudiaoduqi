import { posix, win32 } from 'node:path';
import type { SupportedPlatform } from './contract.ts';
import { APPLICATION_DIRECTORY_NAME, LOCK_FILE_NAME, type LockPathHost } from './lock-contract.ts';
import type { NativeLockAdapter } from './lock-contract.ts';
import { createPosixLockAdapter } from './lock-posix.ts';
import { createWindowsLockAdapter } from './lock-windows.ts';

export {
	APPLICATION_DIRECTORY_NAME,
	LOCK_DIRECTORY_MODE,
	LOCK_FILE_MODE,
	LOCK_FILE_NAME,
	LOCK_METADATA_FIELDS,
	POSIX_LOCK_DIRECTORY_MODE_OCTAL,
	POSIX_LOCK_FILE_MODE_OCTAL,
	WINDOWS_ADMINISTRATORS_SID,
	WINDOWS_SYSTEM_SID,
	combineProbeResults,
	healthProbeHost,
	isWildcardBind,
	parseLockMetadata,
	serializeLockMetadata,
} from './lock-contract.ts';
export type {
	LockFileHandle,
	LockIdentity,
	LockMetadata,
	LockMetadataField,
	LockPathHost,
	NativeLockAdapter,
	NativeLockError,
	NativeLockErrorCode,
	NativeLockReadResult,
	NativeLockWriteResult,
	PosixLockPermissionSpec,
	ProbeLiveness,
	WindowsLockAclSpec,
} from './lock-contract.ts';

export const WINDOWS_LOCK_DIR_FALLBACK = win32.join(
	'C:\\',
	'ProgramData',
	APPLICATION_DIRECTORY_NAME,
);
export const MACOS_LOCK_DIR = posix.join(
	'/',
	'Library',
	'Application Support',
	APPLICATION_DIRECTORY_NAME,
);
export const LINUX_LOCK_DIR = posix.join('/var', 'lib', APPLICATION_DIRECTORY_NAME);

export function lockDirPath(platform: SupportedPlatform, host: LockPathHost): string {
	switch (platform) {
		case 'win32':
			return isUsableWindowsAbsolute(host.programData)
				? win32.join(host.programData, APPLICATION_DIRECTORY_NAME)
				: WINDOWS_LOCK_DIR_FALLBACK;
		case 'darwin':
			return MACOS_LOCK_DIR;
		case 'linux':
			return LINUX_LOCK_DIR;
	}
}

export function lockFilePath(platform: SupportedPlatform, host: LockPathHost): string {
	switch (platform) {
		case 'win32':
			return win32.join(lockDirPath(platform, host), LOCK_FILE_NAME);
		case 'darwin':
			return posix.join(MACOS_LOCK_DIR, LOCK_FILE_NAME);
		case 'linux':
			return posix.join(LINUX_LOCK_DIR, LOCK_FILE_NAME);
	}
}

export function requiredLockPermissionLines(
	platform: SupportedPlatform,
	dirPath: string,
	filePath: string,
): readonly string[] {
	switch (platform) {
		case 'win32':
			return [
				'The lock file must be writable by Administrators and SYSTEM only. Run as Administrator or grant:',
				`icacls "${dirPath}" /inheritance:r /grant:r "Administrators:(OI)(CI)M" "SYSTEM:(OI)(CI)F"`,
				`icacls "${filePath}" /inheritance:r /grant:r "Administrators:F" "SYSTEM:F"`,
			];
		case 'darwin':
			return [
				'The lock file must be owned by root:admin with mode 0600. Run:',
				`sudo install -d -o root -g admin -m 0755 "${dirPath}"`,
				`sudo touch "${filePath}" && sudo chown root:admin "${filePath}" && sudo chmod 0600 "${filePath}"`,
			];
		case 'linux':
			return [
				'The lock file must be owned by root:root with mode 0600. Run:',
				`sudo install -d -o root -g root -m 0755 "${dirPath}"`,
				`sudo touch "${filePath}" && sudo chown root:root "${filePath}" && sudo chmod 0600 "${filePath}"`,
			];
	}
}

export function createNativeLockAdapter(input: {
	readonly platform: SupportedPlatform;
	readonly host: LockPathHost;
	readonly filePath?: string;
}): NativeLockAdapter {
	const dirPath = lockDirPath(input.platform, input.host);
	const filePath = input.filePath ?? lockFilePath(input.platform, input.host);
	const permissionLines = requiredLockPermissionLines(input.platform, dirPath, filePath);
	if (input.platform !== 'win32' && input.platform !== 'darwin' && input.platform !== 'linux') {
		throw new Error(`Unsupported platform: ${input.platform}`);
	}
	if (input.platform === 'win32') {
		return createWindowsLockAdapter({ dirPath, filePath, permissionLines });
	}
	return createPosixLockAdapter({
		platform: input.platform,
		dirPath,
		filePath,
		permissionLines,
	});
}

function isUsableWindowsAbsolute(value: string | undefined): value is string {
	if (value === undefined || value.length === 0) return false;
	return /^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/)/.test(value);
}
