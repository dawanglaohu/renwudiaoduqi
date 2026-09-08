import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { AppError } from '../errors/app-error.ts';
import {
	type NativeLockAdapter,
	type NativeLockCommand,
	type NativeLockCommandResult,
	type NativeLockFailure,
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

export type WindowsLockCommandRunner = (command: NativeLockCommand) => NativeLockCommandResult;

export function createWindowsLockAdapter(input: {
	readonly dirPath: string;
	readonly filePath: string;
	readonly permissionLines: readonly string[];
	readonly icaclsPath: string;
	readonly runCommand?: WindowsLockCommandRunner;
}): NativeLockAdapter {
	const reclaimPath = `${input.filePath}.reclaim`;
	return Object.freeze({
		platform: 'win32',
		filePath: input.filePath,
		dirPath: input.dirPath,
		reclaimPath,
		permissionLines: input.permissionLines,
		createExclusive: (contents: string) => writeWindowsFile(input, input.filePath, contents),
		read: () => readWindowsFile(input.filePath),
		remove: () => removeWindowsFile(input.filePath),
		verifyPermissions: () => verifyWindowsPermissions(input, input.filePath),
		createReclaimGuard: (contents: string) => writeWindowsFile(input, reclaimPath, contents),
		readReclaimGuard: () => readWindowsFile(reclaimPath),
		removeReclaimGuard: () => removeWindowsFile(reclaimPath),
		inspectPermissions: () => inspectWindowsAcl(input, input.filePath),
	});
}

function writeWindowsFile(
	input: {
		readonly dirPath: string;
		readonly runCommand?: WindowsLockCommandRunner;
		readonly icaclsPath: string;
	},
	filePath: string,
	contents: string,
): NativeLockWriteResult {
	let created = false;
	try {
		mkdirSync(input.dirPath, { recursive: true });
		applyAcl(input, input.dirPath, true);
		writeFileSync(filePath, contents, { encoding: 'utf8', flag: 'wx' });
		created = true;
		applyAcl(input, filePath, false);
		return { ok: true };
	} catch (cause) {
		if (created) removeWindowsFile(filePath);
		return { ok: false, failure: toNativeLockFailure(cause, filePath) };
	}
}

function readWindowsFile(filePath: string): NativeLockReadResult {
	try {
		return { ok: true, contents: readFileSync(filePath, 'utf8') };
	} catch (cause) {
		return { ok: false, failure: toNativeLockFailure(cause, filePath) };
	}
}

function removeWindowsFile(filePath: string): NativeLockWriteResult {
	try {
		unlinkSync(filePath);
		return { ok: true };
	} catch (cause) {
		const failure = toNativeLockFailure(cause, filePath);
		if (failure.kind === 'not-found') return { ok: true };
		return { ok: false, failure };
	}
}

function verifyWindowsPermissions(
	input: {
		readonly runCommand?: WindowsLockCommandRunner;
		readonly icaclsPath: string;
	},
	filePath: string,
): NativeLockWriteResult {
	const inspected = inspectWindowsAcl(input, filePath);
	if (!inspected.ok) return inspected;
	if (verifyWindowsAclOutput(inspected.contents)) return { ok: true };
	return {
		ok: false,
		failure: {
			kind: 'invalid-permissions',
			error: new AppError('E_INTERNAL', 'The machine-wide lock has an unsafe Windows ACL.', {
				details: { path: filePath },
			}),
		},
	};
}

function inspectWindowsAcl(
	input: {
		readonly runCommand?: WindowsLockCommandRunner;
		readonly icaclsPath: string;
	},
	filePath: string,
): NativeLockReadResult {
	if (input.runCommand === undefined) {
		return {
			ok: false,
			failure: {
				kind: 'permission-denied',
				error: new AppError(
					'E_INTERNAL',
					`Cannot inspect the machine-wide lock ACL at ${filePath} without an icacls runner.`,
					{ details: { path: filePath } },
				),
			},
		};
	}
	const output = input.runCommand({ file: input.icaclsPath, args: [filePath] });
	if (!output.ok) {
		return {
			ok: false,
			failure: {
				kind: 'permission-denied',
				error: new AppError(
					'E_INTERNAL',
					`Failed to inspect the machine-wide lock ACL at ${filePath}.`,
					{
						cause: output,
						details: { path: filePath, stderr: output.stderr },
					},
				),
			},
		};
	}
	return { ok: true, contents: output.stdout };
}

function applyAcl(
	input: {
		readonly runCommand?: WindowsLockCommandRunner;
		readonly icaclsPath: string;
	},
	path: string,
	isDirectory: boolean,
): void {
	if (input.runCommand === undefined) {
		throw nativeFailure('EACCES', `The Windows lock ACL cannot be applied at ${path}.`);
	}
	const result = input.runCommand(buildAclCommand(input.icaclsPath, path, isDirectory));
	if (!result.ok) {
		throw nativeFailure(
			'EACCES',
			`Failed to apply the Administrators/SYSTEM-only ACL at ${path}: ${result.stderr}`,
		);
	}
	const verification = verifyWindowsPermissions(input, path);
	if (!verification.ok) throw nativeFailure('EACCES', verification.failure.error.message);
}

function buildAclCommand(
	icaclsPath: string,
	path: string,
	isDirectory: boolean,
): NativeLockCommand {
	const grants = WINDOWS_LOCK_ACL.entries.map(
		(entry) => `*${entry.sid}:${isDirectory && entry.inherit ? '(OI)(CI)' : ''}${entry.rights}`,
	);
	return {
		file: icaclsPath,
		args: [path, '/inheritance:r', '/grant:r', ...grants],
	};
}

export function verifyWindowsAclOutput(output: string): boolean {
	if (/\(I\)/.test(output)) return false;
	const entries = extractAclEntries(output);
	const administrators = entries.find((entry) => isAdministratorsIdentity(entry.identity));
	const system = entries.find((entry) => isSystemIdentity(entry.identity));
	return (
		administrators?.rights === 'F' &&
		system?.rights === 'F' &&
		entries.every(
			(entry) => isAdministratorsIdentity(entry.identity) || isSystemIdentity(entry.identity),
		)
	);
}

function extractAclEntries(
	output: string,
): readonly { readonly identity: string; readonly rights: string }[] {
	const entries: { identity: string; rights: string }[] = [];
	const pattern = /([^\r\n]+?):(?:\([A-Z,]+\))*\((F|M|RX|R|W|D)\)/g;
	for (const match of output.matchAll(pattern)) {
		entries.push({ identity: (match[1] ?? '').trim(), rights: match[2] ?? '' });
	}
	return entries;
}

function isAdministratorsIdentity(identity: string): boolean {
	return (
		identity.endsWith(`*${WINDOWS_ADMINISTRATORS_SID}`) ||
		/\\Administrators$/i.test(identity) ||
		/^Administrators$/i.test(identity)
	);
}

function isSystemIdentity(identity: string): boolean {
	return (
		identity.endsWith(`*${WINDOWS_SYSTEM_SID}`) ||
		/\\SYSTEM$/i.test(identity) ||
		/^SYSTEM$/i.test(identity)
	);
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
		error:
			cause instanceof AppError
				? cause
				: new AppError('E_INTERNAL', nativeErrorMessage(kind, path), {
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
			return `The machine-wide lock has an unsafe ACL at ${path}.`;
		case 'internal':
			return `Failed to operate on the machine-wide lock at ${path}.`;
	}
}

function nativeFailure(
	code: string,
	message: string,
): { readonly code: string; readonly message: string } {
	return { code, message };
}

function getErrorCode(cause: unknown): string | undefined {
	if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
	return typeof cause.code === 'string' ? cause.code : undefined;
}
