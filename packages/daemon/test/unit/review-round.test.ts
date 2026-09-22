import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/errors/app-error.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import type { ProcessRegistry } from '../../src/proc/registry.ts';
import type { RunInsertRow, RunRow } from '../../src/repo/runs.ts';
import type { MessageService, ResumeSessionInput } from '../../src/service/message.ts';
import {
	type ReviewRunsRepo,
	type ReviewServiceDeps,
	createReviewService,
} from '../../src/service/review.ts';

/** 完整的 RunRow 基线：M7-T7 的续接入口读的是真实 RunsRepo 的运行行（snake_case）。 */
const BASE_ROW: RunRow = {
	id: 'review-1',
	task_id: 'task-1',
	attempt_no: 1,
	kind: 'review',
	parent_run_id: 'impl-1',
	state: 'exited',
	review_verdict: null,
	agent_id: 'agent-1',
	model_name: 'model-1',
	reported_model: null,
	effort_tier: 'high',
	reported_effort: null,
	permission_tier: 'readOnly',
	snapshot_id: 'snap-1',
	worktree_path: '/tmp/wt',
	branch_name: 'task/M1-T1',
	pid: null,
	exit_code: 0,
	exit_signal: null,
	vendor_session_ref: null,
	changed_file_count: null,
	token_usage_json: null,
	unmapped_event_count: 0,
	is_stall_suspected: 0,
	rework_count: 0,
	queued_reason: null,
	idempotency_key: null,
	actor_device_id: null,
	started_at: '2026-09-16T00:00:00.000Z',
	last_event_at: null,
	ended_at: null,
	lane_no: 1,
	session_archived_at: null,
	effort_vendor: null,
	review_round: 1,
	continued_from_run_id: null,
	assignment_source: 'task',
};

function makeReviewRow(overrides: Partial<RunRow> = {}): RunRow {
	return { ...BASE_ROW, ...overrides };
}

function makeRunsRepo(overrides: Partial<ReviewRunsRepo> = {}): ReviewRunsRepo {
	return {
		findById: () => null,
		updateState: () => {},
		findLatestReview: () => null,
		insert: () => {},
		updateReviewRound: () => {},
		...overrides,
	};
}

function makeMessageService(overrides: Partial<MessageService> = {}): MessageService {
	return {
		sendMessage: async (input) => ({
			delivered: true,
			messageId: 'msg-1',
			text: input.text,
			deliveryState: 'delivered',
			runId: input.runId,
		}),
		deliverMessage: async (input) => ({
			delivered: true,
			messageId: 'msg-1',
			text: input.text,
			deliveryState: 'delivered',
			runId: input.runId,
		}),
		canReply: async () => true,
		getCapabilities: () => ({ canReply: true, canResume: true }),
		getMessage: async () => null,
		getRunMessages: async () => [],
		getUndeliveredMessages: async () => [],
		...overrides,
	};
}

function makeProcessRegistry(overrides: Partial<ProcessRegistry> = {}): ProcessRegistry {
	return {
		register: () => {},
		get: () => undefined,
		getByPid: () => undefined,
		has: () => false,
		hasPid: () => false,
		reassign: () => {},
		unregister: () => false,
		list: () => [],
		size: 0,
		clear: () => {},
		...overrides,
	};
}

function makeIds(): { newId: () => string } {
	let n = 0;
	return { newId: () => `run-${++n}` };
}

const CLOCK = { now: () => '2026-09-17T00:00:00.000Z' };

function makeService(
	runsRepo: ReviewRunsRepo,
	overrides: Partial<ReviewServiceDeps> = {},
): ReturnType<typeof createReviewService> {
	return createReviewService({
		runsRepo,
		clock: CLOCK,
		ids: makeIds(),
		...overrides,
	});
}

describe('Review Round Integration (M7-T7)', () => {
	it('AC 1 & E-89：没有上一轮审查行时拒绝续接', async () => {
		const service = makeService(makeRunsRepo({ findLatestReview: () => null }));

		await expect(
			service.startReviewRound({
				taskId: 'task-1',
				implRunId: 'impl-1',
				round: 2,
				reworkItems: [],
			}),
		).rejects.toThrow(AppError);
	});

	it('AC 4 & E-302：续接目标会话已归档 → E_SESSION_ARCHIVED', async () => {
		const service = makeService(
			makeRunsRepo({
				findLatestReview: () => makeReviewRow({ session_archived_at: '2026-09-16T01:00:00.000Z' }),
			}),
		);

		await expect(
			service.startReviewRound({
				taskId: 'task-1',
				implRunId: 'impl-1',
				round: 2,
				reworkItems: [],
			}),
		).rejects.toThrow('Session archived');
	});

	it('AC 1 & 决策 89：续接目标跨任务或不是 review 行 → 拒绝', async () => {
		for (const row of [
			makeReviewRow({ task_id: 'task-other' }),
			makeReviewRow({ kind: 'implement' }),
		]) {
			const service = makeService(makeRunsRepo({ findLatestReview: () => row }));
			await expect(
				service.startReviewRound({
					taskId: 'task-1',
					implRunId: 'impl-1',
					round: 2,
					reworkItems: [],
				}),
			).rejects.toThrow(AppError);
		}
	});

	it('AC 5 & AC 6：上一轮 review_round 为 NULL 时按 1 处理，新行写 2 且不回填旧行', async () => {
		const inserted: RunInsertRow[] = [];
		const service = makeService(
			makeRunsRepo({
				findLatestReview: () => makeReviewRow({ review_round: null, vendor_session_ref: null }),
				insert: (row) => inserted.push(row),
			}),
		);

		const runId = await service.startReviewRound({
			taskId: 'task-1',
			implRunId: 'impl-1',
			round: 2,
			reworkItems: [],
		});

		expect(runId).toBe('run-1');
		expect(inserted[0]).toMatchObject({
			kind: 'review',
			review_round: 2,
			continued_from_run_id: 'review-1',
			vendor_session_ref: null,
			permission_tier: 'readOnly',
			parent_run_id: 'impl-1',
		});
	});

	it('AC 2 & E-304：注册表仍持有上一轮进程且 canReply → reply，换绑后注入轮次头部', async () => {
		const inserted: RunInsertRow[] = [];
		const reassign = vi.fn();
		const deliver = vi.fn(async (input: Parameters<MessageService['deliverMessage']>[0]) => ({
			delivered: true,
			messageId: 'msg-1',
			text: input.text,
			deliveryState: 'delivered' as const,
			runId: input.runId,
		}));
		const service = makeService(
			makeRunsRepo({
				findLatestReview: () => makeReviewRow({ vendor_session_ref: 'sess-1' }),
				insert: (row) => inserted.push(row),
			}),
			{
				processRegistry: makeProcessRegistry({ has: () => true, reassign }),
				messageService: makeMessageService({
					getCapabilities: () => ({ canReply: true, canResume: false }),
					deliverMessage: deliver,
				}),
			},
		);

		const runId = await service.startReviewRound({
			taskId: 'task-1',
			implRunId: 'impl-1',
			round: 2,
			reworkItems: ['R1 补齐事务边界'],
		});

		expect(runId).toBe('run-1');
		expect(inserted).toHaveLength(1);
		// reply 分支继承会话引用，并把进程换绑到新行。
		expect(inserted[0]?.vendor_session_ref).toBe('sess-1');
		expect(reassign).toHaveBeenCalledWith('review-1', 'run-1');
		const delivered = deliver.mock.calls[0]?.[0];
		expect(delivered?.kind).toBe('reply');
		expect(delivered?.text).toContain('第 2 轮，只核上一轮的 R 条目');
		expect(delivered?.text).toContain('R1 补齐事务边界');
	});

	it('AC 2：进程已结束且 canResume 且有会话引用 → resume 走注入的 resumeSession', async () => {
		const inserted: RunInsertRow[] = [];
		const resumeSession = vi.fn(async (_input: ResumeSessionInput) => ({
			newRunId: 'run-1',
			messageId: 'msg-1',
			delivered: true,
		}));
		const service = makeService(
			makeRunsRepo({
				findLatestReview: () => makeReviewRow({ vendor_session_ref: 'sess-1' }),
				insert: (row) => inserted.push(row),
			}),
			{
				processRegistry: makeProcessRegistry({ has: () => false }),
				messageService: makeMessageService({
					getCapabilities: () => ({ canReply: false, canResume: true }),
				}),
				resumeSession,
			},
		);

		const runId = await service.startReviewRound({
			taskId: 'task-1',
			implRunId: 'impl-1',
			round: 2,
			reworkItems: ['R2 只核这条'],
		});

		expect(runId).toBe('run-1');
		expect(inserted[0]?.vendor_session_ref).toBe('sess-1');
		expect(resumeSession).toHaveBeenCalledTimes(1);
		const resumed = resumeSession.mock.calls[0]?.[0];
		expect(resumed?.runId).toBe('run-1');
		expect(resumed?.taskId).toBe('task-1');
		expect(resumed?.text).toContain('第 2 轮，只核上一轮的 R 条目');
	});

	it('AC 2 & E-304：canReply 与 canResume 皆假 → 直接 new_session，vendor_session_ref 为空', async () => {
		const inserted: RunInsertRow[] = [];
		const deliver = vi.fn(async (_input: Parameters<MessageService['deliverMessage']>[0]) => ({
			delivered: false,
			messageId: 'msg-1',
			text: '',
			deliveryState: 'undelivered' as const,
			runId: '',
		}));
		const resumeSession = vi.fn(async (_input: ResumeSessionInput) => ({
			newRunId: 'run-1',
			messageId: 'msg-1',
			delivered: false,
		}));
		const service = makeService(
			makeRunsRepo({
				findLatestReview: () => makeReviewRow({ vendor_session_ref: 'sess-1' }),
				insert: (row) => inserted.push(row),
			}),
			{
				processRegistry: makeProcessRegistry({ has: () => false }),
				messageService: makeMessageService({
					getCapabilities: () => ({ canReply: false, canResume: false }),
					deliverMessage: deliver,
				}),
				resumeSession,
			},
		);

		const runId = await service.startReviewRound({
			taskId: 'task-1',
			implRunId: 'impl-1',
			round: 2,
			reworkItems: [],
		});

		expect(runId).toBe('run-1');
		expect(inserted[0]).toMatchObject({ review_round: 2, vendor_session_ref: null });
		expect(deliver).not.toHaveBeenCalled();
		expect(resumeSession).not.toHaveBeenCalled();
	});

	it('E-330：投递未送达 → 降级恰一次，失败行标 failed/continuation_exhausted 且不计入 review_round', async () => {
		const inserted: RunInsertRow[] = [];
		const stateUpdates: Array<{ id: string; toState?: string; queuedReason?: string | null }> = [];
		const roundUpdates: Array<{ id: string; round: number | null }> = [];
		const service = makeService(
			makeRunsRepo({
				findLatestReview: () => makeReviewRow({ vendor_session_ref: 'sess-1' }),
				insert: (row) => inserted.push(row),
				updateState: (input) =>
					stateUpdates.push({
						id: input.id,
						toState: input.toState,
						queuedReason: input.queuedReason,
					}),
				updateReviewRound: (id, round) => roundUpdates.push({ id, round }),
			}),
			{
				processRegistry: makeProcessRegistry({ has: () => true }),
				messageService: makeMessageService({
					getCapabilities: () => ({ canReply: true, canResume: false }),
					deliverMessage: async (input) => ({
						delivered: false,
						messageId: 'msg-1',
						text: input.text,
						deliveryState: 'undelivered' as const,
						runId: input.runId,
					}),
				}),
			},
		);

		const returned = await service.startReviewRound({
			taskId: 'task-1',
			implRunId: 'impl-1',
			round: 2,
			reworkItems: [],
		});

		expect(returned).toBe('run-2');
		expect(inserted.map((row) => row.id)).toEqual(['run-1', 'run-2']);
		expect(inserted[1]).toMatchObject({
			id: 'run-2',
			review_round: 2,
			vendor_session_ref: null,
			continued_from_run_id: 'review-1',
		});
		expect(stateUpdates).toContainEqual({
			id: 'run-1',
			toState: 'failed',
			queuedReason: 'continuation_exhausted',
		});
		expect(roundUpdates).toEqual([{ id: 'run-1', round: null }]);
	});

	it('E-330：投递后、首条内容事件前收到失败事件 → 判撑爆并降级到 new_session', async () => {
		const bus = createEventBus({ ringBuffer: createRingBuffer() });
		const envelopeFactory = createEnvelopeFactory({
			clock: CLOCK,
			idAllocator: {
				allocate: (() => {
					let n = 0;
					return () => ++n;
				})(),
			},
		});
		const inserted: RunInsertRow[] = [];
		let firstRunId = '';
		const service = makeService(
			makeRunsRepo({
				findLatestReview: () => makeReviewRow({ vendor_session_ref: 'sess-1' }),
				insert: (row) => {
					inserted.push(row);
					firstRunId = row.id;
				},
			}),
			{
				bus,
				envelopeFactory,
				processRegistry: makeProcessRegistry({ has: () => true }),
				messageService: makeMessageService({
					getCapabilities: () => ({ canReply: true, canResume: false }),
					deliverMessage: async (input) => {
						// 投递成功，但订阅之前安排一条失败类事件：会话启动即退出。
						setTimeout(() => {
							bus.publish(
								envelopeFactory.createEnvelope({
									kind: 'run.state_changed',
									runId: firstRunId,
									taskId: 'task-1',
									payload: { from: 'starting', to: 'failed', reason: 'spawn_failed' },
								}),
							);
						}, 0);
						return {
							delivered: true,
							messageId: 'msg-1',
							text: input.text,
							deliveryState: 'delivered' as const,
							runId: input.runId,
						};
					},
				}),
			},
		);

		const returned = await service.startReviewRound({
			taskId: 'task-1',
			implRunId: 'impl-1',
			round: 2,
			reworkItems: [],
		});

		expect(returned).toBe('run-2');
		expect(inserted.map((row) => row.id)).toEqual(['run-1', 'run-2']);
	});

	it('E-330：既无事件也不退出 → 走停滞检测，不判撑爆（不新开）', async () => {
		const bus = createEventBus({ ringBuffer: createRingBuffer() });
		const envelopeFactory = createEnvelopeFactory({
			clock: CLOCK,
			idAllocator: {
				allocate: (() => {
					let n = 0;
					return () => ++n;
				})(),
			},
		});
		const inserted: RunInsertRow[] = [];
		const service = makeService(
			makeRunsRepo({
				findLatestReview: () => makeReviewRow({ vendor_session_ref: 'sess-1' }),
				insert: (row) => inserted.push(row),
			}),
			{
				bus,
				envelopeFactory,
				processRegistry: makeProcessRegistry({ has: () => true }),
				messageService: makeMessageService({
					getCapabilities: () => ({ canReply: true, canResume: false }),
					deliverMessage: async (input) => ({
						delivered: true,
						messageId: 'msg-1',
						text: input.text,
						deliveryState: 'delivered' as const,
						runId: input.runId,
					}),
				}),
			},
		);

		vi.useFakeTimers();
		try {
			const pending = service.startReviewRound({
				taskId: 'task-1',
				implRunId: 'impl-1',
				round: 2,
				reworkItems: [],
			});
			// 推进到 CONTINUATION_TIMEOUT_MS（180s）之后：判 pending，不降级。
			await vi.advanceTimersByTimeAsync(180_001);
			const returned = await pending;
			expect(returned).toBe('run-1');
			expect(inserted).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
