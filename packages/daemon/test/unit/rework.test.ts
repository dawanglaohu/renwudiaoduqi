import type { ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import type { UnitOfWork } from '../../src/db/unit-of-work.ts';
import { AppError } from '../../src/errors/app-error.ts';
import type { EventBus } from '../../src/events/bus.ts';
import type { EnvelopeFactory } from '../../src/events/envelope.ts';
import type { ProcessRegistry } from '../../src/proc/registry.ts';
import type { ManagedProcess } from '../../src/proc/spawn.ts';
import {
	type RunInsertRow,
	type RunRow,
	type RunsRepo,
	createRunsRepo,
} from '../../src/repo/runs.ts';
import type { MessageService } from '../../src/service/message.ts';
import {
	REWORK_TRANSITION_REASONS,
	type ReworkSnapshotsRepo,
	createReworkService,
	evaluateDiffRegression,
} from '../../src/service/rework.ts';

interface TestEnvelope {
	readonly id: string;
	readonly ts: string;
	readonly runId: string | null;
	readonly taskId: string | null;
	readonly scope: string;
	readonly kind: string;
	readonly seq: number;
	readonly actorDeviceId: string | null;
	readonly payload: {
		readonly from?: string;
		readonly to?: string;
		readonly reason?: string;
		readonly [key: string]: unknown;
	};
}

describe('M7-T4: Rework reinjection and retry limit (AC 1-4, E-55, E-59, E-68, E-279)', () => {
	let runsStore: Map<string, RunRow>;
	let snapshotsStore: Map<string, { launch_spec_json: string }>;
	let publishedEvents: TestEnvelope[];
	let sentMessages: Array<{
		runId: string;
		text: string;
		kind: string;
		actorDeviceId?: string | null;
	}>;
	let mockProcessRegistry: Map<string, ManagedProcess>;
	let mockMessageService: MessageService;
	let mockRunsRepo: RunsRepo;
	let mockSnapshotsRepo: ReworkSnapshotsRepo;
	let mockUnitOfWork: UnitOfWork;
	let mockBus: EventBus;
	let mockEnvelopeFactory: EnvelopeFactory;

	function createDummyRun(overrides?: Partial<RunRow>): RunRow {
		return {
			id: 'run-impl-1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			parent_run_id: null,
			state: 'reviewing',
			review_verdict: null,
			agent_id: 'codex',
			model_name: 'gpt-5-codex',
			reported_model: null,
			effort_tier: 'medium',
			reported_effort: null,
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			worktree_path: '/path/to/worktree',
			branch_name: 'task/M7-T4',
			pid: 12345,
			exit_code: null,
			exit_signal: null,
			vendor_session_ref: null,
			changed_file_count: 3,
			token_usage_json: null,
			unmapped_event_count: 0,
			is_stall_suspected: 0,
			rework_count: 0,
			queued_reason: null,
			idempotency_key: 'idem-1',
			actor_device_id: 'device-1',
			started_at: '2026-09-16T08:00:00.000Z',
			last_event_at: '2026-09-16T08:05:00.000Z',
			ended_at: null,
			lane_no: 1,
			session_archived_at: null,
			...overrides,
		};
	}

	function setRunState(runId: string, state: RunRow['state']) {
		const existing = runsStore.get(runId);
		if (existing) {
			runsStore.set(runId, { ...existing, state });
		}
	}

	function createMockProcess(runId: string, alive = true): ManagedProcess {
		const mockStdin = {
			writable: alive,
			destroyed: !alive,
		} as unknown as Writable;

		const mockChild = {
			pid: 12345,
			killed: !alive,
			exitCode: alive ? null : 0,
			stdin: mockStdin,
		} as unknown as ChildProcess;

		return {
			runId,
			pid: 12345,
			file: 'codex',
			args: [],
			cwd: '/path',
			child: mockChild,
			stdoutReader: {} as unknown as ManagedProcess['stdoutReader'],
			stderrReader: {} as unknown as ManagedProcess['stderrReader'],
			timers: {} as unknown as ManagedProcess['timers'],
			isExited: !alive,
			stderrTail: '',
			attachAppendQueue: vi.fn(),
			waitForStdinDrain: vi.fn().mockResolvedValue(undefined),
			onStdinDrain: vi.fn(),
			writeStdin: vi.fn().mockReturnValue(true),
			onLine: vi.fn(),
			onRaw: vi.fn(),
			onStderr: vi.fn(),
			onJson: vi.fn(),
			onExit: vi.fn(),
			onError: vi.fn(),
			kill: vi.fn().mockResolvedValue({ killed: true }),
			finalize: vi.fn().mockResolvedValue(undefined),
		};
	}

	beforeEach(() => {
		runsStore = new Map();
		snapshotsStore = new Map();
		publishedEvents = [];
		sentMessages = [];
		mockProcessRegistry = new Map();

		mockRunsRepo = {
			insert: (row: RunInsertRow) => {
				runsStore.set(row.id, { ...row } as RunRow);
			},
			findById: (id: string) => runsStore.get(id) ?? null,
			findByIdempotencyKey: (key: string) => {
				for (const r of runsStore.values()) {
					if (r.idempotency_key === key) return r;
				}
				return null;
			},
			findByVendorSessionRef: (ref: string) => {
				for (const r of runsStore.values()) {
					if (r.vendor_session_ref === ref) return r;
				}
				return null;
			},
			findActiveByTaskId: (taskId: string) => {
				for (const r of runsStore.values()) {
					if (r.task_id === taskId) return r;
				}
				return null;
			},
			listByTaskId: (taskId: string) => {
				return Array.from(runsStore.values()).filter((r) => r.task_id === taskId);
			},
			listByTask: (taskId: string) => {
				return Array.from(runsStore.values()).filter((r) => r.task_id === taskId);
			},
			listActive: () => Array.from(runsStore.values()),
			listAll: () => Array.from(runsStore.values()),
			markSessionsArchived: () => ({ runIds: [], runs: [], changes: 0 }),
			listSucceededModelNames: () => [],
			updateState: (input) => {
				const existing = runsStore.get(input.id);
				if (existing) {
					runsStore.set(input.id, {
						...existing,
						state: input.state ?? input.toState ?? existing.state,
						queued_reason:
							input.queuedReason !== undefined ? input.queuedReason : existing.queued_reason,
						ended_at: input.endedAt !== undefined ? input.endedAt : existing.ended_at,
						rework_count:
							input.reworkCount !== undefined ? input.reworkCount : existing.rework_count,
					});
				}
			},
			findLatestReview: () => null,
			updateReviewRound: () => {},
			updateReworkCount: (input) => {
				const existing = runsStore.get(input.id);
				if (existing) {
					runsStore.set(input.id, {
						...existing,
						rework_count: input.reworkCount,
						state: input.state ?? existing.state,
					});
				}
			},
		};

		mockSnapshotsRepo = {
			findById: (id: string) => snapshotsStore.get(id) ?? null,
		};

		mockMessageService = {
			sendMessage: vi.fn().mockImplementation(async (input) => {
				sentMessages.push(input);
				return {
					delivered: true,
					messageId: `msg-${sentMessages.length}`,
					text: input.text,
					deliveryState: 'delivered' as const,
					runId: input.runId,
				};
			}),
			deliverMessage: vi.fn(),
			canReply: vi.fn().mockResolvedValue(true),
			getCapabilities: vi.fn().mockReturnValue({ canReply: true, canResume: true }),
			getMessage: vi.fn(),
			getRunMessages: vi.fn().mockResolvedValue([]),
			getUndeliveredMessages: vi.fn().mockResolvedValue([]),
		};

		mockUnitOfWork = {
			run: <T>(fn: () => T): T => fn(),
		};

		mockBus = {
			publish: (ev: unknown) => publishedEvents.push(ev as TestEnvelope),
			subscribe: vi.fn(),
			close: vi.fn(),
		} as unknown as EventBus;

		let eventSeq = 1;
		mockEnvelopeFactory = {
			createEnvelope: (input: {
				kind: string;
				runId?: string | null;
				taskId?: string | null;
				actorDeviceId?: string | null;
				payload: Record<string, unknown>;
			}) =>
				({
					id: `ev-${eventSeq++}`,
					ts: '2026-09-16T08:10:00.000Z',
					runId: input.runId ?? null,
					taskId: input.taskId ?? null,
					scope: 'run',
					kind: input.kind,
					seq: 1,
					actorDeviceId: input.actorDeviceId ?? null,
					payload: input.payload,
				}) as unknown as ReturnType<EnvelopeFactory['createEnvelope']>,
		} as unknown as EnvelopeFactory;
	});

	function makeService(overrides?: Partial<Parameters<typeof createReworkService>[0]>) {
		return createReworkService({
			runsRepo: mockRunsRepo,
			snapshotsRepo: mockSnapshotsRepo,
			messageService: mockMessageService,
			processRegistry: {
				get: (id: string) => mockProcessRegistry.get(id),
			} as unknown as ProcessRegistry,
			unitOfWork: mockUnitOfWork,
			bus: mockBus,
			envelopeFactory: mockEnvelopeFactory,
			clock: { now: () => '2026-09-16T08:10:00.000Z' },
			ids: { newId: () => 'rework-id-1' },
			...overrides,
		});
	}

	describe('AC 1 & E-55: rework opinion reinjection and retry limit', () => {
		it('reinjects rework opinion via messageService reply channel and increments rework_count (+1)', async () => {
			const run = createDummyRun({ rework_count: 0 });
			runsStore.set(run.id, run);
			snapshotsStore.set('snap-1', {
				launch_spec_json: JSON.stringify({ adapterKind: 'native', agentId: 'codex' }),
			});
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: 'run-rev-1',
				targetRunId: run.id,
				reworkText: '```rework\n- R1: 修复边界处理\n```',
				source: 'review',
			});

			expect(result.success).toBe(true);
			expect(result.action).toBe('injected');
			expect(result.mode).toBe('inject');
			expect(result.reworkCount).toBe(1);

			// Assert message was delivered via messageService with kind 'reply'
			expect(mockMessageService.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					runId: run.id,
					text: '```rework\n- R1: 修复边界处理\n```',
					kind: 'reply',
					throwOnUndelivered: true,
				}),
			);

			// Assert run row rework_count was incremented in repo
			const updatedRun = runsStore.get(run.id);
			expect(updatedRun?.rework_count).toBe(1);
			expect(updatedRun?.state).toBe('running');

			// Assert state transitions were published: reworking then running
			const stateEvents = publishedEvents.filter((e) => e.kind === 'run.state_changed');
			expect(stateEvents.length).toBeGreaterThanOrEqual(2);
			expect(stateEvents[0]?.payload.to).toBe('reworking');
			expect(stateEvents[1]?.payload.to).toBe('running');
		});

		it('defaults automatic retry limit to 2 and transfers to awaiting_human when reached (E-55)', async () => {
			// Current rework_count is already 2 (limit reached)
			const targetRun = createDummyRun({ rework_count: 2, state: 'reviewing' });
			const reviewRun = createDummyRun({
				id: 'run-rev-1',
				kind: 'review',
				state: 'reviewing',
				rework_count: 2,
			});
			runsStore.set(targetRun.id, targetRun);
			runsStore.set(reviewRun.id, reviewRun);
			mockProcessRegistry.set(targetRun.id, createMockProcess(targetRun.id, true));

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: reviewRun.id,
				targetRunId: targetRun.id,
				reworkText: '- R1: 再次未通过审查',
				source: 'review',
			});

			expect(result.success).toBe(false);
			expect(result.action).toBe('awaiting_human');
			expect(result.mode).toBe('awaiting_human');
			expect(result.reworkCount).toBe(2);
			if (result.action === 'awaiting_human') {
				expect(result.reason).toBe('rework_limit_reached');
			}

			// Message MUST NOT be sent when limit reached
			expect(mockMessageService.sendMessage).not.toHaveBeenCalled();

			// Both target run and review run must transition to awaiting_human with rework_limit_reached reason
			const updatedTarget = runsStore.get(targetRun.id);
			const updatedReview = runsStore.get(reviewRun.id);
			expect(updatedTarget?.state).toBe('awaiting_human');
			expect(updatedTarget?.queued_reason).toBe(REWORK_TRANSITION_REASONS.REWORK_LIMIT_REACHED);
			expect(updatedReview?.state).toBe('awaiting_human');

			// Assert state_changed event published with rework_limit_reached reason
			const limitEvents = publishedEvents.filter(
				(e) => e.payload?.reason === REWORK_TRANSITION_REASONS.REWORK_LIMIT_REACHED,
			);
			expect(limitEvents.length).toBeGreaterThanOrEqual(1);
			expect(limitEvents[0]?.payload.to).toBe('awaiting_human');
		});

		it('limit reached with a review run already exited still parks the reviewed run without throwing (E-55)', async () => {
			// 审查行收工后停在 exited 是常态；09 节白名单不允许 exited → awaiting_human，
			// 所以这一行只尽力收，不能因此抛错把「超限转待人确认」整条结果打掉。
			const targetRun = createDummyRun({ rework_count: 2, state: 'reviewing' });
			const reviewRun = createDummyRun({
				id: 'run-rev-exited',
				kind: 'review',
				state: 'exited',
				rework_count: 2,
			});
			runsStore.set(targetRun.id, targetRun);
			runsStore.set(reviewRun.id, reviewRun);
			mockProcessRegistry.set(targetRun.id, createMockProcess(targetRun.id, true));

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: reviewRun.id,
				targetRunId: targetRun.id,
				reworkText: '- R1: 已达上限',
				source: 'review',
			});

			expect(result.success).toBe(false);
			expect(result.action).toBe('awaiting_human');
			if (result.action === 'awaiting_human') {
				expect(result.reason).toBe('rework_limit_reached');
			}

			// 被审实施行照样转 awaiting_human
			expect(runsStore.get(targetRun.id)?.state).toBe('awaiting_human');
			// 审查行状态不动（非法迁移不落库）
			expect(runsStore.get(reviewRun.id)?.state).toBe('exited');
			expect(mockMessageService.sendMessage).not.toHaveBeenCalled();
		});

		it('supports configurable custom maxReworkCount (e.g. max 1 retry)', async () => {
			const run = createDummyRun({ rework_count: 1 });
			runsStore.set(run.id, run);
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();
			const result = await service.dispatchRework({
				targetRunId: run.id,
				reworkText: '- R1: 意见',
				source: 'review',
				maxReworkCount: 1, // Custom limit of 1
			});

			expect(result.success).toBe(false);
			expect(result.action).toBe('awaiting_human');
			expect(result.reworkCount).toBe(1);
			expect(mockMessageService.sendMessage).not.toHaveBeenCalled();
		});

		it('unifies retry counter regardless of prior delivery methods (E-55)', async () => {
			// Whether previous rework was injected, resumed, or new run, rework_count is unified
			const run = createDummyRun({ rework_count: 1 });
			runsStore.set(run.id, run);
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();
			const result = await service.dispatchRework({
				targetRunId: run.id,
				reworkText: '- R1: 第 2 次返工',
				source: 'review',
			});

			expect(result.success).toBe(true);
			expect(result.reworkCount).toBe(2);

			// Implementation finishes, exits, and enters review
			setRunState(run.id, 'reviewing');

			// Next attempt will hit limit
			const nextResult = await service.dispatchRework({
				targetRunId: run.id,
				reworkText: '- R1: 第 3 次返工尝试',
				source: 'review',
			});

			expect(nextResult.success).toBe(false);
			expect(nextResult.action).toBe('awaiting_human');
			expect(nextResult.reworkCount).toBe(2);
		});

		it('R1: asserts rework_count 0 -> 1 -> 2 truly persists in repo and 3rd automatic review turns awaiting_human', async () => {
			const run = createDummyRun({ rework_count: 0, state: 'reviewing' });
			runsStore.set(run.id, run);
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();

			// Round 1: count 0 -> 1
			const res1 = await service.dispatchRework({
				targetRunId: run.id,
				reworkText: '- R1: 修复第 1 次问题',
				source: 'review',
			});
			expect(res1.success).toBe(true);
			expect(res1.action).toBe('injected');
			expect(res1.reworkCount).toBe(1);
			expect(runsStore.get(run.id)?.rework_count).toBe(1);
			expect(runsStore.get(run.id)?.state).toBe('running');

			// Implementation finishes, exits, and enters review
			setRunState(run.id, 'reviewing');

			// Round 2: count 1 -> 2
			const res2 = await service.dispatchRework({
				targetRunId: run.id,
				reworkText: '- R1: 修复第 2 次问题',
				source: 'review',
			});
			expect(res2.success).toBe(true);
			expect(res2.action).toBe('injected');
			expect(res2.reworkCount).toBe(2);
			expect(runsStore.get(run.id)?.rework_count).toBe(2);
			expect(runsStore.get(run.id)?.state).toBe('running');

			// Implementation finishes, exits, and enters review
			setRunState(run.id, 'reviewing');

			// Round 3: count is already 2 (at limit), automatic review turns awaiting_human
			const res3 = await service.dispatchRework({
				targetRunId: run.id,
				reworkText: '- R1: 修复第 3 次问题',
				source: 'review',
			});
			expect(res3.success).toBe(false);
			expect(res3.action).toBe('awaiting_human');
			expect(res3.reworkCount).toBe(2);
			expect(runsStore.get(run.id)?.rework_count).toBe(2);
			expect(runsStore.get(run.id)?.state).toBe('awaiting_human');
			expect(runsStore.get(run.id)?.queued_reason).toBe(
				REWORK_TRANSITION_REASONS.REWORK_LIMIT_REACHED,
			);
			expect(mockMessageService.sendMessage).toHaveBeenCalledTimes(2);
		});

		it('R2: rework_count=2, state=awaiting_human, source=human with comment -> action=injected and count+1 (not blocked by E-55)', async () => {
			const run = createDummyRun({ rework_count: 2, state: 'awaiting_human' });
			runsStore.set(run.id, run);
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();
			const result = await service.dispatchRework({
				targetRunId: run.id,
				reworkText: '人工打回意见：请重构处理逻辑。',
				source: 'human',
				actorDeviceId: 'device-human-1',
			});

			expect(result.success).toBe(true);
			expect(result.action).toBe('injected');
			expect(result.reworkCount).toBe(3);
			expect(runsStore.get(run.id)?.rework_count).toBe(3);
			expect(runsStore.get(run.id)?.state).toBe('running');
			expect(mockMessageService.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					runId: run.id,
					text: '人工打回意见：请重构处理逻辑。',
					kind: 'reply',
					actorDeviceId: 'device-human-1',
				}),
			);
		});

		it('R2: state=reviewing, rework_count=2, source=review -> action=awaiting_human', async () => {
			const run = createDummyRun({ rework_count: 2, state: 'reviewing' });
			runsStore.set(run.id, run);
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();
			const result = await service.dispatchRework({
				targetRunId: run.id,
				reworkText: '自动审查打回意见',
				source: 'review',
			});

			expect(result.success).toBe(false);
			expect(result.action).toBe('awaiting_human');
			expect(result.reworkCount).toBe(2);
			expect(runsStore.get(run.id)?.state).toBe('awaiting_human');
		});

		it('R3: throws E_INVALID_STATE_TRANSITION when target run is in running state', async () => {
			const run = createDummyRun({ rework_count: 0, state: 'running' });
			runsStore.set(run.id, run);
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();

			await expect(
				service.dispatchRework({
					targetRunId: run.id,
					reworkText: '- R1: 试图对运行中任务判返工',
					source: 'review',
				}),
			).rejects.toMatchObject({
				code: 'E_INVALID_STATE_TRANSITION',
			});
		});
	});

	describe('AC 2 & E-68: rework after diff shrinkage or reversion', () => {
		it('evaluates diff regression properly when diff shrank or completely reverted', () => {
			const baseline = { filesChanged: 3, insertions: 100, deletions: 20 };

			// Case 1: lines shrunk
			const shrunkDiff = { filesChanged: 3, insertions: 40, deletions: 10 };
			const evalShrunk = evaluateDiffRegression(baseline, shrunkDiff);
			expect(evalShrunk.isRegressed).toBe(true);
			expect(evalShrunk.reason).toBe('diff_shrunk');
			expect(evalShrunk.diffChanged).toBe(true);

			// Case 2: files shrunk
			const filesShrunkDiff = { filesChanged: 1, insertions: 110, deletions: 20 };
			const evalFilesShrunk = evaluateDiffRegression(baseline, filesShrunkDiff);
			expect(evalFilesShrunk.isRegressed).toBe(true);
			expect(evalFilesShrunk.reason).toBe('diff_shrunk');

			// Case 3: completely reverted
			const revertedDiff = { filesChanged: 0, insertions: 0, deletions: 0 };
			const evalReverted = evaluateDiffRegression(baseline, revertedDiff);
			expect(evalReverted.isRegressed).toBe(true);
			expect(evalReverted.reason).toBe('diff_fully_reverted');

			// Case 4: progressive expansion (normal)
			const progressDiff = { filesChanged: 4, insertions: 150, deletions: 30 };
			const evalProgress = evaluateDiffRegression(baseline, progressDiff);
			expect(evalProgress.isRegressed).toBe(false);
			expect(evalProgress.reason).toBeNull();
		});

		it('runs through the same check and increments rework_count when diff shrunk, transferring to human when limit reached (E-68)', async () => {
			const run = createDummyRun({ rework_count: 1 });
			runsStore.set(run.id, run);
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();

			// Attempt 2: diff shrank from 120 lines to 30 lines
			const result1 = await service.dispatchRework({
				targetRunId: run.id,
				reworkText: '- R1: 修复改动撤回问题',
				source: 'review',
				previousDiff: { filesChanged: 3, insertions: 100, deletions: 20 },
				currentDiff: { filesChanged: 1, insertions: 20, deletions: 10 },
			});

			expect(result1.success).toBe(true);
			expect(result1.action).toBe('injected');
			expect(result1.reworkCount).toBe(2);
			expect(result1.diffRegression?.isRegressed).toBe(true);
			expect(result1.diffRegression?.reason).toBe('diff_shrunk');

			// Implementation finishes, exits, and enters review
			setRunState(run.id, 'reviewing');

			// Attempt 3: diff reverted to 0, hits retry limit (2), must transfer to human
			const result2 = await service.dispatchRework({
				targetRunId: run.id,
				reworkText: '- R1: 全部改动被撤销',
				source: 'review',
				previousDiff: { filesChanged: 1, insertions: 20, deletions: 10 },
				currentDiff: { filesChanged: 0, insertions: 0, deletions: 0 },
			});

			expect(result2.success).toBe(false);
			expect(result2.action).toBe('awaiting_human');
			expect(result2.reworkCount).toBe(2);
			expect(result2.diffRegression?.isRegressed).toBe(true);
			expect(result2.diffRegression?.reason).toBe('diff_fully_reverted');
			expect(runsStore.get(run.id)?.state).toBe('awaiting_human');
		});
	});

	describe('AC 3 & E-59: user manual rework with attached comment', () => {
		it('requires a non-empty comment for manual rework (E-59)', async () => {
			const run = createDummyRun({ state: 'awaiting_human' });
			runsStore.set(run.id, run);
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();

			// Empty comment
			await expect(
				service.dispatchRework({
					targetRunId: run.id,
					reworkText: '   ',
					source: 'human',
				}),
			).rejects.toThrow(AppError);

			// Blank comment error details
			try {
				await service.dispatchRework({
					targetRunId: run.id,
					reworkText: '',
					source: 'manual',
				});
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).code).toBe('E_VALIDATION');
				expect((err as AppError).message).toContain('Manual rework requires an attached comment');
			}
		});

		it('reuses the exact same rework reinjection channel for manual rework with one-sentence comment (E-59)', async () => {
			const run = createDummyRun({ rework_count: 0, state: 'awaiting_human' });
			runsStore.set(run.id, run);
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();
			const result = await service.dispatchRework({
				targetRunId: run.id,
				reworkText: '请重新核对边界 E-59，不要改动不相关的文件。',
				source: 'human',
				actorDeviceId: 'device-human-1',
			});

			expect(result.success).toBe(true);
			expect(result.action).toBe('injected');
			expect(result.reworkCount).toBe(1);
			expect(result.source).toBe('human');

			// Delivered via messageService with exact user comment and reply kind
			expect(mockMessageService.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					runId: run.id,
					text: '请重新核对边界 E-59，不要改动不相关的文件。',
					kind: 'reply',
					actorDeviceId: 'device-human-1',
				}),
			);

			// State transitioned with human_rework reason
			const stateEvents = publishedEvents.filter((e) => e.kind === 'run.state_changed');
			expect(
				stateEvents.some((e) => e.payload.reason === REWORK_TRANSITION_REASONS.HUMAN_REWORK),
			).toBe(true);
		});
	});

	describe('AC 4 & E-279: routing by capability & liveness without try-catch downgrade', () => {
		it('reports a typed undeliverable when agent cannot reply and no dispatcher is wired (no fake handover success)', async () => {
			// dsh agent cannot reply (canReply=false)
			const run = createDummyRun({ agent_id: 'dsh', rework_count: 0 });
			runsStore.set(run.id, run);
			snapshotsStore.set('snap-1', {
				launch_spec_json: JSON.stringify({ adapterKind: 'native', agentId: 'dsh' }),
			});
			// Process is alive, but agent lacks canReply capability
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: 'run-rev-1',
				targetRunId: run.id,
				reworkText: '- R1: dsh 返工意见',
				source: 'review',
			});

			// #136: 没有消费者时 handover 不是成功——必须回类型化失败，让调用方报 E_MESSAGE_UNDELIVERED。
			expect(result.success).toBe(false);
			expect(result.action).toBe('undeliverable');
			expect(result.mode).toBe('undeliverable');
			if (result.action === 'undeliverable') {
				expect(result.reason).toBe('session_dispatch_unavailable');
				expect(result.targetRunId).toBe(run.id);
				expect(result.reviewRunId).toBe('run-rev-1');
			}

			// Delivery MUST NOT have been attempted (no trial-and-error downgrade!)
			expect(mockMessageService.sendMessage).not.toHaveBeenCalled();
		});

		it('reports a typed undeliverable when the process has ended and no dispatcher is wired', async () => {
			// codex supports canReply, but process has already exited
			const run = createDummyRun({ agent_id: 'codex', state: 'exited' });
			runsStore.set(run.id, run);
			snapshotsStore.set('snap-1', {
				launch_spec_json: JSON.stringify({ adapterKind: 'native', agentId: 'codex' }),
			});
			// Process in registry is marked exited
			mockProcessRegistry.set(run.id, createMockProcess(run.id, false));

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: 'run-rev-1',
				targetRunId: run.id,
				reworkText: '- R1: 进程已结束的返工',
				source: 'review',
			});

			expect(result.success).toBe(false);
			expect(result.action).toBe('undeliverable');
			expect(result.mode).toBe('undeliverable');
			if (result.action === 'undeliverable') {
				expect(result.reason).toBe('session_dispatch_unavailable');
				expect(result.targetRunId).toBe(run.id);
			}

			// Delivery MUST NOT have been attempted
			expect(mockMessageService.sendMessage).not.toHaveBeenCalled();
		});

		it('invokes delegateToSessionRework hook with handover payload when injected', async () => {
			const run = createDummyRun({ agent_id: 'dsh' });
			runsStore.set(run.id, run);
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const mockDelegate = vi.fn().mockResolvedValue({
				success: true,
				action: 'new_run_spawned',
				mode: 'new_run',
				targetRunId: run.id,
				reworkCount: 1,
			});

			const service = makeService({
				delegateToSessionRework: mockDelegate,
			});

			const result = await service.dispatchRework({
				reviewRunId: 'rev-99',
				targetRunId: run.id,
				reworkText: '- R1: 必须新开会话',
				source: 'review',
			});

			expect(mockDelegate).toHaveBeenCalledWith(
				expect.objectContaining({
					reviewRunId: 'rev-99',
					targetRunId: run.id,
					reworkText: '- R1: 必须新开会话',
					source: 'review',
				}),
			);
			expect(result).toEqual(
				expect.objectContaining({
					action: 'new_run_spawned',
				}),
			);
		});
	});

	describe('Session Archival (E-302 / M6-T10) & Error handling', () => {
		it('rejects rework reinjection with E_SESSION_ARCHIVED when session has been archived', async () => {
			const run = createDummyRun({
				session_archived_at: '2026-09-16T08:00:00.000Z',
			});
			runsStore.set(run.id, run);
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();
			await expect(
				service.dispatchRework({
					targetRunId: run.id,
					reworkText: '- R1: 尝试向归档会话回灌',
					source: 'review',
				}),
			).rejects.toThrow(AppError);

			try {
				await service.dispatchRework({
					targetRunId: run.id,
					reworkText: '- R1: 尝试向归档会话回灌',
					source: 'review',
				});
			} catch (err) {
				expect((err as AppError).code).toBe('E_SESSION_ARCHIVED');
			}
		});

		it('transitions to awaiting_human when message delivery fails unexpectedly at transport layer (E-112, E-113)', async () => {
			const run = createDummyRun({ rework_count: 0 });
			runsStore.set(run.id, run);
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			// Simulate unexpected transport break during sendMessage
			const sendMock = mockMessageService.sendMessage as unknown as ReturnType<typeof vi.fn>;
			sendMock.mockRejectedValueOnce(new AppError('E_MESSAGE_UNDELIVERED', 'Pipe broken suddenly'));

			const service = makeService();

			await expect(
				service.dispatchRework({
					targetRunId: run.id,
					reworkText: '- R1: 管道突然断裂',
					source: 'review',
				}),
			).rejects.toThrow(AppError);

			// Assert run state was transitioned to awaiting_human with injection_failed
			const updated = runsStore.get(run.id);
			expect(updated?.state).toBe('awaiting_human');
			expect(updated?.queued_reason).toBe(REWORK_TRANSITION_REASONS.INJECTION_FAILED);
		});
	});

	describe('Helper methods: canReinject and checkRetryLimit', () => {
		it('canReinject returns true only for living process with canReply capability', async () => {
			const runCodex = createDummyRun({ id: 'r-codex', agent_id: 'codex' });
			const runDsh = createDummyRun({ id: 'r-dsh', agent_id: 'dsh' });
			runsStore.set(runCodex.id, runCodex);
			runsStore.set(runDsh.id, runDsh);

			mockProcessRegistry.set(runCodex.id, createMockProcess(runCodex.id, true));
			mockProcessRegistry.set(runDsh.id, createMockProcess(runDsh.id, true));

			const service = makeService();

			expect(await service.canReinject(runCodex.id)).toBe(true);
			expect(await service.canReinject(runDsh.id)).toBe(false); // dsh lacks canReply
			expect(await service.canReinject('non-existent')).toBe(false);
		});

		it('checkRetryLimit reports retry status accurately', async () => {
			const run0 = createDummyRun({ id: 'r-0', rework_count: 0 });
			const run1 = createDummyRun({ id: 'r-1', rework_count: 1 });
			const run2 = createDummyRun({ id: 'r-2', rework_count: 2 });
			runsStore.set(run0.id, run0);
			runsStore.set(run1.id, run1);
			runsStore.set(run2.id, run2);

			const service = makeService();

			const check0 = await service.checkRetryLimit('r-0');
			expect(check0.atLimit).toBe(false);
			expect(check0.currentCount).toBe(0);
			expect(check0.maxCount).toBe(2);

			const check1 = await service.checkRetryLimit('r-1');
			expect(check1.atLimit).toBe(false);
			expect(check1.currentCount).toBe(1);

			const check2 = await service.checkRetryLimit('r-2');
			expect(check2.atLimit).toBe(true);
			expect(check2.currentCount).toBe(2);
		});
	});

	describe('Real RunsRepo SQLite persistence for rework_count (R1)', () => {
		const migrationsDirectory = resolve(
			dirname(fileURLToPath(import.meta.url)),
			'../../migrations',
		);

		function setupRealTestDb(): DatabaseConnection {
			const db = openDatabase(':memory:');
			const runner = createMigrationRunner({
				database: db,
				clock: { now: () => '2026-09-15T12:00:00.000Z' },
				fileSystem: {
					readDirectory: (p: string) => readdirSync(p),
					readFile: (p: string) => readFileSync(p, 'utf8'),
				},
			});
			runner.run(migrationsDirectory);

			db.prepare(
				"INSERT INTO documents (id, docs_path, project_name, content_fingerprint, imported_at, last_seen_at) VALUES ('doc-1', '/doc/path', 'project', 'hash1', '2026-09-15T12:00:00.000Z', '2026-09-15T12:00:00.000Z')",
			).run();
			db.prepare(
				"INSERT INTO tasks (id, doc_id, task_key, title, module_key, deps_json, contract_hash, contract_reasons_json) VALUES ('task-uuid-1', 'doc-1', 'M7-T4', 'title', 'M7', '[]', 'hash', '[]')",
			).run();
			db.prepare(
				"INSERT INTO dispatch_snapshots (id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at) VALUES ('snap-001', 'task-uuid-1', 'hash', '[]', '{}', '2026-09-15T12:00:00.000Z')",
			).run();
			db.prepare(
				"INSERT INTO runs (id, task_id, attempt_no, kind, state, agent_id, permission_tier, snapshot_id, rework_count) VALUES ('run-sql-1', 'task-uuid-1', 1, 'implement', 'reviewing', 'codex', 'workspaceWrite', 'snap-001', 0)",
			).run();
			return db;
		}

		it('persists rework_count updates into SQLite via updateReworkCount and updateState', () => {
			const db = setupRealTestDb();
			const repo = createRunsRepo(db);

			// Initial state
			const initial = repo.findById('run-sql-1');
			expect(initial).not.toBeNull();
			expect(initial?.rework_count).toBe(0);
			expect(initial?.state).toBe('reviewing');

			// 0 -> 1 via updateReworkCount
			repo.updateReworkCount({
				id: 'run-sql-1',
				reworkCount: 1,
				state: 'reworking',
			});
			const step1 = repo.findById('run-sql-1');
			expect(step1?.rework_count).toBe(1);
			expect(step1?.state).toBe('reworking');

			// 1 -> 2 via updateState with reworkCount
			repo.updateState({
				id: 'run-sql-1',
				state: 'running',
				reworkCount: 2,
			});
			const step2 = repo.findById('run-sql-1');
			expect(step2?.rework_count).toBe(2);
			expect(step2?.state).toBe('running');

			// updateState without reworkCount should preserve existing rework_count
			repo.updateState({
				id: 'run-sql-1',
				state: 'reviewing',
			});
			const step3 = repo.findById('run-sql-1');
			expect(step3?.rework_count).toBe(2);
			expect(step3?.state).toBe('reviewing');

			db.close();
		});
	});
});
