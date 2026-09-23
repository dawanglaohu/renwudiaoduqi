import * as nodeFs from 'node:fs/promises';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { AdapterKind } from '../config/defaults.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { assembleReworkPrompt } from '../domain/rework-prompt.ts';
import {
	RUN_TRANSITION_REASONS,
	type RunState,
	assertValidTransition,
	canTransition,
	isTerminalRunState,
} from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { ProcessRegistry } from '../proc/registry.ts';
import type { DocumentsRepo } from '../repo/documents.ts';
import type { GatesRepo } from '../repo/gates.ts';
import type { RunInsertRow, RunRow, RunsRepo } from '../repo/runs.ts';
import type { TasksRepo } from '../repo/tasks.ts';
import type { GitRunner, WorktreeManager } from '../workspace/worktree.ts';
import {
	type AgentMessageCapabilities,
	type MessageService,
	type ResumeSessionInput,
	type ResumeSessionResult,
	resolveAgentMessageCapabilities,
} from './message.ts';
import { assertNotArchived, assertSessionRefFree } from './session-guard.ts';

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
	BRANCH_MISSING: 'branch_missing', // E-277
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
 * - 'inject': 进程存活且支持 canReply，直接回灌（AC 1）
 * - 'resume': 进程已结束且支持 canResume，恢复后回灌并明示新运行（AC 1, E-112）
 * - 'new_session': 既不能回灌也不能恢复，新开实施运行并自包含提示词（AC 1, E-279）
 * - 'awaiting_human': 达到重试上限或原分支丢失时转人（E-55, E-277）
 * - 'undeliverable': 没有任何投递器接住这次返工（缺回调 / 启动失败 / 送达未确认，E-112、E-279）
 * - 'handover': 兼容 M7-T4 委托载荷（只在注入了 delegateToSessionRework 时出现）
 */
export type ReworkMode =
	| 'inject'
	| 'resume'
	| 'new_run'
	| 'awaiting_human'
	| 'undeliverable'
	| 'handover';

/**
 * 返工投递失败的类型化原因（E-112、E-279）。
 * 与 `session-resume.ts` 的 `SessionResumeFailureReason` 同词表，外加服务层的两种：
 * 没有投递器（`session_dispatch_unavailable`）与回调没把进程拉起来（`delivery_not_confirmed`）。
 */
export type ReworkUndeliverableReason =
	| 'session_dispatch_unavailable'
	| 'vendor_session_missing'
	| 'session_resume_unavailable'
	| 'session_resume_spec_failed'
	| 'spawn_failed'
	| 'startup_timeout'
	| 'premature_exit'
	| 'delivery_not_confirmed';

const UNDELIVERABLE_REASONS: ReadonlySet<string> = new Set([
	'session_dispatch_unavailable',
	'vendor_session_missing',
	'session_resume_unavailable',
	'session_resume_spec_failed',
	'spawn_failed',
	'startup_timeout',
	'premature_exit',
	'delivery_not_confirmed',
]);

/** 返工投递失败时写在运行行 `queued_reason` 上的统一标记前缀（#136）。 */
export const REWORK_DELIVERY_FAILED_PREFIX = 'rework_delivery_failed';

/** 返工运行「起来就死了」的终态集合：这些状态一律不算投递成功（#136）。 */
export function isReworkDeliveryFailed(state: string): boolean {
	return (
		state === 'failed' || state === 'aborted' || state === 'interrupted' || state === 'orphaned'
	);
}

/**
 * 返工运行是否已确认真的跑起来（#136 / E-327）。
 *
 * `starting` / `queued` 表示还没起；`failed` / `aborted` / `interrupted` / `orphaned` 表示起来就死了
 * （启动即退出会由 `launchRun` 落 `starting → failed`）。两种情况都不算投递成功：公开闸门必须回
 * 类型化 `E_MESSAGE_UNDELIVERED`，且不得发 `run.rework_dispatched` 成功事件。恢复分支用同一把尺子。
 */
export function isReworkDeliveryConfirmed(state: string): boolean {
	if (state === 'starting' || state === 'queued') return false;
	return !isReworkDeliveryFailed(state);
}

/**
 * 从运行行复原启动失败的类型化原因（读 `launchRun` 落下的状态机 reason，或投递器写的前缀原因）。
 * 运行行已经确认跑起来时返回 null。
 */
export function reworkFailureReasonFromRun(
	row: { readonly state: string; readonly queued_reason?: string | null } | null | undefined,
): ReworkUndeliverableReason | null {
	if (!row) return null;
	const notConfirmed = row.state === 'starting' || row.state === 'queued';
	if (!notConfirmed && !isReworkDeliveryFailed(row.state)) return null;

	const queuedReason = row.queued_reason ?? '';
	for (const prefix of [`${REWORK_DELIVERY_FAILED_PREFIX}:`, 'session_resume_failed:']) {
		if (queuedReason.startsWith(prefix)) {
			const reason = queuedReason.slice(prefix.length);
			if (UNDELIVERABLE_REASONS.has(reason)) return reason as ReworkUndeliverableReason;
		}
	}
	if (queuedReason === 'premature_exit') return 'premature_exit';
	if (queuedReason === 'startup_timeout') return 'startup_timeout';
	if (queuedReason === 'spawn_failed' || queuedReason === 'agent_unavailable')
		return 'spawn_failed';
	if (queuedReason === 'workspace_unavailable' || queuedReason === 'upstream_base_missing') {
		return 'spawn_failed';
	}
	return isReworkDeliveryFailed(row.state) ? 'spawn_failed' : 'delivery_not_confirmed';
}

/**
 * 从投递器抛出的错误里取类型化原因；取不到就归为「送达未确认」。
 * 只读自身错误的结构，不解析厂商错误串。
 */
export function undeliverableReasonFromError(error: unknown): ReworkUndeliverableReason {
	const details = (error as { readonly details?: { readonly reason?: unknown } } | null)?.details;
	const reason = details?.reason;
	if (typeof reason === 'string' && UNDELIVERABLE_REASONS.has(reason)) {
		return reason as ReworkUndeliverableReason;
	}
	return 'delivery_not_confirmed';
}

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
	/** The human gate already charged this decision while the task waited for a lane. */
	readonly countAlreadyApplied?: boolean;
}

/**
 * 返工派发与回灌结果（M7-T5 结构化结果，支持三分支）。
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
			readonly success: true;
			readonly action: 'resumed';
			readonly mode: 'resume';
			readonly targetRunId: string;
			readonly newRunId: string;
			readonly reviewRunId?: string | null;
			readonly reworkCount: number;
			readonly messageId?: string;
			readonly source: ReworkSource;
			readonly diffRegression?: DiffRegressionEvaluation;
	  }
	| {
			readonly success: true;
			readonly action: 'new_session_spawned';
			readonly mode: 'new_run';
			readonly targetRunId: string;
			readonly newRunId: string;
			readonly reviewRunId?: string | null;
			readonly reworkCount: number;
			readonly reworkPrompt: string;
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
			readonly reason: 'rework_limit_reached' | 'branch_missing';
			readonly message: string;
			readonly source: ReworkSource;
			readonly diffRegression?: DiffRegressionEvaluation;
	  }
	| {
			readonly success: false;
			readonly action: 'undeliverable';
			readonly mode: 'undeliverable';
			readonly targetRunId: string;
			readonly reviewRunId?: string | null;
			/** 已落库的返工运行行（恢复/新开分支才会产生），失败后落在 `failed` 供人查看。 */
			readonly reworkRunId?: string | null;
			readonly reworkCount: number;
			readonly reason: ReworkUndeliverableReason;
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
 * 派发快照仓储抽象（用于按快照读取被审运行的 launch_spec_json.adapterKind 及 impl_prompt，E-93）。
 */
export interface ReworkSnapshotsRepo {
	findById(id: string): {
		readonly id?: string;
		readonly launch_spec_json: string;
		readonly impl_prompt?: string | null;
		readonly review_prompt?: string | null;
		readonly bug_prompt?: string | null;
		readonly contract_hash?: string;
		readonly task_paths_json?: string;
		readonly input_text?: string | null;
		readonly output_text?: string | null;
		readonly accept_text?: string | null;
		readonly created_at?: string;
	} | null;
	insert?(snapshot: {
		readonly id: string;
		readonly task_id: string;
		readonly input_text?: string | null;
		readonly output_text?: string | null;
		readonly accept_text?: string | null;
		readonly impl_prompt?: string | null;
		readonly review_prompt?: string | null;
		readonly bug_prompt?: string | null;
		readonly contract_hash: string;
		readonly task_paths_json: string;
		readonly launch_spec_json: string;
		readonly created_at: string;
	}): void;
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
	readonly tasksRepo?: TasksRepo;
	readonly gatesRepo?: GatesRepo;
	readonly documentsRepo?: DocumentsRepo;
	readonly worktreeManager?: WorktreeManager;
	readonly gitRunner?: GitRunner;
	readonly repoPath?: string;
	readonly fs?: {
		readonly stat?: (path: string) => Promise<{ isDirectory(): boolean }>;
		readonly access?: (path: string) => Promise<void>;
	};
	readonly resumeSession?: (input: ResumeSessionInput) => Promise<ResumeSessionResult>;
	readonly spawnReworkRun?: (input: { run: RunRow; reworkPrompt?: string }) => Promise<void>;
	readonly getAgentCapabilities?: (
		agentId: string,
		adapterKind?: AdapterKind,
	) => AgentMessageCapabilities;
	readonly delegateToSessionRework?: (
		payload: ReworkHandoverPayload,
	) => Promise<DispatchReworkResult>;
	readonly enableSessionDispatch?: boolean;
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
 * 检查 worktree 目录在文件系统上是否存在（AC 3, E-277）。
 */
async function checkWorktreePathExists(
	worktreePath: string | null | undefined,
	fsOps?: {
		readonly stat?: (path: string) => Promise<{ isDirectory(): boolean }>;
		readonly access?: (path: string) => Promise<void>;
	},
): Promise<boolean> {
	if (!worktreePath || typeof worktreePath !== 'string' || worktreePath.trim().length === 0) {
		return false;
	}
	try {
		if (fsOps?.stat) {
			const s = await fsOps.stat(worktreePath);
			return s.isDirectory();
		}
		if (fsOps?.access) {
			await fsOps.access(worktreePath);
			return true;
		}
		const s = await nodeFs.stat(worktreePath);
		return s.isDirectory();
	} catch {
		return false;
	}
}

/**
 * 检查 git 分支在仓库中是否存在（AC 3, E-277）。
 */
async function checkBranchExists(
	branchName: string | null | undefined,
	repoPath: string | undefined,
	gitRunner?: GitRunner,
): Promise<boolean> {
	if (!branchName || typeof branchName !== 'string' || branchName.trim().length === 0) {
		return false;
	}
	if (!gitRunner || !repoPath) {
		// 没有 gitRunner 或 repoPath 时，默认分支仍存在
		return true;
	}
	try {
		const res = await gitRunner.run(
			['rev-parse', '--verify', `refs/heads/${branchName}`],
			repoPath,
		);
		return res.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * 创建 ReworkService 实现（M7-T5）。
 *
 * 核心规则与验收标准：
 * 1. AC 1: 按被审运行快照 launch_spec_json.adapterKind 读代码层能力位（不读注册表当前值，E-93）：
 *    - 进程活着且 canReply → 回灌
 *    - 已结束且 canResume → 恢复后回灌并明示新运行（E-112）
 *    - 都不能 → 新开实施运行 origin='rework'、同任务 attempt_no+1、spawned_by_run_id=审查运行、同 worktree 与分支（E-279）
 *    分支由能力位决定，代码中不存在「先试投递失败再降级」路径。
 * 2. AC 2: 新会话提示词自包含：返工块原文 + 快照实施提示词「收到返工指令时」段（取不到用内置四句）+ 工作区指针 + 「只改列出条目、不 commit/push」（E-279）。
 * 3. AC 3: worktree 目录已不存在时走 M5-T1 在原分支上 reuse 重建；
 *    分支不存在转 awaiting_human 并在闸门 comment 写 branch_missing，不开干净 worktree（E-277）。
 * 4. AC 4: 三分支都 rework_count+1 且继承旧计数，旧计数已达 2 时直接 reviewing→awaiting_human 不进任何分支（E-55）；
 *    每分支在事务后发 run.rework_dispatched{mode, source}。
 * 5. AC 5: 人工打回（E-59）与审查产出走同一入口，只以 source 区分。
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

	function resolveRepoPath(targetRun: RunRow): string | undefined {
		if (deps.repoPath) {
			return deps.repoPath;
		}
		if (deps.tasksRepo && deps.documentsRepo && targetRun.task_id) {
			const task = deps.tasksRepo.findById(targetRun.task_id);
			if (task) {
				const doc = deps.documentsRepo.findById(task.doc_id);
				if (doc?.repo_path) {
					return doc.repo_path;
				}
			}
		}
		return undefined;
	}

	/**
	 * 投递失败的类型化结果（E-112、E-279）。
	 * 失败本身不改目标行状态——由 `failReworkDelivery` 统一把任务交回人手（E-326）。
	 */
	function buildUndeliverableResult(params: {
		readonly targetRunId: string;
		readonly reviewRunId: string | null;
		readonly reworkRunId?: string | null;
		readonly reworkCount: number;
		readonly reason: ReworkUndeliverableReason;
		readonly message: string;
		readonly source: ReworkSource;
		readonly diffRegression: DiffRegressionEvaluation;
	}): DispatchReworkResult {
		return Object.freeze({
			success: false,
			action: 'undeliverable',
			mode: 'undeliverable',
			targetRunId: params.targetRunId,
			reviewRunId: params.reviewRunId,
			reworkRunId: params.reworkRunId ?? null,
			reworkCount: params.reworkCount,
			reason: params.reason,
			message: params.message,
			source: params.source,
			diffRegression: params.diffRegression,
		});
	}

	/**
	 * 把已落库的返工运行行落成 `failed` 并带上类型化原因，事件在事务后发。
	 * 不留 `starting` 幽灵行：那一行既没有进程也没有终态，谁也说不清它是什么。
	 */
	function markReworkRunFailed(reworkRunId: string, reason: ReworkUndeliverableReason): void {
		const row = deps.runsRepo.findById(reworkRunId);
		if (!row || isTerminalRunState(row.state as RunState)) {
			return;
		}

		const now = deps.clock.now();
		const pendingEvents: EventEnvelope[] = [];

		const persistFailure = () => {
			deps.runsRepo.updateState({
				id: reworkRunId,
				state: 'failed',
				fromState: row.state,
				toState: 'failed',
				queuedReason: `${REWORK_DELIVERY_FAILED_PREFIX}:${reason}`,
				endedAt: now,
				actorDeviceId: null,
			});

			if (deps.envelopeFactory) {
				pendingEvents.push(
					deps.envelopeFactory.createEnvelope({
						kind: 'run.state_changed',
						runId: reworkRunId,
						taskId: row.task_id,
						actorDeviceId: null,
						payload: {
							from: row.state as RunState,
							to: 'failed',
							reason: `${REWORK_DELIVERY_FAILED_PREFIX}:${reason}`,
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
			for (const ev of pendingEvents) {
				deps.bus.publish(ev);
			}
		}
	}

	/**
	 * 投递失败后把任务交回人手（#136 / E-326 / E-327）：目标实施行 `reworking → awaiting_human`、
	 * 释放泳道并发 `lane.released`、留一张 waiting 的审查闸门卡记录类型化原因，供人重试。
	 *
	 * 三件不做的事：不归档任何会话（E-302 的归档只在任务真正到达终态时发生，这条厂商会话还要用来恢复）、
	 * 不改 `rework_count`（一次打回只记一次）、不碰闸门已落库的决定。这样任务既不会占着泳道，
	 * 也不会被那条失败的返工运行挡在补位队列外——它带着明确原因停在人工入口上。
	 */
	function parkTaskAfterDeliveryFailure(
		targetRun: RunRow,
		reason: ReworkUndeliverableReason,
	): void {
		const taskId = targetRun.task_id;
		if (!taskId) return;

		const nowTs = deps.clock.now();
		const events: EventEnvelope[] = [];
		const comment = `${REWORK_DELIVERY_FAILED_PREFIX}:${reason}`;

		const persist = () => {
			const current = deps.runsRepo.findById(targetRun.id);
			if (
				current &&
				!isTerminalRunState(current.state as RunState) &&
				current.state !== 'awaiting_human'
			) {
				// `exited` 没有直达 awaiting_human 的边，按状态机图先经 reviewing（E-348 同一条路）。
				const steps: readonly RunState[] =
					current.state === 'exited' ? ['reviewing', 'awaiting_human'] : ['awaiting_human'];
				let from = current.state as RunState;
				for (const step of steps) {
					if (!canTransition(from, step)) break;
					deps.runsRepo.updateState({
						id: targetRun.id,
						state: step,
						fromState: from,
						toState: step,
						queuedReason: comment,
						actorDeviceId: null,
					});

					if (deps.envelopeFactory) {
						events.push(
							deps.envelopeFactory.createEnvelope({
								kind: 'run.state_changed',
								runId: targetRun.id,
								taskId: targetRun.task_id,
								actorDeviceId: null,
								payload: { from, to: step, reason: comment },
							}),
						);
					}
					from = step;
				}
			}

			const lane = deps.tasksRepo?.clearLaneNo?.(taskId);
			if (lane && lane.changes === 1 && deps.envelopeFactory) {
				events.push(
					deps.envelopeFactory.createEnvelope({
						kind: 'lane.released',
						taskId: targetRun.task_id,
						runId: targetRun.id,
						actorDeviceId: null,
						payload: {
							docId: lane.docId,
							laneNo: lane.previousLaneNo,
							taskId: targetRun.task_id,
							runId: targetRun.id,
							reason: 'awaiting_human',
						},
					}),
				);
			}

			if (deps.gatesRepo) {
				const latest = deps.gatesRepo.findLatestByTaskIdAndKind?.(taskId, 'review');
				if (latest && latest.state === 'waiting') {
					deps.gatesRepo.updateDecision(
						latest.id,
						latest.decision ?? 'rework',
						comment,
						null,
						nowTs,
					);
				} else {
					deps.gatesRepo.create({
						id: deps.ids.newId(),
						task_id: taskId,
						run_id: targetRun.id,
						kind: 'review',
						state: 'waiting',
						comment,
						created_at: nowTs,
					});
					if (deps.envelopeFactory) {
						events.push(
							deps.envelopeFactory.createEnvelope({
								kind: 'task.gate_waiting',
								runId: targetRun.id,
								taskId: targetRun.task_id,
								actorDeviceId: null,
								payload: { gate: 'review', comment },
							}),
						);
					}
				}
			}
		};

		if (deps.unitOfWork) {
			deps.unitOfWork.run(persist);
		} else {
			persist();
		}

		if (deps.bus) {
			for (const ev of events) {
				deps.bus.publish(ev);
			}
		}
	}

	/**
	 * 投递失败的唯一收口：标掉失败的返工行、把任务交回人手、回类型化 `undeliverable`。
	 * 一条路径，保证「失败不留占槽 / 不留幽灵行 / 不重复计数」不会被某个分支漏掉。
	 */
	function failReworkDelivery(params: {
		readonly targetRun: RunRow;
		readonly reviewRunId: string | null;
		readonly reworkRunId?: string | null;
		readonly reworkCount: number;
		readonly reason: ReworkUndeliverableReason;
		readonly message: string;
		readonly source: ReworkSource;
		readonly diffRegression: DiffRegressionEvaluation;
	}): DispatchReworkResult {
		if (params.reworkRunId) {
			markReworkRunFailed(params.reworkRunId, params.reason);
		}
		parkTaskAfterDeliveryFailure(params.targetRun, params.reason);
		return buildUndeliverableResult({
			targetRunId: params.targetRun.id,
			reviewRunId: params.reviewRunId,
			reworkRunId: params.reworkRunId ?? null,
			reworkCount: params.reworkCount,
			reason: params.reason,
			message: params.message,
			source: params.source,
			diffRegression: params.diffRegression,
		});
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
		if (!targetRun.task_id) {
			throw new AppError('E_VALIDATION', 'Cannot dispatch rework for run without task_id');
		}
		const taskId = targetRun.task_id;

		// 会话归档后严格只读，禁止回灌或再进入返工（AC 4 / E-302 / M6-T10）
		assertNotArchived(targetRun);

		// AC 2 & E-68: 判定工作区改动是否缩小或回退
		const diffRegression = evaluateDiffRegression(input.previousDiff, input.currentDiff);

		// 2. 检查自动重试上限（AC 4, E-55, E-68）
		// 旧计数已达 2 时直接 reviewing→awaiting_human 不进任何分支（E-55）
		const currentReworkCount = targetRun.rework_count ?? 0;
		const maxReworkCount = input.maxReworkCount ?? deps.maxReworkCount ?? DEFAULT_MAX_REWORK_COUNT;
		const isAutoReview = !isManual && targetRun.state === 'reviewing';

		if (isAutoReview && currentReworkCount >= maxReworkCount) {
			const pendingEvents: EventEnvelope[] = [];

			const persistLimitReached = () => {
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
								taskId,
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

				if (input.reviewRunId) {
					const reviewRun = deps.runsRepo.findById(input.reviewRunId);
					if (
						reviewRun &&
						reviewRun.state !== 'awaiting_human' &&
						canTransition(reviewRun.state as RunState, 'awaiting_human', {
							reworkCount: currentReworkCount,
							maxReworkCount,
						})
					) {
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

		// 3. 检查能力位与进程存活性（AC 1, E-93）
		// 按被审运行快照 launch_spec_json.adapterKind 读代码层能力位（不读注册表当前值）
		const adapterKind = extractAdapterKindFromSnapshot(targetRun, deps.snapshotsRepo);
		const caps = resolveCaps(targetRun.agent_id, adapterKind);
		const canReply = caps.canReply;
		const canResume = caps.canResume;
		const isProcessAlive = isTargetProcessAlive(targetRun, deps.processRegistry);

		if (!isProcessAlive || !canReply) {
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

			const isSessionDispatchEnabled =
				deps.enableSessionDispatch === true ||
				Boolean(
					deps.worktreeManager ||
						deps.tasksRepo ||
						deps.gitRunner ||
						deps.resumeSession ||
						deps.spawnReworkRun,
				);

			if (!isSessionDispatchEnabled) {
				// #136：没有消费者时 handover 不是成功。进程已结束/无回话能力又没有任何投递器，
				// 只能留下类型化失败：由闸门或补位方报 E_MESSAGE_UNDELIVERED，任务交回人手入口。
				return failReworkDelivery({
					targetRun,
					reviewRunId: input.reviewRunId ?? null,
					reworkCount: currentReworkCount,
					reason: 'session_dispatch_unavailable',
					message: `Rework for run '${targetRun.id}' has no session dispatcher: the process is ${
						isProcessAlive ? 'alive but cannot reply' : 'ended'
					} and no resume / new-run callback is wired.`,
					source: input.source,
					diffRegression,
				});
			}
		}

		// 分支由能力位决定，代码中不存在「先试投递失败再降级」路径（AC 1）
		// 分支一：进程活着且 canReply → 回灌（inject）
		// 分支二：已结束且 canResume → 恢复后回灌并明示新运行（resume, E-112）
		// 分支三：都不能 → 新开实施运行（new_session, E-279）
		const isBranchOne = isProcessAlive && canReply;
		const isBranchTwo = !isBranchOne && canResume;
		const isBranchThree = !isBranchOne && !isBranchTwo;

		const nextReworkCount = input.countAlreadyApplied ? currentReworkCount : currentReworkCount + 1;
		const now = deps.clock.now();

		// ========== 分支一：回灌（inject） ==========
		if (isBranchOne) {
			const transitionReason = isManual
				? REWORK_TRANSITION_REASONS.HUMAN_REWORK
				: REWORK_TRANSITION_REASONS.REWORK_INJECTION;

			const pendingEvents: EventEnvelope[] = [];

			const persistReinjection = () => {
				if (targetRun.state !== 'reworking') {
					assertValidTransition(targetRun.state as RunState, 'reworking', {
						reason: transitionReason,
						reworkCount: currentReworkCount,
						maxReworkCount,
					});
				}

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
							taskId,
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

			// 事务提交后：通过消息回话通路将返工意见投递给原进程
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
								taskId,
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

			// 意见回灌原会话成功：reworking --> running
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

			// AC 4: 每分支在事务后发 run.rework_dispatched{mode, source}
			if (deps.bus && deps.envelopeFactory) {
				const dispatchedEnvelope = deps.envelopeFactory.createEnvelope({
					kind: 'run.rework_dispatched',
					runId: targetRun.id,
					taskId: targetRun.task_id,
					actorDeviceId: input.actorDeviceId ?? null,
					payload: {
						mode: 'inject',
						source: input.source,
						targetRunId: targetRun.id,
						reviewRunId: input.reviewRunId ?? null,
						reworkCount: nextReworkCount,
					},
				});
				deps.bus.publish(dispatchedEnvelope);
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

		// ========== 分支二 & 分支三 共用工作区校验（AC 3, E-277） ==========
		// worktree 目录已不存在时走 M5-T1 在原分支上 reuse 重建；
		// 分支不存在转 awaiting_human 并在闸门 comment 写 branch_missing，不开干净 worktree（E-277）
		let effectiveWorktreePath = targetRun.worktree_path ?? '';
		const isWorktreeOnDisk = await checkWorktreePathExists(targetRun.worktree_path, deps.fs);

		if (!isWorktreeOnDisk) {
			const repoPath = resolveRepoPath(targetRun);
			const branchExists = await checkBranchExists(targetRun.branch_name, repoPath, deps.gitRunner);

			if (!branchExists || !targetRun.branch_name) {
				// 分支不存在：转 awaiting_human 并在闸门 comment 写 branch_missing，不开干净 worktree
				const branchMissingEvents: EventEnvelope[] = [];

				const persistBranchMissing = () => {
					if (
						targetRun.state !== 'awaiting_human' &&
						!isTerminalRunState(targetRun.state as RunState)
					) {
						assertValidTransition(targetRun.state as RunState, 'awaiting_human', {
							reason: REWORK_TRANSITION_REASONS.BRANCH_MISSING,
						});

						deps.runsRepo.updateState({
							id: targetRun.id,
							state: 'awaiting_human',
							fromState: targetRun.state,
							toState: 'awaiting_human',
							queuedReason: REWORK_TRANSITION_REASONS.BRANCH_MISSING,
							actorDeviceId: input.actorDeviceId ?? null,
						});

						if (deps.envelopeFactory) {
							branchMissingEvents.push(
								deps.envelopeFactory.createEnvelope({
									kind: 'run.state_changed',
									runId: targetRun.id,
									taskId: targetRun.task_id,
									actorDeviceId: input.actorDeviceId ?? null,
									payload: {
										from: targetRun.state as RunState,
										to: 'awaiting_human',
										reason: REWORK_TRANSITION_REASONS.BRANCH_MISSING,
									},
								}),
							);
						}
					}

					// 在闸门 comment 写 branch_missing（E-277）
					if (deps.gatesRepo) {
						const existingGate = deps.gatesRepo.findLatestByTaskIdAndKind(taskId, 'review');
						if (existingGate && existingGate.state === 'waiting') {
							deps.gatesRepo.updateDecision(
								existingGate.id,
								existingGate.decision ?? 'rework',
								'branch_missing',
								input.actorDeviceId ?? null,
								now,
							);
						} else {
							deps.gatesRepo.create({
								id: deps.ids.newId(),
								task_id: taskId,
								run_id: targetRun.id,
								kind: 'review',
								state: 'waiting',
								comment: 'branch_missing',
								created_at: now,
							});
						}

						if (deps.envelopeFactory) {
							branchMissingEvents.push(
								deps.envelopeFactory.createEnvelope({
									kind: 'task.gate_waiting',
									runId: targetRun.id,
									taskId: targetRun.task_id,
									actorDeviceId: input.actorDeviceId ?? null,
									payload: {
										gate: 'review',
										comment: 'branch_missing',
									},
								}),
							);
						}
					}
				};

				if (deps.unitOfWork) {
					deps.unitOfWork.run(persistBranchMissing);
				} else {
					persistBranchMissing();
				}

				if (deps.bus) {
					for (const ev of branchMissingEvents) {
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
					reason: 'branch_missing',
					message: `Worktree directory does not exist and branch '${targetRun.branch_name}' is missing (branch_missing). Transferred to awaiting_human.`,
					source: input.source,
					diffRegression,
				});
			}

			// 分支存在：走 M5-T1 在原分支上 reuse 重建
			if (deps.worktreeManager && repoPath) {
				const prepared = await deps.worktreeManager.prepareWorktree({
					repoPath,
					taskId: targetRun.task_id,
					preferredBranchName: targetRun.branch_name,
					targetWorktreePath: targetRun.worktree_path ?? undefined,
					worktreeMode: 'reuse',
				});
				effectiveWorktreePath = prepared.worktreePath;
			}
		}

		// ========== 分支二：恢复后回灌并明示新运行（resume, E-112） ==========
		if (isBranchTwo) {
			// #136：缺恢复回调时不得先插一行再假装恢复成功——直接给类型化失败并把任务交回人手。
			if (!deps.resumeSession) {
				return failReworkDelivery({
					targetRun,
					reviewRunId: input.reviewRunId ?? null,
					reworkCount: currentReworkCount,
					reason: 'session_resume_unavailable',
					message: `Run '${targetRun.id}' supports resume but no resumeSession callback is wired.`,
					source: input.source,
					diffRegression,
				});
			}

			const newRunId = deps.ids.newId();
			const existingRuns = deps.runsRepo.listByTaskId(targetRun.task_id);
			const attemptNo = existingRuns.length + 1;
			const targetTask = deps.tasksRepo?.findById(targetRun.task_id);

			const newRunInsert: RunInsertRow = {
				id: newRunId,
				task_id: targetRun.task_id,
				attempt_no: attemptNo,
				kind: 'implement',
				origin: 'rework',
				spawned_by_run_id: input.reviewRunId ?? null,
				parent_run_id: null,
				state: 'starting',
				agent_id: targetRun.agent_id,
				model_name: targetRun.model_name,
				reported_model: targetRun.reported_model,
				effort_tier: targetRun.effort_tier,
				reported_effort: targetRun.reported_effort,
				permission_tier: targetRun.permission_tier,
				snapshot_id: targetRun.snapshot_id,
				worktree_path: effectiveWorktreePath,
				branch_name: targetRun.branch_name,
				vendor_session_ref: targetRun.vendor_session_ref,
				rework_count: nextReworkCount,
				actor_device_id: input.actorDeviceId ?? null,
				started_at: now,
				lane_no: targetTask?.lane_no ?? targetRun.lane_no ?? null,
			};

			const resumeEvents: EventEnvelope[] = [];

			const persistResume = () => {
				assertSessionRefFree(
					{ taskId, vendorSessionRef: newRunInsert.vendor_session_ref ?? null },
					{ runsRepo: deps.runsRepo, tasksRepo: deps.tasksRepo },
				);
				deps.runsRepo.insert(newRunInsert);

				if (deps.envelopeFactory) {
					resumeEvents.push(
						deps.envelopeFactory.createEnvelope({
							kind: 'run.state_changed',
							runId: newRunId,
							taskId,
							actorDeviceId: input.actorDeviceId ?? null,
							payload: {
								from: targetRun.state as RunState,
								to: 'starting',
								reason: REWORK_TRANSITION_REASONS.REWORK_INJECTION,
							},
						}),
					);
				}
			};

			if (deps.unitOfWork) {
				deps.unitOfWork.run(persistResume);
			} else {
				persistResume();
			}

			if (deps.bus) {
				for (const ev of resumeEvents) {
					deps.bus.publish(ev);
				}
			}

			// 事务提交后执行恢复投递；只有进程真的起来且意见进了启动参数才算送达
			let resumeMessageId: string | undefined = undefined;
			let resumeResult: ResumeSessionResult;
			try {
				resumeResult = await deps.resumeSession({
					runId: newRunId,
					taskId: targetRun.task_id,
					agentId: targetRun.agent_id,
					text: input.reworkText,
					kind: 'reply',
					actorDeviceId: input.actorDeviceId ?? null,
				});
			} catch (error) {
				return failReworkDelivery({
					targetRun,
					reviewRunId: input.reviewRunId ?? null,
					reworkRunId: newRunId,
					reworkCount: currentReworkCount,
					reason: undeliverableReasonFromError(error),
					message: `Resuming the session for run '${targetRun.id}' failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
					source: input.source,
					diffRegression,
				});
			}

			if (resumeResult.delivered !== true) {
				return failReworkDelivery({
					targetRun,
					reviewRunId: input.reviewRunId ?? null,
					reworkRunId: newRunId,
					reworkCount: currentReworkCount,
					reason: 'delivery_not_confirmed',
					message: `Resumed session for run '${targetRun.id}' did not confirm delivery.`,
					source: input.source,
					diffRegression,
				});
			}
			resumeMessageId = resumeResult.messageId;

			// 恢复分支与「新开」分支用同一把尺子：仍停在 starting/queued，或已经落成终态失败
			// （启动即退出、spawn 失败），都不算送达——不得返回成功，也不得发 rework_dispatched。
			const spawnedResumeRun = deps.runsRepo.findById(newRunId);
			if (!spawnedResumeRun || !isReworkDeliveryConfirmed(spawnedResumeRun.state)) {
				const reason = reworkFailureReasonFromRun(spawnedResumeRun) ?? 'delivery_not_confirmed';
				return failReworkDelivery({
					targetRun,
					reviewRunId: input.reviewRunId ?? null,
					reworkRunId: newRunId,
					reworkCount: currentReworkCount,
					reason,
					message: `Resume callback for run '${targetRun.id}' reported delivery but run '${newRunId}' is '${spawnedResumeRun?.state ?? 'missing'}' (${reason}).`,
					source: input.source,
					diffRegression,
				});
			}

			// 走到这里恢复回调已经把新运行拉到 running（见 service/session-resume.ts）；
			// 上面那把尺子保证不存在「停在 starting 也算送达」的假分支。

			// AC 4: 每分支在事务后发 run.rework_dispatched{mode, source}
			if (deps.bus && deps.envelopeFactory) {
				const dispatchedEnvelope = deps.envelopeFactory.createEnvelope({
					kind: 'run.rework_dispatched',
					runId: newRunId,
					taskId: targetRun.task_id,
					actorDeviceId: input.actorDeviceId ?? null,
					payload: {
						mode: 'resume',
						source: input.source,
						targetRunId: targetRun.id,
						reviewRunId: input.reviewRunId ?? null,
						reworkRunId: newRunId,
						reworkCount: nextReworkCount,
					},
				});
				deps.bus.publish(dispatchedEnvelope);
			}

			return Object.freeze({
				success: true,
				action: 'resumed',
				mode: 'resume',
				targetRunId: targetRun.id,
				newRunId,
				reviewRunId: input.reviewRunId ?? null,
				reworkCount: nextReworkCount,
				messageId: resumeMessageId,
				source: input.source,
				diffRegression,
			});
		}

		// ========== 分支三：新开实施运行（new_session, E-279） ==========
		// 既不能回灌也不能恢复：新开实施运行（origin='rework'、同任务 attempt_no+1、spawned_by_run_id=审查运行、同 worktree 与分支）
		// #136：缺新开回调时不得先插一行再假装派发成功——直接给类型化失败并把任务交回人手。
		if (!deps.spawnReworkRun) {
			return failReworkDelivery({
				targetRun,
				reviewRunId: input.reviewRunId ?? null,
				reworkCount: currentReworkCount,
				reason: 'session_dispatch_unavailable',
				message: `Run '${targetRun.id}' can neither reply nor resume and no spawnReworkRun callback is wired.`,
				source: input.source,
				diffRegression,
			});
		}

		const newRunId = deps.ids.newId();
		const existingRuns = deps.runsRepo.listByTaskId(targetRun.task_id);
		const attemptNo = existingRuns.length + 1;

		// 组装自包含提示词（AC 2, E-279）
		const snapshot = deps.snapshotsRepo?.findById(targetRun.snapshot_id);
		const reworkPrompt = assembleReworkPrompt({
			reworkText: input.reworkText,
			implPrompt: snapshot?.impl_prompt,
			worktreePath: effectiveWorktreePath,
			branchName: targetRun.branch_name,
			taskId: targetRun.task_id,
		});

		// 若快照仓储支持写入，将新会话自包含提示词固化为新快照
		let snapshotIdToUse = targetRun.snapshot_id;
		if (deps.snapshotsRepo?.insert && snapshot) {
			const newSnapshotId = deps.ids.newId();
			deps.snapshotsRepo.insert({
				id: newSnapshotId,
				task_id: targetRun.task_id,
				input_text: snapshot.input_text ?? null,
				output_text: snapshot.output_text ?? null,
				accept_text: snapshot.accept_text ?? null,
				impl_prompt: reworkPrompt,
				review_prompt: snapshot.review_prompt ?? null,
				bug_prompt: snapshot.bug_prompt ?? null,
				contract_hash: snapshot.contract_hash ?? 'rework',
				task_paths_json: snapshot.task_paths_json ?? '[]',
				launch_spec_json: snapshot.launch_spec_json,
				created_at: now,
			});
			snapshotIdToUse = newSnapshotId;
		}

		const targetTask = deps.tasksRepo?.findById(targetRun.task_id);
		const newRunInsert: RunInsertRow = {
			id: newRunId,
			task_id: targetRun.task_id,
			attempt_no: attemptNo,
			kind: 'implement',
			origin: 'rework',
			spawned_by_run_id: input.reviewRunId ?? null,
			parent_run_id: null,
			state: 'starting',
			agent_id: targetRun.agent_id,
			model_name: targetRun.model_name,
			reported_model: targetRun.reported_model,
			effort_tier: targetRun.effort_tier,
			reported_effort: targetRun.reported_effort,
			permission_tier: targetRun.permission_tier,
			snapshot_id: snapshotIdToUse,
			worktree_path: effectiveWorktreePath,
			branch_name: targetRun.branch_name,
			rework_count: nextReworkCount,
			actor_device_id: input.actorDeviceId ?? null,
			started_at: now,
			lane_no: targetTask?.lane_no ?? targetRun.lane_no ?? null,
		};

		const newSessionEvents: EventEnvelope[] = [];

		const persistNewSession = () => {
			assertSessionRefFree(
				{ taskId, vendorSessionRef: newRunInsert.vendor_session_ref ?? null },
				{ runsRepo: deps.runsRepo, tasksRepo: deps.tasksRepo },
			);
			deps.runsRepo.insert(newRunInsert);

			if (deps.envelopeFactory) {
				newSessionEvents.push(
					deps.envelopeFactory.createEnvelope({
						kind: 'run.state_changed',
						runId: newRunId,
						taskId,
						actorDeviceId: input.actorDeviceId ?? null,
						payload: {
							from: targetRun.state as RunState,
							to: 'starting',
							reason: REWORK_TRANSITION_REASONS.REWORK_INJECTION,
						},
					}),
				);
			}
		};

		if (deps.unitOfWork) {
			deps.unitOfWork.run(persistNewSession);
		} else {
			persistNewSession();
		}

		if (deps.bus) {
			for (const ev of newSessionEvents) {
				deps.bus.publish(ev);
			}
		}

		// 事务提交后执行新运行派发回调；只有进程真的起来才算派发成功
		try {
			await deps.spawnReworkRun({
				run: {
					...newRunInsert,
					model_name: newRunInsert.model_name ?? null,
					reported_model: newRunInsert.reported_model ?? null,
					effort_tier: newRunInsert.effort_tier ?? null,
					reported_effort: newRunInsert.reported_effort ?? null,
					worktree_path: newRunInsert.worktree_path ?? null,
					branch_name: newRunInsert.branch_name ?? null,
					parent_run_id: null,
					actor_device_id: newRunInsert.actor_device_id ?? null,
					started_at: newRunInsert.started_at ?? null,
					exit_code: null,
					exit_signal: null,
					vendor_session_ref: null,
					changed_file_count: null,
					token_usage_json: null,
					unmapped_event_count: 0,
					is_stall_suspected: 0,
					rework_count: nextReworkCount,
					queued_reason: null,
					idempotency_key: null,
					last_event_at: null,
					ended_at: null,
					pid: null,
					review_verdict: null,
				},
				reworkPrompt,
			});
		} catch (error) {
			return failReworkDelivery({
				targetRun,
				reviewRunId: input.reviewRunId ?? null,
				reworkRunId: newRunId,
				reworkCount: currentReworkCount,
				reason: undeliverableReasonFromError(error),
				message: `Spawning the new rework run for '${targetRun.id}' failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
				source: input.source,
				diffRegression,
			});
		}

		// 派发回调必须真的把进程拉起来，且不允许「起来就死」：仍停在 starting/queued 说明它什么都没做，
		// 已经落成终态失败（启动即退出 / spawn 失败）说明这次投递没成——两种都不算成功，也不发 dispatched。
		const spawnedReworkRun = deps.runsRepo.findById(newRunId);
		if (!spawnedReworkRun || !isReworkDeliveryConfirmed(spawnedReworkRun.state)) {
			const reason = reworkFailureReasonFromRun(spawnedReworkRun) ?? 'delivery_not_confirmed';
			return failReworkDelivery({
				targetRun,
				reviewRunId: input.reviewRunId ?? null,
				reworkRunId: newRunId,
				reworkCount: currentReworkCount,
				reason,
				message: `Rework run '${newRunId}' did not come up: state is '${spawnedReworkRun?.state ?? 'missing'}' (${reason}).`,
				source: input.source,
				diffRegression,
			});
		}

		// AC 4: 每分支在事务后发 run.rework_dispatched{mode, source}
		if (deps.bus && deps.envelopeFactory) {
			const dispatchedEnvelope = deps.envelopeFactory.createEnvelope({
				kind: 'run.rework_dispatched',
				runId: newRunId,
				taskId: targetRun.task_id,
				actorDeviceId: input.actorDeviceId ?? null,
				payload: {
					mode: 'new_run',
					source: input.source,
					targetRunId: targetRun.id,
					reviewRunId: input.reviewRunId ?? null,
					reworkRunId: newRunId,
					reworkCount: nextReworkCount,
				},
			});
			deps.bus.publish(dispatchedEnvelope);
		}

		return Object.freeze({
			success: true,
			action: 'new_session_spawned',
			mode: 'new_run',
			targetRunId: targetRun.id,
			newRunId,
			reviewRunId: input.reviewRunId ?? null,
			reworkCount: nextReworkCount,
			reworkPrompt,
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
