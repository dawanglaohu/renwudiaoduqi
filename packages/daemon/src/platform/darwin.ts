import { posix } from 'node:path';
import type { DaemonLaunchSpec } from '@agent-scheduler/shared/shell/daemon-launch-spec';
import type {
	AutostartAdapter,
	AutostartDependencies,
	AutostartOperationResult,
	AutostartStatus,
	AutostartVoidResult,
} from './autostart-contract.ts';
import { isValidAutostartName } from './autostart-contract.ts';
import {
	commandFailure,
	encodeSpecBase64,
	invalidNameFailure,
	isFileNotFound,
	quoteForSh,
	specsEqual,
	withManualStartCommand,
	xmlEscape,
	xmlUnescape,
} from './autostart-support.ts';
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

export { posixKillTree as darwinKillTree } from './kill-tree-posix.ts';

// ---------------------------------------------------------------------------
// Autostart via LaunchAgent (E-132, E-209). The spec survives a round trip:
// ProgramArguments/WorkingDirectory are authoritative, and a plist comment
// marker carries the base64-encoded spec for lossless field comparison.
// ---------------------------------------------------------------------------

export function darwinAutostartDeleteLine(name: string, hostInputs: PlatformHostInputs): string {
	const path = darwinPlistPath(hostInputs, name);
	return `launchctl unload -w ${quoteForSh(path)}; rm -f ${quoteForSh(path)}`;
}

export function darwinAutostartStartLine(spec: DaemonLaunchSpec): string {
	return `cd ${quoteForSh(spec.cwd)} && exec ${[spec.file, ...spec.args].map(quoteForSh).join(' ')}`;
}

function darwinPlistPath(hostInputs: PlatformHostInputs, name: string): string {
	return posix.join(hostInputs.homedir, 'Library', 'LaunchAgents', `${name}.plist`);
}

export function createDarwinAutostart(
	name: string,
	hostInputs: PlatformHostInputs,
	dependencies: AutostartDependencies,
): AutostartAdapter {
	return Object.freeze({
		register: async (spec: DaemonLaunchSpec) => {
			const result = await darwinAutostartRegister(name, spec, hostInputs, dependencies);
			return result.ok ? result : withManualStartCommand(result, darwinAutostartStartLine(spec));
		},
		status: (spec: DaemonLaunchSpec) => darwinAutostartStatus(name, spec, hostInputs, dependencies),
		unregister: () => darwinAutostartUnregister(name, hostInputs, dependencies),
		manualStartCommand: darwinAutostartStartLine,
		manualUnregisterCommand: darwinAutostartDeleteLine(name, hostInputs),
	});
}

async function darwinAutostartRegister(
	name: string,
	spec: DaemonLaunchSpec,
	hostInputs: PlatformHostInputs,
	dependencies: AutostartDependencies,
): Promise<AutostartVoidResult> {
	if (!isValidAutostartName(name)) return invalidNameFailure(name);
	const existing = await darwinAutostartStatus(name, spec, hostInputs, dependencies);
	if (!existing.ok) return existing;
	if (existing.value.registered && existing.value.matchesSpec) {
		return Object.freeze({ ok: true, value: null });
	}
	const path = darwinPlistPath(hostInputs, name);
	if (existing.value.registered) {
		const unloaded = await dependencies.runCommand('launchctl', ['unload', '-w', path]);
		if (!unloaded.ok && unloaded.kind !== 'not-found') {
			return commandFailure('register', unloaded, { plistPath: path, phase: 'unload-stale' });
		}
	}
	try {
		await dependencies.files.makeDirectory(posix.dirname(path));
		await dependencies.files.writeTextFile(path, buildLaunchAgentPlist(name, spec));
	} catch (cause: unknown) {
		return commandFailure(
			'register',
			{ ok: false, kind: 'failed', code: null, stdout: '', stderr: '', cause },
			{ plistPath: path },
		);
	}
	const loaded = await dependencies.runCommand('launchctl', ['load', '-w', path]);
	if (!loaded.ok) {
		await dependencies.files.removeFile(path).catch(() => undefined);
		return commandFailure('register', loaded, { plistPath: path });
	}
	return Object.freeze({ ok: true, value: null });
}

async function darwinAutostartStatus(
	name: string,
	spec: DaemonLaunchSpec,
	hostInputs: PlatformHostInputs,
	dependencies: AutostartDependencies,
): Promise<AutostatStatusUnion> {
	if (!isValidAutostartName(name)) return invalidNameFailure(name);
	const path = darwinPlistPath(hostInputs, name);
	const nativeStatus = await dependencies.runCommand('launchctl', ['list', name]);
	if (!nativeStatus.ok && nativeStatus.kind !== 'not-found') {
		return commandFailure('status', nativeStatus, { plistPath: path });
	}
	try {
		const content = await dependencies.files.readTextFile(path);
		const recorded = parseLaunchAgentPlist(content);
		if (recorded === undefined) {
			return commandFailure(
				'status',
				{ ok: false, kind: 'failed', code: null, stdout: '', stderr: '' },
				{ plistPath: path, reason: 'unreadable-registration' },
			);
		}
		if (!nativeStatus.ok && nativeStatus.kind === 'not-found') {
			return Object.freeze({
				ok: true,
				value: Object.freeze({ registered: false, matchesSpec: false, recordedSpec: recorded }),
			});
		}
		if (!nativeStatus.ok) return commandFailure('status', nativeStatus, { plistPath: path });
		return Object.freeze({
			ok: true,
			value: Object.freeze({
				registered: true,
				matchesSpec: specsEqual(recorded, spec),
				recordedSpec: recorded,
			}),
		});
	} catch (cause: unknown) {
		if (isFileNotFound(cause)) {
			return Object.freeze({
				ok: true,
				value: Object.freeze({ registered: nativeStatus.ok, matchesSpec: false }),
			});
		}
		return commandFailure(
			'status',
			{ ok: false, kind: 'failed', code: null, stdout: '', stderr: '', cause },
			{ plistPath: path },
		);
	}
}

type AutostatStatusUnion = AutostartOperationResult<AutostartStatus>;

async function darwinAutostartUnregister(
	name: string,
	hostInputs: PlatformHostInputs,
	dependencies: AutostartDependencies,
): Promise<AutostartVoidResult> {
	if (!isValidAutostartName(name)) return invalidNameFailure(name);
	const path = darwinPlistPath(hostInputs, name);
	const unloaded = await dependencies.runCommand('launchctl', ['unload', '-w', path]);
	if (!unloaded.ok && unloaded.kind !== 'not-found') {
		return commandFailure('unregister', unloaded, { plistPath: path });
	}
	try {
		await dependencies.files.removeFile(path);
	} catch (cause: unknown) {
		if (!isFileNotFound(cause)) {
			return commandFailure(
				'unregister',
				{ ok: false, kind: 'failed', code: null, stdout: '', stderr: '', cause },
				{ plistPath: path },
			);
		}
	}
	return Object.freeze({ ok: true, value: null });
}

function buildLaunchAgentPlist(name: string, spec: DaemonLaunchSpec): string {
	const argsXml = [spec.file, ...spec.args]
		.map((argument) => `    <string>${xmlEscape(argument)}</string>`)
		.join('\n');
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		`<!-- agent-scheduler-spec: ${encodeSpecBase64(spec)} -->`,
		'<dict>',
		'  <key>Label</key>',
		`  <string>${xmlEscape(name)}</string>`,
		'  <key>ProgramArguments</key>',
		'  <array>',
		argsXml,
		'  </array>',
		'  <key>WorkingDirectory</key>',
		`  <string>${xmlEscape(spec.cwd)}</string>`,
		'  <key>RunAtLoad</key>',
		'  <true/>',
		'</dict>',
		'</plist>',
		'',
	].join('\n');
}

function parseLaunchAgentPlist(content: string): DaemonLaunchSpec | undefined {
	const argsMatch = content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
	const cwdMatch = content.match(/<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/);
	if (argsMatch?.[1] === undefined || cwdMatch?.[1] === undefined) return undefined;
	const items = [...argsMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) =>
		xmlUnescape(match[1] ?? ''),
	);
	const file = items[0];
	if (file === undefined) return undefined;
	return Object.freeze({
		file,
		args: Object.freeze(items.slice(1)),
		cwd: xmlUnescape(cwdMatch[1]),
	});
}
