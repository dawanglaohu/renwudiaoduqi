import { type DatabaseConnection, toDatabaseError } from '../db/open-database.ts';
import { AppError } from '../errors/app-error.ts';

export interface DocumentRow {
	readonly id: string;
	readonly docs_path: string;
	readonly project_name: string;
	readonly repo_path: string | null;
	readonly main_branch: string;
	readonly branch_prefix: string;
	readonly lane_count: number;
	readonly content_fingerprint: string;
	readonly is_source_readable: number;
	readonly is_takeover_notified: number;
	readonly imported_at: string;
	readonly last_seen_at: string;
}

export interface DocumentMetadataUpdateRow {
	readonly id: string;
	readonly project_name: string;
	readonly repo_path: string | null;
	readonly main_branch: string;
	readonly branch_prefix: string;
	readonly content_fingerprint: string;
	readonly is_source_readable: number;
	readonly last_seen_at: string;
}

const INSERT_SQL = `
INSERT INTO documents (
	id,
	docs_path,
	project_name,
	repo_path,
	main_branch,
	branch_prefix,
	lane_count,
	content_fingerprint,
	is_source_readable,
	is_takeover_notified,
	imported_at,
	last_seen_at
) VALUES (
	@id,
	@docs_path,
	@project_name,
	@repo_path,
	@main_branch,
	@branch_prefix,
	@lane_count,
	@content_fingerprint,
	@is_source_readable,
	@is_takeover_notified,
	@imported_at,
	@last_seen_at
)
`;

const SELECT_BY_ID_SQL = `
SELECT
	id,
	docs_path,
	project_name,
	repo_path,
	main_branch,
	branch_prefix,
	lane_count,
	content_fingerprint,
	is_source_readable,
	is_takeover_notified,
	imported_at,
	last_seen_at
FROM documents
WHERE id = ?
LIMIT 1
`;

const SELECT_BY_PATH_SQL = `
SELECT
	id,
	docs_path,
	project_name,
	repo_path,
	main_branch,
	branch_prefix,
	lane_count,
	content_fingerprint,
	is_source_readable,
	is_takeover_notified,
	imported_at,
	last_seen_at
FROM documents
WHERE docs_path = ?
LIMIT 1
`;

const SELECT_ALL_SQL = `
SELECT
	id,
	docs_path,
	project_name,
	repo_path,
	main_branch,
	branch_prefix,
	lane_count,
	content_fingerprint,
	is_source_readable,
	is_takeover_notified,
	imported_at,
	last_seen_at
FROM documents
ORDER BY imported_at ASC
`;

const UPDATE_METADATA_SQL = `
UPDATE documents
SET
	project_name = @project_name,
	repo_path = @repo_path,
	main_branch = @main_branch,
	branch_prefix = @branch_prefix,
	content_fingerprint = @content_fingerprint,
	is_source_readable = @is_source_readable,
	last_seen_at = @last_seen_at
WHERE id = @id
`;

const UPDATE_SOURCE_READABLE_SQL = `
UPDATE documents
SET
	is_source_readable = @is_source_readable,
	last_seen_at = @last_seen_at
WHERE id = @id
`;

const UPDATE_LANE_COUNT_SQL = `
UPDATE documents
SET lane_count = @lane_count
WHERE id = @id
`;

const UPDATE_TAKEOVER_NOTIFIED_SQL = `
UPDATE documents
SET is_takeover_notified = @is_takeover_notified
WHERE id = @id
`;

const TABLE_EXISTS_SQL = `
SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'
`;

export interface DocumentsRepo {
	readonly insert: (row: DocumentRow) => void;
	readonly findById: (id: string) => DocumentRow | null;
	readonly findByPath: (docsPath: string) => DocumentRow | null;
	readonly listAll: () => readonly DocumentRow[];
	readonly updateMetadata: (row: DocumentMetadataUpdateRow) => void;
	readonly markSourceUnreadable: (id: string, lastSeenAt: string) => void;
	readonly markSourceReadable: (id: string, lastSeenAt: string) => void;
	readonly updateLaneCount: (id: string, laneCount: number) => void;
	readonly setTakeoverNotified: (id: string, isTakeoverNotified: number) => void;
}

export function createDocumentsRepo(db: DatabaseConnection): DocumentsRepo {
	function prepareStatement(sql: string, description: string) {
		try {
			return db.prepare(sql);
		} catch (cause) {
			throw toDatabaseError(cause, `Failed to prepare SQL for ${description}`);
		}
	}

	type Statement = ReturnType<typeof prepareStatement>;
	let tableExistsStmt: Statement | null = null;
	let insertStmt: Statement | null = null;
	let selectByIdStmt: Statement | null = null;
	let selectByPathStmt: Statement | null = null;
	let selectAllStmt: Statement | null = null;
	let updateMetadataStmt: Statement | null = null;
	let updateSourceReadableStmt: Statement | null = null;
	let updateLaneCountStmt: Statement | null = null;
	let updateTakeoverNotifiedStmt: Statement | null = null;

	function hasDocumentsTable(): boolean {
		try {
			if (!tableExistsStmt) {
				tableExistsStmt = db.prepare(TABLE_EXISTS_SQL);
			}
			const row = tableExistsStmt.get();
			return row !== undefined;
		} catch {
			return false;
		}
	}

	function getInsertStmt(): Statement {
		if (!insertStmt) insertStmt = prepareStatement(INSERT_SQL, 'insert document');
		return insertStmt;
	}

	function getSelectByIdStmt(): Statement {
		if (!selectByIdStmt)
			selectByIdStmt = prepareStatement(SELECT_BY_ID_SQL, 'select document by id');
		return selectByIdStmt;
	}

	function getSelectByPathStmt(): Statement {
		if (!selectByPathStmt)
			selectByPathStmt = prepareStatement(SELECT_BY_PATH_SQL, 'select document by path');
		return selectByPathStmt;
	}

	function getSelectAllStmt(): Statement {
		if (!selectAllStmt) selectAllStmt = prepareStatement(SELECT_ALL_SQL, 'select all documents');
		return selectAllStmt;
	}

	function getUpdateMetadataStmt(): Statement {
		if (!updateMetadataStmt)
			updateMetadataStmt = prepareStatement(UPDATE_METADATA_SQL, 'update document metadata');
		return updateMetadataStmt;
	}

	function getUpdateSourceReadableStmt(): Statement {
		if (!updateSourceReadableStmt) {
			updateSourceReadableStmt = prepareStatement(
				UPDATE_SOURCE_READABLE_SQL,
				'update document source readable',
			);
		}
		return updateSourceReadableStmt;
	}

	function getUpdateLaneCountStmt(): Statement {
		if (!updateLaneCountStmt) {
			updateLaneCountStmt = prepareStatement(UPDATE_LANE_COUNT_SQL, 'update document lane count');
		}
		return updateLaneCountStmt;
	}

	function getUpdateTakeoverNotifiedStmt(): Statement {
		if (!updateTakeoverNotifiedStmt) {
			updateTakeoverNotifiedStmt = prepareStatement(
				UPDATE_TAKEOVER_NOTIFIED_SQL,
				'update document takeover notified',
			);
		}
		return updateTakeoverNotifiedStmt;
	}

	function assertValidLaneCount(laneCount: number): void {
		if (!Number.isInteger(laneCount) || laneCount < 1 || laneCount > 6) {
			throw new AppError(
				'E_VALIDATION',
				`Invalid lane_count: ${laneCount}; must be between 1 and 6`,
			);
		}
	}

	return Object.freeze({
		insert(row: DocumentRow): void {
			assertValidLaneCount(row.lane_count);
			if (!hasDocumentsTable()) return;
			try {
				getInsertStmt().run(row);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to insert document: ${row.id}`);
			}
		},

		findById(id: string): DocumentRow | null {
			if (!hasDocumentsTable()) return null;
			try {
				const row = getSelectByIdStmt().get(id) as DocumentRow | undefined;
				return row ? Object.freeze({ ...row }) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find document by id: ${id}`);
			}
		},

		findByPath(docsPath: string): DocumentRow | null {
			if (!hasDocumentsTable()) return null;
			try {
				const row = getSelectByPathStmt().get(docsPath) as DocumentRow | undefined;
				return row ? Object.freeze({ ...row }) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find document by path: ${docsPath}`);
			}
		},

		listAll(): readonly DocumentRow[] {
			if (!hasDocumentsTable()) return Object.freeze([]);
			try {
				const rows = getSelectAllStmt().all() as DocumentRow[];
				return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to list all documents');
			}
		},

		updateMetadata(row: DocumentMetadataUpdateRow): void {
			if (!hasDocumentsTable()) return;
			try {
				getUpdateMetadataStmt().run(row);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update document metadata: ${row.id}`);
			}
		},

		markSourceUnreadable(id: string, lastSeenAt: string): void {
			if (!hasDocumentsTable()) return;
			try {
				getUpdateSourceReadableStmt().run({
					id,
					is_source_readable: 0,
					last_seen_at: lastSeenAt,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to mark document source unreadable: ${id}`);
			}
		},

		markSourceReadable(id: string, lastSeenAt: string): void {
			if (!hasDocumentsTable()) return;
			try {
				getUpdateSourceReadableStmt().run({
					id,
					is_source_readable: 1,
					last_seen_at: lastSeenAt,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to mark document source readable: ${id}`);
			}
		},

		updateLaneCount(id: string, laneCount: number): void {
			assertValidLaneCount(laneCount);
			if (!hasDocumentsTable()) return;
			try {
				getUpdateLaneCountStmt().run({
					id,
					lane_count: laneCount,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update lane count: ${id}`);
			}
		},

		setTakeoverNotified(id: string, isTakeoverNotified: number): void {
			if (!hasDocumentsTable()) return;
			try {
				getUpdateTakeoverNotifiedStmt().run({
					id,
					is_takeover_notified: isTakeoverNotified === 1 ? 1 : 0,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update takeover notified: ${id}`);
			}
		},
	});
}
