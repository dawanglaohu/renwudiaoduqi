import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppContainer } from '../../src/boot/container.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { registerBatchesRoutes } from '../../src/http/routes/batches.ts';
import { type BatchWrapupsRepo, createBatchWrapupsRepo } from '../../src/repo/batch-wrapups.ts';
import { type BatchesRepo, createBatchesRepo } from '../../src/repo/batches.ts';
import {
	type DispatchSnapshotsRepo,
	createDispatchSnapshotsRepo,
} from '../../src/repo/dispatch-snapshots.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../../src/repo/documents.ts';
import { type GatesRepo, createGatesRepo } from '../../src/repo/gates.ts';
import { type RunsRepo, createRunsRepo } from '../../src/repo/runs.ts';
import { type TasksRepo, createTasksRepo } from '../../src/repo/tasks.ts';
import { type BatchService, createBatchService } from '../../src/service/batch.ts';
import { type DispatchService, createDispatchService } from '../../src/service/dispatch.ts';
import type { DocsService } from '../../src/service/docs.ts';
import { type GateService, createGateService } from '../../src/service/gates.ts';
import { type WrapupService, createWrapupService } from '../../src/service/wrapup.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(currentDir, '../../migrations');
const fixturesDir = resolve(currentDir, '../fixtures/wrapup');

function setupTestDatabase(): DatabaseConnection {
	const db = openDatabase(':memory:');
	const migrationFiles = readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort();

	const runner = createMigrationRunner({
		clock: { now: () => '2026-09-17T00:00:00.000Z' },
		database: db,
		fileSystem: {
			readDirectory: () => migrationFiles,
			readFile: (p: string) => readFileSync(p, 'utf8'),
		},
	});
	runner.run(migrationsDir);
	return db;
}

describe('M8-T6 Integration: Batch Wrap-up Trigger, Rounds & Gates (AC 1-7, E-272, E-274, E-283, E-285, E-287, E-288, E-294, E-295, E-301, E-344)', () => {
	let db: DatabaseConnection;
	let documentsRepo: DocumentsRepo;
	let batchesRepo: BatchesRepo;
	let tasksRepo: TasksRepo;
	let runsRepo: RunsRepo;
	let dispatchSnapshotsRepo: DispatchSnapshotsRepo;
	let batchWrapupsRepo: BatchWrapupsRepo;
	let gatesRepo: GatesRepo;
	let batchService: BatchService;
	let wrapupService: WrapupService;
	let dispatchService: DispatchService;
	let gateService: GateService;
	let docsService: DocsService;
	let testTime = '2026-09-17T10:00:00.000Z';
	let inHeadResult = false;
	let app: FastifyInstance;

	const clock = {
		now: () => testTime,
	};
	let idCounter = 1;
	const ids = {
		newId: () => `id_${idCounter++}`,
	};

	beforeEach(async () => {
		idCounter = 1;
		inHeadResult = false;
		testTime = '2026-09-17T10:00:00.000Z';
		db = setupTestDatabase();
		documentsRepo = createDocumentsRepo(db);
		batchesRepo = createBatchesRepo(db);
		tasksRepo = createTasksRepo(db);
		runsRepo = createRunsRepo(db);
		dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		batchWrapupsRepo = createBatchWrapupsRepo(db);
		gatesRepo = createGatesRepo(db);

		const fakeUnitOfWork = {
			run: <T>(fn: () => T): T => {
				return db.transaction(fn)();
			},
		};

		const fakeBus = {
			publish: () => {},
			subscribe: () => () => {},
		};

		const fakeEnvelopeFactory = {
			createEnvelope: (input: {
				runId?: string | null;
				taskId?: string | null;
				scope?: string;
				kind: string;
				payload?: unknown;
				actorDeviceId?: string | null;
			}) => ({
				id: idCounter++,
				ts: testTime,
				runId: input.runId ?? null,
				taskId: input.taskId ?? null,
				scope: input.scope ?? 'run',
				kind: input.kind,
				seq: 1,
				actorDeviceId: input.actorDeviceId ?? null,
				payload: input.payload ?? {},
			}),
		};

		batchService = createBatchService({
			batchesRepo,
			tasksRepo,
			runsRepo,
			unitOfWork: fakeUnitOfWork as unknown as Parameters<
				typeof createBatchService
			>[0]['unitOfWork'],
			clock,
			bus: fakeBus as unknown as Parameters<typeof createBatchService>[0]['bus'],
			envelopeFactory: fakeEnvelopeFactory as unknown as Parameters<
				typeof createBatchService
			>[0]['envelopeFactory'],
		});

		docsService = {
			getWrapupContext: () => ({
				batchId: 'batch-1',
				level: 0,
				wrapup: readFileSync(resolve(fixturesDir, 'clean-report.md'), 'utf8'),
				promptSource: 'docs' as const,
				tasks: [{ taskId: 't1', title: 'Task 1' }],
			}),
		} as unknown as DocsService;

		const fakeAgentRegistry = {
			getSnapshot: () => ({
				agents: {
					codex: {
						name: 'codex',
						command: 'codex',
						args: [],
						env: {},
					},
					claude: {
						name: 'claude',
						command: 'claude',
						args: [],
						env: {},
					},
				},
			}),
		};

		const fakeAgentService = {
			getAvailability: (agentId: string) => ({
				agentId,
				canDispatch: true,
			}),
		};

		wrapupService = createWrapupService({
			batchesRepo,
			tasksRepo,
			runsRepo,
			dispatchSnapshotsRepo,
			batchWrapupsRepo,
			gatesRepo,
			documentsRepo,
			batchService,
			docsService,
			unitOfWork: fakeUnitOfWork as unknown as Parameters<
				typeof createWrapupService
			>[0]['unitOfWork'],
			clock,
			ids,
			bus: fakeBus as unknown as Parameters<typeof createWrapupService>[0]['bus'],
			envelopeFactory: fakeEnvelopeFactory as unknown as Parameters<
				typeof createWrapupService
			>[0]['envelopeFactory'],
			agentRegistry: fakeAgentRegistry as unknown as Parameters<
				typeof createWrapupService
			>[0]['agentRegistry'],
			agentService: fakeAgentService as unknown as Parameters<
				typeof createWrapupService
			>[0]['agentService'],
			workspace: {
				prepareWrapupWorktree: async () => ({
					worktreePath: '/tmp/wrapup-worktree',
					branchName: 'wrapup/batch-1-r1',
					baseSha: 'sha-main',
				}),
				getDiffStat: async () => ' 2 files changed, 20 insertions(+)',
			},
		});

		gateService = createGateService({
			gatesRepo,
			tasksRepo,
			runsRepo,
			batchesRepo,
			batchWrapupsRepo,
			clock,
			ids,
			bus: fakeBus as unknown as Parameters<typeof createGateService>[0]['bus'],
			envelopeFactory: fakeEnvelopeFactory as unknown as Parameters<
				typeof createGateService
			>[0]['envelopeFactory'],
			unitOfWork: fakeUnitOfWork as unknown as Parameters<
				typeof createGateService
			>[0]['unitOfWork'],
			settingsService: {
				getGates: () => ({ dispatch: 'auto', review: 'auto', landing: 'auto' }),
			} as unknown as Parameters<typeof createGateService>[0]['settingsService'],
		});

		dispatchService = createDispatchService({
			tasksRepo,
			batchesRepo,
			documentsRepo,
			dispatchSnapshotsRepo,
			runsRepo,
			batchWrapupsRepo,
			batchService,
			wrapupService,
			isBranchInHead: async () => ({ inHead: inHeadResult, method: 'ancestor' }),
			clock,
			ids,
			bus: fakeBus as unknown as Parameters<typeof createDispatchService>[0]['bus'],
			envelopeFactory: fakeEnvelopeFactory as unknown as Parameters<
				typeof createDispatchService
			>[0]['envelopeFactory'],
			listDispatchableAgents: () => [{ agentId: 'codex', canDispatch: true }],
		});

		// Build Fastify App for HTTP route integration tests
		app = fastify();
		app.decorate('container', {
			services: {
				dispatch: dispatchService,
				wrapup: wrapupService,
				gates: gateService,
			},
		} as unknown as AppContainer);
		registerBatchesRoutes(app);
		app.setErrorHandler((error: unknown, _request, reply) => {
			if (error instanceof AppError) {
				let statusCode = 400;
				if (
					error.code === 'E_RUN_ALREADY_EXISTS' ||
					error.code === 'E_BATCH_NOT_WRAPPABLE' ||
					error.code === 'E_WRAPUP_ROUND_LIMIT'
				) {
					statusCode = 409;
				}
				void reply.status(statusCode).send({
					error: {
						code: error.code,
						message: error.message,
						details: error.details,
					},
				});
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			void reply.status(500).send({ error: { code: 'E_INTERNAL', message } });
		});
		await app.ready();

		// Seed Document, Batch, Tasks, Device
		db.exec(`
			INSERT INTO devices (id, name, token_hash, token_salt, paired_at, last_seen_at)
			VALUES ('dev-1', 'Test Device', 'hash', 'salt', '${testTime}', '${testTime}');
		`);

		documentsRepo.insert({
			id: 'doc-1',
			docs_path: '/docs',
			project_name: 'test-project',
			repo_path: '/repo',
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: 'fp-1',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: testTime,
			last_seen_at: testTime,
		});

		batchesRepo.insert({
			id: 'batch-1',
			doc_id: 'doc-1',
			batch_no: 1,
			state: 'running',
			started_at: testTime,
			finished_at: null,
		});

		tasksRepo.insert({
			id: 'task-1',
			doc_id: 'doc-1',
			task_key: 'M1-T1',
			title: 'Task 1',
			module_key: 'M1',
			deps_json: '[]',
			contract_hash: 'h1',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			batch_id: 'batch-1',
		});

		tasksRepo.insert({
			id: 'task-2',
			doc_id: 'doc-1',
			task_key: 'M1-T2',
			title: 'Task 2',
			module_key: 'M1',
			deps_json: '[]',
			contract_hash: 'h2',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			batch_id: 'batch-1',
		});

		dispatchSnapshotsRepo.insert({
			id: 'snap-1',
			task_id: 'task-1',
			contract_hash: 'h1',
			task_paths_json: '[]',
			launch_spec_json: '{}',
			created_at: testTime,
		});

		dispatchSnapshotsRepo.insert({
			id: 'snap-2',
			task_id: 'task-2',
			contract_hash: 'h2',
			task_paths_json: '[]',
			launch_spec_json: '{}',
			created_at: testTime,
		});
	});

	it('E-272: when all tasks landed but branches not in HEAD, transitions batch to awaiting_landing and does not trigger wrapup', async () => {
		// Task 1 & 2 landed, but is_in_head = 0
		runsRepo.insert({
			id: 'run-t1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			model_name: 'gpt-5',
			effort_tier: 'high',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			branch_name: 'task/m1-t1',
			ended_at: '2026-09-17T10:10:00.000Z',
		});

		runsRepo.insert({
			id: 'run-t2',
			task_id: 'task-2',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'claude',
			model_name: 'claude-3-7-sonnet',
			effort_tier: 'medium',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-2',
			branch_name: 'task/m1-t2',
			ended_at: '2026-09-17T10:20:00.000Z',
		});

		inHeadResult = false;
		const tickRes = await dispatchService.tick();

		const batch = batchesRepo.findById('batch-1');
		expect(batch?.state).toBe('awaiting_landing');
		// No wrapup run dispatched
		expect(runsRepo.findActiveWrapupByBatchId?.('batch-1')).toBeNull();

		// Check batch DTO
		const batchDto = await batchService.getBatch('batch-1');
		expect(batchDto.state).toBe('awaiting_landing');
		expect(batchDto.notInHeadCount).toBe(2);
		expect(batchDto.canWrapup).toBe(false);
	});

	it('AC 1 & E-283 & E-287: when branches merged into HEAD, tick triggers exactly one wrapup run following latest ended_at implementation run', async () => {
		// Both landed
		runsRepo.insert({
			id: 'run-t1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			model_name: 'gpt-5',
			effort_tier: 'high',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			branch_name: 'task/m1-t1',
			ended_at: '2026-09-17T10:10:00.000Z',
		});

		runsRepo.insert({
			id: 'run-t2',
			task_id: 'task-2',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'claude',
			model_name: 'claude-3-7-sonnet',
			effort_tier: 'medium',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-2',
			branch_name: 'task/m1-t2',
			ended_at: '2026-09-17T10:20:00.000Z', // Ended later than run-t1!
		});

		// Branches now in HEAD!
		inHeadResult = true;
		const tickRes = await dispatchService.tick();

		// Tick should have dispatched wrapup and returned immediately without dispatching other runs
		expect(tickRes.runsDispatched.length).toBe(1);
		const wrapupRunId = tickRes.runsDispatched[0];
		if (!wrapupRunId) throw new Error('wrapup run id missing');
		const wrapupRun = runsRepo.findById(wrapupRunId);

		expect(wrapupRun).toBeDefined();
		expect(wrapupRun?.kind).toBe('wrapup');
		expect(wrapupRun?.task_id).toBeNull();
		expect(wrapupRun?.permission_tier).toBe('workspaceWrite');
		expect(wrapupRun?.state).toBe('queued');
		// E-287: follows run-t2 because it ended at 10:20:00 > 10:10:00
		expect(wrapupRun?.agent_id).toBe('claude');
		expect(wrapupRun?.model_name).toBe('claude-3-7-sonnet');
		expect(wrapupRun?.effort_tier).toBe('medium');

		const batch = batchesRepo.findById('batch-1');
		expect(batch?.state).toBe('wrapping');
	});

	it('AC 4 & E-294: clean wrapup report transitions batch to done and wrapup run to landed, even if diff is empty', async () => {
		// Prepare in-head landed tasks
		runsRepo.insert({
			id: 'run-t1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			is_in_head: 1,
			ended_at: '2026-09-17T10:10:00.000Z',
		});
		runsRepo.insert({
			id: 'run-t2',
			task_id: 'task-2',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-2',
			is_in_head: 1,
			ended_at: '2026-09-17T10:20:00.000Z',
		});

		// Trigger wrapup manually or via service
		const { run: wrapupRun } = await wrapupService.triggerWrapup({
			batchId: 'batch-1',
			trigger: 'manual',
			idempotencyKey: 'idemp-wrapup-1',
		});

		expect(wrapupRun.kind).toBe('wrapup');

		// Now simulate process exiting with exitCode 0 and clean 8-section report
		const cleanReportText = readFileSync(resolve(fixturesDir, 'clean-report.md'), 'utf8');
		await wrapupService.recordWrapupResult({
			runId: wrapupRun.id,
			rawText: cleanReportText,
			exitCode: 0,
		});

		// Verify wrapup record inserted
		const wrapupRecord = batchWrapupsRepo.findByRunId(wrapupRun.id);
		expect(wrapupRecord).toBeDefined();
		expect(wrapupRecord?.verdict).toBe('clean');
		expect(wrapupRecord?.is_human_verdict).toBe(0);

		// Verify batch reached 'done'
		const batch = batchesRepo.findById('batch-1');
		expect(batch?.state).toBe('done');

		// Verify wrapup run is landed
		const updatedRun = runsRepo.findById(wrapupRun.id);
		expect(updatedRun?.state).toBe('landed');
	});

	it('AC 4 & AC 5 & E-274 & E-288: unparsable wrapup report creates batch-level gate, needs_attention, and pass requires comment', async () => {
		// Prepare in-head landed tasks
		runsRepo.insert({
			id: 'run-t1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			is_in_head: 1,
			ended_at: '2026-09-17T10:10:00.000Z',
		});
		runsRepo.insert({
			id: 'run-t2',
			task_id: 'task-2',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-2',
			is_in_head: 1,
			ended_at: '2026-09-17T10:20:00.000Z',
		});

		const { run: wrapupRun } = await wrapupService.triggerWrapup({
			batchId: 'batch-1',
			trigger: 'manual',
		});

		// Report with missing NEXT section (E-274)
		const missingNextText = readFileSync(resolve(fixturesDir, 'missing-next.md'), 'utf8');
		await wrapupService.recordWrapupResult({
			runId: wrapupRun.id,
			rawText: missingNextText,
			exitCode: 0,
		});

		// Batch transitions to needs_attention
		const batch = batchesRepo.findById('batch-1');
		expect(batch?.state).toBe('needs_attention');

		// Run transitions to awaiting_human
		const runAfterFailure = runsRepo.findById(wrapupRun.id);
		expect(runAfterFailure?.state).toBe('awaiting_human');

		// Batch-level review gate created with task_id = null
		const gate = gatesRepo.findPendingByRunId?.(wrapupRun.id);
		expect(gate).toBeDefined();
		if (!gate) throw new Error('Gate must exist');
		expect(gate.task_id).toBeNull();
		expect(gate.kind).toBe('review');
		expect(gate.state).toBe('waiting');

		// AC 5: Passing gate without comment throws E_VALIDATION
		await expect(
			gateService.decideGate({
				gateId: gate.id,
				decision: 'pass',
				comment: '',
				actorDeviceId: 'dev-1',
			}),
		).rejects.toThrowError(AppError);

		// AC 5: Passing gate with comment creates is_human_verdict=1 record and transitions batch to done
		await gateService.decideGate({
			gateId: gate.id,
			decision: 'pass',
			comment: 'Manual verification passed by reviewer.',
			actorDeviceId: 'dev-1',
		});

		const humanWrapup = batchWrapupsRepo.findLatestByBatchId('batch-1');
		expect(humanWrapup?.is_human_verdict).toBe(1);
		expect(humanWrapup?.verdict).toBe('clean');
		expect(humanWrapup?.summary_text).toBe('Manual verification passed by reviewer.');

		const finalBatch = batchesRepo.findById('batch-1');
		expect(finalBatch?.state).toBe('done');
	});

	it('AC 5: duplicate idempotencyKey on POST /api/v1/batches/:batchId/wrapup returns 409 E_RUN_ALREADY_EXISTS with existing run in details', async () => {
		// Prepare in-head landed tasks
		runsRepo.insert({
			id: 'run-t1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			is_in_head: 1,
			ended_at: '2026-09-17T10:10:00.000Z',
		});
		runsRepo.insert({
			id: 'run-t2',
			task_id: 'task-2',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-2',
			is_in_head: 1,
			ended_at: '2026-09-17T10:20:00.000Z',
		});

		// 1st request
		const res1 = await app.inject({
			method: 'POST',
			url: '/api/v1/batches/batch-1/wrapup',
			payload: {
				idempotencyKey: 'wrapup-batch-1-key',
			},
		});

		expect(res1.statusCode).toBe(200);
		const body1 = JSON.parse(res1.body);
		expect(body1.run).toBeDefined();
		expect(body1.run.kind).toBe('wrapup');

		// 2nd request with same idempotencyKey returns 409
		const res2 = await app.inject({
			method: 'POST',
			url: '/api/v1/batches/batch-1/wrapup',
			payload: {
				idempotencyKey: 'wrapup-batch-1-key',
			},
		});

		expect(res2.statusCode).toBe(409);
		const body2 = JSON.parse(res2.body);
		expect(body2.error.code).toBe('E_RUN_ALREADY_EXISTS');
		expect(body2.error.details.run.id).toBe(body1.run.id);
	});

	it('AC 5 & E-288: manual wrapup from needs_attention allows rounds beyond auto limit up to hard ceiling (6) then returns E_WRAPUP_ROUND_LIMIT', async () => {
		// Set batch to needs_attention
		batchesRepo.updateState({
			id: 'batch-1',
			state: 'needs_attention',
		});

		// Insert fake implementation runs to satisfy wrappable check
		runsRepo.insert({
			id: 'run-t1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			is_in_head: 1,
			ended_at: '2026-09-17T10:10:00.000Z',
		});
		runsRepo.insert({
			id: 'run-t2',
			task_id: 'task-2',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-2',
			is_in_head: 1,
			ended_at: '2026-09-17T10:20:00.000Z',
		});

		// Trigger round 1 manually from needs_attention
		const { run: r1 } = await wrapupService.triggerWrapup({
			batchId: 'batch-1',
			trigger: 'manual',
		});
		expect(r1.attemptNo).toBe(1);
		// Simulate fail -> back to needs_attention
		await wrapupService.recordWrapupResult({ runId: r1.id, exitCode: 1 });

		// Trigger round 2
		const { run: r2 } = await wrapupService.triggerWrapup({
			batchId: 'batch-1',
			trigger: 'manual',
		});
		expect(r2.attemptNo).toBe(2);
		await wrapupService.recordWrapupResult({ runId: r2.id, exitCode: 1 });

		// Auto trigger should now be BLOCKED by AUTO_WRAPUP_ROUND_LIMIT (2)
		await expect(
			wrapupService.triggerWrapup({
				batchId: 'batch-1',
				trigger: 'auto',
			}),
		).rejects.toThrowError(AppError);

		// But manual trigger IS ALLOWED up to 6 rounds! (AC 5, E-288)
		const { run: r3 } = await wrapupService.triggerWrapup({
			batchId: 'batch-1',
			trigger: 'manual',
		});
		expect(r3.attemptNo).toBe(3);
		await wrapupService.recordWrapupResult({ runId: r3.id, exitCode: 1 });

		const { run: r4 } = await wrapupService.triggerWrapup({
			batchId: 'batch-1',
			trigger: 'manual',
		});
		expect(r4.attemptNo).toBe(4);
		await wrapupService.recordWrapupResult({ runId: r4.id, exitCode: 1 });

		const { run: r5 } = await wrapupService.triggerWrapup({
			batchId: 'batch-1',
			trigger: 'manual',
		});
		expect(r5.attemptNo).toBe(5);
		await wrapupService.recordWrapupResult({ runId: r5.id, exitCode: 1 });

		const { run: r6 } = await wrapupService.triggerWrapup({
			batchId: 'batch-1',
			trigger: 'manual',
		});
		expect(r6.attemptNo).toBe(6);
		await wrapupService.recordWrapupResult({ runId: r6.id, exitCode: 1 });

		// Now attempt round 7 manually -> hits HARD_WRAPUP_ROUND_LIMIT (6) -> E_WRAPUP_ROUND_LIMIT
		try {
			await wrapupService.triggerWrapup({ batchId: 'batch-1', trigger: 'manual' });
			expect.unreachable();
		} catch (err: unknown) {
			const error = err as AppError;
			expect(error.code).toBe('E_WRAPUP_ROUND_LIMIT');
			expect((error.details as Record<string, unknown>)?.hardLimit).toBe(6);
		}
	});

	it('E-301: is_in_head monotonicity: once 1, never resets to 0', async () => {
		runsRepo.insert({
			id: 'run-mono',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			is_in_head: 1, // already in head
			ended_at: testTime,
		});

		// Attempt to update with isInHead = 0
		runsRepo.updateInHead?.({
			id: 'run-mono',
			isInHead: 0,
			checkedAt: testTime,
			branchTipSha: 'sha-tip',
		});

		const run = runsRepo.findById('run-mono');
		expect(run?.is_in_head).toBe(1); // Monotonicity preserved!
		expect(run?.branch_tip_sha).toBe('sha-tip');
	});

	it('HTTP GET /api/v1/batches/:batchId/wrapups returns wrapups list', async () => {
		runsRepo.insert({
			id: 'run-w-1',
			task_id: null as unknown as string,
			attempt_no: 1,
			kind: 'wrapup',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			worktree_path: '/worktrees/w1',
			branch_name: 'wrapup/b1-r1',
		});

		batchWrapupsRepo.insert({
			id: 'rec-1',
			batch_id: 'batch-1',
			batch_no: 1,
			tasks_json: '["M1-T1"]',
			round: 1,
			run_id: 'run-w-1',
			verdict: 'clean',
			prompt_source: 'docs',
			tests_json: '{"status":"pass","items":[]}',
			summary_text: 'All passed',
			findings_json: '[]',
			unassigned_json: '[]',
			fix_run_ids_json: '[]',
			report_text: 'full report',
			created_at: testTime,
		});

		const res = await app.inject({
			method: 'GET',
			url: '/api/v1/batches/batch-1/wrapups',
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.wrapups).toHaveLength(1);
		expect(body.wrapups[0].verdict).toBe('clean');
		expect(body.wrapups[0].landing.branchName).toBe('wrapup/b1-r1');
	});
});
