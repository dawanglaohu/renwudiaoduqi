import type { RunDto } from '@agent-scheduler/shared/api/runs';
import { type DatabaseConnection, toDatabaseError } from '../db/open-database.ts';
import { SUCCEEDED_RUN_STATES } from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';

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

export interface RunsRepo {
	readonly insert: (row: RunInsertRow) => void;
	readonly findById: (id: string) => RunRow | null;
	readonly findByIdempotencyKey: (key: string) => RunRow | null;
	readonly findActiveByTaskId: (taskId: string) => RunRow | null;
	readonly listByTaskId: (taskId: string) => readonly RunRow[];
	readonly listActive: () => readonly RunRow[];
	readonly listAll: () => readonly RunRow[];
	readonly listSucceededModelNames: (params: {
		readonly agentId: string;
		readonly limit?: number;
	}) => readonly string[];
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
    ended_at = @ended_at
WHERE id = @id
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

export function createRunsRepo(db: DatabaseConnection): RunsRepo {
	const insertStmt = db.prepare(INSERT_RUN_SQL);
	const selectByIdStmt = db.prepare(SELECT_RUN_BY_ID_SQL);
	const selectByIdempotencyKeyStmt = db.prepare(SELECT_RUN_BY_IDEMPOTENCY_KEY_SQL);
	const selectActiveByTaskIdStmt = db.prepare(SELECT_ACTIVE_RUN_BY_TASK_ID_SQL);
	const selectByTaskIdStmt = db.prepare(SELECT_RUNS_BY_TASK_ID_SQL);
	const selectActiveStmt = db.prepare(SELECT_ACTIVE_RUNS_SQL);
	const selectAllStmt = db.prepare(SELECT_ALL_RUNS_SQL);
	const selectSucceededModelNamesStmt = db.prepare(SELECT_SUCCEEDED_MODEL_NAMES_SQL);
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
				return row ? freezeRunRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find run by id: ${id}`);
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
