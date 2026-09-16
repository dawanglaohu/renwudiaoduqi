import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
	type DaemonLaunchSpec,
	isAbsoluteLaunchPath,
	parseDaemonLaunchSpec,
} from '@agent-scheduler/shared/shell/daemon-launch-spec';
import { type PlatformProductLayers, evaluatePlatformSupport } from './platform-support.ts';

/**
 * A deployed daemon distribution: `pnpm --filter @agent-scheduler/daemon deploy --prod`
 * output, i.e. the daemon application plus its runtime dependencies resolved into a
 * single directory. This is what the installer carries inside the desktop resources.
 */
export interface DaemonDistribution {
	/** Root of the deployed daemon distribution. */
	readonly rootDir: string;
	/** Node runtime root name inside `node_modules` when the distribution bundles one. */
	readonly bundledRuntimeDir?: string;
}

export interface StageInstalledProductOptions {
	readonly distribution: DaemonDistribution;
	/** Temporary root that receives the extracted installation. */
	readonly rootDir: string;
	readonly hostPlatform: 'win32' | 'darwin' | 'linux';
	readonly arch?: string;
	readonly folderName?: string;
	readonly desktopShellName?: string;
	/**
	 * Fails when the distribution has no `bootstrap.mjs`. Layer verification wants to
	 * inspect an incomplete package instead of being stopped at expansion time.
	 */
	readonly requireDaemonEntry?: boolean;
}

export interface InstalledProductLayout {
	readonly stageDir: string;
	readonly currentExe: string;
	readonly resourceDir: string;
	/** `<resourceDir>/daemon-runtime` — the daemon application as shipped. */
	readonly runtimeDir: string;
	/** Bundled runtime executable used to start the daemon (`node`/`node.exe`). */
	readonly runtimeExecutable: string;
	/** `bootstrap.mjs` entry inside the shipped daemon application. */
	readonly daemonEntry: string;
}

const RUNTIME_DIR_NAME = 'daemon-runtime';
const DAEMON_ENTRY_NAME = 'bootstrap.mjs';
const RUNTIME_EXECUTABLE_BASE = 'node';
const CONVENTION_DIRS = ['bin', 'resources', 'resources/daemon-runtime', 'lib'];

function platformExecutableSuffix(platform: 'win32' | 'darwin' | 'linux'): string {
	return platform === 'win32' ? '.exe' : '';
}

function joinFor(platform: 'win32' | 'darwin' | 'linux', ...parts: string[]): string {
	const separator = platform === 'win32' ? '\\' : '/';
	return parts.join(separator);
}

/** Node runtime packages name the Windows platform `win`, not `win32`. */
function runtimePackagePlatform(platform: 'win32' | 'darwin' | 'linux'): string {
	return platform === 'win32' ? 'win' : platform;
}

/**
 * Locates the Node runtime executable inside a deployed distribution.
 *
 * The distribution may bundle the runtime through the `node<major>-<platform>-<arch>`
 * optional dependency packages (which carry `<pkg>/bin/node[.exe]`); when it does not,
 * only a host runtime is available and `undefined` is returned so the caller can fall
 * back explicitly instead of silently producing a non-shippable launch target.
 */
export function locateBundledRuntime(
	distribution: DaemonDistribution,
	platform: 'win32' | 'darwin' | 'linux',
	arch: string,
): string | undefined {
	const nodeModules = join(distribution.rootDir, 'node_modules');
	if (!existsSync(nodeModules)) return undefined;

	const requested = `${runtimePackagePlatform(platform)}-${arch}`;
	const candidates = readdirSync(nodeModules)
		.filter((entry) => /^node\d+-/.test(entry))
		.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));

	const matching = candidates.filter((entry) => entry.endsWith(requested));
	for (const name of matching) {
		const candidate = join(
			nodeModules,
			name,
			'bin',
			`${RUNTIME_EXECUTABLE_BASE}${platformExecutableSuffix(platform)}`,
		);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function copyDistribution(distribution: DaemonDistribution, targetDir: string): void {
	const packageManagerMetadata = new Set(['.pnpm', '.bin', '.modules.yaml', '.npmrc']);
	mkdirSync(targetDir, { recursive: true });
	cpSync(distribution.rootDir, targetDir, {
		recursive: true,
		dereference: true,
		filter: (source) => {
			const relative = relativeTo(distribution.rootDir, source).replace(/\\/g, '/');
			if (relative === '') return true;
			// Package-manager metadata lives at the root of the deployed tree; nested
			// directories that merely share a name (the runtime's own `bin`) are product
			// content and must be kept.
			if (packageManagerMetadata.has(relative)) return false;
			if (relative === 'test' || relative.startsWith('test/')) return false;
			// Build-machine leftovers: caches and incremental build info.
			if (relative.endsWith('.tsbuildinfo')) return false;
			if (relative === 'dist' || relative.startsWith('dist/')) return false;
			return true;
		},
	});
}

function relativeTo(baseDir: string, target: string): string {
	const normalizedBase = resolve(baseDir);
	const normalizedTarget = resolve(target);
	if (normalizedTarget === normalizedBase) return '';
	const prefix = normalizedBase.endsWith(sep) ? normalizedBase : `${normalizedBase}${sep}`;
	return normalizedTarget.startsWith(prefix)
		? normalizedTarget.slice(prefix.length)
		: normalizedTarget;
}

/**
 * Expands a deployed daemon distribution into a simulated installation root, the same
 * shape the packager produces: `<root>/bin/<shell>` plus
 * `<root>/resources/daemon-runtime/**` (AC 2, E-209).
 *
 * The expansion target always contains a space and a non-ASCII character so the
 * unpack path itself is exercised, not just the file names inside it.
 */
export function stageInstalledProduct(
	options: StageInstalledProductOptions,
): InstalledProductLayout {
	const platform = options.hostPlatform;
	const arch = options.arch ?? process.arch;
	const folderName = options.folderName ?? '调度服务 桌面产物 (Unicode & Spaces) 1.0.0';
	const stageDir = resolve(options.rootDir, folderName);
	const binDir = join(stageDir, 'bin');
	const resourceDir = join(stageDir, 'resources');
	const runtimeDir = join(resourceDir, RUNTIME_DIR_NAME);

	for (const directory of CONVENTION_DIRS) {
		mkdirSync(join(stageDir, directory), { recursive: true });
	}

	copyDistribution(options.distribution, runtimeDir);

	const runtimeExecutable = locateBundledRuntime(options.distribution, platform, arch);
	if (!runtimeExecutable) {
		throw new Error(
			`The deployed daemon distribution does not bundle a Node runtime for ${platform}-${arch}; the installation would depend on a runtime that is not part of the product (E-257).`,
		);
	}
	const shippedRuntime = join(
		runtimeDir,
		'runtime',
		`${RUNTIME_EXECUTABLE_BASE}${platformExecutableSuffix(platform)}`,
	);
	mkdirSync(join(runtimeDir, 'runtime'), { recursive: true });
	cpSync(runtimeExecutable, shippedRuntime);

	const daemonEntry = join(runtimeDir, DAEMON_ENTRY_NAME);
	if (!existsSync(daemonEntry) && options.requireDaemonEntry !== false) {
		throw new Error(`The deployed daemon distribution is missing ${DAEMON_ENTRY_NAME}.`);
	}

	const shellName = options.desktopShellName ?? `scheduler${platformExecutableSuffix(platform)}`;
	const currentExe = joinFor(platform, binDir, shellName);
	writeFileSync(currentExe, 'desktop shell placeholder produced by the packager\n', 'utf8');

	return Object.freeze({
		stageDir,
		currentExe,
		resourceDir,
		runtimeDir,
		runtimeExecutable: shippedRuntime,
		daemonEntry,
	});
}

export interface DaemonStartTarget {
	readonly launchFile: string;
	readonly launchArguments: readonly string[];
	readonly runtimeExecutable: string;
	readonly daemonEntry: string;
}

/**
 * Derives the frozen `{file, args[], cwd}` the desktop shell hands to `spawn`.
 *
 * The desktop shell starts the shipped daemon as
 * `<bundled node runtime> <resources>/daemon-runtime/bootstrap.mjs` — the same way the
 * native shell in `src-tauri/src/lib.rs` does — so the smoke check drives exactly that
 * target instead of substituting the build machine's Node (AC 2, E-209).
 */
export function buildDaemonStartTarget(
	layout: InstalledProductLayout,
	options?: { readonly port?: number },
): DaemonStartTarget {
	const args: string[] = ['--port', String(options?.port ?? 7817)];
	const specCandidate = {
		file: layout.runtimeExecutable,
		args: [layout.daemonEntry, ...args],
		cwd: layout.resourceDir,
	};

	const validation = parseDaemonLaunchSpec(specCandidate);
	if (!validation.ok) {
		const issues = validation.issues.map((issue) => `${issue.path}: ${issue.reason}`).join(', ');
		throw new Error(`Shipped daemon launch spec failed schema validation: ${issues}`);
	}
	if (!isAbsoluteLaunchPath(layout.daemonEntry)) {
		throw new Error(`The shipped daemon entry must be absolute: ${layout.daemonEntry}`);
	}

	return Object.freeze({
		launchFile: layout.runtimeExecutable,
		launchArguments: Object.freeze([layout.daemonEntry, ...args]),
		runtimeExecutable: layout.runtimeExecutable,
		daemonEntry: layout.daemonEntry,
	});
}

export interface ProductLayerEvidence {
	readonly hasDaemonSupport: boolean;
	readonly hasPathAdapter: boolean;
	readonly hasDesktopShell: boolean;
	readonly missing: readonly string[];
}

/**
 * Reads the actual product layers out of the expanded installation (E-257).
 *
 * Every flag here is derived from files that exist on disk; nothing is assumed from
 * the fact that the pipeline got this far. A missing layer is returned as missing, and
 * `evaluatePlatformSupport` then refuses to mark the platform fully supported.
 */
export function inspectProductLayers(layout: InstalledProductLayout): ProductLayerEvidence {
	const missing: string[] = [];

	const daemonEntryPresent = existsSync(layout.daemonEntry);
	let daemonManifestOk = false;
	try {
		const manifest = JSON.parse(readFileSync(join(layout.runtimeDir, 'package.json'), 'utf8')) as {
			name?: string;
		};
		daemonManifestOk = manifest.name === '@agent-scheduler/daemon';
	} catch {
		daemonManifestOk = false;
	}
	const runtimePresent = existsSync(layout.runtimeExecutable);
	if (!daemonEntryPresent || !daemonManifestOk || !runtimePresent) {
		missing.push('daemon');
	}

	const pathAdapterPresent =
		existsSync(join(layout.runtimeDir, 'src', 'platform', 'host.ts')) &&
		existsSync(join(layout.runtimeDir, 'src', 'platform', 'lock.ts'));
	if (!pathAdapterPresent) {
		missing.push('path-adapter');
	}

	const desktopShellPresent =
		existsSync(layout.currentExe) && existsSync(join(layout.stageDir, 'resources'));
	if (!desktopShellPresent) {
		missing.push('desktop-shell');
	}

	return Object.freeze({
		hasDaemonSupport: daemonEntryPresent && daemonManifestOk && runtimePresent,
		hasPathAdapter: pathAdapterPresent,
		hasDesktopShell: desktopShellPresent,
		missing: Object.freeze(missing),
	});
}

/**
 * Expands the installation, reads the real layer evidence, and lets
 * `evaluatePlatformSupport` decide whether the platform counts as fully covered.
 */
export function evaluateStagedProductSupport(
	layout: InstalledProductLayout,
	platform: 'win32' | 'darwin' | 'linux',
): { readonly layers: PlatformProductLayers; readonly missing: readonly string[] } {
	const evidence = inspectProductLayers(layout);
	const layers: PlatformProductLayers = {
		hasDaemonSupport: evidence.hasDaemonSupport,
		hasPathAdapter: evidence.hasPathAdapter,
		hasDesktopShell: evidence.hasDesktopShell,
	};
	const support = evaluatePlatformSupport(platform, layers);
	return {
		layers,
		missing: support.isFullySupported ? Object.freeze([]) : Object.freeze([...evidence.missing]),
	};
}

/** Removes a previously staged installation (used to keep temporary roots small). */
export function removeStagedProduct(stageDir: string): void {
	rmSync(stageDir, { recursive: true, force: true });
}

/** Convenience re-export so callers can type an end-to-end result without extra imports. */
export interface StagedDaemonLaunch {
	readonly spec: DaemonLaunchSpec;
	readonly target: DaemonStartTarget;
}
