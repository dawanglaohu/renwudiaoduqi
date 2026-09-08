import type { DatabaseConnection } from '../db/open-database.ts';
import { AppError } from '../errors/app-error.ts';

export interface DocumentRecord {
	readonly id: string;
	readonly docsPath: string;
	readonly projectName: string;
	readonly repoPath: string | null;
	readonly mainBranch: string;
	readonly branchPrefix: string;
	readonly laneCount: number;
	readonly contentFingerprint: string;
	readonly isSourceReadable: boolean;
	readonly isTakeoverNotified: boolean;
	readonly importedAt: string;
	readonly lastSeenAt: string;
}

export interface DocumentInsert {
	readonly id: string;
	readonly docsPath: string;
	readonly projectName: string;
	readonly repoPath?: string | null;
	readonly mainBranch?: string;
	readonly branchPrefix?: string;
	readonly laneCount?: number;
	readonly contentFingerprint: string;
	readonly isSourceReadable?: boolean;
	readonly isTakeoverNotified?: boolean;
	readonly importedAt: string;
	readonly lastSeenAt: string;
}

export interface DocumentMetadataUpdate {
	readonly id: string;
	readonly projectName: string;
	readonly repoPath: string | null;
	readonly mainBranch: string;
	readonly branchPrefix: string;
	readonly contentFingerprint: string;
	readonly isSourceReadable: boolean;
	readonly lastSeenAt: string;
}

interface DocumentRow {
	id: string;
	docs_path: string;
	project_name: string;
	repo_path: string | null;
	main_branch: string;
	branch_prefix: string;
	lane_count: number;
	content_fingerprint: string;
	is_source_readable: number;
	is_takeover_notified: number;
	imported_at: string;
	last_seen_at: string;
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
	@docsPath,
	@projectName,
	@repoPath,
	@mainBranch,
	@branchPrefix,
	@laneCount,
	@contentFingerprint,
	@isSourceReadable,
	@isTakeoverNotified,
	@importedAt,
	@lastSeenAt
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
	project_name = @projectName,
	repo_path = @repoPath,
	main_branch = @mainBranch,
	branch_prefix = @branchPrefix,
	content_fingerprint = @contentFingerprint,
	is_source_readable = @isSourceReadable,
	last_seen_at = @lastSeenAt
WHERE id = @id
`;

const UPDATE_SOURCE_READABLE_SQL = `
UPDATE documents
SET
	is_source_readable = @isSourceReadable,
	last_seen_at = @lastSeenAt
WHERE id = @id
`;

const UPDATE_LANE_COUNT_SQL = `
UPDATE documents
SET lane_count = @laneCount
WHERE id = @id
`;

const UPDATE_TAKEOVER_NOTIFIED_SQL = `
UPDATE documents
SET is_takeover_notified = @isTakeoverNotified
WHERE id = @id
`;

export interface DocumentsRepo {
	readonly insert: (doc: DocumentInsert) => void;
	readonly findById: (id: string) => DocumentRecord | null;
	readonly findByPath: (docsPath: string) => DocumentRecord | null;
	readonly listAll: () => readonly DocumentRecord[];
	readonly updateMetadata: (params: DocumentMetadataUpdate) => void;
	readonly markSourceUnreadable: (id: string, lastSeenAt: string) => void;
	readonly markSourceReadable: (id: string, lastSeenAt: string) => void;
	readonly updateLaneCount: (id: string, laneCount: number) => void;
	readonly setTakeoverNotified: (id: string, isTakeoverNotified: boolean) => void;
}

export function createDocumentsRepo(db: DatabaseConnection): DocumentsRepo {
	const insertStmt = db.prepare(INSERT_SQL);
	const selectByIdStmt = db.prepare(SELECT_BY_ID_SQL);
	const selectByPathStmt = db.prepare(SELECT_BY_PATH_SQL);
	const selectAllStmt = db.prepare(SELECT_ALL_SQL);
	const updateMetadataStmt = db.prepare(UPDATE_METADATA_SQL);
	const updateSourceReadableStmt = db.prepare(UPDATE_SOURCE_READABLE_SQL);
	const updateLaneCountStmt = db.prepare(UPDATE_LANE_COUNT_SQL);
	const updateTakeoverNotifiedStmt = db.prepare(UPDATE_TAKEOVER_NOTIFIED_SQL);

	function assertValidLaneCount(laneCount: number): void {
		if (!Number.isInteger(laneCount) || laneCount < 1 || laneCount > 6) {
			throw new AppError(
				'E_VALIDATION',
				`Invalid lane_count: ${laneCount}; must be between 1 and 6`,
			);
		}
	}

	return Object.freeze({
		insert(doc: DocumentInsert): void {
			const laneCount = doc.laneCount ?? 2;
			assertValidLaneCount(laneCount);

			insertStmt.run({
				id: doc.id,
				docsPath: doc.docsPath,
				projectName: doc.projectName,
				repoPath: doc.repoPath ?? null,
				mainBranch: doc.mainBranch ?? 'main',
				branchPrefix: doc.branchPrefix ?? 'task/',
				laneCount,
				contentFingerprint: doc.contentFingerprint,
				isSourceReadable: doc.isSourceReadable === false ? 0 : 1,
				isTakeoverNotified: doc.isTakeoverNotified ? 1 : 0,
				importedAt: doc.importedAt,
				lastSeenAt: doc.lastSeenAt,
			});
		},

		findById(id: string): DocumentRecord | null {
			const row = selectByIdStmt.get(id) as DocumentRow | undefined;
			return row ? mapRow(row) : null;
		},

		findByPath(docsPath: string): DocumentRecord | null {
			const row = selectByPathStmt.get(docsPath) as DocumentRow | undefined;
			return row ? mapRow(row) : null;
		},

		listAll(): readonly DocumentRecord[] {
			const rows = selectAllStmt.all() as DocumentRow[];
			return rows.map(mapRow);
		},

		updateMetadata(params: DocumentMetadataUpdate): void {
			updateMetadataStmt.run({
				id: params.id,
				projectName: params.projectName,
				repoPath: params.repoPath ?? null,
				mainBranch: params.mainBranch,
				branchPrefix: params.branchPrefix,
				contentFingerprint: params.contentFingerprint,
				isSourceReadable: params.isSourceReadable ? 1 : 0,
				lastSeenAt: params.lastSeenAt,
			});
		},

		markSourceUnreadable(id: string, lastSeenAt: string): void {
			updateSourceReadableStmt.run({
				id,
				isSourceReadable: 0,
				lastSeenAt,
			});
		},

		markSourceReadable(id: string, lastSeenAt: string): void {
			updateSourceReadableStmt.run({
				id,
				isSourceReadable: 1,
				lastSeenAt,
			});
		},

		updateLaneCount(id: string, laneCount: number): void {
			assertValidLaneCount(laneCount);
			updateLaneCountStmt.run({
				id,
				laneCount,
			});
		},

		setTakeoverNotified(id: string, isTakeoverNotified: boolean): void {
			updateTakeoverNotifiedStmt.run({
				id,
				isTakeoverNotified: isTakeoverNotified ? 1 : 0,
			});
		},
	});
}

function mapRow(row: DocumentRow): DocumentRecord {
	return Object.freeze({
		id: row.id,
		docsPath: row.docs_path,
		projectName: row.project_name,
		repoPath: row.repo_path,
		mainBranch: row.main_branch,
		branchPrefix: row.branch_prefix,
		laneCount: row.lane_count,
		contentFingerprint: row.content_fingerprint,
		isSourceReadable: row.is_source_readable === 1,
		isTakeoverNotified: row.is_takeover_notified === 1,
		importedAt: row.imported_at,
		lastSeenAt: row.last_seen_at,
	});
}
