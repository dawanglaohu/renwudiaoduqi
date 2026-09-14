import type { AutostartAdapter } from '@agent-scheduler/daemon/platform/autostart-contract';
import {
	type DaemonLaunchSpec,
	isAbsoluteLaunchPath,
	parseDaemonLaunchSpec,
} from '@agent-scheduler/shared/shell/daemon-launch-spec';
import {
	type AutostartPreferenceStore,
	type SyncAutostartOptions,
	type SyncAutostartOutcome,
	syncDesktopAutostart,
} from './autostart-handler.ts';
import { type ConnectionUiController, createConnectionUiController } from './connection-ui.ts';
import type { LaunchDaemonResult } from './daemon-process.ts';

export interface ResolveLaunchSpecOptions {
	readonly currentExe: string;
	readonly resourceDir: string;
	readonly hostPlatform: string;
	readonly customDaemonPath?: string;
	readonly customArguments?: readonly string[];
}

function normalizeAbsolutePath(rawPath: string): string {
	const cleaned = rawPath.trim();
	if (!cleaned || cleaned.includes('\0')) {
		return '';
	}
	return cleaned;
}

/**
 * Resolves and validates a frozen DaemonLaunchSpec based on actual current_exe and resource_dir.
 *
 * Requirements (AC 2, E-146, E-209):
 * - Resolves absolute file, args[], absolute cwd.
 * - Freezes the returned launch specification.
 * - Prohibits shell strings or relative paths.
 */
export function resolveLaunchSpec(options: ResolveLaunchSpecOptions): DaemonLaunchSpec {
	const currentExe = normalizeAbsolutePath(options.currentExe);
	const resourceDir = normalizeAbsolutePath(options.resourceDir);

	if (!isAbsoluteLaunchPath(currentExe)) {
		throw new Error('Desktop executable path must be absolute.');
	}
	if (!isAbsoluteLaunchPath(resourceDir)) {
		throw new Error('Desktop resource directory must be absolute.');
	}

	const platform = options.hostPlatform;
	const isWindows = platform === 'win32';

	let daemonFile: string;
	if (options.customDaemonPath) {
		daemonFile = normalizeAbsolutePath(options.customDaemonPath);
	} else {
		const separator = isWindows ? '\\' : '/';
		const binaryName = isWindows ? 'daemon.exe' : 'daemon';
		const trimmedResource = resourceDir.endsWith(separator)
			? resourceDir.slice(0, -1)
			: resourceDir;
		daemonFile = `${trimmedResource}${separator}${binaryName}`;
	}

	const args = Object.freeze(options.customArguments ? [...options.customArguments] : []);
	const cwd = resourceDir;

	const candidate = {
		file: daemonFile,
		args,
		cwd,
	};

	const parseResult = parseDaemonLaunchSpec(candidate);
	if (!parseResult.ok) {
		const issueSummary = parseResult.issues
			.map((item) => `${item.path}: ${item.reason}`)
			.join(', ');
		throw new Error(`Invalid launch specification: ${issueSummary}`);
	}

	return parseResult.value;
}

export interface DesktopStartupOptions {
	readonly currentExe: string;
	readonly resourceDir: string;
	readonly hostPlatform: string;
	readonly autostartAdapter?: AutostartAdapter;
	readonly autostartStore?: AutostartPreferenceStore;
	readonly autostartSync?: (options: SyncAutostartOptions) => Promise<SyncAutostartOutcome>;
	readonly promptUser?: SyncAutostartOptions['promptUser'];
	readonly launcher?: (spec: DaemonLaunchSpec) => LaunchDaemonResult;
	readonly customDaemonPath?: string;
	readonly customArguments?: readonly string[];
}

export interface DesktopStartupContext {
	readonly spec: DaemonLaunchSpec;
	readonly connectionController: ConnectionUiController;
	readonly autostartOutcomePromise?: Promise<SyncAutostartOutcome>;
}

/**
 * Creates the unified desktop shell startup context (AC 2, AC 4, E-146, E-209).
 * Resolves the frozen DaemonLaunchSpec once and passes the identical frozen reference
 * to both the connection UI controller (manual start button) and autostart registration.
 */
export function createDesktopStartupContext(options: DesktopStartupOptions): DesktopStartupContext {
	const spec = resolveLaunchSpec({
		currentExe: options.currentExe,
		resourceDir: options.resourceDir,
		hostPlatform: options.hostPlatform,
		customDaemonPath: options.customDaemonPath,
		customArguments: options.customArguments,
	});

	const connectionController = createConnectionUiController(spec, options.launcher);

	let autostartOutcomePromise: Promise<SyncAutostartOutcome> | undefined;
	if (options.autostartAdapter) {
		const syncFn = options.autostartSync ?? syncDesktopAutostart;
		autostartOutcomePromise = syncFn({
			adapter: options.autostartAdapter,
			spec,
			store: options.autostartStore,
			promptUser: options.promptUser,
		});
	}

	return Object.freeze({
		spec,
		connectionController,
		autostartOutcomePromise,
	});
}
