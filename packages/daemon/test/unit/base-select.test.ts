import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.ts';
import {
	type BaseSelectorDeps,
	type UpstreamTaskInfo,
	checkAgentConcurrency,
	checkUpstreamBranchInHead,
	createBaseSelector,
	prepareTaskWorkspace,
	resolveTaskBase,
	validateUpstreamOutputs,
} from '../../src/workspace/base-select.ts';
import type { GitCommandResult, GitRunner } from '../../src/workspace/worktree.ts';

function createMockGitRunner(
	handler: (args: readonly string[], cwd: string) => GitCommandResult | Promise<GitCommandResult>,
): GitRunner {
	return {
		run: (args, cwd) => Promise.resolve(handler(args, cwd)),
	};
}

describe('M5-T2 Base Selection and Upstream Output Validation', () => {
	describe('checkUpstreamBranchInHead (E-70, E-273, E-301, E-289)', () => {
		it('detects merged upstream when branch is ancestor of HEAD (ancestor)', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse' && args[3] === 'refs/heads/task/M1-T1') {
					return { exitCode: 0, stdout: 'sha_m1t1\n', stderr: '' };
				}
				if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await checkUpstreamBranchInHead(
				'/repo',
				{ taskId: 'M1-T1', branchName: 'task/M1-T1' },
				runner,
			);

			expect(result.isInHead).toBe(true);
			expect(result.method).toBe('ancestor');
			expect(result.tipSha).toBe('sha_m1t1');
		});

		it('detects squash-merged upstream via diff --quiet HEAD fallback when merge-base fails (E-273 no_diff)', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse' && args[3] === 'refs/heads/task/M1-T1') {
					return { exitCode: 0, stdout: 'sha_m1t1\n', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					// Squash merge: ancestor check returns exit 1
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				if (args[0] === 'diff' && args[1] === '--quiet') {
					// No diff between HEAD and squash-merged branch
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await checkUpstreamBranchInHead(
				'/repo',
				{ taskId: 'M1-T1', branchName: 'task/M1-T1' },
				runner,
			);

			expect(result.isInHead).toBe(true);
			expect(result.method).toBe('no_diff');
			expect(result.tipSha).toBe('sha_m1t1');
		});

		it('reports unmerged when branch commits and diff both indicate unlanded changes (E-70 unmerged)', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse' && args[3] === 'refs/heads/task/M1-T1') {
					return { exitCode: 0, stdout: 'sha_m1t1\n', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				if (args[0] === 'diff' && args[1] === '--quiet') {
					// Diff non-empty: changes have not landed into HEAD
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await checkUpstreamBranchInHead(
				'/repo',
				{ taskId: 'M1-T1', branchName: 'task/M1-T1' },
				runner,
			);

			expect(result.isInHead).toBe(false);
			expect(result.method).toBe('unmerged');
			expect(result.reason).toContain('changes not merged into HEAD');
		});

		it('detects dirty worktree and marks not in HEAD before checking git refs (E-301 dirty_worktree)', async () => {
			const runner = createMockGitRunner((args, cwd) => {
				if (args[0] === 'status' && cwd === '/worktrees/m1-t1') {
					return { exitCode: 0, stdout: ' M src/dirty.ts\n?? new.ts\n', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await checkUpstreamBranchInHead(
				'/repo',
				{
					taskId: 'M1-T1',
					branchName: 'task/M1-T1',
					worktreePath: '/worktrees/m1-t1',
				},
				runner,
			);

			expect(result.isInHead).toBe(false);
			expect(result.method).toBe('dirty_worktree');
			expect(result.reason).toContain('2 uncommitted file change(s)');
		});

		it('reports error and retains stderr tail when git command fails unexpectedly (E-301 error)', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') {
					return { exitCode: 0, stdout: 'sha_m1t1\n', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					return {
						exitCode: 128,
						stdout: '',
						stderr: 'fatal: error reading object 1234567890abcdef',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await checkUpstreamBranchInHead(
				'/repo',
				{ taskId: 'M1-T1', branchName: 'task/M1-T1' },
				runner,
			);

			expect(result.isInHead).toBe(false);
			expect(result.method).toBe('error');
			expect(result.stderrTail).toContain('fatal: error reading object');
		});

		it('uses tipSha to verify merge when local branch is gone (E-289 ancestor / branch_gone_unmerged)', async () => {
			// Scenario A: branch gone locally, tipSha is ancestor of HEAD
			const runnerAncestor = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse' && args[3]?.startsWith('refs/heads/')) {
					return { exitCode: 1, stdout: '', stderr: 'unknown ref' };
				}
				if (args[0] === 'rev-parse' && args[3] === 'sha_tip_123') {
					return { exitCode: 0, stdout: 'sha_tip_123\n', stderr: '' };
				}
				if (args[0] === 'merge-base' && args[2] === 'sha_tip_123') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const resAncestor = await checkUpstreamBranchInHead(
				'/repo',
				{ taskId: 'M1-T1', branchName: 'task/M1-T1', tipSha: 'sha_tip_123' },
				runnerAncestor,
			);
			expect(resAncestor.isInHead).toBe(true);
			expect(resAncestor.method).toBe('ancestor');

			// Scenario B: branch gone locally, tipSha is NOT in HEAD -> branch_gone_unmerged
			const runnerUnmerged = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse' && args[3]?.startsWith('refs/heads/')) {
					return { exitCode: 1, stdout: '', stderr: 'unknown ref' };
				}
				if (args[0] === 'rev-parse' && args[3] === 'sha_tip_123') {
					return { exitCode: 0, stdout: 'sha_tip_123\n', stderr: '' };
				}
				if (args[0] === 'merge-base' || args[0] === 'diff') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const resUnmerged = await checkUpstreamBranchInHead(
				'/repo',
				{ taskId: 'M1-T1', branchName: 'task/M1-T1', tipSha: 'sha_tip_123' },
				runnerUnmerged,
			);
			expect(resUnmerged.isInHead).toBe(false);
			expect(resUnmerged.method).toBe('branch_gone_unmerged');
			expect(resUnmerged.commandText).toBe('git branch task/M1-T1 sha_tip_123');
		});

		it('treats landed task with deleted branch as landed into HEAD (E-289 branch_gone)', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') {
					return { exitCode: 1, stdout: '', stderr: 'unknown ref' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await checkUpstreamBranchInHead(
				'/repo',
				{ taskId: 'M1-T1', branchName: 'task/M1-T1', isLanded: true },
				runner,
			);

			expect(result.isInHead).toBe(true);
			expect(result.method).toBe('branch_gone');
		});

		it('reports branch_missing when branch does not exist and task is not landed', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') {
					return { exitCode: 1, stdout: '', stderr: 'unknown ref' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const result = await checkUpstreamBranchInHead(
				'/repo',
				{ taskId: 'M1-T1', branchName: 'task/M1-T1', isLanded: false },
				runner,
			);

			expect(result.isInHead).toBe(false);
			expect(result.method).toBe('branch_missing');
		});
	});

	describe('validateUpstreamOutputs', () => {
		it('returns allLanded: true when all upstream tasks are landed in HEAD', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'sha\n', stderr: '' };
				if (args[0] === 'merge-base') return { exitCode: 0, stdout: '', stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const tasks: UpstreamTaskInfo[] = [
				{ taskId: 'M1-T1', branchName: 'task/M1-T1' },
				{ taskId: 'M1-T2', branchName: 'task/M1-T2' },
			];

			const outcome = await validateUpstreamOutputs('/repo', tasks, runner);
			expect(outcome.allLanded).toBe(true);
			expect(outcome.unmergedUpstreams).toHaveLength(0);
		});

		it('returns allLanded: false and lists unmerged upstreams when any output is missing', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'sha\n', stderr: '' };
				if (args[0] === 'merge-base') {
					// M1-T1 is merged, M1-T2 is not merged
					const isM1T1 = args[2] === 'refs/heads/task/M1-T1';
					return { exitCode: isM1T1 ? 0 : 1, stdout: '', stderr: '' };
				}
				if (args[0] === 'diff') return { exitCode: 1, stdout: '', stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const tasks: UpstreamTaskInfo[] = [
				{ taskId: 'M1-T1', branchName: 'task/M1-T1' },
				{ taskId: 'M1-T2', branchName: 'task/M1-T2' },
			];

			const outcome = await validateUpstreamOutputs('/repo', tasks, runner);
			expect(outcome.allLanded).toBe(false);
			expect(outcome.unmergedUpstreams).toHaveLength(1);
			expect(outcome.unmergedUpstreams[0]?.taskId).toBe('M1-T2');
		});
	});

	describe('resolveTaskBase AC 1 & AC 2 (E-70)', () => {
		it('AC 1 & E-70: rejects dispatch with E_UPSTREAM_BASE_MISSING when upstream is not in HEAD and baseRef is head', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'sha\n', stderr: '' };
				if (args[0] === 'merge-base' || args[0] === 'diff')
					return { exitCode: 1, stdout: '', stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			let caughtError: AppError | undefined;
			try {
				await resolveTaskBase(
					{
						repoPath: '/repo',
						taskId: 'M5-T2',
						upstreamTasks: [{ taskId: 'M5-T1', branchName: 'task/M5-T1' }],
						baseRef: { kind: 'head' },
					},
					runner,
				);
			} catch (err) {
				caughtError = err as AppError;
			}

			expect(caughtError).toBeInstanceOf(AppError);
			expect(caughtError?.code).toBe('E_UPSTREAM_BASE_MISSING');
			expect(caughtError?.message).toContain('base is missing upstream output');
			const details = caughtError?.details as Record<string, unknown>;
			expect(details.reason).toBe('下游 base 缺上游产出');
			expect(Array.isArray(details.unmergedUpstreams)).toBe(true);

			// AC 2: provides explicit option to base on upstream branch
			const available = details.availableUpstreamBases as Array<{
				kind: string;
				taskKey: string;
				branchName: string;
				label: string;
			}>;
			expect(available).toHaveLength(1);
			expect(available[0]?.kind).toBe('upstreamBranch');
			expect(available[0]?.taskKey).toBe('M5-T1');
			expect(available[0]?.branchName).toBe('task/M5-T1');
			expect(available[0]?.label).toContain('以上游任务分支 task/M5-T1 为 base 建 worktree');
		});

		it('AC 1 & E-70: defaults baseRef to head when omitted and rejects missing upstream output', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'sha\n', stderr: '' };
				if (args[0] === 'merge-base' || args[0] === 'diff')
					return { exitCode: 1, stdout: '', stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			await expect(
				resolveTaskBase(
					{
						repoPath: '/repo',
						taskId: 'M5-T2',
						upstreamTasks: [{ taskId: 'M5-T1', branchName: 'task/M5-T1' }],
						// baseRef omitted -> defaults to head
					},
					runner,
				),
			).rejects.toThrow(
				expect.objectContaining({
					code: 'E_UPSTREAM_BASE_MISSING',
				}),
			);
		});

		it('AC 2 & E-70: allows explicit upstreamBranch baseRef and resolves to upstream branch without error', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse' && args[3] === 'refs/heads/task/M5-T1') {
					return { exitCode: 0, stdout: 'sha_m5t1\n', stderr: '' };
				}
				if (args[0] === 'merge-base' || args[0] === 'diff') {
					// Not in HEAD!
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const resolution = await resolveTaskBase(
				{
					repoPath: '/repo',
					taskId: 'M5-T2',
					upstreamTasks: [{ taskId: 'M5-T1', branchName: 'task/M5-T1' }],
					baseRef: {
						kind: 'upstreamBranch',
						taskKey: 'M5-T1',
					},
				},
				runner,
			);

			expect(resolution.resolvedBase).toBe('task/M5-T1');
			expect(resolution.baseKind).toBe('upstreamBranch');
			expect(resolution.upstreamTaskId).toBe('M5-T1');
		});

		it('AC 2: automatically selects the single unmerged upstream when taskKey is omitted in upstreamBranch baseRef', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse' && args[3] === 'refs/heads/task/M5-T1') {
					return { exitCode: 0, stdout: 'sha_m5t1\n', stderr: '' };
				}
				if (args[0] === 'merge-base' || args[0] === 'diff') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const resolution = await resolveTaskBase(
				{
					repoPath: '/repo',
					taskId: 'M5-T2',
					upstreamTasks: [{ taskId: 'M5-T1', branchName: 'task/M5-T1' }],
					baseRef: {
						kind: 'upstreamBranch',
					},
				},
				runner,
			);

			expect(resolution.resolvedBase).toBe('task/M5-T1');
			expect(resolution.baseKind).toBe('upstreamBranch');
			expect(resolution.upstreamTaskId).toBe('M5-T1');
		});

		it('rejects upstreamBranch if specified taskKey is not an upstream dependency', async () => {
			const runner = createMockGitRunner(() => ({ exitCode: 0, stdout: '', stderr: '' }));

			await expect(
				resolveTaskBase(
					{
						repoPath: '/repo',
						taskId: 'M5-T2',
						upstreamTasks: [{ taskId: 'M5-T1', branchName: 'task/M5-T1' }],
						baseRef: {
							kind: 'upstreamBranch',
							taskKey: 'UNKNOWN-TASK',
						},
					},
					runner,
				),
			).rejects.toThrow(
				expect.objectContaining({
					code: 'E_VALIDATION',
				}),
			);
		});

		it('resolves base to HEAD when all upstream outputs are landed in HEAD', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'sha\n', stderr: '' };
				if (args[0] === 'merge-base') return { exitCode: 0, stdout: '', stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const resolution = await resolveTaskBase(
				{
					repoPath: '/repo',
					taskId: 'M5-T2',
					upstreamTasks: [{ taskId: 'M5-T1', branchName: 'task/M5-T1' }],
					baseRef: { kind: 'head' },
				},
				runner,
			);

			expect(resolution.resolvedBase).toBe('HEAD');
			expect(resolution.baseKind).toBe('head');
		});
	});

	describe('checkAgentConcurrency AC 3 & E-31', () => {
		it('permits dispatch when current active runs are below limit', () => {
			expect(() => checkAgentConcurrency('codex', 0, 2)).not.toThrow();
			expect(() => checkAgentConcurrency('codex', 1, 2)).not.toThrow();
		});

		it('AC 3 & E-31: throws E_AGENT_BUSY (429 retryable) when agent concurrency limit is reached', () => {
			let caughtError: AppError | undefined;
			try {
				checkAgentConcurrency('codex', 2, 2);
			} catch (err) {
				caughtError = err as AppError;
			}

			expect(caughtError).toBeInstanceOf(AppError);
			expect(caughtError?.code).toBe('E_AGENT_BUSY');
			expect(caughtError?.retryable).toBe(true);
			const details = caughtError?.details as Record<string, unknown>;
			expect(details.agentId).toBe('codex');
			expect(details.currentActiveRuns).toBe(2);
			expect(details.maxConcurrency).toBe(2);
		});

		it('throws E_AGENT_UNAVAILABLE when maxConcurrency is <= 0 (disabled agent)', () => {
			expect(() => checkAgentConcurrency('codex', 0, 0)).toThrow(
				expect.objectContaining({
					code: 'E_AGENT_UNAVAILABLE',
				}),
			);
			expect(() => checkAgentConcurrency('codex', 0, -1)).toThrow(
				expect.objectContaining({
					code: 'E_AGENT_UNAVAILABLE',
				}),
			);
		});
	});

	describe('prepareTaskWorkspace AC 3 & E-31', () => {
		it('AC 3 & E-31: grok uses native --worktree and receives isolated session and workspace', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'sha\n', stderr: '' };
				if (args[0] === 'merge-base') return { exitCode: 0, stdout: '', stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const deps: BaseSelectorDeps = {
				ids: { newId: () => 'uuid-123' },
			};

			const result = await prepareTaskWorkspace(
				{
					repoPath: '/repos/my-project',
					taskId: 'M5-T2',
					agentId: 'grok',
					currentActiveRuns: 0,
					maxConcurrency: 2,
				},
				runner,
				deps,
			);

			expect(result.strategy).toBe('agent_native');
			expect(result.sessionId).toBe('sess_uuid-123');
			expect(result.worktreePath).toContain('my-project-m5-t2');
			expect(result.nativeArgs).toEqual([
				'--worktree',
				result.worktreePath,
				'--worktree-ref',
				'HEAD',
			]);
		});

		it('AC 3 & E-31: non-grok agent uses git worktree fallback with independent session', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'true\n/repo\n', stderr: '' };
				if (args[0] === 'merge-base') return { exitCode: 0, stdout: '', stderr: '' };
				if (args[0] === 'worktree' && args[1] === 'list')
					return { exitCode: 0, stdout: '', stderr: '' };
				if (args[0] === 'for-each-ref') return { exitCode: 0, stdout: '', stderr: '' };
				if (args[0] === 'worktree' && args[1] === 'add') {
					return { exitCode: 0, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const deps: BaseSelectorDeps = {
				platform: 'linux',
				ids: { newId: () => 'sess-456' },
			};

			const result = await prepareTaskWorkspace(
				{
					repoPath: '/repos/my-project',
					taskId: 'M5-T2',
					agentId: 'codex',
					currentActiveRuns: 0,
					maxConcurrency: 2,
				},
				runner,
				deps,
			);

			expect(result.strategy).toBe('git_worktree');
			expect(result.sessionId).toBe('sess_sess-456');
			expect(result.branchName).toBe('task/M5-T2');
			expect(result.worktreePath).toBeDefined();
		});

		it('AC 3 & E-31: multiple tasks assigned to same agent obtain distinct sessions and workspaces', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'true\n/repo\n', stderr: '' };
				if (args[0] === 'merge-base') return { exitCode: 0, stdout: '', stderr: '' };
				if (args[0] === 'worktree' && args[1] === 'list')
					return { exitCode: 0, stdout: '', stderr: '' };
				if (args[0] === 'for-each-ref') return { exitCode: 0, stdout: '', stderr: '' };
				if (args[0] === 'worktree' && args[1] === 'add')
					return { exitCode: 0, stdout: '', stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			let idCounter = 1;
			const deps: BaseSelectorDeps = {
				platform: 'linux',
				ids: { newId: () => `id-${idCounter++}` },
			};

			// Task 1
			const res1 = await prepareTaskWorkspace(
				{
					repoPath: '/repos/my-project',
					taskId: 'M1-T1',
					agentId: 'codex',
					currentActiveRuns: 0,
					maxConcurrency: 3,
				},
				runner,
				deps,
			);

			// Task 2 concurrently to same agent
			const res2 = await prepareTaskWorkspace(
				{
					repoPath: '/repos/my-project',
					taskId: 'M1-T2',
					agentId: 'codex',
					currentActiveRuns: 1,
					maxConcurrency: 3,
				},
				runner,
				deps,
			);

			expect(res1.sessionId).not.toBe(res2.sessionId);
			expect(res1.worktreePath).not.toBe(res2.worktreePath);
			expect(res1.branchName).not.toBe(res2.branchName);
		});

		it('enforces concurrency limit and rejects 3rd task when limit is 2', async () => {
			const runner = createMockGitRunner(() => ({ exitCode: 0, stdout: '', stderr: '' }));
			const deps: BaseSelectorDeps = { ids: { newId: () => 'id' } };

			await expect(
				prepareTaskWorkspace(
					{
						repoPath: '/repo',
						taskId: 'M1-T3',
						agentId: 'codex',
						currentActiveRuns: 2,
						maxConcurrency: 2,
					},
					runner,
					deps,
				),
			).rejects.toThrow(
				expect.objectContaining({
					code: 'E_AGENT_BUSY',
				}),
			);
		});
	});

	describe('createBaseSelector factory', () => {
		it('creates a BaseSelector instance with all methods bound', async () => {
			const runner = createMockGitRunner((args) => {
				if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'sha\n', stderr: '' };
				if (args[0] === 'merge-base') return { exitCode: 0, stdout: '', stderr: '' };
				return { exitCode: 0, stdout: '', stderr: '' };
			});

			const selector = createBaseSelector({ gitRunner: runner });
			expect(typeof selector.checkUpstreamBranchInHead).toBe('function');
			expect(typeof selector.validateUpstreamOutputs).toBe('function');
			expect(typeof selector.resolveTaskBase).toBe('function');
			expect(typeof selector.checkAgentConcurrency).toBe('function');
			expect(typeof selector.prepareTaskWorkspace).toBe('function');

			const res = await selector.resolveTaskBase({
				repoPath: '/repo',
				taskId: 'M1-T1',
			});
			expect(res.resolvedBase).toBe('HEAD');
		});

		it('throws E_INTERNAL if operations are invoked without a GitRunner', async () => {
			const selector = createBaseSelector({});
			await expect(
				selector.resolveTaskBase({
					repoPath: '/repo',
					taskId: 'M1-T1',
				}),
			).rejects.toThrow(
				expect.objectContaining({
					code: 'E_INTERNAL',
				}),
			);
		});
	});
});
