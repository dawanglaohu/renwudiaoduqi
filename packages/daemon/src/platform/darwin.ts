import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { DaemonLaunchSpec } from '@agent-scheduler/shared/shell/daemon-launch-spec';
import type {
	AutostartOperationResult,
	AutostartStatus,
	AutostartVoidResult,
} from './autostart-contract.ts';
import {
	type CommandRunner,
	decodeSpecBase64,
	deniedFailure,
	encodeSpecBase64,
	specsEqual,
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

export interface DarwinAutostartAdapter {
	readonly register: (
		name: string,
		spec: DaemonLaunchSpec,
		hostInputs: PlatformHostInputs,
		runner?: CommandRunner,
	) => Promise<AutostartVoidResult>;
	readonly status: (
		name: string,
		spec: DaemonLaunchSpec,
		hostInputs: PlatformHostInputs,
	) => Promise<AutostartOperationResult<AutostartStatus>>;
	readonly unregister: (
		name: string,
		hostInputs: PlatformHostInputs,
		runner?: CommandRunner,
	) => Promise<AutostartVoidResult>;
	readonly deleteLine: (name: string, hostInputs: PlatformHostInputs) => string;
}

export const DARWIN_AUTOSTART: DarwinAutostartAdapter = Object.freeze({
	register: darwinAutostartRegister,
	status: darwinAutostartStatus,
	unregister: darwinAutostartUnregister,
	deleteLine: darwinAutostartDeleteLine,
});

export function darwinAutostartDeleteLine(name: string, hostInputs: PlatformHostInputs): string {
	return `rm -f ${darwinPlistPath(hostInputs, name)}`;
}

function darwinPlistPath(hostInputs: PlatformHostInputs, name: string): string {
	return posix.join(hostInputs.homedir, 'Library', 'LaunchAgents', `${name}.plist`);
}

async function darwinAutostartRegister(
	name: string,
	spec: DaemonLaunchSpec,
	hostInputs: PlatformHostInputs,
	runner: CommandRunner = defaultDarwinRunner,
): Promise<AutostartVoidResult> {
	const existing = await darwinAutostartStatus(name, spec, hostInputs);
	if (!existing.ok) return existing;
	if (existing.value.registered && existing.value.matchesSpec) {
		return Object.freeze({ ok: true, value: null });
	}
	const path = darwinPlistPath(hostInputs, name);
	try {
		await mkdir(posix.dirname(path), { recursive: true });
		await writeFile(path, buildLaunchAgentPlist(name, spec), 'utf8');
	} catch (cause: unknown) {
		return deniedFailure('register', Object.freeze({ plistPath: path }), cause);
	}
	// Unload first so a stale in-memory entry cannot shadow the rewrite.
	await runLaunchctl(['unload', '-w', path], runner);
	const loaded = await runLaunchctl(['load', '-w', path], runner);
	if (loaded.code !== 0) {
		return deniedFailure('register', Object.freeze({ plistPath: path, stderr: loaded.stderr }));
	}
	return Object.freeze({ ok: true, value: null });
}

async function darwinAutostartStatus(
	name: string,
	spec: DaemonLaunchSpec,
	hostInputs: PlatformHostInputs,
): Promise<AutostatStatusUnion> {
	const path = darwinPlistPath(hostInputs, name);
	try {
		const content = await readFile(path, 'utf8');
		const recorded = parseLaunchAgentPlist(content) ?? parseEmbeddedSpec(content);
		if (recorded === undefined) {
			return deniedFailure(
				'status',
				Object.freeze({ plistPath: path, reason: 'unreadable-registration' }),
			);
		}
		return Object.freeze({
			ok: true,
			value: Object.freeze({
				registered: true,
				matchesSpec: specsEqual(recorded, spec),
				recordedSpec: recorded,
			}),
		});
	} catch (cause: unknown) {
		if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
			return Object.freeze({
				ok: true,
				value: Object.freeze({ registered: false, matchesSpec: false }),
			});
		}
		return deniedFailure('status', Object.freeze({ plistPath: path }), cause);
	}
}

type AutostatStatusUnion = AutostartOperationResult<AutostartStatus>;

async function darwinAutostartUnregister(
	name: string,
	hostInputs: PlatformHostInputs,
	runner: CommandRunner = defaultDarwinRunner,
): Promise<AutostartVoidResult> {
	const path = darwinPlistPath(hostInputs, name);
	await runLaunchctl(['unload', '-w', path], runner).catch(() => undefined);
	try {
		await rm(path, { force: false });
	} catch (cause: unknown) {
		if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
			return deniedFailure('unregister', Object.freeze({ plistPath: path }), cause);
		}
	}
	return Object.freeze({ ok: true, value: null });
}

function buildLaunchAgentPlist(name: string, spec: DaemonLaunchSpec): string {
	const argsXml = [spec.file, ...spec.args]
		.map((argument) => `    <string>${xmlEscapeText(argument)}</string>`)
		.join('\n');
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		`<!-- agent-scheduler-spec: ${encodeSpecBase64(spec)} -->`,
		'<dict>',
		'  <key>Label</key>',
		`  <string>${xmlEscapeText(name)}</string>`,
		'  <key>ProgramArguments</key>',
		'  <array>',
		argsXml,
		'  </array>',
		'  <key>WorkingDirectory</key>',
		`  <string>${xmlEscapeText(spec.cwd)}</string>`,
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
		xmlUnescapeText(match[1] ?? ''),
	);
	const file = items[0];
	if (file === undefined) return undefined;
	return Object.freeze({
		file,
		args: Object.freeze(items.slice(1)),
		cwd: xmlUnescapeText(cwdMatch[1]),
	});
}

function parseEmbeddedSpec(content: string): DaemonLaunchSpec | undefined {
	const match = content.match(/agent-scheduler-spec: ([A-Za-z0-9+/=]+)/);
	return match?.[1] === undefined ? undefined : decodeSpecBase64(match[1]);
}

function xmlEscapeText(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function xmlUnescapeText(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

function runLaunchctl(args: readonly string[], runner: CommandRunner) {
	return runner('launchctl', args).then(
		(result) => result,
		() => ({ code: null, stdout: '', stderr: '' }) as const,
	);
}

const defaultDarwinRunner: CommandRunner = (file, args) =>
	new Promise((resolve) => {
		spawn(file, [...args], { shell: false }).once('close', (code) =>
			resolve(Object.freeze({ code, stdout: '', stderr: '' })),
		);
	});
