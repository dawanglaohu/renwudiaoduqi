import type {
	BatchDto,
	BatchGateOverrides,
	PauseBatchResponse,
	StartBatchResponse,
} from '@agent-scheduler/shared/api/batches';
import type { DocumentDto } from '@agent-scheduler/shared/api/documents';
import type {
	CreateRunBody,
	RerunRunResponse,
	RunBaseRef,
	RunDto,
} from '@agent-scheduler/shared/api/runs';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { summarizeBatchLanding } from '../domain/batch-landing.ts';
import {
	DEFAULT_AGENT_CONCURRENCY_LIMIT,
	allocateConcurrencySlots,
} from '../domain/concurrency.ts';
import { toEffortColumns } from '../domain/effort-value.ts';
import { evaluatePathClashQueue, isTaskLanded, isTaskPathHolding } from '../domain/path-clash.ts';
import {
	type RunState,
	countsTowardAgentConcurrency,
	isTerminalRunState,
} from '../domain/run-state-machine.ts';
import { isAppError } from '../errors/app-error.ts';
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
import type { TaskRow, TasksRepo } from '../repo/tasks.ts';
import {
	type BaseSelector,
	type UpstreamTaskInfo,
	createBaseSelector,
} from '../workspace/base-select.ts';
import { isBranchInHead } from '../workspace/in-head.ts';
import type { PrepareWorktreeInput, PrepareWorktreeResult } from '../workspace/worktree.ts';
import { type StoredAssignmentDraft, parseAssignmentDraft } from './assignments.ts';
import { type BatchService, createBatchService } from './batch.ts';
import type { EventEnvelopeInput } from './logstore.ts';
import { createRerunService } from './rerun.ts';
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

export function toTaskDto(row: TaskRow): TaskDto {
	let deps: string[] = [];
	try {
		deps = JSON.parse(row.deps_json);
	} catch {
		deps = [];
	}
	return Object.freeze({
		id: row.id,
		docId: row.doc_id,
		taskKey: row.task_key,
		title: row.title,
		moduleKey: row.module_key,
		deps: Object.freeze(deps),
		estDays: row.est_days ?? null,
		batchId: row.batch_id ?? null,
		state: row.manual_state ?? 'pending',
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

export interface DispatchServiceDeps {
	readonly unitOfWork?: UnitOfWork;
	readonly tasksRepo: TasksRepo;
	readonly batchesRepo: BatchesRepo;
	readonly documentsRepo: DocumentsRepo;
	readonly dispatchSnapshotsRepo: DispatchSnapshotsRepo;
	readonly runsRepo: RunsRepo;
	readonly gatesRepo?: GatesRepo;
	readonly batchWrapupsRepo?: BatchWrapupsRepo;
	readonly batchService?: BatchService;
	readonly wrapupService?: WrapupService;
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
	readonly agentLimits?: number | Record<string, number> | ((agentId: string) => number);
	readonly listAgents?: () => Promise<readonly unknown[]> | readonly unknown[];
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
	getSnapshot(): Promise<SnapshotResponse>;
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
		const effortColumns = toEffortColumns(input.effort ?? null);
		const launchSpecJson = JSON.stringify({
			agentId,
			model: input.model ?? null,
			permissionTier: input.permissionTier ?? 'workspaceWrite',
			baseRef: input.baseRef ?? { kind: 'head' },
			worktreeMode: input.worktreeMode ?? 'fresh',
		});

		const existingRuns = runsRepo.listByTaskId(taskId);
		const attemptNo = existingRuns.length + 1;
		const runId = deps.ids.newId();

		const persist = (): { readonly snapshotId: string } => {
			const snapshot = deps.dispatchSnapshotsRepo.takeSnapshotForTask({
				taskId,
				launchSpecJson,
				createdAt: now,
			});
			const runInsert: RunInsertRow = {
				id: runId,
				task_id: taskId,
				attempt_no: attemptNo,
				kind: input.kind ?? 'implement',
				parent_run_id: input.parentRunId ?? null,
				state: 'starting',
				agent_id: agentId,
				model_name: input.model ?? null,
				effort_tier: effortColumns.effort_tier,
				effort_vendor: effortColumns.effort_vendor,
				permission_tier: input.permissionTier ?? 'workspaceWrite',
				snapshot_id: snapshot.id,
				idempotency_key: idempotencyKey,
				actor_device_id: input.actorDeviceId ?? null,
				started_at: now,
				session_no: nextSessionNoFor(agentId),
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
					model: input.model ?? null,
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
		return toRunDtoWithInHeadWarning(run);
	}

	async function listRuns(): Promise<readonly RunDto[]> {
		const runs = runsRepo.listAll();
		return runs.map(toRunDtoWithInHeadWarning);
	}

	async function getSnapshot(): Promise<SnapshotResponse> {
		const documents = deps.documentsRepo.listAll().map(toDocumentDto);
		const allBatches: BatchDto[] = [];
		const allTasks: TaskDto[] = [];

		for (const doc of documents) {
			const bRows = deps.batchesRepo.listByDocId(doc.id);
			for (const b of bRows) {
				allBatches.push(toBatchDto(b));
			}
			const tRows = deps.tasksRepo.listByDocId(doc.id);
			for (const t of tRows) {
				allTasks.push(toTaskDto(t));
			}
		}

		const runs = runsRepo.listAll().map(toRunDtoWithInHeadWarning);
		const agents = deps.listAgents ? await deps.listAgents() : [];
		const latestEventId = deps.getLatestEventId ? deps.getLatestEventId() : null;

		return Object.freeze({
			documents: Object.freeze(documents),
			batches: Object.freeze(allBatches),
			tasks: Object.freeze(allTasks),
			runs: Object.freeze(runs),
			gates: Object.freeze([]),
			agents: Object.freeze(agents),
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
						if (landing.notInHeadCount > 0) {
							// E-272: 全部 landed 但有未进 HEAD -> awaiting_landing
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

						// 全部进 HEAD (notInHeadCount === 0)
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
							continue;
						}
					} else if (batch.state === 'awaiting_landing') {
						// A task reopened or reworked -> return to running (E-59, E-121)
						await effectiveBatchService.transitionBatch(batch.id, 'running', 'task_reopened');
						batchesAdvanced.push(batch.id);
					}

					if (batch.state !== 'running') {
						continue;
					}

					const taskByKey = new Map<string, TaskRow>();
					for (const t of tasks) {
						taskByKey.set(t.task_key, t);
					}

					const activeRuns = runsRepo.listActive();
					const activeTaskIds = new Set(activeRuns.map((r) => r.task_id));
					const candidateTasks: TaskRow[] = [];
					// 派发候选判定沿用「该任务 attempt 最大的任意运行」（终态即不再自动重派，E-51）
					const latestRunByTaskId = new Map<string, RunRow>();
					for (const r of runsRepo.listAll()) {
						if (!r.task_id) continue;
						const existing = latestRunByTaskId.get(r.task_id);
						if (!existing || r.attempt_no > existing.attempt_no) {
							latestRunByTaskId.set(r.task_id, r);
						}
					}

					for (const t of tasks) {
						if (isTaskFinishedOrLanded(t) || activeTaskIds.has(t.id)) {
							continue;
						}

						const latestRun = latestRunByTaskId.get(t.id);
						if (latestRun && isTerminalRunState(latestRun.state as RunState)) {
							if (
								latestRun.state === 'failed' ||
								latestRun.state === 'interrupted' ||
								latestRun.state === 'orphaned' ||
								latestRun.state === 'aborted'
							) {
								continue;
							}
						}

						let depsSatisfied = true;
						let depKeys: string[] = [];
						try {
							depKeys = JSON.parse(t.deps_json);
						} catch {
							depKeys = [];
						}

						for (const depKey of depKeys) {
							const depTask = taskByKey.get(depKey);
							if (!depTask || !isTaskFinishedOrLanded(depTask)) {
								depsSatisfied = false;
								break;
							}
						}

						if (!depsSatisfied) {
							continue;
						}

						if (t.is_contract_ready !== 1) {
							tasksBlocked.push({
								taskId: t.id,
								reason: 'contract_not_ready',
							});
							continue;
						}

						if (t.has_accept_changed === 1 || t.has_prompt_changed === 1) {
							tasksBlocked.push({
								taskId: t.id,
								reason: 'doc_changed_pending_confirmation',
							});
							continue;
						}

						candidateTasks.push(t);
					}

					if (candidateTasks.length === 0) {
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
							batchId: batch.id,
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
						batchId: batch.id,
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

					if (dispatchableTasks.length === 0) {
						continue;
					}

					const assigned: Array<{
						readonly task: TaskRow;
						readonly agentId: string;
						readonly draft: StoredAssignmentDraft | null;
					}> = [];
					for (const t of dispatchableTasks) {
						const agentId = resolveAgentForTask(t);
						if (!agentId || !isAgentDispatchable(agentId)) {
							tasksBlocked.push({
								taskId: t.id,
								reason: 'agent_unavailable',
							});
							continue;
						}
						const draft = parseAssignmentDraft(t.assignment_draft_json);
						assigned.push({
							task: t,
							agentId,
							draft: draft && draft.agentId === agentId ? draft : null,
						});
					}

					if (assigned.length === 0) {
						continue;
					}

					const activeRunCount = activeRuns.filter((r) => isTaskPathHolding(r.state)).length;
					const availableSlots = Math.max(0, doc.lane_count - activeRunCount);
					// 每 agent 并发只数真正占额度的状态（E-54：awaiting_human / orphaned 不计），
					// 与 M8-T11 预览的 `active` 口径一致，否则预览说未满而 tick 仍 defer。
					const activeRunsByAgent: Record<string, number> = {};
					for (const r of activeRuns) {
						if (!countsTowardAgentConcurrency(r.state as RunState)) continue;
						activeRunsByAgent[r.agent_id] = (activeRunsByAgent[r.agent_id] ?? 0) + 1;
					}

					interface SlotCandidate {
						readonly id: string;
						readonly agentId: string;
						readonly task: TaskRow;
						readonly draft: StoredAssignmentDraft | null;
						readonly [key: string]: unknown;
					}

					const slotResult = allocateConcurrencySlots<SlotCandidate>({
						candidates: assigned.map((item) => ({
							id: item.task.id,
							agentId: item.agentId,
							task: item.task,
							draft: item.draft,
						})),
						availableSlots,
						agentLimits: agentLimitFor,
						activeRunsByAgent,
					});

					for (const deferred of slotResult.deferred) {
						tasksDeferred.push({
							taskId: deferred.task.id,
							reason: deferred.reason,
						});
					}

					for (const item of slotResult.admitted) {
						const task = item.task;
						const idempotencyKey = `auto_${task.id}_${deps.ids.newId()}`;
						try {
							// The draft's model and effort travel verbatim into the run (AC 5, E-31).
							const runResult = await createRun({
								taskId: task.id,
								agentId: item.agentId,
								model: item.draft?.model ?? null,
								effort: item.draft?.effort ?? null,
								idempotencyKey,
								permissionTier: 'workspaceWrite',
							});
							runsDispatched.push(runResult.run.id);
						} catch (err) {
							tasksBlocked.push({
								taskId: task.id,
								reason: isAppError(err) ? err.code : 'dispatch_failed',
							});
						}
					}
				}
			}

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
						details: { agentId: run.agent_id, taskId: task.id },
					},
				);
			}

			if (!deps.workspace || !deps.proc || !deps.runService) {
				return;
			}

			let launchSpecData: {
				model?: string | null;
				effort?: string | null;
				permissionTier?: string;
				baseRef?: string | { kind?: string; branchName?: string };
				worktreeMode?: 'fresh' | 'reuse';
			} = {};
			if (run.snapshot_id && deps.dispatchSnapshotsRepo) {
				const snap = deps.dispatchSnapshotsRepo.findById(run.snapshot_id);
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
			try {
				const baseRefInput =
					typeof launchSpecData.baseRef === 'object' && launchSpecData.baseRef !== null
						? (launchSpecData.baseRef as RunBaseRef)
						: undefined;

				if (deps.baseSelector) {
					preparedWorktree = await deps.baseSelector.prepareTaskWorkspace({
						repoPath: doc.repo_path,
						taskId: task.task_key || task.id,
						agentId: run.agent_id,
						sessionId: runId,
						upstreamTasks,
						baseRef: baseRefInput,
						worktreeMode: launchSpecData.worktreeMode ?? 'fresh',
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
						worktreeMode: launchSpecData.worktreeMode ?? 'fresh',
						baseRef: resolvedBase,
					});
				} else {
					return;
				}
			} catch (err) {
				const isUpstreamMissing = err instanceof AppError && err.code === 'E_UPSTREAM_BASE_MISSING';
				await deps.runService.transitionState({
					runId,
					targetState: 'failed',
					reason: isUpstreamMissing ? 'upstream_base_missing' : 'workspace_unavailable',
				});
				throw err instanceof AppError
					? err
					: new AppError('E_WORKSPACE_UNAVAILABLE', `Worktree preparation failed: ${String(err)}`, {
							cause: err,
							details: { runId, taskId: task.id },
						});
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

			const launchSpec = adapter.buildLaunchSpec({
				runId,
				cwd: preparedWorktree.worktreePath,
				model: run.model_name ?? launchSpecData.model ?? null,
				effortTier: run.effort_tier ?? launchSpecData.effort ?? null,
				permissionTier: run.permission_tier ?? launchSpecData.permissionTier ?? 'workspaceWrite',
				prompt: undefined,
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

			// E-348 / R3: starting 状态抢先退出必须落定 starting → failed
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

	function toRunDtoWithInHeadWarning(row: RunRow): RunDto {
		return Object.freeze({
			...toRunDto(row),
			inHeadWarning: getInHeadWarning(row.id),
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
