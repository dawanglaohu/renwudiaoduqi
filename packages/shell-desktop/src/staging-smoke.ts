import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	type DaemonLaunchSpec,
	isAbsoluteLaunchPath,
	parseDaemonLaunchSpec,
} from '@agent-scheduler/shared/shell/daemon-launch-spec';
import { resolveLaunchSpec } from './launch-spec.ts';

export interface ResolveStagedSpecOptions {
	readonly currentExe: string;
	readonly resourceDir: string;
	readonly hostPlatform: string;
	readonly customDaemonPath?: string;
	readonly customArguments?: readonly string[];
}

/**
 * Resolves the absolute `DaemonLaunchSpec` from the expanded installation coordinates
 * and rejects anything the shared schema does not accept (AC 2, E-209).
 *
 * Only `current_exe` and `resource_dir` of the expanded product feed this call; no value
 * may be carried over from the build machine.
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
		const stat = lstatSync(full);
		// A DMG includes an Applications shortcut into the host filesystem. Only
		// inspect files actually carried by the expanded product.
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			results.push(...collectTextFiles(full));
		} else if (/\.(json|js|mjs|ts|sh|cmd|bat|toml|yaml|yml|txt|conf)$/i.test(entry)) {
			results.push(full);
		}
	}
	return results;
}

/** Rewrites separators to `/` and lowercases so comparisons work on every host. */
function normalizeForComparison(value: string): string {
	return value.replace(/\\/g, '/').toLowerCase();
}

/** Absolute path-like tokens embedded in a packaged text asset. */
function extractAbsolutePathTokens(content: string): string[] {
	const tokens = new Set<string>();
	// JSON-escaped Windows paths arrive as `C:\\dir\\file`; fold the escape so the token
	// can be compared like a real path.
	const candidates = content.replace(/\\\\/g, '/');
	const windowsPath = /[A-Za-z]:[^\s,;:="<>|]+(?:[\\\/][^\s,;:="<>|]+)*/g;
	for (const match of candidates.matchAll(windowsPath)) {
		tokens.add(match[0]);
	}
	for (const match of candidates.matchAll(/\/(?:[\w.@+-]+\/)+[\w.@+-]+/g)) {
		tokens.add(match[0]);
	}
	return [...tokens];
}

/**
 * Inspects an expanded installation for paths that point back at the build machine.
 * A shipped package must not embed them (AC 2, E-209). Path comparison is case and
 * separator insensitive so the same location cannot slip through as `C:/Users/...`
 * when the forbidden prefix is `C:\Users\...`.
 */
export function inspectBuildPathResidue(
	stageDir: string,
	forbiddenPathPrefixes: readonly string[],
): PathResidueReport {
	const files = collectTextFiles(stageDir);
	const violations: string[] = [];
	const forbidden = forbiddenPathPrefixes
		.filter((prefix) => prefix.length > 0)
		.map(normalizeForComparison);

	for (const file of files) {
		let content = '';
		try {
			content = readFileSync(file, 'utf8');
		} catch {
			continue;
		}

		for (const token of extractAbsolutePathTokens(content)) {
			const normalized = normalizeForComparison(token);
			const hit = forbidden.find((prefix) => normalized.startsWith(prefix));
			if (hit) {
				violations.push(
					`File "${file}" contains hardcoded builder path: "${token}" (forbidden prefix "${hit}")`,
				);
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

export interface SmokeSpawnOptions {
	readonly cwd: string;
	readonly shell: boolean;
	readonly stdio: 'ignore' | 'pipe' | 'inherit';
	readonly env?: Readonly<Record<string, string>>;
}

export interface ExecuteSmokeOptions {
	readonly port?: number;
	readonly timeoutMs?: number;
	readonly probeEndpoint?: (url: string) => Promise<boolean>;
	readonly customSpawn?: (
		file: string,
		args: readonly string[],
		opts: SmokeSpawnOptions,
	) => ChildProcess;
	/**
	 * Streams the daemon's own stdout/stderr into this process instead of discarding it.
	 * A daemon that refuses to start explains why on stderr, and a silent failure is not
	 * actionable (AC 2). Off by default so unit tests stay quiet.
	 */
	readonly inheritStdio?: boolean;
	/**
	 * Environment handed to the daemon. The frozen spec fixes `file/args/cwd`; the
	 * product's own `AGSCHED_*` variables (port, data directory) are how a smoke check
	 * keeps the daemon away from the machine's real port and data directory.
	 */
	readonly env?: Readonly<Record<string, string>>;
}

/**
 * Starts the daemon from the identical frozen launch spec and waits for its health
 * endpoint (AC 2, E-209, E-265). The injection points exist for unit tests; the default
 * path really spawns the shipped launch target and really probes the endpoint.
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
	const stdioMode: 'ignore' | 'inherit' = options?.inheritStdio ? 'inherit' : 'ignore';
	const spawnOptions: SmokeSpawnOptions = {
		cwd: spec.cwd,
		shell: false,
		stdio: stdioMode,
		...(options?.env ? { env: options.env } : {}),
	};
	let child: ChildProcess | undefined;
	let spawnFailure: string | undefined;
	let processExited: number | null | undefined;

	try {
		child = spawnFunction(spec.file, spec.args, spawnOptions);
		// A spawn that cannot start, or a process that dies immediately, must fail the
		// check instead of surfacing as an unhandled error or a misleading timeout.
		// Test doubles may provide a minimal process object without event emitters.
		if (typeof child.once === 'function') {
			child.once('error', (error: Error) => {
				spawnFailure = error.message;
			});
			child.once('exit', (code: number | null) => {
				processExited = code;
			});
		}

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

		const deadline = Date.now() + timeoutMs;
		let isHealthy = false;

		while (Date.now() < deadline) {
			if (spawnFailure) {
				return Object.freeze({
					success: false,
					pid: child.pid,
					durationMs: Date.now() - startTime,
					error: `The launch target could not be started: ${spawnFailure}`,
				});
			}
			if (processExited !== undefined && processExited !== 0) {
				return Object.freeze({
					success: false,
					pid: child.pid,
					durationMs: Date.now() - startTime,
					error: `The daemon process exited with code ${processExited} before becoming healthy`,
				});
			}
			isHealthy = await probeFn(healthUrl);
			if (isHealthy) {
				break;
			}
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
		}

		if (spawnFailure) {
			return Object.freeze({
				success: false,
				pid: child.pid,
				durationMs: Date.now() - startTime,
				error: `The launch target could not be started: ${spawnFailure}`,
			});
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
			// Let the process release its working directory before the caller removes the
			// staging root; Windows reports EBUSY on a directory a live process still holds.
			await waitForExit(child, 5000);
		}
	}
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || typeof child.once !== 'function') return Promise.resolve();
	return new Promise((resolveWait) => {
		const timer = setTimeout(resolveWait, timeoutMs);
		child.once('exit', () => {
			clearTimeout(timer);
			resolveWait();
		});
	});
}
