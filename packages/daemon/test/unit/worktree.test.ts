import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.ts';
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

			const deps: WorktreeManagerDeps = { platform: 'linux', gitRunner: runner };
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

			const deps: WorktreeManagerDeps = { platform: 'linux', gitRunner: runner };
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

			const deps: WorktreeManagerDeps = { platform: 'linux', gitRunner: runner };
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

			const deps: WorktreeManagerDeps = { platform: 'linux', gitRunner: runner };
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

			const deps: WorktreeManagerDeps = { platform: 'linux', gitRunner: runner };
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

			const deps: WorktreeManagerDeps = { platform: 'linux', gitRunner: runner };
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

			const deps: WorktreeManagerDeps = { platform: 'linux', gitRunner: runner };
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

			const deps: WorktreeManagerDeps = { platform: 'linux', gitRunner: runner };
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

			const deps: WorktreeManagerDeps = { platform: 'linux', gitRunner: runner };
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
			});

			expect(manager.platform).toBe('linux');
			const check = await manager.checkGitRepository('/my-repo');
			expect(check.isGitRepo).toBe(true);

			const inspection = await manager.inspect('/my-repo');
			expect(inspection.hasChanges).toBe(false);
		});
	});

	describe('End-to-End Real Git Integration', () => {
		it('executes real git commands on a real repository (AC 1, AC 2, AC 3, E-69, E-71, E-72)', async () => {
			// Create a real temporary repository
			const tempBase = mkdtempSync(join(tmpdir(), 'git-test-'));
			const mainRepo = join(tempBase, 'main-repo');
			mkdirSync(mainRepo, { recursive: true });

			const gitBinary = '/usr/bin/git';
			const defaultRunner = createDefaultGitRunner(gitBinary, 'linux', { platform: 'linux' });

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
					platform: 'linux',
					gitBinary,
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
		});
	});
});
