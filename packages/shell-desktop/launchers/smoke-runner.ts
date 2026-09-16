import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type InstalledProductLayout,
	evaluateStagedProductSupport,
	stageInstalledProduct,
} from '../src/artifact-staging.ts';
import { resolveLaunchSpec } from '../src/launch-spec.ts';
import { executeDaemonSmoke, inspectBuildPathResidue } from '../src/staging-smoke.ts';

/** Root of the daemon distribution produced by `scripts/build-daemon-distribution.mjs`. */
export const DAEMON_DISTRIBUTION_ENV = 'DESKTOP_DAEMON_DISTRIBUTION_DIR';

/** The single web build the daemon serves (`packages/web/dist`). */
export const WEB_DIST_ENV = 'DESKTOP_WEB_DIST_DIR';

/** The linked desktop shell executable produced by `cargo build --release`. */
export const DESKTOP_SHELL_BINARY_ENV = 'DESKTOP_SHELL_BINARY';

/** Optional probe port override; the daemon's `AGSCHED_PORT` and the probe use the same value. */
export const SMOKE_PORT_ENV = 'DESKTOP_SMOKE_PORT';

/** Keeps the expanded installation on disk for inspection instead of deleting it. */
export const SMOKE_KEEP_STAGING_ENV = 'DESKTOP_SMOKE_KEEP_STAGING';

export interface StagedSmokeOptions {
	readonly daemonDistributionDir?: string;
	readonly webDistDir?: string;
	readonly desktopShellBinary?: string;
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
	return mkdtempSync(join(tmpdir(), 'agsched-smoke-'));
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
	const rootDir = options?.rootDir ?? defaultRootDir();
	const ownsRoot = options?.rootDir === undefined;
	const keepStaging = resolveKeepStaging(options);
	const port = resolvePort(options);

	if (!existsSync(daemonDistributionDir)) {
		return {
			ok: false,
			message: `The daemon distribution does not exist: ${daemonDistributionDir} (build it with \`pnpm --filter @agent-scheduler/shell-desktop build-daemon-distribution\` and \`cargo build --release\`, or point ${DAEMON_DISTRIBUTION_ENV} at it).`,
		};
	}

	let layout: InstalledProductLayout | undefined;
	try {
		console.log(`[smoke-runner] Expanding installed product for ${platform}...`);
		layout = stageInstalledProduct({
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

const isDirectExecution =
	Boolean(process.argv[1]) && resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);

if (isDirectExecution) {
	void executeStagingSmokeCheck()
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
