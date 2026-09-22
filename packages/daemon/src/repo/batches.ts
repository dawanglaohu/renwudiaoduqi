import { BATCH_STATES, type BatchState } from '@agent-scheduler/shared/api/batches';
import { type DatabaseConnection, toDatabaseError } from '../db/open-database.ts';
import { AppError } from '../errors/app-error.ts';

export { BATCH_STATES, type BatchState };
export const VALID_BATCH_STATES = BATCH_STATES;

export interface BatchRow {
	readonly id: string;
	readonly doc_id: string;
	readonly batch_no: number;
	readonly state: BatchState;
	readonly started_at: string | null;
	readonly finished_at: string | null;
}

export interface BatchInsertRow {
	readonly id: string;
	readonly doc_id: string;
	readonly batch_no: number;
	readonly state?: BatchState;
	readonly started_at?: string | null;
	readonly finished_at?: string | null;
}

export interface BatchUpdateStateParams {
	readonly id: string;
	readonly state: BatchState;
	readonly started_at?: string | null;
	readonly finished_at?: string | null;
}

const INSERT_SQL = `
INSERT INTO batches (
	id,
	doc_id,
	batch_no,
	state,
	started_at,
	finished_at
) VALUES (
	@id,
	@doc_id,
	@batch_no,
	@state,
	@started_at,
	@finished_at
)
`;

const SELECT_BY_ID_SQL = `
SELECT
	id,
	doc_id,
	batch_no,
	state,
	started_at,
	finished_at
FROM batches
WHERE id = ?
LIMIT 1
`;

const SELECT_BY_DOC_AND_BATCH_NO_SQL = `
SELECT
	id,
	doc_id,
	batch_no,
	state,
	started_at,
	finished_at
FROM batches
WHERE doc_id = ? AND batch_no = ?
LIMIT 1
`;

const SELECT_BY_DOC_ID_SQL = `
SELECT
	id,
	doc_id,
	batch_no,
	state,
	started_at,
	finished_at
FROM batches
WHERE doc_id = ?
ORDER BY batch_no ASC
`;

const UPDATE_STATE_SQL = `
UPDATE batches
SET
	state = @state,
	started_at = @started_at,
	finished_at = @finished_at
WHERE id = @id
`;

const DELETE_BY_ID_SQL = `
DELETE FROM batches
WHERE id = ?
`;

const DELETE_BY_DOC_ID_SQL = `
DELETE FROM batches
WHERE doc_id = ?
`;

function assertValidBatchState(state: string): asserts state is BatchState {
	if (!VALID_BATCH_STATES.includes(state as BatchState)) {
		throw new AppError('E_VALIDATION', `Invalid batch state: ${state}`);
	}
}

function assertValidBatchNo(batchNo: number): void {
	if (!Number.isInteger(batchNo) || batchNo < 1) {
		throw new AppError('E_VALIDATION', `Invalid batch_no: ${batchNo}; must be an integer >= 1`);
	}
}

export interface BatchesRepo {
	readonly insert: (row: BatchInsertRow) => void;
	readonly findById: (id: string) => BatchRow | null;
	readonly findByDocAndBatchNo: (docId: string, batchNo: number) => BatchRow | null;
	readonly listByDocId: (docId: string) => readonly BatchRow[];
	readonly updateState: (params: BatchUpdateStateParams) => void;
	readonly deleteById: (id: string) => void;
	readonly deleteByDocId: (docId: string) => void;
	readonly ensureBatchesForDoc: (
		docId: string,
		batchNos: readonly number[],
		idGenerator: () => string,
	) => Map<number, BatchRow>;
}

export function createBatchesRepo(db: DatabaseConnection): BatchesRepo {
	const insertStmt = db.prepare(INSERT_SQL);
	const selectByIdStmt = db.prepare(SELECT_BY_ID_SQL);
	const selectByDocAndBatchNoStmt = db.prepare(SELECT_BY_DOC_AND_BATCH_NO_SQL);
	const selectByDocIdStmt = db.prepare(SELECT_BY_DOC_ID_SQL);
	const updateStateStmt = db.prepare(UPDATE_STATE_SQL);
	const deleteByIdStmt = db.prepare(DELETE_BY_ID_SQL);
	const deleteByDocIdStmt = db.prepare(DELETE_BY_DOC_ID_SQL);

	return Object.freeze({
		insert(row: BatchInsertRow): void {
			assertValidBatchNo(row.batch_no);
			const state = row.state ?? 'idle';
			assertValidBatchState(state);

			try {
				insertStmt.run({
					id: row.id,
					doc_id: row.doc_id,
					batch_no: row.batch_no,
					state,
					started_at: row.started_at ?? null,
					finished_at: row.finished_at ?? null,
				});
			} catch (cause) {
				throw toDatabaseError(
					cause,
					`Failed to insert batch: docId=${row.doc_id}, batchNo=${row.batch_no}`,
				);
			}
		},

		findById(id: string): BatchRow | null {
			try {
				const row = selectByIdStmt.get(id) as BatchRow | undefined;
				return row ? Object.freeze({ ...row }) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find batch by id: ${id}`);
			}
		},

		findByDocAndBatchNo(docId: string, batchNo: number): BatchRow | null {
			try {
				const row = selectByDocAndBatchNoStmt.get(docId, batchNo) as BatchRow | undefined;
				return row ? Object.freeze({ ...row }) : null;
			} catch (cause) {
				throw toDatabaseError(
					cause,
					`Failed to find batch by docId and batchNo: ${docId}, ${batchNo}`,
				);
			}
		},

		listByDocId(docId: string): readonly BatchRow[] {
			try {
				const rows = selectByDocIdStmt.all(docId) as BatchRow[];
				return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to list batches for docId: ${docId}`);
			}
		},

		updateState(params: BatchUpdateStateParams): void {
			assertValidBatchState(params.state);
			try {
				updateStateStmt.run({
					id: params.id,
					state: params.state,
					started_at: params.started_at ?? null,
					finished_at: params.finished_at ?? null,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update batch state: ${params.id}`);
			}
		},

		deleteById(id: string): void {
			try {
				deleteByIdStmt.run(id);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to delete batch by id: ${id}`);
			}
		},

		deleteByDocId(docId: string): void {
			try {
				deleteByDocIdStmt.run(docId);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to delete batches by docId: ${docId}`);
			}
		},

		ensureBatchesForDoc(
			docId: string,
			batchNos: readonly number[],
			idGenerator: () => string,
		): Map<number, BatchRow> {
			try {
				const existingRows = selectByDocIdStmt.all(docId) as BatchRow[];
				const map = new Map<number, BatchRow>();
				for (const row of existingRows) {
					map.set(row.batch_no, Object.freeze({ ...row }));
				}

				for (const batchNo of batchNos) {
					assertValidBatchNo(batchNo);
					if (!map.has(batchNo)) {
						const newRow: BatchRow = Object.freeze({
							id: idGenerator(),
							doc_id: docId,
							batch_no: batchNo,
							state: 'idle',
							started_at: null,
							finished_at: null,
						});
						insertStmt.run(newRow);
						map.set(batchNo, newRow);
					}
				}

				return map;
			} catch (cause) {
				if (cause instanceof AppError) throw cause;
				throw toDatabaseError(cause, `Failed to ensure batches for document: ${docId}`);
			}
		},
	});
}
