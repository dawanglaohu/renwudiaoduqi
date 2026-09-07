import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { LockCommandResult } from '../proc/lock-command.ts';
import type { NativeLockCommand } from './lock-contract.ts';

import {
	type NativeLockAdapter,
	type NativeLockError,
	type NativeLockReadResult,
	type NativeLockWriteResult,
	WINDOWS_ADMINISTRATORS_SID,
	WINDOWS_SYSTEM_SID,
	type WindowsLockAclSpec,
} from './lock-contract.ts';
export const WINDOWS_LOCK_ACL: WindowsLockAclSpec = Object.freeze({
	inherit: false,
	entries: Object.freeze([
		Object.freeze({
			sid: WINDOWS_ADMINISTRATORS_SID,
			name: 'Administrators',
			rights: 'F',
			inherit: true,
		}),
		Object.freeze({
			sid: WINDOWS_SYSTEM_SID,
			name: 'SYSTEM',
			rights: 'F',
			inherit: true,
		}),
	]),
});

export type WindowsLockCommandRunner = (command: NativeLockCommand) => LockCommandResult;

export function createWindowsLockAdapter(input: {
	readonly dirPath: string;
	readonly filePath: string;
	readonly permissionLines: readonly string[];
	readonly runCommand?: WindowsLockCommandRunner;
}): NativeLockAdapter {
	return Object.freeze({
		platform: 'win32',
		filePath: input.filePath,
		dirPath: input.dirPath,
		permissionLines: input.permissionLines,
		createExclusive(contents: string): NativeLockWriteResult {
			return writeWindowsLock(input, contents, 'wx');
		},
		overwrite(contents: string): NativeLockWriteResult {
			return writeWindowsLock(input, contents, 'w');
		},
		read(): NativeLockReadResult {
			return readWindowsLock(input.filePath);
		},
		remove(): NativeLockWriteResult {
			return removeWindowsLock(input.filePath);
		},
		inspectPermissions(): NativeLockReadResult {
			return inspectWindowsAcl(input);
		},
	});
}

function writeWindowsLock(
	input: {
		readonly dirPath: string;
		readonly filePath: string;
		readonly runCommand?: WindowsLockCommandRunner;
	},
	contents: string,
	flag: 'wx' | 'w',
): NativeLockWriteResult {
	try {
		mkdirSync(input.dirPath, { recursive: true });
		applyAcl(input.dirPath, input.runCommand);
		writeFileSync(input.filePath, contents, { encoding: 'utf8', flag });
		applyAcl(input.filePath, input.runCommand);
		return { ok: true };
	} catch (cause) {
		if (flag === 'wx') removeWindowsLock(input.filePath);
		return { ok: false, error: toNativeLockError(cause, input.filePath) };
	}
}

function readWindowsLock(filePath: string): NativeLockReadResult {
	try {
		return { ok: true, contents: readFileSync(filePath, 'utf8') };
	} catch (cause) {
		return { ok: false, error: toNativeLockError(cause, filePath) };
	}
}

function removeWindowsLock(filePath: string): NativeLockWriteResult {
	try {
		unlinkSync(filePath);
		return { ok: true };
	} catch (cause) {
		const error = toNativeLockError(cause, filePath);
		if (error.code === 'ENOENT') return { ok: true };
		return { ok: false, error };
	}
}

function inspectWindowsAcl(input: {
	readonly filePath: string;
	readonly runCommand?: WindowsLockCommandRunner;
}): NativeLockReadResult {
	const runCommand = input.runCommand;
	if (runCommand === undefined) {
		return {
			ok: false,
			error: {
				code: 'E_INTERNAL',
				message: `Cannot inspect the machine-wide lock ACL at ${input.filePath} without a command runner.`,
				details: { path: input.filePath },
			},
		};
	}
	const output = runCommand({ file: 'icacls', args: [input.filePath] });
	if (!output.ok) {
		return {
			ok: false,
			error: {
				code: 'E_INTERNAL',
				message: `Failed to inspect the machine-wide lock ACL at ${input.filePath}.`,
				cause: output,
				details: { path: input.filePath, stderr: output.stderr },
			},
		};
	}
	return { ok: true, contents: output.stdout };
}

function applyAcl(path: string, runCommand: WindowsLockCommandRunner | undefined): void {
	if (runCommand === undefined) {
		throw {
			code: 'EACCES',
			message: `The Windows lock ACL cannot be applied at ${path} without an icacls runner.`,
		} satisfies { code: string; message: string };
	}
	const result = runCommand(buildAclCommand(path));
	if (!result.ok) {
		throw {
			code: 'EACCES',
			message: `Failed to apply the Administrators/SYSTEM-only ACL at ${path}: ${result.stderr}`,
		} satisfies { code: string; message: string };
	}
	const verify = runCommand({ file: 'icacls', args: [path] });
	if (!verify.ok || !verifyWindowsAclOutput(verify.stdout)) {
		throw {
			code: 'EACCES',
			message: `The machine-wide lock ACL at ${path} does not match Administrators/SYSTEM-only.`,
		} satisfies { code: string; message: string };
	}
}

function buildAclCommand(path: string): NativeLockCommand {
	const grants = WINDOWS_LOCK_ACL.entries.map(
		(entry) => `*${entry.sid}:${entry.inherit ? '(OI)(CI)' : ''}${entry.rights}`,
	);
	return {
		file: 'icacls',
		args: [path, '/inheritance:r', '/grant:r', ...grants],
	};
}

export function verifyWindowsAclOutput(output: string): boolean {
	const administrators = new RegExp(`\\*${WINDOWS_ADMINISTRATORS_SID}:`).test(output);
	const system = new RegExp(`\\*${WINDOWS_SYSTEM_SID}:`).test(output);
	const grants = output.match(/\([A-Z,]+\):(F|M|RX|R|W|D)/g) ?? [];
	const onlyAllowedGrantees =
		administrators &&
		system &&
		!/\*S-1-5-32-545:/.test(output) &&
		!/\bEveryone\b/i.test(output) &&
		!/\(I\)/.test(output);
	return onlyAllowedGrantees && grants.length > 0;
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
