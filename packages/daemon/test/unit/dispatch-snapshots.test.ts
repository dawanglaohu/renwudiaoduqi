import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import {
	checkTaskDispatchEligibility,
	compareTaskWithSnapshot,
	computeDocDiffBanner,
	filterAffectedTasks,
} from '../../src/domain/docs-fingerprint.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createBatchesRepo } from '../../src/repo/batches.ts';
import {
	type DispatchSnapshotsRepo,
	createDispatchSnapshotsRepo,
} from '../../src/repo/dispatch-snapshots.ts';
import { createDocumentsRepo } from '../../src/repo/documents.ts';
import { type TasksRepo, createTasksRepo } from '../../src/repo/tasks.ts';

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
	const dir = mkdtempSync(join(tmpdir(), 'agent-scheduler-snapshots-test-'));
	temporaryDirectories.push(dir);
	const db = openDatabase(join(dir, 'test.db'));
	openDatabases.push(db);

	const runner = createMigrationRunner({
		clock: { now: () => '2026-09-08T00:00:00.000Z' },
		database: db,
		fileSystem: {
			readDirectory: (path) => readdirSync(path),
			readFile: (path) => readFileSync(path, 'utf8'),
		},
	});
	runner.run(migrationsDirectory);
	return db;
}

function insertMockDocument(db: DatabaseConnection, docId = 'doc-1'): void {
	const docsRepo = createDocumentsRepo(db);
	docsRepo.insert({
		id: docId,
		docs_path: `/data/${docId}/docs-data.js`,
		project_name: 'Test Project',
		repo_path: `/repos/${docId}`,
		main_branch: 'main',
		branch_prefix: 'task/',
		lane_count: 2,
		content_fingerprint: 'fp-initial',
		is_source_readable: 1,
		is_takeover_notified: 0,
		imported_at: '2026-09-08T00:00:00.000Z',
		last_seen_at: '2026-09-08T00:00:00.000Z',
	});
}

function insertMockBatch(
	db: DatabaseConnection,
	docId = 'doc-1',
	batchNo = 1,
	batchId = 'batch-1',
): void {
	const batchesRepo = createBatchesRepo(db);
	batchesRepo.insert({
		id: batchId,
		doc_id: docId,
		batch_no: batchNo,
		state: 'idle',
	});
}

describe('M3-T3 domain/docs-fingerprint comparison & banner pure functions', () => {
	it('returns all false flags when latestSnapshot is null (undispatched task)', () => {
		const task = {
			id: 't-1',
			taskKey: 'M1-T1',
			inputText: 'input A',
			outputText: 'output A',
			acceptText: 'accept A',
			implPrompt: 'impl A',
			reviewPrompt: 'review A',
			contractHash: 'hash-1',
		};

		const result = compareTaskWithSnapshot(task, null);
		expect(result.isRemovedFromDoc).toBe(false);
		expect(result.hasAcceptChanged).toBe(false);
		expect(result.hasPromptChanged).toBe(false);
		expect(result.hasAnyChange).toBe(false);
		expect(result.latestSnapshotId).toBeNull();
		expect(result.snapshotCreatedAt).toBeNull();
	});

	it('detects isRemovedFromDoc when task is explicitly marked or removed (E-18, E-77)', () => {
		const task = {
			id: 't-1',
			taskKey: 'M1-T1',
			contractHash: 'hash-1',
			isRemovedFromDoc: 1,
		};

		const result = compareTaskWithSnapshot(task, null);
		expect(result.isRemovedFromDoc).toBe(true);
		expect(result.hasAnyChange).toBe(true);
	});

	it('detects hasAcceptChanged when accept_text, input_text, or output_text changes (AC 2, E-19, E-78)', () => {
		const snapshot = {
			id: 'snap-1',
			taskId: 't-1',
			inputText: 'input A',
			outputText: 'output A',
			acceptText: 'accept A',
			implPrompt: 'impl A',
			reviewPrompt: 'review A',
			contractHash: 'hash-1',
			createdAt: '2026-09-08T00:00:00.000Z',
		};

		// 1. Identical task -> no accept change
		const identical = compareTaskWithSnapshot(
			{
				id: 't-1',
				taskKey: 'M1-T1',
				inputText: 'input A',
				outputText: 'output A',
				acceptText: 'accept A',
				implPrompt: 'impl A',
				reviewPrompt: 'review A',
				contractHash: 'hash-1',
			},
			snapshot,
		);
		expect(identical.hasAcceptChanged).toBe(false);
		expect(identical.isAcceptTextChanged).toBe(false);
		expect(identical.isInputTextChanged).toBe(false);
		expect(identical.isOutputTextChanged).toBe(false);

		// 2. accept_text changed -> hasAcceptChanged = true, isAcceptTextChanged = true
		const acceptChanged = compareTaskWithSnapshot(
			{
				id: 't-1',
				taskKey: 'M1-T1',
				inputText: 'input A',
				outputText: 'output A',
				acceptText: 'accept A (modified)',
				implPrompt: 'impl A',
				reviewPrompt: 'review A',
				contractHash: 'hash-1',
			},
			snapshot,
		);
		expect(acceptChanged.hasAcceptChanged).toBe(true);
		expect(acceptChanged.isAcceptTextChanged).toBe(true);
		expect(acceptChanged.isInputTextChanged).toBe(false);

		// 3. input_text changed -> hasAcceptChanged = true (E-19)
		const inputChanged = compareTaskWithSnapshot(
			{
				id: 't-1',
				taskKey: 'M1-T1',
				inputText: 'input A (new)',
				outputText: 'output A',
				acceptText: 'accept A',
				implPrompt: 'impl A',
				reviewPrompt: 'review A',
				contractHash: 'hash-1',
			},
			snapshot,
		);
		expect(inputChanged.hasAcceptChanged).toBe(true);
		expect(inputChanged.isInputTextChanged).toBe(true);
		expect(inputChanged.isAcceptTextChanged).toBe(false);

		// 4. output_text changed -> hasAcceptChanged = true (E-19)
		const outputChanged = compareTaskWithSnapshot(
			{
				id: 't-1',
				taskKey: 'M1-T1',
				inputText: 'input A',
				outputText: 'output A (updated)',
				acceptText: 'accept A',
				implPrompt: 'impl A',
				reviewPrompt: 'review A',
				contractHash: 'hash-1',
			},
			snapshot,
		);
		expect(outputChanged.hasAcceptChanged).toBe(true);
		expect(outputChanged.isOutputTextChanged).toBe(true);
	});

	it('detects hasPromptChanged when implPrompt, reviewPrompt, or contractHash changes (AC 2, E-77, E-78)', () => {
		const snapshot = {
			id: 'snap-1',
			taskId: 't-1',
			inputText: 'input A',
			outputText: 'output A',
			acceptText: 'accept A',
			implPrompt: 'prompt impl A',
			reviewPrompt: 'prompt review A',
			contractHash: 'hash-initial',
			createdAt: '2026-09-08T00:00:00.000Z',
		};

		// 1. implPrompt changed
		const implChanged = compareTaskWithSnapshot(
			{
				id: 't-1',
				taskKey: 'M1-T1',
				inputText: 'input A',
				outputText: 'output A',
				acceptText: 'accept A',
				implPrompt: 'prompt impl B',
				reviewPrompt: 'prompt review A',
				contractHash: 'hash-initial',
			},
			snapshot,
		);
		expect(implChanged.hasPromptChanged).toBe(true);
		expect(implChanged.isImplPromptChanged).toBe(true);
		expect(implChanged.isContractHashChanged).toBe(false);

		// 2. reviewPrompt changed
		const reviewChanged = compareTaskWithSnapshot(
			{
				id: 't-1',
				taskKey: 'M1-T1',
				inputText: 'input A',
				outputText: 'output A',
				acceptText: 'accept A',
				implPrompt: 'prompt impl A',
				reviewPrompt: 'prompt review B',
				contractHash: 'hash-initial',
			},
			snapshot,
		);
		expect(reviewChanged.hasPromptChanged).toBe(true);
		expect(reviewChanged.isReviewPromptChanged).toBe(true);

		// 3. AC 2: contractHash changed while prompt text is identical -> hasPromptChanged MUST be true
		const contractHashChanged = compareTaskWithSnapshot(
			{
				id: 't-1',
				taskKey: 'M1-T1',
				inputText: 'input A',
				outputText: 'output A',
				acceptText: 'accept A',
				implPrompt: 'prompt impl A',
				reviewPrompt: 'prompt review A',
				contractHash: 'hash-clause-updated',
			},
			snapshot,
		);
		expect(contractHashChanged.hasPromptChanged).toBe(true);
		expect(contractHashChanged.isContractHashChanged).toBe(true);
		expect(contractHashChanged.isImplPromptChanged).toBe(false);
		expect(contractHashChanged.isReviewPromptChanged).toBe(false);
	});

	it('computes doc diff banner and filters affected tasks correctly (AC 2, E-77, E-78)', () => {
		const tasks = [
			{ id: 't-1', taskKey: 'M1-T1', acceptText: 'accept 1', contractHash: 'h1' },
			{ id: 't-2', taskKey: 'M1-T2', acceptText: 'accept 2 changed', contractHash: 'h2' },
			{ id: 't-3', taskKey: 'M1-T3', acceptText: 'accept 3', contractHash: 'h3 changed' },
			{ id: 't-4', taskKey: 'M1-T4', acceptText: 'accept 4', contractHash: 'h4' },
		];

		const snapshotsMap = new Map([
			[
				't-1',
				{
					id: 's-1',
					taskId: 't-1',
					acceptText: 'accept 1',
					contractHash: 'h1',
					createdAt: '2026-09-08T00:00:00.000Z',
				},
			],
			[
				't-2',
				{
					id: 's-2',
					taskId: 't-2',
					acceptText: 'accept 2',
					contractHash: 'h2',
					createdAt: '2026-09-08T00:00:00.000Z',
				},
			],
			[
				't-3',
				{
					id: 's-3',
					taskId: 't-3',
					acceptText: 'accept 3',
					contractHash: 'h3',
					createdAt: '2026-09-08T00:00:00.000Z',
				},
			],
			[
				't-4',
				{
					id: 's-4',
					taskId: 't-4',
					acceptText: 'accept 4',
					contractHash: 'h4',
					createdAt: '2026-09-08T00:00:00.000Z',
				},
			],
		]);

		// M1-T4 is active, but say M1-T1 is active, M1-T2 is active, M1-T3 is active, M1-T5 disappeared
		const banner = computeDocDiffBanner('doc-1', tasks, snapshotsMap, ['M1-T1', 'M1-T2', 'M1-T3']);

		expect(banner.docId).toBe('doc-1');
		expect(banner.hasChanges).toBe(true);
		expect(banner.totalTasksCount).toBe(4);
		expect(banner.removedTaskCount).toBe(1); // M1-T4 not in active keys
		expect(banner.acceptChangedCount).toBe(1); // M1-T2
		expect(banner.promptChangedCount).toBe(1); // M1-T3
		expect(banner.affectedTaskCount).toBe(3); // M1-T2, M1-T3, M1-T4

		expect(filterAffectedTasks(banner.tasks, 'all')).toHaveLength(3);
		expect(filterAffectedTasks(banner.tasks, 'removed')).toHaveLength(1);
		expect(filterAffectedTasks(banner.tasks, 'accept_changed')).toHaveLength(1);
		expect(filterAffectedTasks(banner.tasks, 'prompt_changed')).toHaveLength(1);
	});

	it('checks task dispatch eligibility and blocks removed tasks (AC 3, E-18, E-77)', () => {
		expect(checkTaskDispatchEligibility({ isRemovedFromDoc: 1 }).canDispatch).toBe(false);
		expect(checkTaskDispatchEligibility({ isRemovedFromDoc: true }).canDispatch).toBe(false);
		expect(checkTaskDispatchEligibility({ is_removed_from_doc: 1 }).canDispatch).toBe(false);
		expect(
			checkTaskDispatchEligibility({ isRemovedFromDoc: 0, isContractReady: 0 }).canDispatch,
		).toBe(false);
		expect(
			checkTaskDispatchEligibility({ isRemovedFromDoc: 0, isContractReady: 1 }).canDispatch,
		).toBe(true);
	});
});

describe('M3-T3 repo/dispatch-snapshots Database Integration', () => {
	let db: DatabaseConnection;
	let tasksRepo: TasksRepo;
	let snapshotsRepo: DispatchSnapshotsRepo;

	beforeEach(() => {
		db = createTestDatabase();
		tasksRepo = createTasksRepo(db);
		snapshotsRepo = createDispatchSnapshotsRepo(db);
		insertMockDocument(db, 'doc-1');
		insertMockBatch(db, 'doc-1', 1, 'batch-1');
	});

	function setupTask(overrides: Partial<Parameters<TasksRepo['insert']>[0]> = {}) {
		const task = {
			id: overrides.id ?? 'task-1',
			doc_id: 'doc-1',
			task_key: overrides.task_key ?? 'M1-T1',
			title: 'Task 1 Title',
			module_key: 'M1',
			deps_json: '[]',
			input_text: overrides.input_text ?? 'Input Text V1',
			output_text: overrides.output_text ?? 'Output Text V1',
			accept_text: overrides.accept_text ?? 'Acceptance Criteria V1',
			edge_ids_json: '["E-19"]',
			task_paths_json: '["packages/daemon/src/a.ts"]',
			contract_hash: overrides.contract_hash ?? 'hash-v1',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1.5,
			batch_id: 'batch-1',
			impl_prompt: overrides.impl_prompt ?? 'Implementation Prompt V1',
			review_prompt: overrides.review_prompt ?? 'Review Prompt V1',
			is_removed_from_doc: overrides.is_removed_from_doc ?? 0,
			has_accept_changed: overrides.has_accept_changed ?? 0,
			has_prompt_changed: overrides.has_prompt_changed ?? 0,
			manual_state: null,
		};
		tasksRepo.insert(task);
		return task;
	}

	it('AC 1 & E-19: snapshots input, output, accept, prompts, contract_hash, and paths verbatim at dispatch time', () => {
		setupTask();

		const launchSpec = JSON.stringify({
			agentId: 'codex',
			permissionTier: 'workspaceWrite',
			effortTier: 'medium',
		});

		const snapshot = snapshotsRepo.takeSnapshotForTask({
			taskId: 'task-1',
			launchSpecJson: launchSpec,
			createdAt: '2026-09-08T12:00:00.000Z',
			snapshotId: 'snap-1',
		});

		expect(snapshot.id).toBe('snap-1');
		expect(snapshot.task_id).toBe('task-1');
		expect(snapshot.input_text).toBe('Input Text V1');
		expect(snapshot.output_text).toBe('Output Text V1');
		expect(snapshot.accept_text).toBe('Acceptance Criteria V1');
		expect(snapshot.impl_prompt).toBe('Implementation Prompt V1');
		expect(snapshot.review_prompt).toBe('Review Prompt V1');
		expect(snapshot.contract_hash).toBe('hash-v1');
		expect(snapshot.task_paths_json).toBe('["packages/daemon/src/a.ts"]');
		expect(snapshot.launch_spec_json).toBe(launchSpec);
		expect(snapshot.created_at).toBe('2026-09-08T12:00:00.000Z');

		// Query back by ID
		const retrieved = snapshotsRepo.findById('snap-1');
		expect(retrieved).toEqual(snapshot);
	});

	it('AC 2 & E-77 & E-78: refreshDocDiff produces three boolean flags, contract hash change triggers prompt flag, and returns affected list', () => {
		setupTask({ id: 't-1', task_key: 'M1-T1' });
		setupTask({ id: 't-2', task_key: 'M1-T2' });
		setupTask({ id: 't-3', task_key: 'M1-T3' });

		// Dispatch all 3 tasks
		snapshotsRepo.takeSnapshotForTask({
			taskId: 't-1',
			launchSpecJson: '{}',
			createdAt: '2026-09-08T10:00:00.000Z',
		});
		snapshotsRepo.takeSnapshotForTask({
			taskId: 't-2',
			launchSpecJson: '{}',
			createdAt: '2026-09-08T10:00:00.000Z',
		});
		snapshotsRepo.takeSnapshotForTask({
			taskId: 't-3',
			launchSpecJson: '{}',
			createdAt: '2026-09-08T10:00:00.000Z',
		});

		// Now document is regenerated:
		// t-1 has changed accept_text
		tasksRepo.updateDocFields({
			id: 't-1',
			title: 'Task 1 Title',
			module_key: 'M1',
			deps_json: '[]',
			input_text: 'Input Text V1',
			output_text: 'Output Text V1',
			accept_text: 'Acceptance Criteria V2 - Changed!',
			edge_ids_json: '[]',
			task_paths_json: '[]',
			contract_hash: 'hash-v1',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1.5,
			batch_id: 'batch-1',
			impl_prompt: 'Implementation Prompt V1',
			review_prompt: 'Review Prompt V1',
			is_removed_from_doc: 0,
		});

		// t-2 has identical prompts and accept, but contract_hash changed (e.g. scope/supportPaths update)
		tasksRepo.updateDocFields({
			id: 't-2',
			title: 'Task 2 Title',
			module_key: 'M1',
			deps_json: '[]',
			input_text: 'Input Text V1',
			output_text: 'Output Text V1',
			accept_text: 'Acceptance Criteria V1',
			edge_ids_json: '[]',
			task_paths_json: '[]',
			contract_hash: 'hash-v2-scope-updated',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1.5,
			batch_id: 'batch-1',
			impl_prompt: 'Implementation Prompt V1',
			review_prompt: 'Review Prompt V1',
			is_removed_from_doc: 0,
		});

		// t-3 disappeared from new document (activeTaskKeys only contains M1-T1 and M1-T2)
		const banner = snapshotsRepo.refreshDocDiff('doc-1', ['M1-T1', 'M1-T2']);

		expect(banner.hasChanges).toBe(true);
		expect(banner.affectedTaskCount).toBe(3);
		expect(banner.acceptChangedCount).toBe(1); // t-1
		expect(banner.promptChangedCount).toBe(1); // t-2 (contract hash changed!)
		expect(banner.removedTaskCount).toBe(1); // t-3

		// Verify database rows updated in tasks table
		const rowT1 = tasksRepo.findById('t-1');
		expect(rowT1?.has_accept_changed).toBe(1);
		expect(rowT1?.has_prompt_changed).toBe(0);
		expect(rowT1?.is_removed_from_doc).toBe(0);

		const rowT2 = tasksRepo.findById('t-2');
		expect(rowT2?.has_accept_changed).toBe(0);
		expect(rowT2?.has_prompt_changed).toBe(1); // Prompt flag triggered by contract hash change!
		expect(rowT2?.is_removed_from_doc).toBe(0);

		const rowT3 = tasksRepo.findById('t-3');
		expect(rowT3?.is_removed_from_doc).toBe(1); // Marked removed!

		// Test getDocDiffBanner read-only retrieval
		const bannerReadonly = snapshotsRepo.getDocDiffBanner('doc-1');
		expect(bannerReadonly.affectedTaskCount).toBe(3);
	});

	it('AC 3 & E-18 & E-77: task disappearing while running is not terminated, not deleted, marked removed, and forbidden from re-dispatch', () => {
		setupTask({ id: 'task-active', task_key: 'M1-T99' });

		// Snapshot and start run
		const snap = snapshotsRepo.takeSnapshotForTask({
			taskId: 'task-active',
			launchSpecJson: '{}',
			createdAt: '2026-09-08T10:00:00.000Z',
		});

		// Insert an in-flight run
		const insertRunStmt = db.prepare(`
			INSERT INTO runs (
				id, task_id, attempt_no, kind, state, agent_id, permission_tier, snapshot_id, started_at
			) VALUES (
				'run-1', 'task-active', 1, 'implement', 'running', 'codex', 'workspaceWrite', ?, '2026-09-08T10:01:00.000Z'
			)
		`);
		insertRunStmt.run(snap.id);

		expect(snapshotsRepo.hasActiveRuns('task-active')).toBe(true);

		// Document is re-imported without M1-T99
		snapshotsRepo.refreshDocDiff('doc-1', []);

		// 1. Task record is NOT deleted, marked is_removed_from_doc = 1
		const task = tasksRepo.findById('task-active');
		expect(task).not.toBeNull();
		expect(task?.is_removed_from_doc).toBe(1);

		// 2. In-flight run is NOT deleted and NOT aborted/terminated
		const runRow = db.prepare('SELECT state FROM runs WHERE id = ?').get('run-1') as {
			state: string;
		};
		expect(runRow.state).toBe('running');

		// 3. Attempting to dispatch again is strictly forbidden (E-18, E-77)
		expect(() =>
			snapshotsRepo.takeSnapshotForTask({
				taskId: 'task-active',
				launchSpecJson: '{}',
				createdAt: '2026-09-08T12:00:00.000Z',
			}),
		).toThrowError(AppError);

		try {
			snapshotsRepo.takeSnapshotForTask({
				taskId: 'task-active',
				launchSpecJson: '{}',
				createdAt: '2026-09-08T12:00:00.000Z',
			});
		} catch (err) {
			expect((err as AppError).code).toBe('E_TASK_REMOVED_FROM_DOC');
		}
	});

	it('AC 4 & E-80: multiple dispatch rounds compare only against the latest snapshot while keeping history read-only', () => {
		setupTask({ id: 'task-multi', task_key: 'M2-T1', accept_text: 'Accept V1' });

		// Round 1 (attempt 1)
		const snap1 = snapshotsRepo.takeSnapshotForTask({
			taskId: 'task-multi',
			launchSpecJson: '{"attempt":1}',
			createdAt: '2026-09-08T09:00:00.000Z',
			snapshotId: 'snap-round-1',
		});

		// Task updated in doc to V2, and re-dispatched in Round 2 (attempt 2)
		tasksRepo.updateDocFields({
			id: 'task-multi',
			title: 'Task Multi',
			module_key: 'M2',
			deps_json: '[]',
			input_text: null,
			output_text: null,
			accept_text: 'Accept V2',
			edge_ids_json: '[]',
			task_paths_json: '[]',
			contract_hash: 'hash-v2',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1,
			batch_id: 'batch-1',
			impl_prompt: 'impl v2',
			review_prompt: 'review v2',
			is_removed_from_doc: 0,
		});

		const snap2 = snapshotsRepo.takeSnapshotForTask({
			taskId: 'task-multi',
			launchSpecJson: '{"attempt":2}',
			createdAt: '2026-09-08T11:00:00.000Z',
			snapshotId: 'snap-round-2',
		});

		// 1. findLatestByTaskId returns snap2
		const latest = snapshotsRepo.findLatestByTaskId('task-multi');
		expect(latest?.id).toBe('snap-round-2');
		expect(latest?.accept_text).toBe('Accept V2');

		// 2. listByTaskId returns both in reverse chronological order
		const history = snapshotsRepo.listByTaskId('task-multi');
		expect(history).toHaveLength(2);
		expect(history[0]?.id).toBe('snap-round-2');
		expect(history[1]?.id).toBe('snap-round-1');
		expect(history[1]?.accept_text).toBe('Accept V1'); // Untouched, read-only!

		// 3. Diff comparison compares against V2 (latest snapshot), so if current doc is still V2, hasAcceptChanged is FALSE
		const diff1 = snapshotsRepo.refreshDocDiff('doc-1', ['M2-T1']);
		const taskRow = tasksRepo.findById('task-multi');
		expect(taskRow?.has_accept_changed).toBe(0);
		expect(diff1.acceptChangedCount).toBe(0);

		// 4. If doc changes to V3, diff compares against V2 (latest)
		tasksRepo.updateDocFields({
			id: 'task-multi',
			title: 'Task Multi',
			module_key: 'M2',
			deps_json: '[]',
			input_text: null,
			output_text: null,
			accept_text: 'Accept V3 - New',
			edge_ids_json: '[]',
			task_paths_json: '[]',
			contract_hash: 'hash-v2',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1,
			batch_id: 'batch-1',
			impl_prompt: 'impl v2',
			review_prompt: 'review v2',
			is_removed_from_doc: 0,
		});

		const diff2 = snapshotsRepo.refreshDocDiff('doc-1', ['M2-T1']);
		expect(diff2.acceptChangedCount).toBe(1);
		const taskRowUpdated = tasksRepo.findById('task-multi');
		expect(taskRowUpdated?.has_accept_changed).toBe(1);

		// Comparison helper for E-78 side-by-side view shows snap2 vs V3
		const comparison = snapshotsRepo.getTaskAcceptanceComparison('task-multi');
		expect(comparison?.hasAcceptChanged).toBe(true);
		expect(comparison?.snapshotAcceptText).toBe('Accept V2');
		expect(comparison?.currentAcceptText).toBe('Accept V3 - New');
	});

	it('AC 5 & E-81: snapshot written at dispatch instant; simultaneous doc change performs post-hoc comparison without rolling back run', () => {
		setupTask({ id: 'task-collision', task_key: 'M3-T1', accept_text: 'Instant Accept V1' });

		// Dispatch moment: snapshot written with Instant Accept V1
		const snap = snapshotsRepo.takeSnapshotForTask({
			taskId: 'task-collision',
			launchSpecJson: '{"agent":"codex"}',
			createdAt: '2026-09-08T15:00:00.000Z',
		});

		// Run created and started
		const insertRunStmt = db.prepare(`
			INSERT INTO runs (
				id, task_id, attempt_no, kind, state, agent_id, permission_tier, snapshot_id, started_at
			) VALUES (
				'run-simultaneous', 'task-collision', 1, 'implement', 'running', 'codex', 'workspaceWrite', ?, '2026-09-08T15:00:01.000Z'
			)
		`);
		insertRunStmt.run(snap.id);

		// Simultaneous document regeneration modified the task in docs
		tasksRepo.updateDocFields({
			id: 'task-collision',
			title: 'Task Collision',
			module_key: 'M3',
			deps_json: '[]',
			input_text: null,
			output_text: null,
			accept_text: 'Regenerated Accept V2',
			edge_ids_json: '[]',
			task_paths_json: '[]',
			contract_hash: 'hash-v2',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 2,
			batch_id: 'batch-1',
			impl_prompt: 'impl v2',
			review_prompt: 'review v2',
			is_removed_from_doc: 0,
		});

		// Post-hoc diff comparison (事后补比对)
		const banner = snapshotsRepo.refreshDocDiff('doc-1', ['M3-T1']);
		expect(banner.hasChanges).toBe(true);
		expect(banner.acceptChangedCount).toBe(1);

		// Crucial assertion: the active run is NEVER rolled back or interrupted
		const activeRun = db.prepare('SELECT state FROM runs WHERE id = ?').get('run-simultaneous') as {
			state: string;
		};
		expect(activeRun.state).toBe('running');

		// And the snapshot remains what was read at dispatch instant
		const recordedSnapshot = snapshotsRepo.findById(snap.id);
		expect(recordedSnapshot?.accept_text).toBe('Instant Accept V1');
	});

	it('E-78: getTaskAcceptanceComparison provides side-by-side snapshot vs current doc texts', () => {
		setupTask({
			id: 'task-e78',
			task_key: 'M3-T2',
			accept_text: 'Current Document Acceptance Text',
			input_text: 'Current Input',
			output_text: 'Current Output',
		});

		// Manual insert of earlier snapshot
		snapshotsRepo.insert({
			id: 'snap-e78',
			task_id: 'task-e78',
			input_text: 'Snapshot Input',
			output_text: 'Snapshot Output',
			accept_text: 'Snapshot Acceptance Text',
			impl_prompt: 'impl',
			review_prompt: 'review',
			contract_hash: 'hash-1',
			task_paths_json: '[]',
			launch_spec_json: '{}',
			created_at: '2026-09-08T08:00:00.000Z',
		});

		const comparison = snapshotsRepo.getTaskAcceptanceComparison('task-e78');
		expect(comparison).not.toBeNull();
		expect(comparison?.taskId).toBe('task-e78');
		expect(comparison?.taskKey).toBe('M3-T2');
		expect(comparison?.hasAcceptChanged).toBe(true);
		expect(comparison?.snapshotAcceptText).toBe('Snapshot Acceptance Text');
		expect(comparison?.currentAcceptText).toBe('Current Document Acceptance Text');
		expect(comparison?.snapshotInputText).toBe('Snapshot Input');
		expect(comparison?.currentInputText).toBe('Current Input');
		expect(comparison?.snapshotOutputText).toBe('Snapshot Output');
		expect(comparison?.currentOutputText).toBe('Current Output');

		// Returns null for non-existent task
		expect(snapshotsRepo.getTaskAcceptanceComparison('unknown-task')).toBeNull();
	});

	it('handles non-existent snapshot and task queries gracefully', () => {
		expect(snapshotsRepo.findById('non-existent')).toBeNull();
		expect(snapshotsRepo.findLatestByTaskId('non-existent')).toBeNull();
		expect(snapshotsRepo.listByTaskId('non-existent')).toEqual([]);
		expect(snapshotsRepo.hasActiveRuns('non-existent')).toBe(false);

		expect(() =>
			snapshotsRepo.takeSnapshotForTask({
				taskId: 'unknown-task-id',
				launchSpecJson: '{}',
				createdAt: '2026-09-08T00:00:00.000Z',
			}),
		).toThrowError(/Task not found: unknown-task-id/);
	});
});
