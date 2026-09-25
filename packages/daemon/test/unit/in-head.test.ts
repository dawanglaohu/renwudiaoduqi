import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	isBranchInHead,
	readWorktreeStartingBaseline,
	takeStderrTail,
} from '../../src/workspace/in-head.ts';
import type { GitCommandResult, GitRunner } from '../../src/workspace/worktree.ts';
import {
	createWorktreeManager,
	formatWrapupBranchName,
	prepareWrapupWorktree,
	resolveWrapupBranchName,
} from '../../src/workspace/worktree.ts';

function createMockRunner(
	handler: (args: readonly string[], cwd: string) => GitCommandResult | Promise<GitCommandResult>,
): { runner: GitRunner; calls: { args: readonly string[]; cwd: string }[] } {
	const calls: { args: readonly string[]; cwd: string }[] = [];
	const runner: GitRunner = {
		run: async (args, cwd) => {
			calls.push({ args, cwd });
			return handler(args, cwd);
		},
	};
	return { runner, calls };
}

describe('M5-T5 isBranchInHead & Wrapup Worktree', () => {
	const fakeRepo = '/repo/test';

	describe('AC 1 & E-273: In-HEAD determination for local branches', () => {
		it('returns inHead: true with method: ancestor when merge-base exitCode is 0', async () => {
			const { runner, calls } = createMockRunner((args) => {
				if (args[0] === 'rev-parse' && args[3] === 'refs/heads/task/M1-T1') {
					return { exitCode: 0, stdout: 'sha-1111111\n', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead({ repoPath: fakeRepo, branchName: 'task/M1-T1' }, runner);

			expect(result).toEqual({
				inHead: true,
				method: 'ancestor',
				tipSha: 'sha-1111111',
			});

			expect(calls.map((c) => c.args[0])).toEqual(['rev-parse', 'merge-base']);
		});

		it('falls back to git diff --quiet HEAD <branch> when merge-base is 1, and returns no_diff when diff is 0 (E-273 squash merge)', async () => {
			const { runner, calls } = createMockRunner((args) => {
				if (args[0] === 'rev-parse') {
					return { exitCode: 0, stdout: 'sha-squash\n', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				if (args[0] === 'diff') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead({ repoPath: fakeRepo, branchName: 'task/M2-T1' }, runner);

			expect(result).toEqual({
				inHead: true,
				method: 'no_diff',
				tipSha: 'sha-squash',
			});

			expect(calls.map((c) => c.args[0])).toEqual(['rev-parse', 'merge-base', 'diff']);
			expect(calls[2]?.args).toEqual(['diff', '--quiet', 'HEAD', 'refs/heads/task/M2-T1']);
		});

		it('returns inHead: false with method: unmerged when diff is also 1', async () => {
			const { runner } = createMockRunner((args) => {
				if (args[0] === 'rev-parse') {
					return { exitCode: 0, stdout: 'sha-unmerged\n', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				if (args[0] === 'diff') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead({ repoPath: fakeRepo, branchName: 'task/M2-T2' }, runner);

			expect(result).toEqual({
				inHead: false,
				method: 'unmerged',
				tipSha: 'sha-unmerged',
			});
		});

		it('judges inHead: false with method: dirty_worktree when worktree exists and porcelain is non-empty (E-301)', async () => {
			const mockFs = {
				stat: async (_path: string) => ({ isDirectory: () => true }),
			};

			const { runner } = createMockRunner((args) => {
				if (args[0] === 'status' && args[1] === '--porcelain') {
					return { exitCode: 0, stdout: ' M package.json\n?? untracked.txt\n', stderr: '' };
				}
				if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
					return { exitCode: 0, stdout: 'sha-worktree-head\n', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead(
				{
					repoPath: fakeRepo,
					branchName: 'task/M3-T1',
					worktreePath: '/repo/worktrees/task-m3-t1',
				},
				{ gitRunner: runner, fs: mockFs },
			);

			expect(result).toEqual({
				inHead: false,
				method: 'dirty_worktree',
				tipSha: 'sha-worktree-head',
			});
		});

		it('proceeds with branch check if worktree exists and is clean', async () => {
			const mockFs = {
				stat: async (_path: string) => ({ isDirectory: () => true }),
			};

			const { runner, calls } = createMockRunner((args) => {
				if (args[0] === 'status' && args[1] === '--porcelain') {
					return { exitCode: 0, stdout: '\n', stderr: '' };
				}
				if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
					return { exitCode: 0, stdout: 'sha-clean-head\n', stderr: '' };
				}
				if (args[0] === 'rev-parse' && args[3] === 'refs/heads/task/M3-T2') {
					return { exitCode: 0, stdout: 'sha-branch-head\n', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead(
				{
					repoPath: fakeRepo,
					branchName: 'task/M3-T2',
					worktreePath: '/repo/worktrees/task-m3-t2',
				},
				{ gitRunner: runner, fs: mockFs },
			);

			expect(result).toEqual({
				inHead: true,
				method: 'ancestor',
				tipSha: 'sha-branch-head',
			});
			expect(calls[0]?.args).toEqual(['status', '--porcelain']);
		});
	});

	describe('AC 2 & E-289: Branch does not exist locally', () => {
		it('uses caller-provided tipSha to test ancestor when branch is gone', async () => {
			const { runner, calls } = createMockRunner((args) => {
				if (args[0] === 'rev-parse' && args[3] === 'refs/heads/task/M4-T1') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					expect(args[2]).toBe('sha-recorded');
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead(
				{
					repoPath: fakeRepo,
					branchName: 'task/M4-T1',
					tipSha: 'sha-recorded',
				},
				runner,
			);

			expect(result).toEqual({
				inHead: true,
				method: 'ancestor',
				tipSha: 'sha-recorded',
			});
			expect(calls.map((c) => c.args[0])).toEqual(['rev-parse', 'merge-base']);
		});

		it('uses caller-provided tipSha and diff fallback when branch is gone and ancestor is false', async () => {
			const { runner } = createMockRunner((args) => {
				if (args[0] === 'rev-parse') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				if (args[0] === 'diff') {
					expect(args[3]).toBe('sha-squashed-gone');
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead(
				{
					repoPath: fakeRepo,
					branchName: 'task/M4-T2',
					tipSha: 'sha-squashed-gone',
				},
				runner,
			);

			expect(result).toEqual({
				inHead: true,
				method: 'no_diff',
				tipSha: 'sha-squashed-gone',
			});
		});

		it('returns branch_gone_unmerged with restore command text when both ancestor and diff fail for tipSha (E-289)', async () => {
			const { runner } = createMockRunner((args) => {
				if (args[0] === 'rev-parse') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				if (args[0] === 'diff') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead(
				{
					repoPath: fakeRepo,
					branchName: 'task/M4-T3',
					tipSha: 'sha-unmerged-gone',
				},
				runner,
			);

			expect(result).toEqual({
				inHead: false,
				method: 'branch_gone_unmerged',
				tipSha: 'sha-unmerged-gone',
				commandText: 'git branch task/M4-T3 sha-unmerged-gone',
			});
		});

		it('recovers tipSha from still-existing worktree HEAD when no tipSha provided (E-289)', async () => {
			const mockFs = {
				stat: async () => ({ isDirectory: () => true }),
			};

			const { runner } = createMockRunner((args) => {
				if (args[0] === 'status' && args[1] === '--porcelain') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
					return { exitCode: 0, stdout: 'sha-from-worktree-head\n', stderr: '' };
				}
				if (args[0] === 'rev-parse' && args[3] === 'refs/heads/task/M4-T4') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					expect(args[2]).toBe('sha-from-worktree-head');
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead(
				{
					repoPath: fakeRepo,
					branchName: 'task/M4-T4',
					worktreePath: '/repo/worktrees/task-m4-t4',
				},
				{ gitRunner: runner, fs: mockFs },
			);

			expect(result).toEqual({
				inHead: true,
				method: 'ancestor',
				tipSha: 'sha-from-worktree-head',
			});
		});

		it('returns inHead: true with method: branch_gone when no SHA and worktree is cleaned up (E-289)', async () => {
			const mockFs = {
				stat: async () => {
					const error = new Error('ENOENT: no such file or directory') as Error & {
						code?: string;
					};
					error.code = 'ENOENT';
					throw error;
				},
			};

			const { runner } = createMockRunner((args) => {
				if (args[0] === 'rev-parse') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead(
				{
					repoPath: fakeRepo,
					branchName: 'task/M4-T5',
					worktreePath: '/repo/worktrees/task-m4-t5',
				},
				{ gitRunner: runner, fs: mockFs },
			);

			expect(result).toEqual({
				inHead: true,
				method: 'branch_gone',
				tipSha: undefined,
			});
		});

		it('does not fall back to branch_gone when the worktree is still present but its HEAD cannot be read (E-289, E-301)', async () => {
			const mockFs = {
				stat: async () => ({ isDirectory: () => true }),
			};

			const { runner } = createMockRunner((args) => {
				if (args[0] === 'status') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
					return { exitCode: 128, stdout: '', stderr: 'fatal: bad object HEAD' };
				}
				if (args[0] === 'rev-parse') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead(
				{
					repoPath: fakeRepo,
					branchName: 'task/M4-T6',
					worktreePath: '/repo/worktrees/task-m4-t6',
				},
				{ gitRunner: runner, fs: mockFs },
			);

			expect(result.inHead).toBe(false);
			expect(result.method).toBe('error');
			expect(result.stderrTail).toContain('bad object HEAD');
		});

		it('does not fall back to branch_gone when the worktree state itself cannot be determined (E-301)', async () => {
			const mockFs = {
				stat: async () => {
					const error = new Error('EACCES: permission denied') as Error & { code?: string };
					error.code = 'EACCES';
					throw error;
				},
			};

			const { runner } = createMockRunner((args) => {
				if (args[0] === 'rev-parse') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead(
				{
					repoPath: fakeRepo,
					branchName: 'task/M4-T7',
					worktreePath: '/repo/worktrees/task-m4-t7',
				},
				{ gitRunner: runner, fs: mockFs },
			);

			expect(result.inHead).toBe(false);
			expect(result.method).toBe('error');
			expect(result.stderrTail).toContain('EACCES');
		});
	});

	describe('AC 3 & E-301: Error handling and stderrTail truncation', () => {
		it('returns method: error with last 200 bytes of stderr when git command fails with non-zero (E-301)', async () => {
			const longStderr = `${'prefix-error-information-'.repeat(20)}CRITICAL_FATAL_ERROR`;
			const { runner } = createMockRunner((args) => {
				if (args[0] === 'rev-parse') {
					return { exitCode: 0, stdout: 'sha-err\n', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					return { exitCode: 128, stdout: '', stderr: longStderr };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead(
				{
					repoPath: fakeRepo,
					branchName: 'task/M5-T1',
				},
				runner,
			);

			expect(result.inHead).toBe(false);
			expect(result.method).toBe('error');
			expect(result.tipSha).toBe('sha-err');
			expect(result.stderrTail).toBeDefined();
			expect(Buffer.from(result.stderrTail ?? '').length).toBeLessThanOrEqual(200);
			expect(result.stderrTail).toContain('CRITICAL_FATAL_ERROR');
		});

		it('returns method: error when status --porcelain fails on worktree check', async () => {
			const mockFs = {
				stat: async () => ({ isDirectory: () => true }),
			};

			const { runner } = createMockRunner((args) => {
				if (args[0] === 'status') {
					return { exitCode: 128, stdout: '', stderr: 'fatal: bad object HEAD' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await isBranchInHead(
				{
					repoPath: fakeRepo,
					branchName: 'task/M5-T2',
					worktreePath: '/repo/worktrees/m5-t2',
				},
				{ gitRunner: runner, fs: mockFs },
			);

			expect(result).toEqual({
				inHead: false,
				method: 'error',
				tipSha: undefined,
				stderrTail: 'fatal: bad object HEAD',
			});
		});

		it('takeStderrTail correctly handles short and long strings', () => {
			expect(takeStderrTail('')).toBe('');
			expect(takeStderrTail('short error')).toBe('short error');

			const exactly200 = 'x'.repeat(200);
			expect(takeStderrTail(exactly200)).toBe(exactly200);

			const over200 = 'a'.repeat(100) + 'b'.repeat(200);
			const truncated = takeStderrTail(over200);
			expect(Buffer.from(truncated, 'utf-8').length).toBe(200);
			expect(truncated).toBe('b'.repeat(200));
		});
	});

	describe('AC 4: Sequential git execution', () => {
		it('executes git commands strictly sequentially without concurrency', async () => {
			let runningCommandCount = 0;
			let maxConcurrentCommands = 0;

			const runner: GitRunner = {
				run: async (args) => {
					runningCommandCount++;
					maxConcurrentCommands = Math.max(maxConcurrentCommands, runningCommandCount);
					// Small async delay to observe potential concurrency
					await new Promise((resolve) => setTimeout(resolve, 10));
					runningCommandCount--;

					if (args[0] === 'rev-parse') {
						return { exitCode: 0, stdout: 'sha-seq\n', stderr: '' };
					}
					if (args[0] === 'merge-base') {
						return { exitCode: 1, stdout: '', stderr: '' };
					}
					if (args[0] === 'diff') {
						return { exitCode: 0, stdout: '', stderr: '' };
					}
					return { exitCode: 0, stdout: '', stderr: '' };
				},
			};

			const result = await isBranchInHead({ repoPath: fakeRepo, branchName: 'task/M5-T3' }, runner);

			expect(result.inHead).toBe(true);
			expect(maxConcurrentCommands).toBe(1);
		});
	});

	describe('AC 5 & E-71: Wrapup worktree and branch naming rules', () => {
		it('formats wrapup branch name as wrapup/<batchId>-<round>', () => {
			expect(formatWrapupBranchName(1, 1)).toBe('wrapup/1-1');
			expect(formatWrapupBranchName('batch-3', 2)).toBe('wrapup/batch-3-2');
		});

		it('resolves wrapup branch without collision when branch does not exist', async () => {
			const { runner } = createMockRunner((args) => {
				if (args[0] === 'for-each-ref') {
					return { exitCode: 0, stdout: 'main\ntask/M1-T1\n', stderr: '' };
				}
				if (args[0] === 'worktree' && args[1] === 'list') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const branchName = await resolveWrapupBranchName(fakeRepo, 1, 1, runner);
			expect(branchName).toBe('wrapup/1-1');
		});

		it('increments suffix according to E-71 when wrapup branch collides', async () => {
			const { runner } = createMockRunner((args) => {
				if (args[0] === 'for-each-ref') {
					// Both wrapup/1-1 and wrapup/1-1-2 already exist
					return {
						exitCode: 0,
						stdout: 'main\nwrapup/1-1\nwrapup/1-1-2\n',
						stderr: '',
					};
				}
				if (args[0] === 'worktree' && args[1] === 'list') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const branchName = await resolveWrapupBranchName(fakeRepo, 1, 1, runner);
			expect(branchName).toBe('wrapup/1-1-3');
		});

		it('prepares wrapup worktree with baseRef permanently set to HEAD', async () => {
			const { runner, calls } = createMockRunner((args) => {
				if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
					return { exitCode: 0, stdout: 'true\n/repo/test', stderr: '' };
				}
				if (args[0] === 'for-each-ref') {
					return { exitCode: 0, stdout: 'main\n', stderr: '' };
				}
				if (args[0] === 'worktree' && args[1] === 'list') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				if (args[0] === 'worktree' && args[1] === 'add') {
					return { exitCode: 0, stdout: 'Preparing worktree...', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await prepareWrapupWorktree(
				{
					repoPath: fakeRepo,
					batchId: 2,
					round: 1,
					targetWorktreePath: '/repo/worktrees/wrapup-2-1',
				},
				runner,
				{
					platform: 'linux',
					ids: { newId: () => 'wrapup-id' },
				},
			);

			expect(result.branchName).toBe('wrapup/2-1');
			expect(result.baseRef).toBe('HEAD');
			expect(result.isReused).toBe(false);

			const addCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
			expect(addCall).toBeDefined();
			// git worktree add -b wrapup/2-1 <path> HEAD
			expect(addCall?.args).toContain('HEAD');
			expect(addCall?.args).toContain('-b');
			expect(addCall?.args).toContain('wrapup/2-1');
		});

		it('exposes wrapup methods via createWorktreeManager', async () => {
			const { runner } = createMockRunner((args) => {
				if (args[0] === 'for-each-ref') {
					return { exitCode: 0, stdout: 'main\n', stderr: '' };
				}
				if (args[0] === 'worktree' && args[1] === 'list') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const manager = createWorktreeManager({
				platform: 'linux',
				gitRunner: runner,
				ids: { newId: () => 'wt-mgr-id' },
			});

			const branch = await manager.resolveWrapupBranchName(fakeRepo, 3, 1);
			expect(branch).toBe('wrapup/3-1');
			expect(typeof manager.prepareWrapupWorktree).toBe('function');
		});
	});
});

describe('E-329 worktree baseline', () => {
	it('freezes dirty tracked and untracked content without changing the real index', async () => {
		const repo = mkdtempSync(join(tmpdir(), 'bughunt-baseline-'));
		const runner: GitRunner = {
			run: async (args, cwd, options) => {
				const result = spawnSync('git', [...args], {
					cwd,
					env: { ...process.env, ...options?.envOverrides },
					encoding: 'utf8',
				});
				return {
					exitCode: result.status ?? 1,
					stdout: result.stdout ?? '',
					stderr: result.stderr ?? '',
				};
			},
		};
		const git = (...args: string[]) => {
			const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
			if (result.status !== 0) throw new Error(result.stderr);
			return result.stdout;
		};
		try {
			git('init', '-q');
			git('config', 'user.name', 'Tester');
			git('config', 'user.email', 'test@example.com');
			writeFileSync(join(repo, 'tracked.txt'), 'original\n');
			git('add', 'tracked.txt');
			git('commit', '-qm', 'initial');
			writeFileSync(join(repo, 'tracked.txt'), 'changed before dispatch\n');
			writeFileSync(join(repo, 'untracked.txt'), 'also before dispatch\n');
			const statusBefore = git('status', '--porcelain');
			const baseline = await readWorktreeStartingBaseline(repo, runner);
			expect(baseline.treeSha).not.toBe(git('rev-parse', 'HEAD^{tree}').trim());
			expect(git('status', '--porcelain')).toBe(statusBefore);
			expect((await readWorktreeStartingBaseline(repo, runner)).treeSha).toBe(baseline.treeSha);
			git('add', '-A');
			git('commit', '-qm', 'commit existing changes');
			expect((await readWorktreeStartingBaseline(repo, runner)).treeSha).toBe(baseline.treeSha);
			writeFileSync(join(repo, 'untracked.txt'), 'changed during bughunt\n');
			expect((await readWorktreeStartingBaseline(repo, runner)).treeSha).not.toBe(baseline.treeSha);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it('rejects a failed snapshot instead of falling back to HEAD', async () => {
		const { runner } = createMockRunner((args) => {
			if (args[0] === 'status') return { exitCode: 0, stdout: ' M tracked.txt\0', stderr: '' };
			if (args[0] === 'add') return { exitCode: 1, stdout: '', stderr: 'cannot stage' };
			return { exitCode: 0, stdout: 'a'.repeat(40), stderr: '' };
		});
		await expect(readWorktreeStartingBaseline('/repo/test', runner)).rejects.toThrow(
			'Cannot stage worktree snapshot',
		);
	});
});
