import { win32 } from 'node:path';
import type {
	AppDataDirectoryResult,
	CurrentPlatformPath,
	PlatformHostInputs,
	PlatformOperationError,
	PlatformPathAdapter,
} from './contract.ts';
import { hasUnexpandedPathToken } from './contract.ts';

const APPLICATION_DIRECTORY_NAME = 'agent-scheduler';
const DEFAULT_WINDOWS_DIRECTORY = 'C:\\Windows';
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/;
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat', ''] as const;
const CMD_META_CHARACTER = /([()\][%!^"`<>&|;, *?])/g;

export const WINDOWS_PATH_ADAPTER: PlatformPathAdapter = Object.freeze({
	platform: 'win32',
	requiresExecutablePermission: false,
	appDataDir: windowsAppDataDir,
	classifyPath: classifyWindowsPath,
	executableCandidatePaths: windowsExecutableCandidatePaths,
	toFileSystemPath: toWindowsFileSystemPath,
});

export function windowsAppDataDir(hostInputs: PlatformHostInputs): AppDataDirectoryResult {
	if (!isUsableAbsoluteWindowsPath(hostInputs.homedir)) {
		return unresolvedDataDirectory(hostInputs.homedir);
	}

	const baseDirectory = isUsableAbsoluteWindowsPath(hostInputs.appData)
		? hostInputs.appData
		: win32.join(hostInputs.homedir, 'AppData', 'Roaming');
	const path = win32.normalize(win32.join(baseDirectory, APPLICATION_DIRECTORY_NAME));
	if (!isUsableAbsoluteWindowsPath(path)) return unresolvedDataDirectory(hostInputs.homedir);

	return Object.freeze({ ok: true, path });
}

export function classifyWindowsPath(value: string): CurrentPlatformPath {
	if (isAbsoluteWindowsPath(value)) {
		return Object.freeze({
			isValidForCurrentPlatform: true,
			value,
			normalizedPath: win32.normalize(value),
		});
	}

	return Object.freeze({
		isValidForCurrentPlatform: false,
		value,
		reason: value.startsWith('/') ? 'foreign-platform-path' : 'not-absolute',
	});
}

export function toWindowsFileSystemPath(value: string): string {
	const classified = classifyWindowsPath(value);
	return classified.isValidForCurrentPlatform
		? win32.toNamespacedPath(classified.normalizedPath)
		: value;
}

export function windowsExecutableCandidatePaths(
	executableName: string,
	hostInputs: PlatformHostInputs,
): readonly string[] {
	const homeRoot = classifyWindowsPath(hostInputs.homedir);
	const roots = new Map<string, string>();
	const addRoot = (value: string): void => {
		const normalized = win32.normalize(value);
		roots.set(normalized.toLowerCase(), normalized);
	};

	if (homeRoot.isValidForCurrentPlatform) {
		const driveRoot = win32.parse(homeRoot.normalizedPath).root;
		addRoot(win32.join(homeRoot.normalizedPath, 'AppData', 'Roaming', 'npm'));
		addRoot(win32.join(homeRoot.normalizedPath, '.local', 'bin'));
		addRoot(win32.join(homeRoot.normalizedPath, '.grok', 'bin'));
		if (driveRoot.length > 0) {
			addRoot(win32.join(driveRoot, 'Program Files', 'nodejs', 'node_global'));
			addRoot(win32.join(driveRoot, 'Program Files', 'nodejs'));
		}
	}
	addRoot('C:\\Program Files\\nodejs\\node_global');
	addRoot('C:\\Program Files\\nodejs');

	const extension = win32.extname(executableName).toLowerCase();
	const hasKnownExtension =
		extension.length > 0 &&
		WINDOWS_EXECUTABLE_EXTENSIONS.includes(
			extension as (typeof WINDOWS_EXECUTABLE_EXTENSIONS)[number],
		);
	const names = hasKnownExtension
		? [executableName]
		: WINDOWS_EXECUTABLE_EXTENSIONS.map((suffix) => `${executableName}${suffix}`);
	const candidates = [...roots.values()].flatMap((directory) =>
		names.map((name) => win32.join(directory, name)),
	);
	return Object.freeze(candidates);
}

export function comSpec(): string {
	return win32.join(DEFAULT_WINDOWS_DIRECTORY, 'System32', 'cmd.exe');
}

/** Escapes one native argv value through ComSpec and a batch shim's %* forwarding. */
export function quoteForCmd(value: string): string {
	const escapedQuotes = value.replace(/(\\*)"/g, '$1$1\\"');
	const escapedTail = escapedQuotes.replace(/(\\*)$/g, '$1$1');
	// Quotes are shell syntax too: protect both cmd parsing passes, then let the
	// target executable decode the remaining quotes and backslashes as native argv.
	return `"${escapedTail}"`.replace(CMD_META_CHARACTER, '^$1').replace(CMD_META_CHARACTER, '^$1');
}

export interface ComSpecLaunch {
	readonly file: string;
	readonly args: readonly string[];
	readonly spawnOptions: { readonly windowsVerbatimArguments: true };
}

export type ComSpecLaunchResult =
	| { readonly ok: true; readonly launch: ComSpecLaunch }
	| {
			readonly ok: false;
			readonly error: PlatformOperationError<'E_VALIDATION'>;
	  };

/**
 * Takes validated absolute paths from resolveExecutable and the complete raw argv.
 * Returns immutable spawn inputs, or E_VALIDATION with the rejected argument index.
 * The batch shim must forward %* to its native CLI without adding another shell.
 */
export function wrapForComSpec(
	scriptPath: string,
	args: readonly string[],
	commandProcessorPath: string,
): ComSpecLaunchResult {
	let invalidIndex: number | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index] as string;
		if (argument.includes('\0') || argument.includes('\r') || argument.includes('\n')) {
			invalidIndex = index;
			break;
		}
	}
	if (invalidIndex !== undefined) {
		return Object.freeze({
			ok: false,
			error: Object.freeze({
				code: 'E_VALIDATION',
				message: 'The argument contains a character that cannot be passed through ComSpec.',
				details: Object.freeze({ argumentIndex: invalidIndex }),
			}),
		});
	}

	// The script path is interpreted only by the initial cmd, unlike its arguments.
	const parts = [scriptPath.replace(CMD_META_CHARACTER, '^$1')];
	for (const argument of args) {
		parts.push(quoteForCmd(argument));
	}

	return Object.freeze({
		ok: true,
		launch: Object.freeze({
			file: commandProcessorPath,
			args: Object.freeze(['/d', '/s', '/c', `"${parts.join(' ')}"`]),
			spawnOptions: Object.freeze({ windowsVerbatimArguments: true }),
		}),
	});
}

function isAbsoluteWindowsPath(value: string): boolean {
	return WINDOWS_DRIVE_ABSOLUTE.test(value) || WINDOWS_UNC_ABSOLUTE.test(value);
}

function isUsableAbsoluteWindowsPath(value: string | undefined): value is string {
	return value !== undefined && isAbsoluteWindowsPath(value) && !hasUnexpandedPathToken(value);
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
