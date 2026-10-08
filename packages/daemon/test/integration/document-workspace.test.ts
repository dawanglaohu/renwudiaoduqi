import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { createDispatchSnapshotsRepo } from '../../src/repo/dispatch-snapshots.ts';
import { createDocumentsRepo } from '../../src/repo/documents.ts';
import { createRunsRepo } from '../../src/repo/runs.ts';
import { createTasksRepo } from '../../src/repo/tasks.ts';
import { createDocsService } from '../../src/service/docs.ts';
import { createWorktreeManager } from '../../src/workspace/worktree.ts';

const directories: string[] = [];
const databases: DatabaseConnection[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), 'document-workspace-'));
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
	const tasksRepo = createTasksRepo(db);
	const runsRepo = createRunsRepo(db);
	const dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
	const service = createDocsService({
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
	return {
		root,
		repo,
		db,
		service,
		documentsRepo,
		tasksRepo,
		runsRepo,
		dispatchSnapshotsRepo,
		writeDoc,
		seedRun,
	};
}

describe('document repository binding with real Git', () => {
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
