import { once } from 'node:events';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { BatchDto } from '@agent-scheduler/shared/api/batches';
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
const testDir = resolve(currentDir, '../fixtures/batch-summary-integration-test');
const migrationsDir = resolve(currentDir, '../../migrations');
const dbPath = join(testDir, 'test.db');
const sqliteModule = createRequire(import.meta.url).resolve('better-sqlite3');

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

describe('R13-T98191508 Batch Summary & Authoritative DTO (AC 1, AC 2, E-272, E-275, E-284, E-298)', () => {
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
			clock: { now: () => '2026-09-25T12:00:00.000Z' },
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
		const c = createContainer({
			config: {
				port: 7820,
				bind: '127.0.0.1',
				dataDir: testDir,
				logLevel: 'error',
				dev: false,
			},
			database: db,
			hostInputs: { platform: 'linux', homedir: testDir },
			lockAdapter,
			instanceLock: { release: () => undefined } as unknown as LockFileHandle,
			clock: { now: () => '2026-09-25T12:00:00.000Z' },
		});
		container = c;
		const s = createHttpServer({ container: c });
		server = s;
		const batchService = c.services.batch;
		if (!batchService) {
			throw new Error('Batch service is not available');
		}
		return { server: s, container: c, batchService };
	}

	async function getAuthToken(c: ReturnType<typeof createContainer>): Promise<string> {
		const activeCode =
			c.services.pairing.getActivePairingCode()?.code ??
			c.services.pairing.createPairingCode().code;
		const claim = await c.services.pairing.claimPairingCode({
			code: activeCode,
			deviceName: 'test-device',
		});
		return `Bearer ${claim.token}`;
	}

	function seedBaseDocAndBatch(docId = 'doc-1', batchId = 'batch-1', batchNo = 1, state = 'idle') {
		db.prepare(
			`INSERT INTO documents (
				id, docs_path, project_name, repo_path, main_branch, branch_prefix,
				lane_count, content_fingerprint, is_source_readable, is_takeover_notified,
				imported_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			docId,
			'docs/Agent任务调度器-开发文档',
			'Agent任务调度器',
			'/tmp/repo',
			'main',
			'task/',
			2,
			'fp-1',
			1,
			0,
			'2026-09-25T12:00:00.000Z',
			'2026-09-25T12:00:00.000Z',
		);

		db.prepare(
			`INSERT INTO batches (id, doc_id, batch_no, state)
			VALUES (?, ?, ?, ?)`,
		).run(batchId, docId, batchNo, state);
	}

	function insertTask(
		id: string,
		docId: string,
		batchId: string,
		taskKey: string,
		manualState: string | null = null,
	) {
		db.prepare(
			`INSERT INTO tasks (
				id, doc_id, batch_id, task_key, title, module_key, deps_json,
				contract_hash, is_contract_ready, contract_reasons_json, manual_state
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			docId,
			batchId,
			taskKey,
			`Title for ${taskKey}`,
			'M2',
			'[]',
			'hash-1',
			1,
			'[]',
			manualState,
		);
	}

	function insertRun(run: {
		id: string;
		taskId: string | null;
		attemptNo: number;
		kind: string;
		state: string;
		origin?: string;
		batchId?: string | null;
		isInHead?: number;
	}) {
		const snapshotId = `snap-${run.id}`;
		db.prepare(
			`INSERT OR IGNORE INTO dispatch_snapshots (
				id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?)`,
		).run(snapshotId, run.taskId, 'hash-1', '[]', '{}', '2026-09-25T12:00:00.000Z');

		db.prepare(
			`INSERT INTO runs (
				id, task_id, attempt_no, kind, state, agent_id, permission_tier,
				snapshot_id, origin, batch_id, is_in_head, started_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			run.id,
			run.taskId,
			run.attemptNo,
			run.kind,
			run.state,
			'agent-1',
			'workspaceWrite',
			snapshotId,
			run.origin ?? 'dispatch',
			run.batchId ?? null,
			run.isInHead ?? 0,
			'2026-09-25T12:00:00.000Z',
		);
	}

	// ─── 1. 空批次断言 ───
	it('asserts empty batch summary and defaultExpanded based on state', async () => {
		const { batchService } = setupServer();
		seedBaseDocAndBatch('doc-1', 'batch-empty', 1, 'idle');

		const batchDto = await batchService.getBatch('batch-empty');
		expect(batchDto.taskCount).toBe(0);
		expect(batchDto.landedCount).toBe(0);
		expect(batchDto.runningCount).toBe(0);
		expect(batchDto.waitingCount).toBe(0);
		expect(batchDto.defaultExpanded).toBe(false);

		// 批次转为 running 时，defaultExpanded 应为 true
		batchService.transitionBatch('batch-empty', 'running', 'test start');
		const runningBatchDto = await batchService.getBatch('batch-empty');
		expect(runningBatchDto.state).toBe('running');
		expect(runningBatchDto.taskCount).toBe(0);
		expect(runningBatchDto.defaultExpanded).toBe(true);
	});

	// ─── 2. 人工停靠断言 ───
	it('asserts manual park awaiting_human increments waitingCount', async () => {
		const { batchService } = setupServer();
		seedBaseDocAndBatch('doc-1', 'batch-park', 1, 'running');
		insertTask('t-park', 'doc-1', 'batch-park', 'M2-T1', 'awaiting_human');

		const batchDto = await batchService.getBatch('batch-park');
		expect(batchDto.taskCount).toBe(1);
		expect(batchDto.landedCount).toBe(0);
		expect(batchDto.runningCount).toBe(0);
		expect(batchDto.waitingCount).toBe(1);
		expect(batchDto.defaultExpanded).toBe(true);

		const list = await batchService.listBatches('doc-1');
		expect(list[0]?.waitingCount).toBe(1);
		expect(list[0]?.runningCount).toBe(0);
	});

	// ─── 3. 跨批修复断言（E-275 批次级口径：忽略在途 wrapup-fix 运行） ───
	it('asserts cross-batch fix preserves landedCount for source batch (E-275)', async () => {
		const { container, batchService } = setupServer();
		seedBaseDocAndBatch('doc-1', 'batch-1', 1, 'done');
		// 第二批
		db.prepare(
			`INSERT INTO batches (id, doc_id, batch_no, state)
			VALUES (?, ?, ?, ?)`,
		).run('batch-2', 'doc-1', 2, 'running');

		// 任务属于 batch-1
		insertTask('t-fix', 'doc-1', 'batch-1', 'M2-T1');
		// 历史实施运行已 landed
		insertRun({
			id: 'run-impl-1',
			taskId: 't-fix',
			attemptNo: 1,
			kind: 'implement',
			state: 'landed',
			isInHead: 1,
		});

		// 跨批修复运行：归属 batch-2，状态 running，origin 为 wrapup-fix
		insertRun({
			id: 'run-fix-1',
			taskId: 't-fix',
			attemptNo: 2,
			kind: 'implement',
			state: 'running',
			origin: 'wrapup-fix',
			batchId: 'batch-2',
			isInHead: 0,
		});

		// 批次 1 读取：按批次级口径忽略在途 wrapup-fix，保持 landedCount=1，runningCount=0
		const b1 = await batchService.getBatch('batch-1');
		expect(b1.taskCount).toBe(1);
		expect(b1.landedCount).toBe(1);
		expect(b1.runningCount).toBe(0);
		expect(b1.waitingCount).toBe(0);

		// 快照中读取一致
		const snap = await container.services.dispatch.getSnapshot('doc-1');
		const b1Snap = snap.batches.find((b) => b.id === 'batch-1');
		expect(b1Snap?.landedCount).toBe(1);
		expect(b1Snap?.runningCount).toBe(0);
	});

	// ─── 4. 未进 HEAD 分支断言（E-272: awaiting_landing, notInHeadCount > 0, defaultExpanded=true） ───
	it('asserts unmerged landed branch results in awaiting_landing and defaultExpanded (E-272, E-298)', async () => {
		const { batchService } = setupServer();
		seedBaseDocAndBatch('doc-1', 'batch-landing', 1, 'awaiting_landing');
		insertTask('t-not-in-head', 'doc-1', 'batch-landing', 'M2-T1');
		insertRun({
			id: 'run-unmerged',
			taskId: 't-not-in-head',
			attemptNo: 1,
			kind: 'implement',
			state: 'landed',
			isInHead: 0,
		});

		const batchDto = await batchService.getBatch('batch-landing');
		expect(batchDto.state).toBe('awaiting_landing');
		expect(batchDto.taskCount).toBe(1);
		expect(batchDto.landedCount).toBe(1);
		expect(batchDto.notInHeadCount).toBe(1);
		expect(batchDto.runningCount).toBe(0);
		expect(batchDto.waitingCount).toBe(0);
		expect(batchDto.defaultExpanded).toBe(true);
		expect(batchDto.canWrapup).toBe(false);
	});

	// ─── 5. 真实事务提交边界与并发写入一致性断言 (R2) ───
	it('asserts consistency between getBatch, listBatches, and getSnapshot across transaction commit boundaries and concurrent writes', async () => {
		const { container, batchService } = setupServer();
		seedBaseDocAndBatch('doc-1', 'batch-tx', 1, 'running');
		insertTask('t-tx-1', 'doc-1', 'batch-tx', 'M2-T1');
		insertTask('t-tx-2', 'doc-1', 'batch-tx', 'M2-T2');

		// 初始状态：T1 在跑，T2 从未派发
		insertRun({
			id: 'run-tx-1',
			taskId: 't-tx-1',
			attemptNo: 1,
			kind: 'implement',
			state: 'running',
		});

		// ─── 阶段 A: 事务开始前读取，三者一致 ───
		const [preSingle, preList, preSnap] = await Promise.all([
			batchService.getBatch('batch-tx'),
			batchService.listBatches('doc-1'),
			container.services.dispatch.getSnapshot('doc-1'),
		]);
		const preListBatch = preList.find((b) => b.id === 'batch-tx');
		const preSnapBatch = preSnap.batches.find((b) => b.id === 'batch-tx');
		for (const target of [preSingle, preListBatch, preSnapBatch]) {
			expect(target).toBeDefined();
			expect(target?.taskCount).toBe(2);
			expect(target?.landedCount).toBe(0);
			expect(target?.runningCount).toBe(1);
			expect(target?.waitingCount).toBe(0);
			expect(target?.defaultExpanded).toBe(true);
		}

		// ─── 阶段 B: 真实事务回滚测试：回滚后状态与计数绝不污染 ───
		const rollbackTx = db.transaction(() => {
			db.prepare('UPDATE runs SET state = ? WHERE id = ?').run('landed', 'run-tx-1');
			insertTask('t-tx-aborted', 'doc-1', 'batch-tx', 'M2-T99');
			throw new Error('Simulated transaction rollback');
		});
		expect(() => rollbackTx()).toThrow('Simulated transaction rollback');

		const [rbSingle, rbList, rbSnap] = await Promise.all([
			batchService.getBatch('batch-tx'),
			batchService.listBatches('doc-1'),
			container.services.dispatch.getSnapshot('doc-1'),
		]);
		for (const target of [
			rbSingle,
			rbList.find((b) => b.id === 'batch-tx'),
			rbSnap.batches.find((b) => b.id === 'batch-tx'),
		]) {
			expect(target?.taskCount).toBe(2);
			expect(target?.landedCount).toBe(0);
			expect(target?.runningCount).toBe(1);
			expect(target?.waitingCount).toBe(0);
		}

		// ─── 阶段 C: 真实事务提交：原子跃迁到新事实 ───
		const commitTx = db.transaction(() => {
			db.prepare('UPDATE runs SET state = ?, is_in_head = 1 WHERE id = ?').run(
				'landed',
				'run-tx-1',
			);
			db.prepare('UPDATE tasks SET manual_state = ? WHERE id = ?').run('awaiting_human', 't-tx-2');
			insertTask('t-tx-3', 'doc-1', 'batch-tx', 'M2-T3');
			insertRun({
				id: 'run-tx-3',
				taskId: 't-tx-3',
				attemptNo: 1,
				kind: 'implement',
				state: 'running',
			});
		});
		commitTx();

		// 事务提交后，并行获取三者，断言字段严格一致
		const [postSingle, postList, postSnap] = await Promise.all([
			batchService.getBatch('batch-tx'),
			batchService.listBatches('doc-1'),
			container.services.dispatch.getSnapshot('doc-1'),
		]);
		for (const target of [
			postSingle,
			postList.find((b) => b.id === 'batch-tx'),
			postSnap.batches.find((b) => b.id === 'batch-tx'),
		]) {
			expect(target).toBeDefined();
			expect(target?.taskCount).toBe(3);
			expect(target?.landedCount).toBe(1);
			expect(target?.runningCount).toBe(1);
			expect(target?.waitingCount).toBe(1);
			expect(target?.defaultExpanded).toBe(true);
		}

		// A second SQLite connection owns an uncommitted write while the service reads.
		const writer = new Worker(
			`
				const { parentPort, workerData } = require('node:worker_threads');
				const Database = require(workerData.sqliteModule);
				const writerDb = new Database(workerData.dbPath);
				writerDb.pragma('journal_mode = WAL');
				writerDb.exec('BEGIN IMMEDIATE');
				writerDb.prepare("UPDATE runs SET state = 'landed' WHERE id = 'run-tx-3'").run();
				parentPort.postMessage('staged');
				parentPort.once('message', () => {
					writerDb.prepare("UPDATE tasks SET manual_state = 'running' WHERE id = 't-tx-2'").run();
					writerDb.exec('COMMIT');
					writerDb.close();
					parentPort.postMessage('committed');
					parentPort.close();
				});
			`,
			{ eval: true, workerData: { dbPath, sqliteModule } },
		);
		try {
			const [staged] = await once(writer, 'message');
			expect(staged).toBe('staged');
			const [duringSingle, duringList, duringSnap] = await Promise.all([
				batchService.getBatch('batch-tx'),
				batchService.listBatches('doc-1'),
				container.services.dispatch.getSnapshot('doc-1'),
			]);
			for (const target of [
				duringSingle,
				duringList.find((b) => b.id === 'batch-tx'),
				duringSnap.batches.find((b) => b.id === 'batch-tx'),
			]) {
				expect(target?.taskCount).toBe(3);
				expect(target?.landedCount).toBe(1);
				expect(target?.runningCount).toBe(1);
				expect(target?.waitingCount).toBe(1);
			}
			writer.postMessage('commit');
			const [committed] = await once(writer, 'message');
			expect(committed).toBe('committed');
		} finally {
			await writer.terminate();
		}

		// Every formal read reflects both committed changes, without a partial state.
		const [concurrentSingle, concurrentList, concurrentSnap] = await Promise.all([
			batchService.getBatch('batch-tx'),
			batchService.listBatches('doc-1'),
			container.services.dispatch.getSnapshot('doc-1'),
		]);
		const concListBatch = concurrentList.find((b) => b.id === 'batch-tx');
		const concSnapBatch = concurrentSnap.batches.find((b) => b.id === 'batch-tx');

		for (const target of [concurrentSingle, concListBatch, concSnapBatch]) {
			expect(target).toBeDefined();
			expect(target?.taskCount).toBe(3);
			expect(target?.landedCount).toBe(2);
			expect(target?.runningCount).toBe(1);
			expect(target?.waitingCount).toBe(0);
			expect(target?.defaultExpanded).toBe(true);
		}
	});

	// ─── 6. HTTP API 级断言：GET /documents/:docId/batches 与 GET /snapshot 同一 DTO ───
	it('asserts GET /documents/:docId/batches and GET /snapshot return identical BatchDto with authoritative counts', async () => {
		const { server, container } = setupServer();
		await server.instance.ready();
		const token = await getAuthToken(container);

		seedBaseDocAndBatch('doc-api', 'batch-api', 1, 'running');
		insertTask('t-api-1', 'doc-api', 'batch-api', 'M2-T1');
		insertRun({
			id: 'run-api-1',
			taskId: 't-api-1',
			attemptNo: 1,
			kind: 'implement',
			state: 'reviewing',
		});

		const batchesRes = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/documents/doc-api/batches',
			headers: { authorization: token },
		});
		expect(batchesRes.statusCode).toBe(200);
		const batchesBody = JSON.parse(batchesRes.body) as { batches: BatchDto[] };
		const b1 = batchesBody.batches[0];
		expect(b1).toBeDefined();
		if (!b1) throw new Error('Expected batch to exist');
		expect(b1.taskCount).toBe(1);
		expect(b1.landedCount).toBe(0);
		expect(b1.runningCount).toBe(1);
		expect(b1.waitingCount).toBe(0);
		expect(b1.defaultExpanded).toBe(true);

		const snapRes = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/snapshot?docId=doc-api',
			headers: { authorization: token },
		});
		expect(snapRes.statusCode).toBe(200);
		const snapBody = JSON.parse(snapRes.body) as SnapshotResponse;
		const bSnap = snapBody.batches.find((b) => b.id === 'batch-api');
		expect(bSnap).toBeDefined();
		expect(bSnap?.taskCount).toBe(b1.taskCount);
		expect(bSnap?.landedCount).toBe(b1.landedCount);
		expect(bSnap?.runningCount).toBe(b1.runningCount);
		expect(bSnap?.waitingCount).toBe(b1.waitingCount);
		expect(bSnap?.defaultExpanded).toBe(b1.defaultExpanded);
	});
});
