import type { DatabaseConnection } from '../db/open-database.ts';

export interface GateRow {
	readonly id: string;
	readonly task_id: string;
	readonly run_id: string | null;
	readonly kind: string;
	readonly state: string;
	readonly decision: string | null;
	readonly comment: string | null;
	readonly decided_by_device_id: string | null;
	readonly created_at: string;
	readonly decided_at: string | null;
}

export interface GateInsertRow {
	readonly id: string;
	readonly task_id: string;
	readonly run_id?: string | null;
	readonly kind: string;
	readonly state: string;
	readonly decision?: string | null;
	readonly comment?: string | null;
	readonly decided_by_device_id?: string | null;
	readonly created_at: string;
	readonly decided_at?: string | null;
}

export interface GatesRepo {
	readonly findById: (id: string) => GateRow | null;
	readonly findLatestByTaskIdAndKind: (taskId: string, kind: string) => GateRow | null;
	readonly list: (params?: { pendingOnly?: boolean }) => readonly GateRow[];
	readonly create: (gate: GateInsertRow) => void;
	readonly updateDecision: (
		id: string,
		decision: string,
		comment: string | null,
		decidedByDeviceId: string | null,
		decidedAt: string,
	) => boolean;
}

const SELECT_BY_ID_SQL = `
SELECT id, task_id, run_id, kind, state, decision, comment, decided_by_device_id, created_at, decided_at
FROM gates
WHERE id = ?
`;

const SELECT_LATEST_BY_TASK_AND_KIND_SQL = `
SELECT id, task_id, run_id, kind, state, decision, comment, decided_by_device_id, created_at, decided_at
FROM gates
WHERE task_id = ? AND kind = ?
ORDER BY created_at DESC
LIMIT 1
`;

const SELECT_ALL_SQL = `
SELECT id, task_id, run_id, kind, state, decision, comment, decided_by_device_id, created_at, decided_at
FROM gates
ORDER BY created_at ASC
`;

const SELECT_PENDING_SQL = `
SELECT id, task_id, run_id, kind, state, decision, comment, decided_by_device_id, created_at, decided_at
FROM gates
WHERE state = 'waiting'
ORDER BY created_at ASC
`;

const INSERT_GATE_SQL = `
INSERT INTO gates (
	id, task_id, run_id, kind, state, decision, comment, decided_by_device_id, created_at, decided_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_DECISION_SQL = `
UPDATE gates
SET state = 'decided',
	decision = ?,
	comment = ?,
	decided_by_device_id = ?,
	decided_at = ?
WHERE id = ? AND state = 'waiting'
`;

export function createGatesRepo(db: DatabaseConnection): GatesRepo {
	const selectByIdStmt = db.prepare<[string], GateRow>(SELECT_BY_ID_SQL);
	const selectLatestStmt = db.prepare<[string, string], GateRow>(
		SELECT_LATEST_BY_TASK_AND_KIND_SQL,
	);
	const selectAllStmt = db.prepare<[], GateRow>(SELECT_ALL_SQL);
	const selectPendingStmt = db.prepare<[], GateRow>(SELECT_PENDING_SQL);
	const insertStmt =
		db.prepare<
			[
				string,
				string,
				string | null,
				string,
				string,
				string | null,
				string | null,
				string | null,
				string,
				string | null,
			]
		>(INSERT_GATE_SQL);
	const updateDecisionStmt =
		db.prepare<[string, string | null, string | null, string, string]>(UPDATE_DECISION_SQL);

	return Object.freeze({
		findById(id: string): GateRow | null {
			const row = selectByIdStmt.get(id);
			return row ?? null;
		},

		findLatestByTaskIdAndKind(taskId: string, kind: string): GateRow | null {
			const row = selectLatestStmt.get(taskId, kind);
			return row ?? null;
		},

		list(params?: { pendingOnly?: boolean }): readonly GateRow[] {
			if (params?.pendingOnly) {
				return selectPendingStmt.all();
			}
			return selectAllStmt.all();
		},

		create(gate: GateInsertRow): void {
			insertStmt.run(
				gate.id,
				gate.task_id,
				gate.run_id ?? null,
				gate.kind,
				gate.state,
				gate.decision ?? null,
				gate.comment ?? null,
				gate.decided_by_device_id ?? null,
				gate.created_at,
				gate.decided_at ?? null,
			);
		},

		updateDecision(
			id: string,
			decision: string,
			comment: string | null,
			decidedByDeviceId: string | null,
			decidedAt: string,
		): boolean {
			const result = updateDecisionStmt.run(decision, comment, decidedByDeviceId, decidedAt, id);
			return result.changes > 0;
		},
	});
}
