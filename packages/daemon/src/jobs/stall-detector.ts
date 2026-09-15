import {
	BUILT_IN_AGENT_DEFAULTS,
	type BuiltInAgentId,
	DEFAULT_IDLE_TIMEOUT_MS,
} from '../config/defaults.ts';
import type { RunState } from '../domain/run-state-machine.ts';
import type { ProcessRegistry } from '../proc/registry.ts';
import type { Clock } from '../proc/timers.ts';

export const DEFAULT_STALL_DETECTOR_INTERVAL_MS = 30_000; // 30s tick (08 节 后端架构)

/**
 * 停滞判定分类。
 * - 'normal': 运行正常未超阈值
 * - 'weak_suspected': 超过思考/空闲阈值但 NDJSON/原始流仍在输出（E-120 弱提示，不改状态、不杀进程）
 * - 'prominent_stalled': 完全无流事件超阈值（E-22 醒目告警，标疑似卡住并给出原始流与终止入口，不改状态、不杀进程）
 * - 'waiting_human': 处于「等待人回话」超时（E-122 归类为等人而非停滞，不重复告警，提示中止以释放并发窗口）
 */
export type StallClassification =
	| 'normal'
	| 'weak_suspected'
	| 'prominent_stalled'
	| 'waiting_human';

export interface StallCheckOutcome {
	readonly runId: string;
	readonly taskId: string;
	readonly state: RunState;
	readonly agentId: string;
	readonly classification: StallClassification;
	readonly silenceDurationMs: number;
	readonly timeoutMs: number;
	readonly isStalled: boolean;
	readonly isProminent: boolean;
	readonly message?: string;
	readonly actionHint?: string;
	readonly notified: boolean;
}

export interface StallDetectorCandidate {
	readonly id: string;
	readonly taskId: string;
	readonly state: RunState;
	readonly agentId: string;
	readonly startedAt?: string | null;
	readonly lastEventAt?: string | null;
	readonly isStallSuspected?: boolean;
	/** Managed process 的活动时间戳（若有），用于识别子进程是否仍在产生输出 (E-120) */
	readonly lastActivityAt?: string | null;
	/** 是否有持续的原始流/NDJSON 输出 (E-120) */
	readonly isOutputActive?: boolean;
}

export interface StallSuspectedEventInput {
	readonly kind: 'run.stalled_suspected';
	readonly runId: string;
	readonly taskId: string;
	readonly actorDeviceId: null;
	readonly payload: {
		readonly durationMs: number;
		readonly severity: 'weak' | 'prominent';
		readonly alertLevel: 'weak' | 'prominent';
		readonly isProminent: boolean;
		readonly vendor?: unknown;
		readonly [key: string]: unknown;
	};
}

export interface StallDetectorService {
	readonly findInFlightRuns: () => Promise<readonly StallDetectorCandidate[]>;
	readonly markStallSuspected?: (
		runId: string,
		details: {
			readonly durationMs: number;
			readonly isProminent: boolean;
			readonly actorDeviceId: null;
		},
	) => Promise<void>;
	readonly clearStallSuspected?: (
		runId: string,
		details: {
			readonly actorDeviceId: null;
		},
	) => Promise<void>;
	readonly publishStalledSuspected?: (eventInput: StallSuspectedEventInput) => Promise<void> | void;
	readonly notifyAwaitingReplyTimeout?: (outcome: StallCheckOutcome) => Promise<void> | void;
}

export interface ProcessActivityProbe {
	/**
	 * 检查指定 runId 对应的子进程是否仍在持续产生输出 (NDJSON/raw lines)。
	 */
	isProcessOutputActive(runId: string, nowMs: number, timeoutMs: number): boolean;
	getProcessLastActivityAt?(runId: string): string | null;
}

export interface StallDetectorDeps {
	readonly service: StallDetectorService;
	readonly clock?: Clock;
	readonly processRegistry?: ProcessRegistry;
	readonly processActivityProbe?: ProcessActivityProbe;
	readonly intervalMs?: number;
	readonly defaultTimeoutMs?: number;
	readonly agentTimeoutOverrides?: Readonly<Record<string, number>>;
	readonly getAgentTimeoutMs?: (agentId: string) => number | undefined;
	readonly logFailure?: (error: unknown) => void;
}

export interface StallDetectorStats {
	readonly skippedTicksCount: number;
	readonly completedTicksCount: number;
	readonly inFlight: boolean;
	readonly lastTickAt: string | null;
}

export interface StallDetectorJob {
	readonly name: string;
	start(): void;
	stop(): Promise<void>;
	runOnce(): Promise<readonly StallCheckOutcome[]>;
	getStats(): StallDetectorStats;
	resetNotificationState(runId?: string): void;
}

const DEFAULT_CLOCK: Clock = Object.freeze({
	now: () => new Date().toISOString(),
	nowMs: () => Date.now(),
});

function parseTimestampMs(timeVal: unknown): number | null {
	if (timeVal === null || timeVal === undefined) {
		return null;
	}
	if (typeof timeVal === 'number' && Number.isFinite(timeVal)) {
		return timeVal >= 0 ? timeVal : null;
	}
	if (timeVal instanceof Date) {
		const ms = timeVal.getTime();
		return Number.isFinite(ms) ? ms : null;
	}
	if (typeof timeVal === 'string') {
		const trimmed = timeVal.trim();
		if (!trimmed) return null;
		const parsed = Date.parse(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/**
 * 停滞检测与静默计时后台工作 (M6-T4, E-120, E-122, E-22)。
 *
 * 验收标准与硬性规则：
 * 1. 完全无流事件超阈值才升级为醒目告警；仍在输出时只标弱提示，不改运行状态、不杀进程 (AC 1, E-22, E-120)。
 * 2. 阈值按 agent 可配、有出厂默认，不做全局单一阈值 (AC 2)。
 * 3. 处于「等待人回话」时归类为「等人」而非「疑似停滞」，不重复告警；超阈值后提示「中止以释放并发窗口」 (AC 3, E-122)。
 * 4. tick 不重入，上一次未完成则跳过本次并计数 (AC 4)。
 * 5. 隔离规则：只调 service、不持有 request/reply、内部 try/catch 防御 unhandledRejection、stop 等待当前 tick 结束。
 */
export function createStallDetectorJob(deps: StallDetectorDeps): StallDetectorJob {
	const clock = deps.clock ?? DEFAULT_CLOCK;
	const readNowMs = (): number =>
		clock.nowMs !== undefined ? clock.nowMs() : Date.parse(clock.now());
	const intervalMs = deps.intervalMs ?? DEFAULT_STALL_DETECTOR_INTERVAL_MS;
	const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const logFailure = deps.logFailure ?? (() => undefined);

	let timer: NodeJS.Timeout | null = null;
	let inFlight: Promise<readonly StallCheckOutcome[]> | null = null;
	let stopRequested = false;

	// 统计数据
	let skippedTicksCount = 0;
	let completedTicksCount = 0;
	let lastTickAt: string | null = null;

	// 通知去重集合（避免每个 30s tick 重复轰炸事件）
	// - awaiting_reply: 同一等待周期内只提醒一次 (AC 3, E-122)
	const notifiedAwaitingReplyRuns = new Set<string>();
	// - weak: 弱提示已发集合
	const notifiedWeakStallRuns = new Set<string>();
	// - prominent: 醒目告警已发集合
	const notifiedProminentStallRuns = new Set<string>();

	function resolveAgentTimeout(agentId: string): number {
		if (deps.agentTimeoutOverrides && agentId in deps.agentTimeoutOverrides) {
			const overridden = deps.agentTimeoutOverrides[agentId];
			if (typeof overridden === 'number' && overridden > 0) {
				return overridden;
			}
		}

		if (deps.getAgentTimeoutMs) {
			const custom = deps.getAgentTimeoutMs(agentId);
			if (typeof custom === 'number' && custom > 0) {
				return custom;
			}
		}

		const builtIn = BUILT_IN_AGENT_DEFAULTS[agentId as BuiltInAgentId]?.timeouts?.idleTimeoutMs;
		if (typeof builtIn === 'number' && builtIn > 0) {
			return builtIn;
		}

		return defaultTimeoutMs;
	}

	function checkIsOutputActive(
		candidate: StallDetectorCandidate,
		nowMs: number,
		timeoutMs: number,
	): boolean {
		// 1. Candidate 自身显式提供了 isOutputActive
		if (candidate.isOutputActive !== undefined) {
			return Boolean(candidate.isOutputActive);
		}

		// 2. Candidate 自身提供了 lastActivityAt
		if (candidate.lastActivityAt) {
			const actMs = parseTimestampMs(candidate.lastActivityAt);
			if (actMs !== null && nowMs - actMs < timeoutMs) {
				return true;
			}
		}

		// 3. 注入的 ProcessActivityProbe 探测器
		if (deps.processActivityProbe) {
			return deps.processActivityProbe.isProcessOutputActive(candidate.id, nowMs, timeoutMs);
		}

		// 4. 注入的 ProcessRegistry 探测 ManagedProcess
		if (deps.processRegistry) {
			const proc = deps.processRegistry.get(candidate.id);
			if (proc) {
				// 优先检查 timers.lastActivityAt
				const lastAct = proc.timers?.lastActivityAt;
				if (lastAct) {
					const actMs = parseTimestampMs(lastAct);
					if (actMs !== null && nowMs - actMs < timeoutMs) {
						return true;
					}
				}
				// 若提供了 idleDurationMs，未超阈值视为活跃
				if (typeof proc.timers?.idleDurationMs === 'function') {
					if (proc.timers.idleDurationMs(nowMs) < timeoutMs) {
						return true;
					}
				}
			}
		}

		return false;
	}

	async function processSingleCandidate(
		candidate: StallDetectorCandidate,
		nowMs: number,
	): Promise<StallCheckOutcome> {
		const timeoutMs = resolveAgentTimeout(candidate.agentId);

		// 基准时间：优先使用 M6-T3 提取的 last_event_at；若尚未产生事件则使用 started_at
		const baseTimeStr = candidate.lastEventAt ?? candidate.startedAt;
		const baseTimeMs = parseTimestampMs(baseTimeStr);

		const silenceDurationMs =
			baseTimeMs !== null && nowMs >= baseTimeMs ? Math.max(0, nowMs - baseTimeMs) : 0;

		// 1. 等待人回话状态处理 (AC 3 & E-122)
		if (candidate.state === 'awaiting_reply') {
			if (silenceDurationMs < timeoutMs) {
				return {
					runId: candidate.id,
					taskId: candidate.taskId,
					state: candidate.state,
					agentId: candidate.agentId,
					classification: 'normal',
					silenceDurationMs,
					timeoutMs,
					isStalled: false,
					isProminent: false,
					notified: false,
				};
			}

			// 超出阈值：归类为「等人」而非「疑似停滞」，不重复告警；超阈值后提示「中止以释放并发窗口」 (AC 3, E-122)
			const alreadyNotified = notifiedAwaitingReplyRuns.has(candidate.id);
			let notified = false;

			if (!alreadyNotified) {
				notifiedAwaitingReplyRuns.add(candidate.id);
				notified = true;

				const outcome: StallCheckOutcome = {
					runId: candidate.id,
					taskId: candidate.taskId,
					state: candidate.state,
					agentId: candidate.agentId,
					classification: 'waiting_human',
					silenceDurationMs,
					timeoutMs,
					isStalled: false,
					isProminent: false,
					message: '任务停在「等待人回话」超过阈值，提示中止以释放并发窗口',
					actionHint: '中止以释放并发窗口',
					notified: true,
				};

				if (deps.service.notifyAwaitingReplyTimeout) {
					await deps.service.notifyAwaitingReplyTimeout(outcome);
				}
				return outcome;
			}

			return {
				runId: candidate.id,
				taskId: candidate.taskId,
				state: candidate.state,
				agentId: candidate.agentId,
				classification: 'waiting_human',
				silenceDurationMs,
				timeoutMs,
				isStalled: false,
				isProminent: false,
				message: '任务停在「等待人回话」超过阈值（已提醒，不重复告警）',
				actionHint: '中止以释放并发窗口',
				notified: false,
			};
		}

		// 2. 正常在途运行状态（running, starting 等）
		if (silenceDurationMs < timeoutMs) {
			// 如果曾经被标过停滞，但现在恢复了活动（silenceDurationMs 回落），清理已通知记录
			if (notifiedWeakStallRuns.has(candidate.id) || notifiedProminentStallRuns.has(candidate.id)) {
				notifiedWeakStallRuns.delete(candidate.id);
				notifiedProminentStallRuns.delete(candidate.id);
				if (candidate.isStallSuspected && deps.service.clearStallSuspected) {
					await deps.service.clearStallSuspected(candidate.id, { actorDeviceId: null });
				}
			}

			return {
				runId: candidate.id,
				taskId: candidate.taskId,
				state: candidate.state,
				agentId: candidate.agentId,
				classification: 'normal',
				silenceDurationMs,
				timeoutMs,
				isStalled: false,
				isProminent: false,
				notified: false,
			};
		}

		// 超出阈值！需要区分：仍在输出（E-120 弱提示） vs 完全无流事件（AC 1 / E-22 醒目告警）
		const isOutputActive = checkIsOutputActive(candidate, nowMs, timeoutMs);

		if (isOutputActive) {
			// E-120: 长思考被误判停滞。超过阈值但 NDJSON/原始流仍在输出 -> 只标「疑似停滞」弱提示，不改运行状态、不杀进程
			const alreadyNotified = notifiedWeakStallRuns.has(candidate.id);
			let notified = false;

			if (!alreadyNotified) {
				notifiedWeakStallRuns.add(candidate.id);
				notified = true;

				// 1. 弱标记写库（is_stall_suspected 弱标记，不是状态，不改运行状态，AC 1, 09节）
				if (deps.service.markStallSuspected) {
					await deps.service.markStallSuspected(candidate.id, {
						durationMs: silenceDurationMs,
						isProminent: false,
						actorDeviceId: null,
					});
				}

				// 2. 发布弱提示事件 run.stalled_suspected
				if (deps.service.publishStalledSuspected) {
					await deps.service.publishStalledSuspected({
						kind: 'run.stalled_suspected',
						runId: candidate.id,
						taskId: candidate.taskId,
						actorDeviceId: null,
						payload: {
							durationMs: silenceDurationMs,
							severity: 'weak',
							alertLevel: 'weak',
							isProminent: false,
							vendor: {
								reason: 'stream_output_active_stall_suspected',
								silenceMinutes: Math.floor(silenceDurationMs / 60_000),
								timeoutMs,
							},
						},
					});
				}
			}

			return {
				runId: candidate.id,
				taskId: candidate.taskId,
				state: candidate.state,
				agentId: candidate.agentId,
				classification: 'weak_suspected',
				silenceDurationMs,
				timeoutMs,
				isStalled: true,
				isProminent: false,
				message: '超过思考阈值但输出流仍在活跃，标记疑似停滞弱提示，不改状态不杀进程',
				notified,
			};
		}

		// 完全无流事件超阈值 -> 升级为醒目告警 (AC 1, E-22)
		// 不得一直显示「进行中」，标「疑似卡住」并给出查看原始流与终止的入口，不改运行状态、不杀进程
		const alreadyNotified = notifiedProminentStallRuns.has(candidate.id);
		let notified = false;

		if (!alreadyNotified) {
			notifiedProminentStallRuns.add(candidate.id);
			notified = true;

			if (deps.service.markStallSuspected) {
				await deps.service.markStallSuspected(candidate.id, {
					durationMs: silenceDurationMs,
					isProminent: true,
					actorDeviceId: null,
				});
			}

			if (deps.service.publishStalledSuspected) {
				await deps.service.publishStalledSuspected({
					kind: 'run.stalled_suspected',
					runId: candidate.id,
					taskId: candidate.taskId,
					actorDeviceId: null,
					payload: {
						durationMs: silenceDurationMs,
						severity: 'prominent',
						alertLevel: 'prominent',
						isProminent: true,
						vendor: {
							reason: 'zero_stream_events_timeout',
							silenceMinutes: Math.floor(silenceDurationMs / 60_000),
							timeoutMs,
							actionHint: 'view_raw_log_or_abort',
						},
					},
				});
			}
		}

		return {
			runId: candidate.id,
			taskId: candidate.taskId,
			state: candidate.state,
			agentId: candidate.agentId,
			classification: 'prominent_stalled',
			silenceDurationMs,
			timeoutMs,
			isStalled: true,
			isProminent: true,
			message: `已 ${Math.floor(silenceDurationMs / 60_000)} 分钟无新输出，完全无流事件超阈值，升级为醒目告警（疑似卡住）`,
			actionHint: 'view_raw_log_or_abort',
			notified,
		};
	}

	async function runOnceInternal(): Promise<readonly StallCheckOutcome[]> {
		try {
			lastTickAt = clock.now();
			const nowMs = readNowMs();

			const inFlightRuns = await deps.service.findInFlightRuns();
			const currentRunIds = new Set<string>();
			const outcomes: StallCheckOutcome[] = [];

			for (const run of inFlightRuns) {
				if (stopRequested) break;
				currentRunIds.add(run.id);

				try {
					const outcome = await processSingleCandidate(run, nowMs);
					outcomes.push(outcome);
				} catch (candidateErr) {
					logFailure(candidateErr);
				}
			}

			// 清理已不再处于在途或已不存在的 run 跟踪缓存，杜绝内存泄漏
			for (const runId of notifiedAwaitingReplyRuns) {
				if (!currentRunIds.has(runId)) {
					notifiedAwaitingReplyRuns.delete(runId);
				}
			}
			for (const runId of notifiedWeakStallRuns) {
				if (!currentRunIds.has(runId)) {
					notifiedWeakStallRuns.delete(runId);
				}
			}
			for (const runId of notifiedProminentStallRuns) {
				if (!currentRunIds.has(runId)) {
					notifiedProminentStallRuns.delete(runId);
				}
			}

			completedTicksCount++;
			return Object.freeze(outcomes);
		} catch (error) {
			logFailure(error);
			return Object.freeze([]);
		}
	}

	function runGuarded(): Promise<readonly StallCheckOutcome[]> {
		// AC 4: tick 不重入，上一次未完成则跳过本次并计数
		if (inFlight !== null) {
			skippedTicksCount++;
			return inFlight;
		}

		const pass = runOnceInternal().finally(() => {
			if (inFlight === pass) {
				inFlight = null;
			}
		});

		inFlight = pass;
		return pass;
	}

	function tick(): void {
		if (stopRequested) return;
		void runGuarded();
	}

	return Object.freeze({
		name: 'stall-detector',

		start(): void {
			stopRequested = false;
			if (timer !== null) return;
			tick();
			timer = setInterval(tick, intervalMs);
			timer.unref();
		},

		async stop(): Promise<void> {
			stopRequested = true;
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
			if (inFlight !== null) {
				await inFlight;
			}
		},

		runOnce(): Promise<readonly StallCheckOutcome[]> {
			return runGuarded();
		},

		getStats(): StallDetectorStats {
			return Object.freeze({
				skippedTicksCount,
				completedTicksCount,
				inFlight: inFlight !== null,
				lastTickAt,
			});
		},

		resetNotificationState(runId?: string): void {
			if (runId) {
				notifiedAwaitingReplyRuns.delete(runId);
				notifiedWeakStallRuns.delete(runId);
				notifiedProminentStallRuns.delete(runId);
			} else {
				notifiedAwaitingReplyRuns.clear();
				notifiedWeakStallRuns.clear();
				notifiedProminentStallRuns.clear();
			}
		},
	});
}
