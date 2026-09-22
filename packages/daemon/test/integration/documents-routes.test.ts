import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	CreateDocumentResponse,
	ListDocumentBatchesResponse,
	ListDocumentTasksResponse,
	RefreshDocumentResponse,
} from '@agent-scheduler/shared/api/documents';
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

const currentDir = dirname(fileURLToPath(import.meta.url));
const testDir = resolve(currentDir, '../fixtures/documents-routes-integration-test');
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

function makeDocPayload(params?: {
	hashSuffix?: string;
	t1Accept?: string;
	extraTasks?: boolean;
}) {
	const suffix = params?.hashSuffix ?? 'v1';
	const t1Accept = params?.t1Accept ?? '1) 验收第一条';
	const t1Hash = `hash-t1-${suffix}`;
	const t2Hash = `hash-t2-${suffix}`;
	const t3Hash = `hash-t3-${suffix}`;

	const contracts: Record<string, { hash: string; effectivePaths: string[] }> = {
		'T-1': { hash: t1Hash, effectivePaths: ['src/a.ts'] },
	};
	const readiness: Record<string, { ready: boolean; contractHash: string; reasons: string[] }> = {
		'T-1': { ready: true, contractHash: t1Hash, reasons: [] },
	};
	const effectivePaths: Record<string, string[]> = {
		'T-1': ['src/a.ts'],
	};
	const tasks: Array<{
		id: string;
		title: string;
		module: string;
		deps: string[];
		input: string;
		output: string;
		accept: string;
		est: number;
		edges: string[];
	}> = [
		{
			id: 'T-1',
			title: '第一个任务',
			module: 'M1',
			deps: [],
			input: '输入文本 1',
			output: '产出文本 1',
			accept: t1Accept,
			est: 1.0,
			edges: ['E-16'],
		},
	];
	const dispatch: Record<string, { contractHash: string; implementation: string; review: string }> =
		{
			'T-1': {
				contractHash: t1Hash,
				implementation: '实现提示词 1',
				review: '审查提示词 1',
			},
		};

	if (params?.extraTasks) {
		contracts['T-2'] = { hash: t2Hash, effectivePaths: ['src/b.ts'] };
		readiness['T-2'] = { ready: true, contractHash: t2Hash, reasons: [] };
		effectivePaths['T-2'] = ['src/b.ts'];
		tasks.push({
			id: 'T-2',
			title: '第二个任务',
			module: 'M1',
			deps: ['T-1'],
			input: '输入文本 2',
			output: '产出文本 2',
			accept: '1) 验收第二条',
			est: 1.5,
			edges: ['E-17'],
		});
		dispatch['T-2'] = {
			contractHash: t2Hash,
			implementation: '实现提示词 2',
			review: '审查提示词 2',
		};

		contracts['T-3'] = { hash: t3Hash, effectivePaths: ['src/c.ts'] };
		readiness['T-3'] = { ready: true, contractHash: t3Hash, reasons: [] };
		effectivePaths['T-3'] = ['src/c.ts'];
		tasks.push({
			id: 'T-3',
			title: '第三个任务',
			module: 'M2',
			deps: ['T-2'],
			input: '输入文本 3',
			output: '产出文本 3',
			accept: '1) 验收第三条',
			est: 2.0,
			edges: ['E-18'],
		});
		dispatch['T-3'] = {
			contractHash: t3Hash,
			implementation: '实现提示词 3',
			review: '审查提示词 3',
		};
	}

	return {
		schemaVersion: 1,
		project: '集成测试文档',
		pres: {
			handoff: {
				repo: 'test-repo',
				mainBranch: 'main',
				branchPrefix: 'task/',
			},
		},
		handoff: {
			version: '1.1.0',
			schemaVersion: 1,
			contracts,
			readiness,
			effectivePaths,
		},
		data: { tasks },
		dispatch,
	};
}

function createDocsDataJs(params?: {
	hashSuffix?: string;
	t1Accept?: string;
	extraTasks?: boolean;
}): string {
	return `window.DOCS = ${JSON.stringify(makeDocPayload(params))};`;
}

describe('M2-T7 Documents Routes Integration: Refresh, Tasks, Batches & 401 Auth', () => {
	let db: DatabaseConnection;

	beforeEach(() => {
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

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true, force: true });
	});

	function setupServer() {
		const lockAdapter = createMemoryLockAdapter();
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
			clock: { now: () => '2026-09-10T12:00:00.000Z' },
		});

		const server = createHttpServer({ container });
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

	it('AC 5 & E-08: All three routes reject unauthenticated requests with 401 and standard error envelope', async () => {
		const { server } = setupServer();
		await server.instance.ready();

		const routesToTest = [
			{ method: 'POST' as const, url: '/api/v1/documents/doc-123/refresh' },
			{ method: 'GET' as const, url: '/api/v1/documents/doc-123/tasks' },
			{ method: 'GET' as const, url: '/api/v1/documents/doc-123/batches' },
		];

		for (const route of routesToTest) {
			// No token provided
			const resNoAuth = await server.instance.inject({
				method: route.method,
				url: route.url,
			});
			expect(resNoAuth.statusCode, `${route.method} ${route.url} without auth must be 401`).toBe(
				401,
			);
			const bodyNoAuth = JSON.parse(resNoAuth.body);
			expect(bodyNoAuth.error).toBeDefined();
			expect(bodyNoAuth.error.code).toBe('E_UNAUTHORIZED');
			expect(typeof bodyNoAuth.error.message).toBe('string');
			expect(typeof bodyNoAuth.error.requestId).toBe('string');

			// Invalid token provided
			const resInvalidAuth = await server.instance.inject({
				method: route.method,
				url: route.url,
				headers: { authorization: 'Bearer invalid-token-xyz' },
			});
			expect(
				resInvalidAuth.statusCode,
				`${route.method} ${route.url} with invalid token must be 401`,
			).toBe(401);
			const bodyInvalid = JSON.parse(resInvalidAuth.body);
			expect(bodyInvalid.error).toBeDefined();
			expect(bodyInvalid.error.code).toBe('E_UNAUTHORIZED');

			// E-08: No bypass for local IP / forwarded headers
			const resSpoofed = await server.instance.inject({
				method: route.method,
				url: route.url,
				headers: {
					'x-forwarded-for': '127.0.0.1',
					'x-real-ip': '127.0.0.1',
				},
			});
			expect(
				resSpoofed.statusCode,
				`${route.method} ${route.url} with spoofed local headers must still be 401`,
			).toBe(401);
		}
	});

	it('AC 4: All three routes return 404 E_NOT_FOUND when docId does not exist', async () => {
		const { server, container } = setupServer();
		const authToken = await getAuthToken(container);
		await server.instance.ready();

		const nonExistentId = 'doc-does-not-exist';

		const refreshRes = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${nonExistentId}/refresh`,
			headers: { authorization: authToken },
		});
		expect(refreshRes.statusCode).toBe(404);
		expect(JSON.parse(refreshRes.body).error.code).toBe('E_NOT_FOUND');

		const tasksRes = await server.instance.inject({
			method: 'GET',
			url: `/api/v1/documents/${nonExistentId}/tasks`,
			headers: { authorization: authToken },
		});
		expect(tasksRes.statusCode).toBe(404);
		expect(JSON.parse(tasksRes.body).error.code).toBe('E_NOT_FOUND');

		const batchesRes = await server.instance.inject({
			method: 'GET',
			url: `/api/v1/documents/${nonExistentId}/batches`,
			headers: { authorization: authToken },
		});
		expect(batchesRes.statusCode).toBe(404);
		expect(JSON.parse(batchesRes.body).error.code).toBe('E_NOT_FOUND');
	});

	it('AC 2, E-17, E-19, E-82: POST /documents/:docId/refresh handles unchanged, accept change, and unreadable source', async () => {
		const { server, container } = setupServer();
		const authToken = await getAuthToken(container);
		await server.instance.ready();

		const docFolder = join(testDir, 'refresh-test-doc');
		mkdirSync(docFolder, { recursive: true });
		const docsDataPath = join(docFolder, 'docs-data.js');
		writeFileSync(docsDataPath, createDocsDataJs({ hashSuffix: 'v1' }), 'utf8');
		writeFileSync(join(docFolder, 'index.html'), '<html>Reader</html>', 'utf8');

		// 1. Initial import
		const importRes = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/documents',
			headers: { authorization: authToken },
			payload: { docsPath: docsDataPath },
		});
		expect(importRes.statusCode).toBe(200);
		const docId = (JSON.parse(importRes.body) as CreateDocumentResponse).document.id;

		// Subscribe to events
		const emittedEvents: Array<{ kind: string; payload: unknown }> = [];
		container.events.bus.subscribe((envelope) => {
			emittedEvents.push({ kind: envelope.kind, payload: envelope.payload });
		});

		// 2. Refresh with identical content -> changed: false, flags all false, NO event emitted
		const refreshUnchangedRes = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers: { authorization: authToken },
		});
		expect(refreshUnchangedRes.statusCode).toBe(200);
		const unchangedBody = JSON.parse(refreshUnchangedRes.body) as RefreshDocumentResponse;
		expect(unchangedBody.changed).toBe(false);
		expect(unchangedBody.flags.hasAcceptChanged).toBe(false);
		expect(unchangedBody.flags.hasPromptChanged).toBe(false);
		expect(unchangedBody.flags.isRemovedFromDoc).toBe(false);
		expect(emittedEvents.filter((e) => e.kind === 'system.docs_changed')).toHaveLength(0);

		// Take a dispatch snapshot for T-1 so that we can compare subsequent doc changes
		const taskT1 = container.repos.tasks.findByDocAndKey(docId, 'T-1');
		expect(taskT1).not.toBeNull();
		if (!taskT1) throw new Error('taskT1 not found');
		const snapshotsRepo = container.repos.dispatchSnapshots;
		if (!snapshotsRepo) throw new Error('dispatchSnapshots repo not found');
		snapshotsRepo.takeSnapshotForTask({
			taskId: taskT1.id,
			launchSpecJson: JSON.stringify({
				adapter: 'process',
				command: 'echo',
				args: [],
			}),
			createdAt: new Date().toISOString(),
		});

		// 3. Update task accept text in docs-data.js and refresh -> changed: true, flags.hasAcceptChanged: true, emits system.docs_changed
		writeFileSync(
			docsDataPath,
			createDocsDataJs({ hashSuffix: 'v2', t1Accept: '2) 验收已被修改的新要求' }),
			'utf8',
		);
		const refreshChangedRes = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers: { authorization: authToken },
		});
		expect(refreshChangedRes.statusCode).toBe(200);
		const changedBody = JSON.parse(refreshChangedRes.body) as RefreshDocumentResponse;
		expect(changedBody.changed).toBe(true);
		expect(changedBody.flags.hasAcceptChanged).toBe(true);

		const docsChangedEvents = emittedEvents.filter((e) => e.kind === 'system.docs_changed');
		expect(docsChangedEvents.length).toBeGreaterThanOrEqual(1);

		// 4. File unreadable: remove docs-data.js -> 409 E_DOC_SOURCE_UNREADABLE, is_source_readable = 0, existing records not deleted
		rmSync(docsDataPath);
		const refreshUnreadableRes = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers: { authorization: authToken },
		});
		expect(refreshUnreadableRes.statusCode).toBe(409);
		const unreadableBody = JSON.parse(refreshUnreadableRes.body);
		expect(unreadableBody.error.code).toBe('E_DOC_SOURCE_UNREADABLE');

		// Verify database state: is_source_readable is 0, but records are NOT deleted
		const docInDb = container.repos.documents.findById(docId);
		expect(docInDb).not.toBeNull();
		if (!docInDb) throw new Error('docInDb not found');
		expect(docInDb.is_source_readable).toBe(0);

		const tasksInDb = container.repos.tasks.listByDocId(docId);
		expect(tasksInDb.length).toBeGreaterThan(0);
		const snapshotsInDb = snapshotsRepo.listByTaskId(taskT1.id);
		expect(snapshotsInDb.length).toBeGreaterThan(0);
	});

	it('AC 3: GET /documents/:docId/tasks supports state filter, cursor pagination, and derived state', async () => {
		const { server, container } = setupServer();
		const authToken = await getAuthToken(container);
		await server.instance.ready();

		const docFolder = join(testDir, 'tasks-test-doc');
		mkdirSync(docFolder, { recursive: true });
		const docsDataPath = join(docFolder, 'docs-data.js');
		writeFileSync(docsDataPath, createDocsDataJs({ hashSuffix: 'v1', extraTasks: true }), 'utf8');
		writeFileSync(join(docFolder, 'index.html'), '<html>Reader</html>', 'utf8');

		const importRes = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/documents',
			headers: { authorization: authToken },
			payload: { docsPath: docsDataPath },
		});
		expect(importRes.statusCode).toBe(200);
		const docId = (JSON.parse(importRes.body) as CreateDocumentResponse).document.id;

		const t1 = container.repos.tasks.findByDocAndKey(docId, 'T-1');
		const t2 = container.repos.tasks.findByDocAndKey(docId, 'T-2');
		const t3 = container.repos.tasks.findByDocAndKey(docId, 'T-3');
		expect(t1 && t2 && t3).toBeTruthy();
		if (!t1 || !t2 || !t3) throw new Error('tasks not found');

		const snapshotsRepo2 = container.repos.dispatchSnapshots;
		if (!snapshotsRepo2) throw new Error('dispatchSnapshots repo not found');

		// T-1 has a run with state 'landed'
		const now = new Date().toISOString();
		const snap1 = snapshotsRepo2.takeSnapshotForTask({
			taskId: t1.id,
			launchSpecJson: JSON.stringify({ adapter: 'process' }),
			createdAt: now,
		});

		container.repos.runs.insert({
			id: 'run-t1-1',
			task_id: t1.id,
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			origin: 'dispatch',
			agent_id: 'codex',
			permission_tier: 'readOnly',
			snapshot_id: snap1.id,
		});

		// T-2 has manual_state = 'failed', but a run with state 'running' (manual_state must take precedence!)
		container.repos.tasks.updateManualState(t2.id, 'failed');
		const snap2 = snapshotsRepo2.takeSnapshotForTask({
			taskId: t2.id,
			launchSpecJson: JSON.stringify({ adapter: 'process' }),
			createdAt: now,
		});

		container.repos.runs.insert({
			id: 'run-t2-1',
			task_id: t2.id,
			attempt_no: 1,
			kind: 'implement',
			state: 'running',
			origin: 'dispatch',
			agent_id: 'codex',
			permission_tier: 'readOnly',
			snapshot_id: snap2.id,
		});

		// T-3 has no runs -> state must be 'never_dispatched'

		// 1. Fetch all tasks without filter
		const allTasksRes = await server.instance.inject({
			method: 'GET',
			url: `/api/v1/documents/${docId}/tasks`,
			headers: { authorization: authToken },
		});
		expect(allTasksRes.statusCode).toBe(200);
		const allTasksBody = JSON.parse(allTasksRes.body) as ListDocumentTasksResponse;
		expect(allTasksBody.tasks).toHaveLength(3);

		const taskMap = new Map(allTasksBody.tasks.map((t) => [t.taskKey, t]));
		expect(taskMap.get('T-1')?.state).toBe('landed');
		expect(taskMap.get('T-2')?.state).toBe('failed'); // manual_state precedence
		expect(taskMap.get('T-3')?.state).toBe('never_dispatched');

		// 2. Filter by state=never_dispatched
		const neverDispatchedRes = await server.instance.inject({
			method: 'GET',
			url: `/api/v1/documents/${docId}/tasks?state=never_dispatched`,
			headers: { authorization: authToken },
		});
		expect(neverDispatchedRes.statusCode).toBe(200);
		const neverDispatchedBody = JSON.parse(neverDispatchedRes.body) as ListDocumentTasksResponse;
		expect(neverDispatchedBody.tasks).toHaveLength(1);
		expect(neverDispatchedBody.tasks[0]?.taskKey).toBe('T-3');

		// 3. Filter by state=landed
		const landedRes = await server.instance.inject({
			method: 'GET',
			url: `/api/v1/documents/${docId}/tasks?state=landed`,
			headers: { authorization: authToken },
		});
		expect(landedRes.statusCode).toBe(200);
		const landedBody = JSON.parse(landedRes.body) as ListDocumentTasksResponse;
		expect(landedBody.tasks).toHaveLength(1);
		expect(landedBody.tasks[0]?.taskKey).toBe('T-1');

		// 4. Invalid state returns 400 E_VALIDATION
		const invalidStateRes = await server.instance.inject({
			method: 'GET',
			url: `/api/v1/documents/${docId}/tasks?state=invalid_nonexistent_state`,
			headers: { authorization: authToken },
		});
		expect(invalidStateRes.statusCode).toBe(400);
		expect(JSON.parse(invalidStateRes.body).error.code).toBe('E_VALIDATION');

		// 5. Cursor pagination with limit=2
		const page1Res = await server.instance.inject({
			method: 'GET',
			url: `/api/v1/documents/${docId}/tasks?limit=2`,
			headers: { authorization: authToken },
		});
		expect(page1Res.statusCode).toBe(200);
		const page1Body = JSON.parse(page1Res.body) as ListDocumentTasksResponse;
		expect(page1Body.tasks).toHaveLength(2);
		expect(page1Body.nextCursor).toBe('T-2');

		// Fetch page 2 using nextCursor
		const page2Res = await server.instance.inject({
			method: 'GET',
			url: `/api/v1/documents/${docId}/tasks?cursor=${page1Body.nextCursor}&limit=2`,
			headers: { authorization: authToken },
		});
		expect(page2Res.statusCode).toBe(200);
		const page2Body = JSON.parse(page2Res.body) as ListDocumentTasksResponse;
		expect(page2Body.tasks).toHaveLength(1);
		expect(page2Body.tasks[0]?.taskKey).toBe('T-3');
		expect(page2Body.nextCursor).toBeNull(); // 到底为 null

		// 6. Limit exceeding 200 returns 400 E_VALIDATION
		const overLimitRes = await server.instance.inject({
			method: 'GET',
			url: `/api/v1/documents/${docId}/tasks?limit=250`,
			headers: { authorization: authToken },
		});
		expect(overLimitRes.statusCode).toBe(400);
		expect(JSON.parse(overLimitRes.body).error.code).toBe('E_VALIDATION');
	});

	it('AC 4: GET /documents/:docId/batches returns BatchDto[] sorted by batchNo ASC with canWrapup and notInHeadCount', async () => {
		const { server, container } = setupServer();
		const authToken = await getAuthToken(container);
		await server.instance.ready();

		const docFolder = join(testDir, 'batches-test-doc');
		mkdirSync(docFolder, { recursive: true });
		const docsDataPath = join(docFolder, 'docs-data.js');
		writeFileSync(docsDataPath, createDocsDataJs({ hashSuffix: 'v1', extraTasks: true }), 'utf8');
		writeFileSync(join(docFolder, 'index.html'), '<html>Reader</html>', 'utf8');

		const importRes = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/documents',
			headers: { authorization: authToken },
			payload: { docsPath: docsDataPath },
		});
		expect(importRes.statusCode).toBe(200);
		const docId = (JSON.parse(importRes.body) as CreateDocumentResponse).document.id;

		const batchesRes = await server.instance.inject({
			method: 'GET',
			url: `/api/v1/documents/${docId}/batches`,
			headers: { authorization: authToken },
		});
		expect(batchesRes.statusCode).toBe(200);
		const batchesBody = JSON.parse(batchesRes.body) as ListDocumentBatchesResponse;

		expect(batchesBody.batches.length).toBeGreaterThanOrEqual(1);

		// Assert batchNo ascending order
		for (let i = 0; i < batchesBody.batches.length - 1; i++) {
			const current = batchesBody.batches[i];
			const next = batchesBody.batches[i + 1];
			if (current && next) {
				expect(current.batchNo).toBeLessThan(next.batchNo);
			}
		}

		// Assert BatchDto fields including canWrapup and notInHeadCount
		for (const batch of batchesBody.batches) {
			expect(batch.id).toBeDefined();
			expect(batch.docId).toBe(docId);
			expect(typeof batch.batchNo).toBe('number');
			expect(batch.state).toBeDefined();
			expect(typeof batch.canWrapup).toBe('boolean');
			expect(typeof batch.notInHeadCount).toBe('number');
		}
	});
});
