import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import {
	BUILTIN_BUGHUNT_PROMPT,
	PROMPT_SOURCE_BUILTIN,
	PROMPT_SOURCE_DOCS,
} from '../../src/domain/bughunt-builtin-prompt.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createBatchesRepo } from '../../src/repo/batches.ts';
import {
	type DispatchSnapshotInsertRow,
	type DispatchSnapshotsRepo,
	createDispatchSnapshotsRepo,
} from '../../src/repo/dispatch-snapshots.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../../src/repo/documents.ts';
import { type TasksRepo, createTasksRepo } from '../../src/repo/tasks.ts';
import {
	createBughuntContextService,
	getBughuntContext,
} from '../../src/service/bughunt-context.ts';

const openDatabases: DatabaseConnection[] = [];
const temporaryDirectories: string[] = [];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsDirectory = resolve(__dirname, '../../migrations');

afterEach(() => {
	for (const db of openDatabases.splice(0)) {
		if (db.open) db.close();
	}
	for (const dir of temporaryDirectories.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

function createTestDatabase(): DatabaseConnection {
	const dir = mkdtempSync(join(tmpdir(), 'agent-scheduler-bughunt-test-'));
	temporaryDirectories.push(dir);
	const db = openDatabase(join(dir, 'test.db'));
	openDatabases.push(db);

	const runner = createMigrationRunner({
		clock: { now: () => '2026-09-14T00:00:00.000Z' },
		database: db,
		fileSystem: {
			readDirectory: (path) => readdirSync(path),
			readFile: (path) => readFileSync(path, 'utf8'),
		},
	});
	runner.run(migrationsDirectory);
	return db;
}

function insertMockDocument(
	db: DatabaseConnection,
	docId = 'doc-1',
	docsPath = '/data/doc-1/docs-data.js',
): void {
	const docsRepo = createDocumentsRepo(db);
	docsRepo.insert({
		id: docId,
		docs_path: docsPath,
		project_name: 'Test Project',
		repo_path: `/repos/${docId}`,
		main_branch: 'main',
		branch_prefix: 'task/',
		lane_count: 2,
		content_fingerprint: 'fp-initial',
		is_source_readable: 1,
		is_takeover_notified: 0,
		imported_at: '2026-09-14T00:00:00.000Z',
		last_seen_at: '2026-09-14T00:00:00.000Z',
	});
}

function insertMockBatch(
	db: DatabaseConnection,
	docId = 'doc-1',
	batchNo = 1,
	batchId = 'batch-1',
	state: 'idle' | 'running' | 'paused' | 'done' = 'running',
): void {
	const batchesRepo = createBatchesRepo(db);
	batchesRepo.insert({
		id: batchId,
		doc_id: docId,
		batch_no: batchNo,
		state,
		started_at: '2026-09-14T00:00:00.000Z',
	});
}

describe('M3-T7 bughunt-context service and getBughuntContext', () => {
	let db: DatabaseConnection;
	let tasksRepo: TasksRepo;
	let snapshotsRepo: DispatchSnapshotsRepo;
	let docsRepo: DocumentsRepo;

	beforeEach(() => {
		db = createTestDatabase();
		tasksRepo = createTasksRepo(db);
		snapshotsRepo = createDispatchSnapshotsRepo(db);
		docsRepo = createDocumentsRepo(db);

		insertMockDocument(db, 'doc-1');
		insertMockBatch(db, 'doc-1', 1, 'batch-1', 'running');
	});

	function setupTask(overrides: Partial<Parameters<TasksRepo['insert']>[0]> = {}) {
		const task = {
			id: overrides.id ?? 'task-1',
			doc_id: 'doc-1',
			task_key: overrides.task_key ?? 'M3-T7',
			title: 'Bughunt Context Interface',
			module_key: 'M3',
			deps_json: '[]',
			input_text: 'input specs',
			output_text: 'output specs',
			accept_text: 'acceptance criteria',
			edge_ids_json: JSON.stringify(['E-19', 'E-316', 'E-50']),
			task_paths_json: JSON.stringify(['packages/daemon/src/service/bughunt-context.ts']),
			contract_hash: overrides.contract_hash ?? 'contract-hash-v1',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 0.5,
			batch_id: 'batch-1',
			impl_prompt: 'Implementation prompt text',
			review_prompt: 'Review prompt text',
			bug_prompt: overrides.bug_prompt ?? 'Document bug prompt text from doc v1',
			is_removed_from_doc: 0,
			has_accept_changed: 0,
			has_prompt_changed: 0,
			manual_state: null,
			...overrides,
		};
		tasksRepo.insert(task);
		return task;
	}

	function setupSnapshot(overrides: Partial<DispatchSnapshotInsertRow> = {}) {
		const snapshot: DispatchSnapshotInsertRow = {
			id: overrides.id ?? 'snap-1',
			task_id: overrides.task_id ?? 'task-1',
			input_text: overrides.input_text ?? 'input specs',
			output_text: overrides.output_text ?? 'output specs',
			accept_text: overrides.accept_text ?? 'acceptance criteria',
			impl_prompt: overrides.impl_prompt ?? 'Implementation prompt text',
			review_prompt: overrides.review_prompt ?? 'Review prompt text',
			bug_prompt:
				overrides.bug_prompt !== undefined ? overrides.bug_prompt : 'Snapshot bug prompt text',
			contract_hash: overrides.contract_hash ?? 'contract-hash-v1',
			task_paths_json: JSON.stringify(['packages/daemon/src/service/bughunt-context.ts']),
			launch_spec_json: JSON.stringify({ agentId: 'codex', modelName: 'gpt-5' }),
			created_at: overrides.created_at ?? '2026-09-14T01:00:00.000Z',
		};
		snapshotsRepo.insert(snapshot);
		return snapshot;
	}

	it('AC 2: returns bugPrompt from dispatch snapshot and promptSource=docs when snapshot has bug prompt', () => {
		setupTask();
		setupSnapshot({
			id: 'snap-101',
			task_id: 'task-1',
			bug_prompt: '# 查找 bug：M3-T7 逐字快照内容\n\n测试命令：npm test',
			contract_hash: 'contract-hash-v1',
		});

		const context = getBughuntContext('task-1', {
			db,
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			documentsRepo: docsRepo,
		});

		expect(context.taskId).toBe('task-1');
		expect(context.taskKey).toBe('M3-T7');
		expect(context.snapshotId).toBe('snap-101');
		expect(context.bugPrompt).toBe('# 查找 bug：M3-T7 逐字快照内容\n\n测试命令：npm test');
		expect(context.promptSource).toBe(PROMPT_SOURCE_DOCS);
		expect(context.contractHash).toBe('contract-hash-v1');
		expect(context.isSnapshot).toBe(true);
		expect(context.isReadOnly).toBe(true);
		expect(context.docChangedSinceDispatch).toBe(false);
	});

	it('AC 2 & E-316: when snapshot bug_prompt is NULL, returns BUILTIN_BUGHUNT_PROMPT and promptSource=builtin without throwing or falling back to current doc', () => {
		// 当前文档中 tasks.bug_prompt 有值
		setupTask({
			id: 'task-1',
			bug_prompt: '当前文档中的提示词（绝不能回落到这里）',
		});
		// 但派发快照中 bug_prompt 为 NULL（派发时文档未提供）
		setupSnapshot({
			id: 'snap-null-bug',
			task_id: 'task-1',
			bug_prompt: null,
		});

		const context = getBughuntContext('task-1', {
			db,
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			documentsRepo: docsRepo,
		});

		// 绝不抛错
		expect(context).toBeDefined();
		// 绝不回落到当前文档的 tasks.bug_prompt
		expect(context.bugPrompt).not.toBe('当前文档中的提示词（绝不能回落到这里）');
		// 严格返回内置通用查 bug 提示词
		expect(context.bugPrompt).toBe(BUILTIN_BUGHUNT_PROMPT);
		expect(context.promptSource).toBe(PROMPT_SOURCE_BUILTIN);
		expect(context.isSnapshot).toBe(true);
		expect(context.isReadOnly).toBe(true);
	});

	it('AC 2 & E-316: when snapshot bug_prompt is empty or whitespace only, returns builtin prompt and promptSource=builtin', () => {
		setupTask({ id: 'task-empty-prompt' });
		setupSnapshot({
			id: 'snap-empty-prompt',
			task_id: 'task-empty-prompt',
			bug_prompt: '   \n\t  ',
		});

		const context = getBughuntContext('task-empty-prompt', {
			db,
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			documentsRepo: docsRepo,
		});

		expect(context.bugPrompt).toBe(BUILTIN_BUGHUNT_PROMPT);
		expect(context.promptSource).toBe(PROMPT_SOURCE_BUILTIN);
	});

	it('AC 2 & E-316: when no snapshot exists for an existing task, returns builtin prompt and promptSource=builtin without stalling', () => {
		setupTask({ id: 'task-never-dispatched', bug_prompt: '一些文档提示词' });
		// 没有调用 setupSnapshot()

		const context = getBughuntContext('task-never-dispatched', {
			db,
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			documentsRepo: docsRepo,
		});

		expect(context).toBeDefined();
		expect(context.bugPrompt).toBe(BUILTIN_BUGHUNT_PROMPT);
		expect(context.promptSource).toBe(PROMPT_SOURCE_BUILTIN);
		expect(context.taskId).toBe('task-never-dispatched');
	});

	it('AC 3: returned materials are strictly verbatim, not rewritten, not truncated', () => {
		const multilinePrompt = [
			'# 查找 bug：复杂格式提示词',
			'',
			'含有特殊字符：`~!@#$%^&*()_+-=[]{}\\|;:\'",.<>/?',
			'含有 Emoji 与 Unicode：🐛 🐞 检查漏洞 \u2028 行分隔符',
			'含有大量缩进与空白：',
			'    def foo():',
			'        return True',
			'',
			'结尾有连续空行：',
			'',
			'',
		].join('\n');

		setupTask({ id: 'task-verbatim' });
		setupSnapshot({
			id: 'snap-verbatim',
			task_id: 'task-verbatim',
			bug_prompt: multilinePrompt,
		});

		const context = getBughuntContext('task-verbatim', {
			db,
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			documentsRepo: docsRepo,
		});

		expect(context.bugPrompt).toBe(multilinePrompt);
		expect(context.bugPrompt.length).toBe(multilinePrompt.length);
	});

	it('AC 3 & E-50: when document fingerprint/contractHash changes during execution, returns original snapshot copy without hot-reloading', () => {
		const originalPrompt = 'Snapshot frozen bug prompt at dispatch time v1';
		setupTask({
			id: 'task-inflight',
			contract_hash: 'contract-v1',
			bug_prompt: originalPrompt,
		});
		setupSnapshot({
			id: 'snap-inflight',
			task_id: 'task-inflight',
			contract_hash: 'contract-v1',
			bug_prompt: originalPrompt,
		});

		// 模拟批次执行途中文档重新导入：任务契约哈希变了、tasks.bug_prompt 被热更新为 v2
		tasksRepo.updateDocFields({
			id: 'task-inflight',
			title: 'Bughunt Context Interface Updated',
			module_key: 'M3',
			deps_json: '[]',
			input_text: 'updated input',
			output_text: 'updated output',
			accept_text: 'updated acceptance criteria',
			edge_ids_json: '[]',
			task_paths_json: '[]',
			contract_hash: 'contract-v2-changed',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 0.5,
			batch_id: 'batch-1',
			impl_prompt: 'Updated impl prompt',
			review_prompt: 'Updated review prompt',
			bug_prompt: 'HOT RELOADED bug prompt in new doc v2 (SHOULD NOT BE RETURNED)',
			is_removed_from_doc: 0,
		});

		// tasks 表标记 has_prompt_changed = 1
		snapshotsRepo.updateTaskChangedFlags('task-inflight', {
			hasAcceptChanged: 0,
			hasPromptChanged: 1,
		});

		const context = getBughuntContext('task-inflight', {
			db,
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			documentsRepo: docsRepo,
		});

		// 严格返回派发时快照中的材料，绝不热改
		expect(context.bugPrompt).toBe(originalPrompt);
		expect(context.promptSource).toBe(PROMPT_SOURCE_DOCS);
		expect(context.contractHash).toBe('contract-v1');
		// 标记文档在派发后已发生变更（E-50）
		expect(context.docChangedSinceDispatch).toBe(true);
	});

	it('supports querying by task_key (e.g. M3-T7) as well as UUID', () => {
		setupTask({ id: 'uuid-1234', task_key: 'M3-T7' });
		setupSnapshot({
			id: 'snap-uuid',
			task_id: 'uuid-1234',
			bug_prompt: 'Bug prompt queried by task_key',
		});

		const contextByKey = getBughuntContext('M3-T7', {
			db,
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			documentsRepo: docsRepo,
		});

		expect(contextByKey.taskId).toBe('uuid-1234');
		expect(contextByKey.taskKey).toBe('M3-T7');
		expect(contextByKey.bugPrompt).toBe('Bug prompt queried by task_key');

		const contextByUuid = getBughuntContext('uuid-1234', {
			db,
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			documentsRepo: docsRepo,
		});
		expect(contextByUuid.taskId).toBe('uuid-1234');
		expect(contextByUuid.taskKey).toBe('M3-T7');
	});

	it('supports querying specific snapshotId via options.snapshotId (E-80)', () => {
		setupTask({ id: 'task-multi-rounds' });
		// 模拟多轮派发（E-80）
		setupSnapshot({
			id: 'snap-round-1',
			task_id: 'task-multi-rounds',
			bug_prompt: 'Bug prompt round 1',
			created_at: '2026-09-14T01:00:00.000Z',
		});
		setupSnapshot({
			id: 'snap-round-2',
			task_id: 'task-multi-rounds',
			bug_prompt: 'Bug prompt round 2',
			created_at: '2026-09-14T02:00:00.000Z',
		});

		// 默认取最新（round 2）
		const defaultContext = getBughuntContext('task-multi-rounds', {
			db,
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			documentsRepo: docsRepo,
		});
		expect(defaultContext.snapshotId).toBe('snap-round-2');
		expect(defaultContext.bugPrompt).toBe('Bug prompt round 2');

		// 显式查询 round 1
		const r1Context = getBughuntContext(
			'task-multi-rounds',
			{
				db,
				dispatchSnapshotsRepo: snapshotsRepo,
				tasksRepo,
				documentsRepo: docsRepo,
			},
			{ snapshotId: 'snap-round-1' },
		);
		expect(r1Context.snapshotId).toBe('snap-round-1');
		expect(r1Context.bugPrompt).toBe('Bug prompt round 1');
	});

	it('validates taskId input format and throws E_VALIDATION for empty input', () => {
		expect(() => {
			getBughuntContext('', { db });
		}).toThrow(AppError);

		try {
			getBughuntContext('   ', { db });
			expect.unreachable('Should have thrown AppError');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).code).toBe('E_VALIDATION');
		}
	});

	it('throws E_NOT_FOUND when task does not exist at all in system', () => {
		try {
			getBughuntContext('non-existent-task-id', {
				db,
				dispatchSnapshotsRepo: snapshotsRepo,
				tasksRepo,
				documentsRepo: docsRepo,
			});
			expect.unreachable('Should have thrown AppError');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).code).toBe('E_NOT_FOUND');
		}
	});

	it('throws E_NOT_FOUND when specific snapshotId is not found', () => {
		setupTask({ id: 'task-snap-missing' });
		try {
			getBughuntContext(
				'task-snap-missing',
				{
					db,
					dispatchSnapshotsRepo: snapshotsRepo,
					tasksRepo,
					documentsRepo: docsRepo,
				},
				{ snapshotId: 'snap-does-not-exist' },
			);
			expect.unreachable('Should have thrown AppError');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).code).toBe('E_NOT_FOUND');
		}
	});

	it('AC 4: migration 0002_add_bug_prompt applies cleanly to existing schema and old rows have NULL bug_prompt without backfilling', () => {
		// 创建一个纯 0001_init 的临时数据库
		const dir = mkdtempSync(join(tmpdir(), 'agent-scheduler-migr-test-'));
		temporaryDirectories.push(dir);
		const testDb = openDatabase(join(dir, 'test-migr.db'));
		openDatabases.push(testDb);

		// 只应用 0001_init.sql
		const initSql = readFileSync(join(migrationsDirectory, '0001_init.sql'), 'utf8');
		testDb.exec(initSql);
		testDb.exec(`
			CREATE TABLE schema_migrations (
				version TEXT PRIMARY KEY,
				applied_at TEXT NOT NULL
			);
			INSERT INTO schema_migrations (version, applied_at) VALUES ('0001_init.sql', '2026-09-08T00:00:00.000Z');
		`);

		// 插入旧数据（没有 bug_prompt 列）
		testDb.exec(`
			INSERT INTO documents (id, docs_path, project_name, content_fingerprint, imported_at, last_seen_at)
			VALUES ('doc-old', '/path/doc', 'Old Project', 'fp-1', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z');
			INSERT INTO tasks (id, doc_id, task_key, title, module_key, deps_json, contract_hash, contract_reasons_json)
			VALUES ('t-old', 'doc-old', 'M1-T1', 'Old Task', 'M1', '[]', 'hash-old', '[]');
			INSERT INTO dispatch_snapshots (id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at)
			VALUES ('snap-old', 't-old', 'hash-old', '[]', '{}', '2026-09-08T00:00:00.000Z');
		`);

		// 运行迁移执行器应用 0002_add_bug_prompt.sql
		const runner = createMigrationRunner({
			clock: { now: () => '2026-09-14T12:00:00.000Z' },
			database: testDb,
			fileSystem: {
				readDirectory: (path) => readdirSync(path),
				readFile: (path) => readFileSync(path, 'utf8'),
			},
		});

		const result = runner.run(migrationsDirectory);
		expect(result.appliedVersions).toContain('0002_add_bug_prompt.sql');

		// 验证旧行直开不回填：bug_prompt 为 null
		const oldTask = testDb.prepare('SELECT bug_prompt FROM tasks WHERE id = ?').get('t-old') as {
			bug_prompt: string | null;
		};
		expect(oldTask.bug_prompt).toBeNull();

		const oldSnapshot = testDb
			.prepare('SELECT bug_prompt FROM dispatch_snapshots WHERE id = ?')
			.get('snap-old') as { bug_prompt: string | null };
		expect(oldSnapshot.bug_prompt).toBeNull();

		// 新行可以正常写入 bug_prompt
		testDb.exec(`
			INSERT INTO tasks (id, doc_id, task_key, title, module_key, deps_json, contract_hash, contract_reasons_json, bug_prompt)
			VALUES ('t-new', 'doc-old', 'M1-T2', 'New Task', 'M1', '[]', 'hash-new', '[]', '新任务查 bug 提示词');
		`);
		const newTask = testDb.prepare('SELECT bug_prompt FROM tasks WHERE id = ?').get('t-new') as {
			bug_prompt: string | null;
		};
		expect(newTask.bug_prompt).toBe('新任务查 bug 提示词');
	});

	it('service factory createBughuntContextService returns service instance with getBughuntContext', () => {
		setupTask({ id: 'task-factory-test' });
		setupSnapshot({
			id: 'snap-factory-test',
			task_id: 'task-factory-test',
			bug_prompt: 'Factory prompt',
		});

		const service = createBughuntContextService({
			db,
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			documentsRepo: docsRepo,
		});

		const context = service.getBughuntContext('task-factory-test');
		expect(context.bugPrompt).toBe('Factory prompt');
		expect(context.promptSource).toBe(PROMPT_SOURCE_DOCS);
	});
});
