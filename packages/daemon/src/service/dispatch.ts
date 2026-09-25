import type { AgentEntryDto } from '@agent-scheduler/shared/api/agents';
import type {
	BatchDto,
	BatchGateOverrides,
	PauseBatchResponse,
	StartBatchResponse,
} from '@agent-scheduler/shared/api/batches';
import type { DocumentDto } from '@agent-scheduler/shared/api/documents';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type {
	CreateRunBody,
	RerunRunResponse,
	RunBaseRef,
	RunDto,
} from '@agent-scheduler/shared/api/runs';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import type { CodexSessionRegistry } from '../adapters/codex/app-server-session.ts';
import type { AgentRegistry } from '../config/registry.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { resolveAssignment } from '../domain/assignment.ts';
import { summarizeBatchLanding } from '../domain/batch-landing.ts';
import {
	DEFAULT_AGENT_CONCURRENCY_LIMIT,
	allocateConcurrencySlots,
	countActiveRunsForAgent,
} from '../domain/concurrency.ts';
import { computeDispatchCandidates } from '../domain/dispatch-candidates.ts';
import { assertVendorEffortInDomain } from '../domain/effort-value.ts';
import { freeLaneNumbers } from '../domain/lane-slots.ts';
import { deriveLanes } from '../domain/lanes.ts';
import {
	type TaskPathDescriptor,
	checkTaskPathClash,
	evaluatePathClashQueue,
	isTaskLanded,
	isTaskPathHolding,
	parseWrapupFixSerialReason,
} from '../domain/path-clash.ts';
import { isPermissionTier, resolvePermissionMapping } from '../domain/permission-tier.ts';
import { parsePipelineSettings } from '../domain/pipeline-settings.ts';
import {
	type RunState,
	TERMINAL_RUN_STATES,
	countsTowardAgentConcurrency,
	isTerminalRunState,
} from '../domain/run-state-machine.ts';
import {
	deriveTaskCrossBatchFix,
	deriveTaskInHead,
	deriveTaskInHeadMethod,
	deriveTaskState,
} from '../domain/task-state.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { LaunchSpec, ManagedProcess, SpawnManagedOptions } from '../proc/spawn.ts';
import type { BatchWrapupsRepo } from '../repo/batch-wrapups.ts';
import type { BatchRow, BatchesRepo } from '../repo/batches.ts';
import type { DispatchSnapshotsRepo } from '../repo/dispatch-snapshots.ts';
import type { DocumentRow, DocumentsRepo } from '../repo/documents.ts';
import type { EventSeqRepo } from '../repo/event-seq-repo.ts';
import type { GatesRepo } from '../repo/gates.ts';
import {
	type RunInsertRow,
	type RunRow,
	type RunsRepo,
	isConstraintConflict,
	toRunDto,
} from '../repo/runs.ts';
import type { SettingsRepo } from '../repo/settings.ts';
import type { TaskRow, TasksRepo } from '../repo/tasks.ts';
import {
	type BaseSelector,
	type UpstreamTaskInfo,
	createBaseSelector,
} from '../workspace/base-select.ts';
import { isBranchInHead } from '../workspace/in-head.ts';
import type { PrepareWorktreeInput, PrepareWorktreeResult } from '../workspace/worktree.ts';
import { createAssignmentReader } from './assignment-reader.ts';
import { type StoredAssignmentDraft, parseAssignmentDraft } from './assignments.ts';
import { type BatchService, createBatchService } from './batch.ts';
import type { LanesService } from './lanes.ts';
import type { EventEnvelopeInput } from './logstore.ts';
import { createRerunService } from './rerun.ts';
import { REWORK_DELIVERY_FAILED_PREFIX, type ReworkService } from './rework.ts';
import type { RunService } from './run.ts';
import { assertSessionRefFree } from './session-guard.ts';
import type { WrapupService } from './wrapup.ts';

export type { RunInsertRow, RunRow, RunsRepo };
export { toRunDto };

export function toBatchDto(row: BatchRow): BatchDto {
	return Object.freeze({
		id: row.id,
		docId: row.doc_id,
		batchNo: row.batch_no,
		state: row.state,
		startedAt: row.started_at ?? null,
		finishedAt: row.finished_at ?? null,
	});
}

export function toTaskDto(
	row: TaskRow,
	latestRunState?: string | null,
	runsForTask?: readonly RunRow[],
): TaskDto {
	let deps: string[] = [];
	try {
		deps = JSON.parse(row.deps_json);
	} catch {
		deps = [];
	}
	const implRuns = runsForTask?.filter((r) => r.kind === 'implement') ?? [];
	const latestImplRun =
		implRuns.length > 0
			? implRuns.reduce((max, r) => (r.attempt_no > max.attempt_no ? r : max))
			: null;
	const inHead = deriveTaskInHead({
		manualState: row.manual_state,
		latestImplementationRun: latestImplRun
			? { state: latestImplRun.state, is_in_head: latestImplRun.is_in_head }
			: null,
	});
	const inHeadMethod = deriveTaskInHeadMethod(
		{
			manualState: row.manual_state,
			latestImplementationRun: latestImplRun
				? { state: latestImplRun.state, is_in_head: latestImplRun.is_in_head }
				: null,
		},
		row.manual_state,
	);
	const crossBatchFix = runsForTask
		? deriveTaskCrossBatchFix({ taskBatchId: row.batch_id, runs: runsForTask })
		: false;

	return Object.freeze({
		id: row.id,
		docId: row.doc_id,
		taskKey: row.task_key,
		title: row.title,
		moduleKey: row.module_key,
		deps: Object.freeze(deps),
		estDays: row.est_days ?? null,
		batchId: row.batch_id ?? null,
		state: deriveTaskState(row.manual_state, latestRunState),
		inHead,
		inHeadMethod,
		crossBatchFix,
	});
}

export function toDocumentDto(row: DocumentRow): DocumentDto {
	return Object.freeze({
		id: row.id,
		docsPath: row.docs_path,
		projectName: row.project_name,
		repoPath: row.repo_path,
		mainBranch: row.main_branch,
		branchPrefix: row.branch_prefix,
		laneCount: row.lane_count,
		contentFingerprint: row.content_fingerprint,
		isSourceReadable: row.is_source_readable === 1,
		isTakeoverNotified: row.is_takeover_notified === 1,
		importedAt: row.imported_at,
		lastSeenAt: row.last_seen_at,
	});
}

export interface SchedulerTickResult {
	readonly executed: boolean;
	readonly reason?: string;
	readonly batchesAdvanced: readonly string[];
	readonly runsDispatched: readonly string[];
	readonly tasksBlocked: readonly { readonly taskId: string; readonly reason: string }[];
	readonly tasksDeferred: readonly { readonly taskId: string; readonly reason: string }[];
}

export interface CreateRunInput extends CreateRunBody {
	readonly actorDeviceId?: string | null;
	readonly kind?: 'implement' | 'review';
	readonly parentRunId?: string | null;
	readonly laneNo?: number | null;
}

export interface CreateRunResult {
	readonly run: RunDto;
	readonly isExisting: boolean;
}

export interface RerunRunInput {
	readonly runId: string;
	readonly idempotencyKey: string;
	readonly actorDeviceId?: string | null;
}

export interface StartBatchInput {
	readonly batchId: string;
	readonly gateOverrides?: BatchGateOverrides;
	readonly actorDeviceId?: string | null;
}

export interface PauseBatchInput {
	readonly batchId: string;
	readonly actorDeviceId?: string | null;
}

export interface DispatchableAgent {
	readonly agentId: string;
	readonly canDispatch: boolean;
	readonly concurrencyLimit?: number;
}

export interface BuildLaunchSpecInput {
	readonly runId: string;
	readonly cwd: string;
	readonly model?: string | null;
	readonly effortTier?: unknown;
	readonly permissionTier?: unknown;
	readonly prompt?: string;
	readonly [key: string]: unknown;
}

export interface DispatchAdapter {
	readonly buildLaunchSpec: (options: BuildLaunchSpecInput) => LaunchSpec;
	readonly mapEvents: (vendorLine: unknown) => readonly EventEnvelopeInput[];
}

function createAgentDefaultsLookup(
	registry?: AgentRegistry,
): ((id: string) => import('../domain/assignment.ts').AgentDefaultInfo | null) | undefined {
	if (!registry) return undefined;
	return (id: string) => {
		const a = registry.getSnapshot().agents[id];
		return a
			? {
					agentId: id,
					defaultModel: a.defaultModel,
					defaultEffortTier: a.defaultEffortTier,
					effortVendorMap: a.effortVendorMap,
				}
			: null;
	};
}

export interface DispatchServiceDeps {
	readonly unitOfWork?: UnitOfWork;
	readonly tasksRepo: TasksRepo;
	readonly batchesRepo: BatchesRepo;
	readonly documentsRepo: DocumentsRepo;
	readonly dispatchSnapshotsRepo: DispatchSnapshotsRepo;
	readonly runsRepo: RunsRepo;
	readonly gatesRepo?: GatesRepo;
	readonly settingsRepo?: SettingsRepo;
	readonly batchWrapupsRepo?: BatchWrapupsRepo;
	readonly batchService?: BatchService;
	readonly wrapupService?: WrapupService;
	readonly lanesService?: LanesService;
	readonly reworkService?: Pick<ReworkService, 'dispatchRework'>;
	readonly isBranchInHead?: typeof isBranchInHead;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly eventSeqRepo?: EventSeqRepo;
	/**
	 * 最近一条真正发布的事件 id（环形缓冲的 latest）。快照的 latestEventId 给 SSE 续接当游标用，
	 * 必须是事件 id 而不是 event_seq 预留水位——水位比真实 id 大得多，续接会把之后的事件全丢掉（E-153）。
	 */
	readonly getLatestEventId?: () => number | null;
	/** tick 内部被吞的异常（收口触发失败等）走这里记日志，缺省丢弃。 */
	readonly logFailure?: (error: unknown) => void;
	readonly getDispatchHalt?: () => boolean;
	readonly agentRegistry?: AgentRegistry;
	readonly agentLimits?: number | Record<string, number> | ((agentId: string) => number);
	readonly listAgents?: () => Promise<readonly AgentEntryDto[]> | readonly AgentEntryDto[];
	readonly listDispatchableAgents?: () => readonly DispatchableAgent[];
	readonly resolveAgentForTask?: (task: TaskRow) => string | null;
	readonly baseSelector?: BaseSelector;
	readonly workspace?: {
		readonly prepareWorktree: (input: PrepareWorktreeInput) => Promise<PrepareWorktreeResult>;
	};
	readonly proc?: {
		readonly spawnManaged: (
			spec: LaunchSpec,
			options?: Partial<SpawnManagedOptions>,
		) => ManagedProcess;
	};
	readonly adapters?: Readonly<Record<string, DispatchAdapter>>;
	readonly codexSessions?: CodexSessionRegistry;
	readonly runService?: RunService;
	readonly reviewService?: {
		readonly evaluateMechanicalCheck: (input: { readonly runId: string }) => Promise<unknown>;
	};
}

export interface DispatchService {
	createRun(input: CreateRunInput): Promise<CreateRunResult>;
	rerunRun(input: RerunRunInput): Promise<RerunRunResponse>;
	startBatch(input: StartBatchInput): Promise<StartBatchResponse>;
	pauseBatch(input: PauseBatchInput): Promise<PauseBatchResponse>;
	getRun(runId: string): Promise<RunDto>;
	listRuns(): Promise<readonly RunDto[]>;
	getSnapshot(docId?: string): Promise<SnapshotResponse>;
	tick(): Promise<SchedulerTickResult>;
	launchRun(runId: string): Promise<void>;
	getBatchGateOverrides(batchId: string): BatchGateOverrides | undefined;
	setBatchGateOverrides(batchId: string, overrides: BatchGateOverrides): void;
	getInHeadWarning(runId: string): string | null;
}

function resolveConstraintConflict(
	error: unknown,
	fallback: () => CreateRunResult | null,
): CreateRunResult | null {
	if (!isConstraintConflict(error)) {
		return null;
	}
	return fallback();
}

export function createDispatchService(deps: DispatchServiceDeps): DispatchService {
	const logFailure = deps.logFailure ?? (() => undefined);
	const runsRepo = deps.runsRepo;
	const assignmentReader = createAssignmentReader({
		runsRepo,
		dispatchSnapshotsRepo: deps.dispatchSnapshotsRepo,
	});
	const batchGateOverridesMap = new Map<string, BatchGateOverrides>();
	const consecutiveInHeadErrors = new Map<string, number>();
	const inFlightLaunches = new Set<string>();
	let isTicking = false;

	const effectiveBatchService =
		deps.batchService ??
		createBatchService({
			batchesRepo: deps.batchesRepo,
			tasksRepo: deps.tasksRepo,
			runsRepo: deps.runsRepo,
			unitOfWork: deps.unitOfWork ?? { run: (fn) => fn() },
			clock: deps.clock,
			bus: deps.bus,
			envelopeFactory: deps.envelopeFactory,
		});

	function checkContractReady(task: TaskRow): void {
		if (task.is_contract_ready !== 1) {
			let reasons: string[] = [];
			try {
				reasons = JSON.parse(task.contract_reasons_json);
			} catch {
				reasons = ['Task contract is not ready'];
			}
			throw new AppError(
				'E_DOC_CONTRACT_PENDING',
				`Task ${task.task_key} (${task.id}) contract is not ready for dispatch (E-82)`,
				{
					details: {
						taskId: task.id,
						reasons,
					},
				},
			);
		}
	}

	function checkTaskRemoved(task: TaskRow): void {
		if (task.is_removed_from_doc === 1) {
			throw new AppError(
				'E_TASK_REMOVED_FROM_DOC',
				`Task ${task.task_key} (${task.id}) has been removed from document (E-18, E-77)`,
				{
					details: { taskId: task.id },
				},
			);
		}
	}

	function checkDocumentReadable(docId: string): DocumentRow {
		const doc = deps.documentsRepo.findById(docId);
		if (!doc) {
			throw new AppError('E_NOT_FOUND', `Document not found: ${docId}`, {
				details: { docId },
			});
		}
		if (doc.is_source_readable === 0) {
			throw new AppError('E_DOC_SOURCE_UNREADABLE', 'Document source is unreadable (E-82)', {
				details: { docId },
			});
		}
		return doc;
	}

	function isTaskFinishedOrLanded(task: TaskRow): boolean {
		if (isTaskLanded(task.manual_state)) {
			return true;
		}
		const runs = runsRepo.listByTaskId(task.id);
		return runs.some((r) => r.state === 'landed');
	}

	function listDispatchableAgents(): readonly DispatchableAgent[] {
		if (deps.listDispatchableAgents) {
			return deps.listDispatchableAgents();
		}
		return Object.freeze([]);
	}

	/**
	 * Agent for an implementation run: the task's assignment draft wins (M8-T11); a task without a
	 * draft falls back to the first dispatchable agent (M8-T3). A drafted agent is returned even
	 * when it cannot dispatch, so the caller reports `agent_unavailable` for the drafted agent
	 * rather than re-routing the task to another one.
	 */
	function resolveAgentForTask(task: TaskRow): string | null {
		if (deps.resolveAgentForTask) {
			return deps.resolveAgentForTask(task);
		}
		const draft = parseAssignmentDraft(task.assignment_draft_json);
		if (draft) {
			return draft.agentId;
		}
		const available = listDispatchableAgents().find((agent) => agent.canDispatch);
		return available?.agentId ?? null;
	}

	/**
	 * Session ordinal of a run about to be inserted (E-31): concurrency-occupying runs of the same
	 * agent plus one. Read inside the insert transaction so two dispatches cannot share a number.
	 */
	function nextSessionNoFor(agentId: string): number {
		const occupying = runsRepo
			.listActive()
			.filter(
				(run) => run.agent_id === agentId && countsTowardAgentConcurrency(run.state as RunState),
			).length;
		return occupying + 1;
	}

	function isAgentDispatchable(agentId: string): boolean {
		const agents = listDispatchableAgents();
		if (agents.length === 0) {
			return false;
		}
		return agents.some((agent) => agent.agentId === agentId && agent.canDispatch);
	}

	function agentLimitFor(agentId: string): number {
		if (typeof deps.agentLimits === 'function') {
			return Math.max(0, Math.floor(deps.agentLimits(agentId)));
		}
		if (typeof deps.agentLimits === 'number') {
			return Math.max(0, Math.floor(deps.agentLimits));
		}
		if (deps.agentLimits && typeof deps.agentLimits === 'object') {
			const mapped = deps.agentLimits[agentId];
			if (typeof mapped === 'number') {
				return Math.max(0, Math.floor(mapped));
			}
		}
		const listed = listDispatchableAgents().find((agent) => agent.agentId === agentId);
		if (typeof listed?.concurrencyLimit === 'number') {
			return Math.max(0, Math.floor(listed.concurrencyLimit));
		}
		return DEFAULT_AGENT_CONCURRENCY_LIMIT;
	}

	/**
	 * 某个 agent 当前占用的并发名额（E-47 / E-54）。
	 *
	 * 被同任务后续实施运行取代的返工行（`kind='implement'`、`state='reworking'`，且同任务已有
	 * `attempt_no` 更大的实施运行）不再计数：它的进程已经死了，返工工作交给后来那条运行，
	 * 继续给它记一个名额等于把同一条流水线算两次。默认注册表里每个 agent 的 `maxConcurrency`
	 * 都是 1，不排除这种行时，E-327 经 tick 的补位投递会被自己那条旧行永久挡住。
	 */
	function countAgentConcurrency(runs: readonly RunRow[], agentId: string): number {
		const latestImplementAttempt = new Map<string, number>();
		for (const run of runs) {
			if (run.kind !== 'implement' || !run.task_id) continue;
			const attempt = run.attempt_no ?? 0;
			const current = latestImplementAttempt.get(run.task_id) ?? 0;
			if (attempt > current) {
				latestImplementAttempt.set(run.task_id, attempt);
			}
		}

		let count = 0;
		for (const run of runs) {
			if (run.agent_id !== agentId) continue;
			if (!countsTowardAgentConcurrency(run.state as RunState)) continue;
			if (
				run.kind === 'implement' &&
				run.state === 'reworking' &&
				run.task_id &&
				(run.attempt_no ?? 0) < (latestImplementAttempt.get(run.task_id) ?? 0)
			) {
				continue;
			}
			count += 1;
		}
		return count;
	}

	/**
	 * 返工运行**启动失败**不按任务失败处理（#136 / E-302、E-327）。
	 *
	 * 一次返工投递没成（spawn 抛错、启动即退出、启动超时）只是「这次没送出去」，任务本身没有失败：
	 * 它必须回到人手入口重试，而那条待恢复的实施会话也要留着恢复。走 `runService.transitionState`
	 * 会把 `kind='implement'` 的终态当成任务终态，连带把该任务全部会话归档、杀掉进程——那条会话就再也
	 * 恢复不了了。所以返工运行只落运行行状态与类型化 `queued_reason`，不触发归档。
	 */
	function failReworkRunStartup(
		runId: string,
		reason: string,
		exit?: { readonly exitCode?: number | null; readonly signal?: string | null },
	): void {
		const row = runsRepo.findById(runId);
		if (!row || isTerminalRunState(row.state as RunState)) {
			return;
		}

		const now = deps.clock.now();
		const pendingEvents: EventEnvelope[] = [];
		const marker = `${REWORK_DELIVERY_FAILED_PREFIX}:${reason}`;

		const persist = () => {
			runsRepo.updateState({
				id: runId,
				state: 'failed',
				fromState: row.state,
				toState: 'failed',
				queuedReason: marker,
				endedAt: now,
				exitCode: exit?.exitCode ?? null,
				exitSignal: exit?.signal ?? null,
				actorDeviceId: null,
			});

			if (deps.envelopeFactory) {
				pendingEvents.push(
					deps.envelopeFactory.createEnvelope({
						kind: 'run.state_changed',
						runId,
						taskId: row.task_id,
						actorDeviceId: null,
						payload: { from: row.state as RunState, to: 'failed', reason: marker },
					}),
				);
			}
		};

		if (deps.unitOfWork) {
			deps.unitOfWork.run(persist);
		} else {
			persist();
		}

		if (deps.bus) {
			for (const ev of pendingEvents) {
				deps.bus.publish(ev);
			}
		}
	}

	async function createRun(input: CreateRunInput): Promise<CreateRunResult> {
		const { taskId, agentId, idempotencyKey } = input;
		if (!taskId || typeof taskId !== 'string' || taskId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'taskId must be a non-empty string');
		}
		if (!agentId || typeof agentId !== 'string' || agentId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'agentId must be a non-empty string');
		}
		if (
			!idempotencyKey ||
			typeof idempotencyKey !== 'string' ||
			idempotencyKey.trim().length === 0
		) {
			throw new AppError('E_VALIDATION', 'idempotencyKey must be a non-empty string');
		}

		const existingByIdempotency = runsRepo.findByIdempotencyKey(idempotencyKey);
		if (existingByIdempotency) {
			return {
				run: toRunDto(existingByIdempotency),
				isExisting: true,
			};
		}

		const task = deps.tasksRepo.findById(taskId);
		if (!task) {
			throw new AppError('E_NOT_FOUND', `Task not found: ${taskId}`, {
				details: { taskId },
			});
		}

		checkDocumentReadable(task.doc_id);
		checkTaskRemoved(task);
		checkContractReady(task);

		if (!isAgentDispatchable(agentId)) {
			throw new AppError('E_AGENT_UNAVAILABLE', `Agent ${agentId} is not available for dispatch`, {
				details: { agentId, taskId },
			});
		}

		if (input.effort && 'vendor' in input.effort && input.effort.vendor) {
			const regSnap = deps.agentRegistry?.getSnapshot();
			const agentEntry = regSnap?.agents[agentId];
			if (agentEntry?.effortVendorMap === null) {
				throw new AppError(
					'E_VALIDATION',
					`Agent '${agentId}' does not support reasoning effort.`,
					{
						details: { field: 'effort', reason: 'effort_unsupported' },
					},
				);
			}
			const allowed = agentEntry?.effortVendorMap
				? (Object.values(agentEntry.effortVendorMap) as readonly string[])
				: [];
			assertVendorEffortInDomain(input.effort.vendor, allowed, 'effort');
		}

		const activeRun = runsRepo.findActiveByTaskId(taskId);
		if (
			activeRun &&
			!(activeRun.state === 'awaiting_human' && activeRun.queued_reason === 'exited_before_output')
		) {
			return {
				run: toRunDto(activeRun),
				isExisting: true,
			};
		}

		const now = deps.clock.now();
		const resolvedAssignment = resolveAssignment({
			stage: 'implement',
			body: {
				agentId,
				model: input.model ?? null,
				effort: input.effort ?? null,
			},
			agentDefaults: createAgentDefaultsLookup(deps.agentRegistry),
		});

		const launchSpecJson = JSON.stringify({
			agentId,
			execPath: deps.agentRegistry?.getSnapshot().agents[agentId]?.execPath,
			model: resolvedAssignment.modelName ?? null,
			effort: resolvedAssignment.effortTier ?? null,
			permissionTier: input.permissionTier ?? 'workspaceWrite',
			baseRef: input.baseRef ?? { kind: 'head' },
			worktreeMode: input.worktreeMode ?? 'fresh',
		});

		const existingRuns = runsRepo.listByTaskId(taskId);
		const attemptNo = existingRuns.length + 1;
		const runId = deps.ids.newId();

		const assignmentSnapshot = {
			agentId,
			modelName: resolvedAssignment.modelName ?? null,
			effortTier: resolvedAssignment.effortTier ?? null,
			effortVendor: resolvedAssignment.effortVendor ?? null,
			source: 'task' as const,
			followedTaskId: null,
			capturedAt: now,
		};
		const assignmentJson = assignmentReader.serializeTaskAssignment(assignmentSnapshot);

		const persist = (): { readonly snapshotId: string } => {
			if (typeof input.laneNo === 'number' && deps.tasksRepo.assignLaneNo) {
				const changes = deps.tasksRepo.assignLaneNo(taskId, input.laneNo);
				if (changes === 0) {
					throw new AppError('E_VALIDATION', `Task ${taskId} is already assigned to a lane.`);
				}
			}
			const snapshot = deps.dispatchSnapshotsRepo.takeSnapshotForTask({
				taskId,
				launchSpecJson,
				createdAt: now,
				assignmentJson,
			});
			const runInsert: RunInsertRow = {
				id: runId,
				task_id: taskId,
				attempt_no: attemptNo,
				kind: input.kind ?? 'implement',
				parent_run_id: input.parentRunId ?? null,
				state: 'starting',
				agent_id: agentId,
				model_name: resolvedAssignment.modelName ?? null,
				effort_tier: resolvedAssignment.effortTier ?? null,
				effort_vendor: resolvedAssignment.effortVendor ?? null,
				permission_tier: input.permissionTier ?? 'workspaceWrite',
				snapshot_id: snapshot.id,
				assignment_source: resolvedAssignment.source ?? 'task',
				idempotency_key: idempotencyKey,
				actor_device_id: input.actorDeviceId ?? null,
				started_at: now,
				session_no: nextSessionNoFor(agentId),
				lane_no: input.laneNo ?? null,
			};
			assertSessionRefFree(
				{ taskId, vendorSessionRef: undefined },
				{ runsRepo, tasksRepo: deps.tasksRepo },
			);
			runsRepo.insert(runInsert);
			if (activeRun?.state === 'awaiting_human') {
				deps.gatesRepo?.supersedePendingByRunIds?.([activeRun.id], now);
			}
			return { snapshotId: snapshot.id };
		};

		try {
			if (deps.unitOfWork) {
				deps.unitOfWork.run(persist);
			} else {
				persist();
			}
		} catch (err) {
			const racedByKey = resolveConstraintConflict(err, () => {
				const racedRun = runsRepo.findByIdempotencyKey(idempotencyKey);
				return racedRun ? { run: toRunDto(racedRun), isExisting: true } : null;
			});
			if (racedByKey) {
				return racedByKey;
			}
			const racedByTask = resolveConstraintConflict(err, () => {
				const active = runsRepo.findActiveByTaskId(taskId);
				return active ? { run: toRunDto(active), isExisting: true } : null;
			});
			if (racedByTask) {
				return racedByTask;
			}
			throw err;
		}

		const created = runsRepo.findById(runId);
		if (!created) {
			throw new AppError('E_INTERNAL', `Failed to retrieve created run: ${runId}`);
		}

		if (deps.envelopeFactory) {
			const envelope = deps.envelopeFactory.createEnvelope({
				kind: 'run.started',
				runId,
				taskId,
				actorDeviceId: input.actorDeviceId ?? null,
				payload: {
					runId,
					taskId,
					attemptNo,
					agentId,
					model: resolvedAssignment.modelName ?? null,
				},
			});
			if (deps.runService) {
				await deps.runService.ingestEvent(runId, envelope);
			} else if (deps.bus) {
				deps.bus.publish(envelope);
			}
		}

		if (deps.proc && deps.workspace && deps.runService) {
			void launchRun(runId).catch((err) => {
				logFailure(err);
			});
		}

		return {
			run: toRunDto(created),
			isExisting: false,
		};
	}

	const rerunService = createRerunService({
		unitOfWork: deps.unitOfWork,
		runsRepo,
		gatesRepo: deps.gatesRepo,
		tasksRepo: deps.tasksRepo,
		batchesRepo: deps.batchesRepo,
		documentsRepo: deps.documentsRepo,
		dispatchSnapshotsRepo: deps.dispatchSnapshotsRepo,
		clock: deps.clock,
		ids: deps.ids,
		bus: deps.bus,
		envelopeFactory: deps.envelopeFactory,
		isAgentDispatchable,
		listDispatchableAgents,
	});

	async function rerunRun(input: RerunRunInput): Promise<RerunRunResponse> {
		const result = await rerunService.rerunRun(input);
		if (result.run.id !== input.runId && result.run.state === 'starting') {
			void launchRun(result.run.id).catch((err) => {
				logFailure(err);
			});
		}
		return result;
	}

	async function startBatch(input: StartBatchInput): Promise<StartBatchResponse> {
		const { batchId, gateOverrides } = input;
		if (!batchId || typeof batchId !== 'string' || batchId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'batchId must be a non-empty string');
		}

		const batch = deps.batchesRepo.findById(batchId);
		if (!batch) {
			throw new AppError('E_NOT_FOUND', `Batch not found: ${batchId}`, {
				details: { batchId },
			});
		}

		checkDocumentReadable(batch.doc_id);

		if (batch.batch_no > 1) {
			const prevBatch = deps.batchesRepo.findByDocAndBatchNo(batch.doc_id, batch.batch_no - 1);
			if (prevBatch) {
				if (prevBatch.state !== 'done') {
					throw new AppError(
						'E_VALIDATION',
						`Previous batch ${prevBatch.batch_no} must be in 'done' state before starting batch ${batch.batch_no} (E-49, E-281)`,
						{
							details: {
								previousBatchState: prevBatch.state,
								previousBatchNo: prevBatch.batch_no,
								currentBatchNo: batch.batch_no,
							},
						},
					);
				}

				const prevTasks = deps.tasksRepo.listByBatchId(prevBatch.id);
				const unlanded = prevTasks.filter((t) => !isTaskFinishedOrLanded(t));
				if (unlanded.length > 0) {
					throw new AppError(
						'E_VALIDATION',
						`All tasks in previous batch ${prevBatch.batch_no} must be landed before starting batch ${batch.batch_no} (E-49, E-281)`,
						{
							details: {
								previousBatchState: prevBatch.state,
								unlandedTaskKeys: unlanded.map((t) => t.task_key),
							},
						},
					);
				}
			}
		}

		await effectiveBatchService.transitionBatch(batchId, 'running', 'batch_start');

		const batchTasks = deps.tasksRepo.listByBatchId(batchId);
		if (gateOverrides && Object.keys(gateOverrides).length > 0) {
			batchGateOverridesMap.set(batchId, Object.freeze({ ...gateOverrides }));
		}
		const activeRunTaskIds = new Set(runsRepo.listActive().map((r) => r.task_id));
		const queuedCount = batchTasks.filter(
			(t) =>
				!isTaskFinishedOrLanded(t) && !activeRunTaskIds.has(t.id) && t.is_removed_from_doc === 0,
		).length;

		void tick();

		return {
			accepted: true,
			queued: queuedCount,
		};
	}

	async function pauseBatch(input: PauseBatchInput): Promise<PauseBatchResponse> {
		const { batchId } = input;
		if (!batchId || typeof batchId !== 'string' || batchId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'batchId must be a non-empty string');
		}

		const batch = deps.batchesRepo.findById(batchId);
		if (!batch) {
			throw new AppError('E_NOT_FOUND', `Batch not found: ${batchId}`, {
				details: { batchId },
			});
		}

		await effectiveBatchService.transitionBatch(batchId, 'paused', 'batch_pause');

		return { paused: true };
	}

	async function getRun(runId: string): Promise<RunDto> {
		if (!runId || typeof runId !== 'string' || runId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'runId must be a non-empty string');
		}
		const run = runsRepo.findById(runId);
		if (!run) {
			throw new AppError('E_NOT_FOUND', `Run not found: ${runId}`, {
				details: { runId },
			});
		}
		const followedMap = run.snapshot_id ? buildFollowedTaskIdMap([run.snapshot_id]) : undefined;
		return toRunDtoWithInHeadWarning(run, followedMap);
	}

	async function listRuns(): Promise<readonly RunDto[]> {
		const runs = runsRepo.listAll();
		const snapshotIds = new Set(
			runs.map((r) => r.snapshot_id).filter((id): id is string => Boolean(id)),
		);
		const followedMap = buildFollowedTaskIdMap(snapshotIds);
		return runs.map((r) => toRunDtoWithInHeadWarning(r, followedMap));
	}

	async function getSnapshot(docId?: string): Promise<SnapshotResponse> {
		const documents = deps.documentsRepo.listAll().map(toDocumentDto);
		const allBatches: BatchDto[] = [];
		const allTasks: TaskDto[] = [];

		const allRunRows = runsRepo.listAll();
		const latestRunByTaskId = new Map<string, RunRow>();
		const runsByTaskId = new Map<string, RunRow[]>();
		for (const r of allRunRows) {
			if (!r.task_id) continue;
			const list = runsByTaskId.get(r.task_id) ?? [];
			list.push(r);
			runsByTaskId.set(r.task_id, list);

			const existing = latestRunByTaskId.get(r.task_id);
			if (!existing || r.attempt_no > existing.attempt_no) {
				latestRunByTaskId.set(r.task_id, r);
			}
		}

		for (const doc of documents) {
			const bRows = deps.batchesRepo.listByDocId(doc.id);
			for (const b of bRows) {
				allBatches.push(toBatchDto(b));
			}
			const tRows = deps.tasksRepo.listByDocId(doc.id);
			for (const t of tRows) {
				const latestRun = latestRunByTaskId.get(t.id);
				const tRuns = runsByTaskId.get(t.id) ?? [];
				allTasks.push(toTaskDto(t, latestRun?.state ?? null, tRuns));
			}
		}

		const snapshotIds = new Set(
			allRunRows.map((r) => r.snapshot_id).filter((id): id is string => Boolean(id)),
		);
		const followedMap = buildFollowedTaskIdMap(snapshotIds);
		const runs = allRunRows.map((r) => toRunDtoWithInHeadWarning(r, followedMap));
		const agents = deps.listAgents ? await deps.listAgents() : [];
		const latestEventId = deps.getLatestEventId ? deps.getLatestEventId() : null;

		const targetDoc = docId
			? documents.find((d) => d.id === docId)
			: (documents.find((d) => d.isSourceReadable) ?? documents[0]);
		const laneCount = targetDoc?.laneCount ?? 2;
		const tasksForLanes = targetDoc
			? deps.tasksRepo.listByDocId(targetDoc.id)
			: documents.flatMap((d) => deps.tasksRepo.listByDocId(d.id));
		const docTaskIds = new Set(tasksForLanes.map((t) => t.id));

		const docBatches =
			targetDoc && deps.batchesRepo ? deps.batchesRepo.listByDocId(targetDoc.id) : [];
		const docBatchIds = new Set(docBatches.map((b) => b.id));
		const activeBatchIds = new Set(
			docBatches
				.filter((b) => b.state === 'running' || b.state === 'awaiting_landing')
				.map((b) => b.id),
		);

		const docRuns = allRunRows.filter(
			(r) =>
				(r.task_id && docTaskIds.has(r.task_id)) || (r.batch_id && docBatchIds.has(r.batch_id)),
		);

		// 与 tick 同一份可派队列；作用域一律按目标文档裁，空 activeBatchIds 也要传（E-317 / E-319）
		const snapshotCandidates = computeDispatchCandidates({
			tasks: tasksForLanes,
			runs: docRuns,
			activeBatchIds,
		});

		const lanes = deps.lanesService
			? deps.lanesService.getLanes(targetDoc?.id)
			: deriveLanes({
					laneCount,
					tasks: tasksForLanes,
					runs: docRuns,
					activeBatchIds,
					candidateTaskIds: snapshotCandidates.eligibleTaskIds,
					blockedCandidates: snapshotCandidates.waitingOnDeps,
				});

		return Object.freeze({
			documents: Object.freeze(documents),
			batches: Object.freeze(allBatches),
			tasks: Object.freeze(allTasks),
			runs: Object.freeze(runs),
			gates: Object.freeze([]),
			agents: Object.freeze(agents),
			lanes: Object.freeze(lanes),
			latestEventId,
		});
	}

	async function tick(): Promise<SchedulerTickResult> {
		if (isTicking) {
			return {
				executed: false,
				reason: 'concurrency_locked',
				batchesAdvanced: Object.freeze([]),
				runsDispatched: Object.freeze([]),
				tasksBlocked: Object.freeze([]),
				tasksDeferred: Object.freeze([]),
			};
		}

		isTicking = true;
		try {
			// Yield to the microtask queue so concurrent tick() calls see isTicking=true
			await Promise.resolve();
			if (deps.getDispatchHalt?.()) {
				return {
					executed: false,
					reason: 'dispatch_halted',
					batchesAdvanced: Object.freeze([]),
					runsDispatched: Object.freeze([]),
					tasksBlocked: Object.freeze([]),
					tasksDeferred: Object.freeze([]),
				};
			}

			const batchesAdvanced: string[] = [];
			const runsDispatched: string[] = [];
			const tasksBlocked: { taskId: string; reason: string }[] = [];
			const tasksDeferred: { taskId: string; reason: string }[] = [];

			// Global Step 1: In-Head refresh (R3: per repo, implement/wrapup only, global limit <= 20, per run >= 30s, sequential git, single tx write back, E-301)
			const nowIsoForRefresh = deps.clock.now();
			const nowMs = Date.parse(nowIsoForRefresh);
			if (Number.isNaN(nowMs)) {
				throw new AppError('E_INTERNAL', 'Injected clock returned an invalid timestamp.', {
					details: { value: nowIsoForRefresh },
				});
			}
			const thirtySecAgo = new Date(nowMs - 30_000).toISOString();
			const unmergedRuns = deps.runsRepo.findLandedNotInHeadRuns?.(20, thirtySecAgo) ?? [];
			const checkInHead = deps.isBranchInHead ?? isBranchInHead;

			const inHeadResults: Array<{
				runId: string;
				isInHead: number;
				tipSha: string | null;
				isError: boolean;
			}> = [];

			for (const r of unmergedRuns) {
				if (!r.branch_name) continue;
				let repoPath: string | null = null;
				if (r.task_id) {
					const task = deps.tasksRepo.findById(r.task_id);
					if (task) {
						const doc = deps.documentsRepo.findById(task.doc_id);
						repoPath = doc?.repo_path ?? null;
					}
				} else if (r.batch_id) {
					const batch = deps.batchesRepo.findById(r.batch_id);
					if (batch) {
						const doc = deps.documentsRepo.findById(batch.doc_id);
						repoPath = doc?.repo_path ?? null;
					}
				}

				if (!repoPath) continue;

				try {
					const checkResult = await checkInHead({
						repoPath,
						branchName: r.branch_name,
						worktreePath: r.worktree_path ?? undefined,
						tipSha: r.branch_tip_sha ?? undefined,
					});

					if (checkResult.method === 'error') {
						const count = (consecutiveInHeadErrors.get(r.id) ?? 0) + 1;
						consecutiveInHeadErrors.set(r.id, count);
						inHeadResults.push({
							runId: r.id,
							isInHead: 0,
							tipSha: checkResult.tipSha ?? r.branch_tip_sha ?? null,
							isError: true,
						});
					} else {
						consecutiveInHeadErrors.delete(r.id);
						inHeadResults.push({
							runId: r.id,
							isInHead: checkResult.inHead ? 1 : 0,
							tipSha: checkResult.tipSha ?? r.branch_tip_sha ?? null,
							isError: false,
						});
					}
				} catch {
					const count = (consecutiveInHeadErrors.get(r.id) ?? 0) + 1;
					consecutiveInHeadErrors.set(r.id, count);
					inHeadResults.push({
						runId: r.id,
						isInHead: 0,
						tipSha: r.branch_tip_sha ?? null,
						isError: true,
					});
				}
			}

			// Single transaction write back (R3)
			if (inHeadResults.length > 0 && deps.runsRepo.updateInHead) {
				const nowIso = deps.clock.now();
				const writeBack = () => {
					for (const item of inHeadResults) {
						deps.runsRepo.updateInHead?.({
							id: item.runId,
							isInHead: item.isInHead,
							checkedAt: nowIso,
							branchTipSha: item.tipSha,
						});
					}
				};

				if (deps.unitOfWork) {
					deps.unitOfWork.run(writeBack);
				} else {
					writeBack();
				}
			}

			const documents = deps.documentsRepo.listAll();

			// R5: 整轮 tick 的槽位分配必须在同一个事务里提交。
			// 某个候选撞唯一索引（lane_no）时，先前文档/候选已经写下的 tasks.lane_no、runs 行、
			// 以及待发事件与待启动列表都必须一起回滚，否则数据库、事件与返回值三者不一致。
			const pendingAssignmentTx: Array<() => void> = [];
			const pendingAssignmentEnvelopes: EventEnvelope[] = [];
			const pendingRunsToLaunch: string[] = [];
			const pendingReworksToDispatch: Array<{
				readonly targetRunId: string;
				readonly reviewRunId?: string | null;
				readonly reworkText: string;
				readonly actorDeviceId?: string | null;
				readonly countAlreadyApplied: true;
			}> = [];

			/**
			 * R5: 把本轮登记的全部槽位分配一次性提交。
			 * 任何一处唯一索引冲突都回滚全部已登记分配，并同步撤销 runsDispatched 里那些根本没提交成功的
			 * run id、丢弃待发事件与待启动列表，保证数据库、事件、返回值三者一致。
			 */
			const commitPendingAssignments = () => {
				if (pendingAssignmentTx.length === 0) {
					return;
				}
				const runsDispatchedBeforeTx = runsDispatched.length;
				let assignmentCommitted = false;
				try {
					const runAllAssignments = () => {
						for (const assign of pendingAssignmentTx) {
							assign();
						}
					};
					if (deps.unitOfWork) {
						deps.unitOfWork.run(runAllAssignments);
					} else {
						runAllAssignments();
					}
					assignmentCommitted = true;
				} catch (err) {
					// 回滚后不得发布任何 lane.assigned / run.state_changed，也不得启动任何进程
					runsDispatched.length = runsDispatchedBeforeTx;
					pendingAssignmentEnvelopes.length = 0;
					pendingRunsToLaunch.length = 0;
					pendingReworksToDispatch.length = 0;
					logFailure(err);
				}

				if (assignmentCommitted) {
					if (deps.bus) {
						for (const env of pendingAssignmentEnvelopes) {
							deps.bus.publish(env);
						}
					}
					for (const runId of pendingRunsToLaunch) {
						void launchRun(runId);
					}
					for (const rw of pendingReworksToDispatch) {
						void deps.reworkService
							?.dispatchRework({
								targetRunId: rw.targetRunId,
								reviewRunId: rw.reviewRunId,
								reworkText: rw.reworkText,
								source: 'human',
								actorDeviceId: rw.actorDeviceId,
								countAlreadyApplied: rw.countAlreadyApplied,
							})
							.then((result) => {
								// #136：补位派出的返工同样不允许假成功——handover 与 undeliverable
								// 都说明没人接住这次投递，记日志并让下一次 tick 再试（实施行留在 reworking）。
								if (result?.mode === 'handover') {
									logFailure(
										new AppError(
											'E_MESSAGE_UNDELIVERED',
											'Queued rework has no session dispatcher.',
											{
												details: { targetRunId: rw.targetRunId },
											},
										),
									);
								} else if (result?.mode === 'undeliverable') {
									logFailure(
										new AppError('E_MESSAGE_UNDELIVERED', result.message, {
											details: {
												targetRunId: result.targetRunId,
												reworkRunId: result.reworkRunId ?? null,
												reason: result.reason,
											},
										}),
									);
								}
							})
							.catch(logFailure);
					}
				}

				pendingAssignmentTx.length = 0;
			};

			for (const doc of documents) {
				if (doc.is_source_readable === 0) {
					continue;
				}

				// Step 2: Batch progression & wrap-up trigger (AC 1, AC 2, E-272, E-283)
				const batches = deps.batchesRepo.listByDocId(doc.id);
				const activeBatches = batches.filter(
					(b) => b.state === 'running' || b.state === 'awaiting_landing',
				);

				for (const batch of activeBatches) {
					const tasks = deps.tasksRepo.listByBatchId(batch.id);
					if (tasks.length === 0) continue;

					// 与 triggerWrapup() / getBatch() 共用同一把尺子（domain/batch-landing.ts）：
					// 只看 kind='implement' 的最大 attempt，manual_state='landed' 算已验收。
					const landing = summarizeBatchLanding(tasks, runsRepo.listAll());

					if (landing.allLanded) {
						// 上一轮收口派出的修复运行是否都已落地（M7-T9 R3）
						const latestWrapupRecord = deps.batchWrapupsRepo?.findLatestByBatchId(batch.id);
						let fixRunsLanded = true;
						if (latestWrapupRecord) {
							let fixRunIds: string[] = [];
							try {
								fixRunIds = JSON.parse(latestWrapupRecord.fix_run_ids_json || '[]');
							} catch {
								fixRunIds = [];
							}
							for (const fixId of fixRunIds) {
								const fixRun = runsRepo.findById(fixId);
								if (!fixRun || fixRun.state !== 'landed') {
									fixRunsLanded = false;
									break;
								}
							}
						}

						if (fixRunsLanded) {
							// 上一轮收口运行本身是否已进 HEAD（M7-T9 R3）
							const latestWrapupRun = deps.runsRepo.findLatestWrapupByBatchId?.(batch.id);
							const prevWrapupInHead = !latestWrapupRun || latestWrapupRun.is_in_head === 1;

							if (landing.notInHeadCount > 0 || !prevWrapupInHead) {
								// E-272 & R3: 全部 landed 但有未进 HEAD -> awaiting_landing
								if (batch.state === 'running') {
									await effectiveBatchService.transitionBatch(
										batch.id,
										'awaiting_landing',
										'waiting_for_branches_in_head',
									);
									batchesAdvanced.push(batch.id);
								}
								continue;
							}

							// 全部进 HEAD (notInHeadCount === 0 && prevWrapupInHead)
							// AC 6 & E-312 / E-318: 统一走严格 parsePipelineSettings，损坏行告警后回落默认
							let wrapupMode: 'auto' | 'manual' = 'auto';
							if (deps.settingsRepo) {
								const pRow = deps.settingsRepo.get('pipeline');
								const pipelineSettings = parsePipelineSettings(pRow?.value_json, (msg) => {
									logFailure(msg);
								});
								wrapupMode = pipelineSettings.wrapupMode;
							}

							if (wrapupMode === 'manual') {
								continue;
							}

							const activeWrapup = deps.runsRepo.findActiveWrapupByBatchId?.(batch.id);
							const latestWrapup = deps.runsRepo.findLatestWrapupByBatchId?.(batch.id);
							const currentRound = deps.batchWrapupsRepo
								? deps.batchWrapupsRepo.getMaxRound(batch.id)
								: (latestWrapup?.attempt_no ?? 0);

							if (!activeWrapup && currentRound < 2 && deps.wrapupService) {
								// 自动派收口运行，且本 tick 不再派发 (AC 1, E-283)
								try {
									const wrapupResult = await deps.wrapupService.triggerWrapup({
										batchId: batch.id,
										trigger: 'auto',
									});
									runsDispatched.push(wrapupResult.run.id);
									batchesAdvanced.push(batch.id);
									// 本 tick 到此为止：先落盘前面文档已登记的槽位分配，再返回
									commitPendingAssignments();
									return {
										executed: true,
										batchesAdvanced: Object.freeze(batchesAdvanced),
										runsDispatched: Object.freeze(runsDispatched),
										tasksBlocked: Object.freeze(tasksBlocked),
										tasksDeferred: Object.freeze(tasksDeferred),
									};
								} catch (error) {
									// 触发失败（条件不满足 / agent 不可用 → 批次已转 needs_attention）：记日志，不吞掉
									logFailure(error);
								}
							}

							if (!deps.wrapupService && !activeWrapup) {
								// Fallback if wrapupService not wired
								await effectiveBatchService.transitionBatch(
									batch.id,
									'done',
									'all_landed_and_in_head',
								);
								batchesAdvanced.push(batch.id);
							}
						} else {
							// 上一轮修复运行仍在飞 -> 批次回到 running 等它们落地
							if (batch.state === 'awaiting_landing') {
								await effectiveBatchService.transitionBatch(
									batch.id,
									'running',
									'fix_runs_pending',
								);
								batchesAdvanced.push(batch.id);
							}
						}
					} else if (batch.state === 'awaiting_landing') {
						// A task reopened or reworked -> return to running (E-59, E-121)
						await effectiveBatchService.transitionBatch(batch.id, 'running', 'task_reopened');
						batchesAdvanced.push(batch.id);
					}
				}

				// Step 3: 按槽位补位 (AC 2, AC 3, E-309, E-310, E-311, E-327)
				const docTasks = deps.tasksRepo.listByDocId(doc.id);
				const allRuns = runsRepo.listAll();
				const activeRuns = runsRepo.listActive();
				const docBatches = deps.batchesRepo ? deps.batchesRepo.listByDocId(doc.id) : batches;
				const docBatchIds = new Set(docBatches.map((b) => b.id));
				const docTaskIds = new Set(docTasks.map((t) => t.id));
				const docRuns = allRuns.filter((r) => {
					if (r.task_id) return docTaskIds.has(r.task_id);
					if (r.batch_id) return docBatchIds.has(r.batch_id);
					return false;
				});

				const occupiedLanes = new Set<number>();
				for (const t of docTasks) {
					if (typeof t.lane_no === 'number' && t.lane_no >= 1) {
						occupiedLanes.add(t.lane_no);
					}
				}
				for (const r of docRuns) {
					if (
						r.kind === 'wrapup' &&
						typeof r.lane_no === 'number' &&
						r.lane_no >= 1 &&
						!isTerminalRunState(r.state as RunState) &&
						r.state !== 'awaiting_human' &&
						r.state !== 'orphaned'
					) {
						occupiedLanes.add(r.lane_no);
					}
				}

				const free = freeLaneNumbers(doc.lane_count, occupiedLanes);

				// AC 6 & E-312 & E-283: 收口运行有空槽即持槽，无空槽 queued_reason='lane_full' 由 tick 先于新任务分槽
				const queuedWrapups = docRuns.filter((r) => r.kind === 'wrapup' && r.state === 'queued');

				for (const wRun of queuedWrapups) {
					if (!wRun.batch_id) continue;

					// If wrapup has no lane, allocate from free if available
					if (wRun.lane_no === null || wRun.lane_no === undefined) {
						const allocatedLaneNo = free.shift();
						if (allocatedLaneNo === undefined) {
							continue;
						}
						occupiedLanes.add(allocatedLaneNo);
						if (deps.unitOfWork) {
							deps.unitOfWork.run(() => {
								runsRepo.updateLaneNo?.(wRun.id, allocatedLaneNo);
								runsRepo.updateState({
									id: wRun.id,
									state: 'queued',
									queuedReason: null,
								});
							});
						} else {
							runsRepo.updateLaneNo?.(wRun.id, allocatedLaneNo);
							runsRepo.updateState({
								id: wRun.id,
								state: 'queued',
								queuedReason: null,
							});
						}

						if (deps.bus && deps.envelopeFactory) {
							deps.bus.publish(
								deps.envelopeFactory.createEnvelope({
									kind: 'lane.assigned',
									payload: {
										docId: doc.id,
										laneNo: allocatedLaneNo,
										taskId: null,
										runId: wRun.id,
									},
								}),
							);
						}
					}

					// Check batch (at most 1 active starting/running wrapup per batch)
					const activeWrapup = deps.runsRepo.findActiveWrapupByBatchId?.(wRun.batch_id);
					if (
						activeWrapup &&
						activeWrapup.id !== wRun.id &&
						(activeWrapup.state === 'starting' || activeWrapup.state === 'running')
					) {
						continue;
					}

					// Check agent capacity (E-283)
					const agentLimit = agentLimitFor(wRun.agent_id);
					const activeRunsForAgent = countActiveRunsForAgent(
						allRuns
							.filter(
								(r) =>
									r.agent_id === wRun.agent_id &&
									r.id !== wRun.id &&
									countsTowardAgentConcurrency(r.state as RunState),
							)
							.map((r) => r.state),
					);

					if (activeRunsForAgent < agentLimit) {
						if (deps.unitOfWork) {
							deps.unitOfWork.run(() => {
								runsRepo.updateState({
									id: wRun.id,
									state: 'starting',
									queuedReason: null,
								});
							});
						} else {
							runsRepo.updateState({
								id: wRun.id,
								state: 'starting',
								queuedReason: null,
							});
						}

						if (deps.bus && deps.envelopeFactory) {
							deps.bus.publish(
								deps.envelopeFactory.createEnvelope({
									kind: 'run.state_changed',
									runId: wRun.id,
									taskId: null,
									payload: {
										from: 'queued',
										to: 'starting',
										reason: 'dispatched',
									},
								}),
							);
						}

						runsDispatched.push(wRun.id);
						void launchRun(wRun.id);
					}
				}

				// 已排队任务运行出队（收口修复 / 撤回，M7-T9 R1）：泳道优先于返工与新任务
				const queuedTaskRuns = docRuns.filter(
					(r) => r.state === 'queued' && r.task_id !== null && r.kind !== 'wrapup',
				);

				for (const queuedRun of queuedTaskRuns) {
					const qTaskId = queuedRun.task_id as string;
					const qTask = docTasks.find((t) => t.id === qTaskId);
					if (!qTask) continue;

					if (!isAgentDispatchable(queuedRun.agent_id)) {
						tasksBlocked.push({
							taskId: qTaskId,
							reason: 'agent_unavailable',
						});
						continue;
					}

					// 1. 串行约束（E-280 / M7-T9 R1）
					const parsedSerial = parseWrapupFixSerialReason(queuedRun.queued_reason);
					if (parsedSerial) {
						const blocker = runsRepo.findById(parsedSerial.runId);
						if (!blocker || blocker.state !== 'landed') {
							continue;
						}
					}

					if (queuedRun.spawned_by_run_id) {
						const priorFixHolding = activeRuns.some(
							(other) =>
								other.id !== queuedRun.id &&
								other.spawned_by_run_id === queuedRun.spawned_by_run_id &&
								other.state !== 'queued' &&
								other.state !== 'landed' &&
								!(TERMINAL_RUN_STATES as readonly string[]).includes(other.state),
						);
						if (priorFixHolding) {
							continue;
						}
					}

					// 2. 路径冲突检查（E-46）
					let qPaths: string[] = [];
					try {
						qPaths = JSON.parse(qTask.task_paths_json ?? '[]');
					} catch {
						qPaths = [];
					}
					const queuedDesc: TaskPathDescriptor = {
						taskId: qTask.id,
						taskKey: qTask.task_key,
						taskPaths: Object.freeze(qPaths),
						batchId: qTask.batch_id ?? undefined,
						state: 'queued',
						runId: queuedRun.id,
					};
					let hasClash = false;
					for (const holding of activeRuns) {
						if (holding.id === queuedRun.id || holding.state === 'queued') continue;
						if (!holding.task_id || !isTaskPathHolding(holding.state)) continue;
						const hTask = deps.tasksRepo.findById(holding.task_id);
						let hPaths: string[] = [];
						try {
							hPaths = JSON.parse(hTask?.task_paths_json ?? '[]');
						} catch {
							hPaths = [];
						}
						const clashRes = checkTaskPathClash(
							{
								taskId: holding.task_id,
								taskKey: hTask?.task_key,
								taskPaths: Object.freeze(hPaths),
								runId: holding.id,
							},
							queuedDesc,
							{ sameBatchOnly: false },
						);
						if (clashRes.hasClash) {
							hasClash = true;
							tasksBlocked.push({
								taskId: qTaskId,
								reason: clashRes.queuedReason ?? 'path_clash',
							});
							break;
						}
					}
					if (hasClash) {
						continue;
					}

					// 3. 泳道：已占槽直接出队，否则取一个空槽（E-309 / E-310 / E-326）
					let laneNo =
						typeof qTask.lane_no === 'number' && qTask.lane_no >= 1 ? qTask.lane_no : null;
					if (laneNo === null) {
						const allocatedLaneNo = free.shift();
						if (allocatedLaneNo === undefined) {
							tasksDeferred.push({
								taskId: qTaskId,
								reason: 'lane_full',
							});
							continue;
						}
						laneNo = allocatedLaneNo;
						occupiedLanes.add(allocatedLaneNo);
					}

					// 4. 每 agent 并发上限（E-54）
					const queuedAgentLimit = agentLimitFor(queuedRun.agent_id);
					const queuedAgentActive = countAgentConcurrency(
						allRuns.filter((r) => r.id !== queuedRun.id),
						queuedRun.agent_id,
					);
					if (queuedAgentActive >= queuedAgentLimit) {
						tasksDeferred.push({
							taskId: qTaskId,
							reason: 'agent_concurrency_limit_reached',
						});
						continue;
					}

					const persistDequeue = () => {
						deps.tasksRepo.assignLaneNo(qTaskId, laneNo as number);
						runsRepo.updateLaneNo?.(queuedRun.id, laneNo as number);
						runsRepo.updateState({
							id: queuedRun.id,
							state: 'starting',
							queuedReason: null,
						});
					};
					if (deps.unitOfWork) {
						deps.unitOfWork.run(persistDequeue);
					} else {
						persistDequeue();
					}

					if (deps.bus && deps.envelopeFactory) {
						deps.bus.publish(
							deps.envelopeFactory.createEnvelope({
								kind: 'lane.assigned',
								payload: {
									docId: doc.id,
									laneNo: laneNo as number,
									taskId: qTaskId,
									runId: queuedRun.id,
								},
							}),
						);
					}

					runsDispatched.push(queuedRun.id);
					void launchRun(queuedRun.id);
				}

				if (free.length === 0) {
					continue;
				}

				const activeBatchesInDoc = docBatches.filter(
					(b) => b.state === 'running' || b.state === 'awaiting_landing',
				);
				const activeBatchIdSetForRework = new Set(activeBatchesInDoc.map((b) => b.id));

				// 打回后等泳道的返工排在全部新任务之前（按打回时间先后，E-327）。
				// 批次暂停/未激活时不入道：停靠中的返工不得占本文档的泳道（E-326 / E-327）。
				const reworkTasks: Array<{ readonly task: TaskRow; readonly run: RunRow }> = [];
				for (const t of docTasks) {
					if (t.lane_no !== null && t.lane_no !== undefined) continue;
					if (!t.batch_id || !activeBatchIdSetForRework.has(t.batch_id)) continue;
					const tRuns = docRuns.filter((r) => r.task_id === t.id && r.kind === 'implement');
					if (tRuns.length === 0) continue;
					const latestImpl = tRuns.reduce((prev, curr) =>
						curr.attempt_no > prev.attempt_no ? curr : prev,
					);
					if (latestImpl.state === 'reworking') {
						reworkTasks.push({ task: t, run: latestImpl });
					}
				}
				reworkTasks.sort((a, b) => {
					const timeA = a.run.started_at ?? a.run.last_event_at ?? '';
					const timeB = b.run.started_at ?? b.run.last_event_at ?? '';
					return timeA.localeCompare(timeB);
				});

				// 可派队列只由 domain/dispatch-candidates.ts 判一次：tick 与泳道快照共用同一份（E-319 / E-326）
				const activeBatchIdsInDoc = new Set(activeBatchesInDoc.map((b) => b.id));
				const dispatchCandidates = computeDispatchCandidates({
					tasks: docTasks,
					runs: allRuns,
					activeBatchIds: activeBatchIdsInDoc,
					excludeTaskIds: reworkTasks.map((rw) => rw.task.id),
				});
				for (const blockedItem of dispatchCandidates.blocked) {
					tasksBlocked.push({
						taskId: blockedItem.taskId,
						reason: blockedItem.reason,
					});
				}
				const eligibleTaskIdSet = new Set(dispatchCandidates.eligibleTaskIds);
				const candidateTasks: TaskRow[] = docTasks.filter((t) => eligibleTaskIdSet.has(t.id));

				if (candidateTasks.length === 0 && reworkTasks.length === 0) {
					continue;
				}

				const candidateDescriptors = candidateTasks.map((t) => {
					let taskPaths: string[] = [];
					try {
						taskPaths = JSON.parse(t.task_paths_json ?? '[]');
					} catch {
						taskPaths = [];
					}
					return {
						taskId: t.id,
						taskKey: t.task_key,
						taskPaths: Object.freeze(taskPaths),
						batchId: t.batch_id ?? undefined,
					};
				});

				const activeDescriptors = activeRuns
					.filter((r) => r.task_id !== null)
					.map((r) => {
						const taskId = r.task_id as string;
						const task = deps.tasksRepo.findById(taskId);
						let taskPaths: string[] = [];
						if (task?.task_paths_json) {
							try {
								taskPaths = JSON.parse(task.task_paths_json);
							} catch {
								taskPaths = [];
							}
						}
						return {
							taskId,
							taskKey: task?.task_key ?? taskId,
							taskPaths: Object.freeze(taskPaths),
							batchId: task?.batch_id ?? undefined,
							state: r.state,
							runId: r.id,
						};
					});

				const pathClashResult = evaluatePathClashQueue({
					candidates: candidateDescriptors,
					activeTasks: activeDescriptors,
					batchId: candidateDescriptors[0]?.batchId,
				});

				for (const blocked of pathClashResult.blocked) {
					tasksBlocked.push({
						taskId: blocked.task.taskId,
						reason: blocked.queuedReason,
					});
				}

				const dispatchableTasks = candidateTasks.filter((t) =>
					pathClashResult.dispatchable.some((d) => d.taskId === t.id),
				);

				dispatchableTasks.sort((a, b) => a.task_key.localeCompare(b.task_key));

				const combinedCandidates: Array<{
					readonly task: TaskRow;
					readonly isRework: boolean;
					readonly reworkRun?: RunRow;
				}> = [
					...reworkTasks.map((rw) => ({ task: rw.task, isRework: true, reworkRun: rw.run })),
					...dispatchableTasks.map((t) => ({ task: t, isRework: false })),
				];

				const assigned: Array<{
					readonly candidate: (typeof combinedCandidates)[number];
					readonly agentId: string;
					readonly draft: StoredAssignmentDraft | null;
				}> = [];
				for (const item of combinedCandidates) {
					const agentId = item.isRework
						? (item.reworkRun?.agent_id ?? null)
						: resolveAgentForTask(item.task);

					if (!agentId || !isAgentDispatchable(agentId)) {
						tasksBlocked.push({
							taskId: item.task.id,
							reason: 'agent_unavailable',
						});
						continue;
					}
					const draft = parseAssignmentDraft(item.task.assignment_draft_json);
					assigned.push({
						candidate: item,
						agentId,
						draft,
					});
				}

				const candidatesForAllocation = assigned.map((a) => ({
					id: a.candidate.task.id,
					agentId: a.agentId,
					item: a,
				}));

				// E-327：被返工的那条实施运行此刻进程已死（进程还活着时走回灌，不进补位队列），
				// 它不该再给这个 agent 记一个名额——返工是替换它，不是与它并排。不排除的话，
				// agent 上限为 1（默认注册表就是 1）时补位队列里的返工永远拿不到名额。
				const supersededReworkRunIds = new Set<string>();
				for (const candidate of combinedCandidates) {
					if (candidate.isRework && candidate.reworkRun) {
						supersededReworkRunIds.add(candidate.reworkRun.id);
					}
				}

				const allocation = allocateConcurrencySlots({
					candidates: candidatesForAllocation,
					availableSlots: free.length,
					agentLimits: (agentId: string) => agentLimitFor(agentId),
					activeRunsByAgent: (agentId: string) =>
						countAgentConcurrency(
							allRuns.filter((run) => !supersededReworkRunIds.has(run.id)),
							agentId,
						),
				});

				for (const deferred of allocation.deferred) {
					tasksDeferred.push({
						taskId: deferred.task.id,
						reason: deferred.reason,
					});
				}

				const admitted = allocation.admitted.map((a) => a.item);

				// R5: 分配动作只登记，不在这里提交——整轮 tick 的分配统一在文档循环之后一次性提交。
				const pendingEnvelopes = pendingAssignmentEnvelopes;
				const runsToLaunch = pendingRunsToLaunch;
				const reworksToDispatch = pendingReworksToDispatch;

				const assignAllInTx = () => {
					for (let i = 0; i < admitted.length; i++) {
						const allocatedLaneNo = free[i];
						if (allocatedLaneNo === undefined) break;

						const item = admitted[i];
						if (!item) continue;
						const candidate = item.candidate;

						if (candidate.isRework && candidate.reworkRun) {
							const reworkRun = candidate.reworkRun;
							const changes = deps.tasksRepo.assignLaneNo?.(candidate.task.id, allocatedLaneNo);
							if (changes === 0) {
								continue;
							}
							runsRepo.updateLaneNo?.(reworkRun.id, allocatedLaneNo);

							if (deps.envelopeFactory) {
								pendingEnvelopes.push(
									deps.envelopeFactory.createEnvelope({
										kind: 'lane.assigned',
										payload: {
											docId: doc.id,
											laneNo: allocatedLaneNo,
											taskId: candidate.task.id,
											runId: reworkRun.id,
										},
									}),
								);
							}

							const rejectedGate =
								deps.gatesRepo?.findLatestByTaskIdAndKind?.(candidate.task.id, 'review') ??
								deps.gatesRepo?.findLatestByTaskIdAndKind?.(candidate.task.id, 'landing');
							const reworkText = rejectedGate?.comment || 'Rework requested';
							reworksToDispatch.push({
								targetRunId: reworkRun.id,
								reviewRunId: rejectedGate?.run_id,
								reworkText,
								actorDeviceId: null,
								countAlreadyApplied: true,
							});
						} else {
							const task = candidate.task;
							const idempotencyKey = `auto_${task.id}_${deps.ids.newId()}`;
							const existingRuns = runsRepo.listByTaskId(task.id);
							const attemptNo = existingRuns.length + 1;
							const runId = deps.ids.newId();

							const changes = deps.tasksRepo.assignLaneNo?.(task.id, allocatedLaneNo);
							if (changes === 0) {
								continue;
							}

							const tickResolved = resolveAssignment({
								stage: 'implement',
								body: {
									agentId: item.agentId,
									model: item.draft?.model ?? null,
									effort: item.draft?.effort ?? null,
								},
								agentDefaults: createAgentDefaultsLookup(deps.agentRegistry),
							});
							const launchSpecJson = JSON.stringify({
								agentId: item.agentId,
								execPath: deps.agentRegistry?.getSnapshot().agents[item.agentId]?.execPath,
								model: tickResolved.modelName ?? null,
								effort: tickResolved.effortTier ?? null,
								permissionTier: 'workspaceWrite',
								baseRef: { kind: 'head' },
								worktreeMode: 'fresh',
							});
							const tickAssignmentSnapshot = {
								agentId: item.agentId,
								modelName: tickResolved.modelName ?? null,
								effortTier: tickResolved.effortTier ?? null,
								effortVendor: tickResolved.effortVendor ?? null,
								source: 'task' as const,
								followedTaskId: null,
								capturedAt: deps.clock.now(),
							};
							const tickAssignmentJson =
								assignmentReader.serializeTaskAssignment(tickAssignmentSnapshot);
							const snapshot = deps.dispatchSnapshotsRepo.takeSnapshotForTask({
								taskId: task.id,
								launchSpecJson,
								createdAt: deps.clock.now(),
								assignmentJson: tickAssignmentJson,
							});

							const runInsert: RunInsertRow = {
								id: runId,
								task_id: task.id,
								attempt_no: attemptNo,
								kind: 'implement',
								parent_run_id: null,
								state: 'starting',
								agent_id: item.agentId,
								model_name: tickResolved.modelName ?? null,
								effort_tier: tickResolved.effortTier ?? null,
								effort_vendor: tickResolved.effortVendor ?? null,
								permission_tier: 'workspaceWrite',
								snapshot_id: snapshot.id,
								assignment_source: tickResolved.source ?? 'task',
								idempotency_key: idempotencyKey,
								actor_device_id: null,
								started_at: deps.clock.now(),
								session_no: nextSessionNoFor(item.agentId),
								lane_no: allocatedLaneNo,
							};

							assertSessionRefFree(
								{ taskId: task.id, vendorSessionRef: undefined },
								{ runsRepo, tasksRepo: deps.tasksRepo },
							);
							runsRepo.insert(runInsert);

							runsDispatched.push(runId);
							runsToLaunch.push(runId);

							if (deps.envelopeFactory) {
								pendingEnvelopes.push(
									deps.envelopeFactory.createEnvelope({
										kind: 'lane.assigned',
										payload: {
											docId: doc.id,
											laneNo: allocatedLaneNo,
											taskId: task.id,
											runId,
										},
									}),
								);
								pendingEnvelopes.push(
									deps.envelopeFactory.createEnvelope({
										kind: 'run.state_changed',
										runId,
										taskId: task.id,
										payload: {
											from: 'none',
											to: 'starting',
											reason: 'dispatched',
										},
									}),
								);
							}
						}
					}
				};

				// 事务边界在文档循环之外（R5）：这里只登记本轮的分配动作。
				pendingAssignmentTx.push(assignAllInTx);
			}

			commitPendingAssignments();

			return {
				executed: true,
				batchesAdvanced: Object.freeze(batchesAdvanced),
				runsDispatched: Object.freeze(runsDispatched),
				tasksBlocked: Object.freeze(tasksBlocked),
				tasksDeferred: Object.freeze(tasksDeferred),
			};
		} finally {
			isTicking = false;
		}
	}

	async function launchRun(runId: string): Promise<void> {
		if (inFlightLaunches.has(runId)) {
			return;
		}
		inFlightLaunches.add(runId);
		try {
			const run = runsRepo.findById(runId);
			if (!run) {
				throw new AppError('E_NOT_FOUND', `Run not found: ${runId}`, {
					details: { runId },
				});
			}

			if (run.state !== 'starting') {
				return;
			}

			if (run.kind === 'wrapup') {
				if (!run.batch_id) {
					throw new AppError('E_VALIDATION', `Wrapup run ${runId} has no associated batch`, {
						details: { runId },
					});
				}
				const batch = deps.batchesRepo.findById(run.batch_id);
				if (!batch) {
					throw new AppError('E_NOT_FOUND', `Batch not found: ${run.batch_id}`, {
						details: { batchId: run.batch_id, runId },
					});
				}
				const doc = deps.documentsRepo.findById(batch.doc_id);
				if (!doc) {
					throw new AppError('E_NOT_FOUND', `Document not found: ${batch.doc_id}`, {
						details: { docId: batch.doc_id, runId },
					});
				}
				if (!isAgentDispatchable(run.agent_id)) {
					if (deps.runService) {
						await deps.runService.transitionState({
							runId,
							targetState: 'failed',
							reason: 'agent_unavailable',
						});
					}
					throw new AppError(
						'E_AGENT_UNAVAILABLE',
						`Agent ${run.agent_id} is not available for dispatch`,
						{
							details: { agentId: run.agent_id, runId },
						},
					);
				}

				if (!deps.proc || !deps.runService) {
					return;
				}

				const adapter = deps.adapters?.[run.agent_id];
				if (!adapter) {
					await deps.runService.transitionState({
						runId,
						targetState: 'failed',
						reason: 'agent_unavailable',
					});
					throw new AppError(
						'E_AGENT_UNAVAILABLE',
						`No adapter configured for agent: ${run.agent_id}`,
						{
							details: { agentId: run.agent_id, runId },
						},
					);
				}

				const worktreePath = run.worktree_path ?? doc.repo_path ?? '';
				// R1: 收口运行必须交付快照里冻结的八段收口提示词，否则 agent 收不到任何指令
				let wrapupPrompt: string | undefined;
				let wrapupLaunchSpecData: {
					model?: string | null;
					effort?: string | null;
					permissionTier?: string;
				} = {};
				if (run.snapshot_id && deps.dispatchSnapshotsRepo) {
					const snap = deps.dispatchSnapshotsRepo.findById(run.snapshot_id);
					wrapupPrompt = snap?.impl_prompt ?? undefined;
					if (snap?.launch_spec_json) {
						try {
							wrapupLaunchSpecData = JSON.parse(snap.launch_spec_json);
						} catch {
							wrapupLaunchSpecData = {};
						}
					}
				}
				if (!wrapupPrompt || wrapupPrompt.trim().length === 0) {
					await deps.runService.transitionState({
						runId,
						targetState: 'failed',
						reason: 'wrapup_prompt_missing',
					});
					throw new AppError(
						'E_VALIDATION',
						`Wrapup run ${runId} has no frozen wrapup prompt in its dispatch snapshot`,
						{ details: { runId, snapshotId: run.snapshot_id } },
					);
				}
				const launchSpec = adapter.buildLaunchSpec({
					runId,
					cwd: worktreePath,
					model: run.model_name ?? wrapupLaunchSpecData.model ?? null,
					effortTier: run.effort_tier ?? wrapupLaunchSpecData.effort ?? null,
					permissionTier: 'workspaceWrite',
					prompt: wrapupPrompt,
					...(run.agent_id === 'codex' ? { mode: 'exec' } : {}),
				});

				let managed: ManagedProcess;
				try {
					managed = deps.proc.spawnManaged(launchSpec);
				} catch (spawnErr) {
					await deps.runService.transitionState({
						runId,
						targetState: 'failed',
						reason: 'spawn_failed',
					});
					throw spawnErr;
				}

				if (managed.isExited) {
					await deps.runService.transitionState({
						runId,
						targetState: 'failed',
						reason: 'premature_exit',
						exitCode: managed.exitResult?.exitCode ?? null,
						exitSignal: managed.exitResult?.signal ? String(managed.exitResult.signal) : null,
					});
					return;
				}

				deps.runService.attachProcess(runId, managed, {
					eventMapper: adapter.mapEvents,
				});

				const latestRun = runsRepo.findById(runId);
				if (latestRun && isTerminalRunState(latestRun.state as RunState)) {
					return;
				}

				await deps.runService.transitionState({
					runId,
					targetState: 'running',
					reason: 'process_spawned',
					pid: managed.pid,
					worktreePath,
					branchName: run.branch_name,
				});
				return;
			}

			if (!run.task_id) {
				throw new AppError('E_VALIDATION', `Run ${runId} has no associated task`, {
					details: { runId },
				});
			}

			const task = deps.tasksRepo.findById(run.task_id);
			if (!task) {
				throw new AppError('E_NOT_FOUND', `Task not found: ${run.task_id}`, {
					details: { taskId: run.task_id, runId },
				});
			}

			const doc = deps.documentsRepo.findById(task.doc_id);
			if (!doc) {
				throw new AppError('E_NOT_FOUND', `Document not found: ${task.doc_id}`, {
					details: { docId: task.doc_id, runId },
				});
			}

			if (!doc.repo_path) {
				throw new AppError('E_VALIDATION', `Document ${doc.id} has no repository path`, {
					details: { docId: doc.id, runId },
				});
			}

			// E-40: 校验 agent 可用性
			if (!isAgentDispatchable(run.agent_id)) {
				if (run.origin === 'rework') {
					failReworkRunStartup(runId, 'agent_unavailable');
				} else if (deps.runService) {
					await deps.runService.transitionState({
						runId,
						targetState: 'failed',
						reason: 'agent_unavailable',
					});
				}
				throw new AppError(
					'E_AGENT_UNAVAILABLE',
					`Agent ${run.agent_id} is not available for dispatch`,
					{
						details: { agentId: run.agent_id, taskId: task.id },
					},
				);
			}

			if (!deps.workspace || !deps.proc || !deps.runService) {
				return;
			}

			let runPrompt = task.impl_prompt ?? undefined;
			let launchSpecData: {
				execPath?: string;
				model?: string | null;
				effort?: string | null;
				permissionTier?: string;
				baseRef?: string | { kind?: string; branchName?: string };
				worktreeMode?: 'fresh' | 'reuse';
				targetWorktreePath?: string;
				preferredBranchName?: string;
			} = {};
			if (run.snapshot_id && deps.dispatchSnapshotsRepo) {
				const snap = deps.dispatchSnapshotsRepo.findById(run.snapshot_id);
				runPrompt = snap?.impl_prompt ?? runPrompt;
				if (snap?.launch_spec_json) {
					try {
						launchSpecData = JSON.parse(snap.launch_spec_json);
					} catch {
						launchSpecData = {};
					}
				}
			}

			// 准备直接上游信息与 Base 解析 (M5-T2, E-70)
			let depKeys: string[] = [];
			try {
				depKeys = JSON.parse(task.deps_json);
			} catch {
				depKeys = [];
			}
			const upstreamTasks: UpstreamTaskInfo[] = depKeys.map((depKey) => {
				const depTask =
					deps.tasksRepo.findByDocAndKey(task.doc_id, depKey) ?? deps.tasksRepo.findById(depKey);
				const key = depTask?.task_key ?? depKey;
				const branchPrefix = doc.branch_prefix ?? 'task/';
				const branchName = `${branchPrefix}${key}`;
				const isLanded = depTask?.manual_state === 'landed';
				return {
					taskId: key,
					branchName,
					isLanded,
				};
			});

			let preparedWorktree: {
				readonly worktreePath: string;
				readonly branchName: string;
				readonly baseRef: string;
			};
			const targetWorktreePath = run.worktree_path ?? launchSpecData.targetWorktreePath;
			const preferredBranchName = run.branch_name ?? launchSpecData.preferredBranchName;
			const effectiveWorktreeMode =
				launchSpecData.worktreeMode ??
				(run.origin === 'wrapup-fix' || targetWorktreePath ? 'reuse' : 'fresh');

			try {
				const baseRefInput =
					typeof launchSpecData.baseRef === 'object' && launchSpecData.baseRef !== null
						? (launchSpecData.baseRef as RunBaseRef)
						: undefined;

				if (effectiveWorktreeMode === 'reuse' && targetWorktreePath) {
					// R2: 自动修复复用收口 worktree，撤回复用原任务 worktree
					if (deps.workspace) {
						preparedWorktree = await deps.workspace.prepareWorktree({
							repoPath: doc.repo_path,
							taskId: task.task_key || task.id,
							branchPrefix: doc.branch_prefix ?? 'task/',
							worktreeMode: 'reuse',
							targetWorktreePath,
							preferredBranchName,
							baseRef: 'HEAD',
						});
					} else {
						preparedWorktree = {
							worktreePath: targetWorktreePath,
							branchName:
								preferredBranchName ?? `${doc.branch_prefix ?? 'task/'}${task.task_key || task.id}`,
							baseRef: 'HEAD',
						};
					}
				} else if (deps.baseSelector) {
					preparedWorktree = await deps.baseSelector.prepareTaskWorkspace({
						repoPath: doc.repo_path,
						taskId: task.task_key || task.id,
						agentId: run.agent_id,
						sessionId: runId,
						upstreamTasks,
						baseRef: baseRefInput,
						worktreeMode: effectiveWorktreeMode,
					});
				} else if (deps.workspace) {
					let resolvedBase = 'HEAD';
					if (upstreamTasks.length > 0 || baseRefInput?.kind === 'upstreamBranch') {
						const defaultSelector = createBaseSelector({
							ids: deps.ids,
							clock: deps.clock,
						});
						const resolution = await defaultSelector.resolveTaskBase({
							repoPath: doc.repo_path,
							taskId: task.task_key || task.id,
							upstreamTasks,
							baseRef: baseRefInput,
						});
						resolvedBase = resolution.resolvedBase;
					}
					preparedWorktree = await deps.workspace.prepareWorktree({
						repoPath: doc.repo_path,
						taskId: task.task_key || task.id,
						branchPrefix: doc.branch_prefix ?? 'task/',
						worktreeMode: effectiveWorktreeMode,
						baseRef: resolvedBase,
					});
				} else {
					return;
				}
			} catch (err) {
				const isUpstreamMissing = err instanceof AppError && err.code === 'E_UPSTREAM_BASE_MISSING';
				const workspaceReason = isUpstreamMissing
					? 'upstream_base_missing'
					: 'workspace_unavailable';
				if (run.origin === 'rework') {
					failReworkRunStartup(runId, workspaceReason);
				} else {
					await deps.runService.transitionState({
						runId,
						targetState: 'failed',
						reason: workspaceReason,
					});
				}
				throw err instanceof AppError
					? err
					: new AppError('E_WORKSPACE_UNAVAILABLE', `Worktree preparation failed: ${String(err)}`, {
							cause: err,
							details: { runId, taskId: task.id },
						});
			}

			const adapter = deps.adapters?.[run.agent_id];
			if (!adapter) {
				if (run.origin === 'rework') {
					failReworkRunStartup(runId, 'agent_unavailable');
				} else {
					await deps.runService.transitionState({
						runId,
						targetState: 'failed',
						reason: 'agent_unavailable',
					});
				}
				throw new AppError(
					'E_AGENT_UNAVAILABLE',
					`No adapter configured for agent: ${run.agent_id}`,
					{
						details: { agentId: run.agent_id, runId },
					},
				);
			}

			const launchSpec = adapter.buildLaunchSpec({
				runId,
				cwd: preparedWorktree.worktreePath,
				execPath: launchSpecData.execPath,
				model: run.model_name ?? launchSpecData.model ?? null,
				effortTier: run.effort_tier ?? launchSpecData.effort ?? null,
				permissionTier: run.permission_tier ?? launchSpecData.permissionTier ?? 'workspaceWrite',
				prompt: runPrompt,
				// A fresh implementation run owns one bidirectional app-server process.
				...(run.agent_id === 'codex'
					? { mode: run.kind === 'implement' && deps.codexSessions ? 'app-server' : 'exec' }
					: {}),
			});

			let managed: ManagedProcess;
			try {
				managed = deps.proc.spawnManaged(launchSpec);
			} catch (spawnErr) {
				if (run.origin === 'rework') {
					failReworkRunStartup(runId, 'spawn_failed');
				} else {
					await deps.runService.transitionState({
						runId,
						targetState: 'failed',
						reason: 'spawn_failed',
					});
				}
				throw spawnErr;
			}

			// E-348 / R3: starting 状态抢先退出必须落定 starting → failed
			if (managed.isExited) {
				const exitCode = managed.exitResult?.exitCode ?? null;
				const exitSignal = managed.exitResult?.signal ? String(managed.exitResult.signal) : null;
				if (run.origin === 'rework') {
					// 返工运行「起来就死」只说明这次投递没成，不是任务失败（#136 / E-302）。
					failReworkRunStartup(runId, 'premature_exit', { exitCode, signal: exitSignal });
				} else {
					await deps.runService.transitionState({
						runId,
						targetState: 'failed',
						reason: 'premature_exit',
						exitCode,
						exitSignal,
					});
				}
				return;
			}

			deps.runService.attachProcess(runId, managed, {
				eventMapper: adapter.mapEvents,
				mapExitResult: (result) => {
					const session = deps.codexSessions?.get(runId);
					if (!session) return result;
					return { ...result, exitCode: session.getTurnExitCode() ?? 1 };
				},
				onExit: async (result) => {
					const isImplementLike =
						run.kind === 'implement' || run.origin === 'rework' || run.origin === 'wrapup-fix';
					if (isImplementLike && result.exitCode === 0 && deps.reviewService) {
						try {
							await deps.reviewService.evaluateMechanicalCheck({ runId });
						} catch (err) {
							logFailure(err);
						}
					}
				},
			});

			const latestRun = deps.runsRepo.findById(runId);
			if (latestRun && isTerminalRunState(latestRun.state as RunState)) {
				return;
			}

			await deps.runService.transitionState({
				runId,
				targetState: 'running',
				reason: 'process_spawned',
				pid: managed.pid,
				worktreePath: preparedWorktree.worktreePath,
				branchName: preparedWorktree.branchName,
			});
			if (run.agent_id === 'codex' && launchSpec.stdinMode === 'pipe' && deps.codexSessions) {
				const session = deps.codexSessions.register(runId, managed);
				try {
					const tier = run.permission_tier ?? launchSpecData.permissionTier ?? 'workspaceWrite';
					if (!isPermissionTier(tier)) {
						throw new AppError('E_VALIDATION', 'Run has an invalid permission tier.');
					}
					const permission = resolvePermissionMapping('codex', tier);
					if (!permission.supported || permission.transport.kind !== 'argv') {
						throw new AppError(
							'E_CAPABILITY_UNSUPPORTED',
							'Codex permission tier has no sandbox mapping.',
						);
					}
					await session.start({
						prompt: runPrompt ?? '',
						model: run.model_name ?? launchSpecData.model,
						sandbox: permission.transport.value as
							| 'read-only'
							| 'workspace-write'
							| 'danger-full-access',
					});
				} catch (error) {
					session.dispose();
					await managed.kill();
					throw error;
				}
			}
		} catch (error) {
			logFailure(error);
			throw error;
		} finally {
			inFlightLaunches.delete(runId);
		}
	}

	function getBatchGateOverrides(batchId: string): BatchGateOverrides | undefined {
		return batchGateOverridesMap.get(batchId);
	}

	function setBatchGateOverrides(batchId: string, overrides: BatchGateOverrides): void {
		batchGateOverridesMap.set(batchId, Object.freeze({ ...overrides }));
	}

	function getInHeadWarning(runId: string): string | null {
		const count = consecutiveInHeadErrors.get(runId) ?? 0;
		return count >= 3 ? '无法判定分支是否已合入' : null;
	}

	function buildFollowedTaskIdMap(snapshotIds: Iterable<string>): Map<string, string | null> {
		const map = new Map<string, string | null>();
		for (const id of snapshotIds) {
			if (!id) continue;
			const followed = assignmentReader.getFollowedTaskId(id);
			map.set(id, followed ?? null);
		}
		return map;
	}

	function toRunDtoWithInHeadWarning(
		row: RunRow,
		followedTaskIdMap?: Map<string, string | null>,
	): RunDto {
		let followedTaskId: string | null = null;
		if (followedTaskIdMap && row.snapshot_id) {
			followedTaskId = followedTaskIdMap.get(row.snapshot_id) ?? null;
		} else if (row.snapshot_id) {
			followedTaskId = assignmentReader.getFollowedTaskId(row.snapshot_id);
		}
		return Object.freeze({
			...toRunDto(row),
			inHeadWarning: getInHeadWarning(row.id),
			followedTaskId: followedTaskId ?? null,
		});
	}

	return Object.freeze({
		createRun,
		rerunRun,
		startBatch,
		pauseBatch,
		getRun,
		listRuns,
		getSnapshot,
		tick,
		launchRun,
		getBatchGateOverrides,
		setBatchGateOverrides,
		getInHeadWarning,
	});
}
