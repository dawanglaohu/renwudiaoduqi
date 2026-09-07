import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createAppendQueue } from '../../src/logstore/append-queue.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import { createEventsIndexRepo } from '../../src/repo/events-index-repo.ts';
import { createLogSegmentsRepo } from '../../src/repo/log-segments-repo.ts';
import { type EventEnvelopeInput, createLogstoreService } from '../../src/service/logstore.ts';

const tmpDirs: string[] = [];
const openDatabases: DatabaseConnection[] = [];
afterEach(() => {
	for (const db of openDatabases.splice(0)) {
		try {
			db.close();
		} catch {
			// ignore: db may already be closed
		}
	}
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeBase(): string {
	const base = mkdtempSync(join(tmpdir(), 'ags-logstore-int-'));
	tmpDirs.push(base);
	return base;
}

function openSqlite(): DatabaseConnection {
	// :memory: DBs avoid the file-lock EBUSY that better-sqlite3 leaves on persistent
	// files; each test gets its own isolated database.
	return openSqliteFile(':memory:');
}

function openSqliteFile(path: string): DatabaseConnection {
	const db = openDatabase(path);
	openDatabases.push(db);
	// The logstore layer doesn't own the runs / tasks lifecycle — tests must only
	// depend on events / log_segments. Drop the cross-table FKs so the test fixtures
	// don't have to seed the whole document / batch / task graph.
	db.pragma('foreign_keys = OFF');
	// Apply the daemon's 0001_init migration so events / log_segments exist.
	const runner = createMigrationRunner({
		clock: { now: () => new Date().toISOString() },
		database: db,
		fileSystem: {
			readDirectory: () => ['0001_init.sql'],
			readFile: () =>
				readFileSync(
					join(dirname(fileURLToPath(import.meta.url)), '../../migrations/0001_init.sql'),
					'utf8',
				),
		},
	});
	runner.run('/dev/null');
	return db;
}

function makeService(db: DatabaseConnection, baseDir: string, limit?: number) {
	const fs = createNodeLogFileSystem();
	const paths = createLogstorePaths(baseDir);
	const queue = createAppendQueue({ appendFile: fs.appendFile });
	let idCounter = 0;
	const ids = { newId: (() => `seg-${(++idCounter).toString()}`) as () => string };
	const unitOfWork = createUnitOfWork(db);
	const eventsIndexRepo = createEventsIndexRepo(db);
	const segmentsRepo = createLogSegmentsRepo(db);
	const service = createLogstoreService({
		fs,
		paths,
		queue,
		ids,
		unitOfWork,
		eventsIndexRepo,
		segmentsRepo,
		...(limit !== undefined ? { segmentSizeLimitBytes: limit } : {}),
	});
	return { service, paths, fs, eventsIndexRepo, segmentsRepo, unitOfWork, queue };
}

function envelope(
	overrides: Partial<EventEnvelopeInput> & { id: number; seq: number },
): EventEnvelopeInput {
	return {
		ts: '2026-01-01T00:00:00.000Z',
		runId: 'run-1',
		taskId: 'M1-T4',
		scope: 'run',
		kind: 'run.started',
		actorDeviceId: null,
		payload: { hello: 'world' },
		...overrides,
	};
}

function paths2Segments(
	paths: ReturnType<typeof createLogstorePaths>,
	runId: string,
): Record<number, string> {
	const out: Record<number, string> = {};
	const dir = paths.runDir(runId);
	let names: readonly string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of names) {
		if (!name.startsWith('events')) continue;
		const dash = name.indexOf('-');
		const seq = dash === -1 ? 0 : Number.parseInt(name.slice(dash + 1, name.indexOf('.')), 10);
		out[seq] = readFileSync(join(dir, name), 'utf8');
	}
	return out;
}

describe('logstore integration (real files + real SQLite)', () => {
	it('R1: appendEvent writes the file first, then the index row appears', async () => {
		const base = makeBase();
		const db = openSqlite();
		const { service, paths, eventsIndexRepo } = makeService(db, base);
		const result = await service.appendEvent(
			'run-1',
			envelope({ id: 1, seq: 0, kind: 'run.started' }),
		);
		await service.closeWriter('run-1');

		const seg0 = paths.segmentPath('run-1', 'events', 0);
		expect(statSync(seg0).size).toBeGreaterThan(0);
		const raw = readFileSync(seg0, 'utf8');
		expect(raw).toContain('"kind":"run.started"');
		// The indexed record is the LAST thing created after the file bytes exist.
		expect(result.indexed).toBe(true);
		expect(eventsIndexRepo.lastIndexedEnd('run-1')).toBe(result.location.byteLen);
	});

	it('R6: normal writes preserve the envelope id/seq in the index; only milestones are indexed', async () => {
		const base = makeBase();
		const db = openSqlite();
		const { service, paths, eventsIndexRepo } = makeService(db, base);

		await service.appendEvent('run-1', envelope({ id: 10, seq: 0, kind: 'run.started' }));
		await service.appendEvent('run-1', envelope({ id: 11, seq: 1, kind: 'agent_message_chunk' }));
		await service.appendEvent('run-1', envelope({ id: 12, seq: 2, kind: 'tool_call' }));
		await service.closeWriter('run-1');

		// The full body contains ALL three events (never truncated)…
		const seg0 = paths.segmentPath('run-1', 'events', 0);
		const raw = readFileSync(seg0, 'utf8');
		expect(raw.match(/\n/g)?.length).toBe(3);
		expect(raw).toContain('"id":10');
		expect(raw).toContain('"id":11');
		expect(raw).toContain('"id":12');

		// …but the index table only carries milestone rows, with the ENVELOPE id/seq preserved.
		const rows = db
			.prepare('SELECT id, seq, kind, byte_offset, byte_len FROM events ORDER BY seq')
			.all() as Array<{
			id: number;
			seq: number;
			kind: string;
			byte_offset: number;
			byte_len: number;
		}>;
		expect(rows.map((r) => r.kind)).toEqual(['run.started', 'tool_call']); // chunk is NOT indexed
		expect(rows.map((r) => r.id)).toEqual([10, 12]);
		expect(rows.map((r) => r.seq)).toEqual([0, 2]);
		// Offsets skip the chunk line: line0 len = len(line0 json)+1, line1 = chunk, line2 starts after both.
		const lines = raw.split('\n');
		const len0 = Buffer.byteLength(lines[0] ?? '', 'utf8') + 1;
		const len1 = Buffer.byteLength(lines[1] ?? '', 'utf8') + 1;
		expect(rows[0]?.byte_offset).toBe(0);
		expect(rows[1]?.byte_offset).toBe(len0 + len1);
		// lastIndexedEnd reflects the LAST indexed milestone, not the file tail.
		expect(eventsIndexRepo.lastIndexedEnd('run-1')).toBe(len0 + len1 + (rows[1]?.byte_len ?? 0));
	});

	it('R1: a failed index insert does NOT lose the file bytes; repair recovers them', async () => {
		const base = makeBase();
		const db = openSqlite();
		const { service, paths, eventsIndexRepo } = makeService(db, base);

		// Break the events table so the index insert fails AFTER the file write.
		db.exec('DROP TABLE events');
		db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, broken TEXT NOT NULL)');

		const result = await service.appendEvent('run-1', envelope({ id: 1, seq: 0 }));
		await service.closeWriter('run-1');
		// Bytes must be on disk even though indexing blew up (R1).
		const seg0 = paths.segmentPath('run-1', 'events', 0);
		expect(statSync(seg0).size).toBeGreaterThan(0);
		expect(result.indexed).toBe(false);
		expect(result.indexError).not.toBeNull();
		expect(result.indexError?.code).toBe('E_INTERNAL');
		// The repair job must still be able to re-index after the schema is restored.
		db.exec('DROP TABLE events');
		db.exec(
			`CREATE TABLE events (
				id INTEGER PRIMARY KEY,
				run_id TEXT,
				task_id TEXT,
				seq INTEGER NOT NULL,
				ts TEXT NOT NULL,
				scope TEXT NOT NULL,
				kind TEXT NOT NULL,
				actor_device_id TEXT,
				file_seq INTEGER NOT NULL,
				byte_offset INTEGER NOT NULL,
				byte_len INTEGER NOT NULL
			)`,
		);
		// Seed the run so repairAll picks the run up.
		db.prepare(
			`INSERT INTO log_segments (id, run_id, stream, file_seq, path, byte_start, byte_end, line_count)
			 VALUES ('seg-r1', 'run-1', 'events', 0, ?, 0, 0, 0)`,
		).run(seg0);
		const reports = await service.repairAll();
		expect(reports[0]?.indexedLines).toBe(1);
		expect(reports[0]?.errors).toEqual([]);
		void eventsIndexRepo;
	});

	it('R2: repair scans an unregistered tail segment and restores the index', async () => {
		const base = makeBase();
		const db = openSqlite();
		const { service, paths, segmentsRepo, eventsIndexRepo } = makeService(db, base);

		// Simulate a crash: write the events file directly (no index rows, no segment row).
		const runDir = paths.runDir('run-crash');
		const { mkdirSync } = await import('node:fs');
		mkdirSync(runDir, { recursive: true });
		const crashPath = paths.segmentPath('run-crash', 'events', 0);
		const line1 = JSON.stringify({
			id: 1,
			seq: 0,
			ts: '2026-01-01T00:00:00.000Z',
			runId: 'run-crash',
			taskId: null,
			scope: 'run',
			kind: 'run.started',
			actorDeviceId: null,
			payload: null,
		});
		const line2 = JSON.stringify({
			id: 2,
			seq: 1,
			ts: '2026-01-01T00:00:01.000Z',
			runId: 'run-crash',
			taskId: null,
			scope: 'task',
			kind: 'task.gate_passed',
			actorDeviceId: 'dev-1',
			payload: { gate: 'review' },
		});
		const line3 = JSON.stringify({
			id: 3,
			seq: 2,
			ts: '2026-01-01T00:00:02.000Z',
			runId: 'run-crash',
			taskId: null,
			scope: 'agent',
			kind: 'agent_message_chunk',
			actorDeviceId: null,
			payload: { text: 'never indexed' },
		});
		writeFileSync(crashPath, `${line1}\n${line2}\n${line3}\n`);

		// Register a run so repairAll finds it (segments repo drives run discovery).
		const db2 = openSqlite();
		void db2;
		// seed a dummy registered segment so the run appears in repairAll
		// (repairAll uses segmentsRepo.listAll to discover runs)
		const segmentsRepoAny = segmentsRepo as unknown as {
			insertSegments: (rows: unknown[]) => void;
		};

		// First, discover runs via listAll: there are none, so repairAll finds nothing.
		// Register the run by recording a (zero-length) segment row first:
		segmentsRepoAny.insertSegments([
			{
				id: 'seed',
				runId: 'run-crash',
				stream: 'events',
				fileSeq: 0,
				path: crashPath,
				byteStart: 0,
				byteEnd: 0,
				lineCount: 0,
			},
		]);

		const reports = await service.repairAll();
		expect(reports).toHaveLength(1);
		const report = reports[0];
		expect(report?.runId).toBe('run-crash');
		// line1 and line2 are milestones; line3 (chunk) is not.
		expect(report?.indexedLines).toBe(2);
		expect(report?.errors).toEqual([]);

		const last = eventsIndexRepo.lastIndexedEnd('run-crash');
		expect(last).toBe(Buffer.byteLength(`${line1}\n${line2}\n`, 'utf8'));
	});

	it('R2: repair is idempotent — a second pass indexes nothing new', async () => {
		const base = makeBase();
		const db = openSqlite();
		const { service, paths, segmentsRepo } = makeService(db, base);
		const runDir = paths.runDir('run-idem');
		const { mkdirSync } = await import('node:fs');
		mkdirSync(runDir, { recursive: true });
		const p = paths.segmentPath('run-idem', 'events', 0);
		const line = JSON.stringify({
			id: 7,
			seq: 0,
			ts: '2026-01-01T00:00:00.000Z',
			runId: 'run-idem',
			taskId: null,
			scope: 'run',
			kind: 'run.exited',
			actorDeviceId: null,
			payload: null,
		});
		writeFileSync(p, `${line}\n`);
		(segmentsRepo as unknown as { insertSegments: (rows: unknown[]) => void }).insertSegments([
			{
				id: 'seed',
				runId: 'run-idem',
				stream: 'events',
				fileSeq: 0,
				path: p,
				byteStart: 0,
				byteEnd: 0,
				lineCount: 0,
			},
		]);

		const first = await service.repairAll();
		expect(first[0]?.indexedLines).toBe(1);
		const second = await service.repairAll();
		expect(second[0]?.indexedLines).toBe(0);
		expect(second[0]?.errors).toEqual([]);
	});

	it('R2: index-ahead-of-file is an error entry, never silently corrected (E-24)', async () => {
		const base = makeBase();
		const db = openSqlite();
		const { service, paths, segmentsRepo, eventsIndexRepo } = makeService(db, base);
		const runDir = paths.runDir('run-ahead');
		const { mkdirSync } = await import('node:fs');
		mkdirSync(runDir, { recursive: true });
		const p = paths.segmentPath('run-ahead', 'events', 0);
		writeFileSync(p, 'small\n');
		(segmentsRepo as unknown as { insertSegments: (rows: unknown[]) => void }).insertSegments([
			{
				id: 'seed',
				runId: 'run-ahead',
				stream: 'events',
				fileSeq: 0,
				path: p,
				byteStart: 0,
				byteEnd: 0,
				lineCount: 0,
			},
		]);
		// Forge index state that is ahead of the file: insert an index row at offset 500.
		// Do it through the repo directly to simulate a corrupted DB.
		db.prepare(
			`INSERT INTO events (id, run_id, task_id, seq, ts, scope, kind, actor_device_id, file_seq, byte_offset, byte_len)
			 VALUES (99, 'run-ahead', NULL, 5, '2026-01-01T00:00:00.000Z', 'run', 'run.exited', NULL, 0, 500, 10)`,
		).run();
		expect(eventsIndexRepo.lastIndexedEnd('run-ahead')).toBe(510);

		const reports = await service.repairAll();
		const report = reports[0];
		expect(report?.errors.length).toBeGreaterThan(0);
		expect(report?.errors[0]?.code).toBe('E_VALIDATION');
		expect(report?.errors[0]?.message).toContain('index ahead of file');
		void segmentsRepo;
	});

	it('R2: truncated tail line (no LF) is not indexed; complete lines are', async () => {
		const base = makeBase();
		const db = openSqlite();
		const { service, paths, segmentsRepo, eventsIndexRepo } = makeService(db, base);
		const runDir = paths.runDir('run-half');
		const { mkdirSync } = await import('node:fs');
		mkdirSync(runDir, { recursive: true });
		const p = paths.segmentPath('run-half', 'events', 0);
		const good = JSON.stringify({
			id: 1,
			seq: 0,
			ts: '2026-01-01T00:00:00.000Z',
			runId: 'run-half',
			taskId: null,
			scope: 'run',
			kind: 'run.started',
			actorDeviceId: null,
			payload: null,
		});
		const partial = '{"id":2,"seq":1,"ts":"2026-01-01T00:00:01.0';
		writeFileSync(p, `${good}\n${partial}`);
		(segmentsRepo as unknown as { insertSegments: (rows: unknown[]) => void }).insertSegments([
			{
				id: 'seed',
				runId: 'run-half',
				stream: 'events',
				fileSeq: 0,
				path: p,
				byteStart: 0,
				byteEnd: 0,
				lineCount: 0,
			},
		]);
		const reports = await service.repairAll();
		expect(reports[0]?.indexedLines).toBe(1);
		// The truncated line stays on disk untouched, so the next append can't collide with it.
		const disk = readFileSync(p, 'utf8');
		expect(disk).toContain(partial);
		expect(eventsIndexRepo.lastIndexedFileSeq('run-half')).toBe(0);
	});

	it('E-151: deleted file → typed E_LOG_FILE_MISSING error entry in the report, other runs still repaired', async () => {
		const base = makeBase();
		const db = openSqlite();
		const { service, paths, segmentsRepo } = makeService(db, base);
		const p = paths.segmentPath('run-gone', 'events', 0);
		(segmentsRepo as unknown as { insertSegments: (rows: unknown[]) => void }).insertSegments([
			{
				id: 'g0',
				runId: 'run-gone',
				stream: 'events',
				fileSeq: 0,
				path: p,
				byteStart: 0,
				byteEnd: 0,
				lineCount: 0,
			},
		]);
		// never create the file on disk
		const reports = await service.repairAll();
		expect(reports[0]?.errors).toHaveLength(1);
		expect(reports[0]?.errors[0]?.code).toBe('E_LOG_FILE_MISSING');
	});

	it('R4: SQLITE_BUSY maps to E_DB_BUSY at the transaction boundary', async () => {
		const base = makeBase();
		// A file-backed database shared by two connections so one can hold a write lock.
		const dbPath = join(base, 'busy.db');
		const db = openSqliteFile(dbPath);
		const other = openSqliteFile(dbPath);
		other.pragma('busy_timeout = 0');
		db.pragma('busy_timeout = 0');
		// Grab an exclusive write lock on the events table with the other connection.
		other.exec('BEGIN IMMEDIATE');
		other
			.prepare(
				`INSERT INTO events (id, run_id, task_id, seq, ts, scope, kind, actor_device_id, file_seq, byte_offset, byte_len)
				 VALUES (1, 'run-1', NULL, 0, '2026-01-01T00:00:00.000Z', 'run', 'run.started', NULL, 0, 0, 0)`,
			)
			.run();
		// A write through the unitOfWork must now fail with a type-safe E_DB_BUSY.
		const unitOfWork = createUnitOfWork(db);
		const eventsIndexRepo = createEventsIndexRepo(db);
		let got: string | null = null;
		try {
			unitOfWork.run(() => {
				eventsIndexRepo.insertIndex({
					id: 2,
					runId: 'run-1',
					taskId: null,
					seq: 1,
					ts: '2026-01-01T00:00:01.000Z',
					scope: 'run',
					kind: 'run.exited',
					actorDeviceId: null,
					fileSeq: 0,
					byteOffset: 0,
					byteLen: 0,
				});
			});
		} catch (error) {
			got = error instanceof AppError ? error.code : null;
		}
		expect(got).toBe('E_DB_BUSY');
		other.exec('ROLLBACK');
	});

	it('R3: readEventsPage advances across a rotated segment and drains the whole stream', async () => {
		const base = makeBase();
		const db = openSqlite();
		// Small segment limit forces a rotation within a handful of events.
		const { service, paths, eventsIndexRepo } = makeService(db, base, 400);

		const mk = (n: number) => envelope({ id: n, seq: n, kind: 'run.started', payload: { n } });
		await service.appendEvent('run-page', mk(1));
		await service.appendEvent('run-page', mk(2));
		const r3 = await service.appendEvent('run-page', mk(3));
		await service.closeWriter('run-page');
		// At least one rotation must have occurred across three ~190-byte lines.
		expect(r3.location.fileSeq).toBeGreaterThanOrEqual(1);

		// Page through with the default chunk limit; the cursor must always advance
		// and eventually drain every segment without a 0:3 → 0:3 stall (R3).
		let cursor: string | undefined = undefined;
		const collected: string[] = [];
		let page = 0;
		for (;;) {
			const res = await service.readEventsPage('run-page', cursor);
			expect(res.ok).toBe(true);
			if (!res.ok) break;
			collected.push(new TextDecoder().decode(res.data));
			expect(res.nextCursor).not.toBe(cursor); // R3: the cursor MUST advance
			cursor = res.nextCursor;
			if (res.tailReached) break;
			page += 1;
			expect(page).toBeLessThan(20); // safety net against stalls
		}
		const all = collected.join('');
		// Every on-disk events segment, concatenated in fileSeq order, must equal the page stream.
		const onDisk = paths2Segments(paths, 'run-page');
		const joined = Object.keys(onDisk)
			.sort((a, b) => Number(a) - Number(b))
			.map((k) => onDisk[Number(k)] ?? '')
			.join('');
		expect(all).toBe(joined);
		// 3 lines total
		expect(all.match(/\n/g)?.length).toBe(3);
		void eventsIndexRepo;
	});
});
