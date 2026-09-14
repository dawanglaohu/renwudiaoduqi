import type { DatabaseConnection } from '../db/open-database.ts';
import { toDatabaseError } from '../db/open-database.ts';
import type { RunState } from '../domain/run-state-machine.ts';

type PreparedStatement = ReturnType<DatabaseConnection['prepare']>;

export type MessageDeliveryState = 'delivered' | 'undelivered';
export type MessageKind = 'reply' | 'approve' | 'deny' | 'elevate_once';

export interface RunMessageRecord {
	readonly id: string;
	readonly runId: string;
	readonly kind: MessageKind;
	readonly text: string;
	readonly deliveryState: MessageDeliveryState;
	readonly undeliveredReason: string | null;
	readonly actorDeviceId: string | null;
	readonly createdAt: string;
	readonly deliveredAt: string | null;
}

export interface InsertRunMessageInput {
	readonly id: string;
	readonly runId: string;
	readonly kind: MessageKind;
	readonly text: string;
	readonly deliveryState: MessageDeliveryState;
	readonly undeliveredReason?: string | null;
	readonly actorDeviceId?: string | null;
	readonly createdAt: string;
	readonly deliveredAt?: string | null;
}

export interface MessageRunRecord {
	readonly id: string;
	readonly taskId: string;
	readonly state: RunState;
	readonly agentId: string;
	readonly pid: number | null;
	readonly parentRunId: string | null;
	readonly attemptNo: number;
}

export interface RunMessagesRepo {
	findRunById(id: string): MessageRunRecord | null;
	insertMessage(input: InsertRunMessageInput): void;
	findMessageById(id: string): RunMessageRecord | null;
	findMessagesByRunId(runId: string): readonly RunMessageRecord[];
	findUndeliveredByRunId(runId: string): readonly RunMessageRecord[];
	updateRunState(input: {
		readonly id: string;
		readonly fromState: RunState;
		readonly toState: RunState;
		readonly lastEventAt: string;
	}): void;
}

const SELECT_RUN_BY_ID_SQL = `
SELECT id, task_id, state, agent_id, pid, parent_run_id, attempt_no
FROM runs
WHERE id = ?
LIMIT 1
`;

const INSERT_MESSAGE_SQL = `
INSERT INTO run_messages (
	id,
	run_id,
	kind,
	text,
	delivery_state,
	undelivered_reason,
	actor_device_id,
	created_at,
	delivered_at
) VALUES (
	@id,
	@runId,
	@kind,
	@text,
	@deliveryState,
	@undeliveredReason,
	@actorDeviceId,
	@createdAt,
	@deliveredAt
)
`;

const SELECT_MESSAGE_BY_ID_SQL = `
SELECT id, run_id, kind, text, delivery_state, undelivered_reason, actor_device_id, created_at, delivered_at
FROM run_messages
WHERE id = ?
LIMIT 1
`;

const SELECT_MESSAGES_BY_RUN_ID_SQL = `
SELECT id, run_id, kind, text, delivery_state, undelivered_reason, actor_device_id, created_at, delivered_at
FROM run_messages
WHERE run_id = ?
ORDER BY created_at ASC
`;

const SELECT_UNDELIVERED_BY_RUN_ID_SQL = `
SELECT id, run_id, kind, text, delivery_state, undelivered_reason, actor_device_id, created_at, delivered_at
FROM run_messages
WHERE run_id = ? AND delivery_state = 'undelivered'
ORDER BY created_at ASC
`;

const UPDATE_RUN_STATE_SQL = `
UPDATE runs
SET state = @toState,
    last_event_at = @lastEventAt
WHERE id = @id AND state = @fromState
`;

interface RunRow {
	readonly id: string;
	readonly task_id: string;
	readonly state: RunState;
	readonly agent_id: string;
	readonly pid: number | null;
	readonly parent_run_id: string | null;
	readonly attempt_no: number;
}

interface MessageRow {
	readonly id: string;
	readonly run_id: string;
	readonly kind: MessageKind;
	readonly text: string;
	readonly delivery_state: MessageDeliveryState;
	readonly undelivered_reason: string | null;
	readonly actor_device_id: string | null;
	readonly created_at: string;
	readonly delivered_at: string | null;
}

function mapRunRow(row: RunRow): MessageRunRecord {
	return {
		id: row.id,
		taskId: row.task_id,
		state: row.state,
		agentId: row.agent_id,
		pid: row.pid,
		parentRunId: row.parent_run_id,
		attemptNo: row.attempt_no,
	};
}

function mapMessageRow(row: MessageRow): RunMessageRecord {
	return {
		id: row.id,
		runId: row.run_id,
		kind: row.kind,
		text: row.text,
		deliveryState: row.delivery_state,
		undeliveredReason: row.undelivered_reason,
		actorDeviceId: row.actor_device_id,
		createdAt: row.created_at,
		deliveredAt: row.delivered_at,
	};
}

export function createSqliteRunMessagesRepo(db: DatabaseConnection): RunMessagesRepo {
	let selectRunStmt: PreparedStatement | undefined;
	let insertMessageStmt: PreparedStatement | undefined;
	let selectMessageStmt: PreparedStatement | undefined;
	let selectMessagesByRunStmt: PreparedStatement | undefined;
	let selectUndeliveredStmt: PreparedStatement | undefined;
	let updateRunStateStmt: PreparedStatement | undefined;

	function getSelectRunStmt(): PreparedStatement {
		if (!selectRunStmt) {
			try {
				selectRunStmt = db.prepare(SELECT_RUN_BY_ID_SQL);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunMessagesRepo: prepare SELECT_RUN_BY_ID');
			}
		}
		return selectRunStmt;
	}

	function getInsertMessageStmt(): PreparedStatement {
		if (!insertMessageStmt) {
			try {
				insertMessageStmt = db.prepare(INSERT_MESSAGE_SQL);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunMessagesRepo: prepare INSERT_MESSAGE');
			}
		}
		return insertMessageStmt;
	}

	function getSelectMessageStmt(): PreparedStatement {
		if (!selectMessageStmt) {
			try {
				selectMessageStmt = db.prepare(SELECT_MESSAGE_BY_ID_SQL);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunMessagesRepo: prepare SELECT_MESSAGE_BY_ID');
			}
		}
		return selectMessageStmt;
	}

	function getSelectMessagesByRunStmt(): PreparedStatement {
		if (!selectMessagesByRunStmt) {
			try {
				selectMessagesByRunStmt = db.prepare(SELECT_MESSAGES_BY_RUN_ID_SQL);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunMessagesRepo: prepare SELECT_MESSAGES_BY_RUN_ID');
			}
		}
		return selectMessagesByRunStmt;
	}

	function getSelectUndeliveredStmt(): PreparedStatement {
		if (!selectUndeliveredStmt) {
			try {
				selectUndeliveredStmt = db.prepare(SELECT_UNDELIVERED_BY_RUN_ID_SQL);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunMessagesRepo: prepare SELECT_UNDELIVERED');
			}
		}
		return selectUndeliveredStmt;
	}

	function getUpdateRunStateStmt(): PreparedStatement {
		if (!updateRunStateStmt) {
			try {
				updateRunStateStmt = db.prepare(UPDATE_RUN_STATE_SQL);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunMessagesRepo: prepare UPDATE_RUN_STATE');
			}
		}
		return updateRunStateStmt;
	}

	return {
		findRunById(id: string): MessageRunRecord | null {
			try {
				const stmt = getSelectRunStmt();
				const row = stmt.get(id) as RunRow | undefined;
				return row ? mapRunRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, 'RunMessagesRepo.findRunById');
			}
		},

		insertMessage(input: InsertRunMessageInput): void {
			try {
				const stmt = getInsertMessageStmt();
				stmt.run({
					id: input.id,
					runId: input.runId,
					kind: input.kind,
					text: input.text,
					deliveryState: input.deliveryState,
					undeliveredReason: input.undeliveredReason ?? null,
					actorDeviceId: input.actorDeviceId ?? null,
					createdAt: input.createdAt,
					deliveredAt: input.deliveredAt ?? null,
				});
			} catch (cause) {
				throw toDatabaseError(cause, 'RunMessagesRepo.insertMessage');
			}
		},

		findMessageById(id: string): RunMessageRecord | null {
			try {
				const stmt = getSelectMessageStmt();
				const row = stmt.get(id) as MessageRow | undefined;
				return row ? mapMessageRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, 'RunMessagesRepo.findMessageById');
			}
		},

		findMessagesByRunId(runId: string): readonly RunMessageRecord[] {
			try {
				const stmt = getSelectMessagesByRunStmt();
				const rows = stmt.all(runId) as readonly MessageRow[];
				return rows.map(mapMessageRow);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunMessagesRepo.findMessagesByRunId');
			}
		},

		findUndeliveredByRunId(runId: string): readonly RunMessageRecord[] {
			try {
				const stmt = getSelectUndeliveredStmt();
				const rows = stmt.all(runId) as readonly MessageRow[];
				return rows.map(mapMessageRow);
			} catch (cause) {
				throw toDatabaseError(cause, 'RunMessagesRepo.findUndeliveredByRunId');
			}
		},

		updateRunState(input: {
			readonly id: string;
			readonly fromState: RunState;
			readonly toState: RunState;
			readonly lastEventAt: string;
		}): void {
			try {
				const stmt = getUpdateRunStateStmt();
				stmt.run({
					id: input.id,
					fromState: input.fromState,
					toState: input.toState,
					lastEventAt: input.lastEventAt,
				});
			} catch (cause) {
				throw toDatabaseError(cause, 'RunMessagesRepo.updateRunState');
			}
		},
	};
}
