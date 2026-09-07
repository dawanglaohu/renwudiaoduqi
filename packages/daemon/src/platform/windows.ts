import { execFile, spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import type { DaemonLaunchSpec } from '@agent-scheduler/shared/shell/daemon-launch-spec';
import type {
	AutostartOperationResult,
	AutostartStatus,
	AutostartVoidResult,
} from './autostart-contract.ts';
import {
	type CommandRunner,
	deniedFailure,
	encodeSpec,
	quoteForWindowsArgv,
	specsEqual,
	xmlEscape,
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
	KillTreeClock,
	KillTreeEmit,
	KillTreeResult,
} from './kill-tree-contract.ts';
import { KILL_TREE_GRACE_MS } from './kill-tree-contract.ts';

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
	options: {
		readonly graceMs?: number;
		readonly clock?: KillTreeClock;
		readonly signal?: AbortSignal;
		readonly emit?: KillTreeEmit;
		readonly spawnImpl?: WindowsSpawnImpl;
	} = {},
): Promise<KillTreeResult> {
	const graceMs = options.graceMs ?? KILL_TREE_GRACE_MS;
	const clock = options.clock ?? { now: () => new Date().toISOString() };
	const spawnImpl = options.spawnImpl ?? defaultWindowsTaskkill;
	const attempts: KillTreeAttempt[] = [];

	const attempt = async (
		method: KillTreeAttemptMethod,
		args: readonly string[],
	): Promise<KillTreeAttemptResult> => {
		const result = await spawnImpl(args);
		const record: KillTreeAttempt = Object.freeze({
			attempt: attempts.length + 1,
			method,
			result,
			at: clock.now(),
		});
		attempts.push(record);
		options.emit?.(Object.freeze({ phase: 'attempt', pid, attempt: record }));
		return result;
	};

	const initial = await attempt('taskkill-soft', ['/PID', String(pid), '/T']);
	if (initial === 'terminated' || initial === 'not-process-owner') {
		return finishKillTree(pid, initial, attempts, options.emit);
	}

	await delayKillTree(graceMs, options.signal);

	const forced = await attempt('taskkill-force', ['/PID', String(pid), '/T', '/F']);
	return finishKillTree(pid, forced, attempts, options.emit);
}

export type WindowsSpawnImpl = (args: readonly string[]) => Promise<KillTreeAttemptResult>;

/** taskkill exit 128 means no process matched; "Access is denied" means EPERM. */
const defaultWindowsTaskkill: WindowsSpawnImpl = async (args) => {
	const child = spawn('taskkill.exe', [...args], {
		shell: false,
		windowsHide: true,
	});
	let stderr = '';
	child.stderr?.on('data', (chunk: Buffer) => {
		stderr += chunk.toString('utf8');
	});
	return new Promise((resolve) => {
		child.once('close', (code) => {
			child.stderr?.removeAllListeners('data');
			if (code === 0 || code === 128) {
				resolve('terminated');
			} else if (/access is denied/i.test(stderr)) {
				resolve('not-process-owner');
			} else {
				resolve('still-running');
			}
		});
		child.once('error', () => resolve('still-running'));
	});
};

function finishKillTree(
	pid: number,
	lastResult: KillTreeAttemptResult,
	attempts: readonly KillTreeAttempt[],
	emit?: KillTreeEmit,
): KillTreeResult {
	const outcome =
		lastResult === 'terminated'
			? 'terminated'
			: lastResult === 'not-process-owner'
				? 'not-process-owner'
				: 'survived';
	emit?.(Object.freeze({ phase: 'outcome', pid, outcome, attempts: Object.freeze([...attempts]) }));
	return Object.freeze({ outcome, attempts });
}

function delayKillTree(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, milliseconds);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(Object.assign(new Error('Aborted.'), { name: 'AbortError' }));
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

// ---------------------------------------------------------------------------
// Autostart via Task Scheduler (E-132, E-209). register is idempotent: the
// current launch spec is embedded in the task description and compared
// field-by-field; any mismatch rewrites the native entry so an upgraded
// install never keeps pointing at the old file/args/cwd.
// ---------------------------------------------------------------------------

const WINDOWS_TASK_FOLDER = '\\AgentScheduler';

export interface WindowsAutostartAdapter {
	readonly register: (
		name: string,
		spec: DaemonLaunchSpec,
		runner?: CommandRunner,
	) => Promise<AutostartVoidResult>;
	readonly status: (
		name: string,
		spec: DaemonLaunchSpec,
		runner?: CommandRunner,
	) => Promise<AutostartOperationResult<AutostartStatus>>;
	readonly unregister: (name: string, runner?: CommandRunner) => Promise<AutostartVoidResult>;
	readonly deleteLine: (name: string) => string;
}

export const WINDOWS_AUTOSTART: WindowsAutostartAdapter = Object.freeze({
	register: windowsAutostartRegister,
	status: windowsAutostartStatus,
	unregister: windowsAutostartUnregister,
	deleteLine: windowsAutostartDeleteLine,
});

export function windowsAutostartDeleteLine(name: string): string {
	return `schtasks.exe /Delete /TN "${windowsTaskName(name)}" /F`;
}

function windowsTaskName(name: string): string {
	return `${WINDOWS_TASK_FOLDER}\\${name}`;
}

async function windowsAutostartRegister(
	name: string,
	spec: DaemonLaunchSpec,
	runner: CommandRunner = defaultWindowsRunner,
): Promise<AutostartVoidResult> {
	const existing = await windowsAutostartStatus(name, spec, runner);
	if (!existing.ok) return existing;
	if (existing.value.registered && existing.value.matchesSpec) {
		return Object.freeze({ ok: true, value: null });
	}
	const xml = buildWindowsTaskXml(spec);
	const xmlPath = await writeTaskXmlFile(name, xml);
	try {
		const result = await runner('schtasks.exe', [
			'/Create',
			'/TN',
			windowsTaskName(name),
			'/XML',
			xmlPath,
			'/F',
		]);
		if (result.code !== 0) {
			return deniedFailure(
				'register',
				Object.freeze({ taskName: windowsTaskName(name), stderr: result.stderr }),
			);
		}
		return Object.freeze({ ok: true, value: null });
	} finally {
		await rm(xmlPath, { force: true }).catch(() => undefined);
	}
}

async function windowsAutostartStatus(
	name: string,
	spec: DaemonLaunchSpec,
	runner: CommandRunner = defaultWindowsRunner,
): Promise<AutostartOperationResult<AutostartStatus>> {
	const result = await runner('schtasks.exe', ['/Query', '/TN', windowsTaskName(name), '/XML']);
	if (result.code !== 0) {
		return Object.freeze({
			ok: true,
			value: Object.freeze({ registered: false, matchesSpec: false }),
		});
	}
	const recorded = parseWindowsTaskXml(result.stdout);
	if (recorded === undefined) {
		return deniedFailure(
			'status',
			Object.freeze({ taskName: windowsTaskName(name), reason: 'unreadable-registration' }),
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
	runner: CommandRunner = defaultWindowsRunner,
): Promise<AutostartVoidResult> {
	const result = await runner('schtasks.exe', ['/Delete', '/TN', windowsTaskName(name), '/F']);
	if (result.code !== 0) {
		return deniedFailure(
			'unregister',
			Object.freeze({ taskName: windowsTaskName(name), stderr: result.stderr }),
		);
	}
	return Object.freeze({ ok: true, value: null });
}

function buildWindowsTaskXml(spec: DaemonLaunchSpec): string {
	return [
		'<?xml version="1.0" encoding="UTF-16"?>',
		'<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
		'  <RegistrationInfo>',
		`    <Description>${xmlEscape(`agent-scheduler-spec\n${encodeSpec(spec)}`)}</Description>`,
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
	].join('\r\n');
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

function xmlUnescape(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#xA;/g, '\n')
		.replace(/&amp;/g, '&');
}

async function writeTaskXmlFile(name: string, xml: string): Promise<string> {
	const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
	const directory = win32.join(tmpdir(), 'agent-scheduler-autostart');
	await mkdir(directory, { recursive: true });
	const path = win32.join(directory, `${safe}.xml`);
	await writeFile(path, xml.replace(/\n/g, '\r\n'), 'utf8');
	return path;
}

const defaultWindowsRunner: CommandRunner = (file, args) =>
	new Promise((resolve, reject) => {
		execFile(file, [...args], { windowsHide: true }, (cause, stdout, stderr) => {
			if (cause && typeof cause.code === 'number') {
				resolve(
					Object.freeze({ code: cause.code, stdout: String(stdout), stderr: String(stderr) }),
				);
				return;
			}
			if (cause) {
				reject(cause);
				return;
			}
			resolve(Object.freeze({ code: 0, stdout: String(stdout), stderr: String(stderr) }));
		});
	});
