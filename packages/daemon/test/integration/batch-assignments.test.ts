import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { errorHandlerPlugin } from '../../src/http/plugins/90-error-handler.ts';
import { registerBatchesRoutes } from '../../src/http/routes/batches.ts';
import { registerDispatchRunsRoutes } from '../../src/http/routes/runs.ts';
import { type BatchesRepo, createBatchesRepo } from '../../src/repo/batches.ts';
import {
	type DispatchSnapshotsRepo,
	createDispatchSnapshotsRepo,
} from '../../src/repo/dispatch-snapshots.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../../src/repo/documents.ts';
import { type EventSeqRepo, createEventSeqRepo } from '../../src/repo/event-seq-repo.ts';
import { type RunsRepo, createRunsRepo } from '../../src/repo/runs.ts';
import { type TasksRepo, createTasksRepo } from '../../src/repo/tasks.ts';
import {
	type AssignmentsService,
	type RegistryAgentSummary,
	createAssignmentsService,
} from '../../src/service/assignments.ts';
import { type DispatchService, createDispatchService } from '../../src/service/dispatch.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(currentDir, '../../migrations');

function setupTestDatabase(): DatabaseConnection {
	const db = openDatabase(':memory:');
	const migrationFiles = readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	const runner = createMigrationRunner({
		clock: { now: () => '2026-09-19T00:00:00.000Z' },
		database: db,
		fileSystem: {
			readDirectory: () => migrationFiles,
			readFile: (p: string) => readFileSync(p, 'utf8'),
		},
	});
	runner.run(migrationsDir);
	return db;
}

/**
 * Registry projection shared by the assignments service and the dispatch tick, the way
 * boot/container.ts wires both from one agentRegistry snapshot.
 */
const REGISTRY_AGENTS: readonly RegistryAgentSummary[] = Object.freeze([
	{
		agentId: 'codex',
		maxConcurrency: 2,
		effortVendorMap: { low: 'low', medium: 'medium', high: 'high' },
	},
	{
		agentId: 'claude',
		maxConcurrency: 2,
		effortVendorMap: { low: '2048', medium: '8192', high: '32768' },
	},
]);

describe('M8-T11 integration: batch assignments endpoint and dispatch by draft (AC 1, AC 4, AC 5, E-47, E-31)', () => {
	let db: DatabaseConnection;
	let documentsRepo: DocumentsRepo;
	let batchesRepo: BatchesRepo;
	let tasksRepo: TasksRepo;
	let runsRepo: RunsRepo;
	let dispatchSnapshotsRepo: DispatchSnapshotsRepo;
	let eventSeqRepo: EventSeqRepo;
	let dispatchService: DispatchService;
	let assignmentsService: AssignmentsService;
	let app: FastifyInstance;
	let testTime = '2026-09-19T10:00:00.000Z';
	let idCounter = 1;

	const clock = { now: () => testTime };
	const ids = { newId: () => `id_${idCounter++}` };

	beforeEach(async () => {
		idCounter = 1;
		testTime = '2026-09-19T10:00:00.000Z';
		db = setupTestDatabase();
		documentsRepo = createDocumentsRepo(db);
		batchesRepo = createBatchesRepo(db);
		tasksRepo = createTasksRepo(db);
		runsRepo = createRunsRepo(db);
		dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		eventSeqRepo = createEventSeqRepo(db);
		const unitOfWork = createUnitOfWork(db);

		documentsRepo.insert({
			id: 'doc-1',
			docs_path: '/abs/path/docs',
			project_name: 'test-project',
			repo_path: '/abs/path/repo',
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 4,
			content_fingerprint: 'fp-1',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: testTime,
			last_seen_at: testTime,
		});

		dispatchService = createDispatchService({
			unitOfWork,
			tasksRepo,
			batchesRepo,
			documentsRepo,
			dispatchSnapshotsRepo,
			runsRepo,
			eventSeqRepo,
			clock,
			ids,
			listDispatchableAgents: () =>
				REGISTRY_AGENTS.map((agent) => ({
					agentId: agent.agentId,
					canDispatch: true,
					concurrencyLimit: agent.maxConcurrency,
				})),
		});
		assignmentsService = createAssignmentsService({
			unitOfWork,
			tasksRepo,
			batchesRepo,
			documentsRepo,
			runsRepo,
			clock,
			listRegistryAgents: () => REGISTRY_AGENTS,
		});

		// Same AJV options as http/server.ts: unknown fields are rejected, not stripped (E-217).
		app = fastify({ ajv: { customOptions: { removeAdditional: false, allErrors: true } } });
		await errorHandlerPlugin(app, {});
		registerDispatchRunsRoutes(app, { dispatchService });
		registerBatchesRoutes(app, { dispatchService, assignmentsService });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		db.close();
	});

	function seedBatch(input: {
		readonly id: string;
		readonly batchNo: number;
		readonly state?: string;
	}) {
		batchesRepo.insert({
			id: input.id,
			doc_id: 'doc-1',
			batch_no: input.batchNo,
			state: (input.state ?? 'idle') as 'idle',
			started_at: null,
			finished_at: null,
		});
	}

	function seedTask(input: {
		readonly id: string;
		readonly taskKey: string;
		readonly batchId?: string;
		readonly deps?: readonly string[];
	}) {
		tasksRepo.insert({
			id: input.id,
			doc_id: 'doc-1',
			task_key: input.taskKey,
			title: `Task ${input.taskKey}`,
			module_key: 'M8',
			deps_json: JSON.stringify(input.deps ?? []),
			contract_hash: `hash_${input.taskKey}`,
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			batch_id: input.batchId ?? 'batch-1',
			task_paths_json: JSON.stringify([`src/${input.taskKey}.ts`]),
			is_removed_from_doc: 0,
			has_accept_changed: 0,
			has_prompt_changed: 0,
			manual_state: null,
		});
	}

	function seedActiveRun(input: {
		readonly id: string;
		readonly taskId: string;
		readonly agentId: string;
		readonly state?: string;
	}) {
		const snapshot = dispatchSnapshotsRepo.takeSnapshotForTask({
			taskId: input.taskId,
			launchSpecJson: '{}',
			createdAt: testTime,
		});
		runsRepo.insert({
			id: input.id,
			task_id: input.taskId,
			attempt_no: 1,
			kind: 'implement',
			state: input.state ?? 'running',
			agent_id: input.agentId,
			permission_tier: 'workspaceWrite',
			snapshot_id: snapshot.id,
			started_at: testTime,
		});
	}

	it('AC 1: GET/POST /api/v1/batches/:batchId/assignments round-trip with whole-batch overwrite', async () => {
		seedBatch({ id: 'batch-1', batchNo: 1 });
		seedTask({ id: 'task-a', taskKey: 'M1-T1' });
		seedTask({ id: 'task-b', taskKey: 'M1-T2' });
		seedTask({ id: 'task-c', taskKey: 'M1-T3', deps: ['M1-T1'] });

		// No drafts yet: calculateBatchConcurrency() evaluates an empty assignment set with an agent
		// limit of 1 (M8-T1), so the preview reports agent_limit until something is drafted.
		const empty = await app.inject({ method: 'GET', url: '/api/v1/batches/batch-1/assignments' });
		expect(empty.statusCode).toBe(200);
		expect(JSON.parse(empty.body)).toEqual({
			drafts: [],
			preview: {
				windowCount: 2,
				userSetting: 4,
				agentCapacities: [
					{ agentId: 'claude', active: 0, limit: 2, drafted: 0, isFull: false },
					{ agentId: 'codex', active: 0, limit: 2, drafted: 0, isFull: false },
				],
				effectiveConcurrency: 1,
				bottleneck: 'agent_limit',
				exceedsWindowCount: true,
			},
		});

		const put = await app.inject({
			method: 'POST',
			url: '/api/v1/batches/batch-1/assignments',
			payload: {
				assignments: [
					{ taskId: 'task-a', agentId: 'codex', model: 'gpt-5.6-sol', effort: { tier: 'high' } },
					{ taskId: 'task-b', agentId: 'claude', model: 'opus[1m]', effort: null },
					{ taskId: 'task-c', agentId: 'claude' },
				],
			},
		});
		expect(put.statusCode).toBe(200);
		const putBody = JSON.parse(put.body);
		expect(putBody.drafts).toEqual([
			{
				taskId: 'task-a',
				taskKey: 'M1-T1',
				agentId: 'codex',
				model: 'gpt-5.6-sol',
				effort: { tier: 'high' },
				sessionNo: 1,
				draftedAt: testTime,
			},
			{
				taskId: 'task-b',
				taskKey: 'M1-T2',
				agentId: 'claude',
				model: 'opus[1m]',
				effort: null,
				sessionNo: 1,
				draftedAt: testTime,
			},
			{
				taskId: 'task-c',
				taskKey: 'M1-T3',
				agentId: 'claude',
				model: null,
				effort: null,
				sessionNo: 2,
				draftedAt: testTime,
			},
		]);
		// Agents could take 3 (codex 1 + claude 2), lanes allow 4, but only a and b are releasable.
		expect(putBody.preview.bottleneck).toBe('window_count');
		expect(putBody.preview.effectiveConcurrency).toBe(2);
		expect(putBody.preview.agentCapacities).toEqual([
			{ agentId: 'codex', active: 0, limit: 2, drafted: 1, isFull: false },
			{ agentId: 'claude', active: 0, limit: 2, drafted: 2, isFull: true },
		]);

		const get = await app.inject({ method: 'GET', url: '/api/v1/batches/batch-1/assignments' });
		expect(JSON.parse(get.body)).toEqual(putBody);

		// Overwrite: task-b and task-c vanish from the drafts and their columns are NULL again.
		const overwrite = await app.inject({
			method: 'POST',
			url: '/api/v1/batches/batch-1/assignments',
			payload: { assignments: [{ taskId: 'task-a', agentId: 'claude' }] },
		});
		expect(overwrite.statusCode).toBe(200);
		expect(JSON.parse(overwrite.body).drafts.map((d: { taskId: string }) => d.taskId)).toEqual([
			'task-a',
		]);
		expect(tasksRepo.findById('task-b')?.assignment_draft_json).toBeNull();
		expect(tasksRepo.findById('task-c')?.assignment_draft_json).toBeNull();
	});

	it('AC 1: validation failures come back as E_VALIDATION with details.field', async () => {
		seedBatch({ id: 'batch-1', batchNo: 1 });
		seedTask({ id: 'task-a', taskKey: 'M1-T1' });

		const badAgent = await app.inject({
			method: 'POST',
			url: '/api/v1/batches/batch-1/assignments',
			payload: { assignments: [{ taskId: 'task-a', agentId: 'nobody' }] },
		});
		expect(badAgent.statusCode).toBe(400);
		expect(JSON.parse(badAgent.body).error).toMatchObject({
			code: 'E_VALIDATION',
			details: { field: 'assignments[0].agentId' },
		});

		const duplicate = await app.inject({
			method: 'POST',
			url: '/api/v1/batches/batch-1/assignments',
			payload: {
				assignments: [
					{ taskId: 'task-a', agentId: 'codex' },
					{ taskId: 'task-a', agentId: 'codex' },
				],
			},
		});
		expect(duplicate.statusCode).toBe(400);
		expect(JSON.parse(duplicate.body).error).toMatchObject({
			code: 'E_VALIDATION',
			details: { field: 'assignments[1].taskId' },
		});

		const foreign = await app.inject({
			method: 'POST',
			url: '/api/v1/batches/batch-1/assignments',
			payload: { assignments: [{ taskId: 'task-zzz', agentId: 'codex' }] },
		});
		expect(foreign.statusCode).toBe(400);
		expect(JSON.parse(foreign.body).error).toMatchObject({
			code: 'E_VALIDATION',
			details: { field: 'assignments[0].taskId' },
		});

		const extraField = await app.inject({
			method: 'POST',
			url: '/api/v1/batches/batch-1/assignments',
			payload: { assignments: [{ taskId: 'task-a', agentId: 'codex', permissionTier: 'x' }] },
		});
		expect(extraField.statusCode).toBe(400);
		expect(JSON.parse(extraField.body).error.code).toBe('E_VALIDATION');

		const missing = await app.inject({
			method: 'GET',
			url: '/api/v1/batches/batch-404/assignments',
		});
		expect(missing.statusCode).toBe(404);
		expect(JSON.parse(missing.body).error.code).toBe('E_NOT_FOUND');
	});

	it('AC 4 & E-47: codex full, claude idle -> tick dispatches the claude task and queues the codex one', async () => {
		seedBatch({ id: 'batch-1', batchNo: 1 });
		seedTask({ id: 'task-busy-1', taskKey: 'M0-T1' });
		seedTask({ id: 'task-busy-2', taskKey: 'M0-T2' });
		seedTask({ id: 'task-codex', taskKey: 'M1-T1' });
		seedTask({ id: 'task-claude', taskKey: 'M1-T2' });
		seedActiveRun({ id: 'run-busy-1', taskId: 'task-busy-1', agentId: 'codex' });
		seedActiveRun({ id: 'run-busy-2', taskId: 'task-busy-2', agentId: 'codex' });

		const put = await app.inject({
			method: 'POST',
			url: '/api/v1/batches/batch-1/assignments',
			payload: {
				assignments: [
					{ taskId: 'task-codex', agentId: 'codex', model: 'gpt-5.6-sol' },
					{ taskId: 'task-claude', agentId: 'claude', model: 'opus[1m]' },
				],
			},
		});
		expect(put.statusCode).toBe(200);
		const preview = JSON.parse(put.body).preview;
		expect(preview.agentCapacities).toEqual([
			{ agentId: 'codex', active: 2, limit: 2, drafted: 1, isFull: true },
			{ agentId: 'claude', active: 0, limit: 2, drafted: 1, isFull: false },
		]);

		const start = await app.inject({
			method: 'POST',
			url: '/api/v1/batches/batch-1/start',
			payload: {},
		});
		expect(start.statusCode).toBe(200);
		expect(JSON.parse(start.body)).toEqual({ accepted: true, queued: 2 });

		// startBatch fires a tick without awaiting it; run one deterministically here.
		const tick = await dispatchService.tick();
		expect(tick.executed).toBe(true);
		expect(runsRepo.listByTaskId('task-claude')).toHaveLength(1);
		expect(runsRepo.listByTaskId('task-codex')).toHaveLength(0);
		expect(tick.tasksDeferred).toContainEqual({
			taskId: 'task-codex',
			reason: 'agent_limit_reached',
		});

		// A second tick still queues codex while its two runs occupy the limit; claude is not re-dispatched.
		const again = await dispatchService.tick();
		expect(runsRepo.listByTaskId('task-codex')).toHaveLength(0);
		expect(runsRepo.listByTaskId('task-claude')).toHaveLength(1);
		expect(again.tasksDeferred).toContainEqual({
			taskId: 'task-codex',
			reason: 'agent_limit_reached',
		});
	});

	it('AC 5 & E-31: dispatched run copies agent/model from the draft, session_no equals the preview and GET /runs/:id serves it', async () => {
		seedBatch({ id: 'batch-1', batchNo: 1 });
		seedTask({ id: 'task-busy', taskKey: 'M0-T1' });
		seedTask({ id: 'tsk_M4T2', taskKey: 'M4-T2' });
		seedTask({ id: 'tsk_M4T5', taskKey: 'M4-T5' });
		seedTask({ id: 'tsk_M5T1', taskKey: 'M5-T1' });
		seedActiveRun({ id: 'run-busy', taskId: 'task-busy', agentId: 'codex' });

		const put = await app.inject({
			method: 'POST',
			url: '/api/v1/batches/batch-1/assignments',
			payload: {
				assignments: [
					{ taskId: 'tsk_M4T2', agentId: 'codex', model: 'gpt-5.6-sol', effort: { tier: 'high' } },
					{ taskId: 'tsk_M4T5', agentId: 'codex', model: null, effort: null },
					{ taskId: 'tsk_M5T1', agentId: 'claude', model: 'opus[1m]', effort: { vendor: '8192' } },
				],
			},
		});
		expect(put.statusCode).toBe(200);
		const drafts = JSON.parse(put.body).drafts as Array<{ taskId: string; sessionNo: number }>;
		const previewSessionNo = new Map(drafts.map((d) => [d.taskId, d.sessionNo]));
		expect(previewSessionNo.get('tsk_M4T2')).toBe(2);
		expect(previewSessionNo.get('tsk_M4T5')).toBe(3);
		expect(previewSessionNo.get('tsk_M5T1')).toBe(1);

		await app.inject({ method: 'POST', url: '/api/v1/batches/batch-1/start', payload: {} });
		const tick = await dispatchService.tick();
		expect(tick.executed).toBe(true);

		const m4t2 = runsRepo.listByTaskId('tsk_M4T2')[0];
		const m5t1 = runsRepo.listByTaskId('tsk_M5T1')[0];
		expect(m4t2).toBeDefined();
		expect(m5t1).toBeDefined();
		expect(m4t2?.agent_id).toBe('codex');
		expect(m4t2?.model_name).toBe('gpt-5.6-sol');
		expect(m4t2?.effort_tier).toBe('high');
		expect(m4t2?.session_no).toBe(previewSessionNo.get('tsk_M4T2'));
		expect(m5t1?.agent_id).toBe('claude');
		expect(m5t1?.model_name).toBe('opus[1m]');
		expect(m5t1?.effort_vendor).toBe('8192');
		expect(m5t1?.session_no).toBe(previewSessionNo.get('tsk_M5T1'));

		// codex limit is 2: the busy run plus M4-T2 fill it, so M4-T5 waits with session 3 still previewed.
		expect(runsRepo.listByTaskId('tsk_M4T5')).toHaveLength(0);
		expect(tick.tasksDeferred).toContainEqual({
			taskId: 'tsk_M4T5',
			reason: 'agent_limit_reached',
		});
		const after = await app.inject({ method: 'GET', url: '/api/v1/batches/batch-1/assignments' });
		const remaining = JSON.parse(after.body).drafts as Array<{ taskId: string; sessionNo: number }>;
		expect(remaining).toHaveLength(1);
		expect(remaining[0]).toMatchObject({ taskId: 'tsk_M4T5', sessionNo: 3 });

		// Drafts of dispatched tasks stay on the row as history (09 节), only pending ones are listed.
		expect(tasksRepo.findById('tsk_M4T2')?.assignment_draft_json).not.toBeNull();

		const getRun = await app.inject({ method: 'GET', url: `/api/v1/runs/${m4t2?.id}` });
		expect(getRun.statusCode).toBe(200);
		const runDto = JSON.parse(getRun.body).run;
		expect(runDto.sessionNo).toBe(2);
		expect(runDto.agentId).toBe('codex');
		expect(runDto.modelName).toBe('gpt-5.6-sol');
		expect(runDto.effort).toEqual({ tier: 'high' });

		const getClaude = await app.inject({ method: 'GET', url: `/api/v1/runs/${m5t1?.id}` });
		expect(JSON.parse(getClaude.body).run.sessionNo).toBe(1);

		// Rows written before the column existed read back as null.
		const legacy = await app.inject({ method: 'GET', url: '/api/v1/runs/run-busy' });
		expect(JSON.parse(legacy.body).run.sessionNo).toBeNull();
	});

	it('AC 5: a task without a draft falls back to the first dispatchable agent (M8-T3 behaviour)', async () => {
		seedBatch({ id: 'batch-1', batchNo: 1 });
		seedTask({ id: 'task-plain', taskKey: 'M1-T1' });

		await app.inject({ method: 'POST', url: '/api/v1/batches/batch-1/start', payload: {} });
		const tick = await dispatchService.tick();
		expect(tick.executed).toBe(true);

		const run = runsRepo.listByTaskId('task-plain')[0];
		expect(run?.agent_id).toBe('codex');
		expect(run?.model_name).toBeNull();
		expect(run?.effort_tier).toBeNull();
		expect(run?.session_no).toBe(1);
	});

	it('E-336: a drafted agent that the registry lists but cannot dispatch is reported, not re-routed', async () => {
		const strictDispatch = createDispatchService({
			unitOfWork: createUnitOfWork(db),
			tasksRepo,
			batchesRepo,
			documentsRepo,
			dispatchSnapshotsRepo,
			runsRepo,
			eventSeqRepo,
			clock,
			ids,
			listDispatchableAgents: () => [
				{ agentId: 'codex', canDispatch: true, concurrencyLimit: 2 },
				{ agentId: 'claude', canDispatch: false, concurrencyLimit: 2 },
			],
		});
		seedBatch({ id: 'batch-1', batchNo: 1, state: 'running' });
		seedTask({ id: 'task-claude', taskKey: 'M1-T1' });
		await assignmentsService.putDrafts({
			batchId: 'batch-1',
			assignments: [{ taskId: 'task-claude', agentId: 'claude' }],
		});

		const tick = await strictDispatch.tick();
		expect(runsRepo.listByTaskId('task-claude')).toHaveLength(0);
		expect(tick.tasksBlocked).toContainEqual({
			taskId: 'task-claude',
			reason: 'agent_unavailable',
		});
	});
});
