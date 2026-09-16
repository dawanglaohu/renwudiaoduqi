import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppContainer } from '../../src/boot/container.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { routesPlugin } from '../../src/http/plugins/50-routes.ts';
import { errorHandlerPlugin } from '../../src/http/plugins/90-error-handler.ts';
import { registerTasksRoutes } from '../../src/http/routes/tasks.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../../src/repo/documents.ts';
import { type TasksRepo, createTasksRepo } from '../../src/repo/tasks.ts';
import {
	cleanupTaskWorktree,
	createLandingService,
	generateLandingCommands,
	getTaskLanding,
} from '../../src/workspace/landing.ts';
import {
	type GitCommandResult,
	type GitRunner,
	createDefaultGitRunner,
	listWorktrees,
	prepareWorktree,
} from '../../src/workspace/worktree.ts';

const testIds = { newId: () => 'test-req-id' };

/**
 * The real-git integration case below drives the host's actual `git`, so it must declare
 * the host platform. Hardcoding 'linux' made it look for /usr/bin/git on a Windows runner.
 */
function hostPlatform(): 'win32' | 'darwin' | 'linux' {
	const platform = process.platform;
	return platform === 'win32' || platform === 'darwin' ? platform : 'linux';
}

/**
 * On Windows the fixed candidate-path list does not include `C:\Program Files\Git\cmd`,
 * so `resolveGitExecutable` can't find the system git. We resolve it via `where` once
 * at module load and pass the result as `gitBinary` to skip the candidate search.
 */
function resolveHostGitBinary(): string | undefined {
	try {
		const cmd = process.platform === 'win32' ? 'where' : 'which';
		return execFileSync(cmd, ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
	} catch {
		return undefined;
	}
}

function createMockGitRunner(
	handler: (args: readonly string[], cwd: string) => GitCommandResult | Promise<GitCommandResult>,
): GitRunner {
	return {
		run: (args, cwd) => Promise.resolve(handler(args, cwd)),
	};
}

describe('M5-T4 Landing Checklist and Worktree Disposal (E-73, E-74, Decision 68)', () => {
	let db: DatabaseConnection;
	let tasksRepo: TasksRepo;
	let documentsRepo: DocumentsRepo;
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'landing-test-'));
		db = openDatabase(':memory:');

		// Set up tables
		db.exec(`
			CREATE TABLE documents (
				id TEXT PRIMARY KEY,
				docs_path TEXT NOT NULL UNIQUE,
				project_name TEXT NOT NULL,
				repo_path TEXT,
				main_branch TEXT NOT NULL DEFAULT 'main',
				branch_prefix TEXT NOT NULL DEFAULT 'task/',
				lane_count INTEGER NOT NULL DEFAULT 2,
				content_fingerprint TEXT NOT NULL,
				is_source_readable INTEGER NOT NULL DEFAULT 1,
				is_takeover_notified INTEGER NOT NULL DEFAULT 0,
				imported_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL
			);

			CREATE TABLE batches (
				id TEXT PRIMARY KEY,
				doc_id TEXT NOT NULL REFERENCES documents(id),
				batch_no INTEGER NOT NULL,
				state TEXT NOT NULL DEFAULT 'idle',
				started_at TEXT,
				finished_at TEXT,
				UNIQUE (doc_id, batch_no)
			);

			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				doc_id TEXT NOT NULL REFERENCES documents(id),
				task_key TEXT NOT NULL,
				title TEXT NOT NULL,
				module_key TEXT NOT NULL,
				deps_json TEXT NOT NULL DEFAULT '[]',
				input_text TEXT,
				output_text TEXT,
				accept_text TEXT,
				edge_ids_json TEXT,
				task_paths_json TEXT,
				contract_hash TEXT NOT NULL,
				is_contract_ready INTEGER NOT NULL DEFAULT 1,
				contract_reasons_json TEXT NOT NULL DEFAULT '[]',
				est_days REAL,
				batch_id TEXT REFERENCES batches(id),
				impl_prompt TEXT,
				review_prompt TEXT,
				is_removed_from_doc INTEGER NOT NULL DEFAULT 0,
				has_accept_changed INTEGER NOT NULL DEFAULT 0,
				has_prompt_changed INTEGER NOT NULL DEFAULT 0,
				manual_state TEXT,
				bug_prompt TEXT,
				UNIQUE (doc_id, task_key)
			);
		`);

		tasksRepo = createTasksRepo(db);
		documentsRepo = createDocumentsRepo(db);

		// Seed a document and a task
		documentsRepo.insert({
			id: 'doc-1',
			docs_path: 'docs/Agent任务调度器-开发文档',
			project_name: 'Agent 任务调度器',
			repo_path: tempDir,
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: 'fp-12345',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: '2026-09-14T12:00:00.000Z',
			last_seen_at: '2026-09-14T12:00:00.000Z',
		});

		tasksRepo.insert({
			id: 'task-uuid-m5-t4',
			doc_id: 'doc-1',
			task_key: 'M5-T4',
			title: '落地清单与 worktree 处置',
			module_key: 'M5',
			deps_json: JSON.stringify(['M5-T3']),
			contract_hash: 'hash-m5-t4',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
		});
	});

	afterEach(() => {
		try {
			db.close();
		} catch {}
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	describe('generateLandingCommands (AC 1, E-74, Decision 68)', () => {
		it('generates copyable gh stack command and build_docs.py landed command with docsPath', () => {
			const commands = generateLandingCommands({
				docsPath: 'docs/Agent任务调度器-开发文档',
				taskId: 'M5-T4',
			});

			expect(commands).toHaveLength(2);
			expect(commands[0]).toBe('gh stack push');
			expect(commands[1]).toBe(
				'python docs/Agent任务调度器-开发文档/_run/build_docs.py docs/Agent任务调度器-开发文档 --landed M5-T4',
			);
			expect(Object.isFrozen(commands)).toBe(true);
		});

		it('normalizes Windows backslashes in docsPath to forward slashes for cross-platform execution', () => {
			const commands = generateLandingCommands({
				docsPath: 'docs\\Agent任务调度器-开发文档',
				taskId: 'M1-T1',
			});

			expect(commands[1]).toBe(
				'python docs/Agent任务调度器-开发文档/_run/build_docs.py docs/Agent任务调度器-开发文档 --landed M1-T1',
			);
		});

		it('allows custom gh stack command text such as gh stack merge', () => {
			const commands = generateLandingCommands({
				docsPath: 'docs/my-project',
				taskId: 'M2-T5',
				ghStackCommand: 'gh stack merge --yes --merge',
			});

			expect(commands[0]).toBe('gh stack merge --yes --merge');
			expect(commands[1]).toBe(
				'python docs/my-project/_run/build_docs.py docs/my-project --landed M2-T5',
			);
		});
	});

	describe('getTaskLanding (AC 1, AC 3, E-74)', () => {
		it('AC 1 & E-74: outputs worktree absolute path, branch name, diff stat, and copyable commands', async () => {
			// Create a dummy worktree directory in tempDir
			const worktreeDir = join(tempDir, 'repo-m5-t4');
			mkdirSync(worktreeDir, { recursive: true });

			const runner = createMockGitRunner((args) => {
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: `worktree ${tempDir}\nHEAD 111\nbranch refs/heads/main\n\nworktree ${worktreeDir}\nHEAD 222\nbranch refs/heads/task/M5-T4`,
						stderr: '',
					};
				}
				if (args[0] === 'diff' && args.includes('--numstat')) {
					return {
						exitCode: 0,
						stdout: '12\t3\tsrc/landing.ts\n5\t0\tsrc/tasks.ts',
						stderr: '',
					};
				}
				if (args[0] === 'diff' && args.includes('--name-status')) {
					return {
						exitCode: 0,
						stdout: 'M\tsrc/landing.ts\nA\tsrc/tasks.ts',
						stderr: '',
					};
				}
				if (args[0] === 'status' && args.includes('--porcelain')) {
					return {
						exitCode: 0,
						stdout: ' M src/landing.ts\nA  src/tasks.ts',
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const landing = await getTaskLanding(
				{ taskId: 'M5-T4' },
				{
					tasksRepo,
					documentsRepo,
					runner,
					repoPath: tempDir,
					ids: testIds,
				},
			);

			// 1. Worktree absolute path
			expect(isAbsolute(landing.worktreePath)).toBe(true);
			expect(landing.worktreePath).toBe(resolve(worktreeDir));

			// 2. Branch name
			expect(landing.branchName).toBe('task/M5-T4');

			// 3. Diff stat summary
			expect(landing.diffStat.filesChanged).toBe(2);
			expect(landing.diffStat.insertions).toBe(17);
			expect(landing.diffStat.deletions).toBe(3);

			// 4. Copyable commands
			expect(landing.commands).toHaveLength(2);
			expect(landing.commands[0]).toBe('gh stack push');
			expect(landing.commands[1]).toBe(
				'python docs/Agent任务调度器-开发文档/_run/build_docs.py docs/Agent任务调度器-开发文档 --landed M5-T4',
			);

			// Frozen response
			expect(Object.isFrozen(landing)).toBe(true);
			expect(Object.isFrozen(landing.diffStat)).toBe(true);
			expect(Object.isFrozen(landing.commands)).toBe(true);
		});

		it('AC 1: retrieves docsPath from document record and supports task UUID lookup', async () => {
			const worktreeDir = join(tempDir, 'repo-m5-t4');
			mkdirSync(worktreeDir, { recursive: true });

			const runner = createMockGitRunner((args) => {
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: `worktree ${tempDir}\nHEAD 111\nbranch refs/heads/main\n\nworktree ${worktreeDir}\nHEAD 222\nbranch refs/heads/task/M5-T4`,
						stderr: '',
					};
				}
				if (args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
				if (args[0] === 'diff') return { exitCode: 0, stdout: '', stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			// Look up via task UUID 'task-uuid-m5-t4'
			const landing = await getTaskLanding(
				{ taskId: 'task-uuid-m5-t4' },
				{
					tasksRepo,
					documentsRepo,
					runner,
					repoPath: tempDir,
					ids: testIds,
				},
			);

			// Task key in command should be 'M5-T4', docsPath should be 'docs/Agent任务调度器-开发文档'
			expect(landing.branchName).toBe('task/M5-T4');
			expect(landing.commands[1]).toBe(
				'python docs/Agent任务调度器-开发文档/_run/build_docs.py docs/Agent任务调度器-开发文档 --landed M5-T4',
			);
		});

		it('AC 3: is strictly read-only and never runs git commit, push, PR merge, or python maintenance scripts', async () => {
			const executedCommands: string[][] = [];
			const worktreeDir = join(tempDir, 'repo-m5-t4');
			mkdirSync(worktreeDir, { recursive: true });

			const runner = createMockGitRunner((args) => {
				executedCommands.push([...args]);
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: `worktree ${tempDir}\nHEAD 111\nbranch refs/heads/main\n\nworktree ${worktreeDir}\nHEAD 222\nbranch refs/heads/task/M5-T4`,
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			await getTaskLanding(
				{ taskId: 'M5-T4' },
				{
					tasksRepo,
					documentsRepo,
					runner,
					repoPath: tempDir,
					ids: testIds,
				},
			);

			// Assert no write/mutation commands occurred
			for (const cmd of executedCommands) {
				expect(cmd).not.toContain('commit');
				expect(cmd).not.toContain('push');
				expect(cmd).not.toContain('merge');
				expect(cmd).not.toContain('pull');
				expect(cmd).not.toContain('rebase');
			}
		});

		it('AC 2 & E-73: throws E_NOT_FOUND when worktree directory does not exist on disk', async () => {
			// Worktree directory NOT created on disk
			const runner = createMockGitRunner(() => ({ exitCode: 0, stdout: '', stderr: '' }));

			await expect(
				getTaskLanding(
					{ taskId: 'M5-T4' },
					{
						tasksRepo,
						documentsRepo,
						runner,
						repoPath: tempDir,
						ids: testIds,
					},
				),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'E_NOT_FOUND',
				}),
			);
		});

		it('throws E_NOT_FOUND when task does not exist', async () => {
			const runner = createMockGitRunner(() => ({ exitCode: 0, stdout: '', stderr: '' }));

			await expect(
				getTaskLanding(
					{ taskId: 'M99-T99' },
					{
						tasksRepo,
						documentsRepo,
						runner,
						repoPath: tempDir,
						ids: testIds,
					},
				),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'E_NOT_FOUND',
				}),
			);
		});

		it('throws E_VALIDATION when taskId is empty', async () => {
			await expect(getTaskLanding({ taskId: '   ' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'E_VALIDATION',
				}),
			);
		});
	});

	describe('cleanupTaskWorktree (AC 2, E-73)', () => {
		it('AC 2 & E-73: executes git worktree remove and prune on explicit cleanup, returning { removed: true }', async () => {
			const executedCommands: string[][] = [];
			const worktreeDir = join(tempDir, 'repo-m5-t4');
			mkdirSync(worktreeDir, { recursive: true });

			const runner = createMockGitRunner((args) => {
				executedCommands.push([...args]);
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: `worktree ${tempDir}\nHEAD 111\nbranch refs/heads/main\n\nworktree ${worktreeDir}\nHEAD 222\nbranch refs/heads/task/M5-T4`,
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await cleanupTaskWorktree(
				{ taskId: 'M5-T4' },
				{
					tasksRepo,
					documentsRepo,
					runner,
					repoPath: tempDir,
					ids: testIds,
				},
			);

			expect(result.removed).toBe(true);

			// Assert worktree remove was called with resolve(worktreeDir)
			expect(executedCommands).toContainEqual([
				'worktree',
				'remove',
				'--force',
				resolve(worktreeDir),
			]);
			expect(executedCommands).toContainEqual(['worktree', 'prune']);

			// Assert git branch was NOT deleted (deleteBranch: false by default for E-73)
			expect(executedCommands.some((c) => c[0] === 'branch' && c[1] === '-D')).toBe(false);
		});

		it('AC 2 & E-73: is idempotent when worktree is already missing from list', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: `worktree ${tempDir}\nHEAD 111\nbranch refs/heads/main`,
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await cleanupTaskWorktree(
				{ taskId: 'M5-T4' },
				{
					tasksRepo,
					documentsRepo,
					runner,
					repoPath: tempDir,
					ids: testIds,
				},
			);

			expect(result.removed).toBe(true);
		});

		it('throws E_NOT_FOUND when task does not exist during cleanup', async () => {
			const runner = createMockGitRunner(() => ({ exitCode: 0, stdout: '', stderr: '' }));

			await expect(
				cleanupTaskWorktree(
					{ taskId: 'NONEXISTENT' },
					{
						tasksRepo,
						documentsRepo,
						runner,
						repoPath: tempDir,
						ids: testIds,
					},
				),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'E_NOT_FOUND',
				}),
			);
		});
	});

	describe('createLandingService factory', () => {
		it('creates a service exposing getLanding, cleanupWorktree, and generateLandingCommands', async () => {
			const worktreeDir = join(tempDir, 'repo-m5-t4');
			mkdirSync(worktreeDir, { recursive: true });

			const runner = createMockGitRunner((args) => {
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: `worktree ${tempDir}\nHEAD 111\nbranch refs/heads/main\n\nworktree ${worktreeDir}\nHEAD 222\nbranch refs/heads/task/M5-T4`,
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const service = createLandingService({
				tasksRepo,
				documentsRepo,
				runner,
				repoPath: tempDir,
				ids: testIds,
			});

			const landing = await service.getLanding({ taskId: 'M5-T4' });
			expect(landing.branchName).toBe('task/M5-T4');
			expect(landing.commands).toHaveLength(2);

			const cleanup = await service.cleanupWorktree({ taskId: 'M5-T4' });
			expect(cleanup.removed).toBe(true);

			const cmds = service.generateLandingCommands({
				docsPath: 'docs',
				taskId: 'M1-T1',
			});
			expect(cmds).toHaveLength(2);
		});
	});

	describe('HTTP Routes (packages/daemon/src/http/routes/tasks.ts)', () => {
		let app: FastifyInstance;

		beforeEach(async () => {
			app = fastify();
			await errorHandlerPlugin(app, {});
		});

		afterEach(async () => {
			await app.close();
		});

		it('GET /api/v1/tasks/:taskId/landing returns 200 with landing checklist', async () => {
			const worktreeDir = join(tempDir, 'repo-m5-t4');
			mkdirSync(worktreeDir, { recursive: true });

			const runner = createMockGitRunner((args) => {
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: `worktree ${tempDir}\nHEAD 111\nbranch refs/heads/main\n\nworktree ${worktreeDir}\nHEAD 222\nbranch refs/heads/task/M5-T4`,
						stderr: '',
					};
				}
				if (args[0] === 'diff' && args.includes('--numstat')) {
					return {
						exitCode: 0,
						stdout: '10\t2\tfile.ts',
						stderr: '',
					};
				}
				if (args[0] === 'diff' && args.includes('--name-status')) {
					return {
						exitCode: 0,
						stdout: 'M\tfile.ts',
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			registerTasksRoutes(app, {
				landingService: createLandingService({
					tasksRepo,
					documentsRepo,
					runner,
					repoPath: tempDir,
					docsPath: 'docs/Agent任务调度器-开发文档',
					ids: testIds,
				}),
			});

			const res = await app.inject({
				method: 'GET',
				url: '/api/v1/tasks/M5-T4/landing',
			});

			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.worktreePath).toBe(resolve(worktreeDir));
			expect(body.branchName).toBe('task/M5-T4');
			expect(body.diffStat).toEqual({
				filesChanged: 1,
				insertions: 10,
				deletions: 2,
			});
			expect(body.commands).toEqual([
				'gh stack push',
				'python docs/Agent任务调度器-开发文档/_run/build_docs.py docs/Agent任务调度器-开发文档 --landed M5-T4',
			]);
		});

		it('GET /api/v1/tasks/:taskId/landing returns 404 when task not found', async () => {
			const runner = createMockGitRunner(() => ({ exitCode: 0, stdout: '', stderr: '' }));

			registerTasksRoutes(app, {
				landingService: createLandingService({
					tasksRepo,
					documentsRepo,
					runner,
					repoPath: tempDir,
					ids: testIds,
				}),
			});

			const res = await app.inject({
				method: 'GET',
				url: '/api/v1/tasks/M99-T99/landing',
			});

			expect(res.statusCode).toBe(404);
			const body = JSON.parse(res.body);
			expect(body.error.code).toBe('E_NOT_FOUND');
		});

		it('GET /api/v1/tasks/:taskId/landing returns 404 when worktree does not exist', async () => {
			const runner = createMockGitRunner(() => ({ exitCode: 0, stdout: '', stderr: '' }));

			registerTasksRoutes(app, {
				landingService: createLandingService({
					tasksRepo,
					documentsRepo,
					runner,
					repoPath: tempDir,
					ids: testIds,
				}),
			});

			const res = await app.inject({
				method: 'GET',
				url: '/api/v1/tasks/M5-T4/landing',
			});

			expect(res.statusCode).toBe(404);
			const body = JSON.parse(res.body);
			expect(body.error.code).toBe('E_NOT_FOUND');
		});

		it('POST /api/v1/tasks/:taskId/worktree/cleanup returns 200 with { removed: true }', async () => {
			const worktreeDir = join(tempDir, 'repo-m5-t4');
			mkdirSync(worktreeDir, { recursive: true });

			const runner = createMockGitRunner((args) => {
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: `worktree ${tempDir}\nHEAD 111\nbranch refs/heads/main\n\nworktree ${worktreeDir}\nHEAD 222\nbranch refs/heads/task/M5-T4`,
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			registerTasksRoutes(app, {
				landingService: createLandingService({
					tasksRepo,
					documentsRepo,
					runner,
					repoPath: tempDir,
					ids: testIds,
				}),
			});

			const res = await app.inject({
				method: 'POST',
				url: '/api/v1/tasks/M5-T4/worktree/cleanup',
			});

			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.removed).toBe(true);
		});

		it('POST /api/v1/tasks/:taskId/worktree/cleanup returns 404 when task not found', async () => {
			const runner = createMockGitRunner(() => ({ exitCode: 0, stdout: '', stderr: '' }));

			registerTasksRoutes(app, {
				landingService: createLandingService({
					tasksRepo,
					documentsRepo,
					runner,
					repoPath: tempDir,
					ids: testIds,
				}),
			});

			const res = await app.inject({
				method: 'POST',
				url: '/api/v1/tasks/UNKNOWN/worktree/cleanup',
			});

			expect(res.statusCode).toBe(404);
			const body = JSON.parse(res.body);
			expect(body.error.code).toBe('E_NOT_FOUND');
		});
	});

	describe('HTTP wiring through the routes plugin', () => {
		it('serves the landing route from the registered handler, not the not-implemented stub', async () => {
			const worktreeDir = join(tempDir, 'repo-m5-t4');
			mkdirSync(worktreeDir, { recursive: true });

			const runner = createMockGitRunner((args) => {
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: `worktree ${tempDir}\nHEAD 111\nbranch refs/heads/main\n\nworktree ${worktreeDir}\nHEAD 222\nbranch refs/heads/task/M5-T4`,
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const app = fastify();
			app.decorate('container', {
				services: {
					landing: createLandingService({
						tasksRepo,
						documentsRepo,
						runner,
						repoPath: tempDir,
						docsPath: 'docs/Agent任务调度器-开发文档',
						ids: testIds,
					}),
				},
			} as unknown as AppContainer);
			await app.register(routesPlugin, { prefix: '/api/v1' });
			await app.ready();

			const res = await app.inject({
				method: 'GET',
				url: '/api/v1/tasks/M5-T4/landing',
			});

			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.branchName).toBe('task/M5-T4');
			expect(body.commands).toHaveLength(2);

			await app.close();
		});
	});

	describe('Real Git Repository Integration (E-73, E-74 lifecycle)', () => {
		it('full lifecycle: prepare worktree -> inspect landing diff & commands -> explicit cleanup -> retry rebuilds worktree (E-73, E-74)', async () => {
			// This case runs the host's real `git`, so it must be told the host platform —
			// passing 'linux' made it look for /usr/bin/git on a Windows runner.
			const gitRunner = createDefaultGitRunner({
				platform: hostPlatform(),
				gitBinary: resolveHostGitBinary(),
				ids: testIds,
			});

			const realRepoDir = join(tempDir, 'real-repo');
			mkdirSync(realRepoDir, { recursive: true });

			// Initialize real git repo
			await gitRunner.run(['init'], realRepoDir);
			await gitRunner.run(['config', 'user.name', 'test'], realRepoDir);
			await gitRunner.run(['config', 'user.email', 'test@example.com'], realRepoDir);

			writeFileSync(join(realRepoDir, 'README.md'), '# Test Repo\n', 'utf-8');
			await gitRunner.run(['add', 'README.md'], realRepoDir);
			await gitRunner.run(['commit', '-m', 'initial commit'], realRepoDir);

			// Register document in DB pointing to real repo
			documentsRepo.insert({
				id: 'doc-real',
				docs_path: 'docs/real-repo-docs',
				project_name: 'Real Repo Integration',
				repo_path: realRepoDir,
				main_branch: 'main',
				branch_prefix: 'task/',
				lane_count: 2,
				content_fingerprint: 'fp-real',
				is_source_readable: 1,
				is_takeover_notified: 0,
				imported_at: '2026-09-14T12:00:00.000Z',
				last_seen_at: '2026-09-14T12:00:00.000Z',
			});

			tasksRepo.insert({
				id: 'task-real-1',
				doc_id: 'doc-real',
				task_key: 'M5-T4',
				title: 'Landing Integration',
				module_key: 'M5',
				deps_json: '[]',
				contract_hash: 'hash-real',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
			});

			// 1. Prepare worktree for task (M5-T1)
			const prepResult = await prepareWorktree(
				{
					repoPath: realRepoDir,
					taskId: 'M5-T4',
				},
				gitRunner,
				{
					platform: hostPlatform(),
					ids: testIds,
					gitRunner,
				},
			);

			expect(existsSync(prepResult.worktreePath)).toBe(true);
			expect(prepResult.branchName).toBe('task/M5-T4');

			// Make some changes in worktree (M5-T3 diff target)
			writeFileSync(
				join(prepResult.worktreePath, 'new-file.ts'),
				'export const a = 1;\nexport const b = 2;\n',
				'utf-8',
			);

			// 2. AC 1 & E-74: Landing checklist output
			const landing = await getTaskLanding(
				{ taskId: 'task-real-1' },
				{
					tasksRepo,
					documentsRepo,
					runner: gitRunner,
					repoPath: realRepoDir,
					ids: testIds,
				},
			);

			// macOS reports the mkdtemp path as /var/folders/… while git and the landing
			// service resolve the same directory through /private/var/…; compare real paths.
			expect(landing.worktreePath).toBe(realpathSync(prepResult.worktreePath));
			expect(landing.branchName).toBe('task/M5-T4');
			expect(landing.diffStat.filesChanged).toBe(1);
			expect(landing.diffStat.insertions).toBe(2);
			expect(landing.diffStat.deletions).toBe(0);
			expect(landing.commands).toEqual([
				'gh stack push',
				'python docs/real-repo-docs/_run/build_docs.py docs/real-repo-docs --landed M5-T4',
			]);

			// AC 2 & E-73: Worktree default retention: still exists on disk
			expect(existsSync(prepResult.worktreePath)).toBe(true);

			// 3. AC 2 & E-73: Explicit user cleanup removes worktree
			const cleanupResult = await cleanupTaskWorktree(
				{ taskId: 'task-real-1' },
				{
					tasksRepo,
					documentsRepo,
					runner: gitRunner,
					repoPath: realRepoDir,
					ids: testIds,
				},
			);

			expect(cleanupResult.removed).toBe(true);

			// Worktree directory is removed from disk and git worktree list
			expect(existsSync(prepResult.worktreePath)).toBe(false);
			const worktreesAfter = await listWorktrees(realRepoDir, gitRunner);
			expect(worktreesAfter.some((wt) => wt.path === prepResult.worktreePath)).toBe(false);

			// After cleanup, landing returns E_NOT_FOUND
			await expect(
				getTaskLanding(
					{ taskId: 'task-real-1' },
					{
						tasksRepo,
						documentsRepo,
						runner: gitRunner,
						repoPath: realRepoDir,
						ids: testIds,
					},
				),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'E_NOT_FOUND',
				}),
			);

			// 4. E-73: Retrying rebuilds the worktree (branch name increments to -2 due to branch retention E-71)
			const retryPrep = await prepareWorktree(
				{
					repoPath: realRepoDir,
					taskId: 'M5-T4',
				},
				gitRunner,
				{
					platform: hostPlatform(),
					ids: testIds,
					gitRunner,
				},
			);

			expect(existsSync(retryPrep.worktreePath)).toBe(true);
			expect(retryPrep.branchName).toBe('task/M5-T4-2');
		});
	});
});
