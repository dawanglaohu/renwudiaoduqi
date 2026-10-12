import type { DocumentExecutionState } from '@agent-scheduler/shared/api/document-execution';
import { type DatabaseConnection, toDatabaseError } from '../db/open-database.ts';

export interface DocumentExecutionRow {
	readonly doc_id: string;
	readonly state: DocumentExecutionState;
	readonly version: number;
	readonly content_fingerprint: string | null;
	readonly plan_json: string;
	readonly default_assignment_json: string | null;
	readonly current_batch_id: string | null;
	readonly pause_reason: string | null;
	readonly started_at: string | null;
	readonly updated_at: string;
	readonly completed_at: string | null;
}

export interface DocumentExecutionsRepo {
	readonly findByDocId: (docId: string) => DocumentExecutionRow | null;
	readonly listAll: () => readonly DocumentExecutionRow[];
	readonly save: (row: DocumentExecutionRow) => void;
	readonly pauseRunningOnRestart: (updatedAt: string) => readonly string[];
}

const FIND_SQL = 'SELECT * FROM document_executions WHERE doc_id = ? LIMIT 1';
const LIST_SQL = 'SELECT * FROM document_executions ORDER BY doc_id';
const SAVE_SQL = `
INSERT INTO document_executions (
 doc_id, state, version, content_fingerprint, plan_json, default_assignment_json,
 current_batch_id, pause_reason, started_at, updated_at, completed_at
) VALUES (
 @doc_id, @state, @version, @content_fingerprint, @plan_json, @default_assignment_json,
 @current_batch_id, @pause_reason, @started_at, @updated_at, @completed_at
)
ON CONFLICT(doc_id) DO UPDATE SET
 state = excluded.state, version = excluded.version,
 content_fingerprint = excluded.content_fingerprint, plan_json = excluded.plan_json,
 default_assignment_json = excluded.default_assignment_json,
 current_batch_id = excluded.current_batch_id, pause_reason = excluded.pause_reason,
 started_at = excluded.started_at, updated_at = excluded.updated_at,
 completed_at = excluded.completed_at
WHERE document_executions.version < excluded.version
`;
const PAUSE_RESTART_SQL = `
UPDATE document_executions SET state = 'paused', version = version + 1,
 pause_reason = 'daemon_restarted', updated_at = ?
WHERE state = 'running'
`;

export function createDocumentExecutionsRepo(db: DatabaseConnection): DocumentExecutionsRepo {
	const find = db.prepare(FIND_SQL);
	const list = db.prepare(LIST_SQL);
	const save = db.prepare(SAVE_SQL);
	const pause = db.prepare(PAUSE_RESTART_SQL);
	return Object.freeze({
		findByDocId(docId: string) {
			try {
				return (find.get(docId) as DocumentExecutionRow | undefined) ?? null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to read document execution: ${docId}`);
			}
		},
		listAll() {
			try {
				return list.all() as readonly DocumentExecutionRow[];
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to list document executions');
			}
		},
		save(row: DocumentExecutionRow) {
			try {
				save.run(row);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to save document execution: ${row.doc_id}`);
			}
		},
		pauseRunningOnRestart(updatedAt: string) {
			try {
				const ids = (list.all() as DocumentExecutionRow[])
					.filter((row) => row.state === 'running')
					.map((row) => row.doc_id);
				pause.run(updatedAt);
				return ids;
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to pause document executions on restart');
			}
		},
	});
}
