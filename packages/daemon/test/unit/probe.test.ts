import { describe, expect, it, vi } from 'vitest';
import {
	createFingerprintCache,
	isForeignPlatformPath,
	isVersionInRange,
	matchVersionFingerprint,
	parseSemanticVersion,
	probeAgent,
} from '../../src/adapters/probe.ts';
import { BUILT_IN_AGENT_DEFAULTS, BUILT_IN_AGENT_IDS } from '../../src/config/defaults.ts';
import type {
	ExecutableFileInfo,
	ExecutableFileSystem,
	PlatformHostInputs,
} from '../../src/platform/contract.ts';

function createMockFileSystem(
	files: Record<
		string,
		{ content?: string; isFile?: boolean; isExecutable?: boolean; mtimeMs?: number; size?: number }
	>,
): ExecutableFileSystem & { realpath: (path: string) => Promise<string> } {
	const normalizePath = (p: string) =>
		p
			.replace(/^\\\\\?\\/, '')
			.replaceAll('/', '\\')
			.toLowerCase();
	const findFile = (p: string) => {
		if (files[p]) return files[p];
		const norm = normalizePath(p);
		for (const [key, val] of Object.entries(files)) {
			if (key === p || normalizePath(key) === norm) return val;
		}
		return undefined;
	};

	return {
		stat: async (path: string) => {
			const file = findFile(path);
			if (!file) {
				const err = new Error(
					`ENOENT: no such file or directory, stat '${path}'`,
				) as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				throw err;
			}
			return {
				isFile: () => file.isFile !== false,
				isSymbolicLink: () => false,
				mtimeMs: file.mtimeMs ?? 1000,
				size: file.size ?? 500,
			} as unknown as ExecutableFileInfo;
		},
		lstat: async (path: string) => {
			const file = findFile(path);
			if (!file) {
				const err = new Error(
					`ENOENT: no such file or directory, lstat '${path}'`,
				) as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				throw err;
			}
			return {
				isFile: () => file.isFile !== false,
				isSymbolicLink: () => false,
			};
		},
		readlink: async (path: string) => path,
		realpath: async (path: string) => path,
		access: async (path: string) => {
			const file = findFile(path);
			if (!file || file.isExecutable === false) {
				const err = new Error(
					`EACCES: permission denied, access '${path}'`,
				) as NodeJS.ErrnoException;
				err.code = 'EACCES';
				throw err;
			}
		},
	};
}

describe('M4-T3 Agent Version Fingerprint & Executable Resolution (AC 1-6, E-195..E-199, E-264, E-270, E-36)', () => {
	const linuxHost: PlatformHostInputs = {
		platform: 'linux',
		homedir: '/home/tester',
	};

	const windowsHost: PlatformHostInputs = {
		platform: 'win32',
		homedir: 'C:\\Users\\tester',
	};

	describe('AC 1 & E-36: Generic registry fields used for probing all agents (not grok-specific)', () => {
		it('uses versionFingerprint.args and versionFingerprint.expectedPattern for all built-in agents', async () => {
			for (const agentId of Object.values(BUILT_IN_AGENT_IDS)) {
				const config = BUILT_IN_AGENT_DEFAULTS[agentId];
				expect(config.versionFingerprint).toBeDefined();
				expect(config.versionFingerprint.args).toBeInstanceOf(Array);
				expect(config.versionFingerprint.args.length).toBeGreaterThan(0);
				expect(typeof config.versionFingerprint.expectedPattern).toBe('string');
				expect(config.versionFingerprint.expectedPattern.length).toBeGreaterThan(0);

				// Simulate probing each agent with custom commandRunner
				const mockRunner = vi.fn(async () => {
					// Return output that matches the expected pattern
					const sampleOutput = agentId === 'claude' ? '1.0.67 (Claude Code)' : `${agentId} v1.2.3`;
					return {
						ok: true,
						exitCode: 0,
						stdout: sampleOutput,
						stderr: '',
					};
				});

				const fs = createMockFileSystem({
					[`/usr/local/bin/${config.execPath}`]: {
						isFile: true,
						isExecutable: true,
						mtimeMs: 2000,
						size: 4000,
					},
				});

				const result = await probeAgent({
					agentId,
					config,
					hostInputs: linuxHost,
					fileSystem: fs,
					commandRunner: mockRunner,
				});

				expect(result.ok).toBe(true);
				expect(result.status).toBe('matched');
				expect(result.canDispatch).toBe(true);
				expect(result.matched).toBe(true);
				expect(mockRunner).toHaveBeenCalledTimes(1);
				const firstCall = mockRunner.mock.calls[0] as unknown as
					| [{ args: readonly string[] }]
					| undefined;
				expect(firstCall?.[0]?.args).toEqual(config.versionFingerprint.args);
			}
		});

		it('probes custom 5th/6th generic agent without grok-specific code branches', async () => {
			const customConfig = {
				...BUILT_IN_AGENT_DEFAULTS.codex,
				execPath: 'agent-x',
				versionFingerprint: {
					args: ['--ver'],
					expectedPattern: '\\bAgent-X Engine\\b',
				},
			};

			const mockRunner = vi.fn(async () => ({
				ok: true,
				exitCode: 0,
				stdout: 'Agent-X Engine 3.14.0',
				stderr: '',
			}));

			const fs = createMockFileSystem({
				'/usr/local/bin/agent-x': { isFile: true, isExecutable: true },
			});

			const result = await probeAgent({
				agentId: 'agent-x',
				config: customConfig,
				hostInputs: linuxHost,
				fileSystem: fs,
				commandRunner: mockRunner,
			});

			expect(result.ok).toBe(true);
			expect(result.status).toBe('matched');
			expect(result.versionString).toBe('Agent-X Engine 3.14.0');
			const firstCall = mockRunner.mock.calls[0] as unknown as
				| [{ args: readonly string[] }]
				| undefined;
			expect(firstCall?.[0]?.args).toEqual(['--ver']);
		});
		it('R1: default spawn path hands the .cmd script plus ComSpec to proc (verbatim wrapping stays in proc)', async () => {
			const config = {
				...BUILT_IN_AGENT_DEFAULTS.grok,
				execPath: 'C:\\tools\\grok.cmd',
			};

			const fs = createMockFileSystem({
				'C:\\tools\\grok.cmd': { isFile: true },
				'C:\\Windows\\System32\\cmd.exe': { isFile: true },
			});

			let capturedSpec: import('../../src/proc/spawn.ts').LaunchSpec | undefined;
			const fakeSpawn = ((
				spec: import('../../src/proc/spawn.ts').LaunchSpec,
				options: import('../../src/proc/spawn.ts').SpawnManagedOptions,
			) => {
				capturedSpec = spec;
				setTimeout(() => {
					options.onRaw?.({ text: 'grok 1.0.3 (1a29d5bc12)' } as never);
					options.onExit?.({
						runId: spec.runId,
						pid: 1,
						exitCode: 0,
						signal: null,
						reason: 'exited',
					});
				}, 0);
				return { runId: spec.runId, pid: 1, file: spec.file, args: spec.args } as never;
			}) as unknown as NonNullable<
				import('../../src/adapters/probe.ts').ProbeAgentOptions['spawnManagedFn']
			>;

			const result = await probeAgent({
				agentId: 'grok',
				config,
				hostInputs: windowsHost,
				fileSystem: fs,
				isCustomPath: true,
				spawnManagedFn: fakeSpawn,
			});

			expect(result.status).toBe('matched');
			// proc wraps only when it receives the batch script itself; handing it cmd.exe
			// directly would skip windowsVerbatimArguments and re-escape the /c payload.
			expect(capturedSpec?.file).toBe('C:\\tools\\grok.cmd');
			expect(capturedSpec?.args).toEqual(['--version']);
			expect(capturedSpec?.windowsComSpecPath).toBe('C:\\Windows\\System32\\cmd.exe');
		});

		it('R1: wraps Windows .cmd/.bat using ComSpec with windowsVerbatimArguments: true', async () => {
			const config = {
				...BUILT_IN_AGENT_DEFAULTS.grok,
				execPath: 'C:\\tools\\grok.cmd',
			};

			const fs = createMockFileSystem({
				'C:\\tools\\grok.cmd': { isFile: true },
				'C:\\Windows\\System32\\cmd.exe': { isFile: true },
			});

			let capturedParams: import('../../src/adapters/probe.ts').CommandRunnerParams | undefined;
			const mockRunner = vi.fn(
				async (params: import('../../src/adapters/probe.ts').CommandRunnerParams) => {
					capturedParams = params;
					return {
						ok: true,
						exitCode: 0,
						stdout: 'grok 1.0.3 (1a29d5bc12)',
						stderr: '',
					};
				},
			);

			const result = await probeAgent({
				agentId: 'grok',
				config,
				hostInputs: windowsHost,
				fileSystem: fs,
				commandRunner: mockRunner,
				isCustomPath: true,
			});

			expect(result.ok).toBe(true);
			expect(result.status).toBe('matched');
			expect(capturedParams).toBeDefined();
			if (capturedParams) {
				// Assert file is comSpec (cmd.exe)
				expect(capturedParams.file.toLowerCase()).toContain('cmd.exe');
				// Assert args first three items are /d, /s, /c
				expect(capturedParams.args[0]).toBe('/d');
				expect(capturedParams.args[1]).toBe('/s');
				expect(capturedParams.args[2]).toBe('/c');
				expect(capturedParams.args[3]).toContain('grok.cmd');
				// Assert windowsVerbatimArguments is true
				expect(capturedParams.windowsVerbatimArguments).toBe(true);
			}
		});

		it('R4: collects version output from stderr when stdout is empty', async () => {
			const config = BUILT_IN_AGENT_DEFAULTS.codex;

			const fs = createMockFileSystem({
				'/usr/local/bin/codex': { isFile: true, isExecutable: true },
			});

			const mockRunner = vi.fn(async () => ({
				ok: true,
				exitCode: 0,
				stdout: '',
				stderr: 'codex version 0.1.5 (cli-engine)\n',
			}));

			const result = await probeAgent({
				agentId: 'codex',
				config,
				hostInputs: linuxHost,
				fileSystem: fs,
				commandRunner: mockRunner,
			});

			expect(result.ok).toBe(true);
			expect(result.status).toBe('matched');
			expect(result.versionString).toBe('codex version 0.1.5 (cli-engine)');
		});

		it('R4: real Node child process collecting version string strictly through stderr', async () => {
			// Real node process emitting version string to stderr and exiting with 0
			const script = 'console.error("codex 0.1.5-stderr"); process.exit(0);';
			const nodeConfig = {
				...BUILT_IN_AGENT_DEFAULTS.codex,
				execPath: process.execPath,
				versionFingerprint: {
					args: ['-e', script],
					expectedPattern: '\\bcodex\\b',
				},
			};

			const result = await probeAgent({
				agentId: 'codex',
				config: nodeConfig,
				hostInputs: {
					platform: process.platform as 'win32' | 'darwin' | 'linux',
					homedir: process.cwd(),
				},
				isCustomPath: true,
			});

			expect(result.ok).toBe(true);
			expect(result.status).toBe('matched');
			expect(result.versionString).toBe('codex 0.1.5-stderr');
		});
	});

	describe('AC 2 & E-195: Unrecognized version output', () => {
		it('marks status unrecognized and canDispatch false, displays observed and expected, provides manual entry', async () => {
			const config = BUILT_IN_AGENT_DEFAULTS.grok;

			const mockRunner = vi.fn(async () => ({
				ok: true,
				exitCode: 0,
				stdout: 'Some Random Utility v0.0.1 (not grok)',
				stderr: '',
			}));

			const fs = createMockFileSystem({
				'/usr/local/bin/grok': { isFile: true, isExecutable: true },
			});

			const result = await probeAgent({
				agentId: 'grok',
				config,
				hostInputs: linuxHost,
				fileSystem: fs,
				commandRunner: mockRunner,
			});

			expect(result.ok).toBe(false);
			expect(result.status).toBe('unrecognized');
			expect(result.canDispatch).toBe(false);
			expect(result.matched).toBe(false);
			expect(result.versionString).toBe('Some Random Utility v0.0.1 (not grok)');
			expect(result.comparison?.expectedPattern).toBe(config.versionFingerprint.expectedPattern);
			expect(result.allowManualPath).toBe(true);
			expect(result.errorDetails).toEqual({
				code: 'E_AGENT_VERSION_UNRECOGNIZED',
				observed: 'Some Random Utility v0.0.1 (not grok)',
				expected: config.versionFingerprint.expectedPattern,
				execPath: '/usr/local/bin/grok',
			});
		});
	});

	describe('AC 3, E-196 & E-270: Candidate discovery, collisions and minimal environment', () => {
		it('R2: reads Path case-insensitively on Windows and lists all candidates with confirmation', async () => {
			const config = BUILT_IN_AGENT_DEFAULTS.grok;

			const fs = createMockFileSystem({
				'C:\\tools\\grok.cmd': { isFile: true },
				'C:\\other\\grok.exe': { isFile: true },
			});

			const result = await probeAgent({
				agentId: 'grok',
				config,
				hostInputs: windowsHost,
				env: { Path: 'C:\\tools;C:\\other' },
				fileSystem: fs,
			});

			expect(result.ok).toBe(false);
			expect(result.status).toBe('requires-confirmation');
			expect(result.canDispatch).toBe(false);
			expect(result.candidates?.requiresConfirmation).toBe(true);
			expect(result.candidates?.allCandidates).toContain('C:\\tools\\grok.cmd');
			expect(result.candidates?.allCandidates).toContain('C:\\other\\grok.exe');
		});

		it('E-196: records first hit but lists all candidates and requires confirmation when multiple executables hit', async () => {
			const config = BUILT_IN_AGENT_DEFAULTS.grok;

			const fs = createMockFileSystem({
				'/usr/local/bin/grok': { isFile: true, isExecutable: true },
				'/home/tester/.grok/bin/grok': { isFile: true, isExecutable: true },
			});

			const result = await probeAgent({
				agentId: 'grok',
				config,
				hostInputs: linuxHost,
				env: { PATH: '/usr/local/bin:/home/tester/.grok/bin' },
				fileSystem: fs,
			});

			expect(result.ok).toBe(false);
			expect(result.status).toBe('requires-confirmation');
			expect(result.canDispatch).toBe(false);
			expect(result.candidates).toBeDefined();
			expect(result.candidates?.primaryCandidate).toBe('/usr/local/bin/grok');
			expect(result.candidates?.allCandidates).toEqual([
				'/usr/local/bin/grok',
				'/home/tester/.grok/bin/grok',
			]);
			expect(result.candidates?.requiresConfirmation).toBe(true);
			expect(result.warningBanner).toBeDefined();
			expect(result.warningBanner?.details?.allCandidates).toEqual([
				'/usr/local/bin/grok',
				'/home/tester/.grok/bin/grok',
			]);
		});

		it('E-196: dispatches successfully when user selects/confirms one of multiple candidates', async () => {
			const config = BUILT_IN_AGENT_DEFAULTS.grok;

			const fs = createMockFileSystem({
				'/usr/local/bin/grok': { isFile: true, isExecutable: true },
				'/home/tester/.grok/bin/grok': { isFile: true, isExecutable: true },
			});

			const mockRunner = vi.fn(async () => ({
				ok: true,
				exitCode: 0,
				stdout: 'grok 1.0.3 (1a29d5bc12)',
				stderr: '',
			}));

			const result = await probeAgent({
				agentId: 'grok',
				config,
				hostInputs: linuxHost,
				env: { PATH: '/usr/local/bin:/home/tester/.grok/bin' },
				fileSystem: fs,
				userConfirmedCandidate: '/home/tester/.grok/bin/grok',
				commandRunner: mockRunner,
			});

			expect(result.ok).toBe(true);
			expect(result.status).toBe('matched');
			expect(result.canDispatch).toBe(true);
			expect(result.resolvedPath).toBe('/home/tester/.grok/bin/grok');
		});

		it('E-270: lists all checked paths and prompts file selection when missing from GUI/autostart minimal PATH', async () => {
			const config = BUILT_IN_AGENT_DEFAULTS.codex;

			// Minimal PATH environment without shell rc additions
			const fs = createMockFileSystem({
				// No codex binary exists in any location
			});

			const result = await probeAgent({
				agentId: 'codex',
				config,
				hostInputs: linuxHost,
				env: { PATH: '/usr/bin:/bin' },
				fileSystem: fs,
			});

			expect(result.ok).toBe(false);
			expect(result.status).toBe('not-found');
			expect(result.canDispatch).toBe(false);
			expect(result.allowManualPath).toBe(true);
			expect(result.candidates).toBeDefined();
			expect(result.candidates?.checkedPaths.length).toBeGreaterThan(0);
			// Fixed platform locations checked (including homedir fallback)
			expect(result.candidates?.checkedPaths).toContain('/usr/bin/codex');
			expect(result.candidates?.checkedPaths).toContain('/usr/local/bin/codex');
			expect(result.candidates?.checkedPaths).toContain('/home/tester/.local/bin/codex');
			expect(result.errorDetails?.code).toBe('E_AGENT_EXEC_NOT_FOUND');
		});
	});

	describe('AC 4 & E-197: Fingerprint caching by resolvedPath + mtime + size', () => {
		it('caches probe result and avoids re-executing command during batch dispatch', async () => {
			const config = BUILT_IN_AGENT_DEFAULTS.pi;
			const cache = createFingerprintCache();

			const mockRunner = vi.fn(async () => ({
				ok: true,
				exitCode: 0,
				stdout: '0.85.1',
				stderr: '',
			}));

			const fs = createMockFileSystem({
				'/usr/local/bin/pi': { isFile: true, isExecutable: true, mtimeMs: 123456, size: 7890 },
			});

			// Task 1 dispatch: probe runs
			const res1 = await probeAgent({
				agentId: 'pi',
				config,
				hostInputs: linuxHost,
				fileSystem: fs,
				cache,
				commandRunner: mockRunner,
			});

			expect(res1.ok).toBe(true);
			expect(res1.status).toBe('matched');
			expect(res1.fromCache).toBeUndefined();
			expect(mockRunner).toHaveBeenCalledTimes(1);

			// Task 2 dispatch in same batch: cache hit, no process execution!
			const res2 = await probeAgent({
				agentId: 'pi',
				config,
				hostInputs: linuxHost,
				fileSystem: fs,
				cache,
				commandRunner: mockRunner,
			});

			expect(res2.ok).toBe(true);
			expect(res2.status).toBe('matched');
			expect(res2.fromCache).toBe(true);
			expect(mockRunner).toHaveBeenCalledTimes(1); // Still 1! Not re-executed.

			// Simulate file update (mtimeMs changes on upgrade):
			const updatedFs = createMockFileSystem({
				'/usr/local/bin/pi': { isFile: true, isExecutable: true, mtimeMs: 999999, size: 7890 },
			});

			const res3 = await probeAgent({
				agentId: 'pi',
				config,
				hostInputs: linuxHost,
				fileSystem: updatedFs,
				cache,
				commandRunner: mockRunner,
			});

			expect(res3.ok).toBe(true);
			expect(res3.fromCache).toBeUndefined();
			expect(mockRunner).toHaveBeenCalledTimes(2); // Re-probed because mtime changed!
		});
	});

	describe('AC 5 & E-198: Lenient pattern + semver range matching for routine upgrades', () => {
		it('passes routine format variations of official agents using lenient matching', () => {
			// Claude code format variation
			const claudeRes = matchVersionFingerprint('claude-code v1.0.0', '\\bClaude Code\\b', {
				agentId: 'claude',
			});
			expect(claudeRes.matched).toBe(true);
			expect(claudeRes.isLenientMatch).toBe(true);
			expect(claudeRes.parsedVersion).toBe('1.0.0');

			// Pi format variation: bare version number or full identifier
			const piRes = matchVersionFingerprint('0.85.1', '\\bpi\\b', {
				agentId: 'pi',
			});
			expect(piRes.matched).toBe(true);
			expect(piRes.parsedVersion).toBe('0.85.1');

			const piPkgRes = matchVersionFingerprint('pi-coding-agent v0.85.1', '\\bpi\\b');
			expect(piPkgRes.matched).toBe(true);
			expect(piPkgRes.parsedVersion).toBe('0.85.1');

			// Codex variation with commit hash and prefixes
			const codexRes = matchVersionFingerprint(
				'openai-codex 0.2.1-beta.1 (rev a1b2c3d)',
				'\\bcodex\\b',
				{
					agentId: 'codex',
				},
			);
			expect(codexRes.matched).toBe(true);
			expect(codexRes.parsedVersion).toBe('0.2.1');
		});

		it('R3: rejects bare version number when expected pattern contains pi substring (E-201)', () => {
			// Pattern contains "pi" as a substring (e.g. api-tool, rapid-pipeline),
			// but output is a bare version number from an unrelated binary.
			const rejectedSubstr = matchVersionFingerprint('2.1.0', 'api-tool');
			expect(rejectedSubstr.matched).toBe(false);

			const rejectedBarePi = matchVersionFingerprint('2.1.0', '\\bpi\\b', {
				agentId: 'other-tool',
			});
			expect(rejectedBarePi.matched).toBe(false);

			const rejectedArbitraryBare = matchVersionFingerprint('0.85.1', '\\bClaude Code\\b');
			expect(rejectedArbitraryBare.matched).toBe(false);
		});

		it('validates version range matching (passes within range, fails out of range)', () => {
			const inRange = matchVersionFingerprint('grok 1.2.0', '\\bgrok\\b', {
				agentId: 'grok',
				versionRange: { min: '1.0.0', max: '2.0.0' },
			});
			expect(inRange.matched).toBe(true);
			expect(inRange.inVersionRange).toBe(true);

			const outOfRange = matchVersionFingerprint('grok 0.9.0', '\\bgrok\\b', {
				agentId: 'grok',
				versionRange: { min: '1.0.0', max: '2.0.0' },
			});
			expect(outOfRange.matched).toBe(false);
			expect(outOfRange.inVersionRange).toBe(false);
		});

		it('helper parseSemanticVersion correctly extracts major, minor, patch, prerelease, and build', () => {
			const parsed = parseSemanticVersion('Claude Code 1.2.3-alpha.1+build.42');
			expect(parsed).toEqual({
				raw: '1.2.3-alpha.1+build.42',
				major: 1,
				minor: 2,
				patch: 3,
				prerelease: 'alpha.1',
				build: 'build.42',
			});

			expect(parsed).not.toBeNull();
			if (parsed) {
				expect(isVersionInRange(parsed, { min: '1.0.0', max: '2.0.0' })).toBe(true);
				expect(isVersionInRange(parsed, { min: '2.0.0' })).toBe(false);
			}
		});
	});

	describe('AC 6, E-199 & E-264: Custom user path and cross-platform path validation', () => {
		it('E-264: identifies and rejects Windows drive or UNC path on POSIX without converting, keeping value intact', async () => {
			const config = {
				...BUILT_IN_AGENT_DEFAULTS.claude,
				execPath: 'C:\\Users\\admin\\AppData\\Roaming\\npm\\claude.cmd',
			};

			const result = await probeAgent({
				agentId: 'claude',
				config,
				hostInputs: linuxHost,
				isCustomPath: true,
			});

			expect(result.ok).toBe(false);
			expect(result.status).toBe('invalid-platform-path');
			expect(result.canDispatch).toBe(false);
			expect(result.errorDetails?.reason).toBe('foreign-platform-path');
			expect(result.warningBanner?.code).toBe('E_AGENT_EXEC_INVALID_TARGET');
		});

		it('E-264: identifies and rejects POSIX absolute path on Windows without converting', async () => {
			const config = {
				...BUILT_IN_AGENT_DEFAULTS.claude,
				execPath: '/usr/local/bin/claude',
			};

			const result = await probeAgent({
				agentId: 'claude',
				config,
				hostInputs: windowsHost,
				isCustomPath: true,
			});

			expect(result.ok).toBe(false);
			expect(result.status).toBe('invalid-platform-path');
			expect(result.canDispatch).toBe(false);
			expect(result.errorDetails?.reason).toBe('foreign-platform-path');
		});

		it('isForeignPlatformPath helper correctly flags mismatching platforms', () => {
			expect(isForeignPlatformPath('C:\\bin\\agent.exe', 'linux')).toBe(true);
			expect(isForeignPlatformPath('\\\\server\\share\\agent.exe', 'darwin')).toBe(true);
			expect(isForeignPlatformPath('/usr/bin/agent', 'win32')).toBe(true);
			expect(isForeignPlatformPath('/usr/bin/agent', 'linux')).toBe(false);
			expect(isForeignPlatformPath('C:\\bin\\agent.exe', 'win32')).toBe(false);
		});

		it('E-199: user custom absolute path failure downgrades to warning banner rather than disabling', async () => {
			const config = {
				...BUILT_IN_AGENT_DEFAULTS.codex,
				execPath: '/opt/custom/codex-wrapper',
			};

			// Custom file exists but returns non-matching version
			const fs = createMockFileSystem({
				'/opt/custom/codex-wrapper': { isFile: true, isExecutable: true },
			});

			const mockRunner = vi.fn(async () => ({
				ok: false,
				exitCode: 1,
				stdout: '',
				stderr: 'custom wrapper initialization warning',
			}));

			const result = await probeAgent({
				agentId: 'codex',
				config,
				hostInputs: linuxHost,
				fileSystem: fs,
				commandRunner: mockRunner,
				isCustomPath: true,
			});

			expect(result.ok).toBe(false);
			expect(result.status).toBe('warning');
			// Crucial: canDispatch is TRUE under E-199 (user override always takes precedence, not disabled)
			expect(result.canDispatch).toBe(true);
			expect(result.isCustomPath).toBe(true);
			expect(result.warningBanner).toBeDefined();
			expect(result.warningBanner?.code).toBe('E_AGENT_VERSION_UNRECOGNIZED');
			expect(result.warningBanner?.message).toContain('user override is allowed with a warning');
		});

		it('E-199: user custom absolute path resolution failure also downgrades to warning banner and allows dispatch', async () => {
			const config = {
				...BUILT_IN_AGENT_DEFAULTS.codex,
				execPath: '/non/existent/codex',
			};

			const fs = createMockFileSystem({});

			const result = await probeAgent({
				agentId: 'codex',
				config,
				hostInputs: linuxHost,
				fileSystem: fs,
				isCustomPath: true,
			});

			expect(result.ok).toBe(false);
			expect(result.status).toBe('warning');
			expect(result.canDispatch).toBe(true);
			expect(result.warningBanner).toBeDefined();
			expect(result.warningBanner?.details?.reason).toBe('custom-path-unresolved');
		});
	});
});
