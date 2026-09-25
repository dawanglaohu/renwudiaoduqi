import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.ts';
import type { ResolvedExecutable } from '../../src/platform/contract.ts';
import { takePlatformHostInputs } from '../../src/platform/host.ts';
import { resolveExecutable } from '../../src/platform/resolve-executable.ts';
import type {
	LaunchSpec,
	ManagedProcess,
	ProcessExitResult,
	spawnManaged,
} from '../../src/proc/spawn.ts';
import {
	type GitCommandResult,
	type GitRunner,
	type WorktreeManagerDeps,
	assertGitRepository,
	checkGitRepository,
	createDefaultGitRunner,
	createWorktreeManager,
	inspectWorktree,
	parseWorktreeListPorcelain,
	prepareWorktree,
	removeWorktree,
	resolveBranchName,
} from '../../src/workspace/worktree.ts';

const defaultTestIds = { newId: () => 'test-req-id' };

function createMockGitRunner(
	handler: (args: readonly string[], cwd: string) => GitCommandResult | Promise<GitCommandResult>,
): GitRunner {
	return {
		run: (args, cwd) => Promise.resolve(handler(args, cwd)),
	};
}

describe('M5-T1 Worktree Preparation, Branch Naming, and Reclamation', () => {
	describe('parseWorktreeListPorcelain', () => {
		it('parses standard, locked, prunable, and bare worktrees', () => {
			const output = `
worktree /repos/main
HEAD abcdef1234567890abcdef1234567890abcdef12
branch refs/heads/main

worktree /repos/task-1
HEAD 1234567890abcdef1234567890abcdef12345678
branch refs/heads/task/M1-T1
locked reason for lock

worktree /repos/task-prunable
HEAD 9876543210abcdef9876543210abcdef98765432
branch refs/heads/task/M2-T1
prunable directory missing

worktree /repos/task-detached
HEAD 1111222233334444555566667777888899990000
detached
`;
			const entries = parseWorktreeListPorcelain(output);
			expect(entries).toHaveLength(4);

			expect(entries[0]).toEqual({
				path: '/repos/main',
				head: 'abcdef1234567890abcdef1234567890abcdef12',
				branch: 'main',
				isBare: false,
				isLocked: false,
				isPrunable: false,
			});

			expect(entries[1]).toEqual({
				path: '/repos/task-1',
				head: '1234567890abcdef1234567890abcdef12345678',
				branch: 'task/M1-T1',
				isBare: false,
				isLocked: true,
				lockReason: 'reason for lock',
				isPrunable: false,
			});

			expect(entries[2]).toEqual({
				path: '/repos/task-prunable',
				head: '9876543210abcdef9876543210abcdef98765432',
				branch: 'task/M2-T1',
				isBare: false,
				isLocked: false,
				isPrunable: true,
				prunableReason: 'directory missing',
			});

			expect(entries[3]).toEqual({
				path: '/repos/task-detached',
				head: '1111222233334444555566667777888899990000',
				branch: null,
				isBare: false,
				isLocked: false,
				isPrunable: false,
			});
		});
	});

	describe('AC 2 & E-69: Target directory is not a git repository', () => {
		it('reports isGitRepo: false and requiresSerialExecution: true without silently degrading to shared parallel', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') {
					return {
						exitCode: 128,
						stdout: '',
						stderr: 'fatal: not a git repository (or any of the parent directories): .git',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const check = await checkGitRepository('/not/a/git/repo', runner);
			expect(check.isGitRepo).toBe(false);
			expect(check.requiresSerialExecution).toBe(true);
			expect(check.reason).toContain('Target directory is not a git repository');
		});

		it('assertGitRepository throws E_NOT_A_GIT_REPO with forcedSerial: true in details', async () => {
			const runner = createMockGitRunner(() => ({
				exitCode: 128,
				stdout: '',
				stderr: 'fatal: not a git repository',
			}));

			let thrown: unknown;
			try {
				await assertGitRepository('/fake/path', runner);
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeInstanceOf(AppError);
			if (thrown instanceof AppError) {
				expect(thrown.code).toBe('E_NOT_A_GIT_REPO');
				expect(thrown.details?.forcedSerial).toBe(true);
				expect(thrown.details?.reason).toBe('not-a-git-repo');
			}
		});

		it('prepareWorktree rejects non-git directory with E_NOT_A_GIT_REPO error', async () => {
			const runner = createMockGitRunner(() => ({
				exitCode: 128,
				stdout: '',
				stderr: 'fatal: not a git repository',
			}));

			const deps: WorktreeManagerDeps = {
				platform: 'linux',
				gitRunner: runner,
				ids: defaultTestIds,
			};
			await expect(
				prepareWorktree(
					{
						repoPath: '/tmp/non-git-dir',
						taskId: 'M5-T1',
					},
					runner,
					deps,
				),
			).rejects.toMatchObject({
				code: 'E_NOT_A_GIT_REPO',
				details: {
					forcedSerial: true,
					reason: 'not-a-git-repo',
				},
			});
		});
	});

	describe('AC 1 & E-71: Branch naming collision and independent worktree', () => {
		it('uses task/<taskId> when branch does not exist yet', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'for-each-ref') {
					return { exitCode: 0, stdout: 'main\nmaster', stderr: '' };
				}
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: 'worktree /repo\nHEAD 1234\nbranch refs/heads/main',
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const branch = await resolveBranchName('/repo', 'M5-T1', runner);
			expect(branch).toBe('task/M5-T1');
		});

		it('appends suffix -2 when base branch name already exists (E-71)', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'for-each-ref') {
					return { exitCode: 0, stdout: 'main\ntask/M5-T1', stderr: '' };
				}
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: 'worktree /repo\nHEAD 1234\nbranch refs/heads/main',
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const branch = await resolveBranchName('/repo', 'M5-T1', runner);
			expect(branch).toBe('task/M5-T1-2');
		});

		it('appends suffix -3 when -2 also exists, never reusing or overwriting existing branches (E-71)', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'for-each-ref') {
					return { exitCode: 0, stdout: 'main\ntask/M5-T1\ntask/M5-T1-2', stderr: '' };
				}
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: 'worktree /repo\nHEAD 1234\nbranch refs/heads/main',
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const branch = await resolveBranchName('/repo', 'M5-T1', runner);
			expect(branch).toBe('task/M5-T1-3');
		});

		it('detects branches checked out in other worktrees even if not listed in for-each-ref', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'for-each-ref') {
					return { exitCode: 0, stdout: 'main', stderr: '' };
				}
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout:
							'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt1\nHEAD def\nbranch refs/heads/task/M5-T1',
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const branch = await resolveBranchName('/repo', 'M5-T1', runner);
			expect(branch).toBe('task/M5-T1-2');
		});

		it('creates independent worktree with resolved branch and does not pass -B or --force to overwrite', async () => {
			const executedCommands: Array<{ args: readonly string[]; cwd: string }> = [];
			const runner = createMockGitRunner((args, cwd) => {
				executedCommands.push({ args, cwd });
				if (args[0] === 'rev-parse') {
					return { exitCode: 0, stdout: 'true\n/repo', stderr: '' };
				}
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/main',
						stderr: '',
					};
				}
				if (args[0] === 'for-each-ref') {
					return { exitCode: 0, stdout: 'main\ntask/M5-T1', stderr: '' };
				}
				if (args[0] === 'worktree' && args[1] === 'add') {
					return { exitCode: 0, stdout: 'Preparing worktree...', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const deps: WorktreeManagerDeps = {
				platform: 'linux',
				gitRunner: runner,
				ids: defaultTestIds,
			};
			const result = await prepareWorktree(
				{
					repoPath: '/repo',
					taskId: 'M5-T1',
				},
				runner,
				deps,
			);

			expect(result.branchName).toBe('task/M5-T1-2');
			expect(result.isReused).toBe(false);

			const addCmd = executedCommands.find(
				(cmd) => cmd.args[0] === 'worktree' && cmd.args[1] === 'add',
			);
			expect(addCmd).toBeDefined();
			// Assert -b is used, NOT -B (which would overwrite)
			expect(addCmd?.args).toContain('-b');
			expect(addCmd?.args).not.toContain('-B');
			expect(addCmd?.args).not.toContain('--force');
			expect(addCmd?.args).toContain('task/M5-T1-2');
		});
	});

	describe('E-277 / E-121: reuse mode rebuilds the worktree on the original branch', () => {
		function createReuseRunner(listStdout: string, branches: string) {
			const executed: Array<readonly string[]> = [];
			const runner = createMockGitRunner((args) => {
				executed.push(args);
				if (args[0] === 'rev-parse') {
					return { exitCode: 0, stdout: 'true\n/repo', stderr: '' };
				}
				if (args[0] === 'worktree' && args[1] === 'list') {
					return { exitCode: 0, stdout: listStdout, stderr: '' };
				}
				if (args[0] === 'for-each-ref') {
					return { exitCode: 0, stdout: branches, stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});
			return { runner, executed };
		}

		const directoryPresentFs = {
			stat: async () => ({ isDirectory: () => true }),
		};
		const directoryMissingFs = {
			stat: async () => {
				throw Object.assign(new Error('missing worktree directory'), { code: 'ENOENT' });
			},
		};

		it('returns the registered worktree untouched when its directory still exists', async () => {
			const { runner, executed } = createReuseRunner(
				'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/task-1\nHEAD def\nbranch refs/heads/task/M7-T5',
				'main\ntask/M7-T5',
			);
			const result = await prepareWorktree(
				{ repoPath: '/repo', taskId: 'M7-T5', worktreeMode: 'reuse' },
				runner,
				{ platform: 'linux', gitRunner: runner, ids: defaultTestIds, fs: directoryPresentFs },
			);
			expect(result).toMatchObject({
				worktreePath: '/wt/task-1',
				branchName: 'task/M7-T5',
				isReused: true,
			});
			expect(executed.some((args) => args[0] === 'worktree' && args[1] === 'add')).toBe(false);
		});

		it('removes the exact prunable registration, then re-adds the same path on the same branch', async () => {
			const { runner, executed } = createReuseRunner(
				'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/task-1\nHEAD def\nbranch refs/heads/task/M7-T5\nprunable gitdir file points to non-existent location',
				'main\ntask/M7-T5',
			);
			const result = await prepareWorktree(
				{ repoPath: '/repo', taskId: 'M7-T5', worktreeMode: 'reuse' },
				runner,
				{ platform: 'linux', gitRunner: runner, ids: defaultTestIds, fs: directoryMissingFs },
			);
			expect(result.branchName).toBe('task/M7-T5');
			expect(result.isReused).toBe(true);
			const remove = executed.find((args) => args[0] === 'worktree' && args[1] === 'remove');
			expect(remove).toEqual(['worktree', 'remove', '--force', '/wt/task-1']);
			const add = executed.find((args) => args[0] === 'worktree' && args[1] === 'add');
			expect(add).toBeDefined();
			expect(add).not.toContain('--force');
			expect(add).not.toContain('-b');
			expect(add?.[add.length - 1]).toBe('task/M7-T5');
		});

		it('rebuilds a missing registered directory even when old Git omits the prunable marker', async () => {
			const { runner, executed } = createReuseRunner(
				'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/task-1\nHEAD def\nbranch refs/heads/task/M7-T5',
				'main\ntask/M7-T5',
			);
			const result = await prepareWorktree(
				{ repoPath: '/repo', taskId: 'M7-T5', worktreeMode: 'reuse' },
				runner,
				{ platform: 'linux', gitRunner: runner, ids: defaultTestIds, fs: directoryMissingFs },
			);
			expect(result).toMatchObject({
				worktreePath: '/wt/task-1',
				branchName: 'task/M7-T5',
				isReused: true,
			});
			expect(executed).toContainEqual(['worktree', 'remove', '--force', '/wt/task-1']);
			expect(executed).toContainEqual(['worktree', 'add', '/wt/task-1', 'task/M7-T5']);
		});

		it('checks out the existing branch into a new worktree when the registration is gone, never a fresh branch from HEAD', async () => {
			const { runner, executed } = createReuseRunner(
				'worktree /repo\nHEAD abc\nbranch refs/heads/main',
				'main\ntask/M7-T5',
			);
			const result = await prepareWorktree(
				{
					repoPath: '/repo',
					taskId: 'M7-T5',
					worktreeMode: 'reuse',
					preferredBranchName: 'task/M7-T5',
					targetWorktreePath: '/wt/task-1',
				},
				runner,
				{ platform: 'linux', gitRunner: runner, ids: defaultTestIds, fs: directoryMissingFs },
			);
			expect(result.branchName).toBe('task/M7-T5');
			expect(result.isReused).toBe(true);
			const add = executed.find((args) => args[0] === 'worktree' && args[1] === 'add');
			expect(add).toBeDefined();
			expect(add).not.toContain('-b');
			expect(add).not.toContain('--force');
			expect(add?.[add.length - 1]).toBe('task/M7-T5');
			expect(add?.some((arg) => arg === 'HEAD')).toBe(false);
		});
	});

	describe('AC 3 & E-72: Main worktree with uncommitted changes', () => {
		it('does NOT stash, reset, or modify main repository when preparing worktree', async () => {
			const executedCommands: string[][] = [];
			const runner = createMockGitRunner((args) => {
				executedCommands.push([...args]);
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'true\n/my-repo', stderr: '' };
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: 'worktree /my-repo\nHEAD abc\nbranch refs/heads/main',
						stderr: '',
					};
				}
				if (args[0] === 'for-each-ref') return { exitCode: 0, stdout: 'main', stderr: '' };
				if (args[0] === 'worktree' && args[1] === 'add') {
					return { exitCode: 0, stdout: 'Preparing worktree...', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const deps: WorktreeManagerDeps = {
				platform: 'linux',
				gitRunner: runner,
				ids: defaultTestIds,
			};
			const result = await prepareWorktree(
				{
					repoPath: '/my-repo',
					taskId: 'M5-T1',
					baseRef: 'HEAD',
				},
				runner,
				deps,
			);

			expect(result.baseRef).toBe('HEAD');

			// Verify NO stash or reset command was ever called
			const disallowed = executedCommands.filter(
				(cmd) =>
					cmd[0] === 'stash' ||
					cmd[0] === 'reset' ||
					(cmd[0] === 'checkout' && !cmd.includes('worktree')),
			);
			expect(disallowed).toEqual([]);
		});
	});

	describe('AC 4 & E-76: Worktree creation failure (disk full or permission)', () => {
		it('maps ENOSPC / disk full to E_WORKSPACE_UNAVAILABLE with reason: disk-full and releaseSlot: true', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'true\n/repo', stderr: '' };
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/main',
						stderr: '',
					};
				}
				if (args[0] === 'for-each-ref') return { exitCode: 0, stdout: 'main', stderr: '' };
				if (args[0] === 'worktree' && args[1] === 'add') {
					return {
						exitCode: 1,
						stdout: '',
						stderr: 'fatal: cannot create directory /repo-m5-t1: No space left on device',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const deps: WorktreeManagerDeps = {
				platform: 'linux',
				gitRunner: runner,
				ids: defaultTestIds,
			};
			let thrown: unknown;
			try {
				await prepareWorktree({ repoPath: '/repo', taskId: 'M5-T1' }, runner, deps);
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeInstanceOf(AppError);
			if (thrown instanceof AppError) {
				expect(thrown.code).toBe('E_WORKSPACE_UNAVAILABLE');
				expect(thrown.details?.reason).toBe('disk-full');
				expect(thrown.details?.releaseSlot).toBe(true);
				expect(thrown.details?.workspaceUnavailable).toBe(true);
			}
		});

		it('maps EACCES / permission denied to E_WORKSPACE_UNAVAILABLE with reason: permission-denied', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'true\n/repo', stderr: '' };
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/main',
						stderr: '',
					};
				}
				if (args[0] === 'for-each-ref') return { exitCode: 0, stdout: 'main', stderr: '' };
				if (args[0] === 'worktree' && args[1] === 'add') {
					return {
						exitCode: 1,
						stdout: '',
						stderr: 'fatal: cannot create directory /repo-m5-t1: Permission denied',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const deps: WorktreeManagerDeps = {
				platform: 'linux',
				gitRunner: runner,
				ids: defaultTestIds,
			};
			let thrown: unknown;
			try {
				await prepareWorktree({ repoPath: '/repo', taskId: 'M5-T1' }, runner, deps);
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeInstanceOf(AppError);
			if (thrown instanceof AppError) {
				expect(thrown.code).toBe('E_WORKSPACE_UNAVAILABLE');
				expect(thrown.details?.reason).toBe('permission-denied');
				expect(thrown.details?.releaseSlot).toBe(true);
			}
		});

		it('maps thrown native filesystem errors to E_WORKSPACE_UNAVAILABLE', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'true\n/repo', stderr: '' };
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/main',
						stderr: '',
					};
				}
				if (args[0] === 'for-each-ref') return { exitCode: 0, stdout: 'main', stderr: '' };
				if (args[0] === 'worktree' && args[1] === 'add') {
					const nativeErr = new Error('ENOSPC: write failed');
					(nativeErr as unknown as { code: string }).code = 'ENOSPC';
					throw nativeErr;
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const deps: WorktreeManagerDeps = {
				platform: 'linux',
				gitRunner: runner,
				ids: defaultTestIds,
			};
			await expect(
				prepareWorktree({ repoPath: '/repo', taskId: 'M5-T1' }, runner, deps),
			).rejects.toMatchObject({
				code: 'E_WORKSPACE_UNAVAILABLE',
				details: {
					reason: 'disk-full',
					releaseSlot: true,
				},
			});
		});
	});

	describe('Worktree Reclamation / Cleanup (removeWorktree)', () => {
		it('executes git worktree remove and prune and returns { removed: true }', async () => {
			const executedCommands: string[][] = [];
			const runner = createMockGitRunner((args) => {
				executedCommands.push([...args]);
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout:
							'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-m5-t1\nHEAD def\nbranch refs/heads/task/M5-T1',
						stderr: '',
					};
				}
				if (args[0] === 'worktree' && args[1] === 'remove') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (args[0] === 'worktree' && args[1] === 'prune') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const deps: WorktreeManagerDeps = {
				platform: 'linux',
				gitRunner: runner,
				ids: defaultTestIds,
			};
			const result = await removeWorktree(
				{
					repoPath: '/repo',
					worktreePath: '/repo-m5-t1',
				},
				runner,
				deps,
			);

			expect(result.removed).toBe(true);
			expect(executedCommands).toContainEqual(['worktree', 'remove', resolve('/repo-m5-t1')]);
			expect(executedCommands).toContainEqual(['worktree', 'prune']);
		});

		it('supports force removal and deleting task branch', async () => {
			const executedCommands: string[][] = [];
			const runner = createMockGitRunner((args) => {
				executedCommands.push([...args]);
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout:
							'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-m5-t1\nHEAD def\nbranch refs/heads/task/M5-T1',
						stderr: '',
					};
				}
				if (args[0] === 'worktree' && args[1] === 'remove') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (args[0] === 'branch' && args[1] === '-D') {
					return { exitCode: 0, stdout: 'Deleted branch task/M5-T1', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const deps: WorktreeManagerDeps = {
				platform: 'linux',
				gitRunner: runner,
				ids: defaultTestIds,
			};
			const result = await removeWorktree(
				{
					repoPath: '/repo',
					worktreePath: '/repo-m5-t1',
					force: true,
					deleteBranch: true,
				},
				runner,
				deps,
			);

			expect(result.removed).toBe(true);
			expect(result.branchDeleted).toBe(true);
			expect(executedCommands).toContainEqual([
				'worktree',
				'remove',
				'--force',
				resolve('/repo-m5-t1'),
			]);
			expect(executedCommands).toContainEqual(['branch', '-D', 'task/M5-T1']);
		});

		it('is idempotent when worktree is already missing from list', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'worktree' && args[1] === 'list') {
					return {
						exitCode: 0,
						stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/main',
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const deps: WorktreeManagerDeps = {
				platform: 'linux',
				gitRunner: runner,
				ids: defaultTestIds,
			};
			const result = await removeWorktree(
				{
					repoPath: '/repo',
					worktreePath: '/repo-m5-t1',
				},
				runner,
				deps,
			);

			expect(result.removed).toBe(true);
		});
	});

	describe('Worktree Inspection (inspectWorktree)', () => {
		it('returns hasChanges: false when working tree is clean', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'status') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (args[0] === 'diff') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const inspection = await inspectWorktree('/worktree/path', runner);
			expect(inspection.hasChanges).toBe(false);
			expect(inspection.changedFileCount).toBe(0);
			expect(inspection.diff).toBe('');
		});

		it('returns hasChanges: true and changedFileCount when files are modified', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'status') {
					return {
						exitCode: 0,
						stdout: ' M src/file1.ts\n?? src/file2.ts\n D src/file3.ts',
						stderr: '',
					};
				}
				if (args[0] === 'diff') {
					return {
						exitCode: 0,
						stdout: 'diff --git a/src/file1.ts b/src/file1.ts\n...',
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const inspection = await inspectWorktree('/worktree/path', runner);
			expect(inspection.hasChanges).toBe(true);
			expect(inspection.changedFileCount).toBe(3);
			expect(inspection.diff).toContain('diff --git');
		});
	});

	describe('WorktreeManager Factory (createWorktreeManager)', () => {
		it('binds dependencies and implements WorktreeManager and WorktreeInspector interface', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'true\n/my-repo', stderr: '' };
				if (args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const manager = createWorktreeManager({
				platform: 'linux',
				gitRunner: runner,
				ids: defaultTestIds,
			});

			expect(manager.platform).toBe('linux');
			const check = await manager.checkGitRepository('/my-repo');
			expect(check.isGitRepo).toBe(true);

			const inspection = await manager.inspect('/my-repo');
			expect(inspection.hasChanges).toBe(false);
		});

		it('R1: throws typed AppError (E_AGENT_EXEC_NOT_FOUND) when git executable cannot be resolved', async () => {
			const deps: WorktreeManagerDeps = {
				platform: 'linux',
				gitBinary: '/non/existent/git/binary/path',
				ids: defaultTestIds,
			};
			const runner = createDefaultGitRunner(deps);
			await expect(runner.run(['status'], '/tmp')).rejects.toMatchObject({
				code: 'E_AGENT_EXEC_NOT_FOUND',
			});
		});

		it('R1 & R2: accepts injected ResolvedExecutable directly and runId uses injected ids.newId()', async () => {
			let capturedRunId = '';
			const fakeResolved: ResolvedExecutable = {
				launchKind: 'direct',
				sourcePath: '/mock/git',
				file: '/mock/git',
				argsPrefix: [],
				checkedPaths: ['/mock/git'],
			};
			let newIdCalls = 0;
			const customIds = {
				newId: () => {
					newIdCalls++;
					return `custom-seq-${newIdCalls}`;
				},
			};

			const deps: WorktreeManagerDeps = {
				platform: 'linux',
				gitBinary: fakeResolved,
				ids: customIds,
				spawnManaged: ((spec: LaunchSpec) => {
					capturedRunId = spec.runId;
					const exitResult: ProcessExitResult = {
						exitCode: 0,
						runId: spec.runId,
						pid: 1234,
						signal: null,
						reason: 'exited',
					};
					return {
						isExited: true,
						exitResult,
						onExit: (cb: (result: ProcessExitResult) => void) => cb(exitResult),
						onError: () => () => {},
					} as unknown as ManagedProcess;
				}) as unknown as typeof spawnManaged,
			};

			const runner = createDefaultGitRunner(deps);
			await runner.run(['status'], '/tmp');

			expect(capturedRunId).toBe('git_custom-seq-1');
			expect(newIdCalls).toBe(1);
		});

		it('passes a resolved Windows Git command shim to the process wrapper', async () => {
			let capturedFile = '';
			const resolvedGit: ResolvedExecutable = {
				launchKind: 'com-spec',
				sourcePath: 'C:\\tools\\git.cmd',
				file: 'C:\\Windows\\System32\\cmd.exe',
				argsPrefix: [],
				spawnOptions: { windowsVerbatimArguments: true },
				checkedPaths: ['C:\\tools\\git.cmd'],
			};
			const runner = createDefaultGitRunner({
				platform: 'win32',
				gitBinary: resolvedGit,
				ids: defaultTestIds,
				spawnManaged: ((spec: LaunchSpec) => {
					capturedFile = spec.file;
					const result: ProcessExitResult = {
						exitCode: 0,
						runId: spec.runId,
						pid: 1,
						signal: null,
						reason: 'exited',
					};
					return {
						isExited: true,
						exitResult: result,
						onExit: (callback: (exit: ProcessExitResult) => void) => callback(result),
						onError: () => () => {},
					} as unknown as ManagedProcess;
				}) as unknown as typeof spawnManaged,
			});
			await runner.run(['status'], 'C:\\repo');
			expect(capturedFile).toBe('C:\\tools\\git.cmd');
		});
	});

	describe('End-to-End Real Git Integration', () => {
		it('executes real git commands on a real repository (AC 1, AC 2, AC 3, E-69, E-71, E-72)', async (ctx) => {
			// R1: E2E 测试按宿主解析 git，找不到就 skip
			const hostInputsResult = takePlatformHostInputs({});
			if (!hostInputsResult.ok) {
				ctx.skip();
				return;
			}
			const hostInputs = hostInputsResult.value;
			const gitResolution = await resolveExecutable({
				hostInputs,
				executableName: 'git',
			});
			if (!gitResolution.ok) {
				ctx.skip();
				return;
			}
			const gitExecutable = gitResolution.executable;

			// Create a real temporary repository
			const tempBase = mkdtempSync(join(tmpdir(), 'git-test-'));
			const mainRepo = join(tempBase, 'main-repo');
			mkdirSync(mainRepo, { recursive: true });

			const defaultRunner = createDefaultGitRunner({
				platform: hostInputs.platform,
				gitBinary: gitExecutable,
				ids: defaultTestIds,
			});

			try {
				// Initialize real git repo
				await defaultRunner.run(['init'], mainRepo);
				await defaultRunner.run(['checkout', '-B', 'main'], mainRepo);
				await defaultRunner.run(['config', 'user.name', 'test'], mainRepo);
				await defaultRunner.run(['config', 'user.email', 'test@example.com'], mainRepo);

				// Create initial commit
				writeFileSync(join(mainRepo, 'README.md'), '# Initial commit\n');
				await defaultRunner.run(['add', 'README.md'], mainRepo);
				await defaultRunner.run(['commit', '-m', 'Initial commit'], mainRepo);

				const manager = createWorktreeManager({
					platform: hostInputs.platform,
					gitBinary: gitExecutable,
					ids: defaultTestIds,
				});

				// AC 2 & E-69: Check git repo status
				const repoCheck = await manager.checkGitRepository(mainRepo);
				expect(repoCheck.isGitRepo).toBe(true);
				expect(repoCheck.requiresSerialExecution).toBe(false);

				const nonGitCheck = await manager.checkGitRepository(tempBase);
				expect(nonGitCheck.isGitRepo).toBe(false);
				expect(nonGitCheck.requiresSerialExecution).toBe(true);

				// AC 3 & E-72: Main worktree has uncommitted changes
				writeFileSync(join(mainRepo, 'README.md'), '# Uncommitted changes in main\n');
				writeFileSync(join(mainRepo, 'untracked.txt'), 'untracked content\n');

				// Prepare worktree for task M5-T1
				const prep1 = await manager.prepareWorktree({
					repoPath: mainRepo,
					taskId: 'M5-T1',
					worktreesDir: tempBase,
				});

				expect(prep1.branchName).toBe('task/M5-T1');
				expect(prep1.isReused).toBe(false);

				// AC 3 & E-72: Verify main worktree changes remain untouched
				const statusMain = await defaultRunner.run(['status', '--porcelain'], mainRepo);
				expect(statusMain.stdout).toContain('M README.md');
				expect(statusMain.stdout).toContain('?? untracked.txt');

				// Verify new worktree is clean
				const inspect1 = await manager.inspect(prep1.worktreePath);
				expect(inspect1.hasChanges).toBe(false);

				// AC 1 & E-71: Branch name collision creates task/M5-T1-2
				const prep2 = await manager.prepareWorktree({
					repoPath: mainRepo,
					taskId: 'M5-T1',
					worktreesDir: tempBase,
				});

				expect(prep2.branchName).toBe('task/M5-T1-2');
				expect(prep2.worktreePath).not.toBe(prep1.worktreePath);

				// Modify file in worktree 1
				writeFileSync(join(prep1.worktreePath, 'new-file.txt'), 'hello from worktree\n');
				const inspectModified = await manager.inspect(prep1.worktreePath);
				expect(inspectModified.hasChanges).toBe(true);
				expect(inspectModified.changedFileCount).toBe(1);

				// E-277: commit on the task branch, delete the directory behind git's back, then reuse-rebuild
				await defaultRunner.run(['add', 'new-file.txt'], prep1.worktreePath);
				await defaultRunner.run(['commit', '-m', 'work on task branch'], prep1.worktreePath);
				rmSync(prep1.worktreePath, { recursive: true, force: true });
				const rebuilt = await manager.prepareWorktree({
					repoPath: mainRepo,
					taskId: 'M5-T1',
					worktreesDir: tempBase,
					worktreeMode: 'reuse',
					preferredBranchName: prep1.branchName,
					targetWorktreePath: prep1.worktreePath,
				});
				expect(rebuilt.isReused).toBe(true);
				expect(rebuilt.branchName).toBe('task/M5-T1');
				expect(realpathSync(rebuilt.worktreePath)).toBe(realpathSync(prep1.worktreePath));
				const headBranch = await defaultRunner.run(
					['rev-parse', '--abbrev-ref', 'HEAD'],
					rebuilt.worktreePath,
				);
				expect(headBranch.stdout.trim()).toBe('task/M5-T1');
				const lsResult = await defaultRunner.run(
					['ls-files', 'new-file.txt'],
					rebuilt.worktreePath,
				);
				expect(lsResult.stdout.trim()).toBe('new-file.txt');

				// Reclamation: remove worktree
				const cleanup1 = await manager.removeWorktree({
					repoPath: mainRepo,
					worktreePath: prep1.worktreePath,
					force: true,
					deleteBranch: true,
				});
				expect(cleanup1.removed).toBe(true);

				const cleanup2 = await manager.removeWorktree({
					repoPath: mainRepo,
					worktreePath: prep2.worktreePath,
					force: true,
					deleteBranch: true,
				});
				expect(cleanup2.removed).toBe(true);
			} finally {
				rmSync(tempBase, { recursive: true, force: true });
			}
		}, 30000);
	});
});
