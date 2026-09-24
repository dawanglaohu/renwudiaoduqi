import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	ListAgentModelsResponse,
	ListAgentsResponse,
} from '@agent-scheduler/shared/api/agents';
import type { ListGatesResponse } from '@agent-scheduler/shared/api/gates';
import type {
	CreateRunResponse,
	ListRunsResponse,
	RerunRunResponse,
} from '@agent-scheduler/shared/api/runs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createAgentRegistry } from '../../src/config/registry.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type { ExecutableFileInfo, ExecutableFileSystem } from '../../src/platform/contract.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import type {
	LaunchSpec,
	ManagedProcess,
	ProcessExitResult,
	SpawnManagedOptions,
} from '../../src/proc/spawn.ts';
import { createAgentService } from '../../src/service/agents.ts';

const currentDir = resolve(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = resolve(currentDir, '../../migrations');
const loginFixturesDir = resolve(currentDir, '../fixtures/login');
const modelsFixturesDir = resolve(currentDir, '../fixtures/models');

function readFixture(dir: string, file: string): string {
	return readFileSync(join(dir, file), 'utf8');
}

function createMockFileStat(): ExecutableFileInfo {
	return {
		isFile: () => true,
		isSymbolicLink: () => false,
		mtimeMs: 1000,
		size: 2048,
	} as unknown as ExecutableFileInfo;
}

function createEmptyManagedProcess(spec: LaunchSpec, pid = 8888): ManagedProcess {
	return {
		runId: spec.runId,
		pid,
		file: spec.file,
		args: spec.args,
		cwd: spec.cwd,
		child: {} as ManagedProcess['child'],
		stdoutReader: {} as ManagedProcess['stdoutReader'],
		stderrReader: {} as ManagedProcess['stderrReader'],
		timers: {} as ManagedProcess['timers'],
		isExited: false,
		stderrTail: '',
		stderrTailLines: [],
		attachAppendQueue: () => () => undefined,
		waitForStdinDrain: async () => undefined,
		onStdinDrain: () => () => undefined,
		writeStdin: () => true,
		onLine: () => () => undefined,
		onRaw: () => () => undefined,
		onStderr: () => () => undefined,
		onJson: () => () => undefined,
		onExit: () => () => undefined,
		onError: () => () => undefined,
		kill: async () => ({ outcome: 'terminated', attempts: [] }),
		finalize: async () => undefined,
	};
}

function createMemoryLockAdapter(testDir: string): NativeLockAdapter {
	return Object.freeze({
		platform: 'linux',
		filePath: join(testDir, 'daemon.lock'),
		dirPath: testDir,
		reclaimPath: join(testDir, 'daemon.lock.reclaim'),
		permissionLines: ['root:root 0600'],
		createExclusive: () => ({ ok: true as const }),
		read: () => ({ ok: true as const, contents: '{}' }),
		remove: () => ({ ok: true as const }),
		verifyPermissions: () => ({ ok: true as const }),
		inspectPermissions: () => ({ ok: true as const, contents: 'root:root mode=600' }),
		createReclaimGuard: () => ({ ok: true as const }),
		readReclaimGuard: () => ({
			ok: false as const,
			failure: { kind: 'not-found' as const, error: new AppError('E_VALIDATION', 'not found') },
		}),
		removeReclaimGuard: () => ({ ok: true as const }),
	});
}

function createTempGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'agents-models-git-'));
	try {
		execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
		execSync('git config user.name "Tester"', { cwd: dir, stdio: 'ignore' });
		execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'ignore' });
		writeFileSync(join(dir, 'README.md'), '# Initial Repo\n');
		execSync('git add README.md && git commit -m "initial commit"', {
			cwd: dir,
			stdio: 'ignore',
		});
	} catch {
		try {
			execSync('git init', { cwd: dir, stdio: 'ignore' });
			execSync('git checkout -b main', { cwd: dir, stdio: 'ignore' });
			execSync('git config user.name "Tester"', { cwd: dir, stdio: 'ignore' });
			execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'ignore' });
			writeFileSync(join(dir, 'README.md'), '# Initial Repo\n');
			execSync('git add README.md && git commit -m "initial commit"', {
				cwd: dir,
				stdio: 'ignore',
			});
		} catch {}
	}
	return dir;
}

describe(
	'M8-T9 Integration: Agents, Models, Login and Assignment Pipeline (AC 1-9, 17 节)',
	{ timeout: 60000 },
	() => {
		let db: DatabaseConnection;
		let testDir: string;
		let gitRepoDir: string;
		let dbPath: string;
		let server: ReturnType<typeof createHttpServer>;
		let container: ReturnType<typeof createContainer>;
		let authToken: string;

		let appServerSpawnCount = 0;
		let forceAppServerTimeout = false;

		beforeEach(async () => {
			testDir = join(tmpdir(), `agents-models-login-${randomUUID()}`);
			dbPath = join(testDir, 'test.db');
			mkdirSync(testDir, { recursive: true });
			gitRepoDir = createTempGitRepo();

			db = openDatabase(dbPath);

			const codexConfigDir = join(testDir, '.codex');
			mkdirSync(codexConfigDir, { recursive: true });
			writeFileSync(
				join(codexConfigDir, 'config.toml'),
				`
model = "gpt-6-astra"
model_reasoning_effort = "xhigh"
`,
			);

			const runner = createMigrationRunner({
				clock: { now: () => '2026-09-17T12:00:00.000Z' },
				database: db,
				fileSystem: {
					readDirectory: () => readdirSync(migrationsDir),
					readFile: (p: string) => readFileSync(p, 'utf8'),
				},
			});
			runner.run(migrationsDir);

			// Seed initial document, batch, and task
			const escapedRepoPath = gitRepoDir.replace(/'/g, "''");
			db.exec(`
			INSERT INTO documents (id, docs_path, project_name, repo_path, content_fingerprint, imported_at, last_seen_at)
			VALUES ('doc-1', '/repo/docs', 'test-proj', '${escapedRepoPath}', 'fp-1', '2026-09-17T12:00:00.000Z', '2026-09-17T12:00:00.000Z');

			INSERT INTO batches (id, doc_id, batch_no, state, started_at)
			VALUES ('batch-1', 'doc-1', 1, 'running', '2026-09-17T12:00:00.000Z');

			INSERT INTO tasks (id, doc_id, task_key, title, module_key, deps_json, contract_hash, contract_reasons_json, is_contract_ready, batch_id)
			VALUES
				('task-1', 'doc-1', 'M1-T1', 'Task 1', 'M1', '[]', 'h1', '[]', 1, 'batch-1'),
				('task-2', 'doc-1', 'M1-T2', 'Task 2', 'M1', '[]', 'h2', '[]', 1, 'batch-1'),
				('task-3', 'doc-1', 'M1-T3', 'Task 3', 'M1', '[]', 'h3', '[]', 1, 'batch-1');
		`);

			appServerSpawnCount = 0;
			forceAppServerTimeout = false;

			const mockFileSystem: ExecutableFileSystem & {
				readUtf8File: (p: string) => Promise<string>;
				writeUtf8File: (p: string, c: string) => Promise<void>;
			} = {
				readUtf8File: async (p) => {
					if (p.includes('config.toml')) {
						return `
model = "gpt-6-astra"
model_reasoning_effort = "xhigh"
`;
					}
					return '{}';
				},
				writeUtf8File: async () => undefined,
				stat: async (p) => {
					if (
						p === '/usr/local/bin/codex' ||
						p === '/usr/local/bin/claude' ||
						p === '/usr/local/bin/pi' ||
						p === '/usr/local/bin/grok'
					) {
						return createMockFileStat();
					}
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				},
				lstat: async (p) => {
					if (
						p === '/usr/local/bin/codex' ||
						p === '/usr/local/bin/claude' ||
						p === '/usr/local/bin/pi' ||
						p === '/usr/local/bin/grok'
					) {
						return createMockFileStat();
					}
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				},
				realpath: async (p) => p,
				access: async (p) => {
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

			// Command runner for login probing and text-based model lists
			const commandRunner = async (params: { file: string; args: readonly string[] }) => {
				const joined = `${params.file} ${params.args.join(' ')}`;
				// Version probes (availability checks)
				if (joined.includes('--version') || joined.includes('-v')) {
					if (joined.includes('claude')) {
						return { ok: true, exitCode: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' };
					}
					if (joined.includes('codex')) {
						return { ok: true, exitCode: 0, stdout: 'codex 0.12.0\n', stderr: '' };
					}
					if (joined.includes('pi')) {
						return { ok: true, exitCode: 0, stdout: 'pi 0.9.0\n', stderr: '' };
					}
					if (joined.includes('grok')) {
						return { ok: true, exitCode: 0, stdout: 'grok 1.1.0\n', stderr: '' };
					}
				}
				if (joined.includes('codex') && joined.includes('login') && joined.includes('status')) {
					return {
						ok: true,
						exitCode: 0,
						stdout: readFixture(loginFixturesDir, 'codex-login-status.logged-in.stdout.txt'),
						stderr: '',
					};
				}
				// 2. Claude login (logged_out)
				if (joined.includes('claude') && joined.includes('auth') && joined.includes('status')) {
					return {
						ok: true,
						exitCode: 0,
						stdout: readFixture(loginFixturesDir, 'claude-auth-status.logged-out.stdout.json'),
						stderr: '',
					};
				}
				// 3. Grok login (models success)
				if (joined.includes('grok') && joined.includes('models')) {
					return {
						ok: true,
						exitCode: 0,
						stdout: readFixture(loginFixturesDir, 'grok-models.success.stdout.txt'),
						stderr: '',
					};
				}
				// 4. Pi login (auth check and list-models)
				if (joined.includes('pi') && joined.includes('auth') && joined.includes('check')) {
					return {
						ok: true,
						exitCode: 0,
						stdout: readFixture(loginFixturesDir, 'pi-auth-check.ready.stdout.json'),
						stderr: '',
					};
				}
				if (joined.includes('pi') && joined.includes('list-models')) {
					return {
						ok: true,
						exitCode: 0,
						stdout: readFixture(loginFixturesDir, 'pi-list-models.stdout.txt'),
						stderr: '',
					};
				}
				return { ok: true, exitCode: 0, stdout: '', stderr: '' };
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
				commandRunner,
				fileSystem: mockFileSystem,
				clock: { now: () => '2026-09-17T12:00:00.000Z' },
				spawnManagedFn: (_spec: LaunchSpec, options?: SpawnManagedOptions) => {
					appServerSpawnCount++;
					if (forceAppServerTimeout) {
						return createEmptyManagedProcess(_spec, 7777);
					}
					const ndjsonContent = readFixture(modelsFixturesDir, 'codex-model-list.stdout.ndjson');
					const lines = ndjsonContent.split('\n').filter((l) => l.trim().length > 0);
					setTimeout(() => {
						for (const line of lines) {
							options?.onLine?.({
								text: line,
								truncated: false,
								rawByteLen: Buffer.byteLength(line),
							});
						}
					}, 5);

					return createEmptyManagedProcess(_spec, 7777);
				},
			});

			const gitRunner = {
				run: async (args: readonly string[], cwd?: string) => {
					try {
						const out = execSync(
							`git ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`,
							{
								cwd: cwd ?? gitRepoDir,
								stdio: ['pipe', 'pipe', 'pipe'],
								encoding: 'utf8',
							},
						);
						return { ok: true, exitCode: 0, stdout: out, stderr: '' };
					} catch (err: unknown) {
						const e = err as {
							status?: number;
							stdout?: Buffer;
							stderr?: Buffer;
							message?: string;
						};
						return {
							ok: false,
							exitCode: e.status ?? 1,
							stdout: e.stdout?.toString() ?? '',
							stderr: e.stderr?.toString() ?? e.message ?? '',
						};
					}
				},
			};

			const fakeSpawnManaged = (spec: LaunchSpec): ManagedProcess => {
				return createEmptyManagedProcess(spec, 8888);
			};

			container = createContainer({
				config: {
					port: 7817,
					bind: '127.0.0.1',
					dataDir: testDir,
					logLevel: 'error',
					dev: false,
				},
				database: db,
				hostInputs: { platform: 'linux', homedir: testDir },
				lockAdapter: createMemoryLockAdapter(testDir),
				instanceLock: { release: () => undefined } as unknown as LockFileHandle,
				clock: { now: () => '2026-09-17T12:00:00.000Z' },
				agentRegistry: baseRegistry,
				agentService,
				gitRunner,
				spawnManaged: fakeSpawnManaged,
			});

			server = createHttpServer({ container });
			await server.instance.ready();

			// Claim pairing code for authorization token
			const activeCode =
				container.services.pairing.getActivePairingCode()?.code ??
				container.services.pairing.createPairingCode().code;
			const claim = await container.services.pairing.claimPairingCode({
				code: activeCode,
				deviceName: 'test-device-m8-t9',
			});
			authToken = `Bearer ${claim.token}`;
		});

		afterEach(async () => {
			if (server) await server.instance.close();
			await new Promise((r) => setTimeout(r, 100));
			if (db) db.close();
			try {
				rmSync(testDir, { recursive: true, force: true });
			} catch {}
			if (gitRepoDir) {
				try {
					rmSync(gitRepoDir, { recursive: true, force: true });
				} catch {}
			}
		});

		it('executes the 8 integration assertions end-to-end', async () => {
			// =========================================================================
			// ① GET /agents returns login status per agent & claude logged_out can still POST /runs
			// =========================================================================
			// Probe availability of all agents (binary existence)
			await container.services.agents.probeAll();

			// Trigger initial login probes according to fixtures
			await container.services.agents.refreshLogin('codex', { force: true });
			await container.services.agents.refreshLogin('claude', { force: true });
			await container.services.agents.refreshLogin('grok', { force: true });
			await container.services.agents.refreshLogin('pi', {
				force: true,
				providers: ['openai', 'anthropic'],
				defaultProvider: 'openai',
			});

			const agentsRes = await server.instance.inject({
				method: 'GET',
				url: '/api/v1/agents',
				headers: { authorization: authToken },
			});
			expect(agentsRes.statusCode).toBe(200);
			const agentsBody = JSON.parse(agentsRes.body) as ListAgentsResponse;
			const agentMap = new Map(agentsBody.agents.map((a) => [a.id, a]));

			expect(agentMap.get('codex')?.login?.state).toBe('logged_in');
			expect(agentMap.get('claude')?.login?.state).toBe('logged_out');
			expect(agentMap.get('grok')?.login?.state).toBe('logged_in');
			expect(agentMap.get('pi')?.login?.state).toBe('logged_in');
			expect(agentMap.get('dsh')?.login).toBeNull();

			// Claude is logged_out, but dispatch must NOT be blocked (decision 108, E-336)
			const postClaudeRunRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/runs',
				headers: { authorization: authToken },
				payload: {
					taskId: 'task-1',
					agentId: 'claude',
					idempotencyKey: 'idemp-claude-test',
				},
			});
			expect(postClaudeRunRes.statusCode).toBe(200);
			const postClaudeRunBody = JSON.parse(postClaudeRunRes.body) as CreateRunResponse;
			expect(postClaudeRunBody.run.agentId).toBe('claude');

			// =========================================================================
			// ② GET /agents/codex/models launches app-server, isComplete:true, effort={vendor:'xhigh'}
			// =========================================================================
			const modelsRes1 = await server.instance.inject({
				method: 'GET',
				url: '/api/v1/agents/codex/models',
				headers: { authorization: authToken },
			});
			expect(modelsRes1.statusCode).toBe(200);
			const modelsBody1 = JSON.parse(modelsRes1.body) as ListAgentModelsResponse;
			expect(modelsBody1.isComplete).toBe(true);
			expect(modelsBody1.currentConfig.effort).toEqual({ vendor: 'xhigh' });
			const astraModel = modelsBody1.models.find((m) => m.name === 'gpt-6-astra');
			expect(astraModel).toBeDefined();
			expect(astraModel?.isCurrentConfig).toBe(true);
			expect(appServerSpawnCount).toBe(1);

			// =========================================================================
			// ③ ?refresh=1 restarts process, two concurrent calls spawn only one process
			// =========================================================================
			const [refreshRes1, refreshRes2] = await Promise.all([
				server.instance.inject({
					method: 'GET',
					url: '/api/v1/agents/codex/models?refresh=1',
					headers: { authorization: authToken },
				}),
				server.instance.inject({
					method: 'GET',
					url: '/api/v1/agents/codex/models?refresh=1',
					headers: { authorization: authToken },
				}),
			]);
			expect(refreshRes1.statusCode).toBe(200);
			expect(refreshRes2.statusCode).toBe(200);
			// App server spawn count only increased by 1 despite 2 concurrent refresh calls
			expect(appServerSpawnCount).toBe(2);

			// =========================================================================
			// ④ Process timeout -> isComplete:false, liveFailure.reason:'timeout', HTTP 200
			// =========================================================================
			forceAppServerTimeout = true;
			const timeoutRes = await server.instance.inject({
				method: 'GET',
				url: '/api/v1/agents/codex/models?refresh=1',
				headers: { authorization: authToken },
			});
			expect(timeoutRes.statusCode).toBe(200);
			const timeoutBody = JSON.parse(timeoutRes.body) as ListAgentModelsResponse;
			expect(timeoutBody.isComplete).toBe(false);
			expect(timeoutBody.liveFailure?.reason).toBe('timeout');
			// Config and history models remain visible
			expect(timeoutBody.currentConfig).toBeDefined();
			forceAppServerTimeout = false;

			// =========================================================================
			// ⑤ PATCH /agents/codex: {defaultEffortTier:{vendor:'ultra'}} -> 400, {vendor:'xhigh'} -> 200
			// =========================================================================
			const patchInvalidEffortRes = await server.instance.inject({
				method: 'PATCH',
				url: '/api/v1/agents/codex',
				headers: { authorization: authToken },
				payload: {
					defaultEffortTier: { vendor: 'ultra' },
				},
			});
			expect(patchInvalidEffortRes.statusCode).toBe(400);

			const patchValidEffortRes = await server.instance.inject({
				method: 'PATCH',
				url: '/api/v1/agents/codex',
				headers: { authorization: authToken },
				payload: {
					defaultEffortTier: { vendor: 'xhigh' },
				},
			});
			expect(patchValidEffortRes.statusCode).toBe(200);

			// =========================================================================
			// ⑥ POST /runs records assignment_json with correct shape
			// =========================================================================
			const postRunRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/runs',
				headers: { authorization: authToken },
				payload: {
					taskId: 'task-2',
					agentId: 'codex',
					model: 'gpt-5-codex',
					effort: { tier: 'high' },
					idempotencyKey: 'idemp-run-6',
				},
			});
			expect(postRunRes.statusCode).toBe(200);
			const run6 = JSON.parse(postRunRes.body).run;

			const run6InDb = db.prepare('SELECT * FROM runs WHERE id = ?').get(run6.id) as Record<
				string,
				unknown
			>;
			expect(run6InDb).toBeDefined();
			const snapRow = db
				.prepare('SELECT * FROM dispatch_snapshots WHERE id = ?')
				.get(run6InDb.snapshot_id as string) as Record<string, unknown>;
			expect(snapRow).toBeDefined();
			expect(snapRow.assignment_json).toBeDefined();
			const parsedSnap = JSON.parse(snapRow.assignment_json as string);
			expect(parsedSnap).toEqual(
				expect.objectContaining({
					agentId: 'codex',
					modelName: 'gpt-5-codex',
					effortTier: 'high',
					effortVendor: null,
					source: 'task',
					followedTaskId: null,
				}),
			);
			expect(typeof parsedSnap.capturedAt).toBe('string');

			// =========================================================================
			// ⑦ Fake process zero-output exit -> gate context, awaiting_human, rerun & decide(reject)
			// =========================================================================
			// Attach fake process to run6 that emits no content and exits
			// Transition run6 to running state before exiting
			db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(run6.id);

			let exitCallback: ((res: ProcessExitResult) => void) | undefined;
			const mockProc: ManagedProcess = {
				...createEmptyManagedProcess({
					runId: run6.id,
					file: 'node',
					args: [],
					cwd: testDir,
				}),
				pid: 9999,
				get stderrTail() {
					return 'Fatal launch error\nsk-ant-api03-secret12345';
				},
				get stderrTailLines() {
					return ['Fatal launch error', 'sk-ant-api03-secret12345'];
				},
				onExit: (fn: (res: ProcessExitResult) => void) => {
					exitCallback = fn;
					return () => undefined;
				},
			};

			const controller = container.services.run.attachProcess(run6.id, mockProc);
			exitCallback?.({
				runId: run6.id,
				pid: 9999,
				exitCode: 1,
				signal: null,
				reason: 'exited',
			});
			await controller.waitForCompletion();

			// Pending gates check
			const gatesRes = await server.instance.inject({
				method: 'GET',
				url: '/api/v1/gates?pending=true',
				headers: { authorization: authToken },
			});
			expect(gatesRes.statusCode).toBe(200);
			const gatesBody = JSON.parse(gatesRes.body) as ListGatesResponse;
			const zeroGate = gatesBody.gates.find((g) => g.comment === 'exited_before_output');
			expect(zeroGate).toBeDefined();
			expect(zeroGate?.context).toBeDefined();
			expect(zeroGate?.context?.exitCode).toBe(1);
			expect(zeroGate?.context?.stderrTail).toBeDefined();
			const lines = (zeroGate?.context?.stderrTail as { lines?: string[] })?.lines;
			expect(Array.isArray(lines)).toBe(true);
			expect(lines?.length).toBeLessThanOrEqual(20);
			expect(zeroGate?.context?.login).not.toBeNull();

			// Task is awaiting_human
			const runRow = db.prepare('SELECT * FROM runs WHERE id = ?').get(run6.id) as Record<
				string,
				unknown
			>;
			expect(runRow.state).toBe('awaiting_human');

			// POST /runs/:id/rerun on zero-output awaiting_human run is permitted and supersedes gate
			const rerunRes = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/runs/${run6.id}/rerun`,
				headers: { authorization: authToken },
				payload: {
					idempotencyKey: 'idemp-rerun-7',
				},
			});
			expect(rerunRes.statusCode).toBe(200);
			const rerunRun = (JSON.parse(rerunRes.body) as RerunRunResponse).run;
			const rerunInDb = db.prepare('SELECT * FROM runs WHERE id = ?').get(rerunRun.id) as Record<
				string,
				unknown
			>;
			expect(rerunInDb.snapshot_id).toBe(run6InDb.snapshot_id);

			// Gate was superseded
			const gateAfterRerun = db
				.prepare('SELECT * FROM gates WHERE id = ?')
				.get(zeroGate?.id) as Record<string, unknown>;
			expect(gateAfterRerun.state).toBe('decided');

			// Now test zero-output exit on rerun run, then decide{reject} sets run state to failed
			db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(rerunRun.id);
			let rejectExitCallback: ((res: ProcessExitResult) => void) | undefined;
			const rejectProc: ManagedProcess = {
				...createEmptyManagedProcess({
					runId: rerunRun.id,
					file: 'node',
					args: [],
					cwd: testDir,
				}),
				pid: 9998,
				get stderrTail() {
					return 'Second zero output error';
				},
				get stderrTailLines() {
					return ['Second zero output error'];
				},
				onExit: (fn: (res: ProcessExitResult) => void) => {
					rejectExitCallback = fn;
					return () => undefined;
				},
			};
			const rejectController = container.services.run.attachProcess(rerunRun.id, rejectProc);
			rejectExitCallback?.({
				runId: rerunRun.id,
				pid: 9998,
				exitCode: 1,
				signal: null,
				reason: 'exited',
			});
			await rejectController.waitForCompletion();

			const pendingGatesAfterSecondExit = await server.instance.inject({
				method: 'GET',
				url: '/api/v1/gates?pending=true',
				headers: { authorization: authToken },
			});
			const secondGatesBody = JSON.parse(pendingGatesAfterSecondExit.body) as ListGatesResponse;
			const secondZeroGate = secondGatesBody.gates.find((g) => g.runId === rerunRun.id);
			expect(secondZeroGate).toBeDefined();

			const decideRes = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/gates/${secondZeroGate?.id}/decide`,
				headers: { authorization: authToken },
				payload: {
					decision: 'reject',
					comment: 'human marked failed',
				},
			});
			expect(decideRes.statusCode).toBe(200);
			const runAfterReject = db
				.prepare('SELECT * FROM runs WHERE id = ?')
				.get(rerunRun.id) as Record<string, unknown>;
			expect(runAfterReject.state).toBe('failed');

			// =========================================================================
			// ⑧ Cross-family reviewOverride creates child snapshot; RunDto.followedTaskId
			// =========================================================================
			// 1. Create task run with effort {tier: 'high'}
			const run8Res = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/runs',
				headers: { authorization: authToken },
				payload: {
					taskId: 'task-3',
					agentId: 'codex',
					effort: { tier: 'high' },
					idempotencyKey: 'idemp-run-8',
				},
			});
			expect(run8Res.statusCode).toBe(200);
			const run8 = JSON.parse(run8Res.body).run;

			// 2. PATCH /settings/pipeline set reviewOverride to claude (cross-family)
			const patchPipelineRes = await server.instance.inject({
				method: 'PATCH',
				url: '/api/v1/settings/pipeline',
				headers: { authorization: authToken },
				payload: {
					bughunt: 0,
					wrapupMode: 'auto',
					reviewOverride: { agentId: 'claude', modelName: null },
					wrapupAssignment: { mode: 'follow' },
				},
			});
			expect(patchPipelineRes.statusCode).toBe(200);

			// Set worktree_path and exited state so review evaluation can proceed
			db.prepare("UPDATE runs SET state = 'exited', worktree_path = ? WHERE id = ?").run(
				gitRepoDir,
				run8.id,
			);

			// Trigger review evaluation (spawns review run with cross-family reviewOverride)
			const evalResult = await container.services.review.evaluateMechanicalCheck({
				runId: run8.id,
				taskId: 'task-3',
				worktreePath: gitRepoDir,
				hasFatalError: false,
				exitCode: 0,
				diffStat: {
					filesChanged: 1,
					changedFileCount: 1,
					insertions: 10,
					deletions: 0,
					hasChanges: true,
					baseline: 'HEAD~1',
					files: [{ path: 'file', insertions: 10, deletions: 0, status: 'modified' as const }],
				},
				diffText: 'diff --git a/file b/file\n+new line\n',
			});

			const reviewRun = db
				.prepare('SELECT * FROM runs WHERE task_id = ? AND kind = ?')
				.get('task-3', 'review') as Record<string, unknown>;
			expect(reviewRun).toBeDefined();
			expect(reviewRun.agent_id).toBe('claude');
			expect(reviewRun.effort_tier).toBe('high');

			const childSnap = db
				.prepare('SELECT * FROM dispatch_snapshots WHERE id = ?')
				.get(reviewRun.snapshot_id as string) as Record<string, unknown>;
			expect(childSnap).toBeDefined();
			const implRunInDb = db.prepare('SELECT * FROM runs WHERE id = ?').get(run8.id) as Record<
				string,
				unknown
			>;
			expect(childSnap.parent_snapshot_id).toBe(implRunInDb.snapshot_id);
			const parentSnap = db
				.prepare('SELECT * FROM dispatch_snapshots WHERE id = ?')
				.get(implRunInDb.snapshot_id as string) as Record<string, unknown>;
			expect(childSnap.assignment_json).toBe(parentSnap.assignment_json);

			// Mark run8 and task-3 landed & in HEAD so follow mode can find landed run
			db.prepare(
				"UPDATE runs SET state = 'landed', is_in_head = 1, ended_at = '2026-09-17T13:00:00.000Z' WHERE id = ?",
			).run(run8.id);
			db.prepare("UPDATE tasks SET manual_state = 'landed' WHERE id = 'task-3'").run();

			// Also ensure all other tasks and runs in batch-1 are landed & in HEAD before wrapup
			db.prepare("UPDATE tasks SET manual_state = 'landed' WHERE batch_id = 'batch-1'").run();
			db.prepare(
				"UPDATE runs SET state = 'landed', is_in_head = 1 WHERE task_id IN ('task-1', 'task-2', 'task-3')",
			).run();

			// Also trigger wrapup in follow mode
			const wrapupRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/batches/batch-1/wrapup',
				headers: { authorization: authToken },
				payload: {
					idempotencyKey: 'idemp-wrapup-8',
				},
			});
			expect(wrapupRes.statusCode).toBe(200);
			const wrapupRun = JSON.parse(wrapupRes.body).run;

			// Check GET /runs followedTaskId
			const listRunsRes = await server.instance.inject({
				method: 'GET',
				url: '/api/v1/runs',
				headers: { authorization: authToken },
			});
			expect(listRunsRes.statusCode).toBe(200);
			const allRuns = (JSON.parse(listRunsRes.body) as ListRunsResponse).runs;

			const implRunDto = allRuns.find((r) => r.id === run8.id);
			const wrapupRunDto = allRuns.find((r) => r.id === wrapupRun.id);

			expect(implRunDto?.followedTaskId).toBeNull();
			expect(wrapupRunDto?.followedTaskId).toBe('task-3');

			// Wait for in-flight log writes to settle
			await new Promise((r) => setTimeout(r, 100));
		});
	},
);
