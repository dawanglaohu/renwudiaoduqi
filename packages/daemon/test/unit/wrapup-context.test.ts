import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import type { DatabaseConnection } from '../../src/db/open-database.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import {
	BUILTIN_WRAPUP_PROMPT,
	PROMPT_SOURCE_BUILTIN,
	PROMPT_SOURCE_DOCS,
} from '../../src/domain/wrapup-builtin-prompt.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { type BatchesRepo, createBatchesRepo } from '../../src/repo/batches.ts';
import {
	type DispatchSnapshotsRepo,
	createDispatchSnapshotsRepo,
} from '../../src/repo/dispatch-snapshots.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../../src/repo/documents.ts';
import { type TasksRepo, createTasksRepo } from '../../src/repo/tasks.ts';
import { createDocsService, matchBatchByTasksSet } from '../../src/service/docs.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsDirectory = resolve(__dirname, '../../migrations');

const openDatabases: DatabaseConnection[] = [];
const temporaryDirectories: string[] = [];

const MOCK_CLOCK = { now: () => '2026-09-13T12:00:00.000Z' };
const MOCK_IDS = {
	counter: 0,
	newId() {
		this.counter += 1;
		return `test-id-${this.counter}`;
	},
};

function createTestDatabase(): DatabaseConnection {
	const dir = mkdtempSync(join(tmpdir(), 'agent-scheduler-wrapup-ctx-test-'));
	temporaryDirectories.push(dir);
	const db = openDatabase(join(dir, 'test.db'));
	openDatabases.push(db);

	const runner = createMigrationRunner({
		clock: { now: () => '2026-09-13T00:00:00.000Z' },
		database: db,
		fileSystem: {
			readDirectory: (path) => readdirSync(path),
			readFile: (path) => readFileSync(path, 'utf8'),
		},
	});
	runner.run(migrationsDirectory);
	return db;
}

function buildValidDocsDataJs(overrides?: {
	tasks?: Array<{ id: string; title: string; deps?: string[]; contractHash?: string }>;
	dispatchBatches?: Record<string, unknown>;
	batchRecords?: Record<string, unknown>;
}) {
	const taskList = overrides?.tasks ?? [
		{ id: 'M1-T1', title: 'Task 1', deps: [] },
		{ id: 'M1-T2', title: 'Task 2', deps: ['M1-T1'] },
	];

	const dataTasks = taskList.map((t) => ({
		id: t.id,
		title: t.title,
		module: 'M1',
		deps: t.deps ?? [],
		accept: `Accept criteria for ${t.id}`,
		input: `Input for ${t.id}`,
		output: `Output for ${t.id}`,
		est: 1.0,
		edges: ['E-01'],
	}));

	const dispatch: Record<string, unknown> = {};
	const contracts: Record<string, unknown> = {};
	const readiness: Record<string, unknown> = {};
	const effectivePaths: Record<string, unknown> = {};

	for (const t of taskList) {
		const hash = t.contractHash ?? `hash-${t.id}-v1`;
		dispatch[t.id] = {
			contractHash: hash,
			implementation: `Implement ${t.id}`,
			review: `Review ${t.id}`,
		};
		contracts[t.id] = { hash };
		readiness[t.id] = { ready: true, reasons: [], contractHash: hash };
		effectivePaths[t.id] = [`packages/daemon/src/${t.id.toLowerCase()}.ts`];
	}

	const docPayload: Record<string, unknown> = {
		schemaVersion: 1,
		project: 'Test Project',
		pres: {
			handoff: {
				repo: '/test/repo',
				mainBranch: 'main',
				branchPrefix: 'task/',
			},
		},
		data: { tasks: dataTasks },
		dispatch,
		handoff: {
			contracts,
			readiness,
			effectivePaths,
		},
	};

	if (overrides?.dispatchBatches !== undefined) {
		docPayload.dispatchBatches = overrides.dispatchBatches;
	}

	if (overrides?.batchRecords !== undefined) {
		docPayload.batchRecords = overrides.batchRecords;
	}

	return `window.DOCS = ${JSON.stringify(docPayload)};`;
}

describe('M3-T6 Wrapup Context Service and DispatchBatches Matching', () => {
	let db: DatabaseConnection;
	let documentsRepo: DocumentsRepo;
	let batchesRepo: BatchesRepo;
	let tasksRepo: TasksRepo;
	let snapshotsRepo: DispatchSnapshotsRepo;

	beforeEach(() => {
		db = createTestDatabase();
		documentsRepo = createDocumentsRepo(db);
		batchesRepo = createBatchesRepo(db);
		tasksRepo = createTasksRepo(db);
		snapshotsRepo = createDispatchSnapshotsRepo(db);
	});

	afterEach(() => {
		for (const d of openDatabases.splice(0)) {
			if (d.open) d.close();
		}
		for (const dir of temporaryDirectories.splice(0)) {
			rmSync(dir, { force: true, recursive: true });
		}
		vi.restoreAllMocks();
	});

	function setupDocument(docId = 'doc-1', fingerprint = 'fp-initial') {
		documentsRepo.insert({
			id: docId,
			docs_path: `/data/${docId}/docs-data.js`,
			project_name: 'Test Project',
			repo_path: '/repo',
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: fingerprint,
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: '2026-09-13T00:00:00.000Z',
			last_seen_at: '2026-09-13T00:00:00.000Z',
		});
	}

	function setupBatch(docId = 'doc-1', batchNo = 1, batchId = 'batch-1') {
		batchesRepo.insert({
			id: batchId,
			doc_id: docId,
			batch_no: batchNo,
			state: 'running',
			started_at: '2026-09-13T01:00:00.000Z',
		});
	}

	function setupTask(
		taskKey: string,
		batchId = 'batch-1',
		docId = 'doc-1',
		overrides?: { contractHash?: string; id?: string },
	) {
		const taskId = overrides?.id ?? `task-${taskKey}`;
		tasksRepo.insert({
			id: taskId,
			doc_id: docId,
			task_key: taskKey,
			title: `Task ${taskKey}`,
			module_key: 'M1',
			deps_json: '[]',
			contract_hash: overrides?.contractHash ?? `hash-${taskKey}-v1`,
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			batch_id: batchId,
			impl_prompt: `Implement ${taskKey}`,
			review_prompt: `Review ${taskKey}`,
			is_removed_from_doc: 0,
			has_accept_changed: 0,
			has_prompt_changed: 0,
		});
		return taskId;
	}

	function createTestDocsService() {
		return createDocsService({
			documentsRepo,
			batchesRepo,
			tasksRepo,
			dispatchSnapshotsRepo: snapshotsRepo,
			clock: MOCK_CLOCK,
			ids: MOCK_IDS,
		});
	}

	it('matchBatchByTasksSet: pure function correctly matches tasks set regardless of order (AC 1)', () => {
		const batches = [
			{
				batchNo: 1,
				tasks: ['M1-T1', 'M1-T2'],
				wrapup: 'Wrapup for Batch 1',
				contractHash: 'hash-b1',
			},
			{
				batchNo: 2,
				tasks: ['M2-T1'],
				wrapup: 'Wrapup for Batch 2',
			},
		];

		// Identical order
		expect(matchBatchByTasksSet(batches, ['M1-T1', 'M1-T2'])?.wrapup).toBe('Wrapup for Batch 1');
		// Reverse order (order-independent)
		expect(matchBatchByTasksSet(batches, ['M1-T2', 'M1-T1'])?.wrapup).toBe('Wrapup for Batch 1');

		// Single task match
		expect(matchBatchByTasksSet(batches, ['M2-T1'])?.wrapup).toBe('Wrapup for Batch 2');

		// Extra task in candidate -> no match
		expect(matchBatchByTasksSet(batches, ['M1-T1'])).toBeNull();
		// Missing task in candidate -> no match
		expect(matchBatchByTasksSet(batches, ['M1-T1', 'M1-T2', 'M1-T3'])).toBeNull();
		// Different task -> no match
		expect(matchBatchByTasksSet(batches, ['UNKNOWN-T1'])).toBeNull();
		// Empty array
		expect(matchBatchByTasksSet([], ['M1-T1'])).toBeNull();
		expect(matchBatchByTasksSet(undefined, ['M1-T1'])).toBeNull();
	});

	it('AC 1: matches by exact tasks set (order-independent) and does not match by layer number (E-296)', () => {
		setupDocument('doc-1');
		setupBatch('doc-1', 2, 'batch-custom'); // Note batch_no is 2
		setupTask('M1-T2', 'batch-custom');
		setupTask('M1-T1', 'batch-custom');

		// Doc dispatchBatches has layer "99" with batchNo 99, but tasks set matches ['M1-T1', 'M1-T2']
		const sampleWrapup =
			'# 第 1 批收口小结与接缝检查\n\n本批两个任务：M1-T1 与 M1-T2 已全部落地。\n请按照八段格式提交报告。';
		const rawDocJs = buildValidDocsDataJs({
			tasks: [
				{ id: 'M1-T1', title: 'Task 1' },
				{ id: 'M1-T2', title: 'Task 2' },
			],
			dispatchBatches: {
				'99': {
					batchNo: 99,
					tasks: ['M1-T1', 'M1-T2'],
					contractHash: 'batch-hash-99',
					wrapup: sampleWrapup,
				},
			},
		});

		const service = createTestDocsService();

		// Parse doc content so it is registered in the service instance closure
		const parsed = service.parseContent(rawDocJs);
		// Update docRow to reflect the parsed fingerprint
		documentsRepo.updateMetadata({
			id: 'doc-1',
			project_name: parsed.projectName,
			repo_path: parsed.repoPath,
			main_branch: parsed.mainBranch,
			branch_prefix: parsed.branchPrefix,
			content_fingerprint: parsed.contentFingerprint,
			is_source_readable: 1,
			last_seen_at: MOCK_CLOCK.now(),
		});

		const context = service.getWrapupContext('batch-custom');

		// AC 1: Matched by tasks set (even though batch_no in DB is 2 and doc layer is 99)
		expect(context.promptSource).toBe(PROMPT_SOURCE_DOCS);
		expect(context.wrapup).toBe(sampleWrapup);
		expect(context.wrapupPrompt).toBe(sampleWrapup);
		expect(context.batchNo).toBe(2);
		expect(context.contractHash).toBe('batch-hash-99');
		expect(context.isSnapshot).toBe(true);
		expect(context.isReadOnly).toBe(true);
		expect(new Set(context.tasks)).toEqual(new Set(['M1-T1', 'M1-T2']));
		expect(context.tasks.length).toBe(2);
	});

	it('AC 2 & E-296: returns builtin prompt and promptSource=builtin when no matching entry exists or key not exported, without throwing', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		setupDocument('doc-1');
		setupBatch('doc-1', 1, 'batch-1');
		setupTask('M1-T1', 'batch-1');

		// 1. Doc completely omits dispatchBatches
		const rawDocWithoutBatches = buildValidDocsDataJs({
			tasks: [{ id: 'M1-T1', title: 'Task 1' }],
		});

		const service1 = createTestDocsService();

		const parsed = service1.parseContent(rawDocWithoutBatches);
		documentsRepo.updateMetadata({
			id: 'doc-1',
			project_name: parsed.projectName,
			repo_path: parsed.repoPath,
			main_branch: parsed.mainBranch,
			branch_prefix: parsed.branchPrefix,
			content_fingerprint: parsed.contentFingerprint,
			is_source_readable: 1,
			last_seen_at: MOCK_CLOCK.now(),
		});

		const contextNoBatches = service1.getWrapupContext('batch-1');
		expect(contextNoBatches.promptSource).toBe(PROMPT_SOURCE_BUILTIN);
		expect(contextNoBatches.wrapup).toBe(BUILTIN_WRAPUP_PROMPT);
		expect(contextNoBatches.contractHash).toBeNull();
		expect(warnSpy).toHaveBeenCalled();

		// 2. Doc has dispatchBatches, but tasks count does not match (has an extra task M1-T2)
		const service2 = createTestDocsService();
		const rawDocMismatch = buildValidDocsDataJs({
			tasks: [
				{ id: 'M1-T1', title: 'Task 1' },
				{ id: 'M1-T2', title: 'Task 2' },
			],
			dispatchBatches: {
				'0': {
					batchNo: 1,
					tasks: ['M1-T1', 'M1-T2'],
					wrapup: 'Wrapup for two tasks',
				},
			},
		});

		const parsedMismatch = service2.parseContent(rawDocMismatch);
		documentsRepo.updateMetadata({
			id: 'doc-1',
			project_name: parsedMismatch.projectName,
			repo_path: parsedMismatch.repoPath,
			main_branch: parsedMismatch.mainBranch,
			branch_prefix: parsedMismatch.branchPrefix,
			content_fingerprint: parsedMismatch.contentFingerprint,
			is_source_readable: 1,
			last_seen_at: MOCK_CLOCK.now(),
		});

		const contextMismatch = service2.getWrapupContext('batch-1');
		expect(contextMismatch.promptSource).toBe(PROMPT_SOURCE_BUILTIN);
		expect(contextMismatch.wrapup).toBe(BUILTIN_WRAPUP_PROMPT);
	});

	it('AC 3 & Decision 73: wrapup material is strictly verbatim and never reads doc batchRecords', () => {
		setupDocument('doc-1');
		setupBatch('doc-1', 1, 'batch-1');
		setupTask('M1-T1', 'batch-1');

		// Wrapup contains complex whitespace, indentation, markdown code blocks and trailing newlines
		const complexVerbatimWrapup = `
# Batch 1 Wrapup Header

Line 1 with trailing space   
Line 2 with \`special characters\` and symbols: !@#$%^&*()_+~

\`\`\`bash
pnpm -w check
python docs/_run/build_docs.py
\`\`\`

- Bullet 1
- Bullet 2

End of prompt.
`;

		const rawDocWithBatchRecords = buildValidDocsDataJs({
			tasks: [{ id: 'M1-T1', title: 'Task 1' }],
			dispatchBatches: {
				'0': {
					batchNo: 1,
					tasks: ['M1-T1'],
					wrapup: complexVerbatimWrapup,
				},
			},
			batchRecords: {
				'1': {
					record: 'HUMAN_RECORD_SHOULD_BE_IGNORED',
					status: 'closed',
				},
			},
		});

		const service = createTestDocsService();

		// Decision 73: parseDocsDataContent does not populate batchRecords
		const parsed = service.parseContent(rawDocWithBatchRecords);
		expect((parsed as unknown as Record<string, unknown>).batchRecords).toBeUndefined();

		documentsRepo.updateMetadata({
			id: 'doc-1',
			project_name: parsed.projectName,
			repo_path: parsed.repoPath,
			main_branch: parsed.mainBranch,
			branch_prefix: parsed.branchPrefix,
			content_fingerprint: parsed.contentFingerprint,
			is_source_readable: 1,
			last_seen_at: MOCK_CLOCK.now(),
		});

		const context = service.getWrapupContext('batch-1');
		// AC 3: Returned verbatim without trimming or truncation
		expect(context.wrapup).toBe(complexVerbatimWrapup);
		expect(context.wrapupPrompt).toBe(complexVerbatimWrapup);
	});

	it('AC 4 & E-50: when document fingerprint changes during execution or wrapup, original snapshot is preserved without hot-reloading (both in memory)', () => {
		setupDocument('doc-1');
		setupBatch('doc-1', 1, 'batch-1');
		const t1Id = setupTask('M1-T1', 'batch-1', 'doc-1', { contractHash: 'hash-M1-T1-v1' });

		const v1Wrapup = '# Batch 1 - Version 1 Wrapup Prompt (Snapshot)';
		const docV1Js = buildValidDocsDataJs({
			tasks: [{ id: 'M1-T1', title: 'Task 1' }],
			dispatchBatches: {
				'0': {
					batchNo: 1,
					tasks: ['M1-T1'],
					wrapup: v1Wrapup,
				},
			},
		});

		const service = createTestDocsService();

		// 1. Initial document import V1
		const parsedV1 = service.parseContent(docV1Js);
		documentsRepo.updateMetadata({
			id: 'doc-1',
			project_name: parsedV1.projectName,
			repo_path: parsedV1.repoPath,
			main_branch: parsedV1.mainBranch,
			branch_prefix: parsedV1.branchPrefix,
			content_fingerprint: parsedV1.contentFingerprint,
			is_source_readable: 1,
			last_seen_at: MOCK_CLOCK.now(),
		});

		// 2. Task is dispatched and takes a snapshot with hash-M1-T1-v1
		snapshotsRepo.takeSnapshotForTask({
			taskId: t1Id,
			launchSpecJson: '{"agentId":"codex"}',
			createdAt: '2026-09-13T01:00:00.000Z',
			snapshotId: 'snap-1',
		});

		// 3. First wrapup context retrieval locks the context in the service instance
		const initialContext = service.getWrapupContext('batch-1');
		expect(initialContext.wrapup).toBe(v1Wrapup);
		expect(initialContext.promptSource).toBe(PROMPT_SOURCE_DOCS);

		// 4. Document changes mid-flight: new tasks, new wrapup prompt V2, new contract hash
		const v2Wrapup = '# Batch 1 - Version 2 Wrapup Prompt (Hot-Reload Attempt)';
		const docV2Js = buildValidDocsDataJs({
			tasks: [{ id: 'M1-T1', title: 'Task 1 Modified', contractHash: 'hash-M1-T1-v2' }],
			dispatchBatches: {
				'0': {
					batchNo: 1,
					tasks: ['M1-T1'],
					wrapup: v2Wrapup,
				},
			},
		});

		const parsedV2 = service.parseContent(docV2Js);
		documentsRepo.updateMetadata({
			id: 'doc-1',
			project_name: parsedV2.projectName,
			repo_path: parsedV2.repoPath,
			main_branch: parsedV2.mainBranch,
			branch_prefix: parsedV2.branchPrefix,
			content_fingerprint: parsedV2.contentFingerprint, // New fingerprint
			is_source_readable: 1,
			last_seen_at: MOCK_CLOCK.now(),
		});

		// Task in DB is updated to new contract hash
		tasksRepo.updateDocFields({
			id: t1Id,
			title: 'Task 1 Modified',
			module_key: 'M1',
			deps_json: '[]',
			input_text: 'new input',
			output_text: 'new output',
			accept_text: 'new accept',
			edge_ids_json: '[]',
			task_paths_json: '["packages/daemon/src/m1-t1.ts"]',
			contract_hash: 'hash-M1-T1-v2',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1.0,
			batch_id: 'batch-1',
			impl_prompt: 'new impl',
			review_prompt: 'new review',
			is_removed_from_doc: 0,
		});

		// 5. AC 4 & E-50: Second call during execution/wrapup strictly yields the locked V1 snapshot
		const contextAfterChange = service.getWrapupContext('batch-1');
		expect(contextAfterChange.wrapup).toBe(v1Wrapup);
		expect(contextAfterChange.wrapup).not.toBe(v2Wrapup);
		expect(contextAfterChange.isSnapshot).toBe(true);

		// 6. Even with a fresh service instance that parsed both V1 and V2, contract hash matching recovers V1
		const serviceNew = createTestDocsService();
		serviceNew.parseContent(docV1Js);
		serviceNew.parseContent(docV2Js);
		const contextFromHistory = serviceNew.getWrapupContext('batch-1');
		expect(contextFromHistory.wrapup).toBe(v1Wrapup);
		expect(contextFromHistory.docChangedSinceDispatch).toBe(true);
	});

	it('R2 & E-50: when document changes to V2 and instance only knows V2 (equivalent to daemon restart after doc change), falls back to builtin and never leaks V2', () => {
		setupDocument('doc-1');
		setupBatch('doc-1', 1, 'batch-restart');
		const t1Id = setupTask('M1-T1', 'batch-restart', 'doc-1', { contractHash: 'hash-M1-T1-v1' });

		// Task was dispatched when contractHash was v1
		snapshotsRepo.takeSnapshotForTask({
			taskId: t1Id,
			launchSpecJson: '{"agentId":"codex"}',
			createdAt: '2026-09-13T01:00:00.000Z',
			snapshotId: 'snap-restarted',
		});

		// Document was updated to V2 in disk and DB task record has hash v2
		const v2Wrapup = '# Batch 1 - Version 2 Wrapup (Should NEVER leak to V1 in-flight batch)';
		const docV2Js = buildValidDocsDataJs({
			tasks: [{ id: 'M1-T1', title: 'Task 1 Modified', contractHash: 'hash-M1-T1-v2' }],
			dispatchBatches: {
				'0': {
					batchNo: 1,
					tasks: ['M1-T1'],
					wrapup: v2Wrapup,
				},
			},
		});

		tasksRepo.updateDocFields({
			id: t1Id,
			title: 'Task 1 Modified',
			module_key: 'M1',
			deps_json: '[]',
			input_text: 'new input',
			output_text: 'new output',
			accept_text: 'new accept',
			edge_ids_json: '[]',
			task_paths_json: '["packages/daemon/src/m1-t1.ts"]',
			contract_hash: 'hash-M1-T1-v2',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1.0,
			batch_id: 'batch-restart',
			impl_prompt: 'new impl',
			review_prompt: 'new review',
			is_removed_from_doc: 0,
		});

		// New service instance starts up and ONLY parses V2 (no knowledge of historical V1)
		const freshServiceAfterRestart = createTestDocsService();
		const parsedV2 = freshServiceAfterRestart.parseContent(docV2Js);
		documentsRepo.updateMetadata({
			id: 'doc-1',
			project_name: parsedV2.projectName,
			repo_path: parsedV2.repoPath,
			main_branch: parsedV2.mainBranch,
			branch_prefix: parsedV2.branchPrefix,
			content_fingerprint: parsedV2.contentFingerprint,
			is_source_readable: 1,
			last_seen_at: MOCK_CLOCK.now(),
		});

		const context = freshServiceAfterRestart.getWrapupContext('batch-restart');

		// R2 requirement: docChangedSinceDispatch=true but snapshot v1 hash not in memory ->
		// MUST fall back to builtin prompt and MUST NOT leak V2 wrapup
		expect(context.promptSource).toBe(PROMPT_SOURCE_BUILTIN);
		expect(context.wrapup).toBe(BUILTIN_WRAPUP_PROMPT);
		expect(context.wrapup).not.toBe(v2Wrapup);
		expect(context.docChangedSinceDispatch).toBe(true);
	});

	it('R1: two separate DocsService instances have isolated wrapup locks and doc version caches (no module-level state)', () => {
		setupDocument('doc-1');
		setupBatch('doc-1', 1, 'batch-isolated');
		setupTask('M1-T1', 'batch-isolated');

		const wrapupTextA = '# Wrapup from Instance A';
		const docJsA = buildValidDocsDataJs({
			tasks: [{ id: 'M1-T1', title: 'Task 1' }],
			dispatchBatches: {
				'0': {
					batchNo: 1,
					tasks: ['M1-T1'],
					wrapup: wrapupTextA,
				},
			},
		});

		const serviceA = createTestDocsService();
		const parsedA = serviceA.parseContent(docJsA);
		documentsRepo.updateMetadata({
			id: 'doc-1',
			project_name: parsedA.projectName,
			repo_path: parsedA.repoPath,
			main_branch: parsedA.mainBranch,
			branch_prefix: parsedA.branchPrefix,
			content_fingerprint: parsedA.contentFingerprint,
			is_source_readable: 1,
			last_seen_at: MOCK_CLOCK.now(),
		});

		// Service A locks wrapupTextA for batch-isolated
		const contextA = serviceA.getWrapupContext('batch-isolated');
		expect(contextA.wrapup).toBe(wrapupTextA);

		// Service B is a completely independent instance that has never parsed docJsA
		const serviceB = createTestDocsService();
		// Service B calls getWrapupContext on the same batchId:
		// because Service B's closure has no cache for doc-1's fingerprint and has no locked wrapup,
		// it falls back to builtin without being affected by Service A's memory lock
		const contextB = serviceB.getWrapupContext('batch-isolated');
		expect(contextB.promptSource).toBe(PROMPT_SOURCE_BUILTIN);
		expect(contextB.wrapup).toBe(BUILTIN_WRAPUP_PROMPT);
		expect(contextB.wrapup).not.toBe(wrapupTextA);
	});

	it('validates batchId and verifies error boundaries for missing entities', () => {
		const service = createTestDocsService();

		// Empty batchId -> E_VALIDATION
		expect(() => service.getWrapupContext('')).toThrowError(AppError);
		expect(() => service.getWrapupContext('   ')).toThrowError(AppError);

		// Non-existent batchId -> E_NOT_FOUND
		expect(() => service.getWrapupContext('non-existent-batch')).toThrowError(AppError);
	});

	it('filters out is_removed_from_doc=1 tasks and matches remaining active tasks set', () => {
		setupDocument('doc-1');
		setupBatch('doc-1', 1, 'batch-removed-test');
		setupTask('M1-T1', 'batch-removed-test');
		const t2Id = setupTask('M1-T2', 'batch-removed-test');

		// Mark M1-T2 as removed from document (is_removed_from_doc = 1)
		tasksRepo.updateDocFields({
			id: t2Id,
			title: 'Task M1-T2 Removed',
			module_key: 'M1',
			deps_json: '[]',
			input_text: null,
			output_text: null,
			accept_text: 'Accept',
			edge_ids_json: '[]',
			task_paths_json: '[]',
			contract_hash: 'hash-M1-T2-v1',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1.0,
			batch_id: 'batch-removed-test',
			impl_prompt: 'impl',
			review_prompt: 'review',
			is_removed_from_doc: 1,
		});

		// Document has dispatchBatches only for the remaining active task M1-T1
		const wrapupOnlyT1 = '# Wrapup matching active task M1-T1 only';
		const docJs = buildValidDocsDataJs({
			tasks: [{ id: 'M1-T1', title: 'Task 1' }],
			dispatchBatches: {
				'0': {
					batchNo: 1,
					tasks: ['M1-T1'],
					wrapup: wrapupOnlyT1,
				},
			},
		});

		const service = createTestDocsService();
		const parsed = service.parseContent(docJs);
		documentsRepo.updateMetadata({
			id: 'doc-1',
			project_name: parsed.projectName,
			repo_path: parsed.repoPath,
			main_branch: parsed.mainBranch,
			branch_prefix: parsed.branchPrefix,
			content_fingerprint: parsed.contentFingerprint,
			is_source_readable: 1,
			last_seen_at: MOCK_CLOCK.now(),
		});

		const context = service.getWrapupContext('batch-removed-test');
		expect(context.promptSource).toBe(PROMPT_SOURCE_DOCS);
		expect(context.wrapup).toBe(wrapupOnlyT1);
		expect(context.tasks).toEqual(['M1-T1']);
	});
});
