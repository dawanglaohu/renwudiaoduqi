import type {
	BatchDto,
	BatchGateOverrides,
	PauseBatchResponse,
	StartBatchResponse,
} from '@agent-scheduler/shared/api/batches';
import type { DocumentDto } from '@agent-scheduler/shared/api/documents';
import type { CreateRunBody, RerunRunResponse, RunDto } from '@agent-scheduler/shared/api/runs';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { allocateConcurrencySlots } from '../domain/concurrency.ts';
import { evaluatePathClashQueue, isTaskLanded, isTaskPathHolding } from '../domain/path-clash.ts';
import { type RunState, isTerminalRunState } from '../domain/run-state-machine.ts';
import { isAppError } from '../errors/app-error.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { BatchRow, BatchesRepo } from '../repo/batches.ts';
import type { DispatchSnapshotsRepo } from '../repo/dispatch-snapshots.ts';
import type { DocumentRow, DocumentsRepo } from '../repo/documents.ts';
import type { EventSeqRepo } from '../repo/event-seq-repo.ts';
import {
	type RunInsertRow,
	type RunRow,
	type RunsRepo,
	isConstraintConflict,
	toRunDto,
} from '../repo/runs.ts';
import type { TaskRow, TasksRepo } from '../repo/tasks.ts';
import { assertSessionRefFree } from './session-guard.ts';

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

export interface DispatchServiceDeps {
	readonly unitOfWork?: UnitOfWork;
	readonly tasksRepo: TasksRepo;
	readonly batchesRepo: BatchesRepo;
	readonly documentsRepo: DocumentsRepo;
	readonly dispatchSnapshotsRepo: DispatchSnapshotsRepo;
	readonly runsRepo: RunsRepo;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly eventSeqRepo?: EventSeqRepo;
	readonly getDispatchHalt?: () => boolean;
	readonly agentLimits?: number | Record<string, number> | ((agentId: string) => number);
	readonly listAgents?: () => Promise<readonly unknown[]> | readonly unknown[];
	readonly listDispatchableAgents?: () => readonly DispatchableAgent[];
	readonly resolveAgentForTask?: (task: TaskRow) => string | null;
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
}

const DEFAULT_AGENT_CONCURRENCY_LIMIT = 2;

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
	const runsRepo = deps.runsRepo;
	let isTicking = false;

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

	function resolveAgentForTask(task: TaskRow): string | null {
		if (deps.resolveAgentForTask) {
			return deps.resolveAgentForTask(task);
		}
		const available = listDispatchableAgents().find((agent) => agent.canDispatch);
		return available?.agentId ?? null;
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
			return Math.max(1, Math.floor(deps.agentLimits(agentId)));
		}
		if (typeof deps.agentLimits === 'number') {
			return Math.max(1, Math.floor(deps.agentLimits));
		}
		if (deps.agentLimits && typeof deps.agentLimits === 'object') {
			const mapped = deps.agentLimits[agentId];
			if (typeof mapped === 'number') {
				return Math.max(1, Math.floor(mapped));
			}
		}
		const listed = listDispatchableAgents().find((agent) => agent.agentId === agentId);
		if (typeof listed?.concurrencyLimit === 'number') {
			return Math.max(1, Math.floor(listed.concurrencyLimit));
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
		if (activeRun) {
			return {
				run: toRunDto(activeRun),
				isExisting: true,
			};
		}

		const now = deps.clock.now();
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
				permission_tier: input.permissionTier ?? 'workspaceWrite',
				snapshot_id: snapshot.id,
				idempotency_key: idempotencyKey,
				actor_device_id: input.actorDeviceId ?? null,
				started_at: now,
			};
			assertSessionRefFree(
				{ taskId, vendorSessionRef: undefined },
				{ runsRepo, tasksRepo: deps.tasksRepo },
			);
			runsRepo.insert(runInsert);
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

		if (deps.bus && deps.envelopeFactory) {
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
			deps.bus.publish(envelope);
		}

		return {
			run: toRunDto(created),
			isExisting: false,
		};
	}

	async function rerunRun(input: RerunRunInput): Promise<RerunRunResponse> {
		const { runId, idempotencyKey } = input;
		if (!runId || typeof runId !== 'string' || runId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'runId must be a non-empty string');
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
			};
		}

		const previousRun = runsRepo.findById(runId);
		if (!previousRun) {
			throw new AppError('E_NOT_FOUND', `Run not found: ${runId}`, {
				details: { runId },
			});
		}

		const task = deps.tasksRepo.findById(previousRun.task_id);
		if (!task) {
			throw new AppError('E_NOT_FOUND', `Task not found: ${previousRun.task_id}`);
		}

		checkDocumentReadable(task.doc_id);
		checkTaskRemoved(task);
		checkContractReady(task);

		const active = runsRepo.findActiveByTaskId(task.id);
		if (active) {
			return {
				run: toRunDto(active),
			};
		}

		const result = await createRun({
			taskId: task.id,
			agentId: previousRun.agent_id,
			model: previousRun.model_name,
			permissionTier: previousRun.permission_tier as CreateRunBody['permissionTier'],
			idempotencyKey,
			actorDeviceId: input.actorDeviceId ?? null,
			parentRunId: previousRun.id,
			kind: previousRun.kind as 'implement' | 'review',
		});

		return {
			run: result.run,
		};
	}

	async function startBatch(input: StartBatchInput): Promise<StartBatchResponse> {
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

		const now = deps.clock.now();
		const startedAt = batch.started_at ?? now;
		deps.batchesRepo.updateState({
			id: batchId,
			state: 'running',
			started_at: startedAt,
			finished_at: null,
		});

		const batchTasks = deps.tasksRepo.listByBatchId(batchId);
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

		deps.batchesRepo.updateState({
			id: batchId,
			state: 'paused',
			started_at: batch.started_at,
			finished_at: batch.finished_at,
		});

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
		return toRunDto(run);
	}

	async function listRuns(): Promise<readonly RunDto[]> {
		const runs = runsRepo.listAll();
		return runs.map(toRunDto);
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

		const runs = runsRepo.listAll().map(toRunDto);
		const agents = deps.listAgents ? await deps.listAgents() : [];
		const latestEventId = deps.eventSeqRepo?.getWatermark('events') ?? null;

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

			const documents = deps.documentsRepo.listAll();
			for (const doc of documents) {
				if (doc.is_source_readable === 0) {
					continue;
				}

				const batches = deps.batchesRepo.listByDocId(doc.id);
				const runningBatches = batches.filter((b) => b.state === 'running');

				for (const batch of runningBatches) {
					const tasks = deps.tasksRepo.listByBatchId(batch.id);
					if (tasks.length === 0) continue;

					const allLanded = tasks.every((t) => isTaskFinishedOrLanded(t));
					if (allLanded) {
						const now = deps.clock.now();
						deps.batchesRepo.updateState({
							id: batch.id,
							state: 'done',
							started_at: batch.started_at,
							finished_at: now,
						});
						batchesAdvanced.push(batch.id);
						if (deps.bus && deps.envelopeFactory) {
							const env = deps.envelopeFactory.createEnvelope({
								kind: 'batch.advanced',
								payload: {
									batchId: batch.id,
									batchNo: batch.batch_no,
									state: 'done',
								},
							});
							deps.bus.publish(env);
						}
						continue;
					}

					const taskByKey = new Map<string, TaskRow>();
					for (const t of tasks) {
						taskByKey.set(t.task_key, t);
					}

					const allRunsForDoc = runsRepo.listAll();
					const latestRunByTaskId = new Map<string, RunRow>();
					for (const r of allRunsForDoc) {
						const existing = latestRunByTaskId.get(r.task_id);
						if (!existing || r.attempt_no > existing.attempt_no) {
							latestRunByTaskId.set(r.task_id, r);
						}
					}

					const activeRuns = runsRepo.listActive();
					const activeTaskIds = new Set(activeRuns.map((r) => r.task_id));
					const candidateTasks: TaskRow[] = [];

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

					const activeDescriptors = activeRuns.map((r) => {
						const task = deps.tasksRepo.findById(r.task_id);
						let taskPaths: string[] = [];
						if (task?.task_paths_json) {
							try {
								taskPaths = JSON.parse(task.task_paths_json);
							} catch {
								taskPaths = [];
							}
						}
						return {
							taskId: r.task_id,
							taskKey: task?.task_key ?? r.task_id,
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

					const assigned: Array<{ readonly task: TaskRow; readonly agentId: string }> = [];
					for (const t of dispatchableTasks) {
						const agentId = resolveAgentForTask(t);
						if (!agentId || !isAgentDispatchable(agentId)) {
							tasksBlocked.push({
								taskId: t.id,
								reason: 'agent_unavailable',
							});
							continue;
						}
						assigned.push({ task: t, agentId });
					}

					if (assigned.length === 0) {
						continue;
					}

					const activeRunCount = activeRuns.filter((r) => isTaskPathHolding(r.state)).length;
					const availableSlots = Math.max(0, doc.lane_count - activeRunCount);
					const activeRunsByAgent: Record<string, number> = {};
					for (const r of activeRuns) {
						activeRunsByAgent[r.agent_id] = (activeRunsByAgent[r.agent_id] ?? 0) + 1;
					}

					interface SlotCandidate {
						readonly id: string;
						readonly agentId: string;
						readonly task: TaskRow;
						readonly [key: string]: unknown;
					}

					const slotResult = allocateConcurrencySlots<SlotCandidate>({
						candidates: assigned.map((item) => ({
							id: item.task.id,
							agentId: item.agentId,
							task: item.task,
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
							const runResult = await createRun({
								taskId: task.id,
								agentId: item.agentId,
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

	return Object.freeze({
		createRun,
		rerunRun,
		startBatch,
		pauseBatch,
		getRun,
		listRuns,
		getSnapshot,
		tick,
	});
}
