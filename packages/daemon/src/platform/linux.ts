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
	decodeSpecBase64,
	encodeSpecBase64,
	invalidNameFailure,
	isFileNotFound,
	quoteForSh,
	specsEqual,
	withManualStartCommand,
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

export function linuxAutostartDeleteLine(name: string, hostInputs: PlatformHostInputs): string {
	return `systemctl --user disable --now ${systemdUnitName(name)}; rm -f '${systemdUnitPath(hostInputs, name).replace(/'/g, `'\\''`)}'; systemctl --user daemon-reload`;
}

export function linuxAutostartStartLine(spec: DaemonLaunchSpec): string {
	return `cd ${quoteForSh(spec.cwd)} && exec ${[spec.file, ...spec.args].map(quoteForSh).join(' ')}`;
}

function systemdUnitName(name: string): string {
	return `${name}.service`;
}

function systemdUnitPath(hostInputs: PlatformHostInputs, name: string): string {
	return posix.join(hostInputs.homedir, '.config', 'systemd', 'user', systemdUnitName(name));
}

export function createLinuxAutostart(
	name: string,
	hostInputs: PlatformHostInputs,
	dependencies: AutostartDependencies,
): AutostartAdapter {
	return Object.freeze({
		register: async (spec: DaemonLaunchSpec) => {
			const result = await linuxAutostartRegister(name, spec, hostInputs, dependencies);
			return result.ok ? result : withManualStartCommand(result, linuxAutostartStartLine(spec));
		},
		status: (spec: DaemonLaunchSpec) => linuxAutostartStatus(name, spec, hostInputs, dependencies),
		unregister: () => linuxAutostartUnregister(name, hostInputs, dependencies),
		manualStartCommand: linuxAutostartStartLine,
		manualUnregisterCommand: linuxAutostartDeleteLine(name, hostInputs),
	});
}

async function linuxAutostartRegister(
	name: string,
	spec: DaemonLaunchSpec,
	hostInputs: PlatformHostInputs,
	dependencies: AutostartDependencies,
): Promise<AutostartVoidResult> {
	if (!isValidAutostartName(name)) return invalidNameFailure(name);
	const existing = await linuxAutostartStatus(name, spec, hostInputs, dependencies);
	if (!existing.ok) return existing;
	if (existing.value.registered && existing.value.matchesSpec) {
		return Object.freeze({ ok: true, value: null });
	}
	const unitPath = systemdUnitPath(hostInputs, name);
	try {
		await dependencies.files.makeDirectory(posix.dirname(unitPath));
		await dependencies.files.writeTextFile(unitPath, buildSystemdUnit(spec));
	} catch (cause) {
		return commandFailure(
			'register',
			{ ok: false, kind: 'failed', code: null, stdout: '', stderr: '', cause },
			{ unitPath },
		);
	}
	const reload = await dependencies.runCommand('systemctl', ['--user', 'daemon-reload']);
	if (!reload.ok) {
		await dependencies.files.removeFile(unitPath).catch(() => undefined);
		return commandFailure('register', reload, { unitPath });
	}
	const enable = await dependencies.runCommand('systemctl', [
		'--user',
		'enable',
		'--now',
		systemdUnitName(name),
	]);
	if (!enable.ok) {
		const disabled = await dependencies.runCommand('systemctl', [
			'--user',
			'disable',
			'--now',
			systemdUnitName(name),
		]);
		let rollbackFailure =
			!disabled.ok && disabled.kind !== 'not-found'
				? commandFailure('register', disabled, { unitPath, phase: 'rollback-disable' })
				: undefined;
		try {
			await dependencies.files.removeFile(unitPath);
		} catch (cause) {
			if (!isFileNotFound(cause)) {
				rollbackFailure ??= commandFailure(
					'register',
					{ ok: false, kind: 'failed', code: null, stdout: '', stderr: '', cause },
					{ unitPath, phase: 'rollback-remove' },
				);
			}
		}
		const rollbackReload = await dependencies.runCommand('systemctl', ['--user', 'daemon-reload']);
		if (!rollbackReload.ok && rollbackFailure === undefined) {
			rollbackFailure = commandFailure('register', rollbackReload, {
				unitPath,
				phase: 'rollback-reload',
			});
		}
		if (rollbackFailure !== undefined) return rollbackFailure;
		return commandFailure('register', enable, { unitPath });
	}
	return Object.freeze({ ok: true, value: null });
}

async function linuxAutostartStatus(
	name: string,
	spec: DaemonLaunchSpec,
	hostInputs: PlatformHostInputs,
	dependencies: AutostartDependencies,
): Promise<AutostartOperationResult<AutostartStatus>> {
	if (!isValidAutostartName(name)) return invalidNameFailure(name);
	const unitPath = systemdUnitPath(hostInputs, name);
	const nativeStatus = await dependencies.runCommand('systemctl', [
		'--user',
		'is-enabled',
		systemdUnitName(name),
	]);
	if (!nativeStatus.ok && nativeStatus.kind !== 'not-found') {
		return commandFailure('status', nativeStatus, { unitPath });
	}
	let content: string;
	try {
		content = await dependencies.files.readTextFile(unitPath);
	} catch (cause) {
		if (isFileNotFound(cause)) {
			return Object.freeze({
				ok: true,
				value: Object.freeze({ registered: nativeStatus.ok, matchesSpec: false }),
			});
		}
		return commandFailure(
			'status',
			{ ok: false, kind: 'failed', code: null, stdout: '', stderr: '', cause },
			{ unitPath },
		);
	}
	const recorded = parseSystemdUnit(content);
	if (recorded === undefined) {
		return commandFailure(
			'status',
			{ ok: false, kind: 'failed', code: null, stdout: '', stderr: '' },
			{ unitPath, reason: 'unreadable-registration' },
		);
	}
	if (!nativeStatus.ok && nativeStatus.kind === 'not-found') {
		return Object.freeze({
			ok: true,
			value: Object.freeze({ registered: false, matchesSpec: false, recordedSpec: recorded }),
		});
	}
	if (!nativeStatus.ok) return commandFailure('status', nativeStatus, { unitPath });
	return Object.freeze({
		ok: true,
		value: Object.freeze({
			registered: true,
			matchesSpec: specsEqual(recorded, spec) && content === buildSystemdUnit(recorded),
			recordedSpec: recorded,
		}),
	});
}

async function linuxAutostartUnregister(
	name: string,
	hostInputs: PlatformHostInputs,
	dependencies: AutostartDependencies,
): Promise<AutostartVoidResult> {
	if (!isValidAutostartName(name)) return invalidNameFailure(name);
	const unitPath = systemdUnitPath(hostInputs, name);
	const stop = await dependencies.runCommand('systemctl', [
		'--user',
		'disable',
		'--now',
		systemdUnitName(name),
	]);
	if (!stop.ok && stop.kind !== 'not-found') {
		return commandFailure('unregister', stop, { unit: systemdUnitName(name) });
	}
	try {
		await dependencies.files.removeFile(unitPath);
	} catch (cause) {
		if (!isFileNotFound(cause)) {
			return commandFailure(
				'unregister',
				{ ok: false, kind: 'failed', code: null, stdout: '', stderr: '', cause },
				{ unitPath },
			);
		}
	}
	const reload = await dependencies.runCommand('systemctl', ['--user', 'daemon-reload']);
	if (!reload.ok) return commandFailure('unregister', reload, { unitPath });
	return Object.freeze({ ok: true, value: null });
}

function buildSystemdUnit(spec: DaemonLaunchSpec): string {
	return [
		'[Unit]',
		'Description=agent-scheduler daemon',
		'',
		'[Service]',
		'Type=simple',
		`WorkingDirectory=${quoteSystemdValue(spec.cwd)}`,
		`ExecStart=${[spec.file, ...spec.args].map(quoteSystemdExec).join(' ')}`,
		'Restart=on-failure',
		'',
		'[Install]',
		'WantedBy=default.target',
		'',
		`# agent-scheduler-spec:${encodeSpecBase64(spec)}`,
		'',
	].join('\n');
}

function quoteSystemdExec(value: string): string {
	return quoteSystemdValue(value);
}

function quoteSystemdValue(value: string): string {
	return `"${value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t')
		.replace(/\$/g, '$$')
		.replace(/%/g, '%%')}"`;
}

function parseSystemdUnit(content: string): DaemonLaunchSpec | undefined {
	const marker = content.match(/# agent-scheduler-spec:([A-Za-z0-9+/=]+)/);
	return marker?.[1] === undefined ? undefined : decodeSpecBase64(marker[1]);
}
