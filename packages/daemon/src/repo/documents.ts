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

	const insertStmt = prepareStatement(INSERT_SQL, 'insert document');
	const selectByIdStmt = prepareStatement(SELECT_BY_ID_SQL, 'select document by id');
	const selectByPathStmt = prepareStatement(SELECT_BY_PATH_SQL, 'select document by path');
	const selectAllStmt = prepareStatement(SELECT_ALL_SQL, 'select all documents');
	const updateMetadataStmt = prepareStatement(UPDATE_METADATA_SQL, 'update document metadata');
	const updateSourceReadableStmt = prepareStatement(
		UPDATE_SOURCE_READABLE_SQL,
		'update document source readable',
	);
	const updateLaneCountStmt = prepareStatement(UPDATE_LANE_COUNT_SQL, 'update document lane count');
	const updateTakeoverNotifiedStmt = prepareStatement(
		UPDATE_TAKEOVER_NOTIFIED_SQL,
		'update document takeover notified',
	);

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
			try {
				insertStmt.run(row);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to insert document: ${row.id}`);
			}
		},

		findById(id: string): DocumentRow | null {
			try {
				const row = selectByIdStmt.get(id) as DocumentRow | undefined;
				return row ? Object.freeze({ ...row }) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find document by id: ${id}`);
			}
		},

		findByPath(docsPath: string): DocumentRow | null {
			try {
				const row = selectByPathStmt.get(docsPath) as DocumentRow | undefined;
				return row ? Object.freeze({ ...row }) : null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to find document by path: ${docsPath}`);
			}
		},

		listAll(): readonly DocumentRow[] {
			try {
				const rows = selectAllStmt.all() as DocumentRow[];
				return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to list all documents');
			}
		},

		updateMetadata(row: DocumentMetadataUpdateRow): void {
			try {
				updateMetadataStmt.run(row);
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update document metadata: ${row.id}`);
			}
		},

		markSourceUnreadable(id: string, lastSeenAt: string): void {
			try {
				updateSourceReadableStmt.run({
					id,
					is_source_readable: 0,
					last_seen_at: lastSeenAt,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to mark document source unreadable: ${id}`);
			}
		},

		markSourceReadable(id: string, lastSeenAt: string): void {
			try {
				updateSourceReadableStmt.run({
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
			try {
				updateLaneCountStmt.run({
					id,
					lane_count: laneCount,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update lane count: ${id}`);
			}
		},

		setTakeoverNotified(id: string, isTakeoverNotified: number): void {
			try {
				updateTakeoverNotifiedStmt.run({
					id,
					is_takeover_notified: isTakeoverNotified === 1 ? 1 : 0,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update takeover notified: ${id}`);
			}
		},
	});
}
