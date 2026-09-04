import { join } from 'node:path';
import type { DatabaseConnection } from './open-database.ts';
import { toDatabaseError } from './open-database.ts';

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/;

const CREATE_MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
	version TEXT PRIMARY KEY,
	applied_at TEXT NOT NULL
)
`;

const READ_APPLIED_MIGRATIONS_SQL = 'SELECT version FROM schema_migrations';
const RECORD_MIGRATION_SQL = 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)';

interface MigrationRow {
	readonly version: string;
}

export interface MigrationClock {
	readonly now: () => string;
}

export interface MigrationFileSystem {
	readonly readDirectory: (directory: string) => readonly string[];
	readonly readFile: (path: string) => string;
}

export interface MigrationRunnerDependencies {
	readonly clock: MigrationClock;
	readonly database: DatabaseConnection;
	readonly fileSystem: MigrationFileSystem;
}

export interface MigrationResult {
	readonly appliedVersions: readonly string[];
}

export interface MigrationRunner {
	readonly run: (directory: string) => MigrationResult;
}

export function createMigrationRunner(dependencies: MigrationRunnerDependencies): MigrationRunner {
	return Object.freeze({
		run(directory: string): MigrationResult {
			try {
				dependencies.database.exec(CREATE_MIGRATION_TABLE_SQL);
				const readApplied = dependencies.database.prepare<[], MigrationRow>(
					READ_APPLIED_MIGRATIONS_SQL,
				);
				const recordMigration =
					dependencies.database.prepare<[string, string]>(RECORD_MIGRATION_SQL);
				const applied = new Set(readApplied.all().map((row) => row.version));
				const migrationFiles = dependencies.fileSystem
					.readDirectory(directory)
					.filter((fileName) => MIGRATION_FILE_PATTERN.test(fileName))
					.sort(compareFileNames);
				const appliedVersions: string[] = [];
				const applyMigration = dependencies.database.transaction(
					(version: string, source: string, appliedAt: string) => {
						dependencies.database.exec(source);
						recordMigration.run(version, appliedAt);
					},
				);

				for (const fileName of migrationFiles) {
					if (applied.has(fileName)) continue;
					const source = dependencies.fileSystem.readFile(join(directory, fileName));
					const appliedAt = dependencies.clock.now();
					applyMigration.immediate(fileName, source, appliedAt);
					appliedVersions.push(fileName);
				}

				return Object.freeze({ appliedVersions: Object.freeze(appliedVersions) });
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to migrate SQLite database.');
			}
		},
	});
}

function compareFileNames(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
