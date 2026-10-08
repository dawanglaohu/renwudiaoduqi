import { execFileSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { createErrorHandler } from '../../src/http/plugins/90-error-handler.ts';
import { registerBatchesRoutes } from '../../src/http/routes/batches.ts';
import { createBatchWrapupsRepo } from '../../src/repo/batch-wrapups.ts';
import { createBatchesRepo } from '../../src/repo/batches.ts';
import { createDispatchSnapshotsRepo } from '../../src/repo/dispatch-snapshots.ts';
import { createDocumentsRepo } from '../../src/repo/documents.ts';
import { createGatesRepo } from '../../src/repo/gates.ts';
import { createRunsRepo } from '../../src/repo/runs.ts';
import { createTasksRepo } from '../../src/repo/tasks.ts';
import { createBatchService } from '../../src/service/batch.ts';
import { createDispatchService } from '../../src/service/dispatch.ts';
import { type DocsFileSystem, createDocsService } from '../../src/service/docs.ts';
import { type WrapupService, createWrapupService } from '../../src/service/wrapup.ts';
import { createWorktreeManager } from '../../src/workspace/worktree.ts';
import { writeTasksDocsData } from '../fixtures/task-docs-data.ts';

const directories: string[] = [];
const databases: DatabaseConnection[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(fs?: DocsFileSystem) {
	const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'document-workspace-'));
	directories.push(root);
	const repo = join(root, 'real repository');
	mkdirSync(repo);
	execFileSync('git', ['init', '-q', repo]);
	const db = openDatabase(join(root, 'app.db'));
	databases.push(db);
	const migrations = resolve('packages/daemon/migrations');
	createMigrationRunner({
		database: db,
		clock: { now: () => new Date().toISOString() },
		fileSystem: { readDirectory: readdirSync, readFile: (path) => readFileSync(path, 'utf8') },
	}).run(migrations);
	const documentsRepo = createDocumentsRepo(db);
	const batchesRepo = createBatchesRepo(db);
	const tasksRepo = createTasksRepo(db);
	const runsRepo = createRunsRepo(db);
	const dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
	const service = createDocsService({
		fs,
		hostInputs: {
			platform: process.platform as 'win32' | 'linux' | 'darwin',
			homedir: root,
			pathEnv: process.env.PATH,
		},
		documentsRepo,
		tasksRepo,
		runsRepo,
		dispatchSnapshotsRepo,
		db,
		unitOfWork: createUnitOfWork(db),
		clock: { now: () => new Date().toISOString() },
		ids: { newId: () => crypto.randomUUID() },
	});
	function writeDoc(directory: string) {
		mkdirSync(directory, { recursive: true });
		const path = join(directory, 'docs-data.js');
		writeFileSync(
			path,
			`window.DOCS = ${JSON.stringify({
				schemaVersion: 1,
				project: 'Workspace regression',
				pres: { handoff: { repo: 'agent-scheduler' } },
				data: { tasks: [{ id: 'T-1', title: 'Task', module: 'M1', deps: [], accept: 'Works' }] },
				handoff: {
					version: '1.1.0',
					schemaVersion: 1,
					contracts: { 'T-1': { hash: 'hash-t1', effectivePaths: ['src/'] } },
					readiness: { 'T-1': { ready: true, reasons: [], contractHash: 'hash-t1' } },
					effectivePaths: { 'T-1': ['src/'] },
				},
				dispatch: {
					'T-1': { contractHash: 'hash-t1', implementation: 'Implement', review: 'Review' },
				},
			})};`,
		);
		return path;
	}
	function seedRun(docId: string, state: 'running' | 'failed') {
		const task = tasksRepo.findByDocAndKey(docId, 'T-1');
		if (!task) throw new Error('Imported task missing');
		const snapshot = dispatchSnapshotsRepo.takeSnapshotForTask({
			taskId: task.id,
			launchSpecJson: JSON.stringify({ repoPath: repo, execPath: 'codex' }),
			createdAt: new Date().toISOString(),
		});
		runsRepo.insert({
			id: 'original-run',
			task_id: task.id,
			attempt_no: 1,
			kind: 'implement',
			state,
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: snapshot.id,
			queued_reason: state === 'failed' ? 'workspace_unavailable' : null,
		});
		return { task, snapshot, run: runsRepo.findById('original-run') };
	}
	function makeDispatch(
		validateWorkspace = service.validateWorkspace,
		wrapupService?: WrapupService,
	) {
		return createDispatchService({
			validateWorkspace,
			validateSourceAtCommit: service.validateSourceAtCommit,
			wrapupService,
			tasksRepo,
			batchesRepo,
			documentsRepo,
			dispatchSnapshotsRepo,
			runsRepo,
			unitOfWork: createUnitOfWork(db),
			clock: { now: () => new Date().toISOString() },
			ids: { newId: () => crypto.randomUUID() },
			listDispatchableAgents: () => [{ agentId: 'codex', canDispatch: true }],
		});
	}
	return {
		root,
		repo,
		db,
		service,
		documentsRepo,
		batchesRepo,
		tasksRepo,
		runsRepo,
		dispatchSnapshotsRepo,
		writeDoc,
		seedRun,
		makeDispatch,
	};
}

describe('document repository binding with real Git', () => {
	it.each(['deleted', 'malformed'] as const)(
		'persists the unreadable marker when a %s source rejects a manual commit',
		async (change) => {
			const f = setup();
			const source = f.writeDoc(join(f.repo, 'docs'));
			const imported = await f.service.importDocument(source);
			const history = f.seedRun(imported.document.id, 'failed');
			const dispatch = f.makeDispatch(async (docId, taskIds) => {
				await f.service.validateWorkspace(docId, taskIds);
				if (change === 'deleted') rmSync(source);
				else writeFileSync(source, 'window.DOCS = {');
			});
			await expect(
				dispatch.createRun({
					taskId: history.task.id,
					agentId: 'codex',
					idempotencyKey: 'late-source-change',
					laneNo: 1,
				}),
			).rejects.toMatchObject({ code: 'E_DOC_SOURCE_UNREADABLE' });
			expect(f.service.getDocumentById(imported.document.id)?.isSourceReadable).toBe(false);
			expect(f.tasksRepo.findById(history.task.id)).toEqual(history.task);
			expect(f.runsRepo.listAll()).toEqual([history.run]);
			expect(f.dispatchSnapshotsRepo.listByTaskId(history.task.id)).toEqual([history.snapshot]);
		},
	);
	it.each([
		['preflight', 'deleted'],
		['preflight', 'malformed'],
		['preflight', 'contract'],
		['commit', 'deleted'],
		['commit', 'malformed'],
		['commit', 'contract'],
		['commit', 'rebind'],
		['commit', 'healthy'],
	] as const)(
		'checks a %s %s source through the manual wrapup HTTP route',
		async (phase, change) => {
			const f = setup();
			const source = f.writeDoc(join(f.repo, 'docs'));
			const imported = await f.service.importDocument(source);
			const task = f.tasksRepo.findByDocAndKey(imported.document.id, 'T-1');
			if (!task?.batch_id) throw new Error('Imported task missing');
			f.tasksRepo.updateManualState(task.id, 'landed');
			f.batchesRepo.updateState({ id: task.batch_id, state: 'running' });
			execFileSync('git', ['-C', f.repo, 'add', 'docs/docs-data.js']);
			execFileSync('git', [
				'-C',
				f.repo,
				'-c',
				'user.name=Regression',
				'-c',
				'user.email=regression@example.com',
				'commit',
				'-qm',
				'Initial document',
			]);
			const manager = createWorktreeManager({
				platform: process.platform as 'win32' | 'linux' | 'darwin',
				hostInputs: {
					platform: process.platform as 'win32' | 'linux' | 'darwin',
					homedir: f.root,
					pathEnv: process.env.PATH,
				},
				ids: { newId: () => crypto.randomUUID() },
			});
			const mutateSource = async () => {
				if (change === 'deleted') rmSync(source);
				else if (change === 'malformed') writeFileSync(source, 'window.DOCS = {');
				else if (change === 'contract')
					writeFileSync(source, readFileSync(source, 'utf8').replaceAll('hash-t1', 'new-hash'));
				else if (change === 'rebind')
					await f.service.refreshDocument(imported.document.id, {
						docsPath: f.writeDoc(join(f.repo, 'replacement')),
					});
			};
			const shared = {
				...f,
				unitOfWork: createUnitOfWork(f.db),
				clock: { now: () => new Date().toISOString() },
				ids: { newId: () => crypto.randomUUID() },
			};
			const prepare = vi.fn(
				async (input: { repoPath: string; batchId: string | number; round: number }) =>
					manager.prepareWrapupWorktree({ ...input, worktreesDir: f.root }),
			);
			const wrapup = createWrapupService({
				...shared,
				batchService: createBatchService(shared),
				batchWrapupsRepo: createBatchWrapupsRepo(f.db),
				gatesRepo: createGatesRepo(f.db),
				docsService: f.service,
				validateWorkspace: f.service.validateWorkspace,
				validateSourceAtCommit: f.service.validateSourceAtCommit,
				workspace: {
					prepareWrapupWorktree: prepare,
					getDiffStat: async (path) => {
						const diff = execFileSync('git', ['-C', path, 'diff', '--stat'], { encoding: 'utf8' });
						if (phase === 'commit') await mutateSource();
						return diff;
					},
				},
			});
			const app = Fastify();
			createErrorHandler(app);
			registerBatchesRoutes(app, { wrapupService: wrapup });
			try {
				if (phase === 'preflight') await mutateSource();
				const request = {
					method: 'POST' as const,
					url: `/api/v1/batches/${task.batch_id}/wrapup`,
					payload: { agentId: 'codex', idempotencyKey: 'manual-wrapup' },
				};
				const response = await app.inject(request);
				if (change === 'healthy') {
					expect(response.statusCode, response.body).toBe(200);
					const run = response.json().run;
					expect(f.runsRepo.listAll()).toHaveLength(1);
					const runRow = f.runsRepo.findById(run.id);
					if (!runRow) throw new Error('Wrapup run missing');
					expect(f.dispatchSnapshotsRepo.findById(runRow.snapshot_id)).not.toBeNull();
					rmSync(source);
					const repeated = await app.inject(request);
					expect(repeated.json().error).toMatchObject({ code: 'E_RUN_ALREADY_EXISTS' });
					expect(f.runsRepo.listAll()).toHaveLength(1);
					return;
				}
				expect(response.json().error, response.body).toMatchObject({
					code:
						change === 'contract'
							? 'E_SNAPSHOT_STALE'
							: change === 'rebind'
								? 'E_WORKSPACE_UNAVAILABLE'
								: 'E_DOC_SOURCE_UNREADABLE',
				});
				expect(f.runsRepo.listAll()).toHaveLength(0);
				expect(f.db.prepare('SELECT COUNT(*) AS count FROM dispatch_snapshots').get()).toEqual({
					count: 0,
				});
				expect(f.batchesRepo.findById(task.batch_id)?.state).toBe('running');
				expect(f.tasksRepo.findById(task.id)?.lane_no).toBeNull();
				expect(f.service.getDocumentById(imported.document.id)?.isSourceReadable).toBe(
					change === 'contract' || change === 'rebind',
				);
				if (phase === 'preflight') expect(prepare).not.toHaveBeenCalled();
			} finally {
				await app.close();
			}
		},
	);
	it.each(['auto', 'manual'] as const)(
		'keeps one run when the %s dispatch preflight overlaps the other entry',
		async (firstEntry) => {
			const f = setup();
			const imported = await f.service.importDocument(f.writeDoc(join(f.repo, 'docs')));
			const task = f.tasksRepo.findByDocAndKey(imported.document.id, 'T-1');
			if (!task?.batch_id) throw new Error('Imported task missing');
			f.batchesRepo.updateState({ id: task.batch_id, state: 'running' });
			let reachedFirst = () => {};
			let releaseFirst = () => {};
			const reached = new Promise<void>((resolve) => {
				reachedFirst = resolve;
			});
			const release = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			let validationCalls = 0;
			const dispatch = f.makeDispatch(async (id, taskIds) => {
				await f.service.validateWorkspace(id, taskIds);
				if (++validationCalls === 1) {
					reachedFirst();
					await release;
				}
			});
			const manualInput = { taskId: task.id, agentId: 'codex', idempotencyKey: 'manual-race' };
			if (firstEntry === 'auto') {
				const ticking = dispatch.tick();
				await reached;
				const accepted = await dispatch.createRun(manualInput);
				releaseFirst();
				const result = await ticking;
				expect(result.runsDispatched).toEqual([]);
				expect(f.runsRepo.listByTaskId(task.id).map((run) => run.id)).toEqual([accepted.run.id]);
				expect(f.tasksRepo.findById(task.id)?.lane_no).toBeNull();
			} else {
				const creating = dispatch.createRun(manualInput);
				await reached;
				const result = await dispatch.tick();
				releaseFirst();
				const accepted = await creating;
				expect(accepted.isExisting).toBe(true);
				expect(result.runsDispatched).toEqual([accepted.run.id]);
			}
			expect(f.runsRepo.listByTaskId(task.id)).toHaveLength(1);
			expect(f.dispatchSnapshotsRepo.listByTaskId(task.id)).toHaveLength(1);
		},
	);
	it('checks task readiness after an automatic wrapup fails despite a successful document-only probe', async () => {
		const f = setup();
		const source = join(f.repo, 'docs-data.js');
		writeTasksDocsData(source, [
			{ id: 'T-1', hash: 'h1' },
			{ id: 'T-2', hash: 'h2', deps: ['T-1'] },
		]);
		const imported = await f.service.importDocument(source);
		const first = f.tasksRepo.findByDocAndKey(imported.document.id, 'T-1');
		const second = f.tasksRepo.findByDocAndKey(imported.document.id, 'T-2');
		if (!first?.batch_id || !second?.batch_id) throw new Error('Imported tasks missing');
		f.tasksRepo.updateManualState(first.id, 'landed');
		for (const task of [first, second])
			f.batchesRepo.updateState({ id: task.batch_id as string, state: 'running' });
		const payload = JSON.parse(
			readFileSync(source, 'utf8')
				.replace(/^window\.DOCS\s*=\s*/, '')
				.replace(/;$/, ''),
		);
		payload.handoff.readiness['T-2'] = {
			ready: false,
			reasons: ['H01: Review pending'],
			contractHash: 'h2',
		};
		writeFileSync(source, `window.DOCS = ${JSON.stringify(payload)};`);
		const shared = {
			...f,
			unitOfWork: createUnitOfWork(f.db),
			clock: { now: () => new Date().toISOString() },
			ids: { newId: () => crypto.randomUUID() },
		};
		const wrapup = createWrapupService({
			...shared,
			batchService: createBatchService(shared),
			batchWrapupsRepo: createBatchWrapupsRepo(f.db),
			gatesRepo: createGatesRepo(f.db),
			docsService: f.service,
		});
		const validate = vi.fn(f.service.validateWorkspace);
		const result = await f.makeDispatch(validate, wrapup).tick();
		expect(validate).toHaveBeenCalledWith(imported.document.id, undefined);
		expect(validate).toHaveBeenCalledWith(imported.document.id, [second.id]);
		expect(result.tasksBlocked).toContainEqual({ taskId: second.id, reason: 'contract_not_ready' });
		expect(f.runsRepo.listByTaskId(second.id)).toHaveLength(0);
		expect(f.dispatchSnapshotsRepo.listByTaskId(second.id)).toHaveLength(0);
	});
	it.each([
		'rebind',
		'unreadable',
		'contract',
		'source_deleted',
		'source_contract',
		'source_readiness',
	] as const)(
		'rechecks the %s document at commit after another document preflight waits',
		async (change) => {
			const f = setup();
			const oldSource = f.writeDoc(join(f.repo, 'first'));
			const first = await f.service.importDocument(oldSource);
			const second = await f.service.importDocument(f.writeDoc(join(f.repo, 'second')));
			const firstTask = f.tasksRepo.findByDocAndKey(first.document.id, 'T-1');
			const secondTask = f.tasksRepo.findByDocAndKey(second.document.id, 'T-1');
			if (!firstTask?.batch_id || !secondTask?.batch_id) throw new Error('Imported tasks missing');
			f.batchesRepo.updateState({ id: firstTask.batch_id, state: 'running' });
			f.batchesRepo.updateState({ id: secondTask.batch_id, state: 'running' });
			let reachedSecond = () => {};
			let releaseSecond = () => {};
			const reached = new Promise<void>((resolve) => {
				reachedSecond = resolve;
			});
			const release = new Promise<void>((resolve) => {
				releaseSecond = resolve;
			});
			const dispatch = f.makeDispatch(async (id) => {
				await f.service.validateWorkspace(id);
				if (id === second.document.id) {
					reachedSecond();
					await release;
				}
			});
			const ticking = dispatch.tick();
			await reached;
			expect(f.runsRepo.listActive()).toHaveLength(0);
			if (change === 'source_deleted') {
				rmSync(oldSource);
			} else if (change === 'source_readiness') {
				writeFileSync(
					oldSource,
					readFileSync(oldSource, 'utf8')
						.replaceAll('"ready":true', '"ready":false')
						.replaceAll('"reasons":[]', '"reasons":["H01 late source change"]'),
				);
			} else if (change === 'contract' || change === 'source_contract') {
				writeFileSync(
					oldSource,
					readFileSync(oldSource, 'utf8').replaceAll('hash-t1', 'changed-hash'),
				);
				if (change === 'contract') await f.service.refreshDocument(first.document.id);
			} else {
				const replacement = f.writeDoc(join(f.repo, 'replacement'));
				await f.service.refreshDocument(first.document.id, { docsPath: replacement });
				if (change === 'unreadable') {
					rmSync(replacement);
					await expect(f.service.refreshDocument(first.document.id)).rejects.toMatchObject({
						code: 'E_DOC_SOURCE_UNREADABLE',
					});
				}
			}
			releaseSecond();
			const result = await ticking;
			expect(f.runsRepo.listByTaskId(firstTask.id)).toHaveLength(0);
			expect(f.dispatchSnapshotsRepo.listByTaskId(firstTask.id)).toHaveLength(0);
			expect(f.tasksRepo.findById(firstTask.id)?.lane_no).toBeNull();
			expect(f.runsRepo.listByTaskId(secondTask.id)).toHaveLength(1);
			expect(result.runsDispatched).toHaveLength(1);
		},
	);
	it.each(['manual', 'rerun', 'auto'] as const)(
		'honors changed readiness metadata for %s dispatch while allowing ready siblings',
		async (mode) => {
			const f = setup();
			const source = join(f.repo, 'docs-data.js');
			writeTasksDocsData(source, [
				{ id: 'T-1', hash: 'hash-t1' },
				{ id: 'T-2', hash: 'hash-t2' },
			]);
			const imported = await f.service.importDocument(source);
			const task = f.tasksRepo.findByDocAndKey(imported.document.id, 'T-1');
			const sibling = f.tasksRepo.findByDocAndKey(imported.document.id, 'T-2');
			if (!task?.batch_id || !sibling) throw new Error('Imported tasks missing');
			if (mode === 'rerun') f.seedRun(imported.document.id, 'failed');
			const payload = JSON.parse(
				readFileSync(source, 'utf8')
					.replace(/^window\.DOCS\s*=\s*/, '')
					.replace(/;$/, ''),
			);
			payload.handoff.readiness['T-1'] = {
				ready: false,
				reasons: ['H01: Review pending'],
				contractHash: 'hash-t1',
			};
			writeFileSync(source, `window.DOCS = ${JSON.stringify(payload)};`);
			expect((await f.service.parseFile(source)).contentFingerprint).toBe(
				imported.document.contentFingerprint,
			);
			const dispatch = f.makeDispatch();
			if (mode === 'auto') {
				f.batchesRepo.updateState({ id: task.batch_id, state: 'running' });
				const result = await dispatch.tick();
				expect(result.tasksBlocked).toContainEqual({
					taskId: task.id,
					reason: 'contract_not_ready',
				});
				expect(f.runsRepo.listByTaskId(sibling.id)).toHaveLength(1);
			} else {
				const pending =
					mode === 'rerun'
						? dispatch.rerunRun({ runId: 'original-run', idempotencyKey: 'readiness-rerun' })
						: dispatch.createRun({
								taskId: task.id,
								agentId: 'codex',
								permissionTier: 'workspaceWrite',
								idempotencyKey: 'readiness-manual',
							});
				await expect(pending).rejects.toMatchObject({
					code: 'E_DOC_CONTRACT_PENDING',
					details: { pendingTasks: [{ taskId: task.id, reasons: ['H01: Review pending'] }] },
				});
				await dispatch.createRun({
					taskId: sibling.id,
					agentId: 'codex',
					permissionTier: 'workspaceWrite',
					idempotencyKey: 'ready-sibling',
				});
			}
			expect(f.runsRepo.listByTaskId(task.id)).toHaveLength(mode === 'rerun' ? 1 : 0);
			expect(f.service.getDocumentById(imported.document.id)?.isSourceReadable).toBe(true);
		},
	);
	it.each(['malformed', 'version', 'contract'] as const)(
		'blocks new dispatch after a %s source change without replacing cached tasks or snapshots',
		async (change) => {
			const f = setup();
			const source = f.writeDoc(join(f.repo, 'docs'));
			const imported = await f.service.importDocument(source);
			const history = f.seedRun(imported.document.id, 'failed');
			const originalDoc = f.documentsRepo.findById(imported.document.id);
			const content = readFileSync(source, 'utf8');
			writeFileSync(
				source,
				change === 'malformed'
					? 'window.DOCS = {'
					: change === 'version'
						? content.replace('"schemaVersion":1', '"schemaVersion":2')
						: content.replaceAll('hash-t1', 'hash-t1-changed'),
			);
			const error = change === 'contract' ? 'E_SNAPSHOT_STALE' : 'E_DOC_SOURCE_UNREADABLE';
			const dispatch = f.makeDispatch();
			await expect(
				dispatch.createRun({
					taskId: history.task.id,
					agentId: 'codex',
					permissionTier: 'workspaceWrite',
					idempotencyKey: 'new-run',
				}),
			).rejects.toMatchObject({ code: error });
			await expect(
				dispatch.startBatch({ batchId: history.task.batch_id as string }),
			).rejects.toMatchObject({ code: error });
			const tick = await dispatch.tick();
			expect(tick.runsDispatched).toHaveLength(0);
			expect(f.documentsRepo.findById(imported.document.id)?.content_fingerprint).toBe(
				originalDoc?.content_fingerprint,
			);
			expect(f.service.getDocumentById(imported.document.id)?.isSourceReadable).toBe(
				change === 'contract',
			);
			expect(f.tasksRepo.findById(history.task.id)).toEqual(history.task);
			expect(f.runsRepo.listAll()).toEqual([history.run]);
			expect(f.dispatchSnapshotsRepo.findById(history.snapshot.id)).toEqual(history.snapshot);
		},
	);

	it.each(['idle', 'done'] as const)(
		'does not probe an inactive %s document on every tick',
		async (state) => {
			const f = setup();
			const imported = await f.service.importDocument(f.writeDoc(join(f.repo, 'docs')));
			const task = f.tasksRepo.findByDocAndKey(imported.document.id, 'T-1');
			f.batchesRepo.updateState({ id: task?.batch_id as string, state });
			const validate = vi.fn(f.service.validateWorkspace);
			await f.makeDispatch(validate).tick();
			expect(validate).not.toHaveBeenCalled();
		},
	);

	it.each([true, false])(
		'advances already landed work when source readability is %s',
		async (readable) => {
			const f = setup();
			const source = f.writeDoc(join(f.repo, 'docs'));
			const imported = await f.service.importDocument(source);
			const history = f.seedRun(imported.document.id, 'failed');
			f.runsRepo.updateState({ id: 'original-run', state: 'landed' });
			f.batchesRepo.updateState({ id: history.task.batch_id as string, state: 'running' });
			rmSync(source);
			if (!readable) f.service.markSourceUnreadable(imported.document.id);
			const validate = vi.fn(f.service.validateWorkspace);
			await f.makeDispatch(validate).tick();
			expect(f.batchesRepo.findById(history.task.batch_id as string)?.state).toBe(
				'awaiting_landing',
			);
			expect(validate).not.toHaveBeenCalled();
		},
	);

	it('launches an already snapshot-backed queued run after its source disappears', async () => {
		const f = setup();
		const source = f.writeDoc(join(f.repo, 'docs'));
		const imported = await f.service.importDocument(source);
		const history = f.seedRun(imported.document.id, 'failed');
		f.runsRepo.updateState({ id: 'original-run', state: 'queued', queuedReason: 'lane_full' });
		f.batchesRepo.updateState({ id: history.task.batch_id as string, state: 'running' });
		rmSync(source);
		f.service.markSourceUnreadable(imported.document.id);
		const validate = vi.fn(f.service.validateWorkspace);
		const result = await f.makeDispatch(validate).tick();
		expect(result.runsDispatched).toEqual(['original-run']);
		expect(f.runsRepo.findById('original-run')?.state).toBe('starting');
		expect(f.dispatchSnapshotsRepo.findById(history.snapshot.id)).toEqual(history.snapshot);
		expect(validate).not.toHaveBeenCalled();
	});

	it.each(['preflight', 'refresh'] as const)(
		'does not mark a recovered binding unreadable after an old %s read fails',
		async (action) => {
			const blockedRead: { path?: string } = {};
			let rejectRead: (error: Error) => void = () => {};
			const f = setup({
				readFile: async (path) => {
					if (path === blockedRead.path)
						return new Promise<string>((_resolve, reject) => {
							rejectRead = reject;
						});
					return readFileSync(path, 'utf8');
				},
			});
			const oldPath = f.writeDoc(join(f.repo, 'old docs'));
			const imported = await f.service.importDocument(oldPath);
			blockedRead.path = oldPath;
			const pending =
				action === 'preflight'
					? f.service.validateWorkspace(imported.document.id)
					: f.service.refreshDocument(imported.document.id);
			const rejection = expect(pending).rejects.toMatchObject({ code: 'E_DOC_SOURCE_UNREADABLE' });
			const newPath = f.writeDoc(join(f.repo, 'new docs'));
			await f.service.refreshDocument(imported.document.id, { docsPath: newPath });
			rejectRead(new Error('Old source removed'));
			await rejection;
			expect(f.service.getDocumentById(imported.document.id)).toMatchObject({
				docsPath: newPath,
				isSourceReadable: true,
			});
			await expect(f.service.validateWorkspace(imported.document.id)).resolves.toBeUndefined();
		},
	);

	it('returns the accepted rerun on an idempotent retry after its source disappears', async () => {
		const f = setup();
		const source = f.writeDoc(join(f.repo, 'docs'));
		const imported = await f.service.importDocument(source);
		const history = f.seedRun(imported.document.id, 'failed');
		const dispatch = f.makeDispatch();
		const input = { runId: 'original-run', idempotencyKey: 'rerun-retry' };
		const accepted = await dispatch.rerunRun(input);
		const acceptedSnapshots = f.dispatchSnapshotsRepo.listByTaskId(history.task.id);
		rmSync(source);
		await expect(dispatch.rerunRun(input)).resolves.toEqual(accepted);
		expect(f.runsRepo.listByTaskId(history.task.id)).toHaveLength(2);
		expect(f.dispatchSnapshotsRepo.listByTaskId(history.task.id)).toEqual(acceptedSnapshots);
	});
	it('binds a portable repository name to the Git root containing docs-data.js', async () => {
		const { repo, service, writeDoc } = setup();
		const imported = await service.importDocument(writeDoc(join(repo, 'docs', '开发文档')));
		expect(imported.document.repoPath).toBe(repo);
	});

	it('prepares a real native Git worktree from the imported repository binding', async () => {
		const { root, repo, service, writeDoc } = setup();
		execFileSync(
			'git',
			[
				'-C',
				repo,
				'-c',
				'user.name=Test',
				'-c',
				'user.email=test@example.invalid',
				'commit',
				'--allow-empty',
				'-m',
				'base',
			],
			{ stdio: 'pipe' },
		);
		const imported = await service.importDocument(writeDoc(join(repo, 'docs', '开发文档')));
		const manager = createWorktreeManager({
			platform: process.platform as 'win32' | 'linux' | 'darwin',
			hostInputs: {
				platform: process.platform as 'win32' | 'linux' | 'darwin',
				homedir: root,
				pathEnv: process.env.PATH,
			},
			ids: { newId: () => crypto.randomUUID() },
		});
		const workspace = await manager.prepareWorktree({
			repoPath: imported.document.repoPath as string,
			taskId: 'T-1',
			baseRef: 'HEAD',
			worktreesDir: root,
		});
		expect(workspace.branchName).toBe('task/T-1');
		expect(await manager.checkGitRepository(workspace.worktreePath)).toMatchObject({
			isGitRepo: true,
		});
		await manager.removeWorktree({
			repoPath: repo,
			worktreePath: workspace.worktreePath,
			deleteBranch: true,
			branchName: workspace.branchName,
		});
	});

	it('accepts an explicit repository for documents stored outside Git and retains it on refresh', async () => {
		const { root, repo, service, writeDoc } = setup();
		const imported = await service.importDocument(writeDoc(join(root, 'external')), {
			repoPath: repo,
		});
		expect(imported.document.repoPath).toBe(repo);
		await service.refreshDocument(imported.document.id);
		expect(service.getDocumentById(imported.document.id)?.repoPath).toBe(repo);
	});

	it('rejects a missing explicit repository without persisting a document', async () => {
		const { root, service, documentsRepo, writeDoc } = setup();
		await expect(
			service.importDocument(writeDoc(join(root, 'external')), {
				repoPath: join(root, 'missing'),
			}),
		).rejects.toMatchObject({ code: 'E_NOT_A_GIT_REPO' });
		expect(documentsRepo.listAll()).toHaveLength(0);
	});

	it('relocates an existing source without replacing task identities or document settings', async () => {
		const { repo, service, tasksRepo, runsRepo, dispatchSnapshotsRepo, writeDoc, seedRun } =
			setup();
		const oldPath = writeDoc(join(repo, 'old docs'));
		const imported = await service.importDocument(oldPath);
		service.updateLaneCount(imported.document.id, 4);
		const originalTask = tasksRepo.findByDocAndKey(imported.document.id, 'T-1');
		const history = seedRun(imported.document.id, 'failed');
		const newPath = writeDoc(join(repo, 'new docs'));
		rmSync(oldPath);
		await service.refreshDocument(imported.document.id, { docsPath: newPath });
		expect(service.getDocumentById(imported.document.id)).toMatchObject({
			docsPath: newPath,
			repoPath: repo,
			laneCount: 4,
			isSourceReadable: true,
		});
		expect(tasksRepo.findByDocAndKey(imported.document.id, 'T-1')?.id).toBe(originalTask?.id);
		expect(runsRepo.findById('original-run')).toEqual(history.run);
		expect(dispatchSnapshotsRepo.findById(history.snapshot.id)).toEqual(history.snapshot);
	});

	it('rejects rebinding while a task is active and keeps the frozen run unchanged', async () => {
		const { repo, service, runsRepo, writeDoc, seedRun } = setup();
		const oldPath = writeDoc(join(repo, 'old docs'));
		const imported = await service.importDocument(oldPath);
		const history = seedRun(imported.document.id, 'running');
		await expect(
			service.refreshDocument(imported.document.id, {
				docsPath: writeDoc(join(repo, 'new docs')),
			}),
		).rejects.toMatchObject({ code: 'E_WORKSPACE_UNAVAILABLE' });
		expect(service.getDocumentById(imported.document.id)?.docsPath).toBe(oldPath);
		expect(runsRepo.findById('original-run')).toEqual(history.run);
	});

	it('keeps a readable binding when a replacement source cannot be read', async () => {
		const { repo, service, writeDoc } = setup();
		const oldPath = writeDoc(join(repo, 'old docs'));
		const imported = await service.importDocument(oldPath);
		await expect(
			service.refreshDocument(imported.document.id, {
				docsPath: join(repo, 'missing', 'docs-data.js'),
			}),
		).rejects.toMatchObject({ code: 'E_DOC_SOURCE_UNREADABLE' });
		expect(service.getDocumentById(imported.document.id)).toMatchObject({
			docsPath: oldPath,
			isSourceReadable: true,
		});
	});

	it('blocks a deleted source at preflight and reports its path', async () => {
		const { repo, service, tasksRepo, writeDoc } = setup();
		const oldPath = writeDoc(join(repo, 'docs'));
		const imported = await service.importDocument(oldPath);
		rmSync(oldPath);
		await expect(service.validateWorkspace(imported.document.id)).rejects.toMatchObject({
			code: 'E_DOC_SOURCE_UNREADABLE',
			details: { docsPath: oldPath },
		});
		expect(service.getDocumentById(imported.document.id)?.isSourceReadable).toBe(false);
		expect(tasksRepo.listByDocId(imported.document.id)).toHaveLength(1);
	});

	it('blocks a source replaced by a directory without changing run history', async () => {
		const { repo, service, runsRepo, dispatchSnapshotsRepo, writeDoc, seedRun } = setup();
		const docsPath = writeDoc(join(repo, 'docs'));
		const imported = await service.importDocument(docsPath);
		const history = seedRun(imported.document.id, 'failed');
		rmSync(docsPath);
		mkdirSync(docsPath);
		await expect(service.validateWorkspace(imported.document.id)).rejects.toMatchObject({
			code: 'E_DOC_SOURCE_UNREADABLE',
			details: { docsPath },
		});
		expect(service.getDocumentById(imported.document.id)?.isSourceReadable).toBe(false);
		expect(runsRepo.findById('original-run')).toEqual(history.run);
		expect(dispatchSnapshotsRepo.findById(history.snapshot.id)).toEqual(history.snapshot);
	});

	it.each(['healthy', 'source', 'repository', 'malformed', 'version', 'contract'] as const)(
		'checks the %s workspace before automatic dispatch in a running batch',
		async (missing) => {
			const fixture = setup();
			const { root, repo, service, tasksRepo, batchesRepo, runsRepo, dispatchSnapshotsRepo } =
				fixture;
			const docsPath = fixture.writeDoc(join(root, 'external'));
			const imported = await service.importDocument(docsPath, { repoPath: repo });
			const task = tasksRepo.findByDocAndKey(imported.document.id, 'T-1');
			if (!task?.batch_id) throw new Error('Imported task must belong to a batch');
			batchesRepo.updateState({ id: task.batch_id, state: 'running' });
			const errors: unknown[] = [];
			const dispatch = createDispatchService({
				validateWorkspace: service.validateWorkspace,
				tasksRepo,
				batchesRepo,
				documentsRepo: fixture.documentsRepo,
				dispatchSnapshotsRepo,
				runsRepo,
				unitOfWork: createUnitOfWork(fixture.db),
				clock: { now: () => new Date().toISOString() },
				ids: { newId: () => crypto.randomUUID() },
				listDispatchableAgents: () => [{ agentId: 'codex', canDispatch: true }],
				logFailure: (error) => errors.push(error),
			});
			if (missing === 'source') rmSync(docsPath);
			else if (missing === 'repository') rmSync(repo, { recursive: true });
			else if (missing === 'malformed') writeFileSync(docsPath, 'window.DOCS = {');
			else if (missing === 'version')
				writeFileSync(
					docsPath,
					readFileSync(docsPath, 'utf8').replace('"schemaVersion":1', '"schemaVersion":2'),
				);
			else if (missing === 'contract')
				writeFileSync(
					docsPath,
					readFileSync(docsPath, 'utf8').replaceAll('hash-t1', 'changed-hash'),
				);
			const result = await dispatch.tick();
			if (missing === 'healthy') {
				expect(result.runsDispatched).toHaveLength(1);
				expect(runsRepo.listByTaskId(task.id)).toHaveLength(1);
				expect(dispatchSnapshotsRepo.listByTaskId(task.id)).toHaveLength(1);
				expect(tasksRepo.findById(task.id)?.lane_no).toBe(1);
				expect(errors).toHaveLength(0);
				return;
			}
			expect(result.runsDispatched).toHaveLength(0);
			expect(runsRepo.listAll()).toHaveLength(0);
			expect(dispatchSnapshotsRepo.listByTaskId(task.id)).toHaveLength(0);
			expect(tasksRepo.findById(task.id)).toEqual(task);
			expect(errors).toEqual([
				expect.objectContaining({
					code:
						missing === 'contract'
							? 'E_SNAPSHOT_STALE'
							: missing === 'repository'
								? 'E_NOT_A_GIT_REPO'
								: 'E_DOC_SOURCE_UNREADABLE',
				}),
			]);
		},
	);

	it('repairs a legacy slug binding on a normal refresh', async () => {
		const { repo, service, documentsRepo, writeDoc } = setup();
		const imported = await service.importDocument(writeDoc(join(repo, 'docs')));
		const row = documentsRepo.findById(imported.document.id);
		if (!row) throw new Error('Imported document missing');
		documentsRepo.updateMetadata({ ...row, repo_path: 'agent-scheduler' });
		await expect(service.validateWorkspace(row.id)).rejects.toMatchObject({
			code: 'E_WORKSPACE_UNAVAILABLE',
			details: { repoPath: 'agent-scheduler' },
		});
		expect((await service.refreshDocument(row.id)).changed).toBe(true);
		await expect(service.validateWorkspace(row.id)).resolves.toBeUndefined();
		expect(service.getDocumentById(row.id)?.repoPath).toBe(repo);
	});

	it.each(
		process.platform === 'win32'
			? ['agent-scheduler', '\\drive-relative', '/foreign/posix-repo', 'D:drive-relative']
			: ['agent-scheduler', 'C:\\foreign\\repo', '~/relative'],
	)('rejects non-host-absolute repository path %s', async (repoPath) => {
		const { repo, service, writeDoc } = setup();
		await expect(
			service.importDocument(writeDoc(join(repo, 'docs')), {
				repoPath,
			}),
		).rejects.toMatchObject({ code: 'E_VALIDATION' });
	});

	it('rejects relocating onto another document instead of corrupting either binding', async () => {
		const { repo, service, writeDoc } = setup();
		const firstPath = writeDoc(join(repo, 'first'));
		const first = await service.importDocument(firstPath);
		const secondPath = writeDoc(join(repo, 'second'));
		await service.importDocument(secondPath);
		await expect(
			service.refreshDocument(first.document.id, { docsPath: secondPath }),
		).rejects.toMatchObject({ code: 'E_VALIDATION' });
		expect(service.getDocumentById(first.document.id)?.docsPath).toBe(firstPath);
	});
});
