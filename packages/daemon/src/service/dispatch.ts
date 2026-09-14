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
import type { DatabaseConnection } from '../db/open-database.ts';
import { toDatabaseError } from '../db/open-database.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { allocateConcurrencySlots } from '../domain/concurrency.ts';
import { evaluatePathClashQueue, isTaskLanded, isTaskPathHolding } from '../domain/path-clash.ts';
import { type RunState, isTerminalRunState } from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { BatchRow, BatchesRepo } from '../repo/batches.ts';
import type { DispatchSnapshotsRepo } from '../repo/dispatch-snapshots.ts';
import type { DocumentRow, DocumentsRepo } from '../repo/documents.ts';
import type { EventSeqRepo } from '../repo/event-seq-repo.ts';
import type { TaskRow, TasksRepo } from '../repo/tasks.ts';

export interface RunRow {
	readonly id: string;
	readonly task_id: string;
	readonly attempt_no: number;
	readonly kind: string;
	readonly parent_run_id: string | null;
	readonly state: string;
	readonly review_verdict: string | null;
	readonly agent_id: string;
	readonly model_name: string | null;
	readonly reported_model: string | null;
	readonly effort_tier: string | null;
	readonly reported_effort: string | null;
	readonly permission_tier: string;
	readonly snapshot_id: string;
	readonly worktree_path: string | null;
	readonly branch_name: string | null;
	readonly pid: number | null;
	readonly exit_code: number | null;
	readonly exit_signal: string | null;
	readonly vendor_session_ref: string | null;
	readonly changed_file_count: number | null;
	readonly token_usage_json: string | null;
	readonly unmapped_event_count: number;
	readonly is_stall_suspected: number;
	readonly rework_count: number;
	readonly queued_reason: string | null;
	readonly idempotency_key: string | null;
	readonly actor_device_id: string | null;
	readonly started_at: string | null;
	readonly last_event_at: string | null;
	readonly ended_at: string | null;
}

export interface RunInsertRow {
	readonly id: string;
	readonly task_id: string;
	readonly attempt_no: number;
	readonly kind: string;
	readonly parent_run_id?: string | null;
	readonly state: string;
	readonly review_verdict?: string | null;
	readonly agent_id: string;
	readonly model_name?: string | null;
	readonly reported_model?: string | null;
	readonly effort_tier?: string | null;
	readonly reported_effort?: string | null;
	readonly permission_tier: string;
	readonly snapshot_id: string;
	readonly worktree_path?: string | null;
	readonly branch_name?: string | null;
	readonly pid?: number | null;
	readonly exit_code?: number | null;
	readonly exit_signal?: string | null;
	readonly vendor_session_ref?: string | null;
	readonly changed_file_count?: number | null;
	readonly token_usage_json?: string | null;
	readonly unmapped_event_count?: number;
	readonly is_stall_suspected?: number;
	readonly rework_count?: number;
	readonly queued_reason?: string | null;
	readonly idempotency_key?: string | null;
	readonly actor_device_id?: string | null;
	readonly started_at?: string | null;
	readonly last_event_at?: string | null;
	readonly ended_at?: string | null;
}

export interface DispatchRunsRepo {
	readonly insert: (row: RunInsertRow) => void;
	readonly findById: (id: string) => RunRow | null;
	readonly findByIdempotencyKey: (key: string) => RunRow | null;
	readonly findActiveByTaskId: (taskId: string) => RunRow | null;
	readonly listByTaskId: (taskId: string) => readonly RunRow[];
	readonly listActive: () => readonly RunRow[];
	readonly listAll: () => readonly RunRow[];
	readonly updateState: (input: {
		readonly id: string;
		readonly state: string;
		readonly queuedReason?: string | null;
		readonly endedAt?: string | null;
	}) => void;
}

const INSERT_RUN_SQL = `
INSERT INTO runs (
	id, task_id, attempt_no, kind, parent_run_id, state, review_verdict,
	agent_id, model_name, reported_model, effort_tier, reported_effort,
	permission_tier, snapshot_id, worktree_path, branch_name, pid,
	exit_code, exit_signal, vendor_session_ref, changed_file_count,
	token_usage_json, unmapped_event_count, is_stall_suspected,
	rework_count, queued_reason, idempotency_key, actor_device_id,
	started_at, last_event_at, ended_at
) VALUES (
	@id, @task_id, @attempt_no, @kind, @parent_run_id, @state, @review_verdict,
	@agent_id, @model_name, @reported_model, @effort_tier, @reported_effort,
	@permission_tier, @snapshot_id, @worktree_path, @branch_name, @pid,
	@exit_code, @exit_signal, @vendor_session_ref, @changed_file_count,
	@token_usage_json, @unmapped_event_count, @is_stall_suspected,
	@rework_count, @queued_reason, @idempotency_key, @actor_device_id,
	@started_at, @last_event_at, @ended_at
)
`;

const SELECT_RUN_BY_ID_SQL = `
SELECT * FROM runs WHERE id = ? LIMIT 1
`;

const SELECT_RUN_BY_IDEMPOTENCY_KEY_SQL = `
SELECT * FROM runs WHERE idempotency_key = ? LIMIT 1
`;

const SELECT_ACTIVE_RUN_BY_TASK_ID_SQL = `
SELECT * FROM runs
WHERE task_id = ? AND state IN ('queued', 'starting', 'running', 'awaiting_reply', 'reviewing', 'reworking', 'awaiting_human')
ORDER BY attempt_no DESC LIMIT 1
`;

const SELECT_RUNS_BY_TASK_ID_SQL = `
SELECT * FROM runs WHERE task_id = ? ORDER BY attempt_no ASC
`;

const SELECT_ACTIVE_RUNS_SQL = `
SELECT * FROM runs
WHERE state IN ('queued', 'starting', 'running', 'awaiting_reply', 'reviewing', 'reworking', 'awaiting_human')
ORDER BY started_at ASC
`;

const SELECT_ALL_RUNS_SQL = `
SELECT * FROM runs ORDER BY started_at DESC
`;

const UPDATE_RUN_STATE_SQL = `
UPDATE runs
SET state = @state,
    queued_reason = @queued_reason,
    ended_at = @ended_at
WHERE id = @id
`;

export function createSqliteDispatchRunsRepo(db: DatabaseConnection): DispatchRunsRepo {
	const insertStmt = db.prepare(INSERT_RUN_SQL);
	const selectByIdStmt = db.prepare(SELECT_RUN_BY_ID_SQL);
	const selectByIdempotencyKeyStmt = db.prepare(SELECT_RUN_BY_IDEMPOTENCY_KEY_SQL);
	const selectActiveByTaskIdStmt = db.prepare(SELECT_ACTIVE_RUN_BY_TASK_ID_SQL);
	const selectByTaskIdStmt = db.prepare(SELECT_RUNS_BY_TASK_ID_SQL);
	const selectActiveStmt = db.prepare(SELECT_ACTIVE_RUNS_SQL);
	const selectAllStmt = db.prepare(SELECT_ALL_RUNS_SQL);
	const updateStateStmt = db.prepare(UPDATE_RUN_STATE_SQL);

	return Object.freeze({
		insert(row: RunInsertRow): void {
			try {
				insertStmt.run({
					id: row.id,
					task_id: row.task_id,
					attempt_no: row.attempt_no,
					kind: row.kind,
					parent_run_id: row.parent_run_id ?? null,
					state: row.state,
					review_verdict: row.review_verdict ?? null,
					agent_id: row.agent_id,
					model_name: row.model_name ?? null,
					reported_model: row.reported_model ?? null,
					effort_tier: row.effort_tier ?? null,
					reported_effort: row.reported_effort ?? null,
					permission_tier: row.permission_tier,
					snapshot_id: row.snapshot_id,
					worktree_path: row.worktree_path ?? null,
					branch_name: row.branch_name ?? null,
					pid: row.pid ?? null,
					exit_code: row.exit_code ?? null,
					exit_signal: row.exit_signal ?? null,
					vendor_session_ref: row.vendor_session_ref ?? null,
					changed_file_count: row.changed_file_count ?? null,
					token_usage_json: row.token_usage_json ?? null,
					unmapped_event_count: row.unmapped_event_count ?? 0,
					is_stall_suspected: row.is_stall_suspected ?? 0,
					rework_count: row.rework_count ?? 0,
					queued_reason: row.queued_reason ?? null,
					idempotency_key: row.idempotency_key ?? null,
					actor_device_id: row.actor_device_id ?? null,
					started_at: row.started_at ?? null,
					last_event_at: row.last_event_at ?? null,
					ended_at: row.ended_at ?? null,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to insert run: id=${row.id}`);
			}
		},

		findById(id: string): RunRow | null {
			try {
				const row = selectByIdStmt.get(id) as RunRow | undefined;
				return row ? Object.freeze({ ...row }) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find run by id: ${id}`);
			}
		},

		findByIdempotencyKey(key: string): RunRow | null {
			try {
				const row = selectByIdempotencyKeyStmt.get(key) as RunRow | undefined;
				return row ? Object.freeze({ ...row }) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find run by idempotency key: ${key}`);
			}
		},

		findActiveByTaskId(taskId: string): RunRow | null {
			try {
				const row = selectActiveByTaskIdStmt.get(taskId) as RunRow | undefined;
				return row ? Object.freeze({ ...row }) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find active run for task: ${taskId}`);
			}
		},

		listByTaskId(taskId: string): readonly RunRow[] {
			try {
				const rows = selectByTaskIdStmt.all(taskId) as RunRow[];
				return Object.freeze(rows.map((r) => Object.freeze({ ...r })));
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to list runs by taskId: ${taskId}`);
			}
		},

		listActive(): readonly RunRow[] {
			try {
				const rows = selectActiveStmt.all() as RunRow[];
				return Object.freeze(rows.map((r) => Object.freeze({ ...r })));
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to list active runs');
			}
		},

		listAll(): readonly RunRow[] {
			try {
				const rows = selectAllStmt.all() as RunRow[];
				return Object.freeze(rows.map((r) => Object.freeze({ ...r })));
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to list all runs');
			}
		},

		updateState(input: {
			readonly id: string;
			readonly state: string;
			readonly queuedReason?: string | null;
			readonly endedAt?: string | null;
		}): void {
			try {
				updateStateStmt.run({
					id: input.id,
					state: input.state,
					queued_reason: input.queuedReason ?? null,
					ended_at: input.endedAt ?? null,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update run state: ${input.id}`);
			}
		},
	});
}

export function toRunDto(row: RunRow): RunDto {
	let tokenUsage: Record<string, unknown> | null = null;
	if (row.token_usage_json) {
		try {
			tokenUsage = JSON.parse(row.token_usage_json);
		} catch {
			tokenUsage = null;
		}
	}

	return Object.freeze({
		id: row.id,
		taskId: row.task_id,
		attemptNo: row.attempt_no,
		kind: row.kind as 'implement' | 'review',
		parentRunId: row.parent_run_id ?? null,
		state: row.state,
		reviewVerdict: (row.review_verdict as RunDto['reviewVerdict']) ?? null,
		agentId: row.agent_id,
		modelName: row.model_name ?? null,
		reportedModel: row.reported_model ?? null,
		effortTier: (row.effort_tier as RunDto['effortTier']) ?? null,
		reportedEffort: row.reported_effort ?? null,
		permissionTier: (row.permission_tier as RunDto['permissionTier']) ?? 'workspaceWrite',
		worktreePath: row.worktree_path ?? null,
		branchName: row.branch_name ?? null,
		pid: row.pid ?? null,
		exitCode: row.exit_code ?? null,
		exitSignal: row.exit_signal ?? null,
		changedFileCount: row.changed_file_count ?? null,
		tokenUsage,
		isStallSuspected: row.is_stall_suspected === 1,
		reworkCount: row.rework_count ?? 0,
		queuedReason: row.queued_reason ?? null,
		idempotencyKey: row.idempotency_key ?? '',
		actorDeviceId: row.actor_device_id ?? null,
		startedAt: row.started_at ?? null,
		lastEventAt: row.last_event_at ?? null,
		endedAt: row.ended_at ?? null,
	});
}

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

export interface DispatchServiceDeps {
	readonly database?: DatabaseConnection;
	readonly unitOfWork?: UnitOfWork;
	readonly tasksRepo: TasksRepo;
	readonly batchesRepo: BatchesRepo;
	readonly documentsRepo: DocumentsRepo;
	readonly dispatchSnapshotsRepo: DispatchSnapshotsRepo;
	readonly runsRepo?: DispatchRunsRepo;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly eventSeqRepo?: EventSeqRepo;
	readonly getDispatchHalt?: () => boolean;
	readonly agentLimits?: number | Record<string, number> | ((agentId: string) => number);
	readonly listAgents?: () => Promise<readonly unknown[]> | readonly unknown[];
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

export function createDispatchService(deps: DispatchServiceDeps): DispatchService {
	const runsRepo: DispatchRunsRepo =
		deps.runsRepo ??
		(deps.database
			? createSqliteDispatchRunsRepo(deps.database)
			: (() => {
					throw new AppError('E_INTERNAL', 'RunsRepo or database connection must be provided');
				})());

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

		// AC 2 & E-126: 幂等键唯一，两端同时点派发时第二次返回既有 run 而非起第二个进程
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

		// E-82: 文档源不可读检查
		checkDocumentReadable(task.doc_id);

		// E-18, E-77: 任务从文档移除检查
		checkTaskRemoved(task);

		// AC 5, E-50, E-82: is_contract_ready 检查，人工确认不绕过文档契约阻断
		checkContractReady(task);

		// AC 2 & E-126: 同一任务若已有在途运行，第二次调用返回既有 run 而非起第二个进程
		const activeRun = runsRepo.findActiveByTaskId(taskId);
		if (activeRun) {
			return {
				run: toRunDto(activeRun),
				isExisting: true,
			};
		}

		// 创建派发快照（E-19、E-50）
		const now = deps.clock.now();
		const launchSpecJson = JSON.stringify({
			agentId,
			model: input.model ?? null,
			permissionTier: input.permissionTier ?? 'workspaceWrite',
			baseRef: input.baseRef ?? { kind: 'head' },
			worktreeMode: input.worktreeMode ?? 'fresh',
		});

		const snapshot = deps.dispatchSnapshotsRepo.takeSnapshotForTask({
			taskId,
			launchSpecJson,
			createdAt: now,
		});

		const existingRuns = runsRepo.listByTaskId(taskId);
		const attemptNo = existingRuns.length + 1;
		const runId = deps.ids.newId();

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

		try {
			runsRepo.insert(runInsert);
		} catch (err) {
			// 并发竞争处理：命中 SQLite 唯一约束时安全回退至已创建的 run
			const errMessage = err instanceof Error ? err.message : String(err);
			if (
				errMessage.includes('UNIQUE constraint failed: runs.idempotency_key') ||
				errMessage.includes('runs.idempotency_key')
			) {
				const racedRun = runsRepo.findByIdempotencyKey(idempotencyKey);
				if (racedRun) {
					return {
						run: toRunDto(racedRun),
						isExisting: true,
					};
				}
			}
			if (
				errMessage.includes('UNIQUE constraint failed: runs.task_id, runs.attempt_no') ||
				errMessage.includes('runs.task_id')
			) {
				const active = runsRepo.findActiveByTaskId(taskId);
				if (active) {
					return {
						run: toRunDto(active),
						isExisting: true,
					};
				}
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

		// 幂等复用既有 rerun
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

		// E-82: 文档源不可读检查
		checkDocumentReadable(task.doc_id);

		// E-18, E-77: 任务从文档移除检查
		checkTaskRemoved(task);

		// AC 5, E-50, E-82: 重派入口检查 is_contract_ready，未通过返回 E_DOC_CONTRACT_PENDING
		checkContractReady(task);

		// 若任务当前已有在途运行，返回既有运行（AC 2, E-126）
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

		// E-82: 检查文档源是否可读
		checkDocumentReadable(batch.doc_id);

		// AC 3, E-49, E-281: 下一批启动条件是本批 done——全部「已落地」且批次状态为 done
		// 前一批未 done 时返回既有前置检查错误并在 details.previousBatchState 写明
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

				// 校验前一批所有任务是否全部落地
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

		// 触发一次调度排队与候选任务计数
		const batchTasks = deps.tasksRepo.listByBatchId(batchId);
		const activeRunTaskIds = new Set(runsRepo.listActive().map((r) => r.task_id));
		const queuedCount = batchTasks.filter(
			(t) =>
				!isTaskFinishedOrLanded(t) && !activeRunTaskIds.has(t.id) && t.is_removed_from_doc === 0,
		).length;

		// 触发一次 scheduler tick
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

	/**
	 * scheduler-tick 核心调度推进逻辑（AC 1, AC 3, AC 4, AC 5, E-126, E-281, E-49, E-50, E-51, E-82）
	 * 全局内存互斥量：禁止并发 tick、禁止重入
	 */
	async function tick(): Promise<SchedulerTickResult> {
		// AC 1: 全局一把内存互斥量，禁止并发 tick、禁止重入
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
				// E-82: 文档源不可读时冻结新派发
				if (doc.is_source_readable === 0) {
					continue;
				}

				const batches = deps.batchesRepo.listByDocId(doc.id);
				const runningBatches = batches.filter((b) => b.state === 'running');

				for (const batch of runningBatches) {
					const tasks = deps.tasksRepo.listByBatchId(batch.id);
					if (tasks.length === 0) continue;

					// AC 3 & E-49: 批次推导——若全批任务均已 landed，批次推进为 done
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
						continue; // 当前批已完成，不再向本批派发
					}

					// 查找有依赖阻断或终态失败的任务状态
					const taskByKey = new Map<string, TaskRow>();
					for (const t of tasks) {
						taskByKey.set(t.task_key, t);
					}

					// AC 4 & E-51: 收集已派运行，任何情况下不自动重派失败/中断任务
					const allRunsForDoc = runsRepo.listAll();
					const latestRunByTaskId = new Map<string, RunRow>();
					for (const r of allRunsForDoc) {
						const existing = latestRunByTaskId.get(r.task_id);
						if (!existing || r.attempt_no > existing.attempt_no) {
							latestRunByTaskId.set(r.task_id, r);
						}
					}

					// 收集活跃运行
					const activeRuns = runsRepo.listActive();
					const activeTaskIds = new Set(activeRuns.map((r) => r.task_id));

					// 筛选本批可放行候选任务
					const candidateTasks: TaskRow[] = [];

					for (const t of tasks) {
						// 1. 已经落地或正在运行中，不重复派发（AC 1）
						if (isTaskFinishedOrLanded(t) || activeTaskIds.has(t.id)) {
							continue;
						}

						// 2. AC 4 & E-51: 进程死后或已失败的任务，任何情况下不自动重派，等待人工干预
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

						// 3. 依赖前置检查（AC 3 & E-49）：
						//    批内某任务失败或未过时不阻塞无依赖任务；有依赖的前置必须已落地
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

						// 4. AC 5 & E-82: 检查 is_contract_ready
						if (t.is_contract_ready !== 1) {
							tasksBlocked.push({
								taskId: t.id,
								reason: 'contract_not_ready',
							});
							continue;
						}

						// 5. AC 5 & E-50: 检查中途文档指纹/提示词变化，变化时自动暂停后续派发待确认
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

					// M8-T2: 路径冲突队列评估
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

					// M8-T1: 并发窗口与每 agent 限制评估
					const dispatchableTasks = candidateTasks.filter((t) =>
						pathClashResult.dispatchable.some((d) => d.taskId === t.id),
					);

					if (dispatchableTasks.length === 0) {
						continue;
					}

					const activeRunCount = activeRuns.filter((r) => isTaskPathHolding(r.state)).length;
					const availableSlots = Math.max(0, doc.lane_count - activeRunCount);

					const activeRunsByAgent: Record<string, number> = {};
					for (const r of activeRuns) {
						activeRunsByAgent[r.agent_id] = (activeRunsByAgent[r.agent_id] ?? 0) + 1;
					}

					const agentLimitsFn =
						typeof deps.agentLimits === 'function'
							? deps.agentLimits
							: typeof deps.agentLimits === 'number'
								? () => deps.agentLimits as number
								: typeof deps.agentLimits === 'object' && deps.agentLimits !== null
									? (agentId: string) => (deps.agentLimits as Record<string, number>)[agentId] ?? 2
									: () => 2;

					interface SlotCandidate {
						readonly id: string;
						readonly agentId: string;
						readonly task: TaskRow;
						readonly [key: string]: unknown;
					}

					const slotResult = allocateConcurrencySlots<SlotCandidate>({
						candidates: dispatchableTasks.map((t) => ({
							id: t.id,
							agentId: 'codex', // 默认 agentId，后续支持指派覆盖
							task: t,
						})),
						availableSlots,
						agentLimits: agentLimitsFn,
						activeRunsByAgent,
					});

					for (const deferred of slotResult.deferred) {
						tasksDeferred.push({
							taskId: deferred.task.id,
							reason: deferred.reason,
						});
					}

					// 派发通过放行的任务（AC 1: 内存互斥保证同一任务不会被派两次）
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
							// 捕获个别任务派发异常，不中断整个 tick
							tasksBlocked.push({
								taskId: task.id,
								reason: err instanceof Error ? err.message : String(err),
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
