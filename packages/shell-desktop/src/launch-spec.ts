import type { AutostartAdapter } from '@agent-scheduler/daemon/platform/autostart-contract';
import { CURRENT_API_VERSION } from '@agent-scheduler/shared/api/system';
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
import {
	type VersionCheckOptions,
	type VersionCheckResult,
	checkDesktopApiVersion,
} from './version-check.ts';

export interface ResolveLaunchSpecOptions {
	readonly currentExe: string;
	readonly resourceDir: string;
	readonly hostPlatform: string;
	readonly customDaemonPath?: string;
	readonly customArguments?: readonly string[];
}

/** Directory under `resource_dir` that carries the shipped daemon application. */
export const DAEMON_RUNTIME_DIR_NAME = 'daemon-runtime';

/** Directory inside the daemon application that carries the bundled Node runtime. */
export const BUNDLED_RUNTIME_DIR_NAME = 'runtime';

/** Entry script of the shipped daemon application. */
export const DAEMON_ENTRY_FILE_NAME = 'bootstrap.mjs';

export interface ShippedDaemonLayout {
	/** `<resource_dir>/daemon-runtime` */
	readonly daemonDir: string;
	/** `<daemonDir>/runtime/node[.exe]`: the launch target. */
	readonly runtimeExecutable: string;
	/** `<daemonDir>/bootstrap.mjs`: the only argument handed to the runtime. */
	readonly daemonEntry: string;
}

export function bundledRuntimeExecutableName(hostPlatform: string): string {
	return hostPlatform === 'win32' ? 'node.exe' : 'node';
}

/**
 * Where the shipped daemon lives relative to `resource_dir` (AC 2, E-209).
 *
 * The daemon is a Node application, so the installation carries the runtime it needs
 * next to it instead of borrowing whatever Node the machine happens to have: the shell
 * starts `<resource_dir>/daemon-runtime/runtime/node[.exe]` with
 * `<resource_dir>/daemon-runtime/bootstrap.mjs` as its single argument. The native shell
 * in `src-tauri/src/lib.rs` derives the identical layout; both sides change together.
 */
export function resolveShippedDaemonLayout(
	resourceDir: string,
	hostPlatform: string,
): ShippedDaemonLayout {
	const separator = hostPlatform === 'win32' ? '\\' : '/';
	const trimmedResource = resourceDir.endsWith(separator) ? resourceDir.slice(0, -1) : resourceDir;
	const daemonDir = `${trimmedResource}${separator}${DAEMON_RUNTIME_DIR_NAME}`;
	return Object.freeze({
		daemonDir,
		runtimeExecutable: `${daemonDir}${separator}${BUNDLED_RUNTIME_DIR_NAME}${separator}${bundledRuntimeExecutableName(hostPlatform)}`,
		daemonEntry: `${daemonDir}${separator}${DAEMON_ENTRY_FILE_NAME}`,
	});
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
 * - Resolves absolute file, args[], absolute cwd from the shipped layout only.
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
	const extraArguments = options.customArguments ? [...options.customArguments] : [];

	let daemonFile: string;
	let args: readonly string[];
	if (options.customDaemonPath) {
		daemonFile = normalizeAbsolutePath(options.customDaemonPath);
		args = Object.freeze(extraArguments);
	} else {
		const layout = resolveShippedDaemonLayout(resourceDir, platform);
		daemonFile = layout.runtimeExecutable;
		args = Object.freeze([layout.daemonEntry, ...extraArguments]);
	}

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
	readonly hostHint?: () => Promise<string | null> | string | null;
	readonly versionFetcher?: VersionCheckOptions['fetcher'];
}

export interface DesktopStartupContext {
	readonly spec: DaemonLaunchSpec;
	readonly connectionController: ConnectionUiController;
	readonly autostartOutcomePromise?: Promise<SyncAutostartOutcome>;
	readonly versionCheckPromise: Promise<VersionCheckResult>;
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

	const versionCheckPromise = Promise.resolve()
		.then(async () => {
			const hinted = options.hostHint ? await options.hostHint() : null;
			return checkDesktopApiVersion({
				baseUrl: hinted,
				fetcher: options.versionFetcher,
			});
		})
		.then((result) => {
			// E-146 vs E-14: only a reachable-but-mismatched (or unusable) version
			// endpoint switches the shell to the upgrade view. An unreachable daemon
			// keeps the connection-failed view with its 「启动 daemon」 button.
			if (!result.compatible && result.reason !== 'unreachable') {
				connectionController.setIncompatible(
					result.apiVersion ?? 'unknown',
					result.expectedVersion,
				);
			}
			return result;
		})
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			return {
				compatible: false as const,
				reason: 'unreachable' as const,
				expectedVersion: CURRENT_API_VERSION,
				message,
				upgradePrompt: '电脑上的调度服务未启动。请先启动调度服务后再打开桌面客户端。',
			};
		});

	return Object.freeze({
		spec,
		connectionController,
		autostartOutcomePromise,
		versionCheckPromise,
	});
}
