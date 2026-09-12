import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	ListAgentModelsResponse,
	ListAgentsResponse,
	UpdateAgentResponse,
} from '@agent-scheduler/shared/api/agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createAgentRegistry } from '../../src/config/registry.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type { ExecutableFileInfo, ExecutableFileSystem } from '../../src/platform/contract.ts';
import type {
	LockFileHandle,
	NativeLockAdapter,
	NativeLockFailure,
	NativeLockReadResult,
	NativeLockWriteResult,
} from '../../src/platform/lock-contract.ts';
import { createAgentService } from '../../src/service/agents.ts';

const currentDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const migrationsDir = resolve(currentDir, '../../migrations');

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

function createMemoryLockAdapter(testDir: string): NativeLockAdapter {
	let lockContents: string | undefined;
	const missing = (): NativeLockFailure => ({
		kind: 'not-found',
		error: new AppError('E_INTERNAL', 'Memory lock is missing.'),
	});
	return Object.freeze({
		platform: 'linux',
		filePath: join(testDir, 'daemon.lock'),
		dirPath: testDir,
		reclaimPath: join(testDir, 'daemon.lock.reclaim'),
		permissionLines: ['root:root 0600'],
		createExclusive(contents: string): NativeLockWriteResult {
			if (lockContents !== undefined) {
				return {
					ok: false,
					failure: {
						kind: 'already-exists',
						error: new AppError('E_INTERNAL', 'Memory lock already exists.'),
					},
				};
			}
			lockContents = contents;
			return { ok: true };
		},
		read(): NativeLockReadResult {
			return lockContents === undefined
				? { ok: false, failure: missing() }
				: { ok: true, contents: lockContents };
		},
		remove(): NativeLockWriteResult {
			lockContents = undefined;
			return { ok: true };
		},
		verifyPermissions: (): NativeLockWriteResult => ({ ok: true }),
		inspectPermissions: (): NativeLockReadResult => ({
			ok: true,
			contents: 'root:root mode=600',
		}),
		createReclaimGuard: (): NativeLockWriteResult => ({ ok: true }),
		readReclaimGuard(): NativeLockReadResult {
			return { ok: false, failure: missing() };
		},
		removeReclaimGuard: (): NativeLockWriteResult => ({ ok: true }),
	});
}

describe('M4-T4 Agents HTTP Routes Integration (R4 Fake Processes)', { timeout: 60000 }, () => {
	let db: DatabaseConnection;
	let testDir: string;
	let dbPath: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `agents-routes-test-${randomUUID()}`);
		dbPath = join(testDir, 'test.db');
		mkdirSync(testDir, { recursive: true });
		db = openDatabase(dbPath);
		const runner = createMigrationRunner({
			clock: { now: () => '2026-09-12T02:00:00.000Z' },
			database: db,
			fileSystem: {
				readDirectory: () => ['0001_init.sql'],
				readFile: (p: string) => readFileSync(p, 'utf8'),
			},
		});
		runner.run(migrationsDir);
	});

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true, force: true });
	});

	function setupTestServer(options?: {
		commandRunner?: (p: { file: string; args: readonly string[] }) => Promise<{
			ok: boolean;
			exitCode: number;
			stdout: string;
			stderr: string;
		}>;
		unavailableAgents?: readonly string[];
	}) {
		const lockAdapter = createMemoryLockAdapter(testDir);
		const unavailableSet = new Set(options?.unavailableAgents ?? []);

		const defaultCommandRunner =
			options?.commandRunner ??
			(async (params: { file: string; args: readonly string[] }) => {
				if (params.file.includes('claude')) {
					return { ok: true, exitCode: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' };
				}
				if (params.file.includes('codex')) {
					return { ok: true, exitCode: 0, stdout: 'codex 0.12.0\n', stderr: '' };
				}
				if (params.file.includes('pi')) {
					return { ok: true, exitCode: 0, stdout: 'pi 0.9.0\n', stderr: '' };
				}
				if (params.file.includes('grok')) {
					return { ok: true, exitCode: 0, stdout: 'grok 1.1.0\n', stderr: '' };
				}
				return { ok: false, exitCode: 1, stdout: '', stderr: 'command not found' };
			});

		const mockFileSystem: ExecutableFileSystem & {
			readUtf8File: (p: string) => Promise<string>;
			writeUtf8File: (p: string, c: string) => Promise<void>;
		} = {
			readUtf8File: async (p) => {
				try {
					return await readFile(p, 'utf8');
				} catch {
					return '{}';
				}
			},
			writeUtf8File: async (p, c) => {
				await writeFile(p, c, 'utf8');
			},
			stat: async (p) => {
				for (const bad of unavailableSet) {
					if (p.includes(bad)) {
						throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
					}
				}
				if (
					p === '/usr/local/bin/codex' ||
					p === '/usr/local/bin/claude' ||
					p === '/usr/local/bin/pi' ||
					p === '/usr/local/bin/grok'
				) {
					return createMockFileStat(true, false, 1000, 2048);
				}
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			},
			lstat: async (p) => {
				for (const bad of unavailableSet) {
					if (p.includes(bad)) {
						throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
					}
				}
				if (
					p === '/usr/local/bin/codex' ||
					p === '/usr/local/bin/claude' ||
					p === '/usr/local/bin/pi' ||
					p === '/usr/local/bin/grok'
				) {
					return createMockFileStat(true, false);
				}
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			},
			realpath: async (p) => p,
			access: async (p) => {
				for (const bad of unavailableSet) {
					if (p.includes(bad)) {
						throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
					}
				}
				if (
					p === '/usr/local/bin/codex' ||
					p === '/usr/local/bin/claude' ||
					p === '/usr/local/bin/pi' ||
					p === '/usr/local/bin/grok'
				) {
					return undefined;
				}
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			},
			readlink: async (p) => p,
		};

		const baseRegistry = createAgentRegistry({
			dataDir: testDir,
			platform: 'posix',
			publishWarning: () => undefined,
			fileSystem: {
				readUtf8File: mockFileSystem.readUtf8File,
				writeUtf8File: mockFileSystem.writeUtf8File,
				watchDirectory: () => {
					const watcher = { close: () => undefined, on: () => watcher };
					return watcher;
				},
			},
		});

		const agentService = createAgentService({
			registry: baseRegistry,
			hostInputs: { platform: 'linux', homedir: testDir },
			commandRunner: defaultCommandRunner,
			fileSystem: mockFileSystem,
			clock: { now: () => '2026-09-12T02:00:00.000Z' },
		});

		const container = createContainer({
			config: {
				port: 7817,
				bind: '127.0.0.1',
				dataDir: testDir,
				logLevel: 'error',
				dev: false,
			},
			database: db,
			hostInputs: { platform: 'linux', homedir: testDir },
			lockAdapter,
			instanceLock: { release: () => undefined } as unknown as LockFileHandle,
			clock: { now: () => '2026-09-12T02:00:00.000Z' },
			agentRegistry: baseRegistry,
			agentService,
		});

		const server = createHttpServer({ container });
		return { server, container };
	}

	async function getAuthToken(container: ReturnType<typeof createContainer>): Promise<string> {
		const activeCode =
			container.services.pairing.getActivePairingCode()?.code ??
			container.services.pairing.createPairingCode().code;
		const claim = await container.services.pairing.claimPairingCode({
			code: activeCode,
			deviceName: 'test-device-m4-t4',
		});
		return `Bearer ${claim.token}`;
	}

	it('GET /api/v1/agents returns 401 without auth, returns agents list with valid token (R4)', async () => {
		const { server, container } = setupTestServer();
		await server.instance.ready();

		// 1. Without auth -> 401
		const unauthedRes = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/agents',
		});
		expect(unauthedRes.statusCode).toBe(401);

		// 2. With auth -> 200
		const token = await getAuthToken(container);
		const authedRes = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/agents',
			headers: { authorization: token },
		});

		expect(authedRes.statusCode).toBe(200);
		const body = JSON.parse(authedRes.body) as ListAgentsResponse;
		expect(Array.isArray(body.agents)).toBe(true);
		expect(body.agents.length).toBeGreaterThanOrEqual(4);

		const agentIds = body.agents.map((a) => a.id);
		expect(agentIds).toContain('codex');
		expect(agentIds).toContain('claude');
		expect(agentIds).toContain('pi');
		expect(agentIds).toContain('grok');

		for (const agent of body.agents) {
			expect(typeof agent.isAvailable).toBe('boolean');
			expect(typeof agent.monogram).toBe('string');
			expect(agent.monogram.length).toBe(2);
		}
	});

	it('PATCH /api/v1/agents/:agentId updates agent and rejects duplicate monogram (R2)', async () => {
		const { server, container } = setupTestServer();
		await server.instance.ready();
		const token = await getAuthToken(container);

		// 1. Monogram collision with claude ('CL') -> 400 E_VALIDATION
		const duplicateRes = await server.instance.inject({
			method: 'PATCH',
			url: '/api/v1/agents/codex',
			headers: { authorization: token },
			payload: { monogram: 'CL' },
		});
		expect(duplicateRes.statusCode).toBe(400);
		const duplicateBody = JSON.parse(duplicateRes.body);
		expect(duplicateBody.error?.code).toBe('E_VALIDATION');

		// 2. Nonexistent agent -> 404 E_NOT_FOUND
		const notFoundRes = await server.instance.inject({
			method: 'PATCH',
			url: '/api/v1/agents/unknown-agent-xyz',
			headers: { authorization: token },
			payload: { maxConcurrency: 2 },
		});
		expect(notFoundRes.statusCode).toBe(404);

		// 3. Valid update -> 200 with updated agent
		const validRes = await server.instance.inject({
			method: 'PATCH',
			url: '/api/v1/agents/codex',
			headers: { authorization: token },
			payload: { monogram: 'CX', maxConcurrency: 4, defaultModel: 'gpt-5' },
		});
		expect(validRes.statusCode).toBe(200);
		const validBody = JSON.parse(validRes.body) as UpdateAgentResponse;
		expect(validBody.agent.id).toBe('codex');
		expect(validBody.agent.maxConcurrency).toBe(4);
		expect(validBody.agent.defaultModel).toBe('gpt-5');
	});

	it('POST /api/v1/agents/:agentId/probe runs probe and reports success or typed error (R4)', async () => {
		const mockRunner = async (params: { file: string; args: readonly string[] }) => {
			if (params.file.includes('claude')) {
				return { ok: true, exitCode: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' };
			}
			return { ok: true, exitCode: 0, stdout: 'Python 3.10.12 (not pi)\n', stderr: '' };
		};

		const { server, container } = setupTestServer({
			commandRunner: mockRunner,
			unavailableAgents: ['codex'],
		});
		await server.instance.ready();
		const token = await getAuthToken(container);

		// 1. Nonexistent agent -> 404
		const notFoundRes = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/agents/unknown-agent/probe',
			headers: { authorization: token },
		});
		expect(notFoundRes.statusCode).toBe(404);

		// 2. Unavailable agent -> 409 E_AGENT_UNAVAILABLE
		const unavailableRes = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/agents/codex/probe',
			headers: { authorization: token },
		});
		expect(unavailableRes.statusCode).toBe(409);
		const unavailBody = JSON.parse(unavailableRes.body);
		expect(unavailBody.error?.code).toBe('E_AGENT_UNAVAILABLE');

		// 3. Available agent (claude) -> 200 ProbeAgentResponse
		const availableRes = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/agents/claude/probe',
			headers: { authorization: token },
		});
		expect(availableRes.statusCode).toBe(200);
		const availableBody = JSON.parse(availableRes.body);
		expect(availableBody.matched).toBe(true);
		expect(availableBody.status).toBe('matched');
	});

	it('GET /api/v1/agents/:agentId/models returns 409 when agent is unavailable and 200 when available (R4)', async () => {
		const { server, container } = setupTestServer({ unavailableAgents: ['codex'] });
		await server.instance.ready();
		const token = await getAuthToken(container);

		// 1. Agent is unavailable -> 409 E_AGENT_UNAVAILABLE
		const unavailRes = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/agents/codex/models',
			headers: { authorization: token },
		});

		expect(unavailRes.statusCode).toBe(409);
		const body = JSON.parse(unavailRes.body);
		expect(body.error?.code).toBe('E_AGENT_UNAVAILABLE');

		// 2. Available agent -> 200 ListAgentModelsResponse
		const availRes = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/agents/claude/models',
			headers: { authorization: token },
		});
		expect(availRes.statusCode).toBe(200);
		const availBody = JSON.parse(availRes.body) as ListAgentModelsResponse;
		expect(Array.isArray(availBody.models)).toBe(true);
	});
});
