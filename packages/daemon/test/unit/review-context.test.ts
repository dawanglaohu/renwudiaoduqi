import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import type { DatabaseConnection } from '../../src/db/open-database.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { type EventBus, createEventBus } from '../../src/events/bus.ts';
import { type EnvelopeFactory, createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import { type BatchesRepo, createBatchesRepo } from '../../src/repo/batches.ts';
import {
	type DispatchSnapshotsRepo,
	createDispatchSnapshotsRepo,
} from '../../src/repo/dispatch-snapshots.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../../src/repo/documents.ts';
import { type TasksRepo, createTasksRepo } from '../../src/repo/tasks.ts';
import { createReviewContextService, getReviewContext } from '../../src/service/review-context.ts';

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
	const dir = mkdtempSync(join(tmpdir(), 'agent-scheduler-review-ctx-test-'));
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
		imported_at: '2026-09-08T00:00:00.000Z',
		last_seen_at: '2026-09-08T00:00:00.000Z',
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
		started_at: '2026-09-08T00:00:00.000Z',
	});
}

describe('M3-T5 review-context service and getReviewContext', () => {
	let db: DatabaseConnection;
	let tasksRepo: TasksRepo;
	let snapshotsRepo: DispatchSnapshotsRepo;
	let batchesRepo: BatchesRepo;
	let docsRepo: DocumentsRepo;

	beforeEach(() => {
		db = createTestDatabase();
		tasksRepo = createTasksRepo(db);
		snapshotsRepo = createDispatchSnapshotsRepo(db);
		batchesRepo = createBatchesRepo(db);
		docsRepo = createDocumentsRepo(db);

		insertMockDocument(db, 'doc-1');
		insertMockBatch(db, 'doc-1', 1, 'batch-1', 'running');
	});

	function setupTask(overrides: Partial<Parameters<TasksRepo['insert']>[0]> = {}) {
		const task = {
			id: overrides.id ?? 'task-1',
			doc_id: 'doc-1',
			task_key: overrides.task_key ?? 'M3-T5',
			title: 'Review Context Interface',
			module_key: 'M3',
			deps_json: '[]',
			input_text: overrides.input_text ?? 'Input Text Doc V1',
			output_text: overrides.output_text ?? 'Output Text Doc V1',
			accept_text: overrides.accept_text ?? 'Acceptance Criteria Doc V1',
			edge_ids_json: '["E-50"]',
			task_paths_json: '["packages/daemon/src/service/review-context.ts"]',
			contract_hash: overrides.contract_hash ?? 'hash-v1',
			is_contract_ready: overrides.is_contract_ready ?? 1,
			contract_reasons_json: overrides.contract_reasons_json ?? '[]',
			est_days: 1.0,
			batch_id: 'batch-1',
			impl_prompt: overrides.impl_prompt ?? 'Implement Prompt Doc V1',
			review_prompt: overrides.review_prompt ?? 'Review Prompt Doc V1',
			is_removed_from_doc: overrides.is_removed_from_doc ?? 0,
			has_accept_changed: overrides.has_accept_changed ?? 0,
			has_prompt_changed: overrides.has_prompt_changed ?? 0,
			manual_state: null,
		};
		tasksRepo.insert(task);
		return task;
	}

	it('AC 1: returns reviewPrompt, contractHash, and dispatch snapshot acceptText, NOT current document values', () => {
		setupTask();

		// Dispatch snapshot is taken with V1 content
		const snapshot = snapshotsRepo.takeSnapshotForTask({
			taskId: 'task-1',
			launchSpecJson: JSON.stringify({ agentId: 'codex', permissionTier: 'readOnly' }),
			createdAt: '2026-09-08T10:00:00.000Z',
			snapshotId: 'snap-1',
		});

		const service = createReviewContextService({
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			batchesRepo,
			documentsRepo: docsRepo,
		});

		// 1. Initial review context before any doc change
		const initialContext = service.getReviewContext('task-1');
		expect(initialContext.taskId).toBe('task-1');
		expect(initialContext.taskKey).toBe('M3-T5');
		expect(initialContext.snapshotId).toBe('snap-1');
		expect(initialContext.reviewPrompt).toBe('Review Prompt Doc V1');
		expect(initialContext.contractHash).toBe('hash-v1');
		expect(initialContext.acceptText).toBe('Acceptance Criteria Doc V1');
		expect(initialContext.inputText).toBe('Input Text Doc V1');
		expect(initialContext.outputText).toBe('Output Text Doc V1');
		expect(initialContext.taskPaths).toEqual(['packages/daemon/src/service/review-context.ts']);
		expect(initialContext.isSnapshot).toBe(true);
		expect(initialContext.isReadOnly).toBe(true);
		expect(initialContext.docChangedSinceDispatch).toBe(false);

		// 2. Document is now modified: new accept criteria, new review prompt, new contract hash
		tasksRepo.updateDocFields({
			id: 'task-1',
			title: 'Review Context Interface Updated',
			module_key: 'M3',
			deps_json: '[]',
			input_text: 'Input Text Doc V2',
			output_text: 'Output Text Doc V2',
			accept_text: 'Acceptance Criteria Doc V2 - MODIFIED',
			edge_ids_json: '["E-50"]',
			task_paths_json: '["packages/daemon/src/service/review-context.ts"]',
			contract_hash: 'hash-v2-MODIFIED',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1.0,
			batch_id: 'batch-1',
			impl_prompt: 'Implement Prompt Doc V2',
			review_prompt: 'Review Prompt Doc V2 - MODIFIED',
			is_removed_from_doc: 0,
		});

		// Verify task table actually has the modified fields
		const taskInDb = tasksRepo.findById('task-1');
		expect(taskInDb?.accept_text).toBe('Acceptance Criteria Doc V2 - MODIFIED');
		expect(taskInDb?.contract_hash).toBe('hash-v2-MODIFIED');
		expect(taskInDb?.review_prompt).toBe('Review Prompt Doc V2 - MODIFIED');

		// 3. AC 1 Assertion: getReviewContext STILL returns the dispatch snapshot's data!
		const contextAfterDocChange = service.getReviewContext('task-1');
		expect(contextAfterDocChange.acceptText).toBe('Acceptance Criteria Doc V1');
		expect(contextAfterDocChange.contractHash).toBe('hash-v1');
		expect(contextAfterDocChange.reviewPrompt).toBe('Review Prompt Doc V1');
		expect(contextAfterDocChange.inputText).toBe('Input Text Doc V1');
		expect(contextAfterDocChange.outputText).toBe('Output Text Doc V1');
		expect(contextAfterDocChange.docChangedSinceDispatch).toBe(true);
		expect(contextAfterDocChange.isReadOnly).toBe(true);
		expect(contextAfterDocChange.isSnapshot).toBe(true);
	});

	it('AC 2: throws E_NOT_FOUND when dispatch snapshot is missing and never falls back to current document', () => {
		// Task exists in tasks table with valid fields
		setupTask({
			id: 'task-no-snap',
			task_key: 'M3-T99',
			accept_text: 'Acceptance Criteria in Document',
			review_prompt: 'Review Prompt in Document',
			contract_hash: 'hash-doc-only',
		});

		const service = createReviewContextService({
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
		});

		// Verify task exists in DB
		const taskInDb = tasksRepo.findById('task-no-snap');
		expect(taskInDb).not.toBeNull();
		expect(taskInDb?.accept_text).toBe('Acceptance Criteria in Document');

		// Snapshot does NOT exist in dispatch_snapshots table
		const snap = snapshotsRepo.findLatestByTaskId('task-no-snap');
		expect(snap).toBeNull();

		// AC 2 Assertion: must throw E_NOT_FOUND, NOT fall back to reading from task table!
		expect(() => service.getReviewContext('task-no-snap')).toThrowError(AppError);
		try {
			service.getReviewContext('task-no-snap');
		} catch (error) {
			expect(error).toBeInstanceOf(AppError);
			const appError = error as AppError;
			expect(appError.code).toBe('E_NOT_FOUND');
			expect(appError.message).toContain('Dispatch snapshot missing');
		}

		// Non-existent task also throws E_NOT_FOUND
		expect(() => service.getReviewContext('completely-nonexistent-task')).toThrowError(AppError);
	});

	it('AC 3 & E-50: when document fingerprint/contractHash changes during batch execution, in-flight tasks continue with snapshot and subsequent dispatches are paused', () => {
		setupTask({ id: 'task-inflight', task_key: 'M3-T1' });
		setupTask({ id: 'task-pending', task_key: 'M3-T2' });

		// 1. Task 1 is dispatched and has an active in-flight run
		const snap1 = snapshotsRepo.takeSnapshotForTask({
			taskId: 'task-inflight',
			launchSpecJson: '{"agentId":"codex"}',
			createdAt: '2026-09-08T11:00:00.000Z',
			snapshotId: 'snap-inflight',
		});

		const insertRunStmt = db.prepare(`
			INSERT INTO runs (
				id, task_id, attempt_no, kind, state, agent_id, permission_tier, snapshot_id, started_at
			) VALUES (
				'run-inflight-1', 'task-inflight', 1, 'implement', 'running', 'codex', 'workspaceWrite', ?, '2026-09-08T11:00:01.000Z'
			)
		`);
		insertRunStmt.run(snap1.id);

		// Verify batch is currently running
		const batchBefore = batchesRepo.findById('batch-1');
		expect(batchBefore?.state).toBe('running');

		const service = createReviewContextService({
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			batchesRepo,
			documentsRepo: docsRepo,
		});

		// Verify task-inflight has active runs
		expect(snapshotsRepo.hasActiveRuns('task-inflight')).toBe(true);

		// 2. Document changes mid-flight: task contractHash changed and doc fingerprint changed
		tasksRepo.updateDocFields({
			id: 'task-inflight',
			title: 'Inflight Changed In Doc',
			module_key: 'M3',
			deps_json: '[]',
			input_text: 'New Input',
			output_text: 'New Output',
			accept_text: 'New Acceptance Standard After Regeneration',
			edge_ids_json: '["E-50"]',
			task_paths_json: '[]',
			contract_hash: 'hash-v2-changed',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1.0,
			batch_id: 'batch-1',
			impl_prompt: 'New Impl',
			review_prompt: 'New Review Prompt',
			is_removed_from_doc: 0,
		});

		// Trigger handleDocFingerprintChange (E-50)
		const changeResult = service.handleDocFingerprintChange({
			docId: 'doc-1',
			newFingerprint: 'fp-new-updated',
			reason: 'doc_regenerated_mid_batch',
		});

		// 3. Verify batch was automatically transitioned from 'running' to 'paused'
		expect(changeResult.hasPausedBatches).toBe(true);
		expect(changeResult.pausedBatchIds).toContain('batch-1');
		expect(changeResult.inFlightTaskIds).toContain('task-inflight');

		const batchAfter = batchesRepo.findById('batch-1');
		expect(batchAfter?.state).toBe('paused');
		expect(batchAfter?.started_at).toBe('2026-09-08T00:00:00.000Z');
		expect(service.isBatchPaused('batch-1')).toBe(true);

		// 4. AC 3 & E-50: In-flight task is NOT hot-reloaded and continues with original snapshot
		const inflightContext = service.getReviewContext('task-inflight');
		expect(inflightContext.acceptText).toBe('Acceptance Criteria Doc V1');
		expect(inflightContext.contractHash).toBe('hash-v1');
		expect(inflightContext.reviewPrompt).toBe('Review Prompt Doc V1');
		expect(inflightContext.docChangedSinceDispatch).toBe(true);

		// 5. AC 3 & E-50: Subsequent task dispatches cannot proceed while batch is paused
		expect(service.isBatchPaused('batch-1')).toBe(true);

		// 6. AC 3 & E-50: Human confirms document changes and resumes batch
		const resumedBatch = service.confirmDocChangeAndResumeBatch('batch-1');
		expect(resumedBatch.state).toBe('running');
		expect(resumedBatch.started_at).toBe('2026-09-08T00:00:00.000Z');
		expect(service.isBatchPaused('batch-1')).toBe(false);

		// Attempting to resume a non-paused batch throws E_INVALID_STATE_TRANSITION
		expect(() => service.confirmDocChangeAndResumeBatch('batch-1')).toThrowError(AppError);
	});

	it('E-80: handles multiple dispatch rounds by defaulting to latest snapshot while allowing query by snapshotId', () => {
		setupTask({ id: 'task-multi' });

		// Round 1 dispatch
		const snapRound1 = snapshotsRepo.takeSnapshotForTask({
			taskId: 'task-multi',
			launchSpecJson: '{"round":1}',
			createdAt: '2026-09-08T09:00:00.000Z',
			snapshotId: 'snap-round-1',
		});

		// Modify task in doc before round 2 dispatch
		tasksRepo.updateDocFields({
			id: 'task-multi',
			title: 'Task Multi Round 2',
			module_key: 'M3',
			deps_json: '[]',
			input_text: 'Input R2',
			output_text: 'Output R2',
			accept_text: 'Accept Criteria Round 2',
			edge_ids_json: '[]',
			task_paths_json: '[]',
			contract_hash: 'hash-round-2',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1.0,
			batch_id: 'batch-1',
			impl_prompt: 'Impl R2',
			review_prompt: 'Review Prompt Round 2',
			is_removed_from_doc: 0,
		});

		// Round 2 dispatch (E-80)
		const snapRound2 = snapshotsRepo.takeSnapshotForTask({
			taskId: 'task-multi',
			launchSpecJson: '{"round":2}',
			createdAt: '2026-09-08T12:00:00.000Z',
			snapshotId: 'snap-round-2',
		});

		const service = createReviewContextService({
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
		});

		// 1. Default query returns latest snapshot (snapRound2)
		const latestCtx = service.getReviewContext('task-multi');
		expect(latestCtx.snapshotId).toBe('snap-round-2');
		expect(latestCtx.acceptText).toBe('Accept Criteria Round 2');
		expect(latestCtx.contractHash).toBe('hash-round-2');
		expect(latestCtx.reviewPrompt).toBe('Review Prompt Round 2');

		// 2. Query with specific snapshotId returns round 1 snapshot
		const r1Ctx = service.getReviewContext('task-multi', { snapshotId: 'snap-round-1' });
		expect(r1Ctx.snapshotId).toBe('snap-round-1');
		expect(r1Ctx.acceptText).toBe('Acceptance Criteria Doc V1');
		expect(r1Ctx.contractHash).toBe('hash-v1');
		expect(r1Ctx.reviewPrompt).toBe('Review Prompt Doc V1');

		// 3. Query with non-existent snapshotId throws E_NOT_FOUND
		expect(() =>
			service.getReviewContext('task-multi', { snapshotId: 'non-existent-snap' }),
		).toThrowError(AppError);
	});

	it('E-77 & E-18: in-flight task removed from doc still retrieves snapshot review context to finish review', () => {
		setupTask({ id: 'task-removed', task_key: 'M3-T-REMOVED' });

		snapshotsRepo.takeSnapshotForTask({
			taskId: 'task-removed',
			launchSpecJson: '{"agent":"codex"}',
			createdAt: '2026-09-08T08:00:00.000Z',
			snapshotId: 'snap-removed',
		});

		// Task disappeared from document, marked removed from doc
		snapshotsRepo.updateTaskChangedFlags('task-removed', {
			hasAcceptChanged: false,
			hasPromptChanged: false,
			isRemovedFromDoc: true,
		});

		const service = createReviewContextService({
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
		});

		// AC 1 & E-77: Can still obtain review context from snapshot!
		const ctx = service.getReviewContext('task-removed');
		expect(ctx.snapshotId).toBe('snap-removed');
		expect(ctx.acceptText).toBe('Acceptance Criteria Doc V1');
		expect(ctx.docChangedSinceDispatch).toBe(true);
	});

	it('supports taskKey lookup as well as task UUID lookup', () => {
		setupTask({ id: 'uuid-1234', task_key: 'M3-T5' });

		snapshotsRepo.takeSnapshotForTask({
			taskId: 'uuid-1234',
			launchSpecJson: '{"agent":"codex"}',
			createdAt: '2026-09-08T08:00:00.000Z',
			snapshotId: 'snap-uuid',
		});

		const service = createReviewContextService({
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			documentsRepo: docsRepo,
		});

		// Lookup by UUID
		const byUuid = service.getReviewContext('uuid-1234');
		expect(byUuid.snapshotId).toBe('snap-uuid');
		expect(byUuid.taskKey).toBe('M3-T5');

		// Lookup by taskKey ('M3-T5')
		const byKey = service.getReviewContext('M3-T5');
		expect(byKey.snapshotId).toBe('snap-uuid');
		expect(byKey.taskId).toBe('uuid-1234');
	});

	it('validates taskId input format', () => {
		const service = createReviewContextService({
			dispatchSnapshotsRepo: snapshotsRepo,
		});

		// @ts-expect-error test runtime validation
		expect(() => service.getReviewContext(null)).toThrowError(AppError);
		expect(() => service.getReviewContext('')).toThrowError(AppError);
		expect(() => service.getReviewContext('   ')).toThrowError(AppError);
	});

	it('subscribes to system.docs_changed on event bus and pauses running batches', () => {
		const ringBuffer = createRingBuffer();
		const bus: EventBus = createEventBus({ ringBuffer });
		let seq = 1;
		const envelopeFactory: EnvelopeFactory = createEnvelopeFactory({
			clock: { now: () => '2026-09-08T12:00:00.000Z' },
			idAllocator: { allocate: () => seq++ },
		});

		const service = createReviewContextService({
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
			batchesRepo,
			documentsRepo: docsRepo,
			bus,
			envelopeFactory,
		});

		expect(batchesRepo.findById('batch-1')?.state).toBe('running');

		// Publish system.docs_changed event for /data/doc-1/docs-data.js
		bus.publish(
			envelopeFactory.createEnvelope({
				kind: 'system.docs_changed',
				payload: {
					docsPath: '/data/doc-1/docs-data.js',
					fingerprint: 'fp-new-via-bus',
				},
			}),
		);

		// Running batch for doc-1 should now be paused (E-50)
		expect(batchesRepo.findById('batch-1')?.state).toBe('paused');
		expect(service.isBatchPaused('batch-1')).toBe(true);

		service.dispose();
	});

	it('standalone getReviewContext export function produces identical results', () => {
		setupTask({ id: 'task-standalone', task_key: 'M3-T-STANDALONE' });

		snapshotsRepo.takeSnapshotForTask({
			taskId: 'task-standalone',
			launchSpecJson: '{"agent":"codex"}',
			createdAt: '2026-09-08T08:00:00.000Z',
			snapshotId: 'snap-standalone',
		});

		const ctx = getReviewContext('task-standalone', {
			dispatchSnapshotsRepo: snapshotsRepo,
			tasksRepo,
		});

		expect(ctx.snapshotId).toBe('snap-standalone');
		expect(ctx.acceptText).toBe('Acceptance Criteria Doc V1');
		expect(ctx.reviewPrompt).toBe('Review Prompt Doc V1');
		expect(ctx.isReadOnly).toBe(true);
	});
});
