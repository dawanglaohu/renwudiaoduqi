import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { resolveShippedDaemonLayout } from './launch-spec.ts';
import { type PlatformProductLayers, evaluatePlatformSupport } from './platform-support.ts';

/**
 * The three product layers as they leave the packager (AC 2, E-257):
 * the daemon distribution (`pnpm deploy --prod` output plus the bundled Node runtime),
 * the single web build the daemon serves, and the native desktop shell executable.
 * A missing source is not an error here; the layer inspection reports it as missing so
 * the release check can name the layer instead of failing on a copy error.
 */
export interface InstalledProductSources {
	/** Root of the daemon distribution: `bootstrap.mjs`, `src/`, `node_modules/`, `runtime/`. */
	readonly daemonDistributionDir: string;
	/** `packages/web/dist` as built once for the daemon, the desktop shell and the mobile shell. */
	readonly webDistDir?: string;
	/** The linked desktop shell executable produced by `cargo build --release`. */
	readonly desktopShellBinary?: string;
}

export interface StageInstalledProductOptions {
	readonly sources: InstalledProductSources;
	/** Temporary root that receives the expanded installation. */
	readonly rootDir: string;
	readonly hostPlatform: 'win32' | 'darwin' | 'linux';
	readonly folderName?: string;
}

export interface InstalledProductLayout {
	readonly stageDir: string;
	/** `<stageDir>/bin/<shell executable>`; only exists when a shell binary was supplied. */
	readonly currentExe: string;
	/** `<stageDir>/resources`, the directory the native shell reports as `resource_dir`. */
	readonly resourceDir: string;
	/** `<resourceDir>/daemon-runtime`, the daemon application as shipped. */
	readonly daemonDir: string;
	/** `<daemonDir>/runtime/node[.exe]`, the launch target of the frozen spec. */
	readonly runtimeExecutable: string;
	/** `<daemonDir>/bootstrap.mjs`, the single argument of the frozen spec. */
	readonly daemonEntry: string;
	/** `<resourceDir>/web/dist`, where the daemon's static plugin looks for the UI. */
	readonly webDistDir: string;
}

export const DEFAULT_STAGING_FOLDER = '调度服务 桌面产物 (Unicode & Spaces) 1.0.0';

function desktopShellFileName(platform: 'win32' | 'darwin' | 'linux'): string {
	return platform === 'win32' ? 'desktop-shell.exe' : 'desktop-shell';
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
 * Recursive copy that follows symbolic links and preserves file modes, written out
 * instead of `fs.cpSync` because the C++ implementation `cpSync` uses for unfiltered
 * directory copies mishandles non-ASCII destination paths on some Node 22 releases on
 * Windows; the staging root always contains such characters on purpose.
 */
function copyTree(
	sourceRoot: string,
	targetRoot: string,
	keep: (relativePosix: string) => boolean,
	currentDir = sourceRoot,
): void {
	const targetDir = join(targetRoot, relativeTo(sourceRoot, currentDir));
	mkdirSync(targetDir, { recursive: true });
	for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
		const source = join(currentDir, entry.name);
		const relative = relativeTo(sourceRoot, source).replace(/\\/g, '/');
		if (!keep(relative)) continue;
		// statSync follows links: an installation carries real files, never links back
		// into the build machine.
		if (statSync(source).isDirectory()) {
			copyTree(sourceRoot, targetRoot, keep, source);
		} else {
			copyFileSync(source, join(targetDir, entry.name));
		}
	}
}

/**
 * Copies the daemon distribution without the build machine's own leftovers. Package
 * manager metadata records absolute build paths, tests and incremental build info are
 * not product content, and none of them is present in a shipped installation.
 */
function copyDaemonDistribution(sourceDir: string, targetDir: string): void {
	const packageManagerMetadata = new Set(['.pnpm', '.bin', '.modules.yaml', '.npmrc']);
	copyTree(sourceDir, targetDir, (relative) => {
		if (relative.startsWith('node_modules/')) {
			const inner = relative.slice('node_modules/'.length);
			if (packageManagerMetadata.has(inner)) return false;
		}
		if (relative === 'test' || relative.startsWith('test/')) return false;
		if (relative.endsWith('.tsbuildinfo')) return false;
		if (relative === 'dist' || relative.startsWith('dist/')) return false;
		return true;
	});
}

/**
 * Expands the packager output into a simulated installation root (AC 2, E-209):
 * `<root>/bin/<shell>` plus `<root>/resources/{daemon-runtime,web/dist}`, the layout
 * `resolveShippedDaemonLayout` and the native shell both derive the launch spec from.
 *
 * The expansion target always contains a space and non-ASCII characters so the unpack
 * path itself is exercised, not just the file names inside it.
 */
export function stageInstalledProduct(
	options: StageInstalledProductOptions,
): InstalledProductLayout {
	const platform = options.hostPlatform;
	const folderName = options.folderName ?? DEFAULT_STAGING_FOLDER;
	const stageDir = resolve(options.rootDir, folderName);
	const binDir = join(stageDir, 'bin');
	const resourceDir = join(stageDir, 'resources');
	const shipped = resolveShippedDaemonLayout(resourceDir, platform);
	const daemonDir = shipped.daemonDir;
	const webDistDir = join(resourceDir, 'web', 'dist');
	const currentExe = join(binDir, desktopShellFileName(platform));

	if (!existsSync(options.sources.daemonDistributionDir)) {
		throw new Error(
			`The daemon distribution does not exist: ${options.sources.daemonDistributionDir}`,
		);
	}

	mkdirSync(binDir, { recursive: true });
	mkdirSync(resourceDir, { recursive: true });
	copyDaemonDistribution(options.sources.daemonDistributionDir, daemonDir);

	const webDistSource = options.sources.webDistDir;
	if (webDistSource && existsSync(webDistSource)) {
		copyTree(webDistSource, webDistDir, () => true);
	}

	const shellSource = options.sources.desktopShellBinary;
	if (shellSource && existsSync(shellSource)) {
		copyFileSync(shellSource, currentExe);
	}

	return Object.freeze({
		stageDir,
		currentExe,
		resourceDir,
		daemonDir,
		runtimeExecutable: shipped.runtimeExecutable,
		daemonEntry: shipped.daemonEntry,
		webDistDir,
	});
}

export interface ProductLayerEvidence {
	readonly hasDaemonSupport: boolean;
	readonly hasPathAdapter: boolean;
	readonly hasDesktopShell: boolean;
	/** Human-readable description of every missing piece, grouped by layer. */
	readonly missing: readonly string[];
}

function readManifestName(daemonDir: string): string | undefined {
	try {
		const manifest = JSON.parse(readFileSync(join(daemonDir, 'package.json'), 'utf8')) as {
			name?: unknown;
		};
		return typeof manifest.name === 'string' ? manifest.name : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Reads the product layers out of the expanded installation (E-257).
 *
 * Every flag is derived from files on disk; nothing is assumed from the fact that the
 * pipeline got this far. The web build counts towards the daemon layer because the
 * daemon refuses to start without it.
 */
export function inspectProductLayers(layout: InstalledProductLayout): ProductLayerEvidence {
	const missing: string[] = [];

	const daemonProblems: string[] = [];
	if (!existsSync(layout.daemonEntry)) daemonProblems.push('daemon-runtime/bootstrap.mjs');
	if (readManifestName(layout.daemonDir) !== '@agent-scheduler/daemon') {
		daemonProblems.push('daemon-runtime/package.json (@agent-scheduler/daemon)');
	}
	if (!existsSync(layout.runtimeExecutable)) daemonProblems.push('daemon-runtime/runtime/node');
	if (!existsSync(join(layout.webDistDir, 'index.html')))
		daemonProblems.push('web/dist/index.html');
	const hasDaemonSupport = daemonProblems.length === 0;
	if (!hasDaemonSupport) missing.push(`daemon (${daemonProblems.join(', ')})`);

	const adapterProblems: string[] = [];
	for (const file of ['host.ts', 'lock.ts']) {
		if (!existsSync(join(layout.daemonDir, 'src', 'platform', file))) {
			adapterProblems.push(`daemon-runtime/src/platform/${file}`);
		}
	}
	const hasPathAdapter = adapterProblems.length === 0;
	if (!hasPathAdapter) missing.push(`path-adapter (${adapterProblems.join(', ')})`);

	const hasDesktopShell = existsSync(layout.currentExe);
	if (!hasDesktopShell) missing.push(`desktop-shell (${layout.currentExe})`);

	return Object.freeze({
		hasDaemonSupport,
		hasPathAdapter,
		hasDesktopShell,
		missing: Object.freeze(missing),
	});
}

/**
 * Lets `evaluatePlatformSupport` decide whether the expanded installation counts as
 * fully covered, and returns what is missing when it does not (E-257).
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
