import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { takePlatformHostInputs } from '../../src/platform/host.ts';
import { resolveExecutable } from '../../src/platform/resolve-executable.ts';
import {
	type GitCommandResult,
	type GitRunner,
	countTextLines,
	detectRemotePush,
	formatUntrackedPatch,
	getDiffStat,
	getDiffText,
	inspectWorktreeDiff,
	isBinaryBuffer,
	parseNameStatus,
	parseNumstat,
	parsePorcelainStatus,
} from '../../src/workspace/diff.ts';
import { createDefaultGitRunner } from '../../src/workspace/worktree.ts';

function createMockGitRunner(
	handler: (args: readonly string[], cwd: string) => GitCommandResult | Promise<GitCommandResult>,
): GitRunner {
	return {
		run: (args, cwd) => Promise.resolve(handler(args, cwd)),
	};
}

describe('M5-T3 Diff Reading and Changed File Count', () => {
	describe('Pure Parsing and Utility Functions', () => {
		it('countTextLines counts lines correctly without trailing newline off-by-one', () => {
			expect(countTextLines('')).toBe(0);
			expect(countTextLines('\n')).toBe(0);
			expect(countTextLines('\r\n')).toBe(0);
			expect(countTextLines('hello')).toBe(1);
			expect(countTextLines('hello\n')).toBe(1);
			expect(countTextLines('hello\r\n')).toBe(1);
			expect(countTextLines('hello\nworld')).toBe(2);
			expect(countTextLines('hello\nworld\n')).toBe(2);
			expect(countTextLines('hello\r\nworld\r\n')).toBe(2);
			expect(countTextLines('line 1\nline 2\nline 3\n')).toBe(3);
		});

		it('isBinaryBuffer detects null bytes within first 8000 bytes', () => {
			const textBuffer = new TextEncoder().encode('normal text without nulls');
			expect(isBinaryBuffer(textBuffer)).toBe(false);

			const binaryBuffer = new Uint8Array([104, 101, 108, 0, 108, 111]);
			expect(isBinaryBuffer(binaryBuffer)).toBe(true);
		});

		it('parsePorcelainStatus parses newline-delimited output', () => {
			const raw = `
 M modified.ts
M  staged.ts
MM staged-and-unstaged.ts
A  added.ts
 D deleted.ts
R  old.ts -> new.ts
?? untracked.ts
`;
			const results = parsePorcelainStatus(raw);
			expect(results).toHaveLength(7);
			expect(results[0]).toEqual({ path: 'modified.ts', status: 'modified' });
			expect(results[1]).toEqual({ path: 'staged.ts', status: 'modified' });
			expect(results[2]).toEqual({
				path: 'staged-and-unstaged.ts',
				status: 'modified',
			});
			expect(results[3]).toEqual({ path: 'added.ts', status: 'added' });
			expect(results[4]).toEqual({ path: 'deleted.ts', status: 'deleted' });
			expect(results[5]).toEqual({
				path: 'new.ts',
				status: 'renamed',
				oldPath: 'old.ts',
			});
			expect(results[6]).toEqual({ path: 'untracked.ts', status: 'untracked' });
		});

		it('parsePorcelainStatus parses NUL-delimited (-z) output with renames and spaces', () => {
			const raw =
				' M file with space.ts\x00A  added.ts\x00R  renamed.ts\x00old-file.ts\x00?? new-file.ts\x00';
			const results = parsePorcelainStatus(raw);
			expect(results).toHaveLength(4);
			expect(results[0]).toEqual({
				path: 'file with space.ts',
				status: 'modified',
			});
			expect(results[1]).toEqual({ path: 'added.ts', status: 'added' });
			expect(results[2]).toEqual({
				path: 'renamed.ts',
				status: 'renamed',
				oldPath: 'old-file.ts',
			});
			expect(results[3]).toEqual({ path: 'new-file.ts', status: 'untracked' });
		});

		it('parseNumstat parses standard newline output including renames and binary files', () => {
			const raw = `
10\t5\tsrc/modified.ts
-\t-\tassets/image.png
1\t0\t{old => new}/file.ts
`;
			const map = parseNumstat(raw);
			expect(map.size).toBe(3);

			const mod = map.get('src/modified.ts');
			expect(mod).toEqual({ insertions: 10, deletions: 5, binary: false });

			const img = map.get('assets/image.png');
			expect(img).toEqual({ insertions: 0, deletions: 0, binary: true });

			const ren = map.get('new/file.ts');
			expect(ren).toEqual({
				insertions: 1,
				deletions: 0,
				binary: false,
				oldPath: 'old/file.ts',
			});
		});

		it('parseNumstat parses NUL-delimited (-z) output including renames', () => {
			const raw = '12\t3\tsrc/app.ts\x000\t0\t\x00old-path.ts\x00new-path.ts\x00-\t-\tlogo.ico\x00';
			const map = parseNumstat(raw);
			expect(map.size).toBe(3);
			expect(map.get('src/app.ts')).toEqual({
				insertions: 12,
				deletions: 3,
				binary: false,
			});
			expect(map.get('new-path.ts')).toEqual({
				insertions: 0,
				deletions: 0,
				binary: false,
				oldPath: 'old-path.ts',
			});
			expect(map.get('logo.ico')).toEqual({
				insertions: 0,
				deletions: 0,
				binary: true,
			});
		});

		it('parseNameStatus parses both newline and -z formats', () => {
			const lineFormat = 'M\tsrc/a.ts\nA\tsrc/b.ts\nD\tsrc/c.ts\nR100\told.ts\tnew.ts';
			const map1 = parseNameStatus(lineFormat);
			expect(map1.get('src/a.ts')?.status).toBe('modified');
			expect(map1.get('src/b.ts')?.status).toBe('added');
			expect(map1.get('src/c.ts')?.status).toBe('deleted');
			expect(map1.get('new.ts')).toEqual({
				status: 'renamed',
				oldPath: 'old.ts',
			});

			const zFormat =
				'M\x00src/a.ts\x00A\x00src/b.ts\x00D\x00src/c.ts\x00R100\x00old.ts\x00new.ts\x00';
			const map2 = parseNameStatus(zFormat);
			expect(map2.get('src/a.ts')?.status).toBe('modified');
			expect(map2.get('src/b.ts')?.status).toBe('added');
			expect(map2.get('src/c.ts')?.status).toBe('deleted');
			expect(map2.get('new.ts')).toEqual({
				status: 'renamed',
				oldPath: 'old.ts',
			});
		});

		it('formatUntrackedPatch generates standard git unified diff format', () => {
			const textPatch = formatUntrackedPatch('src/test.txt', 'line 1\nline 2', false);
			expect(textPatch).toContain('diff --git a/src/test.txt b/src/test.txt');
			expect(textPatch).toContain('new file mode 100644');
			expect(textPatch).toContain('--- /dev/null');
			expect(textPatch).toContain('+++ b/src/test.txt');
			expect(textPatch).toContain('+line 1');
			expect(textPatch).toContain('+line 2');

			const binPatch = formatUntrackedPatch('icon.png', '', true);
			expect(binPatch).toContain('Binary files /dev/null and b/icon.png differ');
		});
	});

	describe('AC 1: Changed file count derived from git worktree diff across all 4 agents', () => {
		it('computes changedFileCount and diffStat without parsing agent tool events', async () => {
			const testDir = mkdtempSync(join(tmpdir(), 'sched-diff-ac1-'));
			try {
				// Create an untracked file
				writeFileSync(join(testDir, 'untracked.ts'), 'export const x = 1;\nexport const y = 2;\n');

				const mockRunner = createMockGitRunner((args, cwd) => {
					expect(cwd).toBe(resolve(testDir));

					if (args[0] === 'rev-parse') {
						return { exitCode: 0, stdout: 'true', stderr: '' };
					}
					if (args[0] === 'status') {
						return {
							exitCode: 0,
							stdout: ' M src/index.ts\x00A  src/added.ts\x00?? untracked.ts\x00',
							stderr: '',
						};
					}
					if (args[0] === 'diff' && args[1] === '--numstat') {
						return {
							exitCode: 0,
							stdout: '5\t2\tsrc/index.ts\x0010\t0\tsrc/added.ts\x00',
							stderr: '',
						};
					}
					if (args[0] === 'diff' && args[1] === '--name-status') {
						return {
							exitCode: 0,
							stdout: 'M\x00src/index.ts\x00A\x00src/added.ts\x00',
							stderr: '',
						};
					}
					return { exitCode: 0, stdout: '', stderr: '' };
				});

				// Four agents (codex, claude, grok, pi) invoke the exact same function
				for (const _agent of ['codex', 'claude', 'grok', 'pi'] as const) {
					const stat = await getDiffStat({
						worktreePath: testDir,
						runner: mockRunner,
					});

					expect(stat.hasChanges).toBe(true);
					expect(stat.filesChanged).toBe(3);
					expect(stat.changedFileCount).toBe(3);
					expect(stat.insertions).toBe(5 + 10 + 2); // 5 from index.ts, 10 from added.ts, 2 from untracked.ts
					expect(stat.deletions).toBe(2);

					const untrackedFile = stat.files.find((f) => f.path === 'untracked.ts');
					expect(untrackedFile).toBeDefined();
					expect(untrackedFile?.status).toBe('untracked');
					expect(untrackedFile?.insertions).toBe(2);
					expect(untrackedFile?.deletions).toBe(0);
				}
			} finally {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it('getDiffText returns unified diff patch combining git diff and untracked files', async () => {
			const testDir = mkdtempSync(join(tmpdir(), 'sched-diff-text-'));
			try {
				writeFileSync(join(testDir, 'new-file.txt'), 'hello world\n');

				const mockRunner = createMockGitRunner((args) => {
					if (args[0] === 'rev-parse') {
						return { exitCode: 0, stdout: 'true', stderr: '' };
					}
					if (args[0] === 'diff' && args[1] === 'HEAD') {
						return {
							exitCode: 0,
							stdout:
								'diff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-old\n+new\n',
							stderr: '',
						};
					}
					if (args[0] === 'status') {
						return {
							exitCode: 0,
							stdout: ' M tracked.txt\x00?? new-file.txt\x00',
							stderr: '',
						};
					}
					if (args[0] === 'diff' && args[1] === '--no-index') {
						return {
							exitCode: 1,
							stdout:
								'diff --git a/new-file.txt b/new-file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new-file.txt\n@@ -0,0 +1 @@\n+hello world\n',
							stderr: '',
						};
					}
					return { exitCode: 0, stdout: '', stderr: '' };
				});

				const diffText = await getDiffText(testDir, { runner: mockRunner });
				expect(diffText).toContain('diff --git a/tracked.txt b/tracked.txt');
				expect(diffText).toContain('+new');
				expect(diffText).toContain('diff --git a/new-file.txt b/new-file.txt');
				expect(diffText).toContain('+hello world');
			} finally {
				rmSync(testDir, { recursive: true, force: true });
			}
		});
	});

	describe('AC 2 & E-72: Diff baseline uses worktree own HEAD and isolates main worktree', () => {
		it('defaults baseline to HEAD and runs git strictly inside worktreePath', async () => {
			const testDir = mkdtempSync(join(tmpdir(), 'sched-diff-e72-'));
			try {
				let capturedCwd = '';
				let capturedBaseRef = '';

				const mockRunner = createMockGitRunner((args, cwd) => {
					capturedCwd = cwd;
					if (args[0] === 'rev-parse') {
						return { exitCode: 0, stdout: 'true', stderr: '' };
					}
					if (args[0] === 'status') {
						return { exitCode: 0, stdout: '', stderr: '' };
					}
					if (args[0] === 'diff' && args[1] === '--numstat') {
						capturedBaseRef = args[3] ?? '';
						return { exitCode: 0, stdout: '', stderr: '' };
					}
					return { exitCode: 0, stdout: '', stderr: '' };
				});

				const stat = await getDiffStat(testDir, { runner: mockRunner });
				expect(capturedCwd).toBe(resolve(testDir));
				expect(capturedBaseRef).toBe('HEAD');
				expect(stat.baseline).toBe('HEAD');
				expect(stat.hasChanges).toBe(false);
				expect(stat.filesChanged).toBe(0);
			} finally {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it('allows explicit custom baseRef while maintaining worktree path confinement', async () => {
			const testDir = mkdtempSync(join(tmpdir(), 'sched-diff-base-'));
			try {
				let capturedBaseRef = '';
				const mockRunner = createMockGitRunner((args) => {
					if (args[0] === 'rev-parse') {
						return { exitCode: 0, stdout: 'true', stderr: '' };
					}
					if (args[0] === 'status') {
						return { exitCode: 0, stdout: '', stderr: '' };
					}
					if (args[0] === 'diff' && args[1] === '--numstat') {
						capturedBaseRef = args[3] ?? '';
						return {
							exitCode: 0,
							stdout: '4\t1\tsrc/feature.ts\x00',
							stderr: '',
						};
					}
					if (args[0] === 'diff' && args[1] === '--name-status') {
						return {
							exitCode: 0,
							stdout: 'M\x00src/feature.ts\x00',
							stderr: '',
						};
					}
					return { exitCode: 0, stdout: '', stderr: '' };
				});

				const stat = await getDiffStat({
					worktreePath: testDir,
					baseRef: 'origin/main',
					runner: mockRunner,
				});

				expect(capturedBaseRef).toBe('origin/main');
				expect(stat.baseline).toBe('origin/main');
				expect(stat.filesChanged).toBe(1);
				expect(stat.insertions).toBe(4);
				expect(stat.deletions).toBe(1);
			} finally {
				rmSync(testDir, { recursive: true, force: true });
			}
		});
	});

	describe('AC 3 & E-75: Unintercepted commits and remote push detection', () => {
		it('detectRemotePush returns pushed: false when no remote tracking ref exists', async () => {
			const testDir = mkdtempSync(join(tmpdir(), 'sched-diff-push-false-'));
			try {
				const mockRunner = createMockGitRunner((args) => {
					if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
						return { exitCode: 0, stdout: 'task/M5-T3', stderr: '' };
					}
					if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
						return {
							exitCode: 0,
							stdout: '1111222233334444555566667777888899990000',
							stderr: '',
						};
					}
					if (args[0] === 'for-each-ref') {
						// Only origin/main exists
						return {
							exitCode: 0,
							stdout: 'refs/remotes/origin/main 0000111122223333444455556666777788889999\n',
							stderr: '',
						};
					}
					if (args[0] === 'branch' && args[1] === '-r') {
						return { exitCode: 0, stdout: '', stderr: '' };
					}
					return { exitCode: 0, stdout: '', stderr: '' };
				});

				const detection = await detectRemotePush(testDir, { runner: mockRunner });
				expect(detection.pushed).toBe(false);
			} finally {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it('detectRemotePush detects when agent pushed branch to remote (E-75)', async () => {
			const testDir = mkdtempSync(join(tmpdir(), 'sched-diff-push-true-'));
			try {
				const commitSha = 'aabbccddeeff00112233445566778899aabbccdd';
				const mockRunner = createMockGitRunner((args) => {
					if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
						return { exitCode: 0, stdout: 'task/M5-T3\n', stderr: '' };
					}
					if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
						return { exitCode: 0, stdout: commitSha, stderr: '' };
					}
					if (args[0] === 'for-each-ref') {
						return {
							exitCode: 0,
							stdout: `refs/remotes/origin/main 00001111\nrefs/remotes/origin/task/M5-T3 ${commitSha}\n`,
							stderr: '',
						};
					}
					return { exitCode: 0, stdout: '', stderr: '' };
				});

				const detection = await detectRemotePush(testDir, { runner: mockRunner });
				expect(detection.pushed).toBe(true);
				expect(detection.branch).toBe('task/M5-T3');
				expect(detection.commit).toBe(commitSha);
				expect(detection.remote).toBe('origin');
				expect(detection.remoteRef).toBe('refs/remotes/origin/task/M5-T3');
				expect(detection.details).toContain('task/M5-T3');
			} finally {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it('detectRemotePush detects push when HEAD is contained in a remote branch', async () => {
			const testDir = mkdtempSync(join(tmpdir(), 'sched-diff-push-contains-'));
			try {
				const commitSha = 'deadbeef1234567890abcdef1234567890abcdef';
				const baseSha = '1111222233334444555566667777888899990000';

				const mockRunner = createMockGitRunner((args) => {
					if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
						return { exitCode: 0, stdout: 'task/custom-feat\n', stderr: '' };
					}
					if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
						return { exitCode: 0, stdout: commitSha, stderr: '' };
					}
					if (args[0] === 'rev-parse' && args[1] === 'main') {
						return { exitCode: 0, stdout: baseSha, stderr: '' };
					}
					if (args[0] === 'for-each-ref') {
						return {
							exitCode: 0,
							stdout: `refs/remotes/upstream/main ${baseSha}\n`,
							stderr: '',
						};
					}
					if (args[0] === 'branch' && args[1] === '-r' && args[2] === '--contains') {
						return {
							exitCode: 0,
							stdout: '  origin/feature-pushed-by-agent\n',
							stderr: '',
						};
					}
					return { exitCode: 0, stdout: '', stderr: '' };
				});

				const detection = await detectRemotePush(testDir, {
					runner: mockRunner,
					baseRef: 'main',
				});

				expect(detection.pushed).toBe(true);
				expect(detection.branch).toBe('feature-pushed-by-agent');
				expect(detection.commit).toBe(commitSha);
				expect(detection.remote).toBe('origin');
				expect(detection.remoteRef).toBe('refs/remotes/origin/feature-pushed-by-agent');
			} finally {
				rmSync(testDir, { recursive: true, force: true });
			}
		});

		it('inspectWorktreeDiff aggregates diffStat, diffText, and remotePush', async () => {
			const testDir = mkdtempSync(join(tmpdir(), 'sched-diff-inspect-'));
			try {
				const mockRunner = createMockGitRunner((args) => {
					if (args[0] === 'rev-parse') {
						return { exitCode: 0, stdout: 'true', stderr: '' };
					}
					if (args[0] === 'status') {
						return { exitCode: 0, stdout: ' M src/a.ts\x00', stderr: '' };
					}
					if (args[0] === 'diff' && args[1] === '--numstat') {
						return { exitCode: 0, stdout: '2\t1\tsrc/a.ts\x00', stderr: '' };
					}
					if (args[0] === 'diff' && args[1] === '--name-status') {
						return { exitCode: 0, stdout: 'M\x00src/a.ts\x00', stderr: '' };
					}
					if (args[0] === 'diff' && args[1] === 'HEAD') {
						return {
							exitCode: 0,
							stdout: 'diff --git a/src/a.ts b/src/a.ts\n',
							stderr: '',
						};
					}
					if (args[0] === 'for-each-ref') {
						return { exitCode: 0, stdout: '', stderr: '' };
					}
					return { exitCode: 0, stdout: '', stderr: '' };
				});

				const inspection = await inspectWorktreeDiff(testDir, {
					runner: mockRunner,
				});
				expect(inspection.hasChanges).toBe(true);
				expect(inspection.changedFileCount).toBe(1);
				expect(inspection.diffStat.filesChanged).toBe(1);
				expect(inspection.diffText).toContain('diff --git a/src/a.ts b/src/a.ts');
				expect(inspection.remotePush.pushed).toBe(false);
			} finally {
				rmSync(testDir, { recursive: true, force: true });
			}
		});
	});

	describe('Error Boundaries and Edge Cases', () => {
		it('throws E_WORKSPACE_UNAVAILABLE when worktree path does not exist', async () => {
			await expect(getDiffStat('/path/that/definitely/does/not/exist/99999')).rejects.toMatchObject(
				{
					code: 'E_WORKSPACE_UNAVAILABLE',
				},
			);
		});

		it('throws E_NOT_A_GIT_REPO when directory is not inside a git repository (E-69)', async () => {
			const nonGitDir = mkdtempSync(join(tmpdir(), 'sched-non-git-'));
			try {
				const mockRunner = createMockGitRunner(() => {
					return {
						exitCode: 128,
						stdout: '',
						stderr: 'fatal: not a git repository (or any of the parent directories): .git',
					};
				});

				await expect(getDiffStat(nonGitDir, { runner: mockRunner })).rejects.toMatchObject({
					code: 'E_NOT_A_GIT_REPO',
				});
			} finally {
				rmSync(nonGitDir, { recursive: true, force: true });
			}
		});
	});

	describe('End-to-End Real Git Integration (AC 1, AC 2, AC 3, E-72, E-75)', () => {
		it('executes getDiffStat, getDiffText, and detectRemotePush on a real git worktree', async (ctx) => {
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

			const tempBase = mkdtempSync(join(tmpdir(), 'sched-diff-real-'));
			const remoteRepo = join(tempBase, 'remote.git');
			const mainRepo = join(tempBase, 'main-repo');
			const worktreePath = join(tempBase, 'task-wt');

			const runner = createDefaultGitRunner({
				platform: hostInputs.platform,
				gitBinary: gitExecutable,
				ids: { newId: () => 'e2e-git' },
			});

			try {
				// 1. Initialize bare remote and local clone
				await runner.run(['init', '--bare'], remoteRepo);
				await runner.run(['init'], mainRepo);
				await runner.run(['checkout', '-B', 'main'], mainRepo);
				await runner.run(['config', 'user.name', 'test'], mainRepo);
				await runner.run(['config', 'user.email', 'test@example.com'], mainRepo);
				await runner.run(['remote', 'add', 'origin', remoteRepo], mainRepo);

				// 2. Create initial commit and push to remote
				writeFileSync(join(mainRepo, 'initial.txt'), 'line 1\nline 2\n');
				await runner.run(['add', 'initial.txt'], mainRepo);
				await runner.run(['commit', '-m', 'initial commit'], mainRepo);
				await runner.run(['push', '-u', 'origin', 'main'], mainRepo);

				// 3. Create independent task worktree
				await runner.run(['worktree', 'add', '-b', 'task/M5-T3', worktreePath, 'main'], mainRepo);

				// Verify clean worktree initially has 0 diff
				const initialStat = await getDiffStat(worktreePath, { runner });
				expect(initialStat.hasChanges).toBe(false);
				expect(initialStat.filesChanged).toBe(0);
				expect(initialStat.insertions).toBe(0);
				expect(initialStat.deletions).toBe(0);

				const initialDiff = await getDiffText(worktreePath, { runner });
				expect(initialDiff).toBe('');

				// 4. AC 1: Modify a tracked file and add an untracked file in the worktree
				writeFileSync(join(worktreePath, 'initial.txt'), 'line 1\nmodified line 2\nline 3\n');
				writeFileSync(join(worktreePath, 'untracked.txt'), 'untracked 1\nuntracked 2\n');

				const statWithChanges = await getDiffStat(worktreePath, { runner });
				expect(statWithChanges.hasChanges).toBe(true);
				expect(statWithChanges.filesChanged).toBe(2);
				expect(statWithChanges.insertions).toBeGreaterThanOrEqual(3);

				const diffTextWithChanges = await getDiffText(worktreePath, { runner });
				expect(diffTextWithChanges).toContain('initial.txt');
				expect(diffTextWithChanges).toContain('+modified line 2');
				expect(diffTextWithChanges).toContain('untracked.txt');
				expect(diffTextWithChanges).toContain('+untracked 1');

				// 5. AC 2 & E-72: User modifies main working tree with uncommitted changes
				writeFileSync(join(mainRepo, 'initial.txt'), 'MAIN REPO UNCOMMITTED CONFLICTING CHANGE\n');
				writeFileSync(join(mainRepo, 'main-untracked.txt'), 'user personal scratchpad\n');

				// Worktree diff must be completely isolated and must NOT contain main repo changes
				const isolatedStat = await getDiffStat(worktreePath, { runner });
				expect(isolatedStat.filesChanged).toBe(2);
				expect(isolatedStat.files.some((f) => f.path.includes('main-untracked'))).toBe(false);

				const isolatedDiff = await getDiffText(worktreePath, { runner });
				expect(isolatedDiff).not.toContain('MAIN REPO UNCOMMITTED');
				expect(isolatedDiff).not.toContain('main-untracked');

				// 6. AC 3 & E-75: Remote push detection
				// Before push: pushed is false
				const beforePush = await detectRemotePush(worktreePath, { runner });
				expect(beforePush.pushed).toBe(false);

				// Agent commits and pushes in worktree
				await runner.run(['add', '.'], worktreePath);
				await runner.run(['commit', '-m', 'agent commit on branch'], worktreePath);
				await runner.run(['push', 'origin', 'task/M5-T3'], worktreePath);

				// After push: detectRemotePush returns pushed: true with details
				const afterPush = await detectRemotePush(worktreePath, { runner });
				expect(afterPush.pushed).toBe(true);
				expect(afterPush.branch).toBe('task/M5-T3');
				expect(afterPush.remote).toBe('origin');
				expect(afterPush.commit).toBeDefined();
				expect(afterPush.remoteRef).toContain('task/M5-T3');
			} finally {
				rmSync(tempBase, { recursive: true, force: true });
			}
		});
	});
});
