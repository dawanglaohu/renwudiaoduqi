import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../../src/config/defaults.ts';
import {
	type StallCheckOutcome,
	type StallDetectorCandidate,
	type StallDetectorService,
	type StallSuspectedEventInput,
	createStallDetectorJob,
} from '../../src/jobs/stall-detector.ts';

describe('stall-detector job (M6-T4, AC 1-4, E-120, E-122, E-22)', () => {
	const BASE_NOW = '2026-09-14T12:00:00.000Z';
	const BASE_NOW_MS = Date.parse(BASE_NOW);

	function createMockClock(initialMs = BASE_NOW_MS) {
		let currentMs = initialMs;
		return {
			now: () => new Date(currentMs).toISOString(),
			nowMs: () => currentMs,
			advance: (ms: number) => {
				currentMs += ms;
			},
			set: (ms: number) => {
				currentMs = ms;
			},
		};
	}

	function createMockService(initialCandidates: StallDetectorCandidate[] = []) {
		let candidates = [...initialCandidates];
		const markedStalled: Array<{
			runId: string;
			details: { durationMs: number; isProminent: boolean; actorDeviceId: null };
		}> = [];
		const clearedStalled: Array<{ runId: string; actorDeviceId: null }> = [];
		const publishedEvents: StallSuspectedEventInput[] = [];
		const awaitingReplyNotifications: StallCheckOutcome[] = [];

		const service: StallDetectorService = {
			findInFlightRuns: vi.fn(async () => candidates),
			markStallSuspected: vi.fn(async (runId, details) => {
				markedStalled.push({ runId, details });
			}),
			clearStallSuspected: vi.fn(async (runId, details) => {
				clearedStalled.push({ runId, actorDeviceId: details.actorDeviceId });
			}),
			publishStalledSuspected: vi.fn(async (eventInput) => {
				publishedEvents.push(eventInput);
			}),
			notifyAwaitingReplyTimeout: vi.fn(async (outcome) => {
				awaitingReplyNotifications.push(outcome);
			}),
		};

		return {
			service,
			markedStalled,
			clearedStalled,
			publishedEvents,
			awaitingReplyNotifications,
			setCandidates: (newCandidates: StallDetectorCandidate[]) => {
				candidates = [...newCandidates];
			},
		};
	}

	describe('AC 1 & E-120 & E-22: 完全无流事件超阈值升级为醒目告警，仍在输出时只标弱提示，不改状态不杀进程', () => {
		it('仍在输出时只标「疑似停滞」弱提示，不改运行状态、不杀进程 (E-120)', async () => {
			const clock = createMockClock(BASE_NOW_MS);
			// 16 分钟前产生最后事件，默认阈值 15 分钟 (900s) -> 已超 15 分钟
			const sixteenMinutesAgo = new Date(BASE_NOW_MS - 16 * 60 * 1000).toISOString();
			// 但子进程在 1 分钟前仍有输出流活动
			const oneMinuteAgo = new Date(BASE_NOW_MS - 1 * 60 * 1000).toISOString();

			const candidate: StallDetectorCandidate = {
				id: 'run-thinking-1',
				taskId: 'task-101',
				state: 'running',
				agentId: 'codex',
				startedAt: new Date(BASE_NOW_MS - 30 * 60 * 1000).toISOString(),
				lastEventAt: sixteenMinutesAgo,
				lastActivityAt: oneMinuteAgo,
				isOutputActive: true, // 仍在持续输出 NDJSON/原始流
			};

			const { service, markedStalled, publishedEvents } = createMockService([candidate]);
			const job = createStallDetectorJob({ service, clock });

			const outcomes = await job.runOnce();

			expect(outcomes).toHaveLength(1);
			const outcome = outcomes[0];
			expect(outcome).toBeDefined();
			if (!outcome) return;

			// 验证弱提示判定
			expect(outcome.classification).toBe('weak_suspected');
			expect(outcome.isStalled).toBe(true);
			expect(outcome.isProminent).toBe(false);
			expect(outcome.notified).toBe(true);
			// 硬性要求：绝不改运行状态（state 依然是 running）
			expect(outcome.state).toBe('running');

			// 验证写库与事件发布
			expect(markedStalled).toHaveLength(1);
			expect(markedStalled[0]?.details.isProminent).toBe(false);
			expect(markedStalled[0]?.details.actorDeviceId).toBeNull();

			expect(publishedEvents).toHaveLength(1);
			expect(publishedEvents[0]?.kind).toBe('run.stalled_suspected');
			expect(publishedEvents[0]?.payload.severity).toBe('weak');
			expect(publishedEvents[0]?.payload.isProminent).toBe(false);
			expect(publishedEvents[0]?.payload.alertLevel).toBe('weak');
		});

		it('完全无流事件超阈值升级为醒目告警，标疑似卡住并给出原始流与终止入口，不改状态不杀进程 (AC 1, E-22)', async () => {
			const clock = createMockClock(BASE_NOW_MS);
			// 20 分钟前完全无任何新输出，阈值 15 分钟
			const twentyMinutesAgo = new Date(BASE_NOW_MS - 20 * 60 * 1000).toISOString();

			const candidate: StallDetectorCandidate = {
				id: 'run-dead-silent-1',
				taskId: 'task-102',
				state: 'running',
				agentId: 'codex',
				startedAt: new Date(BASE_NOW_MS - 30 * 60 * 1000).toISOString(),
				lastEventAt: twentyMinutesAgo,
				lastActivityAt: twentyMinutesAgo,
				isOutputActive: false, // 完全零流输出
			};

			const { service, markedStalled, publishedEvents } = createMockService([candidate]);
			const job = createStallDetectorJob({ service, clock });

			const outcomes = await job.runOnce();

			expect(outcomes).toHaveLength(1);
			const outcome = outcomes[0];
			expect(outcome).toBeDefined();
			if (!outcome) return;

			// 验证醒目告警升级
			expect(outcome.classification).toBe('prominent_stalled');
			expect(outcome.isStalled).toBe(true);
			expect(outcome.isProminent).toBe(true);
			expect(outcome.notified).toBe(true);
			// 硬性要求：绝不改运行状态
			expect(outcome.state).toBe('running');
			// E-22: 给出查看原始流与终止的入口
			expect(outcome.actionHint).toBe('view_raw_log_or_abort');
			expect(outcome.message).toContain('无新输出');

			// 验证标记与事件 payload
			expect(markedStalled).toHaveLength(1);
			expect(markedStalled[0]?.details.isProminent).toBe(true);

			expect(publishedEvents).toHaveLength(1);
			expect(publishedEvents[0]?.kind).toBe('run.stalled_suspected');
			expect(publishedEvents[0]?.payload.severity).toBe('prominent');
			expect(publishedEvents[0]?.payload.isProminent).toBe(true);
			expect(publishedEvents[0]?.payload.alertLevel).toBe('prominent');
			const vendor = publishedEvents[0]?.payload.vendor as Record<string, unknown> | undefined;
			expect(vendor?.actionHint).toBe('view_raw_log_or_abort');
		});

		it('活动时间在阈值内时判定为正常 (normal)，不发事件也不置标记', async () => {
			const clock = createMockClock(BASE_NOW_MS);
			// 5 分钟前有事件，阈值 15 分钟
			const fiveMinutesAgo = new Date(BASE_NOW_MS - 5 * 60 * 1000).toISOString();

			const candidate: StallDetectorCandidate = {
				id: 'run-active-1',
				taskId: 'task-103',
				state: 'running',
				agentId: 'codex',
				startedAt: new Date(BASE_NOW_MS - 10 * 60 * 1000).toISOString(),
				lastEventAt: fiveMinutesAgo,
				isOutputActive: true,
			};

			const { service, markedStalled, publishedEvents } = createMockService([candidate]);
			const job = createStallDetectorJob({ service, clock });

			const outcomes = await job.runOnce();

			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]?.classification).toBe('normal');
			expect(outcomes[0]?.isStalled).toBe(false);
			expect(outcomes[0]?.isProminent).toBe(false);
			expect(markedStalled).toHaveLength(0);
			expect(publishedEvents).toHaveLength(0);
		});
	});

	describe('AC 2: 阈值按 agent 可配、有出厂默认，不做全局单一阈值', () => {
		it('根据不同 agent 配置独立的阈值，杜绝全局单一阈值', async () => {
			const clock = createMockClock(BASE_NOW_MS);
			// 8 分钟前的事件
			const eightMinutesAgo = new Date(BASE_NOW_MS - 8 * 60 * 1000).toISOString();

			// codex 阈值设为 5 分钟 (300_000 ms) -> 8 分钟已超时
			// claude 阈值设为 10 分钟 (600_000 ms) -> 8 分钟未超时
			const candidateCodex: StallDetectorCandidate = {
				id: 'run-codex-fast',
				taskId: 'task-codex',
				state: 'running',
				agentId: 'codex',
				lastEventAt: eightMinutesAgo,
				isOutputActive: false,
			};

			const candidateClaude: StallDetectorCandidate = {
				id: 'run-claude-slow',
				taskId: 'task-claude',
				state: 'running',
				agentId: 'claude',
				lastEventAt: eightMinutesAgo,
				isOutputActive: false,
			};

			const { service } = createMockService([candidateCodex, candidateClaude]);

			const job = createStallDetectorJob({
				service,
				clock,
				agentTimeoutOverrides: {
					codex: 5 * 60 * 1000,
					claude: 10 * 60 * 1000,
				},
			});

			const outcomes = await job.runOnce();

			const codexOutcome = outcomes.find((o) => o.runId === 'run-codex-fast');
			const claudeOutcome = outcomes.find((o) => o.runId === 'run-claude-slow');

			expect(codexOutcome).toBeDefined();
			expect(claudeOutcome).toBeDefined();
			if (!codexOutcome || !claudeOutcome) return;

			// codex 阈值 5 分钟 -> 8 分钟超阈值 (prominent_stalled)
			expect(codexOutcome.timeoutMs).toBe(300_000);
			expect(codexOutcome.classification).toBe('prominent_stalled');
			expect(codexOutcome.isStalled).toBe(true);

			// claude 阈值 10 分钟 -> 8 分钟正常 (normal)
			expect(claudeOutcome.timeoutMs).toBe(600_000);
			expect(claudeOutcome.classification).toBe('normal');
			expect(claudeOutcome.isStalled).toBe(false);
		});

		it('未显式覆盖时回退出厂默认 DEFAULT_IDLE_TIMEOUT_MS (900s)', async () => {
			const clock = createMockClock(BASE_NOW_MS);
			const candidate: StallDetectorCandidate = {
				id: 'run-default-agent',
				taskId: 'task-default',
				state: 'running',
				agentId: 'generic-agent',
				lastEventAt: BASE_NOW,
			};

			const { service } = createMockService([candidate]);
			const job = createStallDetectorJob({ service, clock });

			const outcomes = await job.runOnce();
			expect(outcomes[0]?.timeoutMs).toBe(DEFAULT_IDLE_TIMEOUT_MS);
		});
	});

	describe('AC 3 & E-122: 处于「等待人回话」时归类为「等人」而非「疑似停滞」，不重复告警，超阈值后提示「中止以释放并发窗口」', () => {
		it('awaiting_reply 超阈值时归类为 waiting_human 而非疑似停滞，提示中止以释放并发窗口 (E-122)', async () => {
			const clock = createMockClock(BASE_NOW_MS);
			const twentyMinutesAgo = new Date(BASE_NOW_MS - 20 * 60 * 1000).toISOString();

			const candidate: StallDetectorCandidate = {
				id: 'run-waiting-reply-1',
				taskId: 'task-gate-1',
				state: 'awaiting_reply', // 处于「等待人回话」
				agentId: 'codex',
				startedAt: new Date(BASE_NOW_MS - 30 * 60 * 1000).toISOString(),
				lastEventAt: twentyMinutesAgo,
				isOutputActive: false,
			};

			const { service, markedStalled, publishedEvents, awaitingReplyNotifications } =
				createMockService([candidate]);
			const job = createStallDetectorJob({ service, clock });

			const outcomes = await job.runOnce();

			expect(outcomes).toHaveLength(1);
			const outcome = outcomes[0];
			expect(outcome).toBeDefined();
			if (!outcome) return;

			// 严格归类为「等人」而非「疑似停滞」
			expect(outcome.classification).toBe('waiting_human');
			expect(outcome.isStalled).toBe(false);
			expect(outcome.isProminent).toBe(false);
			expect(outcome.notified).toBe(true);

			// 提示「中止以释放并发窗口」
			expect(outcome.actionHint).toBe('中止以释放并发窗口');
			expect(outcome.message).toContain('中止以释放并发窗口');

			// 绝对不得被标记为停滞，也不得发 run.stalled_suspected 事件
			expect(markedStalled).toHaveLength(0);
			expect(publishedEvents).toHaveLength(0);

			// 触发 awaiting_reply 回调通知
			expect(awaitingReplyNotifications).toHaveLength(1);
			expect(awaitingReplyNotifications[0]?.runId).toBe('run-waiting-reply-1');
		});

		it('同一个 awaiting_reply 等待周期内后续 tick 不重复告警 (AC 3, E-122)', async () => {
			const clock = createMockClock(BASE_NOW_MS);
			const twentyMinutesAgo = new Date(BASE_NOW_MS - 20 * 60 * 1000).toISOString();

			const candidate: StallDetectorCandidate = {
				id: 'run-waiting-reply-dedup',
				taskId: 'task-gate-2',
				state: 'awaiting_reply',
				agentId: 'codex',
				lastEventAt: twentyMinutesAgo,
			};

			const { service, awaitingReplyNotifications } = createMockService([candidate]);
			const job = createStallDetectorJob({ service, clock });

			// 第一次 tick：触发首次通知
			const outcomesFirst = await job.runOnce();
			expect(outcomesFirst[0]?.notified).toBe(true);
			expect(awaitingReplyNotifications).toHaveLength(1);

			// 时间推进 30 秒进行第二次 tick
			clock.advance(30 * 1000);
			const outcomesSecond = await job.runOnce();

			// 仍归类为 waiting_human，但 notified 标 false，且不重复调用通知回调
			expect(outcomesSecond[0]?.classification).toBe('waiting_human');
			expect(outcomesSecond[0]?.notified).toBe(false);
			expect(awaitingReplyNotifications).toHaveLength(1); // 保持为 1，不重复告警
		});
	});

	describe('AC 4: tick 不重入，上一次未完成则跳过本次并计数', () => {
		it('上一轮 tick 处于 in-flight 时，跳过本次 tick 并递增 skippedTicksCount', async () => {
			const clock = createMockClock(BASE_NOW_MS);
			let resolveInFlight: (() => void) | undefined;
			const slowInFlightPromise = new Promise<void>((resolve) => {
				resolveInFlight = resolve;
			});

			const service: StallDetectorService = {
				findInFlightRuns: vi.fn(async () => {
					await slowInFlightPromise;
					return [];
				}),
			};

			const job = createStallDetectorJob({ service, clock });

			// 触发第一次 tick（它会暂停在 slowInFlightPromise）
			const firstPass = job.runOnce();

			expect(job.getStats().inFlight).toBe(true);
			expect(job.getStats().skippedTicksCount).toBe(0);

			// 在第一次 tick 仍在进行中时，再次触发第二次与第三次 tick
			const secondPass = job.runOnce();
			const thirdPass = job.runOnce();

			// 验证跳过了两次 tick 并正确计数
			expect(job.getStats().skippedTicksCount).toBe(2);

			// 解除第一次 tick 的挂起
			resolveInFlight?.();
			await firstPass;
			await secondPass;
			await thirdPass;

			expect(job.getStats().inFlight).toBe(false);
			expect(job.getStats().completedTicksCount).toBe(1);
			expect(job.getStats().skippedTicksCount).toBe(2);
		});
	});

	describe('定时器与生命周期控制', () => {
		it('start() 启动定时任务并在 stop() 时清理定时器且等待当前 pass 结束', async () => {
			vi.useFakeTimers();
			try {
				const clock = createMockClock(BASE_NOW_MS);
				const { service } = createMockService([]);
				const job = createStallDetectorJob({
					service,
					clock,
					intervalMs: 1000,
				});

				expect(job.name).toBe('stall-detector');
				job.start();

				// 推进时间触发定时器
				await vi.advanceTimersByTimeAsync(3000);

				expect(service.findInFlightRuns).toHaveBeenCalled();

				await job.stop();
			} finally {
				vi.useRealTimers();
			}
		});

		it('异常隔离：service 抛错时不冒泡到 unhandledRejection，记录到 logFailure', async () => {
			const clock = createMockClock(BASE_NOW_MS);
			const logFailure = vi.fn();
			const service: StallDetectorService = {
				findInFlightRuns: vi.fn(async () => {
					throw new Error('Database connection failed');
				}),
			};

			const job = createStallDetectorJob({ service, clock, logFailure });

			// 不抛出异常
			const outcomes = await job.runOnce();
			expect(outcomes).toEqual([]);
			expect(logFailure).toHaveBeenCalledWith(expect.any(Error));
		});
	});
});
