import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';

const MIGRATIONS_DIR = join(__dirname, '../../migrations');

function createRunner(db: Database.Database) {
	return createMigrationRunner({
		clock: { now: () => '2026-09-17T12:00:00.000Z' },
		database: db,
		fileSystem: {
			readDirectory: (dir) => readdirSync(dir),
			readFile: (path) => readFileSync(path, 'utf8'),
		},
	});
}

describe('M8-T6 Database Migration & Rebuild (AC 6, E-291)', () => {
	it('migrates a database with existing data to 0007 without data loss and with 0 foreign_key_check errors', () => {
		const db = new Database(':memory:');
		db.pragma('foreign_keys = ON');

		// 1. Run migrations 0001..0006
		const runner = createMigrationRunner({
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
			database: db,
			fileSystem: {
				readDirectory: (dir) =>
					readdirSync(dir).filter(
						(file) =>
							file.startsWith('0001') ||
							file.startsWith('0002') ||
							file.startsWith('0003') ||
							file.startsWith('0004') ||
							file.startsWith('0005') ||
							file.startsWith('0006'),
					),
				readFile: (path) => readFileSync(path, 'utf8'),
			},
		});
		runner.run(MIGRATIONS_DIR);

		// 2. Insert test data in 0001..0006 schema
		db.exec(`
			INSERT INTO documents (id, docs_path, project_name, content_fingerprint, imported_at, last_seen_at)
			VALUES ('doc-1', '/path/to/docs', 'test-project', 'fp-1', '2026-09-17T10:00:00.000Z', '2026-09-17T10:00:00.000Z');

			INSERT INTO batches (id, doc_id, batch_no, state, started_at, finished_at)
			VALUES ('batch-1', 'doc-1', 1, 'running', '2026-09-17T10:00:00.000Z', NULL);

			INSERT INTO tasks (id, doc_id, task_key, title, module_key, deps_json, contract_hash, contract_reasons_json, batch_id)
			VALUES ('task-1', 'doc-1', 'M1-T1', 'Task 1', 'M1', '[]', 'hash-1', '[]', 'batch-1');

			INSERT INTO dispatch_snapshots (id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at, bug_prompt)
			VALUES ('snap-1', 'task-1', 'hash-1', '[]', '{}', '2026-09-17T10:00:00.000Z', 'find bugs');

			INSERT INTO runs (
				id, task_id, attempt_no, kind, state, agent_id, permission_tier,
				snapshot_id, rework_count, origin, review_round
			) VALUES (
				'run-1', 'task-1', 1, 'implement', 'landed', 'codex', 'workspaceWrite',
				'snap-1', 0, 'dispatch', NULL
			);

			INSERT INTO gates (id, task_id, run_id, kind, state, decision, created_at)
			VALUES ('gate-1', 'task-1', 'run-1', 'review', 'decided', 'pass', '2026-09-17T10:00:00.000Z');
		`);

		// 3. Now run migration 0007
		const fullRunner = createRunner(db);
		const result = fullRunner.run(MIGRATIONS_DIR);
		expect(result.appliedVersions).toContain('0007_rebuild_tables_for_wrapup.sql');

		// 4. Verify foreign_key_check is 0 rows
		const fkErrors = db.pragma('foreign_key_check') as unknown[];
		expect(fkErrors).toEqual([]);

		// 5. Verify row count and data preservation
		const batchRow = db.prepare('SELECT * FROM batches WHERE id = ?').get('batch-1') as Record<
			string,
			unknown
		>;
		expect(batchRow).toBeDefined();
		expect(batchRow.doc_id).toBe('doc-1');
		expect(batchRow.state).toBe('running');

		const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-1') as Record<
			string,
			unknown
		>;
		expect(taskRow).toBeDefined();
		expect(taskRow.task_key).toBe('M1-T1');

		const snapshotRow = db
			.prepare('SELECT * FROM dispatch_snapshots WHERE id = ?')
			.get('snap-1') as Record<string, unknown>;
		expect(snapshotRow).toBeDefined();
		expect(snapshotRow.task_id).toBe('task-1');
		expect(snapshotRow.bug_prompt).toBe('find bugs');

		const runRow = db.prepare('SELECT * FROM runs WHERE id = ?').get('run-1') as Record<
			string,
			unknown
		>;
		expect(runRow).toBeDefined();
		expect(runRow.kind).toBe('implement');
		expect(runRow.state).toBe('landed');
		expect(runRow.is_in_head).toBe(0);

		const gateRow = db.prepare('SELECT * FROM gates WHERE id = ?').get('gate-1') as Record<
			string,
			unknown
		>;
		expect(gateRow).toBeDefined();
		expect(gateRow.task_id).toBe('task-1');
		expect(gateRow.decision).toBe('pass');

		// 6. Verify new capabilities:
		// - 7 states on batches
		db.prepare("UPDATE batches SET state = 'wrapping' WHERE id = 'batch-1'").run();
		expect(
			(
				db.prepare('SELECT state FROM batches WHERE id = ?').get('batch-1') as Record<
					string,
					unknown
				>
			).state,
		).toBe('wrapping');

		// - wrapup run with task_id = NULL and kind = 'wrapup'
		db.prepare(`
			INSERT INTO dispatch_snapshots (id, task_id, batch_id, contract_hash, task_paths_json, launch_spec_json, created_at)
			VALUES ('snap-wrapup', NULL, 'batch-1', 'hash-w', '[]', '{}', '2026-09-17T11:00:00.000Z')
		`).run();

		db.prepare(`
			INSERT INTO runs (
				id, task_id, batch_id, attempt_no, kind, state, agent_id, permission_tier,
				snapshot_id, is_in_head
			) VALUES (
				'run-wrapup-1', NULL, 'batch-1', 1, 'wrapup', 'queued', 'codex', 'workspaceWrite',
				'snap-wrapup', 0
			)
		`).run();

		const wrapupRun = db.prepare('SELECT * FROM runs WHERE id = ?').get('run-wrapup-1') as Record<
			string,
			unknown
		>;
		expect(wrapupRun.task_id).toBeNull();
		expect(wrapupRun.kind).toBe('wrapup');
		expect(wrapupRun.batch_id).toBe('batch-1');

		// - batch_wrapups table insert
		db.prepare(`
			INSERT INTO batch_wrapups (
				id, batch_id, batch_no, tasks_json, round, run_id, verdict,
				prompt_source, tests_json, summary_text, findings_json, unassigned_json,
				fix_run_ids_json, report_text, created_at
			) VALUES (
				'wrapup-rec-1', 'batch-1', 1, '["M1-T1"]', 1, 'run-wrapup-1', 'clean',
				'docs', '{"status":"pass","items":[]}', 'Summary', '[]', '[]',
				'[]', 'report text', '2026-09-17T11:00:00.000Z'
			)
		`).run();

		const wrapupRec = db
			.prepare('SELECT * FROM batch_wrapups WHERE id = ?')
			.get('wrapup-rec-1') as Record<string, unknown>;
		expect(wrapupRec.verdict).toBe('clean');
		expect(wrapupRec.is_human_verdict).toBe(0);

		// - batch level gate with task_id = NULL and run_id = 'run-wrapup-1'
		db.prepare(`
			INSERT INTO gates (id, task_id, run_id, kind, state, decision, created_at)
			VALUES ('gate-wrapup-1', NULL, 'run-wrapup-1', 'review', 'waiting', NULL, '2026-09-17T11:00:00.000Z')
		`).run();

		const wrapupGate = db
			.prepare('SELECT * FROM gates WHERE id = ?')
			.get('gate-wrapup-1') as Record<string, unknown>;
		expect(wrapupGate.task_id).toBeNull();
		expect(wrapupGate.run_id).toBe('run-wrapup-1');

		// foreign keys still valid
		expect(db.pragma('foreign_key_check')).toEqual([]);
	});

	it('produces identical sqlite_master schema between fresh migration and upgraded database', () => {
		const freshDb = new Database(':memory:');
		freshDb.pragma('foreign_keys = ON');
		const freshRunner = createRunner(freshDb);
		freshRunner.run(MIGRATIONS_DIR);

		const upgradeDb = new Database(':memory:');
		upgradeDb.pragma('foreign_keys = ON');
		// Step 1: run 0001..0006 (everything before the 0007 rebuild; later ADD COLUMN
		// migrations such as 0008 must run after it, as they do on a real upgrade)
		const partialRunner = createMigrationRunner({
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
			database: upgradeDb,
			fileSystem: {
				readDirectory: (dir) => readdirSync(dir).filter((file) => file < '0007'),
				readFile: (path) => readFileSync(path, 'utf8'),
			},
		});
		partialRunner.run(MIGRATIONS_DIR);

		// Step 2: run 0007
		const fullRunner = createRunner(upgradeDb);
		fullRunner.run(MIGRATIONS_DIR);

		// Compare sqlite_master (tables and indexes)
		const normalizeMaster = (db: Database.Database) =>
			db
				.prepare(
					"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name ASC",
				)
				.all();

		const freshMaster = normalizeMaster(freshDb);
		const upgradeMaster = normalizeMaster(upgradeDb);

		expect(freshMaster).toEqual(upgradeMaster);
	});

	it('rolls back and throws when foreign_key_check detects violation on migration with -- requires: foreign_keys=off', () => {
		const db = new Database(':memory:');
		db.pragma('foreign_keys = ON');

		const runner = createMigrationRunner({
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
			database: db,
			fileSystem: {
				readDirectory: () => ['0001_test.sql', '0002_bad.sql'],
				readFile: (path) => {
					if (path.endsWith('0001_test.sql')) {
						return `
							CREATE TABLE parent (id TEXT PRIMARY KEY);
							CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));
						`;
					}
					return `-- requires: foreign_keys=off
INSERT INTO child (id, parent_id) VALUES ('c1', 'nonexistent');`;
				},
			},
		});

		expect(() => runner.run('/mock')).toThrowError();
		try {
			runner.run('/mock');
		} catch (error: unknown) {
			const err = error as { cause?: { message?: string } };
			expect(err.cause?.message).toMatch(/foreign_key_check failed/);
		}
		// Verified rollback: child table has 0 rows
		const countRow = db.prepare('SELECT count(*) as c FROM child').get() as { c: number };
		expect(countRow.c).toBe(0);
		// foreign_keys is restored to ON
		const pragmaFk = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
		expect(pragmaFk[0]?.foreign_keys).toBe(1);
	});

	it('does not turn off foreign keys when -- requires: foreign_keys=off is not on the first line', () => {
		const db = new Database(':memory:');
		db.pragma('foreign_keys = ON');

		const runner = createMigrationRunner({
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
			database: db,
			fileSystem: {
				readDirectory: () => ['0001_test.sql', '0002_not_first.sql'],
				readFile: (path) => {
					if (path.endsWith('0001_test.sql')) {
						return `
							CREATE TABLE parent (id TEXT PRIMARY KEY);
							CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));
						`;
					}
					return `
						-- some comment first line
						-- requires: foreign_keys=off
						INSERT INTO child (id, parent_id) VALUES ('c1', 'nonexistent');
					`;
				},
			},
		});

		// SQLite itself throws FOREIGN KEY constraint failed because foreign keys were NOT turned off!
		expect(() => runner.run('/mock')).toThrowError();
		try {
			runner.run('/mock');
		} catch (error: unknown) {
			const err = error as { cause?: { message?: string } };
			expect(err.cause?.message).toMatch(/FOREIGN KEY/);
		}
	});
});
