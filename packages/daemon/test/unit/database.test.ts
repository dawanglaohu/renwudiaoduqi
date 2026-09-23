import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '@agent-scheduler/shared/errors/codes';
import { afterEach, describe, expect, it } from 'vitest';
import { type MigrationFileSystem, createMigrationRunner } from '../../src/db/migrate.ts';
import {
	type DatabaseConnection,
	type DatabaseOpener,
	openDatabase,
} from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { AppError } from '../../src/errors/app-error.ts';

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseConnection[] = [];
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

afterEach(() => {
	for (const database of openDatabases.splice(0)) {
		if (database.open) database.close();
	}
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe('SQLite connection factory', () => {
	it('issues exactly the four required PRAGMA statements', () => {
		const pragmas: string[] = [];
		const database = {
			pragma(source: string) {
				pragmas.push(source);
			},
		} as unknown as DatabaseConnection;

		expect(openDatabase('unused.db', { open: () => database })).toBe(database);
		expect(pragmas).toEqual([
			'journal_mode = WAL',
			'busy_timeout = 5000',
			'foreign_keys = ON',
			'synchronous = NORMAL',
		]);
	});

	it('makes all four configured PRAGMA values queryable', () => {
		const database = createTemporaryDatabase();

		expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
		expect(database.pragma('busy_timeout', { simple: true })).toBe(5_000);
		expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
		expect(database.pragma('synchronous', { simple: true })).toBe(1);
	});

	it.each(['ERR_DLOPEN_FAILED', 'MODULE_NOT_FOUND'])(
		'E-152 converts native loading failure %s into rebuild guidance without leaking its message',
		(code) => {
			const nativeFailure = Object.assign(new Error('native ABI stack must stay internal'), {
				code,
			});
			const opener: DatabaseOpener = {
				open() {
					throw nativeFailure;
				},
			};

			const failure = captureFailure(() => openDatabase('unused.db', opener));

			expect(failure).toBeInstanceOf(AppError);
			expect(failure).toMatchObject({
				code: 'E_INTERNAL',
				retryable: false,
				details: { remediation: 'pnpm rebuild' },
				cause: nativeFailure,
			});
			expect(failure.message).toContain('pnpm rebuild');
			expect(failure.message).not.toContain(nativeFailure.message);
		},
	);
});

describe('migration runner', () => {
	it('applies migrations in filename order and records them in schema_migrations', () => {
		const database = createTemporaryDatabase();
		const fileSystem = createMemoryMigrationFileSystem({
			'0002_second.sql': "INSERT INTO migration_order (step) VALUES ('second')",
			'notes.txt': 'ignored',
			'0001_first.sql':
				"CREATE TABLE migration_order (step TEXT NOT NULL); INSERT INTO migration_order (step) VALUES ('first')",
		});
		const appliedTimes = ['2026-09-04T01:00:00.000Z', '2026-09-04T01:00:01.000Z'];
		let clockIndex = 0;
		const runner = createMigrationRunner({
			clock: { now: () => appliedTimes[clockIndex++] ?? 'unexpected' },
			database,
			fileSystem,
		});

		expect(runner.run('memory-migrations')).toEqual({
			appliedVersions: ['0001_first.sql', '0002_second.sql'],
		});
		expect(
			database.prepare<[], { step: string }>('SELECT step FROM migration_order').all(),
		).toEqual([{ step: 'first' }, { step: 'second' }]);
		expect(
			database
				.prepare<[], { version: string; applied_at: string }>(
					'SELECT version, applied_at FROM schema_migrations ORDER BY applied_at',
				)
				.all(),
		).toEqual([
			{ version: '0001_first.sql', applied_at: appliedTimes[0] },
			{ version: '0002_second.sql', applied_at: appliedTimes[1] },
		]);
	});

	it('commits each migration independently and rolls back only the failed file', () => {
		const database = createTemporaryDatabase();
		const runner = createMigrationRunner({
			clock: { now: () => '2026-09-04T02:00:00.000Z' },
			database,
			fileSystem: createMemoryMigrationFileSystem({
				'0001_durable.sql': 'CREATE TABLE durable_change (id TEXT PRIMARY KEY)',
				'0002_broken.sql':
					'CREATE TABLE rolled_back_change (id TEXT PRIMARY KEY); INSERT INTO missing_table (id) VALUES (1)',
			}),
		});

		const failure = captureFailure(() => runner.run('memory-migrations'));

		expect(failure).toMatchObject({ code: 'E_INTERNAL', retryable: false });
		expect(readTableNames(database)).toContain('durable_change');
		expect(readTableNames(database)).not.toContain('rolled_back_change');
		expect(
			database.prepare<[], { version: string }>('SELECT version FROM schema_migrations').all(),
		).toEqual([{ version: '0001_durable.sql' }]);
	});

	it('applies the initial schema once and skips its recorded version on restart', () => {
		const database = createTemporaryDatabase();
		const runner = createMigrationRunner({
			clock: { now: () => '2026-09-04T03:00:00.000Z' },
			database,
			fileSystem: {
				readDirectory: (path) => readdirSync(path),
				readFile: (path) => readFileSync(path, 'utf8'),
			},
		});

		expect(runner.run(migrationsDirectory)).toEqual({
			appliedVersions: [
				'0001_init.sql',
				'0002_add_bug_prompt.sql',
				'0003_add_runs_effort_vendor.sql',
				'0003_add_session_archive_and_lanes.sql',
				'0004_create_settings.sql',
				'0005_add_runs_origin_and_spawned_by.sql',
				'0006_add_review_rounds.sql',
				'0007_rebuild_tables_for_wrapup.sql',
				'0008_add_assignment_drafts_and_session_no.sql',
				'0009_batch_wrapups_human_verdict.sql',
				'0010_bughunt_stage.sql',
			],
		});
		expect(readTableNames(database)).toEqual([
			'batch_wrapups',
			'batches',
			'devices',
			'dispatch_snapshots',
			'documents',
			'event_seq',
			'events',
			'gates',
			'log_segments',
			'run_messages',
			'runs',
			'schema_migrations',
			'settings',
			'tasks',
		]);
		expect(runner.run(migrationsDirectory)).toEqual({ appliedVersions: [] });
		expect(
			database
				.prepare<[], { version: string; applied_at: string }>(
					'SELECT version, applied_at FROM schema_migrations',
				)
				.all(),
		).toEqual([
			{ version: '0001_init.sql', applied_at: '2026-09-04T03:00:00.000Z' },
			{ version: '0002_add_bug_prompt.sql', applied_at: '2026-09-04T03:00:00.000Z' },
			{ version: '0003_add_runs_effort_vendor.sql', applied_at: '2026-09-04T03:00:00.000Z' },
			{
				version: '0003_add_session_archive_and_lanes.sql',
				applied_at: '2026-09-04T03:00:00.000Z',
			},
			{ version: '0004_create_settings.sql', applied_at: '2026-09-04T03:00:00.000Z' },
			{
				version: '0005_add_runs_origin_and_spawned_by.sql',
				applied_at: '2026-09-04T03:00:00.000Z',
			},
			{
				version: '0006_add_review_rounds.sql',
				applied_at: '2026-09-04T03:00:00.000Z',
			},
			{
				version: '0007_rebuild_tables_for_wrapup.sql',
				applied_at: '2026-09-04T03:00:00.000Z',
			},
			{
				version: '0008_add_assignment_drafts_and_session_no.sql',
				applied_at: '2026-09-04T03:00:00.000Z',
			},
			{
				version: '0009_batch_wrapups_human_verdict.sql',
				applied_at: '2026-09-04T03:00:00.000Z',
			},
			{
				version: '0010_bughunt_stage.sql',
				applied_at: '2026-09-04T03:00:00.000Z',
			},
		]);
	});
});

describe('unit of work', () => {
	it('rejects a nested transaction with E_TX_NESTED and rolls back the outer write', () => {
		const database = createTemporaryDatabase();
		database.exec('CREATE TABLE writes (value TEXT NOT NULL)');
		const unitOfWork = createUnitOfWork(database);

		const failure = captureFailure(() =>
			unitOfWork.run(() => {
				database.prepare("INSERT INTO writes (value) VALUES ('outer')").run();
				unitOfWork.run(() => {
					database.prepare("INSERT INTO writes (value) VALUES ('inner')").run();
				});
			}),
		);

		expect(failure).toMatchObject({
			code: 'E_TX_NESTED',
			retryable: false,
			message: 'Nested database transactions are not allowed.',
		});
		expect(
			database.prepare<[], { count: number }>('SELECT count(*) AS count FROM writes').get(),
		).toEqual({ count: 0 });
	});

	it('E-150 maps lock contention to E_DB_BUSY and does not write a second row', () => {
		const directory = createTemporaryDirectory();
		const path = join(directory, 'contended.db');
		const lockHolder = trackDatabase(openDatabase(path));
		const contender = trackDatabase(openDatabase(path));
		lockHolder.exec('CREATE TABLE writes (value TEXT NOT NULL)');
		lockHolder.exec('BEGIN IMMEDIATE');
		contender.pragma('busy_timeout = 10');

		let failure: Error;
		try {
			failure = captureFailure(() =>
				createUnitOfWork(contender).run(() => {
					contender.prepare("INSERT INTO writes (value) VALUES ('contender')").run();
				}),
			);
		} finally {
			lockHolder.exec('ROLLBACK');
		}

		expect(failure).toMatchObject({
			code: 'E_DB_BUSY',
			retryable: ERROR_CODES.E_DB_BUSY.retryable,
		});
		expect(
			lockHolder.prepare<[], { count: number }>('SELECT count(*) AS count FROM writes').get(),
		).toEqual({ count: 0 });
	});
});

function createTemporaryDatabase(): DatabaseConnection {
	const directory = createTemporaryDirectory();
	return trackDatabase(openDatabase(join(directory, 'app.db')));
}

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'agent-scheduler-db-'));
	temporaryDirectories.push(directory);
	return directory;
}

function trackDatabase(database: DatabaseConnection): DatabaseConnection {
	openDatabases.push(database);
	return database;
}

function createMemoryMigrationFileSystem(
	files: Readonly<Record<string, string>>,
): MigrationFileSystem {
	return {
		readDirectory: () => Object.keys(files),
		readFile: (path) => files[basename(path)] ?? '',
	};
}

function readTableNames(database: DatabaseConnection): string[] {
	return database
		.prepare<[], { name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all()
		.map((row) => row.name);
}

function captureFailure(action: () => unknown): Error {
	try {
		action();
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new TypeError('Expected action to throw.');
}
