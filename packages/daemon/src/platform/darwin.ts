import { posix } from 'node:path';
import type {
	AppDataDirectoryResult,
	CurrentPlatformPath,
	PlatformHostInputs,
	PlatformPathAdapter,
} from './contract.ts';
import { hasUnexpandedPathToken } from './contract.ts';

const APPLICATION_DIRECTORY_NAME = 'agent-scheduler';
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE = /^(?:\\\\|\/\/)/;

export const DARWIN_PATH_ADAPTER: PlatformPathAdapter = Object.freeze({
	platform: 'darwin',
	requiresExecutablePermission: true,
	appDataDir: darwinAppDataDir,
	classifyPath: classifyDarwinPath,
	executableCandidatePaths: darwinExecutableCandidatePaths,
	toFileSystemPath: (value: string) => value,
});

export function darwinAppDataDir(hostInputs: PlatformHostInputs): AppDataDirectoryResult {
	if (!isUsableAbsolutePosixPath(hostInputs.homedir)) {
		return unresolvedDataDirectory(hostInputs.homedir);
	}
	const path = posix.normalize(
		posix.join(hostInputs.homedir, 'Library', 'Application Support', APPLICATION_DIRECTORY_NAME),
	);
	return Object.freeze({ ok: true, path });
}

export function classifyDarwinPath(value: string): CurrentPlatformPath {
	if (isAbsolutePosixPath(value)) {
		return Object.freeze({
			isValidForCurrentPlatform: true,
			value,
			normalizedPath: posix.normalize(value),
		});
	}

	return Object.freeze({
		isValidForCurrentPlatform: false,
		value,
		reason:
			WINDOWS_DRIVE_ABSOLUTE.test(value) || WINDOWS_UNC_ABSOLUTE.test(value)
				? 'foreign-platform-path'
				: 'not-absolute',
	});
}

export function darwinExecutableCandidatePaths(
	executableName: string,
	hostInputs: PlatformHostInputs,
): readonly string[] {
	const directories = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
	if (isUsableAbsolutePosixPath(hostInputs.homedir)) {
		directories.push(
			posix.join(hostInputs.homedir, '.local', 'bin'),
			posix.join(hostInputs.homedir, '.npm-global', 'bin'),
			posix.join(hostInputs.homedir, '.grok', 'bin'),
		);
	}
	return Object.freeze(directories.map((directory) => posix.join(directory, executableName)));
}

function isAbsolutePosixPath(value: string): boolean {
	return posix.isAbsolute(value) && !WINDOWS_UNC_ABSOLUTE.test(value);
}

function isUsableAbsolutePosixPath(value: string): boolean {
	return isAbsolutePosixPath(value) && !hasUnexpandedPathToken(value);
}

function unresolvedDataDirectory(homedir: string): AppDataDirectoryResult {
	return Object.freeze({
		ok: false,
		error: Object.freeze({
			code: 'E_DATA_DIR_UNRESOLVABLE',
			message: 'The host home directory cannot resolve an absolute application data path.',
			details: Object.freeze({ homedir }),
		}),
	});
}
