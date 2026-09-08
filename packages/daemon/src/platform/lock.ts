import { posix, win32 } from 'node:path';
import type { SupportedPlatform } from './contract.ts';
import {
	APPLICATION_DIRECTORY_NAME,
	LOCK_FILE_NAME,
	type LockPathHost,
	type NativeLockAdapter,
} from './lock-contract.ts';
import { createPosixLockAdapter } from './lock-posix.ts';
import { type WindowsLockCommandRunner, createWindowsLockAdapter } from './lock-windows.ts';

export const WINDOWS_LOCK_DIR_FALLBACK = win32.join(
	'C:\\',
	'ProgramData',
	APPLICATION_DIRECTORY_NAME,
);
export const WINDOWS_SYSTEM_ROOT_FALLBACK = 'C:\\Windows';
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
	const dirPath = lockDirPath(platform, host);
	return platform === 'win32'
		? win32.join(dirPath, LOCK_FILE_NAME)
		: posix.join(dirPath, LOCK_FILE_NAME);
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
				`icacls "${dirPath}" /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F"`,
				`icacls "${filePath}" /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F"`,
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
	readonly runWindowsCommand?: WindowsLockCommandRunner;
}): NativeLockAdapter {
	const defaultDirPath = lockDirPath(input.platform, input.host);
	const filePath = input.filePath ?? lockFilePath(input.platform, input.host);
	const dirPath =
		input.filePath === undefined
			? defaultDirPath
			: input.platform === 'win32'
				? win32.dirname(filePath)
				: posix.dirname(filePath);
	const permissionLines = requiredLockPermissionLines(input.platform, dirPath, filePath);
	if (input.platform === 'win32') {
		const systemRoot = isUsableWindowsAbsolute(input.host.systemRoot)
			? input.host.systemRoot
			: WINDOWS_SYSTEM_ROOT_FALLBACK;
		return createWindowsLockAdapter({
			dirPath,
			filePath,
			permissionLines,
			icaclsPath: win32.join(systemRoot, 'System32', 'icacls.exe'),
			runCommand: input.runWindowsCommand,
		});
	}
	return createPosixLockAdapter({
		platform: input.platform,
		dirPath,
		filePath,
		permissionLines,
	});
}

function isUsableWindowsAbsolute(value: string | undefined): value is string {
	return value !== undefined && win32.isAbsolute(value) && !/[~%]|\$\{/.test(value);
}
