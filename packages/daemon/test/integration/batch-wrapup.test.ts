import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppContainer } from '../../src/boot/container.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { registerBatchesRoutes } from '../../src/http/routes/batches.ts';
import { registerTasksRoutes } from '../../src/http/routes/tasks.ts';
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
import { type InHeadCheckMethod, isBranchInHead } from '../../src/workspace/in-head.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(currentDir, '../../migrations');
const fixturesDir = resolve(currentDir, '../fixtures/wrapup');

const tempDirectories: string[] = [];

function createTempGitRepo(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirectories.push(dir);
	try {
		execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
		execSync('git config user.name "Tester"', { cwd: dir, stdio: 'ignore' });
		execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'ignore' });
		writeFileSync(join(dir, 'README.md'), '# Initial Repo\n');
		execSync('git add README.md && git commit -m "initial commit"', {
			cwd: dir,
			stdio: 'ignore',
		});
	} catch (err) {
		// Fallback without -b main for older git
		execSync('git init', { cwd: dir, stdio: 'ignore' });
		execSync('git checkout -b main', { cwd: dir, stdio: 'ignore' });
		execSync('git config user.name "Tester"', { cwd: dir, stdio: 'ignore' });
		execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'ignore' });
		writeFileSync(join(dir, 'README.md'), '# Initial Repo\n');
		execSync('git add README.md && git commit -m "initial commit"', {
			cwd: dir,
			stdio: 'ignore',
		});
	}
	return dir;
}

afterEach(() => {
	for (const dir of tempDirectories.splice(0)) {
		try {
			rmSync(dir, { force: true, recursive: true });
		} catch {}
	}
});

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
	let inHeadMockResult: { inHead: boolean; method: string } | null = null;
	let gitRepoDir: string;
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
		inHeadMockResult = null;
		testTime = '2026-09-17T10:00:00.000Z';
		db = setupTestDatabase();
		gitRepoDir = createTempGitRepo('sched-git-repo-');

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
				scope: input.scope ?? 'batch',
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
				tasks: [{ taskId: 'task-1', title: 'Task 1' }],
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
				prepareWrapupWorktree: async (input) => {
					const branchName = `wrapup/${input.batchId}-${input.round}-${ids.newId()}`;
					const worktreePath = join(tmpdir(), `sched-wrapup-${ids.newId()}`);
					tempDirectories.push(worktreePath);
					execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], {
						cwd: input.repoPath,
						stdio: 'ignore',
					});
					return { worktreePath, branchName, baseSha: 'HEAD' };
				},
				getDiffStat: async (worktreePath) =>
					execFileSync('git', ['diff', '--stat', 'HEAD'], {
						cwd: worktreePath,
						encoding: 'utf8',
					}),
			},
		});

		gateService = createGateService({
			gatesRepo,
			tasksRepo,
			runsRepo,
			batchesRepo,
			batchWrapupsRepo,
			batchService,
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
			isBranchInHead: async (input) => {
				if (inHeadMockResult !== null) {
					return {
						inHead: inHeadMockResult.inHead,
						method: inHeadMockResult.method as InHeadCheckMethod,
						tipSha: 'sha-tip',
					};
				}
				return await isBranchInHead(input);
			},
			clock,
			ids,
			bus: fakeBus as unknown as Parameters<typeof createDispatchService>[0]['bus'],
			envelopeFactory: fakeEnvelopeFactory as unknown as Parameters<
				typeof createDispatchService
			>[0]['envelopeFactory'],
			listDispatchableAgents: () => [{ agentId: 'codex', canDispatch: true }],
		});

		// Fastify server configuration (R2)
		app = fastify();
		app.decorate('container', {
			services: {
				dispatch: dispatchService,
				wrapup: wrapupService,
				gates: gateService,
			},
		} as unknown as AppContainer);
		registerBatchesRoutes(app);
		registerTasksRoutes(app);
		app.setErrorHandler((error: unknown, _request, reply) => {
			if ('validation' in (error as Record<string, unknown>)) {
				void reply.status(400).send({
					error: {
						code: 'E_VALIDATION',
						message: (error as Error).message,
					},
				});
				return;
			}
			if (error instanceof AppError) {
				let statusCode = 400;
				if (
					error.code === 'E_RUN_ALREADY_EXISTS' ||
					error.code === 'E_BATCH_NOT_WRAPPABLE' ||
					error.code === 'E_WRAPUP_ROUND_LIMIT' ||
					error.code === 'E_FIX_RUN_IN_FLIGHT'
				) {
					statusCode = 409;
				} else if (error.code === 'E_NOT_FOUND') {
					statusCode = 404;
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

		// Seed Document, Batch, Tasks, Devices
		db.exec(`
			INSERT INTO devices (id, name, token_hash, token_salt, paired_at, last_seen_at)
			VALUES ('dev-1', 'Test Device', 'hash', 'salt', '${testTime}', '${testTime}');
		`);

		documentsRepo.insert({
			id: 'doc-1',
			docs_path: '/docs',
			project_name: 'test-project',
			repo_path: gitRepoDir,
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

		inHeadMockResult = { inHead: false, method: 'unmerged' };
		await dispatchService.tick();

		const batch = batchesRepo.findById('batch-1');
		expect(batch?.state).toBe('awaiting_landing');
		expect(runsRepo.findActiveWrapupByBatchId?.('batch-1')).toBeNull();

		const batchDto = await batchService.getBatch('batch-1');
		expect(batchDto.state).toBe('awaiting_landing');
		expect(batchDto.notInHeadCount).toBe(2);
		expect(batchDto.canWrapup).toBe(false);
	});

	it('AC 1 & E-283 & E-287: when branches merged into HEAD, tick triggers exactly one wrapup run following latest ended_at implementation run', async () => {
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
			ended_at: '2026-09-17T10:20:00.000Z', // Ended later than run-t1
		});

		inHeadMockResult = { inHead: true, method: 'ancestor' };
		const tickRes = await dispatchService.tick();

		expect(tickRes.runsDispatched.length).toBe(1);
		const wrapupRunId = tickRes.runsDispatched[0];
		if (!wrapupRunId) throw new Error('wrapup run id missing');
		const wrapupRun = runsRepo.findById(wrapupRunId);

		expect(wrapupRun).toBeDefined();
		expect(wrapupRun?.kind).toBe('wrapup');
		expect(wrapupRun?.task_id).toBeNull();
		expect(wrapupRun?.permission_tier).toBe('workspaceWrite');
		expect(wrapupRun?.state).toBe('queued');
		// E-287: follows run-t2
		expect(wrapupRun?.agent_id).toBe('claude');
		expect(wrapupRun?.model_name).toBe('claude-3-7-sonnet');
		expect(wrapupRun?.effort_tier).toBe('medium');

		const batch = batchesRepo.findById('batch-1');
		expect(batch?.state).toBe('wrapping');
	});

	it('F1 (E-272 / E-283): a review run with a higher attempt_no must not hide the landed implementation run', async () => {
		// 实施行 landed 且已进 HEAD；随后的审查行（attempt 2，停在 exited）与它共用 task_id
		runsRepo.insert({
			id: 'run-t1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			branch_name: 'task/m1-t1',
			is_in_head: 1,
			ended_at: '2026-09-17T10:10:00.000Z',
		});
		runsRepo.insert({
			id: 'run-t1-review',
			task_id: 'task-1',
			attempt_no: 2,
			kind: 'review',
			parent_run_id: 'run-t1',
			state: 'exited',
			agent_id: 'codex',
			permission_tier: 'readOnly',
			snapshot_id: 'snap-1',
			ended_at: '2026-09-17T10:15:00.000Z',
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
			branch_name: 'task/m1-t2',
			is_in_head: 1,
			ended_at: '2026-09-17T10:20:00.000Z',
		});

		const dto = await batchService.getBatch('batch-1');
		expect(dto.canWrapup).toBe(true);
		expect(dto.notInHeadCount).toBe(0);

		inHeadMockResult = { inHead: true, method: 'ancestor' };
		const tickRes = await dispatchService.tick();
		expect(tickRes.runsDispatched.length).toBe(1);
		expect(runsRepo.findById(tickRes.runsDispatched[0] ?? '')?.kind).toBe('wrapup');
		expect(batchesRepo.findById('batch-1')?.state).toBe('wrapping');
	});

	it('F1 (E-272): tasks landed by a human gate (manual_state) count for tick AND triggerWrapup, and their branches still get the in-HEAD check', async () => {
		// M8-T4 闸门 pass 的真实产物：tasks.manual_state='landed'，实施行停在 awaiting_human
		tasksRepo.updateManualState('task-1', 'landed');
		tasksRepo.updateManualState('task-2', 'landed');
		runsRepo.insert({
			id: 'run-t1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'awaiting_human',
			agent_id: 'codex',
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
			state: 'awaiting_human',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-2',
			branch_name: 'task/m1-t2',
			ended_at: '2026-09-17T10:20:00.000Z',
		});

		// 分支未进 HEAD：tick 必须把批次转 awaiting_landing（而不是吞掉 not_all_landed 停在 running）
		inHeadMockResult = { inHead: false, method: 'unmerged' };
		await dispatchService.tick();
		expect(batchesRepo.findById('batch-1')?.state).toBe('awaiting_landing');
		const waiting = await batchService.getBatch('batch-1');
		expect(waiting.notInHeadCount).toBe(2);
		await expect(
			wrapupService.triggerWrapup({ batchId: 'batch-1', trigger: 'manual' }),
		).rejects.toMatchObject({ code: 'E_BATCH_NOT_WRAPPABLE', details: { reason: 'not_in_head' } });

		// 分支合入后：下一 tick（节流 30s 后）刷新 is_in_head 并派收口
		inHeadMockResult = { inHead: true, method: 'ancestor' };
		testTime = '2026-09-17T10:31:00.000Z';
		const tickRes = await dispatchService.tick();
		expect(tickRes.runsDispatched.length).toBe(1);
		expect(batchesRepo.findById('batch-1')?.state).toBe('wrapping');
	});

	it('F3 (E-288): after round 2 is still open, the human pass on the batch gate lands beside the machine verdict row', async () => {
		batchesRepo.insert({
			id: 'batch-2',
			doc_id: 'doc-1',
			batch_no: 2,
			state: 'done',
			started_at: testTime,
			finished_at: testTime,
		});
		tasksRepo.insert({
			id: 'task-m3-t6',
			doc_id: 'doc-1',
			task_key: 'M3-T6',
			title: 'Task M3-T6',
			module_key: 'M3',
			deps_json: '[]',
			contract_hash: 'h-m3t6',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			batch_id: 'batch-2',
		});
		runsRepo.insert({
			id: 'run-m3-t6',
			task_id: 'task-m3-t6',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			is_in_head: 1,
			ended_at: '2026-09-17T09:00:00.000Z',
		});
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
		const openReport = readFileSync(resolve(fixturesDir, 'open-unfixed-bug.md'), 'utf8');

		const { run: round1 } = await wrapupService.triggerWrapup({
			batchId: 'batch-1',
			trigger: 'manual',
		});
		await wrapupService.recordWrapupResult({ runId: round1.id, rawText: openReport, exitCode: 0 });
		expect(batchWrapupsRepo.getMaxRound('batch-1')).toBe(1);
		expect(batchesRepo.findById('batch-1')?.state).toBe('running');

		const { run: round2 } = await wrapupService.triggerWrapup({
			batchId: 'batch-1',
			trigger: 'manual',
		});
		await wrapupService.recordWrapupResult({ runId: round2.id, rawText: openReport, exitCode: 0 });
		expect(batchesRepo.findById('batch-1')?.state).toBe('needs_attention');
		const machineRow = batchWrapupsRepo.findByRunId(round2.id);
		expect(machineRow?.verdict).toBe('open');
		expect(machineRow?.is_human_verdict).toBe(0);

		const gate = gatesRepo.findPendingByRunId?.(round2.id);
		if (!gate) throw new Error('batch-level gate must exist after round 2 open');
		await gateService.decideGate({
			gateId: gate.id,
			decision: 'pass',
			comment: '剩余 B2 已另开任务承接，本批放行。',
			actorDeviceId: 'dev-1',
		});

		const rows = batchWrapupsRepo.listByBatchId('batch-1');
		const humanRow = rows.find((r) => r.is_human_verdict === 1);
		expect(humanRow?.run_id).toBe(round2.id);
		expect(humanRow?.verdict).toBe('clean');
		expect(rows.filter((r) => r.run_id === round2.id)).toHaveLength(2);
		expect(batchesRepo.findById('batch-1')?.state).toBe('done');
		expect(gatesRepo.findById(gate.id)?.state).toBe('decided');
	});

	it('AC 4 & E-294: clean wrapup report transitions batch to done and wrapup run to landed, even if diff is empty', async () => {
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
			idempotencyKey: 'idemp-wrapup-1',
		});

		expect(wrapupRun.kind).toBe('wrapup');
		expect(wrapupRun.taskId).toBeNull();

		const cleanReportText = readFileSync(resolve(fixturesDir, 'clean-report.md'), 'utf8');
		await wrapupService.recordWrapupResult({
			runId: wrapupRun.id,
			rawText: cleanReportText,
			exitCode: 0,
		});

		const wrapupRecord = batchWrapupsRepo.findByRunId(wrapupRun.id);
		expect(wrapupRecord).toBeDefined();
		expect(wrapupRecord?.verdict).toBe('clean');
		expect(wrapupRecord?.is_human_verdict).toBe(0);

		const batch = batchesRepo.findById('batch-1');
		expect(batch?.state).toBe('done');

		const updatedRun = runsRepo.findById(wrapupRun.id);
		expect(updatedRun?.state).toBe('landed');
	});

	it('AC 4 & AC 5 & E-274 & E-288: unparsable wrapup report creates batch-level gate, needs_attention, and pass requires comment', async () => {
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

		const missingNextText = readFileSync(resolve(fixturesDir, 'missing-next.md'), 'utf8');
		await wrapupService.recordWrapupResult({
			runId: wrapupRun.id,
			rawText: missingNextText,
			exitCode: 0,
		});

		const batch = batchesRepo.findById('batch-1');
		expect(batch?.state).toBe('needs_attention');

		const runAfterFailure = runsRepo.findById(wrapupRun.id);
		expect(runAfterFailure?.state).toBe('awaiting_human');

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

	it('R4: failed wrapup runs do not consume valid auto rounds; manual wrapup allows rounds up to physical hard ceiling (6)', async () => {
		batchesRepo.updateState({
			id: 'batch-1',
			state: 'needs_attention',
		});

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

		// Trigger round 1 -> fail
		const { run: r1 } = await wrapupService.triggerWrapup({
			batchId: 'batch-1',
			trigger: 'manual',
		});
		expect(r1.attemptNo).toBe(1);
		await wrapupService.recordWrapupResult({ runId: r1.id, exitCode: 1 });

		// Since r1 failed, validRoundCount in batch_wrapups is 0 (E-274: failure does not consume auto round)
		expect(batchWrapupsRepo.getMaxRound('batch-1')).toBe(0);

		// Trigger round 2 -> fail
		const { run: r2 } = await wrapupService.triggerWrapup({
			batchId: 'batch-1',
			trigger: 'manual',
		});
		expect(r2.attemptNo).toBe(2);
		await wrapupService.recordWrapupResult({ runId: r2.id, exitCode: 1 });
		expect(batchWrapupsRepo.getMaxRound('batch-1')).toBe(0);

		// Trigger manual runs up to hard physical ceiling of 6
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

		// 7th manual trigger exceeds HARD_WRAPUP_ROUND_LIMIT (6)
		try {
			await wrapupService.triggerWrapup({ batchId: 'batch-1', trigger: 'manual' });
			expect.unreachable();
		} catch (err: unknown) {
			const error = err as AppError;
			expect(error.code).toBe('E_WRAPUP_ROUND_LIMIT');
			expect((error.details as Record<string, unknown>)?.hardLimit).toBe(6);
		}
	});

	it('R3 & E-301: cross-repo in-head refresh and consecutive error warnings', async () => {
		// Create second git repository
		const gitRepoDirB = createTempGitRepo('sched-git-repo-b-');
		documentsRepo.insert({
			id: 'doc-2',
			docs_path: '/docs-2',
			project_name: 'test-project-2',
			repo_path: gitRepoDirB,
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: 'fp-2',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: testTime,
			last_seen_at: testTime,
		});

		batchesRepo.insert({
			id: 'batch-2',
			doc_id: 'doc-2',
			batch_no: 1,
			state: 'running',
			started_at: testTime,
			finished_at: null,
		});

		tasksRepo.insert({
			id: 'task-b1',
			doc_id: 'doc-2',
			task_key: 'M2-T1',
			title: 'Task B1',
			module_key: 'M2',
			deps_json: '[]',
			contract_hash: 'hb1',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			batch_id: 'batch-2',
		});

		runsRepo.insert({
			id: 'run-b1',
			task_id: 'task-b1',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			branch_name: 'task/m2-t1',
			is_in_head: 0,
			ended_at: '2026-09-17T10:05:00.000Z',
		});

		runsRepo.insert({
			id: 'run-a1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			branch_name: 'task/m1-t1',
			is_in_head: 0,
			ended_at: '2026-09-17T10:00:00.000Z',
		});

		// 1. Simulate git error on run-a1 for 3 consecutive ticks (E-301)
		inHeadMockResult = { inHead: false, method: 'error' };

		testTime = '2026-09-17T10:31:00.000Z'; // > 30s throttle
		await dispatchService.tick();
		expect(dispatchService.getInHeadWarning('run-a1')).toBeNull();

		testTime = '2026-09-17T10:32:00.000Z';
		await dispatchService.tick();
		expect(dispatchService.getInHeadWarning('run-a1')).toBeNull();

		testTime = '2026-09-17T10:33:00.000Z';
		await dispatchService.tick();
		// 3 consecutive errors triggers warning banner! (E-301)
		expect(dispatchService.getInHeadWarning('run-a1')).toBe('无法判定分支是否已合入');
		expect((await dispatchService.getRun('run-a1')).inHeadWarning).toBe('无法判定分支是否已合入');

		// 2. Both repos recover and branches are in HEAD
		inHeadMockResult = { inHead: true, method: 'ancestor' };
		testTime = '2026-09-17T10:34:00.000Z';
		await dispatchService.tick();

		// Warning cleared
		expect(dispatchService.getInHeadWarning('run-a1')).toBeNull();
		// Both runs in different repos successfully marked in_head
		expect(runsRepo.findById('run-a1')?.is_in_head).toBe(1);
		expect(runsRepo.findById('run-b1')?.is_in_head).toBe(1);
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

		runsRepo.updateInHead?.({
			id: 'run-mono',
			isInHead: 0,
			checkedAt: testTime,
			branchTipSha: 'sha-tip',
		});

		const run = runsRepo.findById('run-mono');
		expect(run?.is_in_head).toBe(1); // Monotonicity preserved
		expect(run?.branch_tip_sha).toBe('sha-tip');
	});

	it('HTTP GET /api/v1/batches/:batchId/wrapups returns wrapups list', async () => {
		runsRepo.insert({
			id: 'run-w-1',
			task_id: null,
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

	describe('M8-T7 Integration: Wrapup Fix Dispatch, Cross-Batch Semantics, and Manual Recall (AC 1-6, E-275, E-276, E-280, E-290, E-293, E-298, E-300, E-46, E-55)', () => {
		it('AC 1 & AC 2 & E-275 & E-280: Open wrapup report dispatches fix runs grouped by task, serializes them, and reuses worktree', async () => {
			runsRepo.insert({
				id: 'run-t1-orig',
				task_id: 'task-1',
				attempt_no: 1,
				kind: 'implement',
				state: 'landed',
				agent_id: 'codex',
				model_name: 'gpt-4o',
				effort_tier: 'high',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-1',
				worktree_path: '/worktrees/task-1',
				branch_name: 'task/M1-T1',
				is_in_head: 1,
				ended_at: '2026-09-17T10:10:00.000Z',
			});
			runsRepo.insert({
				id: 'run-t2-orig',
				task_id: 'task-2',
				attempt_no: 1,
				kind: 'implement',
				state: 'landed',
				agent_id: 'codex',
				model_name: 'gpt-4o',
				effort_tier: 'high',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-2',
				worktree_path: '/worktrees/task-2',
				branch_name: 'task/M1-T2',
				is_in_head: 1,
				ended_at: '2026-09-17T10:20:00.000Z',
			});

			const { run: wrapupRun } = await wrapupService.triggerWrapup({
				batchId: 'batch-1',
				trigger: 'manual',
			});

			// Wrapup report with open findings for both task-1 and task-2
			const openReport = `## BATCH_SUMMARY
发现 2 处未修复问题

## TESTS
pass

## BUGS
- B1 [S2] 涉及 M1-T1: 鉴权失败 → login → 401 → auth.ts:10
- B2 [S1] 涉及 M1-T2: 格式解析错误 → parse → NaN → parser.ts:25

## FIXED
- none

## NOT_FIXED
- none

## SUSPECT
- none

## RECORD
verdict: open

## NEXT
需由 M8-T7 派发修复运行。`;

			await wrapupService.recordWrapupResult({
				runId: wrapupRun.id,
				rawText: openReport,
				exitCode: 0,
			});

			// 1. Verify batch wrapup record
			const wrapupRecord = batchWrapupsRepo.findByRunId(wrapupRun.id);
			expect(wrapupRecord).toBeDefined();
			expect(wrapupRecord?.verdict).toBe('open');
			const fixRunIds: string[] = JSON.parse(wrapupRecord?.fix_run_ids_json ?? '[]');
			expect(fixRunIds).toHaveLength(2);

			// 2. Verify fix runs created for each task (AC 1)
			const fixRun1 = runsRepo.findById(fixRunIds[0] ?? '');
			const fixRun2 = runsRepo.findById(fixRunIds[1] ?? '');
			expect(fixRun1).toBeDefined();
			expect(fixRun2).toBeDefined();

			// Task 1 fix run assertions
			expect(fixRun1?.task_id).toBe('task-1');
			expect(fixRun1?.batch_id).toBe('batch-1');
			expect(fixRun1?.origin).toBe('wrapup-fix');
			expect(fixRun1?.spawned_by_run_id).toBe(wrapupRun.id);
			expect(fixRun1?.attempt_no).toBe(2);
			expect(fixRun1?.rework_count).toBe(0);
			expect(fixRun1?.permission_tier).toBe('workspaceWrite');
			expect(fixRun1?.worktree_path).toBe(wrapupRun.worktreePath); // Reuses wrapup worktree! (E-280)
			expect(fixRun1?.branch_name).toBe(wrapupRun.branchName);
			expect(fixRun1?.agent_id).toBe('codex');
			expect(fixRun1?.model_name).toBe('gpt-4o');
			expect(fixRun1?.effort_tier).toBe('high');
			expect(fixRun1?.queued_reason).toBeNull(); // First fix run has no clash

			// Task 2 fix run assertions (AC 2, E-280 serialization)
			expect(fixRun2?.task_id).toBe('task-2');
			expect(fixRun2?.origin).toBe('wrapup-fix');
			expect(fixRun2?.spawned_by_run_id).toBe(wrapupRun.id);
			expect(fixRun2?.attempt_no).toBe(2);
			expect(fixRun2?.rework_count).toBe(0);
			expect(fixRun2?.worktree_path).toBe(wrapupRun.worktreePath); // Reuses wrapup worktree!
			// Second fix run is serialized behind first fix run (AC 2, E-280)
			expect(fixRun2?.queued_reason).toBe(`wrapup-fix-serial:${fixRun1?.id}`);

			// Verify prompt structure (AC 1, E-275): R item text + rework rules
			const snap1 = dispatchSnapshotsRepo.findById(fixRun1?.snapshot_id ?? '');
			expect(snap1?.impl_prompt).toContain('R1');
			expect(snap1?.impl_prompt).toContain('鉴权失败');
			expect(snap1?.impl_prompt).toContain('收到返工指令时');
			expect(snap1?.impl_prompt).toContain('只改列出条目、不 commit/push');

			// Batch returns to running (wrapup_fixes_pending)
			const batch = batchesRepo.findById('batch-1');
			expect(batch?.state).toBe('running');
		});

		it('AC 2 & E-46: First fix run queues behind active task touching the same taskPaths', async () => {
			// Update task-1 to declare taskPaths
			tasksRepo.updateDocFields({
				id: 'task-1',
				title: 'Task 1',
				module_key: 'M1',
				deps_json: '[]',
				input_text: null,
				output_text: null,
				accept_text: null,
				edge_ids_json: null,
				task_paths_json: JSON.stringify(['src/shared-worker.ts']),
				contract_hash: 'h1',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
				est_days: null,
				batch_id: 'batch-1',
				impl_prompt: null,
				review_prompt: null,
				is_removed_from_doc: 0,
			});

			runsRepo.insert({
				id: 'run-t1-active-1',
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
				id: 'run-t2-active-1',
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

			// An unrelated in-flight task in another batch touches src/shared-worker.ts
			batchesRepo.insert({
				id: 'batch-blocking',
				doc_id: 'doc-1',
				batch_no: 3,
				state: 'running',
				started_at: testTime,
				finished_at: null,
			});
			tasksRepo.insert({
				id: 'task-blocking',
				doc_id: 'doc-1',
				task_key: 'M9-T99',
				title: 'Blocking Task',
				module_key: 'M9',
				deps_json: '[]',
				contract_hash: 'hb',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
				task_paths_json: JSON.stringify(['src/shared-worker.ts']),
				batch_id: 'batch-blocking',
			});
			runsRepo.insert({
				id: 'run-blocking-active',
				task_id: 'task-blocking',
				attempt_no: 1,
				kind: 'implement',
				state: 'running', // in flight!
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-1',
				batch_id: 'batch-blocking',
			});

			const { run: wrapupRun } = await wrapupService.triggerWrapup({
				batchId: 'batch-1',
				trigger: 'manual',
			});

			const openReport = `## BATCH_SUMMARY
发现问题

## TESTS
pass

## BUGS
- B1 [S2] 涉及 M1-T1: 冲突测试 → test → clash → shared-worker.ts:5

## FIXED
- none

## NOT_FIXED
- none

## SUSPECT
- none

## RECORD
verdict: open

## NEXT
修复。`;

			await wrapupService.recordWrapupResult({
				runId: wrapupRun.id,
				rawText: openReport,
				exitCode: 0,
			});

			const wrapupRecord = batchWrapupsRepo.findByRunId(wrapupRun.id);
			const fixRunIds: string[] = JSON.parse(wrapupRecord?.fix_run_ids_json ?? '[]');
			expect(fixRunIds).toHaveLength(1);

			const fixRun = runsRepo.findById(fixRunIds[0] ?? '');
			// Should be blocked by path clash against task-blocking (E-46)
			expect(fixRun?.queued_reason).toContain('path_conflict:');
			expect(fixRun?.queued_reason).toContain('task-blocking');
		});

		it('AC 3 & E-290: Open wrapup report with all unassigned open items transitions directly to needs_attention without dispatching fix runs', async () => {
			runsRepo.insert({
				id: 'run-t1-unassigned',
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
				id: 'run-t2-unassigned',
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

			// Tests fail without task attribution + bugs without task attribution (E-290)
			const unassignedReport = `## BATCH_SUMMARY
收口测试失败，但未指明任务

## TESTS
fail
- test_unattributed_suite failed

## BUGS
- B1 [S2]: 未归属任务的 bug → root cause → file.ts:1

## FIXED
- none

## NOT_FIXED
- none

## SUSPECT
- none

## RECORD
verdict: open

## NEXT
待人工确认。`;

			await wrapupService.recordWrapupResult({
				runId: wrapupRun.id,
				rawText: unassignedReport,
				exitCode: 0,
			});

			const batch = batchesRepo.findById('batch-1');
			expect(batch?.state).toBe('needs_attention');

			const wrapupRecord = batchWrapupsRepo.findByRunId(wrapupRun.id);
			const fixRunIds: string[] = JSON.parse(wrapupRecord?.fix_run_ids_json ?? '[]');
			expect(fixRunIds).toHaveLength(0); // No fix runs dispatched

			// Gate created with task_id: null
			const gate = gatesRepo.findPendingByRunId?.(wrapupRun.id);
			expect(gate).toBeDefined();
			expect(gate?.task_id).toBeNull();
		});

		it('AC 4 & E-275: Cross-batch fix runs are attributed to triggering batch without rolling back prior batch done state', async () => {
			// Seed batch-2 (triggering batch) and batch-0 (prior done batch)
			batchesRepo.insert({
				id: 'batch-prior',
				doc_id: 'doc-1',
				batch_no: 99,
				state: 'done',
				started_at: testTime,
				finished_at: testTime,
			});

			tasksRepo.insert({
				id: 'task-prior-1',
				doc_id: 'doc-1',
				task_key: 'M0-T1',
				title: 'Prior Task',
				module_key: 'M0',
				deps_json: '[]',
				contract_hash: 'h0',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
				batch_id: 'batch-prior',
			});

			runsRepo.insert({
				id: 'run-prior-impl',
				task_id: 'task-prior-1',
				attempt_no: 1,
				kind: 'implement',
				state: 'landed',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-1',
				is_in_head: 1,
				ended_at: '2026-09-17T09:00:00.000Z',
			});

			runsRepo.insert({
				id: 'run-t1-cb',
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
				id: 'run-t2-cb',
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

			// Batch-1 wraps up and discovers bug in prior batch's M0-T1
			const { run: wrapupRun } = await wrapupService.triggerWrapup({
				batchId: 'batch-1',
				trigger: 'manual',
			});

			const crossBatchReport = `## BATCH_SUMMARY
跨批问题发现

## TESTS
pass

## BUGS
- B1 [S1] 涉及 M0-T1（跨批）：前置批次接口字段缺失 → call → undefined → api.ts:40

## FIXED
- none

## NOT_FIXED
- none

## SUSPECT
- none

## RECORD
verdict: open

## NEXT
修复 M0-T1。`;

			await wrapupService.recordWrapupResult({
				runId: wrapupRun.id,
				rawText: crossBatchReport,
				exitCode: 0,
			});

			// Prior batch remains 'done' (AC 4, E-275)
			const priorBatch = batchesRepo.findById('batch-prior');
			expect(priorBatch?.state).toBe('done');

			// Fix run is attributed to batch-1 (triggering batch)
			const wrapupRecord = batchWrapupsRepo.findByRunId(wrapupRun.id);
			const fixRunIds: string[] = JSON.parse(wrapupRecord?.fix_run_ids_json ?? '[]');
			expect(fixRunIds).toHaveLength(1);

			const fixRun = runsRepo.findById(fixRunIds[0] ?? '');
			expect(fixRun?.task_id).toBe('task-prior-1');
			expect(fixRun?.batch_id).toBe('batch-1'); // Belongs to triggering batch!
			expect(fixRun?.origin).toBe('wrapup-fix');
			expect(fixRun?.spawned_by_run_id).toBe(wrapupRun.id);

			// Task row still belongs to its original batch (AC 4)
			const taskPrior = tasksRepo.findById('task-prior-1');
			expect(taskPrior?.batch_id).toBe('batch-prior');
		});

		it('AC 5 & E-293 & E-300: POST /api/v1/tasks/:taskId/recall creates wrapup-fix run and enforces validations', async () => {
			runsRepo.insert({
				id: 'run-t1-recall-base',
				task_id: 'task-1',
				attempt_no: 1,
				kind: 'implement',
				state: 'landed',
				agent_id: 'codex',
				model_name: 'gpt-4o',
				effort_tier: 'medium',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-1',
				worktree_path: '/worktrees/task-1',
				branch_name: 'task/M1-T1',
				is_in_head: 1,
				ended_at: '2026-09-17T10:10:00.000Z',
			});

			// 1. Missing comment -> 400 E_VALIDATION
			const resNoComment = await app.inject({
				method: 'POST',
				url: '/api/v1/tasks/task-1/recall',
				payload: {
					comment: '',
					idempotencyKey: 'recall-idemp-1',
				},
			});
			expect(resNoComment.statusCode).toBe(400);
			expect(JSON.parse(resNoComment.body).error.code).toBe('E_VALIDATION');

			// 2. Missing idempotencyKey -> 400 E_VALIDATION
			const resNoKey = await app.inject({
				method: 'POST',
				url: '/api/v1/tasks/task-1/recall',
				payload: {
					comment: 'Review was incorrect, recall task',
				},
			});
			expect(resNoKey.statusCode).toBe(400);
			expect(JSON.parse(resNoKey.body).error.code).toBe('E_VALIDATION');

			// 3. Nonexistent task -> 404 E_NOT_FOUND
			const resNotFound = await app.inject({
				method: 'POST',
				url: '/api/v1/tasks/nonexistent-task/recall',
				payload: {
					comment: 'Review was incorrect',
					idempotencyKey: 'recall-idemp-2',
				},
			});
			expect(resNotFound.statusCode).toBe(404);
			expect(JSON.parse(resNotFound.body).error.code).toBe('E_NOT_FOUND');

			// 4. Successful recall
			const resSuccess = await app.inject({
				method: 'POST',
				url: '/api/v1/tasks/task-1/recall',
				payload: {
					comment: '人工发现审查误判，需重新修复鉴权模块',
					idempotencyKey: 'recall-idemp-success',
				},
			});
			expect(resSuccess.statusCode).toBe(200);
			const recalledRun = JSON.parse(resSuccess.body).run;
			expect(recalledRun).toBeDefined();
			expect(recalledRun.taskId).toBe('task-1');
			expect(recalledRun.origin).toBe('wrapup-fix');
			expect(recalledRun.spawnedByRunId).toBeNull(); // AC 5: spawned_by_run_id 为空
			expect(recalledRun.attemptNo).toBe(2);
			expect(recalledRun.reworkCount).toBe(0); // AC 5: 不计入 E-55 计数
			expect(recalledRun.worktreePath).toBe('/worktrees/task-1');
			expect(recalledRun.branchName).toBe('task/M1-T1');

			// Prompt contains comment and rework rules
			const recalledRunRow = runsRepo.findById(recalledRun.id);
			const snapRecall = dispatchSnapshotsRepo.findById(recalledRunRow?.snapshot_id ?? '');
			expect(snapRecall?.impl_prompt).toContain('人工发现审查误判');
			expect(snapRecall?.impl_prompt).toContain('收到返工指令时');

			// 5. Duplicate idempotencyKey -> 409 E_RUN_ALREADY_EXISTS with existing run in details
			const resDuplicate = await app.inject({
				method: 'POST',
				url: '/api/v1/tasks/task-1/recall',
				payload: {
					comment: '人工发现审查误判，需重新修复鉴权模块',
					idempotencyKey: 'recall-idemp-success',
				},
			});
			expect(resDuplicate.statusCode).toBe(409);
			const dupBody = JSON.parse(resDuplicate.body);
			expect(dupBody.error.code).toBe('E_RUN_ALREADY_EXISTS');
			expect(dupBody.error.details.run.id).toBe(recalledRun.id);

			// 6. Another recall attempt with different key while fix run is in flight -> 409 E_FIX_RUN_IN_FLIGHT (E-300)
			const resInFlight = await app.inject({
				method: 'POST',
				url: '/api/v1/tasks/task-1/recall',
				payload: {
					comment: 'Another recall while in flight',
					idempotencyKey: 'recall-idemp-second',
				},
			});
			expect(resInFlight.statusCode).toBe(409);
			expect(JSON.parse(resInFlight.body).error.code).toBe('E_FIX_RUN_IN_FLIGHT');
		});

		it('AC 5: POST /tasks/:taskId/recall returns 409 E_FIX_RUN_IN_FLIGHT when batch wrapup is in flight', async () => {
			runsRepo.insert({
				id: 'run-t2-recall-base',
				task_id: 'task-2',
				attempt_no: 1,
				kind: 'implement',
				state: 'landed',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-2',
				is_in_head: 1,
			});
			runsRepo.insert({
				id: 'run-t1-recall-base-2',
				task_id: 'task-1',
				attempt_no: 1,
				kind: 'implement',
				state: 'landed',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-1',
				is_in_head: 1,
			});

			// Trigger wrapup for batch-1
			await wrapupService.triggerWrapup({
				batchId: 'batch-1',
				trigger: 'manual',
			});

			// Now attempt recall on task-2
			const res = await app.inject({
				method: 'POST',
				url: '/api/v1/tasks/task-2/recall',
				payload: {
					comment: 'Recall during wrapup',
					idempotencyKey: 'recall-during-wrapup',
				},
			});

			expect(res.statusCode).toBe(409);
			expect(JSON.parse(res.body).error.code).toBe('E_FIX_RUN_IN_FLIGHT');
		});
	});
});
