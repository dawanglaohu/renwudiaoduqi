import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES } from '@agent-scheduler/shared/api/routes';
import {
	type InstalledProductLayout,
	evaluateStagedProductSupport,
	stageInstalledProduct,
} from '../src/artifact-staging.ts';
import { stageTauriBundle } from '../src/bundle-staging.ts';
import { type SpawnOptionsInjection, launchDaemon } from '../src/daemon-process.ts';
import { resolveLaunchSpec } from '../src/launch-spec.ts';
import { executeDaemonSmoke, inspectBuildPathResidue } from '../src/staging-smoke.ts';

/** Root of the daemon distribution produced by `scripts/build-daemon-distribution.mjs`. */
export const DAEMON_DISTRIBUTION_ENV = 'DESKTOP_DAEMON_DISTRIBUTION_DIR';

/** The single web build the daemon serves (`packages/web/dist`). */
export const WEB_DIST_ENV = 'DESKTOP_WEB_DIST_DIR';

/** The linked desktop shell executable produced by `cargo build --release`. */
export const DESKTOP_SHELL_BINARY_ENV = 'DESKTOP_SHELL_BINARY';

/** Real Tauri installer bundle to expand for release verification (MSI/DMG/deb). */
export const DESKTOP_BUNDLE_PATH_ENV = 'DESKTOP_BUNDLE_PATH';

/** Optional probe port override; the daemon's `AGSCHED_PORT` and the probe use the same value. */
export const SMOKE_PORT_ENV = 'DESKTOP_SMOKE_PORT';

/** Keeps the expanded installation on disk for inspection instead of deleting it. */
export const SMOKE_KEEP_STAGING_ENV = 'DESKTOP_SMOKE_KEEP_STAGING';

export interface StagedSmokeOptions {
	readonly daemonDistributionDir?: string;
	readonly webDistDir?: string;
	readonly desktopShellBinary?: string;
	readonly bundlePath?: string;
	readonly rootDir?: string;
	readonly hostPlatform?: 'win32' | 'darwin' | 'linux';
	readonly port?: number;
	readonly keepStaging?: boolean;
	readonly probeTimeoutMs?: number;
}

export interface StagedSmokeResult {
	readonly ok: boolean;
	readonly message: string;
	readonly stageDir?: string;
}

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const shellPackageDir = resolve(scriptDir, '..');
const repoRoot = resolve(shellPackageDir, '../..');
const tauriReleaseDir = join(shellPackageDir, 'src-tauri', 'target', 'release');

function hostPlatform(): 'win32' | 'darwin' | 'linux' {
	return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
}

/**
 * Default sources are what `tauri-build` placed next to the shell executable: the
 * `bundle.resources` entries of `tauri.conf.json` land in `target/release/` exactly as
 * they do in an installation, so the smoke check expands the same files the installer
 * carries.
 */
function defaultSources(platform: 'win32' | 'darwin' | 'linux'): {
	readonly daemonDistributionDir: string;
	readonly webDistDir: string;
	readonly desktopShellBinary: string;
} {
	return {
		daemonDistributionDir: join(tauriReleaseDir, 'daemon-runtime'),
		webDistDir: join(tauriReleaseDir, 'web', 'dist'),
		desktopShellBinary: join(
			tauriReleaseDir,
			platform === 'win32' ? 'desktop-shell.exe' : 'desktop-shell',
		),
	};
}

function defaultRootDir(): string {
	// macOS maps /var to /private/var. Tauri rejects an executable path that
	// contains a symlink before resolving its bundled Resources directory.
	return realpathSync(mkdtempSync(join(tmpdir(), 'agsched-smoke-')));
}

/**
 * Paths that must never appear inside a shipped installation: this checkout and its
 * parent, plus the generic CI runner roots (AC 2, E-209).
 */
export function forbiddenBuilderPrefixes(checkoutRoot: string): readonly string[] {
	return Object.freeze([
		'/home/runner/work',
		'/Users/runner/work',
		'C:\\Users\\runneradmin',
		'D:\\a\\',
		resolve(checkoutRoot),
		resolve(join(checkoutRoot, '..')),
	]);
}

function resolvePort(options?: StagedSmokeOptions): number {
	if (options?.port !== undefined) return options.port;
	const fromEnv = Number.parseInt(process.env[SMOKE_PORT_ENV] ?? '', 10);
	return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 7817;
}

function resolveKeepStaging(options?: StagedSmokeOptions): boolean {
	if (options?.keepStaging !== undefined) return options.keepStaging;
	return process.env[SMOKE_KEEP_STAGING_ENV] === '1';
}

/**
 * End-to-end staged installation check (AC 2, E-209, E-257, E-265):
 * expand the packager output into a path with spaces and non-ASCII characters, refuse
 * to continue when a product layer is missing or a build machine path leaked in,
 * resolve the frozen launch spec from the expanded `current_exe/resource_dir` the way
 * the native shell does, and really start the shipped daemon through that spec until
 * its health endpoint answers.
 */
export async function executeStagingSmokeCheck(
	options?: StagedSmokeOptions,
): Promise<StagedSmokeResult> {
	const platform = options?.hostPlatform ?? hostPlatform();
	const defaults = defaultSources(platform);
	const daemonDistributionDir =
		options?.daemonDistributionDir ??
		process.env[DAEMON_DISTRIBUTION_ENV] ??
		defaults.daemonDistributionDir;
	const webDistDir = options?.webDistDir ?? process.env[WEB_DIST_ENV] ?? defaults.webDistDir;
	const desktopShellBinary =
		options?.desktopShellBinary ??
		process.env[DESKTOP_SHELL_BINARY_ENV] ??
		defaults.desktopShellBinary;
	const bundlePath = options?.bundlePath ?? process.env[DESKTOP_BUNDLE_PATH_ENV];
	const rootDir = options?.rootDir ?? defaultRootDir();
	const ownsRoot = options?.rootDir === undefined;
	const keepStaging = resolveKeepStaging(options);
	const port = resolvePort(options);

	if (!bundlePath && !existsSync(daemonDistributionDir)) {
		return {
			ok: false,
			message: `The daemon distribution does not exist: ${daemonDistributionDir} (build it with \`pnpm --filter @agent-scheduler/shell-desktop build-daemon-distribution\` and \`cargo build --release\`, or point ${DAEMON_DISTRIBUTION_ENV} at it).`,
		};
	}

	let layout: InstalledProductLayout | undefined;
	try {
		console.log(`[smoke-runner] Expanding installed product for ${platform}...`);
		layout = bundlePath
			? stageTauriBundle({ bundlePath: resolve(bundlePath), rootDir, hostPlatform: platform })
			: stageInstalledProduct({
					sources: {
						daemonDistributionDir: resolve(daemonDistributionDir),
						webDistDir: resolve(webDistDir),
						desktopShellBinary: resolve(desktopShellBinary),
					},
					rootDir,
					hostPlatform: platform,
				});
		console.log(`[smoke-runner] Expanded installation to "${layout.stageDir}"`);
		console.log(
			`[smoke-runner] current_exe="${layout.currentExe}" resource_dir="${layout.resourceDir}"`,
		);

		const support = evaluateStagedProductSupport(layout, platform);
		if (support.missing.length > 0) {
			return {
				ok: false,
				stageDir: layout.stageDir,
				message: `Product layers missing on ${platform} (E-257): ${support.missing.join('; ')}`,
			};
		}
		console.log('[smoke-runner] Product layers present: daemon, path-adapter, desktop-shell.');

		const residue = inspectBuildPathResidue(layout.stageDir, forbiddenBuilderPrefixes(repoRoot));
		if (!residue.isClean) {
			return {
				ok: false,
				stageDir: layout.stageDir,
				message: `Staged installation contains build machine paths: ${residue.violations.join('; ')}`,
			};
		}
		console.log('[smoke-runner] Staged installation is free of build machine paths.');

		// The very call the native shell makes at startup: only the expanded
		// `current_exe/resource_dir` feed it, nothing from this process.
		const spec = resolveLaunchSpec({
			currentExe: layout.currentExe,
			resourceDir: layout.resourceDir,
			hostPlatform: platform,
		});
		if (spec.file !== layout.runtimeExecutable || spec.args[0] !== layout.daemonEntry) {
			return {
				ok: false,
				stageDir: layout.stageDir,
				message: `The resolved launch spec does not point at the shipped daemon: file="${spec.file}" args=[${spec.args.join(' ')}]`,
			};
		}
		console.log(
			`[smoke-runner] Starting daemon with file="${spec.file}" args=[${spec.args.join(' ')}] cwd="${spec.cwd}"`,
		);

		const dataDir = join(layout.stageDir, 'smoke-data');
		mkdirSync(dataDir, { recursive: true });
		const smokeOutcome = await executeDaemonSmoke(spec, {
			port,
			timeoutMs: options?.probeTimeoutMs ?? 60_000,
			// A daemon that refuses to start explains why on stderr; surface it in the log.
			inheritStdio: true,
			env: {
				...(process.env as Record<string, string>),
				AGSCHED_PORT: String(port),
				AGSCHED_BIND: '127.0.0.1',
				AGSCHED_DATA_DIR: dataDir,
			},
		});
		if (!smokeOutcome.success) {
			return {
				ok: false,
				stageDir: layout.stageDir,
				message: `The shipped daemon did not become healthy: ${smokeOutcome.error}`,
			};
		}
		console.log(
			`[smoke-runner] Shipped daemon healthy (status ${smokeOutcome.endpointStatus}) after ${smokeOutcome.durationMs}ms.`,
		);

		return {
			ok: true,
			stageDir: layout.stageDir,
			message: `Staged installation of the shipped daemon verified on ${platform}.`,
		};
	} catch (error) {
		return {
			ok: false,
			stageDir: layout?.stageDir,
			message: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (ownsRoot && !keepStaging) {
			try {
				rmSync(rootDir, { recursive: true, force: true });
			} catch {
				// Temporary cleanup is best effort.
			}
		}
	}
}

/** Paths the shell stage calls on the shipped daemon; both are entries of the shared ROUTES table. */
const HEALTH_PATH = '/api/v1/health' as const;
const CLAIM_PAIRING_PATH = '/api/v1/pair/claim' as const;

function requireRoute(method: 'GET' | 'POST', path: string): string {
	const route = ROUTES.find((entry) => entry.method === method && entry.path === path);
	if (!route) {
		throw new Error(`${method} ${path} is missing from the shared ROUTES table`);
	}
	return route.path;
}

/**
 * Env variables the harness hands to the shell executable. Mirrored in
 * `src-tauri/src/lib.rs`; the shell reads the token only while `AGSCHED_SMOKE=1`.
 */
export const SHELL_SMOKE_ENV = 'AGSCHED_SMOKE' as const;
export const SHELL_SMOKE_TOKEN_ENV = 'AGSCHED_SMOKE_TOKEN' as const;
/** Mirrors `SMOKE_POLL_INTERVAL_MS` / `SMOKE_TIMEOUT_MS` in `src-tauri/src/lib.rs`. */
export const SHELL_SMOKE_POLL_INTERVAL_MS = 500 as const;
export const SHELL_SMOKE_TIMEOUT_MS = 20_000 as const;

export interface ShellSmokeOptions extends StagedSmokeOptions {
	/** Extra slack on top of the shell's own 20s ceiling before the stage gives up. */
	readonly shellExitTimeoutMs?: number;
	/** Injection point for the daemon spawn (unit tests only; the default really spawns). */
	readonly customDaemonSpawn?: SpawnOptionsInjection['spawn'];
	/** Injection point for the shell spawn (unit tests only; the default really spawns). */
	readonly customShellSpawn?: ShellSpawnFunction;
}

export type ShellSpawnFunction = (
	file: string,
	args: readonly string[],
	options: { readonly stdio: 'inherit'; readonly env: Readonly<Record<string, string>> },
) => ChildProcess;

export interface ShellSmokeLaunchPlan {
	readonly file: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

/**
 * How the shell executable is started for the smoke (M10-T6 AC 3).
 *
 * Linux runners have no X display, so the shell goes through `xvfb-run`; the daemon runs
 * on the same port the shell is told to hint at, or the page would look for a service that
 * is not there (E-224).
 */
export function resolveShellSmokeLaunchPlan(options: {
	readonly hostPlatform: 'win32' | 'darwin' | 'linux';
	readonly shellBinary: string;
	readonly port: number;
	readonly token: string;
	readonly dataDir: string;
}): ShellSmokeLaunchPlan {
	const env = Object.freeze({
		[SHELL_SMOKE_ENV]: '1',
		[SHELL_SMOKE_TOKEN_ENV]: options.token,
		AGSCHED_PORT: String(options.port),
		AGSCHED_DATA_DIR: options.dataDir,
	});
	return options.hostPlatform === 'linux'
		? Object.freeze({
				file: 'xvfb-run',
				args: Object.freeze(['-a', options.shellBinary]),
				env,
			})
		: Object.freeze({ file: options.shellBinary, args: Object.freeze([]), env });
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * Waits for the one-time pairing code the daemon writes next to its data directory
 * (`packages/daemon/src/service/pairing.ts`). Its TTL is 60 seconds, so the shell stage
 * must claim the token immediately after this resolves.
 */
export async function readPairingCode(dataDir: string, timeoutMs = 30_000): Promise<string> {
	const codeFile = join(dataDir, 'pairing-code.txt');
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(codeFile)) {
			const code = readFileSync(codeFile, 'utf8').trim();
			if (code.length > 0) {
				return code;
			}
		}
		await delay(200);
	}
	throw new Error(`The shipped daemon never wrote a pairing code to ${codeFile}`);
}

/**
 * Exchanges the daemon's one-time code for a real device token over the real endpoint.
 * The shell smoke cannot type a code into `#/pair` (there is no GUI session, E-266), so the
 * harness pairs and hands the resulting token to the shell process.
 */
export async function claimSmokeDeviceToken(options: {
	readonly baseUrl: string;
	readonly code: string;
	readonly deviceName?: string;
}): Promise<string> {
	const path = requireRoute('POST', CLAIM_PAIRING_PATH);
	const response = await fetch(`${options.baseUrl}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			code: options.code,
			deviceName: options.deviceName ?? 'desktop-shell-smoke',
		}),
	});
	if (!response.ok) {
		throw new Error(`POST ${path} answered HTTP ${response.status}`);
	}
	const payload = (await response.json()) as { token?: unknown };
	if (typeof payload.token !== 'string' || payload.token.length === 0) {
		throw new Error(`POST ${path} returned no device token`);
	}
	return payload.token;
}

async function waitForDaemonHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
	const path = requireRoute('GET', HEALTH_PATH);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}${path}`, {
				signal: AbortSignal.timeout(2_000),
			});
			if (response.ok) {
				return true;
			}
		} catch {
			// Not up yet; keep probing until the deadline.
		}
		await delay(200);
	}
	return false;
}

function runShellProcess(
	plan: ShellSmokeLaunchPlan,
	timeoutMs: number,
	customSpawn?: ShellSpawnFunction,
): Promise<{ readonly exitCode: number | null; readonly timedOut: boolean }> {
	return new Promise((resolveRun) => {
		const spawnFunction = customSpawn ?? spawn;
		const child = spawnFunction(plan.file, [...plan.args], {
			stdio: 'inherit',
			env: { ...(process.env as Record<string, string>), ...plan.env },
		});
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			resolveRun({ exitCode: null, timedOut: true });
		}, timeoutMs);
		child.once('error', () => {
			clearTimeout(timer);
			resolveRun({ exitCode: null, timedOut: false });
		});
		child.once('exit', (code) => {
			clearTimeout(timer);
			resolveRun({ exitCode: code, timedOut: false });
		});
	});
}

/**
 * Shell smoke stage (M10-T6 AC 3, E-257, E-265, E-266).
 *
 * Expands the installation, starts the shipped daemon from the same frozen launch spec the
 * native shell uses, pairs a real device over the real endpoint, then starts the shell
 * executable with `AGSCHED_SMOKE=1` (through `xvfb-run` on Linux). The shell itself reads
 * `data-style-loaded` and `data-connection-status` out of the loaded page and exits 0 only
 * when both hold within 20 seconds; this stage only reports that verdict.
 *
 * It asserts nothing about clicks, notification banners or window behaviour: those stay on
 * the per-platform manual checklist (E-266).
 */
export async function executeShellSmokeCheck(
	options?: ShellSmokeOptions,
): Promise<StagedSmokeResult> {
	const platform = options?.hostPlatform ?? hostPlatform();
	const defaults = defaultSources(platform);
	const daemonDistributionDir =
		options?.daemonDistributionDir ??
		process.env[DAEMON_DISTRIBUTION_ENV] ??
		defaults.daemonDistributionDir;
	const webDistDir = options?.webDistDir ?? process.env[WEB_DIST_ENV] ?? defaults.webDistDir;
	const desktopShellBinary =
		options?.desktopShellBinary ??
		process.env[DESKTOP_SHELL_BINARY_ENV] ??
		defaults.desktopShellBinary;
	const bundlePath = options?.bundlePath ?? process.env[DESKTOP_BUNDLE_PATH_ENV];
	const rootDir = options?.rootDir ?? defaultRootDir();
	const ownsRoot = options?.rootDir === undefined;
	const keepStaging = resolveKeepStaging(options);
	const port = resolvePort(options);

	if (!bundlePath && !existsSync(daemonDistributionDir)) {
		return {
			ok: false,
			message: `The daemon distribution does not exist: ${daemonDistributionDir} (build it with \`pnpm --filter @agent-scheduler/shell-desktop build-daemon-distribution\` and \`cargo build --release\`, or point ${DAEMON_DISTRIBUTION_ENV} at it).`,
		};
	}

	let layout: InstalledProductLayout | undefined;
	let daemonPid: number | undefined;
	try {
		console.log(`[smoke-runner] Shell stage: expanding installed product for ${platform}...`);
		layout = bundlePath
			? stageTauriBundle({ bundlePath: resolve(bundlePath), rootDir, hostPlatform: platform })
			: stageInstalledProduct({
					sources: {
						daemonDistributionDir: resolve(daemonDistributionDir),
						webDistDir: resolve(webDistDir),
						desktopShellBinary: resolve(desktopShellBinary),
					},
					rootDir,
					hostPlatform: platform,
				});
		console.log(`[smoke-runner] Expanded installation to "${layout.stageDir}"`);

		const support = evaluateStagedProductSupport(layout, platform);
		if (support.missing.length > 0) {
			return {
				ok: false,
				stageDir: layout.stageDir,
				message: `Product layers missing on ${platform} (E-257): ${support.missing.join('; ')}`,
			};
		}

		const spec = resolveLaunchSpec({
			currentExe: layout.currentExe,
			resourceDir: layout.resourceDir,
			hostPlatform: platform,
		});
		if (!existsSync(layout.currentExe)) {
			return {
				ok: false,
				stageDir: layout.stageDir,
				message: `The desktop shell executable is missing from the expanded installation: ${layout.currentExe}`,
			};
		}

		const dataDir = join(layout.stageDir, 'shell-smoke-data');
		mkdirSync(dataDir, { recursive: true });
		const baseUrl = `http://127.0.0.1:${port}`;
		console.log(`[smoke-runner] Starting the shipped daemon for the shell stage on ${baseUrl}`);
		const daemon = launchDaemon(spec, {
			env: {
				...(process.env as Record<string, string>),
				AGSCHED_PORT: String(port),
				AGSCHED_BIND: '127.0.0.1',
				AGSCHED_DATA_DIR: dataDir,
			},
			stdio: 'inherit',
			...(options?.customDaemonSpawn ? { spawn: options.customDaemonSpawn } : {}),
		});
		if (!daemon.success || daemon.pid === undefined) {
			return {
				ok: false,
				stageDir: layout.stageDir,
				message: `The shipped daemon could not be started: ${daemon.error ?? 'no pid reported'}`,
			};
		}
		daemonPid = daemon.pid;

		if (!(await waitForDaemonHealth(baseUrl, options?.probeTimeoutMs ?? 60_000))) {
			return {
				ok: false,
				stageDir: layout.stageDir,
				message: `The shipped daemon did not answer ${baseUrl}${HEALTH_PATH} in time`,
			};
		}

		const pairingCode = await readPairingCode(dataDir);
		const token = await claimSmokeDeviceToken({ baseUrl, code: pairingCode });
		console.log('[smoke-runner] Paired a real device token for the shell smoke.');

		const plan = resolveShellSmokeLaunchPlan({
			hostPlatform: platform,
			shellBinary: layout.currentExe,
			port,
			token,
			dataDir,
		});
		console.log(
			`[smoke-runner] Starting the shell: file="${plan.file}" args=[${plan.args.join(' ')}] (${SHELL_SMOKE_ENV}=1)`,
		);
		const outcome = await runShellProcess(
			plan,
			options?.shellExitTimeoutMs ?? SHELL_SMOKE_TIMEOUT_MS + 40_000,
			options?.customShellSpawn,
		);
		if (outcome.timedOut) {
			return {
				ok: false,
				stageDir: layout.stageDir,
				message: `The shell did not exit within ${SHELL_SMOKE_TIMEOUT_MS}ms of starting; it never saw styleLoaded="true" together with connectionStatus="online"`,
			};
		}
		if (outcome.exitCode !== 0) {
			return {
				ok: false,
				stageDir: layout.stageDir,
				message: `The shell smoke exited with code ${String(outcome.exitCode)} instead of 0`,
			};
		}

		return {
			ok: true,
			stageDir: layout.stageDir,
			message: `The desktop shell rendered the web bundle and reached the shipped daemon on ${platform}.`,
		};
	} catch (error) {
		return {
			ok: false,
			stageDir: layout?.stageDir,
			message: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (daemonPid !== undefined) {
			try {
				process.kill(daemonPid, 'SIGTERM');
			} catch {
				// The daemon may already be gone; the staging root is removed either way.
			}
		}
		if (ownsRoot && !keepStaging) {
			try {
				rmSync(rootDir, { recursive: true, force: true });
			} catch {
				// Temporary cleanup is best effort.
			}
		}
	}
}

const isDirectExecution =
	Boolean(process.argv[1]) && resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);

/**
 * Stages this runner can execute: `staging` (installation layout + shipped daemon health)
 * and `shell` (the real shell executable against that daemon, M10-T6 AC 3).
 */
export type SmokeStage = 'staging' | 'shell';

export function resolveSmokeStage(argv: readonly string[]): SmokeStage {
	return argv.includes('shell') ? 'shell' : 'staging';
}

if (isDirectExecution) {
	const stage = resolveSmokeStage(process.argv.slice(2));
	console.log(`[smoke-runner] Running the ${stage} stage.`);
	const run = stage === 'shell' ? executeShellSmokeCheck() : executeStagingSmokeCheck();
	void run
		.then((result) => {
			if (result.ok) {
				console.log(`[smoke-runner] SUCCESS: ${result.message}`);
				process.exit(0);
			}
			console.error(`[smoke-runner] FAILED: ${result.message}`);
			process.exit(1);
		})
		.catch((error: unknown) => {
			console.error(
				`[smoke-runner] FAILED: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		});
}
