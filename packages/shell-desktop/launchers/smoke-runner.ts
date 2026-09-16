import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type InstalledProductLayout,
	buildDaemonStartTarget,
	stageInstalledProduct,
} from '../src/artifact-staging.ts';
import {
	executeDaemonSmoke,
	inspectBuildPathResidue,
	resolveStagedLaunchSpec,
} from '../src/staging-smoke.ts';

/** Environment variable carrying the deployed daemon distribution produced by the packager. */
export const DAEMON_PACKAGE_ENV = 'DESKTOP_DAEMON_PACKAGE_DIR';

/** Optional probe port override; the launch spec and the probe use the same value. */
export const SMOKE_PORT_ENV = 'DESKTOP_SMOKE_PORT';

/** Keeps the expanded installation on disk for inspection instead of deleting it. */
export const SMOKE_KEEP_STAGING_ENV = 'DESKTOP_SMOKE_KEEP_STAGING';

export interface StagedSmokeOptions {
	/** Root of the deployed daemon distribution (`pnpm deploy --prod` output). */
	readonly daemonPackageDir?: string;
	readonly rootDir?: string;
	readonly hostPlatform?: 'win32' | 'darwin' | 'linux';
	readonly arch?: string;
	readonly port?: number;
	readonly keepStaging?: boolean;
	readonly probeTimeoutMs?: number;
}

export interface StagedSmokeResult {
	readonly ok: boolean;
	readonly message: string;
	readonly stageDir?: string;
}

function defaultRootDir(): string {
	return mkdtempSync(join(tmpdir(), 'agsched-smoke-'));
}

/**
 * Paths that must never appear inside a shipped installation: the build machine's own
 * checkout and workspace root, plus the generic CI runner roots (AC 2, E-209).
 */
export function forbiddenBuilderPrefixes(repoRoot: string): readonly string[] {
	return Object.freeze([
		'/home/runner/work',
		'C:\\Users\\runneradmin',
		'D:\\a\\',
		resolve(repoRoot),
		resolve(join(repoRoot, '..')),
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
 * End-to-end staged installation check (AC 2, AC 3, E-209, E-257):
 * expand the real installed product into a path with spaces and non-ASCII characters,
 * refuse to continue when a product layer is missing or a build machine path leaked in,
 * resolve the frozen launch spec from the expanded `current_exe/resource_dir` only, and
 * really start the shipped daemon through its health endpoint.
 */
export async function executeStagingSmokeCheck(
	options?: StagedSmokeOptions,
): Promise<StagedSmokeResult> {
	const platform = options?.hostPlatform ?? (process.platform as 'win32' | 'darwin' | 'linux');
	const daemonPackageDir = options?.daemonPackageDir ?? process.env[DAEMON_PACKAGE_ENV];
	const rootDir = options?.rootDir ?? defaultRootDir();
	const ownsRoot = options?.rootDir === undefined;
	const keepStaging = resolveKeepStaging(options);
	const port = resolvePort(options);

	if (!daemonPackageDir) {
		return {
			ok: false,
			message: `No deployed daemon distribution was provided; set ${DAEMON_PACKAGE_ENV} to the packager output (AC 2).`,
		};
	}
	if (!existsSync(daemonPackageDir)) {
		return {
			ok: false,
			message: `The deployed daemon distribution does not exist: ${daemonPackageDir}`,
		};
	}

	let layout: InstalledProductLayout | undefined;
	try {
		console.log(`[smoke-runner] Expanding installed product for ${platform}...`);
		layout = stageInstalledProduct({
			distribution: { rootDir: resolve(daemonPackageDir) },
			rootDir,
			hostPlatform: platform,
			arch: options?.arch,
		});
		console.log(`[smoke-runner] Expanded installation to "${layout.stageDir}"`);
		console.log(
			`[smoke-runner] current_exe="${layout.currentExe}" resource_dir="${layout.resourceDir}"`,
		);

		const residue = inspectBuildPathResidue(
			layout.stageDir,
			forbiddenBuilderPrefixes(process.cwd()),
		);
		if (!residue.isClean) {
			return {
				ok: false,
				stageDir: layout.stageDir,
				message: `Staged installation contains build machine paths: ${residue.violations.join('; ')}`,
			};
		}
		console.log('[smoke-runner] Staged installation is free of build machine paths.');

		const target = buildDaemonStartTarget(layout, { port });
		const spec = resolveStagedLaunchSpec({
			currentExe: layout.currentExe,
			resourceDir: layout.resourceDir,
			hostPlatform: platform,
			customDaemonPath: target.runtimeExecutable,
			customArguments: target.launchArguments,
		});
		console.log(
			`[smoke-runner] Starting daemon with file="${spec.file}" args=[${spec.args.join(' ')}] cwd="${spec.cwd}"`,
		);

		const smokeOutcome = await executeDaemonSmoke(spec, {
			port,
			timeoutMs: options?.probeTimeoutMs ?? 30_000,
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
