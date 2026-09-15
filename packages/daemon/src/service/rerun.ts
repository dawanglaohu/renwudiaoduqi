import type { RunBaseRef, RunDto } from '@agent-scheduler/shared/api/runs';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { BatchesRepo } from '../repo/batches.ts';
import type { DispatchSnapshotsRepo } from '../repo/dispatch-snapshots.ts';
import type { DocumentRow, DocumentsRepo } from '../repo/documents.ts';
import { type RunInsertRow, type RunsRepo, isConstraintConflict, toRunDto } from '../repo/runs.ts';
import type { TaskRow, TasksRepo } from '../repo/tasks.ts';

export interface RerunRunInput {
	readonly runId: string;
	readonly idempotencyKey: string;
	readonly actorDeviceId?: string | null;
}

export interface RerunRunResponse {
	readonly run: RunDto;
}

export interface RedispatchRunInput {
	readonly taskId: string;
	readonly agentId: string;
	readonly model?: string | null;
	readonly permissionTier?: 'readOnly' | 'workspaceWrite' | 'unrestricted';
	readonly worktreeMode?: 'fresh' | 'reuse';
	readonly baseRef?: RunBaseRef;
	readonly idempotencyKey: string;
	readonly actorDeviceId?: string | null;
}

export interface RedispatchRunResult {
	readonly run: RunDto;
	readonly isExisting: boolean;
}

export interface DispatchableAgent {
	readonly agentId: string;
	readonly canDispatch: boolean;
	readonly concurrencyLimit?: number;
}

export interface BatchAlignmentResult {
	readonly isMisaligned: boolean;
	readonly taskBatchNo: number | null;
	readonly currentMaxBatchNo: number | null;
	readonly message: string | null;
}

export interface HandleModelInvalidInput {
	readonly runId: string;
	readonly agentStderrTail?: string;
	readonly message?: string;
}

export interface RerunServiceDeps {
	readonly unitOfWork?: UnitOfWork;
	readonly runsRepo: RunsRepo;
	readonly tasksRepo: TasksRepo;
	readonly batchesRepo: BatchesRepo;
	readonly documentsRepo: DocumentsRepo;
	readonly dispatchSnapshotsRepo: DispatchSnapshotsRepo;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly isAgentDispatchable?: (agentId: string) => boolean;
	readonly listDispatchableAgents?: () => readonly DispatchableAgent[];
}

export interface RerunService {
	readonly rerunRun: (input: RerunRunInput) => Promise<RerunRunResponse>;
	readonly redispatchRun: (input: RedispatchRunInput) => Promise<RedispatchRunResult>;
	readonly checkDocSnapshotStale: (task: TaskRow) => void;
	readonly checkBatchAlignment: (task: TaskRow) => BatchAlignmentResult;
	readonly handleModelInvalid: (input: HandleModelInvalidInput) => RunDto;
}

/**
 * Checks whether the document snapshot has changed since dispatch using Decision 13 flags (E-180).
 * Throws E_SNAPSHOT_STALE if changed, instructing user to handle on desktop.
 */
export function checkDocSnapshotStale(task: TaskRow): void {
	if (
		task.has_accept_changed === 1 ||
		task.has_prompt_changed === 1 ||
		task.is_removed_from_doc === 1
	) {
		throw new AppError(
			'E_SNAPSHOT_STALE',
			'Document snapshot has changed since dispatch; rerun must be handled on desktop (E-180)',
			{
				details: {
					taskId: task.id,
					hasAcceptChanged: task.has_accept_changed === 1,
					hasPromptChanged: task.has_prompt_changed === 1,
					isRemovedFromDoc: task.is_removed_from_doc === 1,
				},
			},
		);
	}
}

/**
 * Checks whether the task's batch has been surpassed by subsequent batches (E-179).
 * Returns structured misalignment info with human-readable banner message.
 */
export function checkBatchAlignment(task: TaskRow, batchesRepo: BatchesRepo): BatchAlignmentResult {
	if (!task.batch_id) {
		return Object.freeze({
			isMisaligned: false,
			taskBatchNo: null,
			currentMaxBatchNo: null,
			message: null,
		});
	}

	const taskBatch = batchesRepo.findById(task.batch_id);
	if (!taskBatch) {
		return Object.freeze({
			isMisaligned: false,
			taskBatchNo: null,
			currentMaxBatchNo: null,
			message: null,
		});
	}

	const docBatches = batchesRepo.listByDocId(task.doc_id);
	const surpassingBatches = docBatches.filter(
		(b) => b.batch_no > taskBatch.batch_no && b.state !== 'idle',
	);

	if (surpassingBatches.length > 0) {
		const currentMaxBatchNo = Math.max(...surpassingBatches.map((b) => b.batch_no));
		return Object.freeze({
			isMisaligned: true,
			taskBatchNo: taskBatch.batch_no,
			currentMaxBatchNo,
			message: `批次 ${currentMaxBatchNo} 已开始，本条属批次 ${taskBatch.batch_no}`,
		});
	}

	return Object.freeze({
		isMisaligned: false,
		taskBatchNo: taskBatch.batch_no,
		currentMaxBatchNo: null,
		message: null,
	});
}

function resolveConstraintConflict<T>(err: unknown, resolver: () => T | null): T | null {
	if (isConstraintConflict(err)) {
		return resolver();
	}
	return null;
}

export function createRerunService(deps: RerunServiceDeps): RerunService {
	const { runsRepo, tasksRepo, batchesRepo, documentsRepo, clock, ids } = deps;

	function checkDocumentReadable(docId: string): DocumentRow {
		const doc = documentsRepo.findById(docId);
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

	function checkTaskRemoved(task: TaskRow): void {
		if (task.is_removed_from_doc === 1) {
			throw new AppError(
				'E_TASK_REMOVED_FROM_DOC',
				`Task '${task.id}' was removed from document (E-77)`,
				{
					details: { taskId: task.id },
				},
			);
		}
	}

	function checkContractReady(task: TaskRow): void {
		if (task.is_contract_ready === 0) {
			let reasons: readonly string[] = [];
			try {
				reasons = JSON.parse(task.contract_reasons_json || '[]');
			} catch {
				reasons = [task.contract_reasons_json || 'Contract is not ready for dispatch'];
			}
			throw new AppError(
				'E_DOC_CONTRACT_PENDING',
				`Task '${task.id}' contract is not ready for dispatch (E-82)`,
				{
					details: {
						taskId: task.id,
						contractHash: task.contract_hash,
						reasons,
					},
				},
			);
		}
	}

	function isAgentOnline(agentId: string): boolean {
		if (deps.isAgentDispatchable) {
			return deps.isAgentDispatchable(agentId);
		}
		if (deps.listDispatchableAgents) {
			const agents = deps.listDispatchableAgents();
			if (agents.length === 0) {
				return false;
			}
			return agents.some((a) => a.agentId === agentId && a.canDispatch);
		}
		return true;
	}

	/**
	 * Rerun execution (AC 2, E-177):
	 * Strictly reuses the original dispatch payload (task, agent, model, batch, permission_tier, snapshot_id).
	 * Does NOT open any selectors and does NOT create a new snapshot.
	 */
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

		// Idempotency: return existing run if key was already used
		const existingByIdempotency = runsRepo.findByIdempotencyKey(idempotencyKey);
		if (existingByIdempotency) {
			return {
				run: toRunDto(existingByIdempotency),
			};
		}

		// Look up the run being rerun
		const previousRun = runsRepo.findById(runId);
		if (!previousRun) {
			throw new AppError('E_NOT_FOUND', `Run not found: ${runId}`, {
				details: { runId },
			});
		}

		const task = tasksRepo.findById(previousRun.task_id);
		if (!task) {
			throw new AppError('E_NOT_FOUND', `Task not found: ${previousRun.task_id}`, {
				details: { taskId: previousRun.task_id },
			});
		}

		checkDocumentReadable(task.doc_id);

		// AC 4 & E-180: Document snapshot changed blocks rerun and prompts desktop
		checkDocSnapshotStale(task);

		checkTaskRemoved(task);
		checkContractReady(task);

		// AC 2 & E-177: Check if task already has an active run (intercept duplicate run)
		const active = runsRepo.findActiveByTaskId(task.id);
		if (active) {
			return {
				run: toRunDto(active),
			};
		}

		// E-177 / M9-T13: Only terminal runs or awaiting_human with exited_before_output can be rerun
		if (
			previousRun.state === 'starting' ||
			previousRun.state === 'running' ||
			previousRun.state === 'reviewing'
		) {
			return {
				run: toRunDto(previousRun),
			};
		}

		// AC 3 & E-178: Agent must be online; immediately fail and forbid silent fallback
		if (!isAgentOnline(previousRun.agent_id)) {
			throw new AppError(
				'E_AGENT_UNAVAILABLE',
				`Agent '${previousRun.agent_id}' is not online (E-178)`,
				{
					details: {
						agentId: previousRun.agent_id,
						taskId: task.id,
					},
				},
			);
		}

		// AC 5 & E-179: Check batch alignment; allow rerun even if misaligned (warning/banner only)
		const batchAlignment = checkBatchAlignment(task, batchesRepo);
		if (batchAlignment.isMisaligned) {
			// Misalignment recorded; single-user self-use allows execution over blocking
		}

		// AC 6 & E-36: Model name is passed through directly without whitelist checks
		const now = clock.now();
		const existingRuns = runsRepo.listByTaskId(task.id);
		const attemptNo = existingRuns.length + 1;
		const newRunId = ids.newId();

		// AC 2: Strictly reuse original snapshot_id without creating new snapshot or modifying assignment
		const runInsert: RunInsertRow = {
			id: newRunId,
			task_id: task.id,
			attempt_no: attemptNo,
			kind: previousRun.kind,
			parent_run_id: previousRun.id,
			state: 'starting',
			agent_id: previousRun.agent_id,
			model_name: previousRun.model_name ?? null,
			permission_tier: previousRun.permission_tier,
			snapshot_id: previousRun.snapshot_id,
			idempotency_key: idempotencyKey,
			actor_device_id: input.actorDeviceId ?? null,
			started_at: now,
		};

		const persist = (): void => {
			runsRepo.insert(runInsert);
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
				return racedRun ? { run: toRunDto(racedRun) } : null;
			});
			if (racedByKey) {
				return racedByKey;
			}
			const racedByTask = resolveConstraintConflict(err, () => {
				const activeRun = runsRepo.findActiveByTaskId(task.id);
				return activeRun ? { run: toRunDto(activeRun) } : null;
			});
			if (racedByTask) {
				return racedByTask;
			}
			throw err;
		}

		const created = runsRepo.findById(newRunId);
		if (!created) {
			throw new AppError('E_INTERNAL', `Failed to create rerun run: ${newRunId}`);
		}

		if (deps.bus && deps.envelopeFactory) {
			const envelope = deps.envelopeFactory.createEnvelope({
				kind: 'run.state_changed',
				runId: newRunId,
				taskId: task.id,
				actorDeviceId: input.actorDeviceId ?? null,
				payload: {
					from: previousRun.state,
					to: 'starting',
					reason: 'rerun',
					misalignment: batchAlignment.isMisaligned ? batchAlignment.message : undefined,
				},
			});
			deps.bus.publish(envelope);
		}

		return {
			run: toRunDto(created),
		};
	}

	/**
	 * Redispatch with new agent (AC 1, E-121):
	 * Creates a new run record (attempt N+1), retains old run records as read-only,
	 * and defaults to clean worktree ('fresh') unless explicitly chosen to 'reuse'.
	 */
	async function redispatchRun(input: RedispatchRunInput): Promise<RedispatchRunResult> {
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

		const task = tasksRepo.findById(taskId);
		if (!task) {
			throw new AppError('E_NOT_FOUND', `Task not found: ${taskId}`, {
				details: { taskId },
			});
		}

		checkDocumentReadable(task.doc_id);
		checkTaskRemoved(task);
		checkContractReady(task);

		if (!isAgentOnline(agentId)) {
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

		// AC 1 & E-121: default to fresh worktree unless explicitly chosen to reuse
		const worktreeMode = input.worktreeMode === 'reuse' ? 'reuse' : 'fresh';

		// AC 6 & E-36: Do not perform whitelist validation on model name; pass through verbatim
		const now = clock.now();
		const launchSpecJson = JSON.stringify({
			agentId,
			model: input.model ?? null,
			permissionTier: input.permissionTier ?? 'workspaceWrite',
			baseRef: input.baseRef ?? { kind: 'head' },
			worktreeMode,
		});

		// AC 1: Old runs are retained as read-only historical rows; attempt number increments
		const existingRuns = runsRepo.listByTaskId(taskId);
		const attemptNo = existingRuns.length + 1;
		const runId = ids.newId();

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
				kind: 'implement',
				parent_run_id: null,
				state: 'starting',
				agent_id: agentId,
				model_name: input.model ?? null,
				permission_tier: input.permissionTier ?? 'workspaceWrite',
				snapshot_id: snapshot.id,
				idempotency_key: idempotencyKey,
				actor_device_id: input.actorDeviceId ?? null,
				started_at: now,
			};
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
			throw new AppError('E_INTERNAL', `Failed to create redispatch run: ${runId}`);
		}

		if (deps.bus && deps.envelopeFactory) {
			const envelope = deps.envelopeFactory.createEnvelope({
				kind: 'run.state_changed',
				runId,
				taskId,
				actorDeviceId: input.actorDeviceId ?? null,
				payload: {
					from: 'none',
					to: 'starting',
					reason: 'redispatch',
					worktreeMode,
				},
			});
			deps.bus.publish(envelope);
		}

		return {
			run: toRunDto(created),
			isExisting: false,
		};
	}

	/**
	 * Marks a run as failed due to invalid model name (AC 6 & E-36).
	 * Sets queued_reason to '派发失败·模型无效' and releases slot/window capacity.
	 */
	function handleModelInvalid(input: HandleModelInvalidInput): RunDto {
		const run = runsRepo.findById(input.runId);
		if (!run) {
			throw new AppError('E_NOT_FOUND', `Run not found: ${input.runId}`, {
				details: { runId: input.runId },
			});
		}

		const now = clock.now();
		runsRepo.updateState({
			id: run.id,
			state: 'failed',
			queuedReason: '派发失败·模型无效',
			endedAt: now,
		});

		if (deps.bus && deps.envelopeFactory) {
			const envelope = deps.envelopeFactory.createEnvelope({
				kind: 'run.state_changed',
				runId: run.id,
				taskId: run.task_id,
				payload: {
					from: run.state,
					to: 'failed',
					reason: 'model_invalid',
					message: input.message ?? '派发失败·模型无效',
					agentStderrTail: input.agentStderrTail,
				},
			});
			deps.bus.publish(envelope);
		}

		const updated = runsRepo.findById(input.runId);
		return toRunDto(updated ?? run);
	}

	return Object.freeze({
		rerunRun,
		redispatchRun,
		checkDocSnapshotStale,
		checkBatchAlignment: (task: TaskRow) => checkBatchAlignment(task, batchesRepo),
		handleModelInvalid,
	});
}
