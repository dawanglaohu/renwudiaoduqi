import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SnapshotResponse } from '@agent-scheduler/shared/api/snapshot';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import type { HttpServer } from '../../src/http/server.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type {
	LockFileHandle,
	NativeLockAdapter,
	NativeLockFailure,
	NativeLockReadResult,
	NativeLockWriteResult,
} from '../../src/platform/lock-contract.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const testDir = resolve(currentDir, '../fixtures/snapshot-routes-integration-test');
const migrationsDir = resolve(currentDir, '../../migrations');
const dbPath = join(testDir, 'test.db');

function createMemoryLockAdapter(): NativeLockAdapter {
	let lockContents: string | undefined;
	const missing = (): NativeLockFailure => ({
		kind: 'not-found',
		error: new AppError('E_INTERNAL', 'Memory lock is missing.'),
	});
	return Object.freeze({
		platform: 'linux',
		filePath: join(testDir, 'daemon.lock'),
		dirPath: testDir,
		reclaimPath: join(testDir, 'daemon.lock.reclaim'),
		permissionLines: ['root:root 0600'],
		createExclusive(contents: string): NativeLockWriteResult {
			if (lockContents !== undefined) {
				return {
					ok: false,
					failure: {
						kind: 'already-exists',
						error: new AppError('E_INTERNAL', 'Memory lock already exists.'),
					},
				};
			}
			lockContents = contents;
			return { ok: true };
		},
		read(): NativeLockReadResult {
			return lockContents === undefined
				? { ok: false, failure: missing() }
				: { ok: true, contents: lockContents };
		},
		remove(): NativeLockWriteResult {
			lockContents = undefined;
			return { ok: true };
		},
		verifyPermissions: (): NativeLockWriteResult => ({ ok: true }),
		inspectPermissions: (): NativeLockReadResult => ({
			ok: true,
			contents: 'root:root mode=600',
		}),
		createReclaimGuard: (): NativeLockWriteResult => ({ ok: true }),
		readReclaimGuard(): NativeLockReadResult {
			return { ok: false, failure: missing() };
		},
		removeReclaimGuard: (): NativeLockWriteResult => ({ ok: true }),
	});
}

describe('M2-T8 Snapshot Routes Integration: Task State Derivation & Global Snapshot', () => {
	let db: DatabaseConnection;
	let server: HttpServer | undefined;
	let container: ReturnType<typeof createContainer> | undefined;

	beforeEach(() => {
		server = undefined;
		container = undefined;
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(testDir, { recursive: true });
		db = openDatabase(dbPath);
		const runner = createMigrationRunner({
			clock: { now: () => '2026-09-10T12:00:00.000Z' },
			database: db,
			fileSystem: {
				readDirectory: () => readdirSync(migrationsDir),
				readFile: (p: string) => readFileSync(p, 'utf8'),
			},
		});
		runner.run(migrationsDir);
	});

	afterEach(async () => {
		container?.services.agents.stop();
		await server?.close();
		db.close();
		rmSync(testDir, { recursive: true, force: true });
	});

	function setupServer() {
		const lockAdapter = createMemoryLockAdapter();
		container = createContainer({
			config: {
				port: 7818,
				bind: '127.0.0.1',
				dataDir: testDir,
				logLevel: 'error',
				dev: false,
			},
			database: db,
			hostInputs: { platform: 'linux', homedir: testDir },
			lockAdapter,
			instanceLock: { release: () => undefined } as unknown as LockFileHandle,
			clock: { now: () => '2026-09-10T12:00:00.000Z' },
		});

		server = createHttpServer({ container });
		return { server, container };
	}

	async function getAuthToken(container: ReturnType<typeof createContainer>): Promise<string> {
		const activeCode =
			container.services.pairing.getActivePairingCode()?.code ??
			container.services.pairing.createPairingCode().code;
		const claim = await container.services.pairing.claimPairingCode({
			code: activeCode,
			deviceName: 'test-device',
		});
		return `Bearer ${claim.token}`;
	}

	it('E-08: GET /api/v1/snapshot requires authentication and rejects unauthenticated requests with 401', async () => {
		const { server } = setupServer();
		await server.instance.ready();

		const res = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/snapshot',
		});
		expect(res.statusCode).toBe(401);
		const body = JSON.parse(res.body);
		expect(body.error.code).toBe('E_UNAUTHORIZED');
	});

	it('/api/v1/snapshot derives task.state as manual_state -> max attempt_no run.state -> never_dispatched', async () => {
		const { server, container } = setupServer();
		await server.instance.ready();
		const token = await getAuthToken(container);

		db.prepare(
			`INSERT INTO documents (
				id, docs_path, project_name, repo_path, main_branch, branch_prefix,
				lane_count, content_fingerprint, is_source_readable, is_takeover_notified,
				imported_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			'doc-snap-1',
			'docs/Agent任务调度器-开发文档',
			'Agent任务调度器',
			'/repo',
			'main',
			'task/',
			2,
			'fp-001',
			1,
			1,
			'2026-09-10T12:00:00.000Z',
			'2026-09-10T12:00:00.000Z',
		);

		// These rows pin all three precedence levels of the Section 09 derived-state contract.
		const insertTaskStmt = db.prepare(
			`INSERT INTO tasks (
				id, doc_id, task_key, title, module_key, deps_json, est_days, contract_hash, contract_reasons_json, manual_state
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		insertTaskStmt.run(
			'task-1',
			'doc-snap-1',
			'M2-T1',
			'人工状态任务',
			'M2',
			'[]',
			1.0,
			'hash-1',
			'[]',
			'landed',
		);
		insertTaskStmt.run(
			'task-2',
			'doc-snap-1',
			'M2-T2',
			'多运行任务',
			'M2',
			'[]',
			1.5,
			'hash-2',
			'[]',
			null,
		);
		insertTaskStmt.run(
			'task-3',
			'doc-snap-1',
			'M2-T3',
			'未派发任务',
			'M2',
			'[]',
			2.0,
			'hash-3',
			'[]',
			null,
		);

		// Seed dispatch snapshots for foreign key
		const insertSnapshotStmt = db.prepare(
			`INSERT INTO dispatch_snapshots (
				id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?)`,
		);
		insertSnapshotStmt.run('snap-1', 'task-1', 'hash-1', '[]', '{}', '2026-09-10T12:00:00.000Z');
		insertSnapshotStmt.run('snap-2', 'task-2', 'hash-2', '[]', '{}', '2026-09-10T12:00:00.000Z');

		const insertRunStmt = db.prepare(
			`INSERT INTO runs (
				id, task_id, attempt_no, kind, state, agent_id, permission_tier, snapshot_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		insertRunStmt.run(
			'run-t1-1',
			'task-1',
			1,
			'implement',
			'failed',
			'codex',
			'workspaceWrite',
			'snap-1',
		);
		insertRunStmt.run(
			'run-t1-2',
			'task-1',
			2,
			'implement',
			'running',
			'codex',
			'workspaceWrite',
			'snap-1',
		);

		insertRunStmt.run(
			'run-t2-1',
			'task-2',
			1,
			'implement',
			'failed',
			'codex',
			'workspaceWrite',
			'snap-2',
		);
		insertRunStmt.run(
			'run-t2-2',
			'task-2',
			2,
			'implement',
			'running',
			'codex',
			'workspaceWrite',
			'snap-2',
		);

		const res = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/snapshot',
			headers: {
				authorization: token,
			},
		});

		expect(res.statusCode).toBe(200);
		const snapshot = JSON.parse(res.body) as SnapshotResponse;

		expect(snapshot.documents).toHaveLength(1);
		expect(snapshot.documents[0]?.id).toBe('doc-snap-1');
		expect(snapshot.tasks).toHaveLength(3);
		expect(Array.isArray(snapshot.batches)).toBe(true);
		expect(snapshot.runs).toHaveLength(4);
		expect(Array.isArray(snapshot.gates)).toBe(true);
		expect(Array.isArray(snapshot.agents)).toBe(true);

		const task1 = snapshot.tasks.find((t) => t.id === 'task-1');
		const task2 = snapshot.tasks.find((t) => t.id === 'task-2');
		const task3 = snapshot.tasks.find((t) => t.id === 'task-3');

		expect(task1).toBeDefined();
		expect(task1?.state).toBe('landed');

		expect(task2).toBeDefined();
		expect(task2?.state).toBe('running');

		expect(task3).toBeDefined();
		expect(task3?.state).toBe('never_dispatched');
	});
});
