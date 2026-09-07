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
	decodeSpec,
	deniedFailure,
	encodeSpec,
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

export const LINUX_PATH_ADAPTER: PlatformPathAdapter = Object.freeze({
	platform: 'linux',
	requiresExecutablePermission: true,
	appDataDir: linuxAppDataDir,
	classifyPath: classifyLinuxPath,
	executableCandidatePaths: linuxExecutableCandidatePaths,
	toFileSystemPath: (value: string) => value,
});

export function linuxAppDataDir(hostInputs: PlatformHostInputs): AppDataDirectoryResult {
	if (!isUsableAbsolutePosixPath(hostInputs.homedir)) {
		return unresolvedDataDirectory(hostInputs.homedir);
	}

	const baseDirectory = isUsableAbsolutePosixPath(hostInputs.xdgDataHome)
		? hostInputs.xdgDataHome
		: posix.join(hostInputs.homedir, '.local', 'share');
	const path = posix.normalize(posix.join(baseDirectory, APPLICATION_DIRECTORY_NAME));
	return Object.freeze({ ok: true, path });
}

export function classifyLinuxPath(value: string): CurrentPlatformPath {
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

export function linuxExecutableCandidatePaths(
	executableName: string,
	hostInputs: PlatformHostInputs,
): readonly string[] {
	const directories = ['/usr/local/bin', '/usr/bin', '/snap/bin'];
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

function isUsableAbsolutePosixPath(value: string | undefined): value is string {
	return value !== undefined && isAbsolutePosixPath(value) && !hasUnexpandedPathToken(value);
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

// ---------------------------------------------------------------------------
// Process tree termination (E-119) shares the POSIX group implementation.
// ---------------------------------------------------------------------------

export { posixKillTree as linuxKillTree } from './kill-tree-posix.ts';

// ---------------------------------------------------------------------------
// Autostart via systemd --user (E-132, E-209). The launch spec rides in the
// unit Description after a marker line so status() recovers it without a side
// registry; ExecStart/WorkingDirectory carry the real file/args/cwd, never a
// shell. E-261: hosts without a user systemd instance surface
// E_AUTOSTART_UNSUPPORTED and no system-level unit is written.
// ---------------------------------------------------------------------------

export interface LinuxAutostartAdapter {
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

export const LINUX_AUTOSTART: LinuxAutostartAdapter = Object.freeze({
	register: linuxAutostartRegister,
	status: linuxAutostartStatus,
	unregister: linuxAutostartUnregister,
	deleteLine: linuxAutostartDeleteLine,
});

export function linuxAutostartDeleteLine(name: string, hostInputs: PlatformHostInputs): string {
	return (
		`systemctl --user disable --now ${systemdUnitName(name)} && rm -f ${systemdUnitPath(hostInputs, name)}`
	);
}

function systemdUnitName(name: string): string {
	return `${name}.service`;
}

function systemdUnitPath(hostInputs: PlatformHostInputs, name: string): string {
	return posix.join(hostInputs.homedir, '.config', 'systemd', 'user', systemdUnitName(name));
}

const LINUX_SPEC_TAG = 'agent-scheduler-spec\n';

async function linuxAutostartRegister(
	name: string,
	spec: DaemonLaunchSpec,
	hostInputs: PlatformHostInputs,
	runner: CommandRunner = defaultLinuxRunner,
): Promise<AutostartVoidResult> {
	const existing = await linuxAutostartStatus(name, spec, hostInputs);
	if (!existing.ok) return existing;
	if (existing.value.registered && existing.value.matchesSpec) {
		return Object.freeze({ ok: true, value: null });
	}
	const unitPath = systemdUnitPath(hostInputs, name);
	try {
		await mkdir(posix.dirname(unitPath), { recursive: true });
		await writeFile(unitPath, buildSystemdUnit(name, spec), 'utf8');
	} catch (cause) {
		return deniedFailure('register', Object.freeze({ unitPath }), cause);
	}
	const reload = await runner('systemctl', ['--user', 'daemon-reload']);
	if (reload.code !== 0) {
		await rm(unitPath, { force: true }).catch(() => undefined);
		return deniedFailure('register', Object.freeze({ unitPath, stderr: reload.stderr }));
	}
	const enable = await runner('systemctl', ['--user', 'enable', '--now', systemdUnitName(name)]);
	if (enable.code !== 0) {
		await rm(unitPath, { force: true }).catch(() => undefined);
		return deniedFailure('register', Object.freeze({ unitPath, stderr: enable.stderr }));
	}
	return Object.freeze({ ok: true, value: null });
}

async function linuxAutostartStatus(
	name: string,
	spec: DaemonLaunchSpec,
	hostInputs: PlatformHostInputs,
): Promise<AutostartOperationResult<AutostartStatus>> {
	const unitPath = systemdUnitPath(hostInputs, name);
	let content: string;
	try {
		content = await readFile(unitPath, 'utf8');
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
			return Object.freeze({
				ok: true,
				value: Object.freeze({ registered: false, matchesSpec: false }),
			});
		}
		return deniedFailure('status', Object.freeze({ unitPath }), cause);
	}
	const recorded = parseSystemdUnit(content);
	if (recorded === undefined) {
		return deniedFailure('status', Object.freeze({ unitPath, reason: 'unreadable-registration' }));
	}
	return Object.freeze({
		ok: true,
		value: Object.freeze({
			registered: true,
			matchesSpec: specsEqual(recorded, spec),
			recordedSpec: recorded,
		}),
	});
}

async function linuxAutostartUnregister(
	name: string,
	hostInputs: PlatformHostInputs,
	runner: CommandRunner = defaultLinuxRunner,
): Promise<AutostartVoidResult> {
	const unitPath = systemdUnitPath(hostInputs, name);
	const stop = await runner('systemctl', ['--user', 'disable', '--now', systemdUnitName(name)]);
	if (stop.code !== 0) {
		return deniedFailure(
			'unregister',
			Object.freeze({ unit: systemdUnitName(name), stderr: stop.stderr }),
		);
	}
	try {
		await rm(unitPath, { force: false });
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
			return deniedFailure('unregister', Object.freeze({ unitPath }), cause);
		}
	}
	await runner('systemctl', ['--user', 'daemon-reload']);
	return Object.freeze({ ok: true, value: null });
}

function buildSystemdUnit(name: string, spec: DaemonLaunchSpec): string {
	const encoded = encodeSpec(spec)
		.split('\n')
		.map((line) => `# ${line}`)
		.join('\n');
	return [
		'[Unit]',
		'Description=agent-scheduler daemon',
		'',
		'[Service]',
		'Type=simple',
		`WorkingDirectory=${quoteSystemdConfig(spec.cwd)}`,
		`ExecStart=${[spec.file, ...spec.args].map(quoteSystemdExec).join(' ')}`,
		'Restart=on-failure',
		'',
		'[Install]',
		'WantedBy=default.target',
		'',
		'# agent-scheduler-spec',
		`# ${encodeSpec(spec)}`,
		'',
	].join('\n');
}

function quoteSystemdExec(value: string): string {
	if (!/[\s"'\\$`]/.test(value)) return value;
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$')}"`;
}

function quoteSystemdConfig(value: string): string {
	return value.replace(/\n/g, '\\n');
}

function parseSystemdUnit(content: string): DaemonLaunchSpec | undefined {
	const marker = content.indexOf('# agent-scheduler-spec\n# ');
	if (marker === -1) return undefined;
	const after = content.slice(marker + '# agent-scheduler-spec\n# '.length);
	const encoded = after
		.split('\n')
		.filter((line) => line.startsWith('# '))
		.map((line) => line.slice(2))
		.join('\n');
	return decodeSpec(encoded);
}

const defaultLinuxRunner: CommandRunner = (file, args) =>
	new Promise((resolve, reject) => {
		const child = spawn(file, [...args], { shell: false });
		let stderr = '';
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.once('error', (cause) => reject(cause));
		child.once('close', (code) => {
			child.stderr?.removeAllListeners('data');
			resolve(Object.freeze({ code, stdout: '', stderr }));
		});
	});
