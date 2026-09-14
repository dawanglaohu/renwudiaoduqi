import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_TRANSITION_REASONS } from '../../src/domain/run-state-machine.ts';
import { AppError } from '../../src/errors/app-error.ts';
import {
	COMMAND_FAILED_TAG,
	type CommandRunner,
	DEFAULT_CHECK_TIMEOUT_MS,
	EXIT_CODE_FAILED_TAG,
	KEYWORDS_MISSED_TAG,
	MECHANICAL_CHECK_PASSED_TAG,
	MECHANICAL_CHECK_TIMEOUT_TAG,
	MECHANICAL_COVERAGE_LIMITED_TAG,
	NO_CHANGES_TAG,
	type ReviewGatesRepo,
	type ReviewRunsRepo,
	SESSION_ERROR_TAG,
	assertWorktreeDirectory,
	createReviewService,
	extractAcceptanceKeywords,
	matchesAcceptanceKeywords,
	normalizeCommandSpec,
	parseCommandString,
	runMechanicalCheck,
} from '../../src/service/review.ts';
import type { DiffStatResult } from '../../src/workspace/diff.ts';

describe('M7-T1: Mechanical Check Two Layers and Execution Directory (AC 1-4, E-23, E-60, E-61, E-66, E-67)', () => {
	const tempDirs: string[] = [];
	let fakeWorktreeDir: string;
	let fakeMainRepoDir: string;

	beforeEach(() => {
		const baseDir = mkdtempSync(join(tmpdir(), 'ags-m7t1-review-test-'));
		tempDirs.push(baseDir);

		fakeWorktreeDir = join(baseDir, 'worktrees', 'task-m7-t1');
		fakeMainRepoDir = join(baseDir, 'main-repo');

		mkdirSync(fakeWorktreeDir, { recursive: true });
		mkdirSync(fakeMainRepoDir, { recursive: true });
	});

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup failures on Windows temp locks
			}
		}
	});

	function makeFakeDiffStat(hasChanges: boolean, filesChanged = 1): DiffStatResult {
		return Object.freeze({
			filesChanged: hasChanges ? filesChanged : 0,
			changedFileCount: hasChanges ? filesChanged : 0,
			insertions: hasChanges ? 42 : 0,
			deletions: hasChanges ? 10 : 0,
			hasChanges,
			baseline: 'HEAD',
			files: hasChanges
				? Object.freeze([
						{
							path: 'packages/daemon/src/service/review.ts',
							insertions: 42,
							deletions: 10,
							status: 'modified' as const,
						},
					])
				: Object.freeze([]),
		});
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 1: 零配置层恒执行与项目命令层留空跳过（明示「机械检查覆盖有限」E-60）
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 1 & E-60: Zero-config layer execution & limited coverage notice', () => {
		it('executes zero-config layer and when project commands are omitted, skips command layer and sets tag to 机械检查覆盖有限', async () => {
			const diffStat = makeFakeDiffStat(true);
			const diffText = '+export function runMechanicalCheck() {}\n// E-60 coverage limited';

			const result = await runMechanicalCheck({
				worktreePath: fakeWorktreeDir,
				mainRepoPath: fakeMainRepoDir,
				exitCode: 0,
				diffStat,
				diffText,
				acceptText: '1) 零配置层恒执行 E-60 2) 机械检查覆盖有限',
				projectCommands: [], // empty project commands
			});

			expect(result.passed).toBe(true);
			expect(result.targetState).toBe('reviewing');
			expect(result.tag).toBe(MECHANICAL_COVERAGE_LIMITED_TAG);
			expect(result.reason).toBe('zero_config_passed_limited_coverage');
			expect(result.canDispatchReviewAgent).toBe(true);
			expect(result.retryable).toBe(true);

			// Check zero config layer passed
			expect(result.zeroConfigLayer.passed).toBe(true);
			expect(result.zeroConfigLayer.diffCheck.passed).toBe(true);
			expect(result.zeroConfigLayer.exitCodeCheck.passed).toBe(true);
			expect(result.zeroConfigLayer.sessionErrorCheck.passed).toBe(true);
			expect(result.zeroConfigLayer.keywordsCheck.passed).toBe(true);

			// Check project command layer was skipped and marked limited
			expect(result.projectCommandLayer.executed).toBe(false);
			expect(result.projectCommandLayer.coverageLimited).toBe(true);
			expect(result.projectCommandLayer.notice).toBe(MECHANICAL_COVERAGE_LIMITED_TAG);
			expect(result.projectCommandLayer.commands.length).toBe(0);
		});

		it('treats whitespace-only project commands as empty and displays limited coverage notice (E-60)', async () => {
			const diffStat = makeFakeDiffStat(true);
			const diffText = '+const check = true; // E-60';

			const result = await runMechanicalCheck({
				worktreePath: fakeWorktreeDir,
				mainRepoPath: fakeMainRepoDir,
				exitCode: 0,
				diffStat,
				diffText,
				acceptText: 'E-60 zero-config',
				projectCommands: ['   ', ''],
			});

			expect(result.passed).toBe(true);
			expect(result.tag).toBe(MECHANICAL_COVERAGE_LIMITED_TAG);
			expect(result.projectCommandLayer.coverageLimited).toBe(true);
			expect(result.projectCommandLayer.executed).toBe(false);
		});

		it('fails zero-config layer when acceptance keywords are required but none are hit in diff', async () => {
			const diffStat = makeFakeDiffStat(true);
			// Diff does NOT contain any of the required keywords
			const diffText = '+const unrelated = 123;';

			const result = await runMechanicalCheck({
				worktreePath: fakeWorktreeDir,
				mainRepoPath: fakeMainRepoDir,
				exitCode: 0,
				diffStat,
				diffText,
				acceptText: '1) MUST contain SpecialFeatureX and E-999',
				projectCommands: [],
			});

			expect(result.passed).toBe(false);
			expect(result.targetState).toBe('awaiting_human');
			expect(result.tag).toBe(KEYWORDS_MISSED_TAG);
			expect(result.reason).toBe(RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED);
			expect(result.canDispatchReviewAgent).toBe(false);
			expect(result.zeroConfigLayer.keywordsCheck.passed).toBe(false);
			expect(result.zeroConfigLayer.keywordsCheck.requiredKeywords).toContain('E-999');
			expect(result.zeroConfigLayer.keywordsCheck.matchedKeywords.length).toBe(0);
		});

		it('matches keywords via explicit acceptanceKeywords array', async () => {
			const diffStat = makeFakeDiffStat(true);
			const diffText = '+const token = 1; // review-service hit';

			const result = await runMechanicalCheck({
				worktreePath: fakeWorktreeDir,
				mainRepoPath: fakeMainRepoDir,
				exitCode: 0,
				diffStat,
				diffText,
				acceptanceKeywords: ['review-service', 'unmatched-term'],
				projectCommands: [],
			});

			expect(result.passed).toBe(true);
			expect(result.zeroConfigLayer.keywordsCheck.passed).toBe(true);
			expect(result.zeroConfigLayer.keywordsCheck.matchedKeywords).toContain('review-service');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 2: 退出码 0 但 diff 为空直接判失败，不派审查 agent，标「无改动」转人（E-61, E-23）
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 2 & E-61 & E-23: Exit code 0 with empty diff directly fails, does not dispatch review agent, tags 无改动', () => {
		it('fails immediately when exitCode is 0 and diff has no changes, tags 无改动, targets awaiting_human, and does not dispatch review agent', async () => {
			const emptyDiffStat = makeFakeDiffStat(false, 0);

			let commandExecuted = false;
			const fakeCommandRunner: CommandRunner = async (cmd, cwd) => {
				commandExecuted = true;
				return {
					command: cmd.label ?? cmd.file,
					file: cmd.file,
					args: cmd.args ?? [],
					exitCode: 0,
					signal: null,
					stdout: 'ok',
					stderr: '',
					timedOut: false,
					durationMs: 10,
				};
			};

			const result = await runMechanicalCheck(
				{
					worktreePath: fakeWorktreeDir,
					mainRepoPath: fakeMainRepoDir,
					exitCode: 0,
					diffStat: emptyDiffStat,
					diffText: '',
					acceptText: '1) diff must not be empty (E-61, E-23)',
					projectCommands: ['npm test'],
				},
				{ commandRunner: fakeCommandRunner },
			);

			// AC 2 verification
			expect(result.passed).toBe(false);
			expect(result.canDispatchReviewAgent).toBe(false); // 不派审查 agent
			expect(result.tag).toBe(NO_CHANGES_TAG); // 标「无改动」转人
			expect(result.targetState).toBe('awaiting_human'); // 转人
			expect(result.retryable).toBe(false);
			expect(result.reason).toBe(RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED);

			// Zero-config diff check recorded failure
			expect(result.zeroConfigLayer.passed).toBe(false);
			expect(result.zeroConfigLayer.diffCheck.passed).toBe(false);
			expect(result.zeroConfigLayer.diffCheck.hasChanges).toBe(false);
			expect(result.zeroConfigLayer.diffCheck.filesChanged).toBe(0);

			// Project commands were not executed because empty diff failed directly
			expect(commandExecuted).toBe(false);
			expect(result.projectCommandLayer.executed).toBe(false);
		});

		it('fails zero-config check when exitCode is non-zero even if diff has changes (E-23)', async () => {
			const diffStat = makeFakeDiffStat(true);

			const result = await runMechanicalCheck({
				worktreePath: fakeWorktreeDir,
				mainRepoPath: fakeMainRepoDir,
				exitCode: 1, // Non-zero exit
				diffStat,
				diffText: '+some code change',
				projectCommands: [],
			});

			expect(result.passed).toBe(false);
			expect(result.canDispatchReviewAgent).toBe(false);
			expect(result.targetState).toBe('awaiting_human');
			expect(result.tag).toBe(EXIT_CODE_FAILED_TAG);
			expect(result.zeroConfigLayer.exitCodeCheck.passed).toBe(false);
			expect(result.zeroConfigLayer.exitCodeCheck.exitCode).toBe(1);
		});

		it('fails zero-config check when session encountered a fatal process error (E-23)', async () => {
			const diffStat = makeFakeDiffStat(true);

			const result = await runMechanicalCheck({
				worktreePath: fakeWorktreeDir,
				mainRepoPath: fakeMainRepoDir,
				exitCode: 0,
				hasFatalError: true,
				exitReason: 'spawn-failed',
				errorDetail: 'Subprocess crashed abruptly',
				diffStat,
				diffText: '+some code change',
			});

			expect(result.passed).toBe(false);
			expect(result.canDispatchReviewAgent).toBe(false);
			expect(result.targetState).toBe('awaiting_human');
			expect(result.tag).toBe(SESSION_ERROR_TAG);
			expect(result.zeroConfigLayer.sessionErrorCheck.passed).toBe(false);
			expect(result.zeroConfigLayer.sessionErrorCheck.hasFatalError).toBe(true);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 3: 执行目录恒为该任务的 worktree，绝不在用户主工作区跑（E-67）
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 3 & E-67: Execution directory strictly task worktree, never user main workspace', () => {
		it('rejects execution when worktreePath is identical to mainRepoPath (E-67)', async () => {
			await expect(
				runMechanicalCheck({
					worktreePath: fakeMainRepoDir,
					mainRepoPath: fakeMainRepoDir,
					exitCode: 0,
					diffStat: makeFakeDiffStat(true),
				}),
			).rejects.toThrowError(AppError);

			try {
				await runMechanicalCheck({
					worktreePath: fakeMainRepoDir,
					mainRepoPath: fakeMainRepoDir,
					exitCode: 0,
					diffStat: makeFakeDiffStat(true),
				});
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).code).toBe('E_WORKSPACE_UNAVAILABLE');
				expect((err as AppError).message).toContain('E-67');
			}
		});

		it('assertWorktreeDirectory rejects main repo directory with case-insensitive normalization on Windows', async () => {
			const upperMain = fakeMainRepoDir.toUpperCase();
			try {
				await assertWorktreeDirectory(fakeMainRepoDir, upperMain);
				expect.unreachable('Should have thrown AppError');
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).code).toBe('E_WORKSPACE_UNAVAILABLE');
				expect((err as AppError).message).toContain('E-67');
			}
		});

		it('assertWorktreeDirectory rejects inaccessible or missing worktree directory', async () => {
			const nonExistent = join(fakeWorktreeDir, 'does-not-exist');
			try {
				await assertWorktreeDirectory(nonExistent);
				expect.unreachable('Should have thrown AppError');
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).code).toBe('E_WORKSPACE_UNAVAILABLE');
			}
		});

		it('assertWorktreeDirectory rejects empty worktree path', async () => {
			try {
				await assertWorktreeDirectory('');
				expect.unreachable('Should have thrown AppError');
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).code).toBe('E_WORKSPACE_UNAVAILABLE');
			}

			try {
				await assertWorktreeDirectory('   ');
				expect.unreachable('Should have thrown AppError');
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).code).toBe('E_WORKSPACE_UNAVAILABLE');
			}
		});

		it('passes cwd = worktreePath to every project check command runner call (E-67)', async () => {
			const diffStat = makeFakeDiffStat(true);
			const diffText = '+const code = 1;';
			const recordedCwds: string[] = [];

			const customRunner: CommandRunner = async (cmd, cwd) => {
				recordedCwds.push(cwd);
				return {
					command: cmd.label ?? cmd.file,
					file: cmd.file,
					args: cmd.args ?? [],
					exitCode: 0,
					signal: null,
					stdout: 'all tests passed',
					stderr: '',
					timedOut: false,
					durationMs: 25,
				};
			};

			const result = await runMechanicalCheck(
				{
					worktreePath: fakeWorktreeDir,
					mainRepoPath: fakeMainRepoDir,
					exitCode: 0,
					diffStat,
					diffText,
					projectCommands: ['npm run lint', 'npm test'],
				},
				{ commandRunner: customRunner },
			);

			expect(result.passed).toBe(true);
			expect(result.tag).toBe(MECHANICAL_CHECK_PASSED_TAG);
			expect(recordedCwds.length).toBe(2);
			const normalizedWorktree = resolve(fakeWorktreeDir);
			expect(resolve(recordedCwds[0] ?? '')).toBe(normalizedWorktree);
			expect(resolve(recordedCwds[1] ?? '')).toBe(normalizedWorktree);
			expect(resolve(recordedCwds[0] ?? '')).not.toBe(resolve(fakeMainRepoDir));
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 4: build/test 命令 10 分钟硬超时后杀掉，标「机械检查超时」转人，不重试（E-66）
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 4 & E-66: Build/test 10-minute hard timeout kills process, tags 机械检查超时, does not retry', () => {
		it('times out hanging build/test command, marks 机械检查超时, transitions to awaiting_human, and does not retry (retryable: false)', async () => {
			const diffStat = makeFakeDiffStat(true);
			const diffText = '+const testCode = true;';

			const hangingRunner: CommandRunner = async (cmd, cwd, timeouts) => {
				// Assert checkTimeoutMs defaults to 10 minutes (600_000 ms)
				expect(timeouts?.checkTimeoutMs).toBe(DEFAULT_CHECK_TIMEOUT_MS);
				return {
					command: cmd.label ?? cmd.file,
					file: cmd.file,
					args: cmd.args ?? [],
					exitCode: null,
					signal: 'SIGTERM',
					stdout: 'running tests...\n[hangs]',
					stderr: 'Timed out after 600000ms',
					timedOut: true, // Process killed on timeout
					durationMs: 600_000,
				};
			};

			const result = await runMechanicalCheck(
				{
					worktreePath: fakeWorktreeDir,
					mainRepoPath: fakeMainRepoDir,
					exitCode: 0,
					diffStat,
					diffText,
					projectCommands: ['npm test'],
				},
				{ commandRunner: hangingRunner },
			);

			// AC 4 & E-66 verification
			expect(result.passed).toBe(false);
			expect(result.tag).toBe(MECHANICAL_CHECK_TIMEOUT_TAG); // 标「机械检查超时」
			expect(result.targetState).toBe('awaiting_human'); // 转人
			expect(result.retryable).toBe(false); // 不重试
			expect(result.canDispatchReviewAgent).toBe(false);
			expect(result.reason).toBe(RUN_TRANSITION_REASONS.MECHANICAL_CHECK_TIMEOUT);

			expect(result.projectCommandLayer.passed).toBe(false);
			expect(result.projectCommandLayer.timedOut).toBe(true);
			expect(result.projectCommandLayer.failedCommand).toBe('npm test');
		});

		it('halts sequential execution on first command timeout without running subsequent commands', async () => {
			const diffStat = makeFakeDiffStat(true);
			const executedCommands: string[] = [];

			const runner: CommandRunner = async (cmd) => {
				executedCommands.push(cmd.label ?? cmd.file);
				if (cmd.file === 'hanging-test') {
					return {
						command: cmd.label ?? cmd.file,
						file: cmd.file,
						args: cmd.args ?? [],
						exitCode: null,
						signal: 'SIGKILL',
						stdout: '',
						stderr: 'Hard timeout triggered',
						timedOut: true,
						durationMs: 50,
					};
				}
				return {
					command: cmd.label ?? cmd.file,
					file: cmd.file,
					args: cmd.args ?? [],
					exitCode: 0,
					signal: null,
					stdout: 'ok',
					stderr: '',
					timedOut: false,
					durationMs: 10,
				};
			};

			const result = await runMechanicalCheck(
				{
					worktreePath: fakeWorktreeDir,
					mainRepoPath: fakeMainRepoDir,
					exitCode: 0,
					diffStat,
					diffText: '+code',
					projectCommands: [
						{ file: 'hanging-test', timeoutMs: 50 },
						{ file: 'should-never-run', timeoutMs: 50 },
					],
				},
				{ commandRunner: runner },
			);

			expect(result.passed).toBe(false);
			expect(result.tag).toBe(MECHANICAL_CHECK_TIMEOUT_TAG);
			expect(result.retryable).toBe(false);
			expect(executedCommands).toEqual(['hanging-test']);
		});

		it('marks failure when command exits with non-zero exit code without timeout', async () => {
			const diffStat = makeFakeDiffStat(true);

			const failingRunner: CommandRunner = async (cmd) => {
				return {
					command: cmd.label ?? cmd.file,
					file: cmd.file,
					args: cmd.args ?? [],
					exitCode: 2,
					signal: null,
					stdout: '1 failing test',
					stderr: 'AssertionError',
					timedOut: false,
					durationMs: 100,
				};
			};

			const result = await runMechanicalCheck(
				{
					worktreePath: fakeWorktreeDir,
					mainRepoPath: fakeMainRepoDir,
					exitCode: 0,
					diffStat,
					diffText: '+code',
					projectCommands: ['vitest run'],
				},
				{ commandRunner: failingRunner },
			);

			expect(result.passed).toBe(false);
			expect(result.tag).toBe(COMMAND_FAILED_TAG);
			expect(result.targetState).toBe('awaiting_human');
			expect(result.canDispatchReviewAgent).toBe(false);
			expect(result.projectCommandLayer.timedOut).toBe(false);
			expect(result.projectCommandLayer.failedCommand).toBe('vitest run');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// ReviewService Composition & evaluateMechanicalCheck
	// ─────────────────────────────────────────────────────────────────────────────
	describe('createReviewService & evaluateMechanicalCheck integration', () => {
		it('transitions run from exited to reviewing, runs check, and if check passes remains in reviewing', async () => {
			const diffStat = makeFakeDiffStat(true);
			const diffText = '+const review = 1; // E-60 mechanical check';

			const runRecord = {
				id: 'run-001',
				taskId: 'task-m7-t1',
				state: 'exited' as const,
				exitCode: 0,
				worktreePath: fakeWorktreeDir,
			};

			const stateUpdates: Array<{ fromState: string; toState: string }> = [];
			const mockRunsRepo: ReviewRunsRepo = {
				findById: (id) => (id === runRecord.id ? { ...runRecord } : null),
				updateState: (input) => {
					stateUpdates.push({ fromState: input.fromState, toState: input.toState });
				},
			};

			const service = createReviewService({
				runsRepo: mockRunsRepo,
				clock: { now: () => '2026-09-14T12:00:00.000Z' },
			});

			const evalResult = await service.evaluateMechanicalCheck({
				runId: 'run-001',
				mainRepoPath: fakeMainRepoDir,
				diffStat,
				diffText,
				acceptText: 'E-60 mechanical check',
				projectCommands: [],
			});

			expect(evalResult.result.passed).toBe(true);
			expect(evalResult.previousState).toBe('reviewing');
			expect(evalResult.currentState).toBe('reviewing');
			expect(evalResult.result.canDispatchReviewAgent).toBe(true);
			// Transitioned exited -> reviewing
			expect(stateUpdates).toContainEqual({ fromState: 'exited', toState: 'reviewing' });
		});

		it('transitions run from reviewing to awaiting_human and inserts gate on empty diff (E-61, E-23)', async () => {
			const runRecord = {
				id: 'run-002',
				taskId: 'task-m7-t1',
				state: 'reviewing' as const,
				exitCode: 0,
				worktreePath: fakeWorktreeDir,
			};

			const stateUpdates: Array<{ fromState: string; toState: string; reason?: string }> = [];
			const mockRunsRepo: ReviewRunsRepo = {
				findById: (id) => (id === runRecord.id ? { ...runRecord } : null),
				updateState: (input) => {
					stateUpdates.push({
						fromState: input.fromState,
						toState: input.toState,
						reason: input.queuedReason ?? undefined,
					});
				},
			};

			const insertedGates: Array<{ taskId: string; comment?: string | null }> = [];
			const mockGatesRepo: ReviewGatesRepo = {
				insert: (gate) => {
					insertedGates.push({ taskId: gate.taskId, comment: gate.comment });
				},
			};

			const service = createReviewService({
				runsRepo: mockRunsRepo,
				gatesRepo: mockGatesRepo,
				clock: { now: () => '2026-09-14T12:00:00.000Z' },
			});

			// No changes diffStat
			const emptyDiffStat = makeFakeDiffStat(false, 0);

			const evalResult = await service.evaluateMechanicalCheck({
				runId: 'run-002',
				mainRepoPath: fakeMainRepoDir,
				diffStat: emptyDiffStat,
				projectCommands: [],
			});

			expect(evalResult.result.passed).toBe(false);
			expect(evalResult.result.tag).toBe(NO_CHANGES_TAG);
			expect(evalResult.currentState).toBe('awaiting_human');
			expect(evalResult.gateCreated).toBe(true);
			expect(insertedGates[0]?.comment).toBe(NO_CHANGES_TAG);
			expect(stateUpdates).toContainEqual({
				fromState: 'reviewing',
				toState: 'awaiting_human',
				reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED,
			});
		});

		it('transitions run to awaiting_human and tags 机械检查超时 on timeout (E-66)', async () => {
			const runRecord = {
				id: 'run-003',
				taskId: 'task-m7-t1',
				state: 'reviewing' as const,
				exitCode: 0,
				worktreePath: fakeWorktreeDir,
			};

			const stateUpdates: Array<{ fromState: string; toState: string; reason?: string }> = [];
			const mockRunsRepo: ReviewRunsRepo = {
				findById: (id) => (id === runRecord.id ? { ...runRecord } : null),
				updateState: (input) => {
					stateUpdates.push({
						fromState: input.fromState,
						toState: input.toState,
						reason: input.queuedReason ?? undefined,
					});
				},
			};

			const timeoutRunner: CommandRunner = async (cmd) => ({
				command: cmd.label ?? cmd.file,
				file: cmd.file,
				args: cmd.args ?? [],
				exitCode: null,
				signal: 'SIGTERM',
				stdout: '',
				stderr: '10 min timeout',
				timedOut: true,
				durationMs: 600_000,
			});

			const service = createReviewService({
				runsRepo: mockRunsRepo,
				commandRunner: timeoutRunner,
				clock: { now: () => '2026-09-14T12:00:00.000Z' },
			});

			const evalResult = await service.evaluateMechanicalCheck({
				runId: 'run-003',
				mainRepoPath: fakeMainRepoDir,
				diffStat: makeFakeDiffStat(true),
				projectCommands: ['npm test'],
			});

			expect(evalResult.result.passed).toBe(false);
			expect(evalResult.result.tag).toBe(MECHANICAL_CHECK_TIMEOUT_TAG);
			expect(evalResult.result.retryable).toBe(false);
			expect(evalResult.currentState).toBe('awaiting_human');
			expect(stateUpdates).toContainEqual({
				fromState: 'reviewing',
				toState: 'awaiting_human',
				reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_TIMEOUT,
			});
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// Parsing and helper functions unit coverage
	// ─────────────────────────────────────────────────────────────────────────────
	describe('Helper utilities: command parsing, keyword extraction and matching', () => {
		it('parseCommandString handles flags, paths and quoted arguments', () => {
			const res1 = parseCommandString('pnpm -w check');
			expect(res1.file).toBe('pnpm');
			expect(res1.args).toEqual(['-w', 'check']);

			const res2 = parseCommandString('node --test "path/with space/test.js" --verbose');
			expect(res2.file).toBe('node');
			expect(res2.args).toEqual(['--test', 'path/with space/test.js', '--verbose']);

			const res3 = parseCommandString("git commit -m 'commit message with spaces'");
			expect(res3.file).toBe('git');
			expect(res3.args).toEqual(['commit', '-m', 'commit message with spaces']);
		});

		it('parseCommandString throws on empty command string', () => {
			expect(() => parseCommandString('')).toThrow(AppError);
			expect(() => parseCommandString('   ')).toThrow(AppError);
		});

		it('normalizeCommandSpec normalizes strings, arrays, and objects', () => {
			const s1 = normalizeCommandSpec('cargo test --lib');
			expect(s1.file).toBe('cargo');
			expect(s1.args).toEqual(['test', '--lib']);

			const s2 = normalizeCommandSpec(['vitest', 'run', '--coverage']);
			expect(s2.file).toBe('vitest');
			expect(s2.args).toEqual(['run', '--coverage']);

			const s3 = normalizeCommandSpec({
				file: 'pytest',
				args: ['-v', 'tests/'],
				timeoutMs: 30_000,
			});
			expect(s3.file).toBe('pytest');
			expect(s3.timeoutMs).toBe(30_000);
		});

		it('extractAcceptanceKeywords extracts boundary codes, quoted terms, and technical keywords', () => {
			const text = `
				1) 零配置层（diff 非空／退出码／会话无致命错误／验收关键词命中）恒执行
				项目命令层留空则跳过并在 UI 明示「机械检查覆盖有限」（E-60）
				2) 退出码为 0 但 diff 为空时机械层直接判失败，不派审查 agent，标「无改动」转人（E-61、E-23）
				3) 执行目录恒为该任务的 worktree，绝不在用户主工作区跑（E-67）
				4) build/test 命令 10 分钟硬超时后杀掉，标「机械检查超时」转人，不重试（E-66）
			`;

			const keywords = extractAcceptanceKeywords(text);
			expect(keywords).toContain('E-60');
			expect(keywords).toContain('E-61');
			expect(keywords).toContain('E-23');
			expect(keywords).toContain('E-66');
			expect(keywords).toContain('E-67');
			expect(keywords).toContain('机械检查覆盖有限');
			expect(keywords).toContain('无改动');
			expect(keywords).toContain('机械检查超时');
			expect(keywords).toContain('零配置');
			expect(keywords).toContain('退出码');
			expect(keywords).toContain('worktree');
		});

		it('matchesAcceptanceKeywords accurately detects ASCII and non-ASCII keyword hits in diff and file paths', () => {
			const keywords = ['E-60', '无改动', 'worktree', 'unmatched'];
			const diffText = 'Index: file.ts\n+const note = "无改动";\n+const e = "E-60";';
			const filePaths = ['packages/daemon/src/workspace/worktree.ts'];

			const match = matchesAcceptanceKeywords(keywords, diffText, filePaths);
			expect(match.hit).toBe(true);
			expect(match.matched).toContain('E-60');
			expect(match.matched).toContain('无改动');
			expect(match.matched).toContain('worktree');
			expect(match.matched).not.toContain('unmatched');
		});

		it('matchesAcceptanceKeywords returns hit true when required keywords list is empty', () => {
			const match = matchesAcceptanceKeywords([], 'any diff text', []);
			expect(match.hit).toBe(true);
			expect(match.matched).toEqual([]);
		});

		it('extractAcceptanceKeywords returns empty list for undefined or empty text', () => {
			expect(extractAcceptanceKeywords(undefined)).toEqual([]);
			expect(extractAcceptanceKeywords('')).toEqual([]);
			expect(extractAcceptanceKeywords('   ')).toEqual([]);
		});

		it('normalizeCommandSpec throws AppError on invalid command input', () => {
			expect(() => normalizeCommandSpec([] as unknown as readonly string[])).toThrow(AppError);
			expect(() => normalizeCommandSpec(123 as unknown as string)).toThrow(AppError);
			expect(() => normalizeCommandSpec({ file: '' })).toThrow(AppError);
		});

		it('evaluateMechanicalCheck throws E_NOT_FOUND when runsRepo is provided but run does not exist', async () => {
			const mockRepo: ReviewRunsRepo = {
				findById: () => null,
				updateState: () => {},
			};
			const service = createReviewService({ runsRepo: mockRepo });
			await expect(
				service.evaluateMechanicalCheck({ runId: 'non-existent' }),
			).rejects.toThrowError();
			try {
				await service.evaluateMechanicalCheck({ runId: 'non-existent' });
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).code).toBe('E_NOT_FOUND');
			}
		});

		it('createDefaultCommandRunner executes via injected spawnManaged', async () => {
			type SpawnManagedFn = NonNullable<
				NonNullable<Parameters<typeof createReviewService>[0]>['spawnManaged']
			>;
			const fakeSpawnManaged: SpawnManagedFn = (spec, options) => {
				setTimeout(() => {
					options.onLine?.({
						text: 'build output line 1',
						truncated: false,
						rawByteLen: 19,
					});
					options.onExit?.({
						runId: spec.runId,
						pid: 9999,
						exitCode: 0,
						signal: null,
						reason: 'exited',
					});
				}, 10);
				return {
					runId: spec.runId,
					pid: 9999,
					file: spec.file,
					args: spec.args,
					cwd: spec.cwd,
				} as unknown as ReturnType<SpawnManagedFn>;
			};

			const diffStat = makeFakeDiffStat(true);
			const diffText = '+const code = 1;';

			const result = await runMechanicalCheck(
				{
					worktreePath: fakeWorktreeDir,
					mainRepoPath: fakeMainRepoDir,
					exitCode: 0,
					diffStat,
					diffText,
					projectCommands: [{ file: 'fake-build', args: ['--prod'] }],
				},
				{ spawnManaged: fakeSpawnManaged },
			);

			expect(result.passed).toBe(true);
			expect(result.projectCommandLayer.executed).toBe(true);
			expect(result.projectCommandLayer.commands[0]?.stdout).toContain('build output line 1');
		});
	});
});
