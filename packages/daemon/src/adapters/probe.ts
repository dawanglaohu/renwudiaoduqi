import { constants as fsConstants } from 'node:fs';
import { access as nodeAccess, realpath as nodeRealpath, stat as nodeStat } from 'node:fs/promises';
import { isAbsolute, join, normalize, delimiter as pathDelimiter, win32 } from 'node:path';
import type { AgentConfig, ResolvedAgentConfig } from '../config/defaults.ts';
import type {
	ExecutableFileSystem,
	PlatformHostInputs,
	ResolvedExecutable,
	SupportedPlatform,
} from '../platform/contract.ts';
import { platformPathAdapter, takePlatformHostInputs } from '../platform/host.ts';
import { resolveExecutable as resolvePlatformExecutable } from '../platform/resolve-executable.ts';
import { wrapForComSpec } from '../platform/windows.ts';
import { createProcessEnv } from '../proc/env.ts';
import { type LaunchSpec, spawnManaged } from '../proc/spawn.ts';

export const DEFAULT_PROBE_TIMEOUT_MS = 5000;
export const PROBE_WINDOWS_EXTENSIONS = Object.freeze(['.cmd', '.bat', '.exe', ''] as const);

export type ProbeStatus =
	| 'matched'
	| 'unrecognized'
	| 'warning'
	| 'not-found'
	| 'requires-confirmation'
	| 'invalid-platform-path';

export interface FingerprintCacheEntry {
	readonly resolvedPath: string;
	readonly mtimeMs: number;
	readonly size: number;
	readonly result: ProbeAgentResult;
	readonly cachedAt: string;
}

export interface FingerprintCache {
	get(resolvedPath: string): FingerprintCacheEntry | undefined;
	set(resolvedPath: string, entry: FingerprintCacheEntry): void;
	delete(resolvedPath: string): boolean;
	clear(): void;
	readonly size: number;
}

export function createFingerprintCache(): FingerprintCache {
	const store = new Map<string, FingerprintCacheEntry>();
	return {
		get(resolvedPath: string) {
			return store.get(resolvedPath);
		},
		set(resolvedPath: string, entry: FingerprintCacheEntry) {
			store.set(resolvedPath, entry);
		},
		delete(resolvedPath: string) {
			return store.delete(resolvedPath);
		},
		clear() {
			store.clear();
		},
		get size() {
			return store.size;
		},
	};
}

export interface SemanticVersion {
	readonly raw: string;
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly prerelease?: string;
	readonly build?: string;
}

export interface VersionRange {
	readonly min?: string;
	readonly max?: string;
}

export interface VersionComparison {
	readonly matched: boolean;
	readonly isStrictMatch: boolean;
	readonly isLenientMatch: boolean;
	readonly observedVersion: string;
	readonly parsedVersion: string | null;
	readonly expectedPattern: string;
	readonly inVersionRange?: boolean;
}

export interface CandidateDiscoveryResult {
	readonly primaryCandidate?: string;
	readonly allCandidates: readonly string[];
	readonly checkedPaths: readonly string[];
	readonly requiresConfirmation: boolean;
}

export interface ProbeWarningBanner {
	readonly code: string;
	readonly message: string;
	readonly details?: Readonly<Record<string, unknown>>;
}

export interface ProbeAgentResult {
	readonly ok: boolean;
	readonly status: ProbeStatus;
	readonly agentId: string;
	readonly canDispatch: boolean;
	readonly matched: boolean;
	readonly versionString: string;
	readonly resolvedPath?: string;
	readonly isCustomPath: boolean;
	readonly fromCache?: boolean;
	readonly candidates?: CandidateDiscoveryResult;
	readonly comparison?: VersionComparison;
	readonly warningBanner?: ProbeWarningBanner;
	readonly allowManualPath?: boolean;
	readonly errorDetails?: {
		readonly code: string;
		readonly observed?: string;
		readonly expected?: string;
		readonly execPath?: string;
		readonly checkedPaths?: readonly string[];
		readonly reason?: string;
	};
}

export interface CommandRunnerParams {
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly env?: Record<string, string>;
	readonly windowsVerbatimArguments?: boolean;
}

export interface ProbeComSpecLaunch {
	readonly sourcePath: string;
	readonly commandProcessor: string;
	readonly rawArgs: readonly string[];
}

export interface ProbeLaunchSpec {
	readonly file: string;
	readonly args: readonly string[];
	readonly windowsVerbatimArguments: boolean;
	readonly comSpec?: ProbeComSpecLaunch;
}

export function buildProbeLaunch(
	executable: ResolvedExecutable,
	rawArgs: readonly string[],
): ProbeLaunchSpec | null {
	const fullArgs = Object.freeze([...executable.argsPrefix, ...rawArgs]);
	if (executable.launchKind === 'direct') {
		return Object.freeze({
			file: executable.file,
			args: fullArgs,
			windowsVerbatimArguments: false,
		});
	}

	const wrapped = wrapForComSpec(executable.sourcePath, fullArgs, executable.file);
	return wrapped.ok
		? Object.freeze({
				file: wrapped.launch.file,
				args: wrapped.launch.args,
				windowsVerbatimArguments: true,
				comSpec: Object.freeze({
					sourcePath: executable.sourcePath,
					commandProcessor: executable.file,
					rawArgs: fullArgs,
				}),
			})
		: null;
}

export interface CommandRunnerResult {
	readonly ok: boolean;
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut?: boolean;
}

export interface ProbeAgentOptions {
	readonly agentId: string;
	readonly config: AgentConfig | ResolvedAgentConfig;
	readonly hostInputs?: PlatformHostInputs;
	readonly platform?: SupportedPlatform;
	readonly homedir?: string;
	readonly env?: Record<string, string | undefined>;
	readonly timeoutMs?: number;
	readonly cache?: FingerprintCache;
	readonly fileSystem?: ExecutableFileSystem & {
		readonly realpath?: (path: string) => Promise<string>;
	};
	readonly spawnManagedFn?: typeof spawnManaged;
	readonly commandRunner?: (params: CommandRunnerParams) => Promise<CommandRunnerResult>;
	readonly isCustomPath?: boolean;
	readonly userConfirmedCandidate?: string;
	readonly versionRange?: VersionRange;
	readonly nowIso?: string;
}

const DEFAULT_FILE_SYSTEM: ExecutableFileSystem & {
	readonly realpath: (path: string) => Promise<string>;
} = Object.freeze({
	stat: nodeStat,
	lstat: nodeStat,
	readlink: async (path: string) => path,
	realpath: nodeRealpath,
	access: nodeAccess,
});

/**
 * Probes an agent's executable version and validates its fingerprint against
 * generic registry configuration.
 *
 * Handles:
 * - Generic probe command + expectedPattern (AC 1, E-36)
 * - Unrecognized version output with structured diagnostic details (AC 2, E-195)
 * - Multiple candidate executables requiring confirmation (AC 3, E-196)
 * - GUI/autostart minimal environment PATH check listing locations without shell startup files (AC 3, E-270)
 * - Fingerprint cache by resolved path + mtime + size (AC 4, E-197)
 * - Lenient pattern and version range matching for routine upgrades (AC 5, E-198)
 * - Hand-entered custom absolute paths with failure downgrade to warning banner (AC 6, E-199)
 * - Foreign-platform path preservation and validation (AC 6, E-264)
 */
export async function probeAgent(options: ProbeAgentOptions): Promise<ProbeAgentResult> {
	const defaultHost = takePlatformHostInputs({});
	const fallbackHost: PlatformHostInputs = defaultHost.ok
		? defaultHost.value
		: { platform: 'linux', homedir: '' };
	const hostInputs: PlatformHostInputs = options.hostInputs ?? fallbackHost;
	const platform = options.platform ?? hostInputs.platform;
	const homedir = options.homedir ?? hostInputs.homedir;
	const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
	const configuredExecPath = options.config.execPath.trim();
	const isCustom = options.isCustomPath ?? isPathExplicitCustom(configuredExecPath, platform);

	// 1. Check if configured path is from another platform (E-264)
	if (isForeignPlatformPath(configuredExecPath, platform)) {
		return Object.freeze({
			ok: false,
			status: 'invalid-platform-path',
			agentId: options.agentId,
			canDispatch: false,
			matched: false,
			versionString: '',
			isCustomPath: isCustom,
			allowManualPath: true,
			errorDetails: Object.freeze({
				code: 'E_AGENT_EXEC_INVALID_TARGET',
				execPath: configuredExecPath,
				reason: 'foreign-platform-path',
			}),
			warningBanner: Object.freeze({
				code: 'E_AGENT_EXEC_INVALID_TARGET',
				message:
					'The configured executable path uses a format from another platform. Please select a path for the current system.',
				details: Object.freeze({
					configuredPath: configuredExecPath,
					platform,
					reason: 'foreign-platform-path',
				}),
			}),
		});
	}

	const pathIsAbsolute = platform === 'win32' ? win32.isAbsolute : isAbsolute;

	// 2. Resolve executable path
	let targetExecutablePath: string | undefined;
	let discovery: CandidateDiscoveryResult | undefined;

	if (options.userConfirmedCandidate !== undefined && options.userConfirmedCandidate.length > 0) {
		targetExecutablePath = options.userConfirmedCandidate;
	} else if (isCustom && pathIsAbsolute(configuredExecPath)) {
		targetExecutablePath = configuredExecPath;
	} else {
		// Discover candidates on PATH and fixed platform locations (AC 3, E-196, E-270)
		discovery = await findExecutableCandidates({
			executableName: configuredExecPath,
			hostInputs,
			env: options.env,
			fileSystem,
		});

		if (discovery.allCandidates.length === 0) {
			// Not found in any checked location (E-270)
			return Object.freeze({
				ok: false,
				status: 'not-found',
				agentId: options.agentId,
				canDispatch: false,
				matched: false,
				versionString: '',
				isCustomPath: isCustom,
				candidates: discovery,
				allowManualPath: true,
				errorDetails: Object.freeze({
					code: 'E_AGENT_EXEC_NOT_FOUND',
					execPath: configuredExecPath,
					checkedPaths: discovery.checkedPaths,
				}),
			});
		}

		if (discovery.requiresConfirmation) {
			// Multiple candidates found on PATH / platform directories:
			// Record first hit, list ALL candidates, require user confirmation (AC 3, E-196).
			// Never silently take the first candidate for dispatch!
			return Object.freeze({
				ok: false,
				status: 'requires-confirmation',
				agentId: options.agentId,
				canDispatch: false,
				matched: false,
				versionString: '',
				resolvedPath: discovery.primaryCandidate,
				isCustomPath: isCustom,
				candidates: discovery,
				allowManualPath: true,
				errorDetails: Object.freeze({
					code: 'E_VALIDATION',
					execPath: configuredExecPath,
					checkedPaths: discovery.checkedPaths,
					reason: 'multiple-candidates-found',
				}),
				warningBanner: Object.freeze({
					code: 'E_VALIDATION',
					message:
						'Multiple executable candidates were found on PATH. Confirmation is required before dispatching.',
					details: Object.freeze({
						primaryCandidate: discovery.primaryCandidate,
						allCandidates: discovery.allCandidates,
					}),
				}),
			});
		}

		targetExecutablePath = discovery.primaryCandidate;
	}

	if (!targetExecutablePath) {
		return Object.freeze({
			ok: false,
			status: 'not-found',
			agentId: options.agentId,
			canDispatch: false,
			matched: false,
			versionString: '',
			isCustomPath: isCustom,
			candidates: discovery,
			allowManualPath: true,
			errorDetails: Object.freeze({
				code: 'E_AGENT_EXEC_NOT_FOUND',
				execPath: configuredExecPath,
				checkedPaths: discovery?.checkedPaths ?? Object.freeze([]),
			}),
		});
	}

	// 3. Validate executable target on current platform
	const resolved = await resolvePlatformExecutable(
		{
			hostInputs,
			executableName: configuredExecPath,
			configuredPath: targetExecutablePath,
		},
		fileSystem,
	);

	if (!resolved.ok) {
		if (isCustom) {
			// User manual path failure downgrades to warning banner instead of disabling (AC 6, E-199)
			return Object.freeze({
				ok: false,
				status: 'warning',
				agentId: options.agentId,
				canDispatch: true,
				matched: false,
				versionString: '',
				resolvedPath: targetExecutablePath,
				isCustomPath: true,
				candidates: discovery,
				allowManualPath: true,
				warningBanner: Object.freeze({
					code: resolved.error.code,
					message: resolved.error.message,
					details: Object.freeze({
						...resolved.error.details,
						reason: 'custom-path-unresolved',
					}),
				}),
				errorDetails: Object.freeze({
					code: resolved.error.code,
					execPath: targetExecutablePath,
					checkedPaths:
						(resolved.error.details.checkedPaths as readonly string[]) ?? Object.freeze([]),
				}),
			});
		}

		return Object.freeze({
			ok: false,
			status: 'not-found',
			agentId: options.agentId,
			canDispatch: false,
			matched: false,
			versionString: '',
			resolvedPath: targetExecutablePath,
			isCustomPath: false,
			candidates: discovery,
			allowManualPath: true,
			errorDetails: Object.freeze({
				code: resolved.error.code,
				execPath: targetExecutablePath,
				checkedPaths:
					(resolved.error.details.checkedPaths as readonly string[]) ?? Object.freeze([]),
			}),
		});
	}

	const executable = resolved.executable;
	const realPath = executable.sourcePath;

	// 4. Inspect file stats for cache checking (AC 4, E-197)
	let mtimeMs = 0;
	let size = 0;
	try {
		const stat = await fileSystem.stat(realPath);
		const rawStat = stat as unknown as { mtimeMs?: number; mtime?: Date; size?: number };
		mtimeMs = rawStat.mtimeMs ?? (rawStat.mtime instanceof Date ? rawStat.mtime.getTime() : 0);
		size = rawStat.size ?? 0;
	} catch {
		// If stat fails, continue without caching
	}

	const cache = options.cache;
	if (cache && mtimeMs > 0) {
		const cached = cache.get(realPath);
		if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
			return Object.freeze({
				...cached.result,
				fromCache: true,
			});
		}
	}

	// 5. Build launch specification for direct or com-spec execution (R1)
	const probeArgs = options.config.versionFingerprint.args;
	const expectedPattern = options.config.versionFingerprint.expectedPattern;
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

	const launch = buildProbeLaunch(executable, probeArgs);
	if (!launch) {
		return Object.freeze({
			ok: false,
			status: 'warning',
			agentId: options.agentId,
			canDispatch: isCustom,
			matched: false,
			versionString: '',
			resolvedPath: realPath,
			isCustomPath: isCustom,
			allowManualPath: true,
			warningBanner: Object.freeze({
				code: 'E_VALIDATION',
				message: 'Failed to wrap arguments for Windows ComSpec.',
			}),
		});
	}

	const execution = await executeProbeProcess({
		file: launch.file,
		args: launch.args,
		windowsVerbatimArguments: launch.windowsVerbatimArguments,
		comSpec: launch.comSpec,
		cwd: homedir.length > 0 ? homedir : '.',
		timeoutMs,
		platform,
		commandRunner: options.commandRunner,
		spawnManagedFn: options.spawnManagedFn,
		agentId: options.agentId,
	});

	const rawOutput = (
		execution.stdout.trim().length > 0 ? execution.stdout : execution.stderr
	).trim();

	// 6. Match version output against fingerprint pattern (AC 1, AC 2, AC 5, E-195, E-198)
	const comparison = matchVersionFingerprint(rawOutput, expectedPattern, {
		agentId: options.agentId,
		versionRange: options.versionRange,
	});

	if (comparison.matched && execution.ok) {
		const result: ProbeAgentResult = Object.freeze({
			ok: true,
			status: 'matched',
			agentId: options.agentId,
			canDispatch: true,
			matched: true,
			versionString: rawOutput,
			resolvedPath: realPath,
			isCustomPath: isCustom,
			candidates: discovery,
			comparison,
		});

		if (cache && mtimeMs > 0) {
			cache.set(
				realPath,
				Object.freeze({
					resolvedPath: realPath,
					mtimeMs,
					size,
					result,
					cachedAt: options.nowIso ?? new Date().toISOString(),
				}),
			);
		}

		return result;
	}

	// 7. Probe failed or output was unrecognized
	if (isCustom) {
		// Custom user-entered path: failure downgrades to warning banner instead of disabling (AC 6, E-199)
		const warningBanner: ProbeWarningBanner = Object.freeze({
			code: 'E_AGENT_VERSION_UNRECOGNIZED',
			message:
				'Probing the custom executable returned an unrecognized version string, but user override is allowed with a warning.',
			details: Object.freeze({
				observed: rawOutput,
				expected: expectedPattern,
				execPath: realPath,
				exitCode: execution.exitCode,
			}),
		});

		const result: ProbeAgentResult = Object.freeze({
			ok: false,
			status: 'warning',
			agentId: options.agentId,
			canDispatch: true,
			matched: false,
			versionString: rawOutput,
			resolvedPath: realPath,
			isCustomPath: true,
			candidates: discovery,
			comparison,
			warningBanner,
			allowManualPath: true,
			errorDetails: Object.freeze({
				code: 'E_AGENT_VERSION_UNRECOGNIZED',
				observed: rawOutput,
				expected: expectedPattern,
				execPath: realPath,
			}),
		});

		if (cache && mtimeMs > 0) {
			cache.set(
				realPath,
				Object.freeze({
					resolvedPath: realPath,
					mtimeMs,
					size,
					result,
					cachedAt: options.nowIso ?? new Date().toISOString(),
				}),
			);
		}

		return result;
	}

	// Non-custom path unrecognized output: mark 'unrecognized', cannot dispatch, provide manual path entry (AC 2, E-195)
	const result: ProbeAgentResult = Object.freeze({
		ok: false,
		status: 'unrecognized',
		agentId: options.agentId,
		canDispatch: false,
		matched: false,
		versionString: rawOutput,
		resolvedPath: realPath,
		isCustomPath: false,
		candidates: discovery,
		comparison,
		allowManualPath: true,
		errorDetails: Object.freeze({
			code: 'E_AGENT_VERSION_UNRECOGNIZED',
			observed: rawOutput,
			expected: expectedPattern,
			execPath: realPath,
		}),
	});

	if (cache && mtimeMs > 0) {
		cache.set(
			realPath,
			Object.freeze({
				resolvedPath: realPath,
				mtimeMs,
				size,
				result,
				cachedAt: options.nowIso ?? new Date().toISOString(),
			}),
		);
	}

	return result;
}

/**
 * Searches candidate directories (including PATH and fixed platform locations)
 * for an executable name and detects collisions.
 *
 * Implements AC 3, E-196 and E-270.
 */
export async function findExecutableCandidates(input: {
	readonly executableName: string;
	readonly hostInputs: PlatformHostInputs;
	readonly env?: Record<string, string | undefined>;
	readonly fileSystem?: ExecutableFileSystem;
}): Promise<CandidateDiscoveryResult> {
	const { executableName, hostInputs } = input;
	const fileSystem = input.fileSystem ?? DEFAULT_FILE_SYSTEM;
	const adapter = platformPathAdapter(hostInputs.platform);
	const platform = hostInputs.platform;

	const searchDirectories: string[] = [];

	// 1. Search directories from PATH environment variable (R2 case-insensitive on win32)
	const resolvedEnv = createProcessEnv({
		platform,
		baseEnv: input.env,
	});
	let rawPath = resolvedEnv.PATH;
	if (platform === 'win32' || rawPath === undefined) {
		for (const [key, value] of Object.entries(resolvedEnv)) {
			if (key.toLowerCase() === 'path' && value !== undefined) {
				rawPath = value;
				break;
			}
		}
	}
	if (rawPath === undefined && input.env) {
		for (const [key, value] of Object.entries(input.env)) {
			if (key.toLowerCase() === 'path' && value !== undefined) {
				rawPath = value;
				break;
			}
		}
	}
	if (rawPath !== undefined && rawPath.length > 0) {
		const segments = rawPath.split(platform === 'win32' ? ';' : pathDelimiter);
		for (const segment of segments) {
			const trimmed = segment.trim();
			if (trimmed.length > 0) {
				searchDirectories.push(trimmed);
			}
		}
	}

	// 2. Fixed platform candidate paths (AC 3, E-270 GUI fallback)
	const fixedCandidates = adapter.executableCandidatePaths(executableName, hostInputs);

	// 3. Assemble full candidate paths to test
	const candidatePathsToTest: string[] = [];
	const seenPaths = new Set<string>();

	const pathJoin = platform === 'win32' ? win32.join : join;
	const pathNormalize = platform === 'win32' ? win32.normalize : normalize;

	const addCandidate = (cand: string) => {
		const normalized = pathNormalize(cand);
		const key = platform === 'win32' ? normalized.toLowerCase() : normalized;
		if (!seenPaths.has(key)) {
			seenPaths.add(key);
			candidatePathsToTest.push(normalized);
		}
	};

	// Add PATH based candidates
	for (const dir of searchDirectories) {
		if (platform === 'win32') {
			for (const ext of PROBE_WINDOWS_EXTENSIONS) {
				addCandidate(pathJoin(dir, `${executableName}${ext}`));
			}
		} else {
			addCandidate(pathJoin(dir, executableName));
		}
	}

	// Add platform fixed candidates
	for (const fixed of fixedCandidates) {
		addCandidate(fixed);
	}

	const checkedPaths: string[] = [];
	const validCandidates: string[] = [];
	const seenRealPaths = new Set<string>();

	for (const candidate of candidatePathsToTest) {
		checkedPaths.push(candidate);
		const classified = adapter.classifyPath(candidate);
		if (!classified.isValidForCurrentPlatform) continue;

		try {
			const stat = await fileSystem.stat(candidate);
			if (!stat.isFile()) continue;

			if (adapter.requiresExecutablePermission) {
				await fileSystem.access(candidate, fsConstants.X_OK);
			}

			let real = candidate;
			if (typeof fileSystem.realpath === 'function') {
				try {
					real = await fileSystem.realpath(candidate);
				} catch {
					// Fallback to candidate path if realpath fails
				}
			}

			const realKey = platform === 'win32' ? real.toLowerCase() : real;
			if (!seenRealPaths.has(realKey)) {
				seenRealPaths.add(realKey);
				validCandidates.push(candidate);
			}
		} catch {
			// Path does not exist or lacks execute permission; continue checking
		}
	}

	const hasMultiple = validCandidates.length > 1;
	return Object.freeze({
		primaryCandidate: validCandidates[0],
		allCandidates: Object.freeze([...validCandidates]),
		checkedPaths: Object.freeze([...checkedPaths]),
		requiresConfirmation: hasMultiple,
	});
}

/**
 * Matches version output against expected pattern using strict and lenient
 * comparison, plus version range validation.
 *
 * Implements AC 1, AC 5, E-198.
 */
export function matchVersionFingerprint(
	output: string,
	expectedPattern: string,
	options: {
		readonly agentId?: string;
		readonly versionRange?: VersionRange;
	} = {},
): VersionComparison {
	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return Object.freeze({
			matched: false,
			isStrictMatch: false,
			isLenientMatch: false,
			observedVersion: '',
			parsedVersion: null,
			expectedPattern,
		});
	}

	// 1. Parse semantic version
	const parsed = parseSemanticVersion(trimmed);
	const parsedVersionStr = parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : null;

	// 2. Version range check
	let inVersionRange: boolean | undefined;
	if (parsed && options.versionRange) {
		inVersionRange = isVersionInRange(parsed, options.versionRange);
	}

	// 3. Check negative indicators (e.g. "not grok", "not claude")
	if (hasNegativeIndicator(trimmed, expectedPattern, options.agentId)) {
		return Object.freeze({
			matched: false,
			isStrictMatch: false,
			isLenientMatch: false,
			observedVersion: trimmed,
			parsedVersion: parsedVersionStr,
			expectedPattern,
			inVersionRange,
		});
	}

	// 4. Strict pattern match
	let isStrictMatch = false;
	try {
		const strictRegex = new RegExp(expectedPattern, 'i');
		isStrictMatch = strictRegex.test(trimmed);
	} catch {
		isStrictMatch = false;
	}

	if (isStrictMatch && (inVersionRange === undefined || inVersionRange === true)) {
		return Object.freeze({
			matched: true,
			isStrictMatch: true,
			isLenientMatch: false,
			observedVersion: trimmed,
			parsedVersion: parsedVersionStr,
			expectedPattern,
			inVersionRange,
		});
	}

	// 4. Lenient pattern match (AC 5, E-198)
	// Routine upgrades may alter wrapper name or prefix (e.g. "Claude Code" -> "claude-code v1.0")
	const isLenientMatch = checkLenientMatch(trimmed, expectedPattern, options.agentId, parsed);

	const isRangeValid = inVersionRange === undefined || inVersionRange === true;
	const matched = (isStrictMatch || isLenientMatch) && isRangeValid;

	return Object.freeze({
		matched,
		isStrictMatch,
		isLenientMatch,
		observedVersion: trimmed,
		parsedVersion: parsedVersionStr,
		expectedPattern,
		inVersionRange,
	});
}

/**
 * Extracts semantic version components from an output string.
 */
export function parseSemanticVersion(versionString: string): SemanticVersion | null {
	const match = versionString.match(
		/\bv?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?\b/,
	);
	if (!match) return null;

	const raw = match[0];
	const major = Number.parseInt(match[1] ?? '0', 10);
	const minor = Number.parseInt(match[2] ?? '0', 10);
	const patch = Number.parseInt(match[3] ?? '0', 10);

	return Object.freeze({
		raw,
		major,
		minor,
		patch,
		prerelease: match[4],
		build: match[5],
	});
}

/**
 * Compares semantic version with an optional range { min, max }.
 */
export function isVersionInRange(version: SemanticVersion, range: VersionRange): boolean {
	if (range.min) {
		const parsedMin = parseSemanticVersion(range.min);
		if (parsedMin && compareSemver(version, parsedMin) < 0) return false;
	}
	if (range.max) {
		const parsedMax = parseSemanticVersion(range.max);
		if (parsedMax && compareSemver(version, parsedMax) > 0) return false;
	}
	return true;
}

export function compareSemver(a: SemanticVersion, b: SemanticVersion): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
}

/**
 * Validates whether a path is from another operating system platform (E-264).
 */
export function isForeignPlatformPath(pathValue: string, platform: SupportedPlatform): boolean {
	const trimmed = pathValue.trim();
	if (trimmed.length === 0) return false;

	if (platform === 'win32') {
		// Windows reading POSIX absolute path
		return trimmed.startsWith('/') && !trimmed.startsWith('//');
	}

	// POSIX (darwin/linux) reading Windows drive letter or UNC
	return /^[A-Za-z]:[\\/]/.test(trimmed) || /^(?:\\\\|\/\/)/.test(trimmed);
}

function isPathExplicitCustom(configuredPath: string, platform: SupportedPlatform): boolean {
	if (configuredPath.length === 0) return false;
	if (platform === 'win32') {
		return /^[A-Za-z]:[\\/]/.test(configuredPath) || /^(?:\\\\)/.test(configuredPath);
	}
	return configuredPath.startsWith('/');
}

function hasNegativeIndicator(output: string, expectedPattern: string, agentId?: string): boolean {
	const lower = output.toLowerCase();
	const cleanExpected = expectedPattern.replace(/\\b/g, '').replace(/[\^$]/g, '').trim();
	const tokens = [
		...cleanExpected.split(/[\s_\-|/]+/).map((t) => t.trim().toLowerCase()),
		...(agentId ? [agentId.toLowerCase()] : []),
	].filter((t) => t.length > 1);

	for (const token of tokens) {
		const negativeRegex = new RegExp(
			`\\b(?:not|no|non|unrelated)\\s+${escapeRegex(token)}\\b`,
			'i',
		);
		if (negativeRegex.test(lower)) {
			return true;
		}
	}
	return false;
}

function checkLenientMatch(
	output: string,
	expectedPattern: string,
	agentId?: string,
	parsedVersion: SemanticVersion | null = null,
): boolean {
	if (!parsedVersion) return false;

	const trimmed = output.trim();
	// Universal rule for bare version string (R3):
	// Matches if expectedPattern is a version regex, or if expectedPattern equals the agentId.
	// Rejects if expectedPattern merely contains agentId/substring (e.g. 'api-tool' for unrelated binary).
	if (trimmed === parsedVersion.raw || trimmed === `v${parsedVersion.raw}`) {
		if (agentId) {
			const cleanExpected = expectedPattern
				.replace(/\\b/g, '')
				.replace(/[\^$]/g, '')
				.trim()
				.toLowerCase();
			if (cleanExpected === agentId.toLowerCase()) {
				return true;
			}
		}
		try {
			const versionRegex = new RegExp(expectedPattern, 'i');
			if (versionRegex.test(parsedVersion.raw) || versionRegex.test(`v${parsedVersion.raw}`)) {
				return true;
			}
		} catch {
			// ignore regex failure
		}
		return false;
	}

	const cleanExpected = expectedPattern.replace(/\\b/g, '').replace(/[\^$]/g, '').trim();
	const tokens = [
		...cleanExpected.split(/[\s_\-|/]+/).map((t) => t.trim().toLowerCase()),
		...(agentId ? [agentId.toLowerCase()] : []),
	].filter((t) => t.length > 1);

	// Check if the output identifies the agent as its name/prefix
	for (const token of tokens) {
		const escaped = escapeRegex(token);
		const namePatterns = [
			new RegExp(`^(?:@[\\w.-]+\\/)?[\\w.-]*${escaped}[\\w.-]*\\b`, 'i'),
			new RegExp(`\\b${escaped}(?:[-_\\s]?cli)?\\s+v?\\d`, 'i'),
			new RegExp(`\\b${escaped}\\s*\\(`, 'i'),
			new RegExp(`\\(${escaped}\\)`, 'i'),
		];
		if (namePatterns.some((p) => p.test(trimmed))) {
			return true;
		}
	}

	return false;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function executeProbeProcess(params: {
	readonly file: string;
	readonly args: readonly string[];
	readonly windowsVerbatimArguments: boolean;
	readonly comSpec?: ProbeComSpecLaunch;
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly platform: SupportedPlatform;
	readonly commandRunner?: (params: CommandRunnerParams) => Promise<CommandRunnerResult>;
	readonly spawnManagedFn?: typeof spawnManaged;
	readonly agentId: string;
}): Promise<CommandRunnerResult> {
	const {
		file,
		args,
		windowsVerbatimArguments,
		comSpec,
		cwd,
		timeoutMs,
		platform,
		commandRunner,
		spawnManagedFn,
		agentId,
	} = params;

	if (commandRunner) {
		return commandRunner({
			file,
			args,
			cwd,
			timeoutMs,
			windowsVerbatimArguments,
		});
	}

	const spawnFn = spawnManagedFn ?? spawnManaged;
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];

	return new Promise<CommandRunnerResult>((resolve) => {
		let resolved = false;
		const timer = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				try {
					void managed.kill().catch(() => undefined);
				} catch {
					// Ignore kill errors on timeout
				}
				resolve({
					ok: false,
					exitCode: null,
					stdout: stdoutChunks.join(''),
					stderr: stderrChunks.join(''),
					timedOut: true,
				});
			}
		}, timeoutMs);
		if (typeof timer.unref === 'function') timer.unref();

		// ComSpec launches go to proc as the batch script plus the command processor:
		// proc owns the /d /s /c wrapper and windowsVerbatimArguments, so the frozen argv
		// is never re-escaped by Node's own Windows quoting (E-130, E-119).
		const spec: LaunchSpec = comSpec
			? {
					runId: `probe-${agentId}-${Date.now()}`,
					file: comSpec.sourcePath,
					args: comSpec.rawArgs,
					windowsComSpecPath: comSpec.commandProcessor,
					cwd,
					timeouts: {
						startupTimeoutMs: timeoutMs,
					},
				}
			: {
					runId: `probe-${agentId}-${Date.now()}`,
					file,
					args,
					cwd,
					timeouts: {
						startupTimeoutMs: timeoutMs,
					},
				};

		let managed: ReturnType<typeof spawnManaged>;
		try {
			managed = spawnFn(spec, {
				platform,
				onRaw: (line) => {
					stdoutChunks.push(line.text);
				},
				onStderr: (line) => {
					stderrChunks.push(line.text);
				},
				onError: (err) => {
					stderrChunks.push(err.message);
				},
				onExit: (exitResult) => {
					if (!resolved) {
						resolved = true;
						clearTimeout(timer);
						const stdout = stdoutChunks.join('\n');
						const stderr = stderrChunks.join('\n');
						const ok = exitResult.exitCode === 0;
						resolve({
							ok,
							exitCode: exitResult.exitCode,
							stdout,
							stderr,
						});
					}
				},
			});
		} catch (err) {
			clearTimeout(timer);
			resolve({
				ok: false,
				exitCode: null,
				stdout: '',
				stderr: (err as Error).message,
			});
		}
	});
}
