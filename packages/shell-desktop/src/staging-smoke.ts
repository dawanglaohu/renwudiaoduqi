import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	type DaemonLaunchSpec,
	isAbsoluteLaunchPath,
	parseDaemonLaunchSpec,
} from '@agent-scheduler/shared/shell/daemon-launch-spec';
import { resolveLaunchSpec } from './launch-spec.ts';
import { type PlatformProductLayers, evaluatePlatformSupport } from './platform-support.ts';

export const DEFAULT_SIMULATED_STAGING_FOLDER = '调度服务 桌面产物 (Unicode & Spaces) 1.0.0';

/**
 * File name written into the staging resource directory as the runnable health-probe stub.
 * smoke-runner launches this via `process.execPath <script> --port <port>` (R3 fix).
 */
export const SMOKE_STUB_SCRIPT_NAME = 'daemon-smoke-stub.mjs';

/**
 * Minimal Node.js ESM script written as the daemon stub in staging.
 * Starts an HTTP server on the port given via `--port <n>` and serves /api/v1/health.
 */
export const SMOKE_STUB_SCRIPT_CONTENT = [
	'import { createServer } from "node:http";',
	'const args = process.argv.slice(2);',
	'const portIdx = args.indexOf("--port");',
	'const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 7817;',
	'const server = createServer((req, res) => {',
	'  if (req.url === "/api/v1/health") {',
	'    res.writeHead(200, { "Content-Type": "application/json" });',
	'    res.end(JSON.stringify({ ok: true, smokeStub: true }));',
	'  } else { res.writeHead(404); res.end(); }',
	'});',
	'server.listen(port, "127.0.0.1");',
].join('\n');

export interface StagingLayout {
	readonly stageDir: string;
	readonly currentExe: string;
	readonly resourceDir: string;
	readonly daemonFile: string;
	/** Absolute path to the runnable health-probe ESM script inside the staging resource dir (R3). */
	readonly stubScriptFile: string;
}

export interface CreateStagingOptions {
	readonly rootDir: string;
	readonly folderName?: string;
	readonly hostPlatform?: string;
	readonly daemonContent?: string;
}

/**
 * Creates simulated staging layout in a temporary root containing spaces and Unicode (AC 2, E-209).
 */
export function createSimulatedStaging(options: CreateStagingOptions): StagingLayout {
	const folderName = options.folderName ?? DEFAULT_SIMULATED_STAGING_FOLDER;
	const stageDir = resolve(options.rootDir, folderName);
	const binDir = join(stageDir, 'bin');
	const resourceDir = join(stageDir, 'resources');

	mkdirSync(binDir, { recursive: true });
	mkdirSync(resourceDir, { recursive: true });

	const isWin = (options.hostPlatform ?? process.platform) === 'win32';
	const exeName = isWin ? 'scheduler.exe' : 'scheduler';
	const daemonName = isWin ? 'daemon.exe' : 'daemon';
	const separator = isWin ? '\\' : '/';

	const currentExe = `${binDir}${separator}${exeName}`;
	const daemonFile = `${resourceDir}${separator}${daemonName}`;

	const stubContent = options.daemonContent ?? SMOKE_STUB_SCRIPT_CONTENT;
	// Also write the runnable health-stub script alongside the platform-named daemon file (R3)
	const stubScriptFile = join(resourceDir, SMOKE_STUB_SCRIPT_NAME);
	if (!existsSync(currentExe)) {
		writeFileSync(currentExe, 'stub-desktop-binary\n', 'utf8');
	}
	if (!existsSync(daemonFile)) {
		writeFileSync(daemonFile, stubContent, 'utf8');
	}
	if (!existsSync(stubScriptFile)) {
		writeFileSync(stubScriptFile, SMOKE_STUB_SCRIPT_CONTENT, 'utf8');
	}

	return Object.freeze({
		stageDir,
		currentExe,
		resourceDir,
		daemonFile,
		stubScriptFile,
	});
}

export interface ResolveStagedSpecOptions {
	readonly currentExe: string;
	readonly resourceDir: string;
	readonly hostPlatform: string;
	readonly customDaemonPath?: string;
	readonly customArguments?: readonly string[];
}

/**
 * Resolves absolute DaemonLaunchSpec from staged layout and validates against shared schema (AC 2, E-209).
 */
export function resolveStagedLaunchSpec(options: ResolveStagedSpecOptions): DaemonLaunchSpec {
	const spec = resolveLaunchSpec({
		currentExe: options.currentExe,
		resourceDir: options.resourceDir,
		hostPlatform: options.hostPlatform,
		customDaemonPath: options.customDaemonPath,
		customArguments: options.customArguments,
	});

	const validation = parseDaemonLaunchSpec(spec);
	if (!validation.ok) {
		const issues = validation.issues.map((iss) => `${iss.path}: ${iss.reason}`).join(', ');
		throw new Error(`Staged launch spec validation failed: ${issues}`);
	}

	if (!isAbsoluteLaunchPath(spec.file)) {
		throw new Error(`Resolved launch file must be absolute: ${spec.file}`);
	}
	if (!isAbsoluteLaunchPath(spec.cwd)) {
		throw new Error(`Resolved launch cwd must be absolute: ${spec.cwd}`);
	}

	return validation.value;
}

export interface PathResidueReport {
	readonly isClean: boolean;
	readonly violations: readonly string[];
}

function collectTextFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const results: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			results.push(...collectTextFiles(full));
		} else if (/\.(json|js|mjs|ts|sh|cmd|bat|toml|yaml|yml|txt|conf)$/i.test(entry)) {
			results.push(full);
		}
	}
	return results;
}

/**
 * Inspects staged package assets to ensure no hardcoded builder machine paths are present (AC 2, E-209).
 */
export function inspectBuildPathResidue(
	stageDir: string,
	forbiddenPathPrefixes: readonly string[],
): PathResidueReport {
	const files = collectTextFiles(stageDir);
	const violations: string[] = [];

	for (const file of files) {
		let content = '';
		try {
			content = readFileSync(file, 'utf8');
		} catch {
			continue;
		}

		for (const prefix of forbiddenPathPrefixes) {
			if (prefix && content.includes(prefix)) {
				violations.push(`File "${file}" contains hardcoded builder path: "${prefix}"`);
			}
		}
	}

	return Object.freeze({
		isClean: violations.length === 0,
		violations: Object.freeze(violations),
	});
}

export interface SmokeOutcome {
	readonly success: boolean;
	readonly pid?: number;
	readonly endpointStatus?: number;
	readonly durationMs: number;
	readonly error?: string;
}

export interface ExecuteSmokeOptions {
	readonly port?: number;
	readonly timeoutMs?: number;
	readonly probeEndpoint?: (url: string) => Promise<boolean>;
	readonly customSpawn?: (
		file: string,
		args: readonly string[],
		opts: { cwd: string; shell: boolean; stdio: 'ignore' | 'pipe' | 'inherit' },
	) => ChildProcess;
}

/**
 * Executes the daemon smoke check using the identical frozen launch spec (AC 2, E-209, E-265).
 * Connects to health endpoint and stops the spawned process cleanly.
 */
export async function executeDaemonSmoke(
	spec: DaemonLaunchSpec,
	options?: ExecuteSmokeOptions,
): Promise<SmokeOutcome> {
	const startTime = Date.now();
	const port = options?.port ?? 7817;
	const timeoutMs = options?.timeoutMs ?? 15000;
	const healthUrl = `http://127.0.0.1:${port}/api/v1/health`;

	const spawnFunction = options?.customSpawn ?? nodeSpawn;
	let child: ChildProcess | undefined;

	try {
		child = spawnFunction(spec.file, spec.args, {
			cwd: spec.cwd,
			shell: false,
			stdio: 'ignore',
		});

		const probeFn =
			options?.probeEndpoint ??
			(async (url: string): Promise<boolean> => {
				try {
					const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
					return res.ok;
				} catch {
					return false;
				}
			});

		// Poll health endpoint until healthy or timeout
		const deadline = Date.now() + timeoutMs;
		let isHealthy = false;

		while (Date.now() < deadline) {
			isHealthy = await probeFn(healthUrl);
			if (isHealthy) {
				break;
			}
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
		}

		if (!isHealthy) {
			return Object.freeze({
				success: false,
				pid: child.pid,
				durationMs: Date.now() - startTime,
				error: `Health check probe failed within ${timeoutMs}ms at ${healthUrl}`,
			});
		}

		return Object.freeze({
			success: true,
			pid: child.pid,
			endpointStatus: 200,
			durationMs: Date.now() - startTime,
		});
	} catch (err) {
		return Object.freeze({
			success: false,
			durationMs: Date.now() - startTime,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		if (child?.pid) {
			try {
				child.kill('SIGTERM');
			} catch {
				// Clean exit ignore
			}
		}
	}
}

export interface VerifyStagedDeploymentOptions {
	readonly rootDir: string;
	readonly hostPlatform: 'win32' | 'darwin' | 'linux';
	readonly layers: PlatformProductLayers;
	readonly forbiddenPrefixes?: readonly string[];
	readonly customDaemonPath?: string;
	readonly customArguments?: readonly string[];
	readonly executeSmoke?: boolean;
	readonly smokeOptions?: ExecuteSmokeOptions;
}

export interface StagedDeploymentReport {
	readonly passed: boolean;
	readonly stageLayout: StagingLayout;
	readonly spec: DaemonLaunchSpec;
	readonly pathResidueClean: boolean;
	readonly smokeOutcome?: SmokeOutcome;
	readonly layerReport: ReturnType<typeof evaluatePlatformSupport>;
	readonly errors: readonly string[];
}

/**
 * Full verification pipeline for staged installation (AC 2, E-209, E-257).
 * Unpacks to Unicode/spaces path, inspects build path residue, resolves frozen launch spec,
 * verifies product layers, and executes daemon smoke test.
 */
export async function verifyStagedDeployment(
	options: VerifyStagedDeploymentOptions,
): Promise<StagedDeploymentReport> {
	const errors: string[] = [];

	// 1. Verify product layers completeness (E-257)
	const layerReport = evaluatePlatformSupport(options.hostPlatform, options.layers);
	if (!layerReport.isFullySupported) {
		errors.push(
			`Product layers incomplete for ${options.hostPlatform} (E-257): daemon=${options.layers.hasDaemonSupport}, pathAdapter=${options.layers.hasPathAdapter}, desktopShell=${options.layers.hasDesktopShell}`,
		);
	}

	// 2. Stage to directory with Unicode and spaces (AC 2, E-209)
	const stageLayout = createSimulatedStaging({
		rootDir: options.rootDir,
		hostPlatform: options.hostPlatform,
	});

	// 3. Check for hardcoded builder machine paths (AC 2)
	const forbidden = options.forbiddenPrefixes ?? [];
	const residueReport = inspectBuildPathResidue(stageLayout.stageDir, forbidden);
	if (!residueReport.isClean) {
		errors.push(...residueReport.violations);
	}

	// 4. Resolve absolute launch spec (AC 2, E-209)
	let spec: DaemonLaunchSpec;
	try {
		spec = resolveStagedLaunchSpec({
			currentExe: stageLayout.currentExe,
			resourceDir: stageLayout.resourceDir,
			hostPlatform: options.hostPlatform,
			customDaemonPath: options.customDaemonPath,
			customArguments: options.customArguments,
		});
	} catch (specErr) {
		const message = specErr instanceof Error ? specErr.message : String(specErr);
		errors.push(`Launch spec resolution failure: ${message}`);
		spec = {
			file: stageLayout.daemonFile,
			args: [],
			cwd: stageLayout.resourceDir,
		};
	}

	// 5. Execute smoke test if requested (AC 2, E-209)
	let smokeOutcome: SmokeOutcome | undefined;
	if (options.executeSmoke) {
		smokeOutcome = await executeDaemonSmoke(spec, options.smokeOptions);
		if (!smokeOutcome.success) {
			errors.push(`Daemon smoke execution failed: ${smokeOutcome.error}`);
		}
	}

	const passed = errors.length === 0;

	return Object.freeze({
		passed,
		stageLayout,
		spec,
		pathResidueClean: residueReport.isClean,
		smokeOutcome,
		layerReport,
		errors: Object.freeze(errors),
	});
}
