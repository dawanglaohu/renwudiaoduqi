import type { Statement } from 'better-sqlite3';
import type { DatabaseConnection } from '../db/open-database.ts';
import { toDatabaseError } from '../db/open-database.ts';

type PreparedStatement = Statement;

export interface RunLogRow {
	readonly id: string;
	readonly taskId: string;
	readonly state: string;
	readonly vendorSessionRef: string | null;
	readonly snapshotId: string | null;
	readonly worktreePath: string | null;
	readonly attemptNo?: number | null;
	readonly startedAt?: string | null;
	readonly endedAt?: string | null;
}

export interface RunsLogRepo {
	findById(id: string): RunLogRow | null;
	findByTaskId(taskId: string): readonly RunLogRow[];
	findCompletedRuns(): readonly RunLogRow[];
}

const SELECT_RUN_BY_ID_SQL = `
SELECT id, task_id, state, vendor_session_ref, snapshot_id, worktree_path, attempt_no, started_at, ended_at
FROM runs
WHERE id = ?
LIMIT 1
`;

const SELECT_RUNS_BY_TASK_ID_SQL = `
SELECT id, task_id, state, vendor_session_ref, snapshot_id, worktree_path, attempt_no, started_at, ended_at
FROM runs
WHERE task_id = ?
ORDER BY attempt_no DESC
`;

const SELECT_COMPLETED_RUNS_SQL = `
SELECT id, task_id, state, vendor_session_ref, snapshot_id, worktree_path, attempt_no, started_at, ended_at
FROM runs
WHERE ended_at IS NOT NULL OR state IN ('failed', 'landed', 'aborted', 'interrupted')
ORDER BY ended_at ASC
`;

interface RawRunLogRow {
	id: string;
	task_id: string;
	state: string;
	vendor_session_ref: string | null;
	snapshot_id: string | null;
	worktree_path: string | null;
	attempt_no: number | null;
	started_at: string | null;
	ended_at: string | null;
}

function mapRow(row: RawRunLogRow): RunLogRow {
	return {
		id: row.id,
		taskId: row.task_id,
		state: row.state,
		vendorSessionRef: row.vendor_session_ref,
		snapshotId: row.snapshot_id,
		worktreePath: row.worktree_path,
		attemptNo: row.attempt_no,
		startedAt: row.started_at,
		endedAt: row.ended_at,
	};
}

export function createSqliteRunsLogRepo(db: DatabaseConnection): RunsLogRepo {
	let selectStmt: PreparedStatement | undefined;
	let selectByTaskStmt: PreparedStatement | undefined;
	let selectCompletedStmt: PreparedStatement | undefined;

	function getSelectStmt(): PreparedStatement {
		if (!selectStmt) {
			try {
				selectStmt = db.prepare(SELECT_RUN_BY_ID_SQL);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunsLogRepo: prepare SELECT_RUN_BY_ID');
			}
		}
		return selectStmt;
	}

	function getSelectByTaskStmt(): PreparedStatement {
		if (!selectByTaskStmt) {
			try {
				selectByTaskStmt = db.prepare(SELECT_RUNS_BY_TASK_ID_SQL);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunsLogRepo: prepare SELECT_RUNS_BY_TASK_ID');
			}
		}
		return selectByTaskStmt;
	}

	function getSelectCompletedStmt(): PreparedStatement {
		if (!selectCompletedStmt) {
			try {
				selectCompletedStmt = db.prepare(SELECT_COMPLETED_RUNS_SQL);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunsLogRepo: prepare SELECT_COMPLETED_RUNS');
			}
		}
		return selectCompletedStmt;
	}

	return {
		findById(id: string): RunLogRow | null {
			try {
				const stmt = getSelectStmt();
				const row = stmt.get(id) as RawRunLogRow | undefined;
				if (!row) return null;
				return mapRow(row);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunsLogRepo.findById');
			}
		},

		findByTaskId(taskId: string): readonly RunLogRow[] {
			try {
				const stmt = getSelectByTaskStmt();
				const rows = stmt.all(taskId) as readonly RawRunLogRow[];
				return Object.freeze(rows.map(mapRow));
			} catch (cause) {
				throw toDatabaseError(cause, 'RunsLogRepo.findByTaskId');
			}
		},

		findCompletedRuns(): readonly RunLogRow[] {
			try {
				const stmt = getSelectCompletedStmt();
				const rows = stmt.all() as readonly RawRunLogRow[];
				return Object.freeze(rows.map(mapRow));
			} catch (cause) {
				throw toDatabaseError(cause, 'RunsLogRepo.findCompletedRuns');
			}
		},
	};
}
