import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { errorHandlerPlugin } from '../../src/http/plugins/90-error-handler.ts';
import { registerBatchesRoutes } from '../../src/http/routes/batches.ts';
import { registerDispatchRunsRoutes } from '../../src/http/routes/runs.ts';
import { registerSnapshotRoute } from '../../src/http/routes/snapshot.ts';
import { createHttpServer } from '../../src/http/server.ts';
import { createSchedulerTickJob } from '../../src/jobs/scheduler-tick.ts';
import type {
	LockFileHandle,
	NativeLockAdapter,
	NativeLockFailure,
	NativeLockReadResult,
	NativeLockWriteResult,
} from '../../src/platform/lock-contract.ts';
import { type BatchesRepo, createBatchesRepo } from '../../src/repo/batches.ts';
import {
	type DispatchSnapshotsRepo,
	createDispatchSnapshotsRepo,
} from '../../src/repo/dispatch-snapshots.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../../src/repo/documents.ts';
import { type EventSeqRepo, createEventSeqRepo } from '../../src/repo/event-seq-repo.ts';
import { type RunsRepo, createRunsRepo } from '../../src/repo/runs.ts';
import { type TasksRepo, createTasksRepo } from '../../src/repo/tasks.ts';
import type { DispatchService } from '../../src/service/dispatch.ts';
import { createDispatchService } from '../../src/service/dispatch.ts';
import type { PairingService } from '../../src/service/pairing.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(currentDir, '../../migrations');

function setupTestDatabase(): DatabaseConnection {
	const db = openDatabase(':memory:');
	const migrationFiles = readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort();

	const runner = createMigrationRunner({
		clock: { now: () => '2026-09-15T00:00:00.000Z' },
		database: db,
		fileSystem: {
			readDirectory: () => migrationFiles,
			readFile: (p: string) => readFileSync(p, 'utf8'),
		},
	});
	runner.run(migrationsDir);
	return db;
}

describe('M8-T3 Dispatch & Batch Progression Contract', () => {
	let db: DatabaseConnection;
	let documentsRepo: DocumentsRepo;
	let batchesRepo: BatchesRepo;
	let tasksRepo: TasksRepo;
	let dispatchSnapshotsRepo: DispatchSnapshotsRepo;
	let runsRepo: RunsRepo;
	let eventSeqRepo: EventSeqRepo;
	let dispatchService: DispatchService;
	let testTime = '2026-09-15T10:00:00.000Z';

	const clock = {
		now: () => testTime,
	};
	let idCounter = 1;
	const ids = {
		newId: () => `id_${idCounter++}`,
	};

	beforeEach(() => {
		idCounter = 1;
		testTime = '2026-09-15T10:00:00.000Z';
		db = setupTestDatabase();
		documentsRepo = createDocumentsRepo(db);
		batchesRepo = createBatchesRepo(db);
		tasksRepo = createTasksRepo(db);
		dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		runsRepo = createRunsRepo(db);
		eventSeqRepo = createEventSeqRepo(db);

		// Seed initial document
		documentsRepo.insert({
			id: 'doc-1',
			docs_path: '/abs/path/docs',
			project_name: 'test-project',
			repo_path: '/abs/path/repo',
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: 'fp-initial-123',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: testTime,
			last_seen_at: testTime,
		});

		dispatchService = createDispatchService({
			tasksRepo,
			batchesRepo,
			documentsRepo,
			dispatchSnapshotsRepo,
			runsRepo,
			eventSeqRepo,
			clock,
			ids,
			agentLimits: 2,
			listDispatchableAgents: () => [{ agentId: 'codex', canDispatch: true, concurrencyLimit: 2 }],
		});
	});

	afterEach(() => {
		db.close();
	});

	function seedBatch(input: {
		readonly id: string;
		readonly batchNo: number;
		readonly state?: 'idle' | 'running' | 'paused' | 'done';
		readonly docId?: string;
	}) {
		batchesRepo.insert({
			id: input.id,
			doc_id: input.docId ?? 'doc-1',
			batch_no: input.batchNo,
			state: input.state ?? 'idle',
			started_at: input.state === 'running' || input.state === 'done' ? testTime : null,
			finished_at: input.state === 'done' ? testTime : null,
		});
	}

	function seedTask(input: {
		readonly id: string;
		readonly taskKey: string;
		readonly batchId: string;
		readonly deps?: readonly string[];
		readonly isContractReady?: number;
		readonly contractReasons?: readonly string[];
		readonly taskPaths?: readonly string[];
		readonly hasAcceptChanged?: number;
		readonly hasPromptChanged?: number;
		readonly isRemovedFromDoc?: number;
		readonly manualState?: string | null;
	}) {
		tasksRepo.insert({
			id: input.id,
			doc_id: 'doc-1',
			task_key: input.taskKey,
			title: `Task ${input.taskKey}`,
			module_key: 'M8',
			deps_json: JSON.stringify(input.deps ?? []),
			contract_hash: `hash_${input.taskKey}`,
			is_contract_ready: input.isContractReady ?? 1,
			contract_reasons_json: JSON.stringify(input.contractReasons ?? []),
			batch_id: input.batchId,
			task_paths_json: JSON.stringify(input.taskPaths ?? [`src/${input.taskKey}.ts`]),
			has_accept_changed: input.hasAcceptChanged ?? 0,
			has_prompt_changed: input.hasPromptChanged ?? 0,
			is_removed_from_doc: input.isRemovedFromDoc ?? 0,
			manual_state: input.manualState ?? null,
		});
	}

	function seedSnapshot(taskId: string): string {
		const id = `snap_${idCounter++}`;
		dispatchSnapshotsRepo.insert({
			id,
			task_id: taskId,
			contract_hash: 'hash-test',
			task_paths_json: '[]',
			launch_spec_json: '{}',
			created_at: testTime,
		});
		return id;
	}

	describe('AC 1: scheduler-tick job mutual exclusion & non-reentrancy', () => {
		it('prohibits concurrent ticks and re-entrancy, ensuring task is not dispatched twice', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({ id: 'task-1', taskKey: 'T1', batchId: 'batch-1' });

			const job = createSchedulerTickJob({
				dispatchService,
				intervalMs: 10000,
			});

			// Fire two ticks simultaneously
			const [res1, res2] = await Promise.all([job.tick(), job.tick()]);

			// One tick executes, the other is skipped due to mutual exclusion
			const executedCount = (res1 !== null ? 1 : 0) + (res2 !== null ? 1 : 0);
			expect(executedCount).toBe(1);

			// The task should only have been dispatched once
			const runs = runsRepo.listByTaskId('task-1');
			expect(runs.length).toBe(1);
		});

		it('service-level mutex returns concurrency_locked when tick is re-entered', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({ id: 'task-1', taskKey: 'T1', batchId: 'batch-1' });

			const p1 = dispatchService.tick();
			const p2 = dispatchService.tick();

			const [r1, r2] = await Promise.all([p1, p2]);
			expect(r1.executed !== r2.executed).toBe(true);

			const locked = !r1.executed ? r1 : r2;
			expect(locked.executed).toBe(false);
			expect(locked.reason).toBe('concurrency_locked');
		});
	});

	describe('AC 2 & E-126: Idempotent dispatch and duplicate prevention', () => {
		it('returns existing run with same ID and idempotency key when called multiple times (E-126)', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({ id: 'task-1', taskKey: 'T1', batchId: 'batch-1' });

			const first = await dispatchService.createRun({
				taskId: 'task-1',
				agentId: 'codex',
				idempotencyKey: 'idemp-test-key-1',
			});

			expect(first.isExisting).toBe(false);
			expect(first.run.id).toBeDefined();
			expect(first.run.idempotencyKey).toBe('idemp-test-key-1');

			// Second click from another device or retry with same key
			const second = await dispatchService.createRun({
				taskId: 'task-1',
				agentId: 'codex',
				idempotencyKey: 'idemp-test-key-1',
			});

			expect(second.isExisting).toBe(true);
			expect(second.run.id).toBe(first.run.id);
			expect(second.run.idempotencyKey).toBe('idemp-test-key-1');

			// Confirm only one run exists in database
			const allRuns = runsRepo.listByTaskId('task-1');
			expect(allRuns.length).toBe(1);
		});

		it('returns existing active run if another device attempts dispatch on an already-running task (E-126)', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({ id: 'task-1', taskKey: 'T1', batchId: 'batch-1' });

			const first = await dispatchService.createRun({
				taskId: 'task-1',
				agentId: 'codex',
				idempotencyKey: 'device-a-click',
			});

			expect(first.isExisting).toBe(false);

			// Device B clicks dispatch on the same task with a different key while task is active
			const second = await dispatchService.createRun({
				taskId: 'task-1',
				agentId: 'codex',
				idempotencyKey: 'device-b-click',
			});

			expect(second.isExisting).toBe(true);
			expect(second.run.id).toBe(first.run.id);

			const allRuns = runsRepo.listByTaskId('task-1');
			expect(allRuns.length).toBe(1);
		});

		it('keeps an ordinary awaiting_human review gate parked when another dispatch is requested', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({ id: 'task-1', taskKey: 'T1', batchId: 'batch-1' });
			const snapshotId = seedSnapshot('task-1');
			runsRepo.insert({
				id: 'waiting-for-review',
				task_id: 'task-1',
				attempt_no: 1,
				kind: 'implement',
				state: 'awaiting_human',
				queued_reason: 'review_gate_waiting',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: snapshotId,
			});

			const result = await dispatchService.createRun({
				taskId: 'task-1',
				agentId: 'codex',
				idempotencyKey: 'new-dispatch-on-waiting',
			});

			expect(result.isExisting).toBe(true);
			expect(result.run.id).toBe('waiting-for-review');
			expect(runsRepo.listByTaskId('task-1')).toHaveLength(1);
		});
	});

	describe('AC 3, E-49 & E-281: Batch progression, failure isolation & previous batch checks', () => {
		it('E-49: failure of a task does not block independent tasks in the same batch from running', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			// Task A (failed)
			seedTask({ id: 'task-a', taskKey: 'TA', batchId: 'batch-1' });
			// Task B (independent of Task A)
			seedTask({ id: 'task-b', taskKey: 'TB', batchId: 'batch-1' });
			// Task C (depends on Task A)
			seedTask({ id: 'task-c', taskKey: 'TC', batchId: 'batch-1', deps: ['TA'] });

			// Simulate Task A previously ran and failed
			const snapA = seedSnapshot('task-a');
			runsRepo.insert({
				id: 'run-a',
				task_id: 'task-a',
				attempt_no: 1,
				kind: 'implement',
				state: 'failed',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: snapA,
			});

			// Run scheduler tick
			const tickResult = await dispatchService.tick();
			expect(tickResult.executed).toBe(true);

			// Task B is independent, so it is dispatched! (E-49)
			const runsB = runsRepo.listByTaskId('task-b');
			expect(runsB.length).toBe(1);

			// Task C depends on Task A (which failed, not landed), so it is not dispatched
			const runsC = runsRepo.listByTaskId('task-c');
			expect(runsC.length).toBe(0);

			// Batch 1 should NOT be marked done because not all tasks landed
			const b1 = batchesRepo.findById('batch-1');
			expect(b1?.state).toBe('running');
		});

		it('E-281 & AC 3: starting next batch when previous batch is not done returns E_VALIDATION with previousBatchState', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedBatch({ id: 'batch-2', batchNo: 2, state: 'idle' });
			seedTask({ id: 'task-1', taskKey: 'T1', batchId: 'batch-1' });

			// Attempt to start batch-2 while batch-1 is running
			await expect(dispatchService.startBatch({ batchId: 'batch-2' })).rejects.toMatchObject({
				code: 'E_VALIDATION',
				details: {
					previousBatchState: 'running',
					previousBatchNo: 1,
					currentBatchNo: 2,
				},
			});

			// When previous batch is paused, also returns previousBatchState
			batchesRepo.updateState({ id: 'batch-1', state: 'paused' });
			await expect(dispatchService.startBatch({ batchId: 'batch-2' })).rejects.toMatchObject({
				code: 'E_VALIDATION',
				details: {
					previousBatchState: 'paused',
				},
			});
		});

		it('starting next batch succeeds when previous batch is done and all tasks are landed', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'done' });
			seedBatch({ id: 'batch-2', batchNo: 2, state: 'idle' });
			seedTask({
				id: 'task-1',
				taskKey: 'T1',
				batchId: 'batch-1',
				manualState: 'landed',
			});
			seedTask({ id: 'task-2', taskKey: 'T2', batchId: 'batch-2' });

			const result = await dispatchService.startBatch({ batchId: 'batch-2' });
			expect(result.accepted).toBe(true);

			const b2 = batchesRepo.findById('batch-2');
			expect(b2?.state).toBe('running');
		});
	});

	describe('AC 4 & E-51: No automatic re-dispatch on restart or crash', () => {
		it('never automatically re-dispatches tasks whose runs ended in interrupted, orphaned, or failed', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({ id: 'task-interrupted', taskKey: 'TI', batchId: 'batch-1' });

			// Run was marked interrupted (e.g. after daemon restart process reconciliation, E-51)
			const snapDead = seedSnapshot('task-interrupted');
			runsRepo.insert({
				id: 'run-dead',
				task_id: 'task-interrupted',
				attempt_no: 1,
				kind: 'implement',
				state: 'interrupted',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: snapDead,
			});

			const tickResult = await dispatchService.tick();
			expect(tickResult.executed).toBe(true);

			// Under NO circumstances should scheduler-tick automatically create another run (E-51)
			const runs = runsRepo.listByTaskId('task-interrupted');
			expect(runs.length).toBe(1);
			expect(runs[0]?.state).toBe('interrupted');
		});

		it('manual rerun via rerunRun creates attempt 2 after human decision', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({ id: 'task-interrupted', taskKey: 'TI', batchId: 'batch-1' });

			const snapDead2 = seedSnapshot('task-interrupted');
			runsRepo.insert({
				id: 'run-dead',
				task_id: 'task-interrupted',
				attempt_no: 1,
				kind: 'implement',
				state: 'interrupted',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: snapDead2,
			});

			// Human initiates rerun
			const rerunRes = await dispatchService.rerunRun({
				runId: 'run-dead',
				idempotencyKey: 'manual-rerun-key-1',
			});

			expect(rerunRes.run.attemptNo).toBe(2);
			expect(rerunRes.run.state).toBe('starting');

			const allRuns = runsRepo.listByTaskId('task-interrupted');
			expect(allRuns.length).toBe(2);
		});
	});

	describe('AC 5, E-50 & E-82: Contract readiness enforcement & mid-batch doc change pausing', () => {
		it('blocks auto-dispatch and returns reasons when is_contract_ready is 0 (E-82)', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({
				id: 'task-unready',
				taskKey: 'TU',
				batchId: 'batch-1',
				isContractReady: 0,
				contractReasons: ['Missing acceptance criteria for AC3', 'Invalid path pattern'],
			});

			const tickResult = await dispatchService.tick();
			expect(tickResult.executed).toBe(true);

			// Unready task is not dispatched
			expect(runsRepo.listByTaskId('task-unready').length).toBe(0);
			expect(tickResult.tasksBlocked).toContainEqual({
				taskId: 'task-unready',
				reason: 'contract_not_ready',
			});
		});

		it('manual dispatch rejects is_contract_ready=0 with E_DOC_CONTRACT_PENDING and reasons (AC 5, E-50, E-82)', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({
				id: 'task-unready',
				taskKey: 'TU',
				batchId: 'batch-1',
				isContractReady: 0,
				contractReasons: ['Pending reviewer verification', 'Section 10 mismatch'],
			});

			await expect(
				dispatchService.createRun({
					taskId: 'task-unready',
					agentId: 'codex',
					idempotencyKey: 'manual-dispatch-attempt',
				}),
			).rejects.toMatchObject({
				code: 'E_DOC_CONTRACT_PENDING',
				details: {
					taskId: 'task-unready',
					reasons: ['Pending reviewer verification', 'Section 10 mismatch'],
				},
			});
		});

		it('rerunRun rejects is_contract_ready=0 with E_DOC_CONTRACT_PENDING (AC 5)', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({
				id: 'task-unready',
				taskKey: 'TU',
				batchId: 'batch-1',
				isContractReady: 0,
				contractReasons: ['Contract modified and unreviewed'],
			});

			const snapPrior = seedSnapshot('task-unready');
			runsRepo.insert({
				id: 'run-prior',
				task_id: 'task-unready',
				attempt_no: 1,
				kind: 'implement',
				state: 'failed',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: snapPrior,
			});

			await expect(
				dispatchService.rerunRun({
					runId: 'run-prior',
					idempotencyKey: 'rerun-attempt',
				}),
			).rejects.toMatchObject({
				code: 'E_DOC_CONTRACT_PENDING',
			});
		});

		it('pauses auto-dispatch when task has unconfirmed document changes (has_prompt_changed or has_accept_changed) (E-50)', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({
				id: 'task-doc-changed',
				taskKey: 'TDC',
				batchId: 'batch-1',
				hasPromptChanged: 1,
			});

			const tickResult = await dispatchService.tick();
			expect(tickResult.executed).toBe(true);

			// Automatically paused pending confirmation
			expect(runsRepo.listByTaskId('task-doc-changed').length).toBe(0);
			expect(tickResult.tasksBlocked).toContainEqual({
				taskId: 'task-doc-changed',
				reason: 'doc_changed_pending_confirmation',
			});
		});

		it('E-82: when document source is unreadable, freezes new dispatch and startBatch', async () => {
			documentsRepo.markSourceUnreadable('doc-1', testTime);

			seedBatch({ id: 'batch-1', batchNo: 1, state: 'idle' });
			seedTask({ id: 'task-1', taskKey: 'T1', batchId: 'batch-1' });

			// startBatch throws E_DOC_SOURCE_UNREADABLE
			await expect(dispatchService.startBatch({ batchId: 'batch-1' })).rejects.toMatchObject({
				code: 'E_DOC_SOURCE_UNREADABLE',
			});

			// createRun throws E_DOC_SOURCE_UNREADABLE
			await expect(
				dispatchService.createRun({
					taskId: 'task-1',
					agentId: 'codex',
					idempotencyKey: 'test-key',
				}),
			).rejects.toMatchObject({
				code: 'E_DOC_SOURCE_UNREADABLE',
			});
		});
	});

	describe('M8-T1 & M8-T2 Integration: Path Clash & Concurrency Window', () => {
		it('queues conflicting tasks using M8-T2 path clash queue and dispatches non-conflicting ones', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			// Task 1 and Task 2 touch overlapping paths
			seedTask({
				id: 'task-1',
				taskKey: 'T1',
				batchId: 'batch-1',
				taskPaths: ['packages/common/utils.ts'],
			});
			seedTask({
				id: 'task-2',
				taskKey: 'T2',
				batchId: 'batch-1',
				taskPaths: ['packages/common/utils.ts', 'packages/daemon/main.ts'],
			});

			// In-flight run exists for Task 1 holding path lock
			const snap1 = seedSnapshot('task-1');
			runsRepo.insert({
				id: 'run-1',
				task_id: 'task-1',
				attempt_no: 1,
				kind: 'implement',
				state: 'running',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: snap1,
			});

			const tickResult = await dispatchService.tick();
			expect(tickResult.executed).toBe(true);

			// Task 2 is blocked by Task 1's path lock
			expect(runsRepo.listByTaskId('task-2').length).toBe(0);
			expect(tickResult.tasksBlocked.some((b) => b.taskId === 'task-2')).toBe(true);
		});

		it('respects document lane count and allocates concurrency slots (M8-T1)', async () => {
			// lane_count is 2 (seeded in doc-1)
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({
				id: 'task-1',
				taskKey: 'T1',
				batchId: 'batch-1',
				taskPaths: ['path/a.ts'],
			});
			seedTask({
				id: 'task-2',
				taskKey: 'T2',
				batchId: 'batch-1',
				taskPaths: ['path/b.ts'],
			});
			seedTask({
				id: 'task-3',
				taskKey: 'T3',
				batchId: 'batch-1',
				taskPaths: ['path/c.ts'],
			});

			const tickResult = await dispatchService.tick();
			expect(tickResult.executed).toBe(true);

			// With lane_count = 2, exactly 2 tasks are admitted and dispatched, 1 deferred
			expect(tickResult.runsDispatched.length).toBe(2);
			expect(tickResult.tasksDeferred.length).toBe(1);
			expect(tickResult.tasksDeferred[0]?.reason).toBe('window_exhausted');
		});
	});

	describe('E-54 seam (M8-T3 ↔ M8-T11): agent concurrency counts only slot-holding states', () => {
		it('does not count awaiting_human runs against the per-agent limit', async () => {
			documentsRepo.updateLaneCount('doc-1', 6);
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({ id: 'task-h1', taskKey: 'H1', batchId: 'batch-1', taskPaths: ['path/h1.ts'] });
			seedTask({ id: 'task-h2', taskKey: 'H2', batchId: 'batch-1', taskPaths: ['path/h2.ts'] });
			seedTask({ id: 'task-n1', taskKey: 'N1', batchId: 'batch-1', taskPaths: ['path/n1.ts'] });
			seedTask({ id: 'task-n2', taskKey: 'N2', batchId: 'batch-1', taskPaths: ['path/n2.ts'] });
			for (const taskId of ['task-h1', 'task-h2']) {
				runsRepo.insert({
					id: `run-${taskId}`,
					task_id: taskId,
					attempt_no: 1,
					kind: 'implement',
					state: 'awaiting_human',
					agent_id: 'codex',
					permission_tier: 'workspaceWrite',
					snapshot_id: seedSnapshot(taskId),
				});
			}

			// agentLimits = 2：两条 awaiting_human 不占 codex 的额度（E-54），两个新任务都该派出去
			const tickResult = await dispatchService.tick();
			expect(tickResult.runsDispatched.length).toBe(2);
			expect(tickResult.tasksDeferred.filter((d) => d.reason === 'agent_limit_reached')).toEqual(
				[],
			);
		});
	});

	describe('HTTP Routes Integration (Fastify)', () => {
		let app: FastifyInstance;

		beforeEach(async () => {
			app = fastify();
			await errorHandlerPlugin(app, {});

			// Register routes
			registerDispatchRunsRoutes(app, { dispatchService });
			registerBatchesRoutes(app, { dispatchService });
			registerSnapshotRoute(app, { dispatchService });

			await app.ready();
		});

		afterEach(async () => {
			await app.close();
		});

		it('POST /api/v1/runs creates and dispatches a new run idempotently', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({ id: 'task-http-1', taskKey: 'TH1', batchId: 'batch-1' });

			const res1 = await app.inject({
				method: 'POST',
				url: '/api/v1/runs',
				payload: {
					taskId: 'task-http-1',
					agentId: 'codex',
					idempotencyKey: 'http-test-key-123',
				},
			});

			expect(res1.statusCode).toBe(200);
			const body1 = JSON.parse(res1.body);
			expect(body1.run).toBeDefined();
			expect(body1.run.taskId).toBe('task-http-1');
			expect(body1.run.idempotencyKey).toBe('http-test-key-123');

			// Second call with same idempotency key returns same run
			const res2 = await app.inject({
				method: 'POST',
				url: '/api/v1/runs',
				payload: {
					taskId: 'task-http-1',
					agentId: 'codex',
					idempotencyKey: 'http-test-key-123',
				},
			});

			expect(res2.statusCode).toBe(200);
			const body2 = JSON.parse(res2.body);
			expect(body2.run.id).toBe(body1.run.id);
		});

		it('POST /api/v1/runs returns 409 E_DOC_CONTRACT_PENDING when task contract is not ready', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({
				id: 'task-unready',
				taskKey: 'TU',
				batchId: 'batch-1',
				isContractReady: 0,
				contractReasons: ['Incomplete requirements'],
			});

			const res = await app.inject({
				method: 'POST',
				url: '/api/v1/runs',
				payload: {
					taskId: 'task-unready',
					agentId: 'codex',
					idempotencyKey: 'unready-test-key',
				},
			});

			expect(res.statusCode).toBe(409);
			const body = JSON.parse(res.body);
			expect(body.error.code).toBe('E_DOC_CONTRACT_PENDING');
			expect(body.error.details.reasons).toEqual(['Incomplete requirements']);
		});

		it('POST /api/v1/batches/:batchId/start and pause lifecycle', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'idle' });
			seedTask({ id: 'task-1', taskKey: 'T1', batchId: 'batch-1' });

			// Start batch
			const startRes = await app.inject({
				method: 'POST',
				url: '/api/v1/batches/batch-1/start',
				payload: {},
			});

			expect(startRes.statusCode).toBe(200);
			const startBody = JSON.parse(startRes.body);
			expect(startBody.accepted).toBe(true);

			// Pause batch
			const pauseRes = await app.inject({
				method: 'POST',
				url: '/api/v1/batches/batch-1/pause',
			});

			expect(pauseRes.statusCode).toBe(200);
			const pauseBody = JSON.parse(pauseRes.body);
			expect(pauseBody.paused).toBe(true);

			const batch = batchesRepo.findById('batch-1');
			expect(batch?.state).toBe('paused');
		});

		it('GET /api/v1/snapshot returns global state snapshot', async () => {
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({ id: 'task-1', taskKey: 'T1', batchId: 'batch-1' });

			const res = await app.inject({
				method: 'GET',
				url: '/api/v1/snapshot',
			});

			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.documents).toBeDefined();
			expect(body.batches).toBeDefined();
			expect(body.tasks).toBeDefined();
			expect(body.runs).toBeDefined();
			expect(body.agents).toBeDefined();
			expect(body.documents.length).toBeGreaterThan(0);
			expect(body.batches.length).toBeGreaterThan(0);
			expect(body.tasks.length).toBeGreaterThan(0);
		});
	});

	describe('R3: agent availability is required before auto-dispatch', () => {
		it('does not create a run when the registry has no dispatchable agent', async () => {
			dispatchService = createDispatchService({
				tasksRepo,
				batchesRepo,
				documentsRepo,
				dispatchSnapshotsRepo,
				runsRepo,
				eventSeqRepo,
				clock,
				ids,
				agentLimits: 2,
				listDispatchableAgents: () => [],
			});
			seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
			seedTask({ id: 'task-1', taskKey: 'T1', batchId: 'batch-1' });

			const tickResult = await dispatchService.tick();
			expect(tickResult.executed).toBe(true);
			expect(runsRepo.listByTaskId('task-1').length).toBe(0);
			expect(tickResult.tasksBlocked).toContainEqual({
				taskId: 'task-1',
				reason: 'agent_unavailable',
			});
		});
	});

	describe('R1: boot wiring through createContainer', () => {
		function createMemoryLockAdapter(): NativeLockAdapter {
			let lockContents: string | undefined;
			const missing = (): NativeLockFailure => ({
				kind: 'not-found',
				error: new AppError('E_INTERNAL', 'Memory lock is missing.'),
			});
			return Object.freeze({
				platform: 'linux',
				filePath: '/machine/daemon.lock',
				dirPath: '/machine',
				reclaimPath: '/machine/daemon.lock.reclaim',
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

		it('wires dispatch routes and scheduler-tick through createContainer', async () => {
			const lockAdapter = createMemoryLockAdapter();
			const mockPairingService: PairingService = {
				bootstrapIfNeeded: () => ({ bootstrapped: false }),
				getActivePairingCode: () => null,
				createPairingCode: () => ({ code: '123456', expiresAt: '2026-09-15T12:01:00.000Z' }),
				claimPairingCode: async () => ({ deviceId: 'dev-1', token: 'mock-valid-token' }),
				invalidatePairingCode: () => undefined,
				listDevices: () => [],
				revokeDevice: () => ({ revokedAt: '2026-09-15T10:00:00.000Z' }),
				authenticateToken: (authHeader) => {
					if (!authHeader || !authHeader.startsWith('Bearer ')) {
						throw new AppError('E_UNAUTHORIZED', 'Missing or invalid Authorization header');
					}
					return { deviceId: 'dev-1', deviceName: 'test-device' };
				},
				registerConnection: () => () => undefined,
			};
			const container = createContainer({
				config: {
					port: 7817,
					bind: '127.0.0.1',
					dataDir: resolve(currentDir, '../fixtures'),
					logLevel: 'error',
					dev: false,
				},
				database: db,
				hostInputs: { platform: 'linux', homedir: resolve(currentDir, '../fixtures') },
				lockAdapter,
				instanceLock: { release: () => undefined } as unknown as LockFileHandle,
				clock,
				pairingService: mockPairingService,
			});

			expect(container.jobs.some((job) => job.name === 'scheduler-tick')).toBe(true);
			expect(container.services.dispatch).toBeDefined();

			const server = createHttpServer({ container });
			await server.instance.ready();

			const snapshotRes = await server.instance.inject({
				method: 'GET',
				url: '/api/v1/snapshot',
			});
			expect(snapshotRes.statusCode).not.toBe(501);
			expect(snapshotRes.statusCode).not.toBe(404);
			const snapshotBody = JSON.parse(snapshotRes.body);
			expect(snapshotBody.error?.message ?? '').not.toMatch(/not implemented yet/i);

			// E-153 接缝（M8-T3 ↔ M2-T5）：latestEventId 必须是最后一条真正发出的事件 id，
			// 不是 event_seq 的预留水位（1000）——SSE 客户端拿它当 Last-Event-ID 续接，偏大就会静默丢事件。
			const publishedEnvelope = container.events.envelopeFactory.createEnvelope({
				kind: 'system.docs_changed',
				payload: { docsPath: '/abs/path/docs', fingerprint: 'fp-x' },
			});
			container.events.bus.publish(publishedEnvelope);
			const published = publishedEnvelope;
			const afterPublishRes = await server.instance.inject({
				method: 'GET',
				url: '/api/v1/snapshot',
				headers: { authorization: 'Bearer mock-valid-token' },
			});
			const afterPublish = JSON.parse(afterPublishRes.body) as { latestEventId: number | null };
			// 容器后台任务可在两次读取之间继续发布 agent availability 等事件；快照游标可以推进，
			// 但绝不能倒退到本测试刚发布的事件之前，更不能返回 event_seq 的预留水位。
			expect(afterPublish.latestEventId).not.toBeNull();
			expect(afterPublish.latestEventId ?? 0).toBeGreaterThanOrEqual(published.id);
			expect(afterPublish.latestEventId).toBeLessThan(1000);

			const createRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/runs',
				payload: {
					taskId: 'missing',
					agentId: 'codex',
					idempotencyKey: 'boot-wiring-key',
				},
			});
			expect(createRes.statusCode).not.toBe(501);
			const createBody = JSON.parse(createRes.body);
			expect(createBody.error?.message ?? '').not.toMatch(/not implemented yet/i);

			await server.close();
		}, 30_000);
	});
});
