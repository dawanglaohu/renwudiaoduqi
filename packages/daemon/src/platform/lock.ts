import { posix, win32 } from 'node:path';
import type { SupportedPlatform } from './contract.ts';

const APPLICATION_DIRECTORY_NAME = 'agent-scheduler';
const LOCK_FILE_NAME = 'daemon.lock';

// Win32: %PROGRAMDATA%\agent-scheduler\daemon.lock (defaults to C:\ProgramData\agent-scheduler\daemon.lock)
// darwin: /Library/Application Support/agent-scheduler/daemon.lock (system-wide, not user-level)
// linux: /var/lib/agent-scheduler/daemon.lock
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

export interface LockPathHost {
	readonly programData?: string;
}

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

// Print these when the daemon fails to acquire the lock due to permission,
// never silently fall back to per-user directories (E-03).
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

function isUsableWindowsAbsolute(value: string | undefined): value is string {
	if (value === undefined || value.length === 0) return false;
	return /^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/)/.test(value);
}
