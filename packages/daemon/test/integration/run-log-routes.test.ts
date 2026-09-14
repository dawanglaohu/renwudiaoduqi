import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GetRunLogResponse } from '@agent-scheduler/shared/api/runs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type {
	LockFileHandle,
	NativeLockAdapter,
	NativeLockFailure,
	NativeLockReadResult,
	NativeLockWriteResult,
} from '../../src/platform/lock-contract.ts';
import type { PairingService } from '../../src/service/pairing.ts';

const currentDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const migrationsDir = resolve(currentDir, '../../migrations');

function createMemoryLockAdapter(testDir: string): NativeLockAdapter {
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

describe('M6-T8 / R1 Integration: Real Container and HTTP pipeline for GET /api/v1/runs/:id/log', () => {
	let testDir: string;
	let dbPath: string;
	let db: DatabaseConnection;

	beforeEach(() => {
		testDir = join(tmpdir(), `agent-sched-run-log-integ-${randomUUID()}`);
		dbPath = join(testDir, 'test.db');
		mkdirSync(testDir, { recursive: true });
		db = openDatabase(dbPath);
		const runner = createMigrationRunner({
			clock: { now: () => '2026-09-14T12:00:00.000Z' },
			database: db,
			fileSystem: {
				readDirectory: () => ['0001_init.sql'],
				readFile: (p: string) => readFileSync(p, 'utf8'),
			},
		});
		runner.run(migrationsDir);
	});

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true, force: true });
	});

	function setupTestServer() {
		const lockAdapter = createMemoryLockAdapter(testDir);
		const mockPairingService: PairingService = {
			bootstrapIfNeeded: () => ({ bootstrapped: false }),
			getActivePairingCode: () => null,
			createPairingCode: () => ({ code: '123456', expiresAt: '2026-09-14T12:01:00.000Z' }),
			claimPairingCode: async () => ({ deviceId: 'dev-1', token: 'mock-valid-token' }),
			invalidatePairingCode: () => undefined,
			listDevices: () => [],
			revokeDevice: () => ({ revokedAt: '2026-09-14T12:00:00.000Z' }),
			authenticateToken: (authHeader) => {
				if (!authHeader || !authHeader.startsWith('Bearer ')) {
					throw new AppError('E_UNAUTHORIZED', 'Missing or invalid Authorization header');
				}
				const token = authHeader.slice('Bearer '.length);
				if (token === 'mock-valid-token') {
					return { deviceId: 'dev-1', deviceName: 'test-device' };
				}
				throw new AppError('E_UNAUTHORIZED', 'Invalid token');
			},
			registerConnection: () => () => undefined,
		};

		const container = createContainer({
			config: {
				port: 7817,
				bind: '127.0.0.1',
				dataDir: testDir,
				logLevel: 'error',
				dev: false,
			},
			database: db,
			hostInputs: { platform: 'linux', homedir: testDir },
			lockAdapter,
			instanceLock: { release: () => undefined } as unknown as LockFileHandle,
			clock: { now: () => '2026-09-14T12:00:00.000Z' },
			pairingService: mockPairingService,
		});

		const server = createHttpServer({ container });
		return { server, container };
	}

	it('R1 Integration: unauthenticated request yields 401 E_UNAUTHORIZED, non-existent run yields 404 E_NOT_FOUND, existing run yields 200 with disk content', async () => {
		const { server } = setupTestServer();
		await server.instance.ready();

		// 1. Unauthenticated request -> 401 E_UNAUTHORIZED
		const unauthedRes = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/runs/run-test-1/log',
		});
		expect(unauthedRes.statusCode).toBe(401);
		const unauthedBody = JSON.parse(unauthedRes.body);
		expect(unauthedBody.error.code).toBe('E_UNAUTHORIZED');

		// 2. Authenticated request for non-existent run -> 404 E_NOT_FOUND
		const token = 'Bearer mock-valid-token';
		const notFoundRes = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/runs/non-existent-run/log',
			headers: { authorization: token },
		});
		expect(notFoundRes.statusCode).toBe(404);
		const notFoundBody = JSON.parse(notFoundRes.body);
		expect(notFoundBody.error.code).toBe('E_NOT_FOUND');

		// 3. Insert document, task, dispatch snapshot, and run in SQLite
		const now = '2026-09-14T12:00:00.000Z';
		db.prepare(
			`INSERT INTO documents (id, docs_path, project_name, content_fingerprint, imported_at, last_seen_at)
			 VALUES ('doc-1', '/repo/docs', 'test-project', 'fp-1', ?, ?)`,
		).run(now, now);

		db.prepare(
			`INSERT INTO tasks (id, doc_id, task_key, title, module_key, deps_json, contract_hash, contract_reasons_json)
			 VALUES ('task-1', 'doc-1', 'M6-T8', 'Run log readback', 'M6', '[]', 'hash-1', '[]')`,
		).run();

		db.prepare(
			`INSERT INTO dispatch_snapshots (id, task_id, input_text, output_text, accept_text, contract_hash, task_paths_json, launch_spec_json, created_at)
			 VALUES ('snap-1', 'task-1', 'Input req text', 'Output target text', 'Accept criteria text', 'hash-1', '[]', '{}', ?)`,
		).run(now);

		const runId = 'run-real-1';
		db.prepare(
			`INSERT INTO runs (id, task_id, attempt_no, kind, state, agent_id, permission_tier, snapshot_id, idempotency_key)
			 VALUES (?, 'task-1', 1, 'implement', 'running', 'codex', 'workspaceWrite', 'snap-1', 'idem-key-1')`,
		).run(runId);

		// Write real log file to disk in runsDataDir: <testDir>/runs/<runId>/raw.log
		const runDir = join(testDir, 'runs', runId);
		mkdirSync(runDir, { recursive: true });
		const rawLogPath = join(runDir, 'raw.log');
		writeFileSync(
			rawLogPath,
			'Line 1: agent initialized\nLine 2: tool_call executing\nLine 3: finished\n',
			'utf8',
		);

		// 4. Authenticated request for existing run -> 200 with disk content
		const successRes = await server.instance.inject({
			method: 'GET',
			url: `/api/v1/runs/${runId}/log`,
			headers: { authorization: token },
		});

		expect(successRes.statusCode).toBe(200);
		const successBody = JSON.parse(successRes.body) as GetRunLogResponse;
		expect(successBody.lines).toEqual([
			'Line 1: agent initialized',
			'Line 2: tool_call executing',
			'Line 3: finished',
		]);
		expect(successBody.totalLines).toBe(3);

		// 5. Test missing vendor session fallback (E-97) via real HTTP container pipeline
		const runWithMissingVendor = 'run-missing-vendor';
		const missingVendorPath = join(testDir, 'missing-vendor-session.json');
		db.prepare(
			`INSERT INTO runs (id, task_id, attempt_no, kind, state, agent_id, permission_tier, snapshot_id, vendor_session_ref, idempotency_key)
			 VALUES (?, 'task-1', 2, 'implement', 'running', 'codex', 'workspaceWrite', 'snap-1', ?, 'idem-key-2')`,
		).run(runWithMissingVendor, missingVendorPath);

		const missingVendorRes = await server.instance.inject({
			method: 'GET',
			url: `/api/v1/runs/${runWithMissingVendor}/log`,
			headers: { authorization: token },
		});
		expect(missingVendorRes.statusCode).toBe(200);
		const missingVendorBody = JSON.parse(missingVendorRes.body) as GetRunLogResponse;
		expect(missingVendorBody.lines).toContain(
			`[调度器提示] 原始会话已不在磁盘（附路径：${missingVendorPath}）`,
		);
		expect(missingVendorBody.lines).toContain('--- 派发快照：输入 ---');
		expect(missingVendorBody.lines).toContain('Input req text');
		expect(missingVendorBody.lines).toContain('--- 派发快照：产出 ---');
		expect(missingVendorBody.lines).toContain('Output target text');
		expect(missingVendorBody.lines).toContain('--- 派发快照：验收标准 ---');
		expect(missingVendorBody.lines).toContain('Accept criteria text');
	});
});
