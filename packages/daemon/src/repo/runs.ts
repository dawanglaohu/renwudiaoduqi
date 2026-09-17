import type { RunDto } from '@agent-scheduler/shared/api/runs';
import { type DatabaseConnection, toDatabaseError } from '../db/open-database.ts';
import { SUCCEEDED_RUN_STATES } from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';

export interface RunRow {
	readonly id: string;
	readonly task_id: string | null;
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
	readonly lane_no?: number | null;
	readonly session_archived_at?: string | null;
	readonly effort_vendor?: string | null;
	readonly review_round?: number | null;
	readonly continued_from_run_id?: string | null;
	readonly assignment_source?: string | null;
	readonly origin?: string;
	readonly spawned_by_run_id?: string | null;
	readonly batch_id?: string | null;
	readonly is_in_head?: number;
	readonly in_head_checked_at?: string | null;
	readonly branch_tip_sha?: string | null;
	readonly prompt_source?: string | null;
}

export interface RunInsertRow {
	readonly id: string;
	readonly task_id: string | null;
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
	readonly lane_no?: number | null;
	readonly session_archived_at?: string | null;
	readonly effort_vendor?: string | null;
	readonly review_round?: number | null;
	readonly continued_from_run_id?: string | null;
	readonly assignment_source?: string | null;
	readonly origin?: string;
	readonly spawned_by_run_id?: string | null;
	readonly batch_id?: string | null;
	readonly is_in_head?: number;
	readonly in_head_checked_at?: string | null;
	readonly branch_tip_sha?: string | null;
	readonly prompt_source?: string | null;
}

export interface RunsRepo {
	readonly insert: (row: RunInsertRow) => void;
	readonly findById: (id: string) => RunRow | null;
	readonly findByIdempotencyKey: (key: string) => RunRow | null;
	readonly findByVendorSessionRef: (vendorSessionRef: string) => RunRow | null;
	readonly findActiveByTaskId: (taskId: string) => RunRow | null;
	readonly listByTaskId: (taskId: string) => readonly RunRow[];
	readonly listByTask: (taskId: string) => readonly RunRow[];
	readonly listActive: () => readonly RunRow[];
	readonly listAll: () => readonly RunRow[];
	readonly findLatestReview: (taskId: string) => RunRow | null;
	readonly markSessionsArchived: (input: {
		readonly taskId: string;
		readonly archivedAt: string;
	}) => {
		readonly runIds: readonly string[];
		readonly runs: readonly { readonly id: string; readonly pid: number | null }[];
		readonly changes: number;
	};
	readonly listSucceededModelNames: (params: {
		readonly agentId: string;
		readonly limit?: number;
	}) => readonly string[];
	readonly updateState: (input: {
		readonly id: string;
		readonly state?: string;
		readonly toState?: string;
		readonly fromState?: string;
		readonly queuedReason?: string | null;
		readonly endedAt?: string | null;
		readonly exitCode?: number | null;
		readonly exitSignal?: string | null;
		readonly actorDeviceId?: string | null;
		readonly reworkCount?: number;
	}) => void;
	readonly updateReviewRound: (id: string, reviewRound: number | null) => void;
	readonly updateReworkCount: (input: {
		readonly id: string;
		readonly reworkCount: number;
		readonly state?: string;
		readonly reviewVerdict?: string | null;
		readonly reworkText?: string | null;
	}) => void;
	readonly findActiveWrapupByBatchId?: (batchId: string) => RunRow | null;
	readonly findLatestWrapupByBatchId?: (batchId: string) => RunRow | null;
	readonly listWrapupsByBatchId?: (batchId: string) => readonly RunRow[];
	readonly findLandedImplementationRunsByBatchId?: (batchId: string) => readonly RunRow[];
	readonly findLandedNotInHeadRuns?: (
		limit: number,
		olderThanIso?: string | null,
	) => readonly RunRow[];
	readonly updateInHead?: (input: {
		readonly id: string;
		readonly isInHead: number;
		readonly checkedAt: string;
		readonly branchTipSha?: string | null;
	}) => void;
}

const INSERT_RUN_SQL_BASE = `
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

const INSERT_RUN_SQL_WITH_LANES = `
INSERT INTO runs (
	id, task_id, attempt_no, kind, parent_run_id, state, review_verdict,
	agent_id, model_name, reported_model, effort_tier, reported_effort,
	permission_tier, snapshot_id, worktree_path, branch_name, pid,
	exit_code, exit_signal, vendor_session_ref, changed_file_count,
	token_usage_json, unmapped_event_count, is_stall_suspected,
	rework_count, queued_reason, idempotency_key, actor_device_id,
	started_at, last_event_at, ended_at, lane_no, session_archived_at
) VALUES (
	@id, @task_id, @attempt_no, @kind, @parent_run_id, @state, @review_verdict,
	@agent_id, @model_name, @reported_model, @effort_tier, @reported_effort,
	@permission_tier, @snapshot_id, @worktree_path, @branch_name, @pid,
	@exit_code, @exit_signal, @vendor_session_ref, @changed_file_count,
	@token_usage_json, @unmapped_event_count, @is_stall_suspected,
	@rework_count, @queued_reason, @idempotency_key, @actor_device_id,
	@started_at, @last_event_at, @ended_at, @lane_no, @session_archived_at
)
`;

const SELECT_LATEST_REVIEW_SQL = `
SELECT * FROM runs
WHERE task_id = ? AND kind = 'review'
ORDER BY review_round DESC NULLS LAST, started_at DESC, id DESC
LIMIT 1
`;

const SELECT_RUN_BY_ID_SQL = `
SELECT * FROM runs WHERE id = ? LIMIT 1
`;

const SELECT_RUN_BY_IDEMPOTENCY_KEY_SQL = `
SELECT * FROM runs WHERE idempotency_key = ? LIMIT 1
`;

const SELECT_RUN_BY_VENDOR_SESSION_REF_SQL = `
SELECT * FROM runs WHERE vendor_session_ref = ? LIMIT 1
`;

const SELECT_UNARCHIVED_RUNS_BY_TASK_ID_SQL = `
SELECT id, pid FROM runs WHERE task_id = ? AND session_archived_at IS NULL
`;

const MARK_SESSIONS_ARCHIVED_SQL = `
UPDATE runs SET session_archived_at = ? WHERE task_id = ? AND session_archived_at IS NULL
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

const SUCCEEDED_STATE_PLACEHOLDERS = SUCCEEDED_RUN_STATES.map(() => '?').join(', ');

const SELECT_SUCCEEDED_MODEL_NAMES_SQL = `
SELECT model_name FROM runs
WHERE agent_id = ?
  AND state IN (${SUCCEEDED_STATE_PLACEHOLDERS})
  AND model_name IS NOT NULL
  AND model_name != ''
GROUP BY model_name
ORDER BY MAX(ended_at) DESC
LIMIT ?
`;

const UPDATE_RUN_STATE_SQL = `
UPDATE runs
SET state = @state,
    queued_reason = @queued_reason,
    ended_at = @ended_at,
    rework_count = CASE WHEN @rework_count IS NOT NULL THEN @rework_count ELSE rework_count END
WHERE id = @id
`;

const UPDATE_REWORK_COUNT_SQL = `
UPDATE runs
SET rework_count = @rework_count,
    state = CASE WHEN @state IS NOT NULL THEN @state ELSE state END
WHERE id = @id
`;

const UPDATE_REVIEW_ROUND_SQL = `
UPDATE runs
SET review_round = ?
WHERE id = ?
`;

function freezeRunRow(row: RunRow): RunRow {
	return Object.freeze({ ...row });
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

	let effort: RunDto['effort'] = null;
	if (row.effort_tier) {
		effort = { tier: row.effort_tier as 'low' | 'medium' | 'high' };
	} else if (row.effort_vendor) {
		effort = { vendor: row.effort_vendor };
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
		effortVendor: row.effort_vendor ?? null,
		effort,
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
		laneNo: row.lane_no ?? null,
		sessionArchivedAt: row.session_archived_at ?? null,
		origin: (row.origin as RunDto['origin']) ?? 'dispatch',
		spawnedByRunId: row.spawned_by_run_id ?? null,
		reviewRound: row.review_round ?? null,
		continuedFromRunId: row.continued_from_run_id ?? null,
		batchId: row.batch_id ?? null,
		isInHead: row.is_in_head === 1,
		inHeadCheckedAt: row.in_head_checked_at ?? null,
		branchTipSha: row.branch_tip_sha ?? null,
		promptSource: (row.prompt_source as RunDto['promptSource']) ?? null,
		assignmentSource: (row.assignment_source as RunDto['assignmentSource']) ?? null,
	});
}

export function createRunsRepo(db: DatabaseConnection): RunsRepo {
	let hasSessionArchivedAt = false;
	let hasLaneNo = false;
	let hasEffortVendor = false;
	let hasReviewRound = false;
	let hasContinuedFromRunId = false;
	let hasAssignmentSource = false;
	let hasOrigin = false;
	let hasSpawnedByRunId = false;
	let hasBatchId = false;
	let hasIsInHead = false;
	let hasInHeadCheckedAt = false;
	let hasBranchTipSha = false;
	let hasPromptSource = false;
	try {
		const tableInfo = db.prepare<[], { name: string }>('PRAGMA table_info(runs)').all();
		hasSessionArchivedAt = tableInfo.some((col) => col.name === 'session_archived_at');
		hasLaneNo = tableInfo.some((col) => col.name === 'lane_no');
		hasEffortVendor = tableInfo.some((col) => col.name === 'effort_vendor');
		hasReviewRound = tableInfo.some((col) => col.name === 'review_round');
		hasContinuedFromRunId = tableInfo.some((col) => col.name === 'continued_from_run_id');
		hasAssignmentSource = tableInfo.some((col) => col.name === 'assignment_source');
		hasOrigin = tableInfo.some((col) => col.name === 'origin');
		hasSpawnedByRunId = tableInfo.some((col) => col.name === 'spawned_by_run_id');
		hasBatchId = tableInfo.some((col) => col.name === 'batch_id');
		hasIsInHead = tableInfo.some((col) => col.name === 'is_in_head');
		hasInHeadCheckedAt = tableInfo.some((col) => col.name === 'in_head_checked_at');
		hasBranchTipSha = tableInfo.some((col) => col.name === 'branch_tip_sha');
		hasPromptSource = tableInfo.some((col) => col.name === 'prompt_source');
	} catch {}

	const baseInsertCols = [
		'id',
		'task_id',
		'attempt_no',
		'kind',
		'parent_run_id',
		'state',
		'review_verdict',
		'agent_id',
		'model_name',
		'reported_model',
		'effort_tier',
		'reported_effort',
		'permission_tier',
		'snapshot_id',
		'worktree_path',
		'branch_name',
		'pid',
		'exit_code',
		'exit_signal',
		'vendor_session_ref',
		'changed_file_count',
		'token_usage_json',
		'unmapped_event_count',
		'is_stall_suspected',
		'rework_count',
		'queued_reason',
		'idempotency_key',
		'actor_device_id',
		'started_at',
		'last_event_at',
		'ended_at',
	];
	const extraInsertCols: string[] = [];
	if (hasLaneNo) extraInsertCols.push('lane_no');
	if (hasSessionArchivedAt) extraInsertCols.push('session_archived_at');
	if (hasEffortVendor) extraInsertCols.push('effort_vendor');
	if (hasReviewRound) extraInsertCols.push('review_round');
	if (hasContinuedFromRunId) extraInsertCols.push('continued_from_run_id');
	if (hasAssignmentSource) extraInsertCols.push('assignment_source');
	if (hasOrigin) extraInsertCols.push('origin');
	if (hasSpawnedByRunId) extraInsertCols.push('spawned_by_run_id');
	if (hasBatchId) extraInsertCols.push('batch_id');
	if (hasIsInHead) extraInsertCols.push('is_in_head');
	if (hasInHeadCheckedAt) extraInsertCols.push('in_head_checked_at');
	if (hasBranchTipSha) extraInsertCols.push('branch_tip_sha');
	if (hasPromptSource) extraInsertCols.push('prompt_source');

	const allInsertCols = [...baseInsertCols, ...extraInsertCols];
	const dynamicInsertSql = `INSERT INTO runs (${allInsertCols.join(', ')}) VALUES (${allInsertCols.map((col) => `@${col}`).join(', ')})`;
	const insertStmt = db.prepare(dynamicInsertSql);
	const selectByIdStmt = db.prepare(SELECT_RUN_BY_ID_SQL);
	const selectLatestReviewStmt = db.prepare(SELECT_LATEST_REVIEW_SQL);
	const selectByIdempotencyKeyStmt = db.prepare(SELECT_RUN_BY_IDEMPOTENCY_KEY_SQL);
	const selectByVendorSessionRefStmt = db.prepare(SELECT_RUN_BY_VENDOR_SESSION_REF_SQL);
	const selectActiveByTaskIdStmt = db.prepare(SELECT_ACTIVE_RUN_BY_TASK_ID_SQL);
	const selectByTaskIdStmt = db.prepare(SELECT_RUNS_BY_TASK_ID_SQL);
	const selectActiveStmt = db.prepare(SELECT_ACTIVE_RUNS_SQL);
	const selectAllStmt = db.prepare(SELECT_ALL_RUNS_SQL);
	const selectSucceededModelNamesStmt = db.prepare(SELECT_SUCCEEDED_MODEL_NAMES_SQL);
	const updateStateStmt = db.prepare(UPDATE_RUN_STATE_SQL);
	const updateReworkCountStmt = db.prepare(UPDATE_REWORK_COUNT_SQL);
	const updateReviewRoundStmt = db.prepare(UPDATE_REVIEW_ROUND_SQL);

	const selectActiveWrapupByBatchIdStmt = db.prepare(`
		SELECT * FROM runs
		WHERE batch_id = ? AND kind = 'wrapup'
		  AND state IN ('queued', 'starting', 'running', 'awaiting_reply', 'reviewing', 'reworking')
		LIMIT 1
	`);

	const selectLatestWrapupByBatchIdStmt = db.prepare(`
		SELECT * FROM runs
		WHERE batch_id = ? AND kind = 'wrapup'
		ORDER BY attempt_no DESC, started_at DESC
		LIMIT 1
	`);

	const selectListWrapupsByBatchIdStmt = db.prepare(`
		SELECT * FROM runs
		WHERE batch_id = ? AND kind = 'wrapup'
		ORDER BY attempt_no ASC
	`);

	const selectLandedImplementationRunsByBatchIdStmt = db.prepare(`
		SELECT r.* FROM runs r
		LEFT JOIN tasks t ON r.task_id = t.id
		WHERE (r.batch_id = ? OR t.batch_id = ?)
		  AND r.kind = 'implement'
		  AND r.state = 'landed'
		ORDER BY r.ended_at DESC NULLS LAST, r.id DESC
	`);

	const selectLandedNotInHeadRunsStmt = db.prepare(`
		SELECT * FROM runs
		WHERE state = 'landed' AND is_in_head = 0
		  AND kind IN ('implement', 'wrapup')
		  AND (in_head_checked_at IS NULL OR in_head_checked_at <= ?)
		ORDER BY ended_at ASC NULLS LAST
		LIMIT ?
	`);

	const updateInHeadStmt = db.prepare(`
		UPDATE runs
		SET is_in_head = CASE WHEN is_in_head = 1 THEN 1 ELSE @is_in_head END,
		    in_head_checked_at = @in_head_checked_at,
		    branch_tip_sha = COALESCE(@branch_tip_sha, branch_tip_sha)
		WHERE id = @id
	`);
	const selectUnarchivedStmt = hasSessionArchivedAt
		? db.prepare(SELECT_UNARCHIVED_RUNS_BY_TASK_ID_SQL)
		: null;
	const markArchivedStmt = hasSessionArchivedAt ? db.prepare(MARK_SESSIONS_ARCHIVED_SQL) : null;

	return Object.freeze({
		insert(row: RunInsertRow): void {
			try {
				const params: Record<string, unknown> = {
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
				};
				if (hasLaneNo) {
					params.lane_no = row.lane_no ?? null;
				}
				if (hasSessionArchivedAt) {
					params.session_archived_at = row.session_archived_at ?? null;
				}
				if (hasEffortVendor) {
					params.effort_vendor = row.effort_vendor ?? null;
				}
				if (hasReviewRound) {
					params.review_round = row.review_round ?? null;
				}
				if (hasContinuedFromRunId) {
					params.continued_from_run_id = row.continued_from_run_id ?? null;
				}
				if (hasAssignmentSource) {
					params.assignment_source = row.assignment_source ?? null;
				}
				if (hasOrigin) {
					params.origin = row.origin ?? 'dispatch';
				}
				if (hasSpawnedByRunId) {
					params.spawned_by_run_id = row.spawned_by_run_id ?? null;
				}
				if (hasBatchId) {
					params.batch_id = row.batch_id ?? null;
				}
				if (hasIsInHead) {
					params.is_in_head = row.is_in_head ?? 0;
				}
				if (hasInHeadCheckedAt) {
					params.in_head_checked_at = row.in_head_checked_at ?? null;
				}
				if (hasBranchTipSha) {
					params.branch_tip_sha = row.branch_tip_sha ?? null;
				}
				if (hasPromptSource) {
					params.prompt_source = row.prompt_source ?? null;
				}
				insertStmt.run(params);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to insert run: id=${row.id}`);
			}
		},

		findById(id: string): RunRow | null {
			try {
				const row = selectByIdStmt.get(id) as RunRow | undefined;
				return row ? freezeRunRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find run by id: ${id}`);
			}
		},
		findLatestReview(taskId: string): RunRow | null {
			try {
				const row = selectLatestReviewStmt.get(taskId) as RunRow | undefined;
				return row ? freezeRunRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find latest review for task: ${taskId}`);
			}
		},

		findByIdempotencyKey(key: string): RunRow | null {
			try {
				const row = selectByIdempotencyKeyStmt.get(key) as RunRow | undefined;
				return row ? freezeRunRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find run by idempotency key: ${key}`);
			}
		},

		findByVendorSessionRef(vendorSessionRef: string): RunRow | null {
			try {
				const row = selectByVendorSessionRefStmt.get(vendorSessionRef) as RunRow | undefined;
				return row ? freezeRunRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(
					cause,
					`Failed to find run by vendor session ref: ${vendorSessionRef}`,
				);
			}
		},

		findActiveByTaskId(taskId: string): RunRow | null {
			try {
				const row = selectActiveByTaskIdStmt.get(taskId) as RunRow | undefined;
				return row ? freezeRunRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find active run for task: ${taskId}`);
			}
		},

		listByTaskId(taskId: string): readonly RunRow[] {
			try {
				const rows = selectByTaskIdStmt.all(taskId) as RunRow[];
				return Object.freeze(rows.map(freezeRunRow));
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to list runs by taskId: ${taskId}`);
			}
		},

		listByTask(taskId: string): readonly RunRow[] {
			try {
				const rows = selectByTaskIdStmt.all(taskId) as RunRow[];
				return Object.freeze(rows.map(freezeRunRow));
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to list runs by task: ${taskId}`);
			}
		},

		listActive(): readonly RunRow[] {
			try {
				const rows = selectActiveStmt.all() as RunRow[];
				return Object.freeze(rows.map(freezeRunRow));
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to list active runs');
			}
		},

		listAll(): readonly RunRow[] {
			try {
				const rows = selectAllStmt.all() as RunRow[];
				return Object.freeze(rows.map(freezeRunRow));
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to list all runs');
			}
		},

		markSessionsArchived(input: {
			readonly taskId: string;
			readonly archivedAt: string;
		}): {
			readonly runIds: readonly string[];
			readonly runs: readonly { readonly id: string; readonly pid: number | null }[];
			readonly changes: number;
		} {
			if (!selectUnarchivedStmt || !markArchivedStmt) {
				return Object.freeze({ runIds: [], runs: [], changes: 0 });
			}
			try {
				const unarchived = selectUnarchivedStmt.all(input.taskId) as Array<{
					id: string;
					pid: number | null;
				}>;
				if (unarchived.length === 0) {
					return Object.freeze({ runIds: [], runs: [], changes: 0 });
				}
				const result = markArchivedStmt.run(input.archivedAt, input.taskId);
				const runIds = Object.freeze(unarchived.map((r) => r.id));
				const runs = Object.freeze(unarchived.map((r) => Object.freeze({ id: r.id, pid: r.pid })));
				return Object.freeze({
					runIds,
					runs,
					changes: result.changes,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to mark sessions archived for task: ${input.taskId}`);
			}
		},

		listSucceededModelNames(params: {
			readonly agentId: string;
			readonly limit?: number;
		}): readonly string[] {
			try {
				const limit = params.limit ?? 40;
				const rows = selectSucceededModelNamesStmt.all(
					params.agentId,
					...SUCCEEDED_RUN_STATES,
					limit,
				) as readonly {
					model_name: string;
				}[];
				return Object.freeze(rows.map((r) => r.model_name));
			} catch (cause) {
				throw toDatabaseError(
					cause,
					`Failed to list succeeded model names for agent: ${params.agentId}`,
				);
			}
		},

		updateState(input: {
			readonly id: string;
			readonly state?: string;
			readonly toState?: string;
			readonly fromState?: string;
			readonly queuedReason?: string | null;
			readonly endedAt?: string | null;
			readonly exitCode?: number | null;
			readonly exitSignal?: string | null;
			readonly actorDeviceId?: string | null;
			readonly reworkCount?: number;
		}): void {
			try {
				const state = input.state ?? input.toState;
				updateStateStmt.run({
					id: input.id,
					state,
					queued_reason: input.queuedReason ?? null,
					ended_at: input.endedAt ?? null,
					rework_count: input.reworkCount ?? null,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update run state: ${input.id}`);
			}
		},

		updateReviewRound(id: string, reviewRound: number | null): void {
			try {
				updateReviewRoundStmt.run(reviewRound, id);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update review_round for run: ${id}`);
			}
		},

		updateReworkCount(input: {
			readonly id: string;
			readonly reworkCount: number;
			readonly state?: string;
			readonly reviewVerdict?: string | null;
			readonly reworkText?: string | null;
		}): void {
			try {
				updateReworkCountStmt.run({
					id: input.id,
					rework_count: input.reworkCount,
					state: input.state ?? null,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update run rework count: ${input.id}`);
			}
		},

		findActiveWrapupByBatchId(batchId: string): RunRow | null {
			try {
				const row = selectActiveWrapupByBatchIdStmt.get(batchId) as RunRow | undefined;
				return row ? freezeRunRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find active wrapup run for batch: ${batchId}`);
			}
		},

		findLatestWrapupByBatchId(batchId: string): RunRow | null {
			try {
				const row = selectLatestWrapupByBatchIdStmt.get(batchId) as RunRow | undefined;
				return row ? freezeRunRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find latest wrapup run for batch: ${batchId}`);
			}
		},

		listWrapupsByBatchId(batchId: string): readonly RunRow[] {
			try {
				const rows = selectListWrapupsByBatchIdStmt.all(batchId) as RunRow[];
				return Object.freeze(rows.map(freezeRunRow));
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to list wrapup runs for batch: ${batchId}`);
			}
		},

		findLandedImplementationRunsByBatchId(batchId: string): readonly RunRow[] {
			try {
				const rows = selectLandedImplementationRunsByBatchIdStmt.all(batchId, batchId) as RunRow[];
				return Object.freeze(rows.map(freezeRunRow));
			} catch (cause) {
				throw toDatabaseError(
					cause,
					`Failed to find landed implementation runs for batch: ${batchId}`,
				);
			}
		},

		findLandedNotInHeadRuns(limit: number, olderThanIso?: string | null): readonly RunRow[] {
			try {
				const threshold = olderThanIso ?? new Date().toISOString();
				const rows = selectLandedNotInHeadRunsStmt.all(threshold, limit) as RunRow[];
				return Object.freeze(rows.map(freezeRunRow));
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to find landed not-in-head runs');
			}
		},

		updateInHead(input: {
			readonly id: string;
			readonly isInHead: number;
			readonly checkedAt: string;
			readonly branchTipSha?: string | null;
		}): void {
			try {
				updateInHeadStmt.run({
					id: input.id,
					is_in_head: input.isInHead,
					in_head_checked_at: input.checkedAt,
					branch_tip_sha: input.branchTipSha ?? null,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update in_head for run: ${input.id}`);
			}
		},
	});
}

export function isConstraintConflict(error: unknown): boolean {
	if (error instanceof AppError && error.cause && typeof error.cause === 'object') {
		const cause = error.cause as { readonly code?: string };
		return (
			cause.code === 'SQLITE_CONSTRAINT' ||
			cause.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
			cause.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
		);
	}
	if (typeof error === 'object' && error !== null && 'code' in error) {
		const code = (error as { readonly code?: string }).code;
		return (
			code === 'SQLITE_CONSTRAINT' ||
			code === 'SQLITE_CONSTRAINT_UNIQUE' ||
			code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
		);
	}
	return false;
}
