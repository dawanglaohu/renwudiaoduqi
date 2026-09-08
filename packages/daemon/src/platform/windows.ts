import { win32 } from 'node:path';
import type { DaemonLaunchSpec } from '@agent-scheduler/shared/shell/daemon-launch-spec';
import type {
	AutostartAdapter,
	AutostartDependencies,
	AutostartOperationResult,
	AutostartStatus,
	AutostartVoidResult,
	CommandRunner,
} from './autostart-contract.ts';
import { isValidAutostartName } from './autostart-contract.ts';
import {
	commandFailure,
	encodeSpecBase64,
	invalidNameFailure,
	quoteForWindowsArgv,
	specsEqual,
	withManualStartCommand,
	xmlEscape,
	xmlUnescape,
} from './autostart-support.ts';
import type {
	AppDataDirectoryResult,
	CurrentPlatformPath,
	PlatformHostInputs,
	PlatformOperationError,
	PlatformPathAdapter,
} from './contract.ts';
import { hasUnexpandedPathToken } from './contract.ts';
import type {
	KillTreeAttempt,
	KillTreeAttemptMethod,
	KillTreeAttemptResult,
	KillTreeOptions,
	KillTreeProcessOps,
	KillTreeResult,
} from './kill-tree-contract.ts';
import { KILL_TREE_GRACE_MS } from './kill-tree-contract.ts';
import { finish, recordAttempt } from './kill-tree-posix.ts';

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

// ---------------------------------------------------------------------------
// Process tree termination (E-119): taskkill /PID <pid> /T first, /F added
// only after the 3s grace window. Killing only the parent leaves orphaned
// grandchildren holding file locks. Every attempt is emitted as an event.
// ---------------------------------------------------------------------------

export async function windowsKillTree(
	pid: number,
	processOps: KillTreeProcessOps,
	options: KillTreeOptions = {},
): Promise<KillTreeResult> {
	const graceMs = options.graceMs ?? KILL_TREE_GRACE_MS;
	const attempts: KillTreeAttempt[] = [];

	const attempt = async (
		method: KillTreeAttemptMethod,
		args: readonly string[],
	): Promise<KillTreeAttemptResult> => {
		const result = await processOps.taskkill(args);
		recordAttempt(pid, method, result, processOps, attempts, options.emit);
		return result;
	};

	const initial = await attempt('taskkill-soft', ['/PID', String(pid), '/T']);
	if (initial === 'terminated' || initial === 'not-process-owner') {
		return finish(pid, initial, attempts, options.emit);
	}

	await processOps.wait(graceMs);
	const afterGrace = await processOps.probeTree(pid);
	if (afterGrace !== 'still-running') {
		return finish(pid, afterGrace, attempts, options.emit);
	}

	const forced = await attempt('taskkill-force', ['/PID', String(pid), '/T', '/F']);
	return finish(pid, forced, attempts, options.emit);
}

// ---------------------------------------------------------------------------
// Autostart via Task Scheduler (E-132, E-209). register is idempotent: the
// current launch spec is embedded in the task description and compared
// field-by-field; any mismatch rewrites the native entry so an upgraded
// install never keeps pointing at the old file/args/cwd.
// ---------------------------------------------------------------------------

const WINDOWS_TASK_FOLDER = '\\AgentScheduler';

export function windowsAutostartDeleteLine(name: string): string {
	return `schtasks.exe /Delete /TN "${windowsTaskName(name)}" /F`;
}

export function windowsAutostartStartLine(spec: DaemonLaunchSpec): string {
	return `Set-Location -LiteralPath ${quoteForPowerShell(spec.cwd)}; & ${[spec.file, ...spec.args]
		.map(quoteForPowerShell)
		.join(' ')}`;
}

function windowsTaskName(name: string): string {
	return `${WINDOWS_TASK_FOLDER}\\${name}`;
}

export function createWindowsAutostart(
	name: string,
	dependencies: AutostartDependencies,
): AutostartAdapter {
	return Object.freeze({
		register: async (spec: DaemonLaunchSpec) => {
			const result = await windowsAutostartRegister(name, spec, dependencies);
			return result.ok ? result : withManualStartCommand(result, windowsAutostartStartLine(spec));
		},
		status: (spec: DaemonLaunchSpec) => windowsAutostartStatus(name, spec, dependencies.runCommand),
		unregister: () => windowsAutostartUnregister(name, dependencies.runCommand),
		manualStartCommand: windowsAutostartStartLine,
		manualUnregisterCommand: windowsAutostartDeleteLine(name),
	});
}

function quoteForPowerShell(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

async function windowsAutostartRegister(
	name: string,
	spec: DaemonLaunchSpec,
	dependencies: AutostartDependencies,
): Promise<AutostartVoidResult> {
	if (!isValidAutostartName(name)) return invalidNameFailure(name);
	const existing = await windowsAutostartStatus(name, spec, dependencies.runCommand);
	if (!existing.ok) return existing;
	if (existing.value.registered && existing.value.matchesSpec) {
		return Object.freeze({ ok: true, value: null });
	}
	const xml = buildWindowsTaskXml(spec);
	const xmlPath = win32.join(dependencies.temporaryDirectory, `${name}.xml`);
	try {
		await dependencies.files.makeDirectory(dependencies.temporaryDirectory);
		await dependencies.files.writeTextFile(xmlPath, xml);
	} catch (cause) {
		return commandFailure(
			'register',
			{ ok: false, kind: 'failed', code: null, stdout: '', stderr: '', cause },
			Object.freeze({ taskName: windowsTaskName(name), xmlPath }),
		);
	}
	try {
		const result = await dependencies.runCommand('schtasks.exe', [
			'/Create',
			'/TN',
			windowsTaskName(name),
			'/XML',
			xmlPath,
			'/F',
		]);
		if (!result.ok) return commandFailure('register', result, { taskName: windowsTaskName(name) });
		return Object.freeze({ ok: true, value: null });
	} finally {
		await dependencies.files.removeFile(xmlPath).catch(() => undefined);
	}
}

async function windowsAutostartStatus(
	name: string,
	spec: DaemonLaunchSpec,
	runner: CommandRunner,
): Promise<AutostartOperationResult<AutostartStatus>> {
	if (!isValidAutostartName(name)) return invalidNameFailure(name);
	const result = await runner('schtasks.exe', ['/Query', '/TN', windowsTaskName(name), '/XML']);
	if (!result.ok && result.kind === 'not-found') {
		return Object.freeze({
			ok: true,
			value: Object.freeze({ registered: false, matchesSpec: false }),
		});
	}
	if (!result.ok) return commandFailure('status', result, { taskName: windowsTaskName(name) });
	const recorded = parseWindowsTaskXml(result.stdout);
	if (recorded === undefined) {
		return commandFailure(
			'status',
			{ ok: false, kind: 'failed', code: 0, stdout: result.stdout, stderr: '' },
			{ taskName: windowsTaskName(name), reason: 'unreadable-registration' },
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
}

async function windowsAutostartUnregister(
	name: string,
	runner: CommandRunner,
): Promise<AutostartVoidResult> {
	if (!isValidAutostartName(name)) return invalidNameFailure(name);
	const result = await runner('schtasks.exe', ['/Delete', '/TN', windowsTaskName(name), '/F']);
	if (!result.ok && result.kind === 'not-found') return Object.freeze({ ok: true, value: null });
	if (!result.ok) return commandFailure('unregister', result, { taskName: windowsTaskName(name) });
	return Object.freeze({ ok: true, value: null });
}

function buildWindowsTaskXml(spec: DaemonLaunchSpec): string {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
		'  <RegistrationInfo>',
		`    <Description>agent-scheduler-spec:${encodeSpecBase64(spec)}</Description>`,
		'  </RegistrationInfo>',
		'  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>',
		'  <Settings>',
		'    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
		'    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
		'    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
		'    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
		'  </Settings>',
		'  <Actions Context="Author">',
		'    <Exec>',
		`      <Command>${xmlEscape(spec.file)}</Command>`,
		`      <Arguments>${xmlEscape(spec.args.map(quoteForWindowsArgv).join(' '))}</Arguments>`,
		`      <WorkingDirectory>${xmlEscape(spec.cwd)}</WorkingDirectory>`,
		'    </Exec>',
		'  </Actions>',
		'</Task>',
	].join('\n');
}

function parseWindowsTaskXml(xml: string): DaemonLaunchSpec | undefined {
	const extract = (tag: string): string | undefined => {
		const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
		return match?.[1] === undefined ? undefined : xmlUnescape(match[1].trim());
	};
	const file = extract('Command');
	const argsLine = extract('Arguments');
	const cwd = extract('WorkingDirectory');
	if (file === undefined || cwd === undefined) return undefined;
	const args =
		argsLine === undefined || argsLine.length === 0
			? Object.freeze([] as readonly string[])
			: Object.freeze(parseCommandLineToArgv(argsLine));
	return Object.freeze({ file, args, cwd });
}

/** Inverse of quoteForWindowsArgv: CommandLineToArgvW-compatible parsing. */
function parseCommandLineToArgv(commandLine: string): readonly string[] {
	const args: string[] = [];
	let current = '';
	let backslashes = 0;
	let inQuotes = false;
	let reading = false;
	const flush = (): void => {
		if (reading || current.length > 0) args.push(current);
		current = '';
		reading = false;
	};
	for (const char of commandLine) {
		if (char === '\\') {
			backslashes += 1;
			continue;
		}
		if (char === '"') {
			current += '\\'.repeat(Math.floor(backslashes / 2));
			if (backslashes % 2 === 0) {
				inQuotes = !inQuotes;
				reading = true;
			} else {
				current += '"';
			}
			backslashes = 0;
			continue;
		}
		current += '\\'.repeat(backslashes);
		backslashes = 0;
		if (/\s/.test(char) && !inQuotes) {
			flush();
			continue;
		}
		reading = true;
		current += char;
	}
	current += '\\'.repeat(backslashes);
	flush();
	return Object.freeze(args);
}
