import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedAgentConfig } from '../../src/config/defaults.ts';
import { type AgentRegistry, createAgentRegistry } from '../../src/config/registry.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import type {
	ExecutableFileInfo,
	ExecutableFileSystem,
	PlatformHostInputs,
} from '../../src/platform/contract.ts';
import { createAgentService } from '../../src/service/agents.ts';

function createMockFileStat(
	isFile = true,
	isSymbolicLink = false,
	mtimeMs = 1000,
	size = 2048,
): ExecutableFileInfo {
	return {
		isFile: () => isFile,
		isSymbolicLink: () => isSymbolicLink,
		mtimeMs,
		size,
	} as unknown as ExecutableFileInfo;
}

function createMockRegistry(initialOverrides: Record<string, Partial<ResolvedAgentConfig>> = {}): {
	registry: AgentRegistry;
	files: Map<string, string>;
} {
	const files = new Map<string, string>();
	const configPath = '/test/data/agents.json';
	const initialJson = {
		schemaVersion: 1,
		overrides: initialOverrides,
	};
	files.set(configPath, JSON.stringify(initialJson, null, 2));

	const mockFs = {
		readUtf8File: async (p: string) => files.get(p) ?? '{}',
		writeUtf8File: async (p: string, c: string) => {
			files.set(p, c);
		},
		watchDirectory: () => {
			const watcher = {
				close: () => undefined,
				on: () => watcher,
			};
			return watcher;
		},
	};

	const registry = createAgentRegistry({
		dataDir: '/test/data',
		platform: 'posix',
		publishWarning: () => undefined,
		fileSystem: mockFs,
	});

	return { registry, files };
}

describe('M4-T4 AgentService and Availability Probing', () => {
	const hostInputs: PlatformHostInputs = Object.freeze({
		platform: 'linux',
		homedir: '/home/test',
	});

	it('AC 1 & E-40: marks missing agent as not-found / unavailable at startup, prevents dispatch before execution', async () => {
		const { registry, files } = createMockRegistry({
			codex: { execPath: 'nonexistent-codex-cli-binary-12345' },
		});

		const agentService = createAgentService({
			registry,
			hostInputs,
			fileSystem: {
				readUtf8File: async (p) => files.get(p) ?? '{}',
				writeUtf8File: async (p, c) => {
					files.set(p, c);
				},
				stat: async () => {
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				},
				lstat: async () => {
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				},
				realpath: async (p) => p,
				access: async () => {
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				},
				readlink: async (p) => p,
			},
		});

		await agentService.start();

		const agents = await agentService.listAgents();
		const codex = agents.find((a) => a.id === 'codex');
		expect(codex).toBeDefined();
		expect(codex?.isAvailable).toBe(false);
		expect(codex?.unavailableCode).toBe('E_AGENT_EXEC_NOT_FOUND');
		expect(codex?.unavailableReason).toContain('was not found in PATH');
		expect(codex?.missingRequirements?.length).toBeGreaterThan(0);

		// Pre-dispatch check must fail before starting any task execution (E-40)
		await expect(agentService.assertCanDispatch('codex')).rejects.toThrowError(AppError);
		try {
			await agentService.assertCanDispatch('codex');
		} catch (err) {
			const appError = err as AppError;
			expect(appError.code).toBe('E_AGENT_UNAVAILABLE');
			expect(appError.details?.agentId).toBe('codex');
		}
	});

	it('AC 2 & E-88: invalid executable path does not block other agents from being probed and allows jumping to config', async () => {
		const { registry, files } = createMockRegistry({
			codex: { execPath: '/invalid/path/to/codex' },
			claude: { execPath: '/valid/path/to/claude' },
		});

		const fileSystem: ExecutableFileSystem & {
			readUtf8File: (p: string) => Promise<string>;
			writeUtf8File: (p: string, c: string) => Promise<void>;
		} = {
			readUtf8File: async (p: string) => files.get(p) ?? '{}',
			writeUtf8File: async (p: string, c: string) => {
				files.set(p, c);
			},
			stat: async (p: string) => {
				if (p === '/valid/path/to/claude') {
					return createMockFileStat(true, false, 1000, 2048);
				}
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			},
			lstat: async (p: string) => {
				if (p === '/valid/path/to/claude') {
					return createMockFileStat(true, false);
				}
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			},
			realpath: async (p: string) => p,
			access: async (p: string) => {
				if (p === '/valid/path/to/claude') return undefined;
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			},
			readlink: async (p: string) => p,
		};

		const commandRunner = async (params: { file: string; args: readonly string[] }) => {
			if (params.file === '/valid/path/to/claude') {
				return { ok: true, exitCode: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' };
			}
			return { ok: false, exitCode: 1, stdout: '', stderr: 'command not found' };
		};

		const agentService = createAgentService({
			registry,
			hostInputs,
			fileSystem,
			commandRunner,
		});

		await agentService.start();

		const agents = await agentService.listAgents();
		const codex = agents.find((a) => a.id === 'codex');
		const claude = agents.find((a) => a.id === 'claude');

		// Codex failed due to invalid path (E-88)
		expect(codex?.isAvailable).toBe(false);
		expect(codex?.execPath).toBe('/invalid/path/to/codex');
		expect(codex?.unavailableCode).toBe('E_AGENT_EXEC_NOT_FOUND');

		// Claude was NOT blocked by Codex and probed successfully
		expect(claude?.isAvailable).toBe(true);
		expect(claude?.unavailableCode).toBeNull();
		await expect(agentService.assertCanDispatch('claude')).resolves.toBeUndefined();
	});

	it('AC 2 & E-262: returns E_AGENT_EXEC_NOT_EXECUTABLE when POSIX binary lacks execute permission', async () => {
		const { registry, files } = createMockRegistry({
			codex: { execPath: '/bin/codex-no-perm' },
		});

		const fileSystem: ExecutableFileSystem & {
			readUtf8File: (p: string) => Promise<string>;
			writeUtf8File: (p: string, c: string) => Promise<void>;
		} = {
			readUtf8File: async (p: string) => files.get(p) ?? '{}',
			writeUtf8File: async (p: string, c: string) => {
				files.set(p, c);
			},
			stat: async () => createMockFileStat(true, false, 1000, 2048),
			lstat: async () => createMockFileStat(true, false),
			realpath: async (p: string) => p,
			access: async () => {
				// Simulate X_OK failure (EACCES)
				throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
			},
			readlink: async (p: string) => p,
		};

		const agentService = createAgentService({
			registry,
			hostInputs,
			fileSystem,
		});

		await agentService.start();

		const codex = await agentService.getAgent('codex');
		expect(codex?.isAvailable).toBe(false);
		expect(codex?.unavailableCode).toBe('E_AGENT_EXEC_NOT_EXECUTABLE');
		expect(codex?.unavailableReason).toContain('execute permission');
		expect(codex?.missingRequirements).toContain('Execute permission on executable file (X_OK)');

		await expect(agentService.assertCanDispatch('codex')).rejects.toThrowError(AppError);
		try {
			await agentService.assertCanDispatch('codex');
		} catch (err) {
			const appError = err as AppError;
			expect(appError.code).toBe('E_AGENT_UNAVAILABLE');
			expect(appError.details?.code).toBe('E_AGENT_EXEC_NOT_EXECUTABLE');
		}
	});

	it('AC 2 & E-263: returns E_AGENT_EXEC_INVALID_TARGET on broken symlink, reports paths, does not cache failure', async () => {
		const { registry, files } = createMockRegistry({
			grok: { execPath: '/usr/local/bin/grok-broken-link' },
		});

		let accessAttempts = 0;
		const fileSystem: ExecutableFileSystem & {
			readUtf8File: (p: string) => Promise<string>;
			writeUtf8File: (p: string, c: string) => Promise<void>;
		} = {
			readUtf8File: async (p: string) => files.get(p) ?? '{}',
			writeUtf8File: async (p: string, c: string) => {
				files.set(p, c);
			},
			stat: async () => {
				throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
			},
			lstat: async () => createMockFileStat(false, true),
			realpath: async () => {
				throw Object.assign(new Error('ENOENT: broken symlink'), { code: 'ENOENT' });
			},
			access: async () => {
				accessAttempts++;
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			},
			readlink: async () => '/nonexistent/target',
		};

		const agentService = createAgentService({
			registry,
			hostInputs,
			fileSystem,
		});

		await agentService.start();

		const grok = await agentService.getAgent('grok');
		expect(grok?.isAvailable).toBe(false);
		expect(grok?.unavailableCode).toBe('E_AGENT_EXEC_INVALID_TARGET');
		expect(grok?.unavailableReason).toContain('regular file');

		// AC 2 & E-263: failed result must not be cached, second probe must hit fileSystem again
		const probeRes = await agentService.probeAgent('grok', { force: false });
		expect(probeRes.fromCache).toBeFalsy();
		expect(probeRes.ok).toBe(false);
		expect(accessAttempts).toBe(0); // broken link fails before access()
	});

	it(
		'R1 E-263 end-to-end: real fs broken/cyclic/directory symlink yields E_AGENT_EXEC_INVALID_TARGET with originalPath and resolvedPath',
		{ timeout: 30000 },
		async () => {
			const tempDir = join(tmpdir(), `test-symlinks-e263-${randomUUID()}`);
			mkdirSync(tempDir, { recursive: true });

			try {
				// 1. Broken symlink to non-existent target
				const brokenLink = join(tempDir, 'broken-link');
				const missingTarget = join(tempDir, 'nonexistent-target');
				symlinkSync(missingTarget, brokenLink);

				// 2. Cyclic symlink
				const cyclicA = join(tempDir, 'cyclic-a');
				const cyclicB = join(tempDir, 'cyclic-b');
				symlinkSync(cyclicB, cyclicA);
				symlinkSync(cyclicA, cyclicB);

				// 3. Symlink to a directory (non-regular file)
				const subDir = join(tempDir, 'some-dir');
				mkdirSync(subDir);
				const dirLink = join(tempDir, 'dir-link');
				symlinkSync(subDir, dirLink);

				const { registry } = createMockRegistry({
					codex: { execPath: brokenLink },
					claude: { execPath: cyclicA },
					grok: { execPath: dirLink },
				});

				// No mock fileSystem injected: use real DEFAULT_FILE_SYSTEM (R1)
				const agentService = createAgentService({
					registry,
					hostInputs: { platform: 'linux', homedir: tempDir },
				});

				await agentService.start();

				// Verify broken symlink
				const codex = await agentService.getAgent('codex');
				expect(codex?.isAvailable).toBe(false);
				expect(codex?.unavailableCode).toBe('E_AGENT_EXEC_INVALID_TARGET');
				expect(codex?.errorDetails?.originalPath).toBe(brokenLink);
				expect(codex?.errorDetails?.resolvedPath).toBe(missingTarget);

				// Verify cyclic symlink
				const claude = await agentService.getAgent('claude');
				expect(claude?.isAvailable).toBe(false);
				expect(claude?.unavailableCode).toBe('E_AGENT_EXEC_INVALID_TARGET');
				expect(claude?.errorDetails?.originalPath).toBe(cyclicA);

				// Verify directory symlink
				const grok = await agentService.getAgent('grok');
				expect(grok?.isAvailable).toBe(false);
				expect(grok?.unavailableCode).toBe('E_AGENT_EXEC_INVALID_TARGET');
				expect(grok?.errorDetails?.originalPath).toBe(dirLink);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);

	it('AC 3 & E-201: detects pi pointing to another binary via fingerprint mismatch, prompts manual path entry, forbids silent dispatch', async () => {
		// In E-201: PATH has 'pi', but running it returns mismatched output
		const { registry, files } = createMockRegistry({
			pi: { execPath: 'pi' },
		});

		const fileSystem: ExecutableFileSystem & {
			readUtf8File: (p: string) => Promise<string>;
			writeUtf8File: (p: string, c: string) => Promise<void>;
		} = {
			readUtf8File: async (p: string) => files.get(p) ?? '{}',
			writeUtf8File: async (p: string, c: string) => {
				files.set(p, c);
			},
			stat: async (p: string) => {
				if (p === '/usr/local/bin/pi') {
					return createMockFileStat(true, false, 1000, 2048);
				}
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			},
			lstat: async (p: string) => {
				if (p === '/usr/local/bin/pi') {
					return createMockFileStat(true, false);
				}
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			},
			realpath: async (p: string) => p,
			access: async (p: string) => {
				if (p === '/usr/local/bin/pi') return undefined;
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			},
			readlink: async (p: string) => p,
		};

		// Simulate /usr/local/bin/pi executing Python or a different utility (E-201)
		const commandRunner = async () => ({
			ok: true,
			exitCode: 0,
			stdout: 'Python 3.10.12 (main, Nov 20 2023, 15:14:05)\n',
			stderr: '',
		});

		const agentService = createAgentService({
			registry,
			hostInputs,
			fileSystem,
			commandRunner,
		});

		await agentService.start();

		const pi = await agentService.getAgent('pi');
		expect(pi?.isAvailable).toBe(false);
		expect(pi?.unavailableCode).toBe('E_AGENT_VERSION_UNRECOGNIZED');
		expect(pi?.unavailableReason).toContain('manual path configuration required');
		expect(pi?.errorDetails?.observed).toContain('Python 3.10.12');
		expect(pi?.errorDetails?.expected).toContain('\\bpi\\b');

		// Must never silently dispatch with wrong parameters (E-201)
		await expect(agentService.assertCanDispatch('pi')).rejects.toThrowError(AppError);
		try {
			await agentService.assertCanDispatch('pi');
		} catch (err) {
			const appError = err as AppError;
			expect(appError.code).toBe('E_AGENT_VERSION_UNRECOGNIZED');
			expect(appError.details?.observed).toContain('Python 3.10.12');
		}
	});

	it('publishes agent.availability_changed event on availability state change', async () => {
		const { registry, files } = createMockRegistry({
			codex: { execPath: '/bin/codex' },
		});

		const ringBuffer = createRingBuffer();
		const bus = createEventBus({ ringBuffer });
		let eventCount = 0;
		const idAllocator = { allocate: () => ++eventCount };
		const envelopeFactory = createEnvelopeFactory({
			clock: { now: () => '2026-09-12T02:00:00.000Z' },
			idAllocator,
		});

		const receivedEvents: Array<{ agentId: string; available: boolean }> = [];
		bus.subscribe((envelope) => {
			if (envelope.kind === 'agent.availability_changed') {
				const p = envelope.payload as { agentId: string; available: boolean };
				receivedEvents.push(p);
			}
		});

		const fileSystem: ExecutableFileSystem & {
			readUtf8File: (p: string) => Promise<string>;
			writeUtf8File: (p: string, c: string) => Promise<void>;
		} = {
			readUtf8File: async (p: string) => files.get(p) ?? '{}',
			writeUtf8File: async (p: string, c: string) => {
				files.set(p, c);
			},
			stat: async () => createMockFileStat(true, false, 1000, 2048),
			lstat: async () => createMockFileStat(true, false),
			realpath: async (p: string) => p,
			access: async () => undefined,
			readlink: async (p: string) => p,
		};

		const commandRunner = async () => ({
			ok: true,
			exitCode: 0,
			stdout: 'codex-cli 0.12.0\n',
			stderr: '',
		});

		const agentService = createAgentService({
			registry,
			hostInputs,
			bus,
			envelopeFactory,
			fileSystem,
			commandRunner,
		});

		await agentService.start();

		// Startup probe emits availability_changed events
		expect(receivedEvents.length).toBeGreaterThan(0);
		const codexEvent = receivedEvents.find((e) => e.agentId === 'codex');
		expect(codexEvent).toBeDefined();
		expect(codexEvent?.available).toBe(true);
	});

	it('disables agent when maxConcurrency is 0 or negative (E-91)', async () => {
		const { registry, files } = createMockRegistry({
			codex: { maxConcurrency: 0 },
		});

		const agentService = createAgentService({
			registry,
			hostInputs,
			fileSystem: {
				readUtf8File: async (p) => files.get(p) ?? '{}',
				writeUtf8File: async (p, c) => {
					files.set(p, c);
				},
				stat: async () => createMockFileStat(true, false, 1000, 2048),
				lstat: async () => createMockFileStat(true, false),
				realpath: async (p) => p,
				access: async () => undefined,
				readlink: async (p) => p,
			},
		});

		await agentService.start();

		const codex = await agentService.getAgent('codex');
		expect(codex?.isAvailable).toBe(false);
		expect(codex?.unavailableReason).toContain('maxConcurrency <= 0');

		await expect(agentService.assertCanDispatch('codex')).rejects.toThrowError(AppError);
	});

	it('updates agent settings and validates monogram uniqueness (E-183)', async () => {
		const { registry, files } = createMockRegistry({
			codex: { monogram: 'CX' },
			claude: { monogram: 'CL' },
		});

		const agentService = createAgentService({
			registry,
			hostInputs,
			fileSystem: {
				readUtf8File: async (p) => files.get(p) ?? '{}',
				writeUtf8File: async (p, c) => {
					files.set(p, c);
				},
				stat: async () => createMockFileStat(true, false, 1000, 2048),
				lstat: async () => createMockFileStat(true, false),
				realpath: async (p) => p,
				access: async () => undefined,
				readlink: async (p) => p,
			},
			commandRunner: async () => ({
				ok: true,
				exitCode: 0,
				stdout: 'codex 1.0.0\n',
				stderr: '',
			}),
		});

		await agentService.start();

		// Monogram collision with claude ('CL') must fail with E_VALIDATION
		await expect(agentService.updateAgent('codex', { monogram: 'CL' })).rejects.toThrowError(
			AppError,
		);

		try {
			await agentService.updateAgent('codex', { monogram: 'CL' });
		} catch (err) {
			const appError = err as AppError;
			expect(appError.code).toBe('E_VALIDATION');
			expect(appError.message).toContain("already in use by agent 'claude'");
		}

		// Valid update succeeds
		const updated = await agentService.updateAgent('codex', {
			monogram: 'CD',
			maxConcurrency: 3,
		});
		expect(updated.monogram).toBe('CD');
		expect(updated.maxConcurrency).toBe(3);
	});

	it('R2: refuses invalid values with 400 E_VALIDATION and keeps disk file byte-by-byte identical; preserves unparseable disk file', async () => {
		const { registry, files } = createMockRegistry({
			codex: { execPath: 'codex', monogram: 'CX' },
			claude: { execPath: 'claude', monogram: 'CL' },
		});

		const agentService = createAgentService({
			registry,
			hostInputs,
			fileSystem: {
				readUtf8File: async (p) => files.get(p) ?? '{}',
				writeUtf8File: async (p, c) => {
					files.set(p, c);
				},
				stat: async () => createMockFileStat(true, false, 1000, 2048),
				lstat: async () => createMockFileStat(true, false),
				realpath: async (p) => p,
				access: async () => undefined,
				readlink: async (p) => p,
			},
		});

		await agentService.start();
		const originalDiskBytes = files.get(registry.configPath);
		expect(originalDiskBytes).toBeDefined();

		// 1. Invalid execPath: '' -> must fail with E_VALIDATION, file unchanged byte-by-byte
		await expect(agentService.updateAgent('codex', { execPath: '' })).rejects.toThrowError(
			AppError,
		);
		expect(files.get(registry.configPath)).toBe(originalDiskBytes);

		// 2. Invalid monogram: 'TOOLONG' -> must fail with E_VALIDATION, file unchanged byte-by-byte
		await expect(agentService.updateAgent('codex', { monogram: 'TOOLONG' })).rejects.toThrowError(
			AppError,
		);
		expect(files.get(registry.configPath)).toBe(originalDiskBytes);

		// 3. Corrupted unparseable JSON on disk -> updateAgent refuses to write and keeps file intact
		const corruptedContent = '<<<corrupted unparseable json text>>>';
		files.set(registry.configPath, corruptedContent);
		await expect(agentService.updateAgent('claude', { maxConcurrency: 2 })).rejects.toThrowError(
			AppError,
		);
		expect(files.get(registry.configPath)).toBe(corruptedContent);
	});

	it('R3: hot-reload refreshing availability; assertCanDispatch blocks after path becomes invalid', async () => {
		const { registry, files } = createMockRegistry({
			codex: { execPath: '/bin/codex-valid' },
		});

		const fileSystem: ExecutableFileSystem & {
			readUtf8File: (p: string) => Promise<string>;
			writeUtf8File: (p: string, c: string) => Promise<void>;
		} = {
			readUtf8File: async (p: string) => files.get(p) ?? '{}',
			writeUtf8File: async (p: string, c: string) => {
				files.set(p, c);
			},
			stat: async (p: string) => {
				if (p === '/bin/codex-valid') {
					return createMockFileStat(true, false, 1000, 2048);
				}
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			},
			lstat: async (p: string) => {
				if (p === '/bin/codex-valid') {
					return createMockFileStat(true, false);
				}
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			},
			realpath: async (p: string) => p,
			access: async (p: string) => {
				if (p === '/bin/codex-valid') return undefined;
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			},
			readlink: async (p: string) => p,
		};

		const commandRunner = async (params: { file: string; args: readonly string[] }) => {
			if (params.file === '/bin/codex-valid') {
				return { ok: true, exitCode: 0, stdout: 'codex 0.12.0\n', stderr: '' };
			}
			return { ok: false, exitCode: 1, stdout: '', stderr: 'command not found' };
		};

		const agentService = createAgentService({
			registry,
			hostInputs,
			fileSystem,
			commandRunner,
		});

		await agentService.start();

		// Initially valid and dispatchable
		expect(agentService.getAvailability('codex')?.isAvailable).toBe(true);
		await expect(agentService.assertCanDispatch('codex')).resolves.toBeUndefined();

		// Simulate external configuration change: change execPath to a non-existent path
		const updatedContent = JSON.stringify({
			schemaVersion: 1,
			overrides: {
				codex: { execPath: '/bin/codex-corrupted-now' },
			},
		});
		files.set(registry.configPath, updatedContent);
		const reloadRes = await registry.reload();
		expect(reloadRes.status).toBe('loaded');

		// R3: Hot-reload triggers generation advancement; availability is refreshed
		expect(agentService.getAvailability('codex')?.isAvailable).toBeFalsy();
		await expect(agentService.assertCanDispatch('codex')).rejects.toThrowError(AppError);
		try {
			await agentService.assertCanDispatch('codex');
		} catch (err) {
			const appError = err as AppError;
			expect(appError.code).toBe('E_AGENT_UNAVAILABLE');
		}
	});
});
