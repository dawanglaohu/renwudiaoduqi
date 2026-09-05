import { constants as fileSystemConstants } from 'node:fs';
import {
	access as nodeAccess,
	lstat as nodeLstat,
	readlink as nodeReadlink,
	realpath as nodeRealpath,
	stat as nodeStat,
} from 'node:fs/promises';
import { posix } from 'node:path';
import type {
	ExecutableFileSystem,
	ExecutableResolutionErrorCode,
	PlatformOperationError,
	PlatformPathAdapter,
	ResolveExecutableInput,
	ResolveExecutableResult,
	ResolvedExecutable,
} from './contract.ts';
import { platformPathAdapter } from './host.ts';
import { comSpec } from './windows.ts';

const NODE_EXECUTABLE_FILE_SYSTEM: ExecutableFileSystem = Object.freeze({
	lstat: nodeLstat,
	readlink: nodeReadlink,
	realpath: nodeRealpath,
	stat: nodeStat,
	access: nodeAccess,
});

interface ValidatedExecutable {
	readonly ok: true;
	readonly path: string;
}

interface InvalidExecutable {
	readonly ok: false;
	readonly kind: 'missing' | 'not-executable' | 'invalid-target';
	readonly originalPath: string;
	readonly resolvedPath?: string;
	readonly cause?: unknown;
}

type ExecutableValidationResult = ValidatedExecutable | InvalidExecutable;

export async function resolveExecutable(
	input: ResolveExecutableInput,
	fileSystem: ExecutableFileSystem = NODE_EXECUTABLE_FILE_SYSTEM,
): Promise<ResolveExecutableResult> {
	const adapter = platformPathAdapter(input.hostInputs.platform);
	const hasConfiguredPath = input.configuredPath !== undefined && input.configuredPath !== '';
	if (!hasConfiguredPath && !isExecutableName(input.executableName)) {
		return invalidTargetFailure(input.executableName, [], 'invalid-executable-name');
	}

	const candidates = hasConfiguredPath
		? Object.freeze([input.configuredPath as string])
		: adapter.executableCandidatePaths(input.executableName, input.hostInputs);
	const checkedPaths: string[] = [];

	for (const candidate of candidates) {
		checkedPaths.push(candidate);
		const classified = adapter.classifyPath(candidate);
		if (!classified.isValidForCurrentPlatform) {
			return invalidTargetFailure(candidate, checkedPaths, classified.reason);
		}

		const validation = await validateExecutable(classified.normalizedPath, adapter, fileSystem);
		if (validation.ok) {
			return buildResolvedExecutable(validation.path, input, adapter, fileSystem, checkedPaths);
		}
		if (validation.kind === 'missing' && !hasConfiguredPath) continue;
		return validationFailure(validation, checkedPaths);
	}

	return notFoundFailure(input.executableName, checkedPaths);
}

async function buildResolvedExecutable(
	sourcePath: string,
	input: ResolveExecutableInput,
	adapter: PlatformPathAdapter,
	fileSystem: ExecutableFileSystem,
	checkedPaths: string[],
): Promise<ResolveExecutableResult> {
	if (adapter.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(sourcePath)) {
		return resolved({
			launchKind: 'direct',
			sourcePath,
			file: sourcePath,
			argsPrefix: Object.freeze([]),
			checkedPaths: freezePaths(checkedPaths),
		});
	}

	const commandProcessor = input.windowsComSpecPath ?? comSpec();
	checkedPaths.push(commandProcessor);
	const classified = adapter.classifyPath(commandProcessor);
	if (!classified.isValidForCurrentPlatform) {
		return invalidTargetFailure(commandProcessor, checkedPaths, classified.reason);
	}
	const commandProcessorValidation = await validateWindowsExecutable(
		classified.normalizedPath,
		adapter,
		fileSystem,
	);
	if (!commandProcessorValidation.ok) {
		return validationFailure(commandProcessorValidation, checkedPaths);
	}

	return resolved({
		launchKind: 'com-spec',
		sourcePath,
		file: commandProcessorValidation.path,
		argsPrefix: Object.freeze(['/d', '/s', '/c', `""${sourcePath}""`]),
		spawnOptions: Object.freeze({ windowsVerbatimArguments: true }),
		checkedPaths: freezePaths(checkedPaths),
	});
}

async function validateExecutable(
	path: string,
	adapter: PlatformPathAdapter,
	fileSystem: ExecutableFileSystem,
): Promise<ExecutableValidationResult> {
	return adapter.requiresExecutablePermission
		? validatePosixExecutable(path, adapter, fileSystem)
		: validateWindowsExecutable(path, adapter, fileSystem);
}

async function validateWindowsExecutable(
	path: string,
	adapter: PlatformPathAdapter,
	fileSystem: ExecutableFileSystem,
): Promise<ExecutableValidationResult> {
	try {
		const info = await fileSystem.stat(adapter.toFileSystemPath(path));
		return info.isFile()
			? Object.freeze({ ok: true, path })
			: invalidExecutable('invalid-target', path, path);
	} catch (cause) {
		return invalidExecutable(
			hasNativeErrorCode(cause, 'ENOENT') ? 'missing' : 'invalid-target',
			path,
			undefined,
			cause,
		);
	}
}

async function validatePosixExecutable(
	path: string,
	adapter: PlatformPathAdapter,
	fileSystem: ExecutableFileSystem,
): Promise<ExecutableValidationResult> {
	const fileSystemPath = adapter.toFileSystemPath(path);
	let initialInfo: Awaited<ReturnType<ExecutableFileSystem['lstat']>>;
	try {
		initialInfo = await fileSystem.lstat(fileSystemPath);
	} catch (cause) {
		return invalidExecutable(
			hasNativeErrorCode(cause, 'ENOENT') ? 'missing' : 'invalid-target',
			path,
			undefined,
			cause,
		);
	}

	let linkedTarget: string | undefined;
	if (initialInfo.isSymbolicLink()) {
		try {
			const target = await fileSystem.readlink(fileSystemPath);
			linkedTarget = posix.resolve(posix.dirname(path), target);
		} catch (cause) {
			return invalidExecutable('invalid-target', path, path, cause);
		}
	}

	let resolvedPath: string;
	try {
		resolvedPath = await fileSystem.realpath(fileSystemPath);
	} catch (cause) {
		return invalidExecutable('invalid-target', path, linkedTarget ?? path, cause);
	}

	const classifiedTarget = adapter.classifyPath(resolvedPath);
	if (!classifiedTarget.isValidForCurrentPlatform) {
		return invalidExecutable('invalid-target', path, resolvedPath);
	}
	resolvedPath = classifiedTarget.normalizedPath;

	try {
		const finalInfo = await fileSystem.stat(adapter.toFileSystemPath(resolvedPath));
		if (!finalInfo.isFile()) {
			return invalidExecutable('invalid-target', path, resolvedPath);
		}
	} catch (cause) {
		return invalidExecutable('invalid-target', path, resolvedPath, cause);
	}

	try {
		await fileSystem.access(adapter.toFileSystemPath(resolvedPath), fileSystemConstants.X_OK);
	} catch (cause) {
		return invalidExecutable(
			hasNativeErrorCode(cause, 'EACCES') || hasNativeErrorCode(cause, 'EPERM')
				? 'not-executable'
				: 'invalid-target',
			path,
			resolvedPath,
			cause,
		);
	}

	return Object.freeze({ ok: true, path: resolvedPath });
}

function validationFailure(
	validation: InvalidExecutable,
	checkedPaths: readonly string[],
): ResolveExecutableResult {
	if (validation.kind === 'missing') {
		return failure(
			'E_AGENT_EXEC_NOT_FOUND',
			'The executable file does not exist.',
			validation,
			checkedPaths,
		);
	}
	if (validation.kind === 'not-executable') {
		return failure(
			'E_AGENT_EXEC_NOT_EXECUTABLE',
			'The executable file does not have execute permission.',
			validation,
			checkedPaths,
		);
	}
	return failure(
		'E_AGENT_EXEC_INVALID_TARGET',
		'The executable path does not resolve to a regular file.',
		validation,
		checkedPaths,
	);
}

function notFoundFailure(
	executableName: string,
	checkedPaths: readonly string[],
): ResolveExecutableResult {
	return Object.freeze({
		ok: false,
		error: Object.freeze({
			code: 'E_AGENT_EXEC_NOT_FOUND',
			message: 'The executable was not found in the fixed platform locations.',
			details: Object.freeze({
				executableName,
				checkedPaths: freezePaths(checkedPaths),
			}),
		}),
	});
}

function invalidTargetFailure(
	originalPath: string,
	checkedPaths: readonly string[],
	reason: string,
): ResolveExecutableResult {
	return Object.freeze({
		ok: false,
		error: Object.freeze({
			code: 'E_AGENT_EXEC_INVALID_TARGET',
			message: 'The executable path is not an absolute path for the current platform.',
			details: Object.freeze({
				originalPath,
				reason,
				checkedPaths: freezePaths(checkedPaths),
			}),
		}),
	});
}

function failure(
	code: ExecutableResolutionErrorCode,
	message: string,
	validation: InvalidExecutable,
	checkedPaths: readonly string[],
): ResolveExecutableResult {
	const details = Object.freeze({
		originalPath: validation.originalPath,
		resolvedPath: validation.resolvedPath,
		checkedPaths: freezePaths(checkedPaths),
	});
	const error: PlatformOperationError<ExecutableResolutionErrorCode> = Object.freeze({
		code,
		message,
		details,
		cause: validation.cause,
	});
	return Object.freeze({ ok: false, error });
}

function resolved(executable: ResolvedExecutable): ResolveExecutableResult {
	return Object.freeze({ ok: true, executable: Object.freeze(executable) });
}

function freezePaths(paths: readonly string[]): readonly string[] {
	return Object.freeze([...paths]);
}

function isExecutableName(value: string): boolean {
	return (
		value.trim().length > 0 &&
		value !== '.' &&
		value !== '..' &&
		!value.includes('/') &&
		!value.includes('\\') &&
		!value.includes('\0')
	);
}

function hasNativeErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { readonly code?: unknown }).code === code
	);
}

function invalidExecutable(
	kind: InvalidExecutable['kind'],
	originalPath: string,
	resolvedPath?: string,
	cause?: unknown,
): InvalidExecutable {
	return Object.freeze({ ok: false, kind, originalPath, resolvedPath, cause });
}
