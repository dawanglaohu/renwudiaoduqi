import type { BatchWrapupDto, BatchWrapupLandingDto } from '@agent-scheduler/shared/api/batches';
import type { DatabaseConnection } from '../db/open-database.ts';
import { toDatabaseError } from '../db/open-database.ts';

export interface BatchWrapupRow {
	readonly id: string;
	readonly batch_id: string;
	readonly batch_no: number;
	readonly tasks_json: string;
	readonly round: number;
	readonly run_id: string;
	readonly verdict: 'clean' | 'fixed' | 'open';
	readonly declared_verdict: string | null;
	readonly is_human_verdict: number;
	readonly prompt_source: 'docs' | 'builtin';
	readonly tests_json: string;
	readonly summary_text: string;
	readonly findings_json: string;
	readonly unassigned_json: string;
	readonly fix_run_ids_json: string;
	readonly report_text: string;
	readonly created_at: string;
}

export interface BatchWrapupInsertRow {
	readonly id: string;
	readonly batch_id: string;
	readonly batch_no: number;
	readonly tasks_json: string;
	readonly round: number;
	readonly run_id: string;
	readonly verdict: 'clean' | 'fixed' | 'open';
	readonly declared_verdict?: string | null;
	readonly is_human_verdict?: number;
	readonly prompt_source: 'docs' | 'builtin';
	readonly tests_json: string;
	readonly summary_text: string;
	readonly findings_json: string;
	readonly unassigned_json: string;
	readonly fix_run_ids_json: string;
	readonly report_text: string;
	readonly created_at: string;
}

export interface BatchWrapupsRepo {
	readonly insert: (row: BatchWrapupInsertRow) => void;
	readonly findById: (id: string) => BatchWrapupRow | null;
	readonly findByRunId: (runId: string) => BatchWrapupRow | null;
	readonly listByBatchId: (batchId: string) => readonly BatchWrapupRow[];
	readonly findLatestByBatchId: (batchId: string) => BatchWrapupRow | null;
	readonly getMaxRound: (batchId: string) => number;
}

const INSERT_WRAPUP_SQL = `
INSERT INTO batch_wrapups (
	id, batch_id, batch_no, tasks_json, round, run_id, verdict,
	declared_verdict, is_human_verdict, prompt_source, tests_json,
	summary_text, findings_json, unassigned_json, fix_run_ids_json,
	report_text, created_at
) VALUES (
	@id, @batch_id, @batch_no, @tasks_json, @round, @run_id, @verdict,
	@declared_verdict, @is_human_verdict, @prompt_source, @tests_json,
	@summary_text, @findings_json, @unassigned_json, @fix_run_ids_json,
	@report_text, @created_at
)
`;

const SELECT_BY_ID_SQL = `
SELECT * FROM batch_wrapups WHERE id = ? LIMIT 1
`;

const SELECT_BY_RUN_ID_SQL = `
SELECT * FROM batch_wrapups WHERE run_id = ? LIMIT 1
`;

const SELECT_BY_BATCH_ID_SQL = `
SELECT * FROM batch_wrapups WHERE batch_id = ? ORDER BY round ASC, created_at ASC
`;

const SELECT_LATEST_BY_BATCH_ID_SQL = `
SELECT * FROM batch_wrapups WHERE batch_id = ? ORDER BY round DESC, created_at DESC LIMIT 1
`;

const SELECT_MAX_ROUND_SQL = `
SELECT COALESCE(MAX(round), 0) as max_round FROM batch_wrapups WHERE batch_id = ?
`;

function freezeRow(row: BatchWrapupRow): BatchWrapupRow {
	return Object.freeze({ ...row });
}

export function toBatchWrapupDto(
	row: BatchWrapupRow,
	landing?: BatchWrapupLandingDto | null,
): BatchWrapupDto {
	let tasks: readonly string[] = [];
	try {
		tasks = JSON.parse(row.tasks_json);
	} catch {
		tasks = [];
	}

	let tests: BatchWrapupDto['tests'] = { status: 'unknown', items: [] };
	try {
		tests = JSON.parse(row.tests_json);
	} catch {
		tests = { status: 'unknown', items: [] };
	}

	let findings: readonly unknown[] = [];
	try {
		findings = JSON.parse(row.findings_json);
	} catch {
		findings = [];
	}

	let unassigned: readonly string[] = [];
	try {
		unassigned = JSON.parse(row.unassigned_json);
	} catch {
		unassigned = [];
	}

	let fixRunIds: readonly string[] = [];
	try {
		fixRunIds = JSON.parse(row.fix_run_ids_json);
	} catch {
		fixRunIds = [];
	}

	return Object.freeze({
		id: row.id,
		batchId: row.batch_id,
		batchNo: row.batch_no,
		tasks: Object.freeze(tasks),
		round: row.round,
		runId: row.run_id,
		verdict: row.verdict,
		declaredVerdict: (row.declared_verdict as BatchWrapupDto['declaredVerdict']) ?? null,
		isHumanVerdict: row.is_human_verdict === 1,
		promptSource: row.prompt_source,
		tests: Object.freeze(tests),
		summaryText: row.summary_text,
		findings: Object.freeze(findings),
		unassigned: Object.freeze(unassigned),
		fixRunIds: Object.freeze(fixRunIds),
		reportText: row.report_text,
		createdAt: row.created_at,
		landing: landing ?? null,
	});
}

export function createBatchWrapupsRepo(db: DatabaseConnection): BatchWrapupsRepo {
	const insertStmt = db.prepare(INSERT_WRAPUP_SQL);
	const selectByIdStmt = db.prepare(SELECT_BY_ID_SQL);
	const selectByRunIdStmt = db.prepare(SELECT_BY_RUN_ID_SQL);
	const selectByBatchIdStmt = db.prepare(SELECT_BY_BATCH_ID_SQL);
	const selectLatestByBatchIdStmt = db.prepare(SELECT_LATEST_BY_BATCH_ID_SQL);
	const selectMaxRoundStmt = db.prepare(SELECT_MAX_ROUND_SQL);

	return Object.freeze({
		insert(row: BatchWrapupInsertRow): void {
			try {
				insertStmt.run({
					id: row.id,
					batch_id: row.batch_id,
					batch_no: row.batch_no,
					tasks_json: row.tasks_json,
					round: row.round,
					run_id: row.run_id,
					verdict: row.verdict,
					declared_verdict: row.declared_verdict ?? null,
					is_human_verdict: row.is_human_verdict ?? 0,
					prompt_source: row.prompt_source,
					tests_json: row.tests_json,
					summary_text: row.summary_text,
					findings_json: row.findings_json,
					unassigned_json: row.unassigned_json,
					fix_run_ids_json: row.fix_run_ids_json,
					report_text: row.report_text,
					created_at: row.created_at,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to insert batch_wrapup: id=${row.id}`);
			}
		},

		findById(id: string): BatchWrapupRow | null {
			try {
				const row = selectByIdStmt.get(id) as BatchWrapupRow | undefined;
				return row ? freezeRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find batch_wrapup by id: ${id}`);
			}
		},

		findByRunId(runId: string): BatchWrapupRow | null {
			try {
				const row = selectByRunIdStmt.get(runId) as BatchWrapupRow | undefined;
				return row ? freezeRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find batch_wrapup by runId: ${runId}`);
			}
		},

		listByBatchId(batchId: string): readonly BatchWrapupRow[] {
			try {
				const rows = selectByBatchIdStmt.all(batchId) as BatchWrapupRow[];
				return Object.freeze(rows.map(freezeRow));
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to list batch_wrapups for batch: ${batchId}`);
			}
		},

		findLatestByBatchId(batchId: string): BatchWrapupRow | null {
			try {
				const row = selectLatestByBatchIdStmt.get(batchId) as BatchWrapupRow | undefined;
				return row ? freezeRow(row) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find latest batch_wrapup for batch: ${batchId}`);
			}
		},

		getMaxRound(batchId: string): number {
			try {
				const result = selectMaxRoundStmt.get(batchId) as { max_round: number } | undefined;
				return result?.max_round ?? 0;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to get max round for batch: ${batchId}`);
			}
		},
	});
}
