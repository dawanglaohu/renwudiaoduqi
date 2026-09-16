import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { AdapterKind } from '../config/defaults.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import {
	RUN_TRANSITION_REASONS,
	type RunState,
	assertValidTransition,
	isTerminalRunState,
} from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { ProcessRegistry } from '../proc/registry.ts';
import type { RunRow, RunsRepo } from '../repo/runs.ts';
import {
	type AgentMessageCapabilities,
	type MessageService,
	resolveAgentMessageCapabilities,
} from './message.ts';
import { assertNotArchived } from './session-guard.ts';

/**
 * 自动重试上限默认 2 次（AC 1, E-55）。
 * 超过上限后转「待人确认」（awaiting_human），禁止无限自动返工。
 */
export const DEFAULT_MAX_REWORK_COUNT = 2;

/**
 * 返工相关状态机迁移原因常量（09 节数据模型与 E-55, E-59, E-68）。
 */
export const REWORK_TRANSITION_REASONS = {
	REWORK_LIMIT_REACHED: RUN_TRANSITION_REASONS.REWORK_LIMIT_REACHED, // 'rework_limit_reached' (E-55)
	REWORK_INJECTION: RUN_TRANSITION_REASONS.REWORK_INJECTION, // 'rework_injection'
	HUMAN_REWORK: RUN_TRANSITION_REASONS.HUMAN_REWORK, // 'human_rework' (E-59)
	DIFF_REGRESSION: 'diff_regression_rework', // E-68
	INJECTION_FAILED: 'injection_failed', // E-112, E-113
} as const;

/**
 * 返工触发来源：
 * - 'review': 自动审查流水线判定 rework
 * - 'human' | 'manual': 用户在闸门或运行中点击「打回」（E-59）
 * - 'wrapup': 收口阶段发现问题触发的修复返工
 */
export type ReworkSource = 'review' | 'human' | 'manual' | 'wrapup';

/**
 * 返工处理模式：
 * - 'inject': 原会话存活且支持 canReply，直接回灌（M7-T4 负责）
 * - 'handover': 进程已结束或能力位为假，交 M7-T5 选恢复或新开（M7-T4 交接侧 / E-279 入口）
 * - 'awaiting_human': 达到重试上限转人（E-55）
 */
export type ReworkMode = 'inject' | 'handover' | 'awaiting_human';

/**
 * 工作区 diff 统计数据接口（用于 E-68 diff 缩小或回退判定）。
 */
export interface DiffStatLike {
	readonly filesChanged: number;
	readonly insertions: number;
	readonly deletions: number;
}

/**
 * diff 缩小或回退判定结果（E-68）。
 */
export interface DiffRegressionEvaluation {
	readonly isRegressed: boolean;
	readonly reason: 'diff_fully_reverted' | 'diff_shrunk' | null;
	readonly diffChanged: boolean;
	readonly previousTotalLines: number;
	readonly currentTotalLines: number;
}

/**
 * 交给 M7-T5 处理的交接载荷（AC 4, E-279 的入口侧）。
 * 严格保留四项必传信息：{reviewRunId, targetRunId, reworkText, source}。
 */
export interface ReworkHandoverPayload {
	readonly reviewRunId?: string | null;
	readonly targetRunId: string;
	readonly reworkText: string;
	readonly source: ReworkSource;
	readonly actorDeviceId?: string | null;
	readonly maxReworkCount?: number;
}

/**
 * 返工派发与回灌入参。
 */
export interface DispatchReworkInput {
	/**
	 * 审查运行 ID（可选，来自自动审查时提供）
	 */
	readonly reviewRunId?: string | null;

	/**
	 * 被审实施运行 ID（接收返工意见的实施运行，必须非空）
	 */
	readonly targetRunId: string;

	/**
	 * 返工意见文本（审查产出或人工打回的一句话意见，必须非空）
	 */
	readonly reworkText: string;

	/**
	 * 触发来源：'review'（自动审查）或 'human' / 'manual'（用户人工打回）
	 */
	readonly source: ReworkSource;

	/**
	 * 操作人设备 ID（可选，用于审计与信封）
	 */
	readonly actorDeviceId?: string | null;

	/**
	 * 可选：自定义任务最大重试上限（默认 2 次，E-55）
	 */
	readonly maxReworkCount?: number;

	/**
	 * 可选：前一次与当前 diff（用于 E-68 diff 缩小或回退的检查与审计）
	 */
	readonly previousDiff?: DiffStatLike | null;
	readonly currentDiff?: DiffStatLike | null;
}

/**
 * 返工派发与回灌结果。
 */
export type DispatchReworkResult =
	| {
			readonly success: true;
			readonly action: 'injected';
			readonly mode: 'inject';
			readonly targetRunId: string;
			readonly reviewRunId?: string | null;
			readonly reworkCount: number;
			readonly messageId: string;
			readonly source: ReworkSource;
			readonly diffRegression?: DiffRegressionEvaluation;
	  }
	| {
			readonly success: false;
			readonly action: 'awaiting_human';
			readonly mode: 'awaiting_human';
			readonly targetRunId: string;
			readonly reviewRunId?: string | null;
			readonly reworkCount: number;
			readonly reason: 'rework_limit_reached';
			readonly message: string;
			readonly source: ReworkSource;
			readonly diffRegression?: DiffRegressionEvaluation;
	  }
	| {
			readonly success: true;
			readonly action: 'handover_to_m7_t5';
			readonly mode: 'handover';
			readonly handover: ReworkHandoverPayload;
			readonly reason: 'process_ended' | 'capability_unsupported';
			readonly reworkCount: number;
			readonly source: ReworkSource;
			readonly diffRegression?: DiffRegressionEvaluation;
	  };

/**
 * 派发快照仓储抽象（用于按快照读取被审运行的 launch_spec_json.adapterKind，E-93）。
 */
export interface ReworkSnapshotsRepo {
	findById(id: string): { readonly launch_spec_json: string } | null;
}

/**
 * ReworkService 依赖接口。
 */
export interface ReworkServiceDeps {
	readonly runsRepo: RunsRepo;
	readonly messageService: MessageService;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly processRegistry?: ProcessRegistry;
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly unitOfWork?: UnitOfWork;
	readonly snapshotsRepo?: ReworkSnapshotsRepo;
	readonly getAgentCapabilities?: (
		agentId: string,
		adapterKind?: AdapterKind,
	) => AgentMessageCapabilities;
	readonly delegateToSessionRework?: (
		payload: ReworkHandoverPayload,
	) => Promise<DispatchReworkResult>;
	readonly maxReworkCount?: number;
}

/**
 * ReworkService 契约接口。
 */
export interface ReworkService {
	dispatchRework(input: DispatchReworkInput): Promise<DispatchReworkResult>;
	canReinject(targetRunId: string): Promise<boolean>;
	checkRetryLimit(
		targetRunId: string,
		maxLimit?: number,
	): Promise<{
		readonly atLimit: boolean;
		readonly currentCount: number;
		readonly maxCount: number;
	}>;
	evaluateDiffRegression(
		previousDiff?: DiffStatLike | null,
		currentDiff?: DiffStatLike | null,
	): DiffRegressionEvaluation;
}

/**
 * 判定工作区改动是否反而缩小或回退（AC 2, E-68）。
 * 若回灌后改动缩小或撤回，仍保持正常的重试计数和审查流程，达上限转人。
 */
export function evaluateDiffRegression(
	previousDiff?: DiffStatLike | null,
	currentDiff?: DiffStatLike | null,
): DiffRegressionEvaluation {
	if (!previousDiff || !currentDiff) {
		return Object.freeze({
			isRegressed: false,
			reason: null,
			diffChanged: false,
			previousTotalLines: 0,
			currentTotalLines: 0,
		});
	}

	const prevTotal = previousDiff.insertions + previousDiff.deletions;
	const currTotal = currentDiff.insertions + currentDiff.deletions;
	const diffChanged =
		previousDiff.filesChanged !== currentDiff.filesChanged ||
		previousDiff.insertions !== currentDiff.insertions ||
		previousDiff.deletions !== currentDiff.deletions;

	const fullyReverted = prevTotal > 0 && currentDiff.filesChanged === 0 && currTotal === 0;

	if (fullyReverted) {
		return Object.freeze({
			isRegressed: true,
			reason: 'diff_fully_reverted',
			diffChanged,
			previousTotalLines: prevTotal,
			currentTotalLines: currTotal,
		});
	}

	const filesShrunk = currentDiff.filesChanged < previousDiff.filesChanged;
	const linesShrunk = currTotal < prevTotal;

	if (filesShrunk || linesShrunk) {
		return Object.freeze({
			isRegressed: true,
			reason: 'diff_shrunk',
			diffChanged,
			previousTotalLines: prevTotal,
			currentTotalLines: currTotal,
		});
	}

	return Object.freeze({
		isRegressed: false,
		reason: null,
		diffChanged,
		previousTotalLines: prevTotal,
		currentTotalLines: currTotal,
	});
}

/**
 * 从派发快照中解析 adapterKind（E-93）。
 * 必须读取派发那一刻快照里的 launch_spec_json.adapterKind，绝不读注册表当前值。
 */
function extractAdapterKindFromSnapshot(
	run: RunRow,
	snapshotsRepo?: ReworkSnapshotsRepo,
): AdapterKind {
	if (!snapshotsRepo || !run.snapshot_id) {
		return 'native';
	}
	const snap = snapshotsRepo.findById(run.snapshot_id);
	if (!snap || !snap.launch_spec_json) {
		return 'native';
	}
	try {
		const parsed = JSON.parse(snap.launch_spec_json) as { adapterKind?: unknown };
		if (typeof parsed.adapterKind === 'string' && parsed.adapterKind.length > 0) {
			return parsed.adapterKind as AdapterKind;
		}
	} catch {
		// Fall back to 'native'
	}
	return 'native';
}

/**
 * 校验进程是否存活且具备写入管道。
 */
function isTargetProcessAlive(run: RunRow, processRegistry?: ProcessRegistry): boolean {
	const isEnded = isTerminalRunState(run.state as RunState) || run.state === 'exited';
	if (isEnded) {
		return false;
	}

	if (!processRegistry) {
		return false;
	}

	const managedProcess = processRegistry.get(run.id);
	if (!managedProcess) {
		return false;
	}

	if (
		managedProcess.isExited ||
		managedProcess.child.killed ||
		managedProcess.child.exitCode !== null
	) {
		return false;
	}

	if (
		!managedProcess.child.stdin ||
		managedProcess.child.stdin.destroyed ||
		!managedProcess.child.stdin.writable
	) {
		return false;
	}

	return true;
}

/**
 * 创建 ReworkService 实现（M7-T4）。
 *
 * 核心规则：
 * 1. AC 1: rework 意见经回话通路回灌原会话，重试计数 +1。
 *    自动重试上限默认 2 次，超限转「待人确认」（awaiting_human），不无限自动改（E-55）。
 * 2. AC 2: 回灌后 diff 反而缩小或回退时仍走同一套检查，计数照加，达上限转人（E-68）。
 * 3. AC 3: 人工打回时必须能附一句话意见，该意见复用同一条 rework 通路（E-59）。
 * 4. AC 4: 本任务只负责「原会话活着且 canReply」的回灌分支。
 *    进程已结束或能力位为假时把 {reviewRunId, targetRunId, reworkText, source} 交 M7-T5 按能力位选恢复或新开，
 *    代码中不存在「先试投递失败再降级」的路径（E-279 的入口侧）。
 */
export function createReworkService(deps: ReworkServiceDeps): ReworkService {
	function resolveCaps(
		agentId: string,
		adapterKind: AdapterKind = 'native',
	): AgentMessageCapabilities {
		if (deps.getAgentCapabilities) {
			return deps.getAgentCapabilities(agentId, adapterKind);
		}
		return resolveAgentMessageCapabilities(agentId, adapterKind);
	}

	async function checkRetryLimit(
		targetRunId: string,
		maxLimit?: number,
	): Promise<{
		readonly atLimit: boolean;
		readonly currentCount: number;
		readonly maxCount: number;
	}> {
		const targetRun = deps.runsRepo.findById(targetRunId);
		if (!targetRun) {
			throw new AppError('E_NOT_FOUND', `Run '${targetRunId}' was not found.`, {
				details: { runId: targetRunId },
			});
		}

		const currentCount = targetRun.rework_count ?? 0;
		const maxCount = maxLimit ?? deps.maxReworkCount ?? DEFAULT_MAX_REWORK_COUNT;
		return Object.freeze({
			atLimit: currentCount >= maxCount,
			currentCount,
			maxCount,
		});
	}

	async function canReinject(targetRunId: string): Promise<boolean> {
		if (!targetRunId || typeof targetRunId !== 'string' || targetRunId.trim().length === 0) {
			return false;
		}

		const targetRun = deps.runsRepo.findById(targetRunId);
		if (!targetRun) {
			return false;
		}

		// 已归档会话是严格只读的，禁止回灌（E-302）
		if (targetRun.session_archived_at) {
			return false;
		}

		const adapterKind = extractAdapterKindFromSnapshot(targetRun, deps.snapshotsRepo);
		const caps = resolveCaps(targetRun.agent_id, adapterKind);
		if (!caps.canReply) {
			return false;
		}

		return isTargetProcessAlive(targetRun, deps.processRegistry);
	}

	async function dispatchRework(input: DispatchReworkInput): Promise<DispatchReworkResult> {
		// 1. 校验输入
		if (
			!input.targetRunId ||
			typeof input.targetRunId !== 'string' ||
			input.targetRunId.trim().length === 0
		) {
			throw new AppError('E_VALIDATION', 'Target run ID must be a non-empty string.', {
				details: { field: 'targetRunId' },
			});
		}

		const isManual = input.source === 'human' || input.source === 'manual';

		// AC 3 & E-59: 人工打回时必须附一句话意见；任何来源的返工文本均不得为空
		if (typeof input.reworkText !== 'string' || input.reworkText.trim().length === 0) {
			const message = isManual
				? 'Manual rework requires an attached comment.'
				: 'Rework text cannot be empty or whitespace only.';
			throw new AppError('E_VALIDATION', message, {
				details: {
					field: 'reworkText',
					source: input.source,
					code: 'EMPTY_REWORK_COMMENT',
				},
			});
		}

		const targetRun = deps.runsRepo.findById(input.targetRunId);
		if (!targetRun) {
			throw new AppError('E_NOT_FOUND', `Target run '${input.targetRunId}' was not found.`, {
				details: { runId: input.targetRunId },
			});
		}

		// 会话归档后严格只读，禁止回灌或再进入返工（AC 4 / E-302 / M6-T10）
		assertNotArchived(targetRun);

		// AC 2 & E-68: 判定工作区改动是否缩小或回退
		const diffRegression = evaluateDiffRegression(input.previousDiff, input.currentDiff);

		// 2. 检查自动重试上限（AC 1, E-55, E-68）
		// 不管改动是否缩小或回退，重试计数同等累计；超限必须转「待人确认」，不无限自动改
		// 上限只拦自动审查那条路（from === 'reviewing'，与 run-state-machine.ts:215 及 09 节数据模型一致）；
		// 人工/手动来源照常回灌、计数照加（E-59）
		const currentReworkCount = targetRun.rework_count ?? 0;
		const maxReworkCount = input.maxReworkCount ?? deps.maxReworkCount ?? DEFAULT_MAX_REWORK_COUNT;
		const isAutoReview = !isManual && targetRun.state === 'reviewing';

		if (isAutoReview && currentReworkCount >= maxReworkCount) {
			const now = deps.clock.now();
			const pendingEvents: EventEnvelope[] = [];

			const persistLimitReached = () => {
				// 目标运行转 awaiting_human
				if (
					targetRun.state !== 'awaiting_human' &&
					!isTerminalRunState(targetRun.state as RunState)
				) {
					assertValidTransition(targetRun.state as RunState, 'awaiting_human', {
						reason: REWORK_TRANSITION_REASONS.REWORK_LIMIT_REACHED,
						reworkCount: currentReworkCount,
						maxReworkCount,
					});

					deps.runsRepo.updateState({
						id: targetRun.id,
						state: 'awaiting_human',
						fromState: targetRun.state,
						toState: 'awaiting_human',
						queuedReason: REWORK_TRANSITION_REASONS.REWORK_LIMIT_REACHED,
						actorDeviceId: input.actorDeviceId ?? null,
					});

					if (deps.envelopeFactory) {
						pendingEvents.push(
							deps.envelopeFactory.createEnvelope({
								kind: 'run.state_changed',
								runId: targetRun.id,
								taskId: targetRun.task_id,
								actorDeviceId: input.actorDeviceId ?? null,
								payload: {
									from: targetRun.state as RunState,
									to: 'awaiting_human',
									reason: REWORK_TRANSITION_REASONS.REWORK_LIMIT_REACHED,
								},
							}),
						);
					}
				}

				// 审查运行（若存在且未在终态/未在 awaiting_human）转 awaiting_human
				if (input.reviewRunId) {
					const reviewRun = deps.runsRepo.findById(input.reviewRunId);
					if (
						reviewRun &&
						reviewRun.state !== 'awaiting_human' &&
						!isTerminalRunState(reviewRun.state as RunState)
					) {
						assertValidTransition(reviewRun.state as RunState, 'awaiting_human', {
							reason: REWORK_TRANSITION_REASONS.REWORK_LIMIT_REACHED,
							reworkCount: currentReworkCount,
							maxReworkCount,
						});

						deps.runsRepo.updateState({
							id: reviewRun.id,
							state: 'awaiting_human',
							fromState: reviewRun.state,
							toState: 'awaiting_human',
							queuedReason: REWORK_TRANSITION_REASONS.REWORK_LIMIT_REACHED,
							actorDeviceId: input.actorDeviceId ?? null,
						});

						if (deps.envelopeFactory) {
							pendingEvents.push(
								deps.envelopeFactory.createEnvelope({
									kind: 'run.state_changed',
									runId: reviewRun.id,
									taskId: reviewRun.task_id,
									actorDeviceId: input.actorDeviceId ?? null,
									payload: {
										from: reviewRun.state as RunState,
										to: 'awaiting_human',
										reason: REWORK_TRANSITION_REASONS.REWORK_LIMIT_REACHED,
									},
								}),
							);
						}
					}
				}
			};

			if (deps.unitOfWork) {
				deps.unitOfWork.run(persistLimitReached);
			} else {
				persistLimitReached();
			}

			// 事务外发布事件
			if (deps.bus) {
				for (const ev of pendingEvents) {
					deps.bus.publish(ev);
				}
			}

			return Object.freeze({
				success: false,
				action: 'awaiting_human',
				mode: 'awaiting_human',
				targetRunId: targetRun.id,
				reviewRunId: input.reviewRunId ?? null,
				reworkCount: currentReworkCount,
				reason: 'rework_limit_reached',
				message: `Rework retry limit reached (${currentReworkCount}/${maxReworkCount}). Transferred to awaiting_human.`,
				source: input.source,
				diffRegression,
			});
		}

		// 3. 检查能力位与进程存活性（AC 4, E-279 入口侧）
		// 读快照中的 adapterKind（E-93），分支由能力位与进程状态决定，代码中不存在「先试投递失败再降级」的路径
		const adapterKind = extractAdapterKindFromSnapshot(targetRun, deps.snapshotsRepo);
		const caps = resolveCaps(targetRun.agent_id, adapterKind);
		const canReply = caps.canReply;
		const isProcessAlive = isTargetProcessAlive(targetRun, deps.processRegistry);

		if (!isProcessAlive || !canReply) {
			// 进程已结束或能力位为假：把交接载荷交给 M7-T5
			const handoverPayload: ReworkHandoverPayload = Object.freeze({
				reviewRunId: input.reviewRunId ?? null,
				targetRunId: targetRun.id,
				reworkText: input.reworkText,
				source: input.source,
				actorDeviceId: input.actorDeviceId ?? null,
				maxReworkCount,
			});

			if (deps.delegateToSessionRework) {
				return await deps.delegateToSessionRework(handoverPayload);
			}

			return Object.freeze({
				success: true,
				action: 'handover_to_m7_t5',
				mode: 'handover',
				handover: handoverPayload,
				reason: !isProcessAlive ? 'process_ended' : 'capability_unsupported',
				reworkCount: currentReworkCount,
				source: input.source,
				diffRegression,
			});
		}

		// 4. 原会话活着且 canReply：进入「回灌分支」（AC 1, AC 3）
		const nextReworkCount = currentReworkCount + 1;
		const transitionReason = isManual
			? REWORK_TRANSITION_REASONS.HUMAN_REWORK
			: REWORK_TRANSITION_REASONS.REWORK_INJECTION;

		const pendingEvents: EventEnvelope[] = [];

		const persistReinjection = () => {
			assertValidTransition(targetRun.state as RunState, 'reworking', {
				reason: transitionReason,
				reworkCount: currentReworkCount,
				maxReworkCount,
			});

			// 重试计数 +1，状态切至 reworking
			deps.runsRepo.updateReworkCount({
				id: targetRun.id,
				reworkCount: nextReworkCount,
				state: 'reworking',
			});

			if (deps.envelopeFactory) {
				pendingEvents.push(
					deps.envelopeFactory.createEnvelope({
						kind: 'run.state_changed',
						runId: targetRun.id,
						taskId: targetRun.task_id,
						actorDeviceId: input.actorDeviceId ?? null,
						payload: {
							from: targetRun.state as RunState,
							to: 'reworking',
							reason: transitionReason,
						},
					}),
				);
			}
		};

		if (deps.unitOfWork) {
			deps.unitOfWork.run(persistReinjection);
		} else {
			persistReinjection();
		}

		if (deps.bus) {
			for (const ev of pendingEvents) {
				deps.bus.publish(ev);
			}
		}

		// 事务提交后：通过消息回话通路将返工意见投递给原进程（硬顺序：先事务再副作用）
		let deliveryResult: { messageId: string; delivered: boolean };
		try {
			deliveryResult = await deps.messageService.sendMessage({
				runId: targetRun.id,
				text: input.reworkText,
				kind: 'reply',
				actorDeviceId: input.actorDeviceId ?? null,
				throwOnUndelivered: true,
			});
		} catch (error) {
			// 投递失败：由独立事务将状态切至 awaiting_human（E-112, E-113）
			const failEvents: EventEnvelope[] = [];
			const persistFailure = () => {
				assertValidTransition('reworking', 'awaiting_human', {
					reason: REWORK_TRANSITION_REASONS.INJECTION_FAILED,
				});

				deps.runsRepo.updateState({
					id: targetRun.id,
					state: 'awaiting_human',
					fromState: 'reworking',
					toState: 'awaiting_human',
					queuedReason: REWORK_TRANSITION_REASONS.INJECTION_FAILED,
					actorDeviceId: input.actorDeviceId ?? null,
				});

				if (deps.envelopeFactory) {
					failEvents.push(
						deps.envelopeFactory.createEnvelope({
							kind: 'run.state_changed',
							runId: targetRun.id,
							taskId: targetRun.task_id,
							actorDeviceId: input.actorDeviceId ?? null,
							payload: {
								from: 'reworking',
								to: 'awaiting_human',
								reason: REWORK_TRANSITION_REASONS.INJECTION_FAILED,
							},
						}),
					);
				}
			};

			if (deps.unitOfWork) {
				deps.unitOfWork.run(persistFailure);
			} else {
				persistFailure();
			}

			if (deps.bus) {
				for (const ev of failEvents) {
					deps.bus.publish(ev);
				}
			}

			throw error;
		}

		// 意见回灌原会话成功：reworking --> running（09 节数据模型与 E-59）
		const postDeliveryEvents: EventEnvelope[] = [];
		const persistRunning = () => {
			assertValidTransition('reworking', 'running', {
				reason: transitionReason,
			});

			deps.runsRepo.updateState({
				id: targetRun.id,
				state: 'running',
				fromState: 'reworking',
				toState: 'running',
				queuedReason: transitionReason,
				actorDeviceId: input.actorDeviceId ?? null,
			});

			if (deps.envelopeFactory) {
				postDeliveryEvents.push(
					deps.envelopeFactory.createEnvelope({
						kind: 'run.state_changed',
						runId: targetRun.id,
						taskId: targetRun.task_id,
						actorDeviceId: input.actorDeviceId ?? null,
						payload: {
							from: 'reworking',
							to: 'running',
							reason: transitionReason,
						},
					}),
				);
			}
		};

		if (deps.unitOfWork) {
			deps.unitOfWork.run(persistRunning);
		} else {
			persistRunning();
		}

		if (deps.bus) {
			for (const ev of postDeliveryEvents) {
				deps.bus.publish(ev);
			}
		}

		return Object.freeze({
			success: true,
			action: 'injected',
			mode: 'inject',
			targetRunId: targetRun.id,
			reviewRunId: input.reviewRunId ?? null,
			reworkCount: nextReworkCount,
			messageId: deliveryResult.messageId,
			source: input.source,
			diffRegression,
		});
	}

	return Object.freeze({
		dispatchRework,
		canReinject,
		checkRetryLimit,
		evaluateDiffRegression,
	});
}
