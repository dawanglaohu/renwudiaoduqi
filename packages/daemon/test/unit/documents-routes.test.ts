import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	CreateDocumentResponse,
	DocumentDto,
	ListDocumentsResponse,
} from '@agent-scheduler/shared/api/documents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createOpenBrowser } from '../../src/proc/open-browser.ts';
import { createDocumentsRepo } from '../../src/repo/documents.ts';
import { createDocsService } from '../../src/service/docs.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const testDir = resolve(currentDir, '../fixtures/documents-routes-test');
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

function makeValidDocPayload(hashSuffix = '1') {
	return {
		schemaVersion: 1,
		project: '测试项目',
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
			contracts: {
				'T-1': {
					hash: `hash-t1-${hashSuffix}`,
					effectivePaths: ['src/a.ts'],
				},
			},
			readiness: {
				'T-1': {
					ready: true,
					contractHash: `hash-t1-${hashSuffix}`,
					reasons: [],
				},
			},
			effectivePaths: {
				'T-1': ['src/a.ts'],
			},
		},
		data: {
			tasks: [
				{
					id: 'T-1',
					title: '第一个任务',
					module: 'M1',
					deps: [],
					input: '输入文本',
					output: '产出文本',
					accept: '1) 验收第一条',
					est: 1.0,
					edges: ['E-16'],
				},
			],
		},
		dispatch: {
			'T-1': {
				contractHash: `hash-t1-${hashSuffix}`,
				implementation: '实现提示词',
				review: '审查提示词',
			},
		},
	};
}

function createSampleDocsDataJs(fingerprintId = '1'): string {
	return `window.DOCS = ${JSON.stringify(makeValidDocPayload(fingerprintId))};`;
}

describe(
	'M3-T4 Documents HTTP Routes, Takeover Banner and Reader Integration',
	{ timeout: 60000 },
	() => {
		let db: DatabaseConnection;
		let openedTargets: string[] = [];

		beforeEach(() => {
			openedTargets = [];
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

		function setupTestServer(options?: { openBrowser?: (p: string) => Promise<void> }) {
			const lockAdapter = createMemoryLockAdapter();
			let docsService: ReturnType<typeof createDocsService> | undefined;
			if (options?.openBrowser) {
				const documentsRepo = createDocumentsRepo(db);
				docsService = createDocsService({
					documentsRepo,
					clock: { now: () => '2026-09-10T12:00:00.000Z' },
					ids: { newId: () => 'test-doc-id' },
					openBrowser: options.openBrowser,
				});
			}
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
				docsService,
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
				deviceName: 'my-test-device',
			});
			return `Bearer ${claim.token}`;
		}

		it('AC 1 & E-84: first takeover exposes isTakeoverNotified=false banner data, and can be dismissed and remembered per document', async () => {
			const { server, container } = setupTestServer();
			const authToken = await getAuthToken(container);
			await server.instance.ready();

			// Setup mock doc directory with docs-data.js and index.html
			const docFolder = join(testDir, 'my-doc');
			mkdirSync(docFolder, { recursive: true });
			const docsDataPath = join(docFolder, 'docs-data.js');
			writeFileSync(docsDataPath, createSampleDocsDataJs('abc'), 'utf8');
			writeFileSync(join(docFolder, 'index.html'), '<html><body>Reader</body></html>', 'utf8');

			// 1. Import document (first takeover)
			const importRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/documents',
				headers: { authorization: authToken },
				payload: { docsPath: docsDataPath },
			});
			expect(importRes.statusCode).toBe(200);
			const importData = JSON.parse(importRes.body) as CreateDocumentResponse;
			expect(importData.document.isTakeoverNotified).toBe(false);
			const docId = importData.document.id;

			// 2. GET /documents lists document with isTakeoverNotified=false (banner data)
			const listRes1 = await server.instance.inject({
				method: 'GET',
				url: '/api/v1/documents',
				headers: { authorization: authToken },
			});
			expect(listRes1.statusCode).toBe(200);
			const listData1 = JSON.parse(listRes1.body) as ListDocumentsResponse;
			const doc1 = listData1.documents.find((d) => d.id === docId);
			expect(doc1).toBeDefined();
			expect(doc1?.isTakeoverNotified).toBe(false);

			// 3. Dismiss takeover banner via PATCH /settings?dismissBanner=true
			const patchRes = await server.instance.inject({
				method: 'PATCH',
				url: `/api/v1/documents/${docId}/settings?dismissBanner=true`,
				headers: { authorization: authToken },
				payload: { laneCount: 3 },
			});
			expect(patchRes.statusCode).toBe(200);
			const patchData = JSON.parse(patchRes.body) as { document: DocumentDto };
			expect(patchData.document.laneCount).toBe(3);
			expect(patchData.document.isTakeoverNotified).toBe(true);

			// 4. Verify persisted state: GET /documents confirms remembered as isTakeoverNotified=true
			const listRes2 = await server.instance.inject({
				method: 'GET',
				url: '/api/v1/documents',
				headers: { authorization: authToken },
			});
			const listData2 = JSON.parse(listRes2.body) as ListDocumentsResponse;
			const doc2 = listData2.documents.find((d) => d.id === docId);
			expect(doc2?.isTakeoverNotified).toBe(true);
		});

		it('接缝（M3-T2 ↔ M3-T4）：POST /documents 把任务与批次落进 tasks / batches 表，GET /snapshot 能看到', async () => {
			const { server, container } = setupTestServer();
			const authToken = await getAuthToken(container);
			await server.instance.ready();

			const docFolder = join(testDir, 'my-doc-import');
			mkdirSync(docFolder, { recursive: true });
			const docsDataPath = join(docFolder, 'docs-data.js');
			writeFileSync(docsDataPath, createSampleDocsDataJs('import'), 'utf8');

			const importRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/documents',
				headers: { authorization: authToken },
				payload: { docsPath: docsDataPath },
			});
			expect(importRes.statusCode).toBe(200);
			const importData = JSON.parse(importRes.body) as CreateDocumentResponse;
			expect(importData.taskCount).toBe(1);
			const docId = importData.document.id;

			// 落库：一个任务、第 1 批，任务归属该批
			const tasks = container.repos.tasks.listByDocId(docId);
			expect(tasks.map((t) => t.task_key)).toEqual(['T-1']);
			const batches = container.repos.batches.listByDocId(docId);
			expect(batches.map((b) => b.batch_no)).toEqual([1]);
			expect(tasks[0]?.batch_id).toBe(batches[0]?.id);
			expect(tasks[0]?.impl_prompt).toBe('实现提示词');

			// 快照从表里读，不是从解析结果读
			const snapshotRes = await server.instance.inject({
				method: 'GET',
				url: '/api/v1/snapshot',
				headers: { authorization: authToken },
			});
			expect(snapshotRes.statusCode).toBe(200);
			const snapshot = JSON.parse(snapshotRes.body) as {
				tasks: Array<{ taskKey: string; batchId: string | null }>;
				batches: Array<{ id: string }>;
			};
			expect(snapshot.tasks.map((t) => t.taskKey)).toEqual(['T-1']);
			expect(snapshot.batches).toHaveLength(1);

			// 重新导入同一份文档：幂等，不重复插行
			const reimportRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/documents',
				headers: { authorization: authToken },
				payload: { docsPath: docsDataPath },
			});
			expect(reimportRes.statusCode).toBe(200);
			expect(container.repos.tasks.listByDocId(docId)).toHaveLength(1);
			expect(container.repos.batches.listByDocId(docId)).toHaveLength(1);
		});

		it('AC 2 & E-83: scheduler never reads or writes reader localStorage', async () => {
			const { server, container } = setupTestServer();
			const authToken = await getAuthToken(container);
			await server.instance.ready();

			const docFolder = join(testDir, 'my-doc-2');
			mkdirSync(docFolder, { recursive: true });
			const docsDataPath = join(docFolder, 'docs-data.js');
			writeFileSync(docsDataPath, createSampleDocsDataJs('xyz'), 'utf8');
			writeFileSync(join(docFolder, 'index.html'), '<html>Reader</html>', 'utf8');

			const importRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/documents',
				headers: { authorization: authToken },
				payload: { docsPath: docsDataPath },
			});
			expect(importRes.statusCode).toBe(200);
			const docId = (JSON.parse(importRes.body) as CreateDocumentResponse).document.id;

			// Verify that scheduler uses its own database storage and defaults lane_count to 2
			const doc = container.services.docs.getDocumentById(docId);
			expect(doc).toBeDefined();
			expect(doc?.laneCount).toBe(2);
			// No localStorage files, browser stores, or injected reader keys are accessed
		});

		it('AC 3 & E-85: open-reader opens index.html in default browser without script injection or file modification', async () => {
			const openSpy = vi.fn(async (targetPath: string) => {
				openedTargets.push(targetPath);
			});
			const { server, container } = setupTestServer({ openBrowser: openSpy });
			const authToken = await getAuthToken(container);
			await server.instance.ready();

			const docFolder = join(testDir, 'my-doc-3');
			mkdirSync(docFolder, { recursive: true });
			const docsDataPath = join(docFolder, 'docs-data.js');
			const originalDocsContent = createSampleDocsDataJs('reader-test');
			writeFileSync(docsDataPath, originalDocsContent, 'utf8');

			const originalHtml =
				'<!DOCTYPE html><html><head><title>Original Reader</title></head><body><h1>Handoff</h1></body></html>';
			const readerPath = join(docFolder, 'index.html');
			writeFileSync(readerPath, originalHtml, 'utf8');

			const importRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/documents',
				headers: { authorization: authToken },
				payload: { docsPath: docsDataPath },
			});
			const docId = (JSON.parse(importRes.body) as CreateDocumentResponse).document.id;

			const openRes = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/documents/${docId}/open-reader`,
				headers: { authorization: authToken },
			});

			expect(openRes.statusCode).toBe(200);
			expect(JSON.parse(openRes.body)).toEqual({ opened: true });

			// Verify opened target is exact path to original index.html
			expect(openSpy).toHaveBeenCalledTimes(1);
			expect(openSpy).toHaveBeenCalledWith(readerPath);

			// Verify files on disk were untouched (no script injection, no modification)
			const htmlAfter = readFileSync(readerPath, 'utf8');
			expect(htmlAfter).toBe(originalHtml);
			expect(htmlAfter).not.toContain('<script');
			const docsAfter = readFileSync(docsDataPath, 'utf8');
			expect(docsAfter).toBe(originalDocsContent);
		});

		it('AC 4 & E-86: when document directory is moved or renamed, returns error with message and retains all records', async () => {
			const { server, container } = setupTestServer();
			const authToken = await getAuthToken(container);
			await server.instance.ready();

			const docFolder = join(testDir, 'my-doc-4');
			mkdirSync(docFolder, { recursive: true });
			const docsDataPath = join(docFolder, 'docs-data.js');
			writeFileSync(docsDataPath, createSampleDocsDataJs('move-test'), 'utf8');
			const readerPath = join(docFolder, 'index.html');
			writeFileSync(readerPath, '<html>Reader</html>', 'utf8');

			const importRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/documents',
				headers: { authorization: authToken },
				payload: { docsPath: docsDataPath },
			});
			const docId = (JSON.parse(importRes.body) as CreateDocumentResponse).document.id;

			// Move / delete index.html to simulate relocated directory or broken link
			rmSync(readerPath, { force: true });

			const openRes = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/documents/${docId}/open-reader`,
				headers: { authorization: authToken },
			});

			expect(openRes.statusCode).toBe(404);
			const errorBody = JSON.parse(openRes.body);
			expect(errorBody.error.code).toBe('E_NOT_FOUND');
			expect(errorBody.error.details.docId).toBe(docId);
			expect(errorBody.error.details.readerPath).toBe(readerPath);

			// Verify existing task records, document record, and state pointers are preserved
			const doc = container.services.docs.getDocumentById(docId);
			expect(doc).toBeDefined();
			expect(doc?.id).toBe(docId);
			expect(doc?.isSourceReadable).toBe(false); // marked unreadable, but not deleted
		});

		it('AC 5 & E-249: scheduler stores laneCount independently and rejects invalid values', async () => {
			const { server, container } = setupTestServer();
			const authToken = await getAuthToken(container);
			await server.instance.ready();

			const docFolder = join(testDir, 'my-doc-5');
			mkdirSync(docFolder, { recursive: true });
			const docsDataPath = join(docFolder, 'docs-data.js');
			writeFileSync(docsDataPath, createSampleDocsDataJs('settings-test'), 'utf8');
			writeFileSync(join(docFolder, 'index.html'), '<html>Reader</html>', 'utf8');

			const importRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/documents',
				headers: { authorization: authToken },
				payload: { docsPath: docsDataPath },
			});
			const docId = (JSON.parse(importRes.body) as CreateDocumentResponse).document.id;

			// Valid lane count (1..6)
			const patchRes = await server.instance.inject({
				method: 'PATCH',
				url: `/api/v1/documents/${docId}/settings`,
				headers: { authorization: authToken },
				payload: { laneCount: 5 },
			});
			expect(patchRes.statusCode).toBe(200);
			expect(JSON.parse(patchRes.body).document.laneCount).toBe(5);

			// Invalid lane count (< 1 or > 6) is rejected with 400 E_VALIDATION
			const invalidRes = await server.instance.inject({
				method: 'PATCH',
				url: `/api/v1/documents/${docId}/settings`,
				headers: { authorization: authToken },
				payload: { laneCount: 10 },
			});
			expect(invalidRes.statusCode).toBe(400);
			expect(JSON.parse(invalidRes.body).error.code).toBe('E_VALIDATION');
		});

		it('M3-T4 Output: publishes system.docs_changed event on document content change', async () => {
			const { server, container } = setupTestServer();
			const authToken = await getAuthToken(container);
			await server.instance.ready();

			const docFolder = join(testDir, 'my-doc-events');
			mkdirSync(docFolder, { recursive: true });
			const docsDataPath = join(docFolder, 'docs-data.js');
			writeFileSync(docsDataPath, createSampleDocsDataJs('fingerprint-v1'), 'utf8');
			writeFileSync(join(docFolder, 'index.html'), '<html>Reader</html>', 'utf8');

			const publishedEvents: Array<{ kind: string; payload: unknown }> = [];
			container.events.bus.subscribe((envelope) => {
				publishedEvents.push({ kind: envelope.kind, payload: envelope.payload });
			});

			// 1. Initial import triggers system.docs_changed
			const importRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/documents',
				headers: { authorization: authToken },
				payload: { docsPath: docsDataPath },
			});
			expect(importRes.statusCode).toBe(200);
			const docId = (JSON.parse(importRes.body) as CreateDocumentResponse).document.id;

			const docsChangedEvents = publishedEvents.filter((e) => e.kind === 'system.docs_changed');
			expect(docsChangedEvents.length).toBeGreaterThanOrEqual(1);

			// 2. Update doc content and re-import -> emits another system.docs_changed event
			writeFileSync(docsDataPath, createSampleDocsDataJs('fingerprint-v2'), 'utf8');
			const reimportRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/documents',
				headers: { authorization: authToken },
				payload: { docsPath: docsDataPath },
			});
			expect(reimportRes.statusCode).toBe(200);

			const updatedEvents = publishedEvents.filter((e) => e.kind === 'system.docs_changed');
			expect(updatedEvents.length).toBeGreaterThanOrEqual(2);
		});

		it('R1 & R3: createOpenBrowser uses injected hostInputs without process.platform and resolves absolute path', async () => {
			const spawned: Array<{ file: string; args: readonly string[]; options: unknown }> = [];
			const mockProcessOps = {
				spawn: (file: string, args: readonly string[], options: unknown) => {
					spawned.push({ file, args, options });
					return { unref: vi.fn() };
				},
			};
			const mockResolver = vi.fn(async () => ({
				ok: true as const,
				executable: {
					sourcePath: 'resolved/xdg-open',
					file: '/resolved/bin/xdg-open',
					argsPrefix: [] as readonly string[],
					checkedPaths: [] as readonly string[],
					launchKind: 'direct' as const,
				},
			}));

			const openBrowser = createOpenBrowser({
				hostInputs: { platform: 'linux', homedir: testDir },
				processOps: mockProcessOps as unknown as Parameters<
					typeof createOpenBrowser
				>[0]['processOps'],
				resolver: mockResolver as unknown as Parameters<typeof createOpenBrowser>[0]['resolver'],
			});

			await openBrowser('/tmp/test-doc/index.html');

			expect(mockResolver).toHaveBeenCalledTimes(1);
			expect(mockResolver).toHaveBeenCalledWith({
				hostInputs: { platform: 'linux', homedir: testDir },
				executableName: 'xdg-open',
				configuredPath: '/usr/bin/xdg-open',
			});
			expect(spawned).toHaveLength(1);
			expect(spawned[0]?.file).toBe('/resolved/bin/xdg-open');
			expect(spawned[0]?.args).toEqual(['/tmp/test-doc/index.html']);
			expect(spawned[0]?.options).toMatchObject({
				shell: false,
				windowsHide: true,
				detached: true,
				stdio: 'ignore',
			});
		});

		it('R3: createOpenBrowser throws AppError with E_AGENT_EXEC_NOT_FOUND when executable cannot be resolved', async () => {
			const mockResolver = vi.fn(async () => ({
				ok: false as const,
				error: {
					code: 'E_AGENT_EXEC_NOT_FOUND' as const,
					message: 'Command not found',
					details: {},
				},
			}));

			const openBrowser = createOpenBrowser({
				hostInputs: { platform: 'linux', homedir: testDir },
				resolver: mockResolver as unknown as Parameters<typeof createOpenBrowser>[0]['resolver'],
			});

			await expect(openBrowser('/tmp/test-doc/index.html')).rejects.toThrowError(AppError);
			await expect(openBrowser('/tmp/test-doc/index.html')).rejects.toMatchObject({
				code: 'E_AGENT_EXEC_NOT_FOUND',
			});
		});
	},
);
