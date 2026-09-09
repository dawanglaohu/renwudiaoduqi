import type { DatabaseConnection } from '../db/open-database.ts';
import { toDatabaseError } from '../db/open-database.ts';
import type { RunState } from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';

type PreparedStatement = ReturnType<DatabaseConnection['prepare']>;

export interface RunAbortRunRecord {
	readonly id: string;
	readonly taskId: string;
	readonly state: RunState;
	readonly pid: number | null;
	readonly worktreePath: string | null;
	readonly changedFileCount: number | null;
}

export interface RunsAbortRepo {
	findById(id: string): RunAbortRunRecord | null;
	updateState(input: {
		readonly id: string;
		readonly fromState: RunState;
		readonly toState: RunState;
		readonly endedAt: string;
		readonly actorDeviceId?: string | null;
		readonly changedFileCount?: number | null;
		readonly queuedReason?: string | null;
	}): void;
}

const SELECT_BY_ID_SQL = `
SELECT id, task_id, state, pid, worktree_path, changed_file_count
FROM runs
WHERE id = ?
LIMIT 1
`;

const UPDATE_STATE_SQL = `
UPDATE runs
SET state = @toState,
    ended_at = @endedAt,
    actor_device_id = @actorDeviceId,
    changed_file_count = @changedFileCount,
    queued_reason = @queuedReason
WHERE id = @id AND state = @fromState
`;

export function createSqliteRunsAbortRepo(db: DatabaseConnection): RunsAbortRepo {
	let selectStmt: PreparedStatement | undefined;
	let updateStmt: PreparedStatement | undefined;

	function getSelectStmt(): PreparedStatement {
		if (!selectStmt) {
			try {
				selectStmt = db.prepare(SELECT_BY_ID_SQL);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunsAbortRepo: prepare SELECT_BY_ID');
			}
		}
		return selectStmt;
	}

	function getUpdateStmt(): PreparedStatement {
		if (!updateStmt) {
			try {
				updateStmt = db.prepare(UPDATE_STATE_SQL);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunsAbortRepo: prepare UPDATE_STATE');
			}
		}
		return updateStmt;
	}

	return {
		findById(id: string): RunAbortRunRecord | null {
			try {
				const stmt = getSelectStmt();
				const row = stmt.get(id) as
					| {
							id: string;
							task_id: string;
							state: RunState;
							pid: number | null;
							worktree_path: string | null;
							changed_file_count: number | null;
					  }
					| undefined;
				if (!row) return null;
				return {
					id: row.id,
					taskId: row.task_id,
					state: row.state,
					pid: row.pid,
					worktreePath: row.worktree_path,
					changedFileCount: row.changed_file_count,
				};
			} catch (cause) {
				throw toDatabaseError(cause, 'RunsAbortRepo.findById');
			}
		},

		updateState(input): void {
			try {
				const stmt = getUpdateStmt();
				const result = stmt.run({
					id: input.id,
					fromState: input.fromState,
					toState: input.toState,
					endedAt: input.endedAt,
					actorDeviceId: input.actorDeviceId ?? null,
					changedFileCount: input.changedFileCount ?? null,
					queuedReason: input.queuedReason ?? null,
				});
				if (result.changes === 0) {
					throw new AppError(
						'E_INVALID_STATE_TRANSITION',
						`Run ${input.id} could not be updated from ${input.fromState} to ${input.toState}`,
					);
				}
			} catch (cause) {
				if (cause instanceof AppError) throw cause;
				throw toDatabaseError(cause, 'RunsAbortRepo.updateState');
			}
		},
	};
}
