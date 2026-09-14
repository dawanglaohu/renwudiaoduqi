import type { DatabaseConnection } from '../db/open-database.ts';
import { toDatabaseError } from '../db/open-database.ts';

type PreparedStatement = ReturnType<DatabaseConnection['prepare']>;

export interface RunLogRow {
	readonly id: string;
	readonly taskId: string;
	readonly state: string;
	readonly vendorSessionRef: string | null;
	readonly snapshotId: string | null;
	readonly worktreePath: string | null;
}

export interface RunsLogRepo {
	findById(id: string): RunLogRow | null;
}

const SELECT_RUN_BY_ID_SQL = `
SELECT id, task_id, state, vendor_session_ref, snapshot_id, worktree_path
FROM runs
WHERE id = ?
LIMIT 1
`;

export function createSqliteRunsLogRepo(db: DatabaseConnection): RunsLogRepo {
	let selectStmt: PreparedStatement | undefined;

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

	return {
		findById(id: string): RunLogRow | null {
			try {
				const stmt = getSelectStmt();
				const row = stmt.get(id) as
					| {
							id: string;
							task_id: string;
							state: string;
							vendor_session_ref: string | null;
							snapshot_id: string | null;
							worktree_path: string | null;
					  }
					| undefined;
				if (!row) return null;
				return {
					id: row.id,
					taskId: row.task_id,
					state: row.state,
					vendorSessionRef: row.vendor_session_ref,
					snapshotId: row.snapshot_id,
					worktreePath: row.worktree_path,
				};
			} catch (cause) {
				throw toDatabaseError(cause, 'RunsLogRepo.findById');
			}
		},
	};
}
