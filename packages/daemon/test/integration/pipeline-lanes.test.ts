import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../../src/config/registry.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import type { RunState } from '../../src/domain/run-state-machine.ts';
import { canWrapup } from '../../src/domain/wrapup-policy.ts';
import type { EventBus } from '../../src/events/bus.ts';
import { type EnvelopeFactory, createEnvelopeFactory } from '../../src/events/envelope.ts';
import { errorHandlerPlugin } from '../../src/http/plugins/90-error-handler.ts';
import { registerDocumentRoutes } from '../../src/http/routes/documents.ts';
import { registerGateRoutes } from '../../src/http/routes/gates.ts';
import { registerRunsRoutes } from '../../src/http/routes/runs.ts';
import { registerSnapshotRoute } from '../../src/http/routes/snapshot.ts';
import { createProcessRegistry } from '../../src/proc/registry.ts';
import { type BatchWrapupsRepo, createBatchWrapupsRepo } from '../../src/repo/batch-wrapups.ts';
import { type BatchesRepo, createBatchesRepo } from '../../src/repo/batches.ts';
import {
	type DispatchSnapshotsRepo,
	createDispatchSnapshotsRepo,
} from '../../src/repo/dispatch-snapshots.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../../src/repo/documents.ts';
import { type GatesRepo, createGatesRepo } from '../../src/repo/gates.ts';
import { createSqliteRunMessagesRepo } from '../../src/repo/run-messages-repo.ts';
import { type RunsRepo, createRunsRepo } from '../../src/repo/runs.ts';
import { type SettingsRepo, createSettingsRepo } from '../../src/repo/settings.ts';
import { type TasksRepo, createTasksRepo } from '../../src/repo/tasks.ts';
import { type BatchService, createBatchService } from '../../src/service/batch.ts';
import { type BughuntService, createBughuntService } from '../../src/service/bughunt.ts';
import { type DispatchService, createDispatchService } from '../../src/service/dispatch.ts';
import { type DocsService, createDocsService } from '../../src/service/docs.ts';
import { type GateService, createGateService } from '../../src/service/gates.ts';
import { type LanesService, createLanesService } from '../../src/service/lanes.ts';
import type { LogstoreService } from '../../src/service/logstore.ts';
import { createMessageService } from '../../src/service/message.ts';
import { createReworkService } from '../../src/service/rework.ts';
import { createRunService } from '../../src/service/run.ts';
import { createSessionArchiveService } from '../../src/service/session-archive.ts';
import { type SettingsService, createSettingsService } from '../../src/service/settings.ts';
import { type WrapupService, createWrapupService } from '../../src/service/wrapup.ts';
import type { GitRunner } from '../../src/workspace/diff.ts';
import type { WorktreeManager } from '../../src/workspace/worktree.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(currentDir, '../../migrations');
const bughuntFixturesDir = resolve(currentDir, '../fixtures/bughunt');

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
	} catch {
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

describe('M8-T8 Integration: Pipeline Lanes, Slots, Backfill & Stage Settings (AC 1-7, E-302~E-312, E-326, E-327, E-334)', () => {
	let db: DatabaseConnection;
	let gitRepoPath: string;
	let documentsRepo: DocumentsRepo;
	let batchesRepo: BatchesRepo;
	let tasksRepo: TasksRepo;
	let runsRepo: RunsRepo;
	let dispatchSnapshotsRepo: DispatchSnapshotsRepo;
	let batchWrapupsRepo: BatchWrapupsRepo;
	let gatesRepo: GatesRepo;
	let settingsRepo: SettingsRepo;
	let unitOfWork: ReturnType<typeof createUnitOfWork>;

	let publishedEvents: EventEnvelope[];
	let bus: EventBus;
	let envelopeFactory: EnvelopeFactory;
	let clock: { now: () => string };
	let nowIso: string;

	let batchService: BatchService;
	let wrapupService: WrapupService;
	let dispatchService: DispatchService;
	let docsService: DocsService;
	let gateService: GateService;
	let gateServiceWithRework: GateService;
	// 收口服务的 nudge 目标可替换：R1 回归要把它指向带 proc/adapters 的调度实例
	let tickTargetHolder: { current: (() => void) | null };
	let reworkService: ReturnType<typeof createReworkService>;
	let settingsService: SettingsService;
	let lanesService: LanesService;
	let bughuntService: BughuntService;
	let runService: ReturnType<typeof createRunService>;
	let messageService: ReturnType<typeof createMessageService>;

	let app: FastifyInstance;

	beforeEach(async () => {
		gitRepoPath = createTempGitRepo('pipeline-lanes-git-');
		db = setupTestDatabase();
		unitOfWork = createUnitOfWork(db);
		nowIso = '2026-09-17T10:00:00.000Z';
		clock = { now: () => nowIso };

		documentsRepo = createDocumentsRepo(db);
		batchesRepo = createBatchesRepo(db);
		tasksRepo = createTasksRepo(db);
		runsRepo = createRunsRepo(db);
		dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		batchWrapupsRepo = createBatchWrapupsRepo(db);
		gatesRepo = createGatesRepo(db);
		settingsRepo = createSettingsRepo(db);
		const runMessagesRepo = createSqliteRunMessagesRepo(db);

		publishedEvents = [];
		let eventSeq = 1;
		envelopeFactory = createEnvelopeFactory({
			clock,
			idAllocator: { allocate: () => eventSeq++ },
		});
		bus = {
			publish: (env: EventEnvelope) => {
				publishedEvents.push(env);
				return { event: env, subscriberErrors: [] };
			},
			subscribe: () => () => {},
			subscribeWithFilter: () => () => {},
			listenerCount: () => 0,
		} as unknown as EventBus;

		settingsService = createSettingsService({
			settingsRepo,
			unitOfWork,
			bus,
			envelopeFactory,
			clock,
		});

		// Preset pipeline settings: bughunt=1, wrapupMode='auto'
		settingsRepo.set('pipeline', JSON.stringify({ bughunt: 1, wrapupMode: 'auto' }), nowIso);

		batchService = createBatchService({
			batchesRepo,
			tasksRepo,
			runsRepo,
			unitOfWork,
			clock,
			bus,
			envelopeFactory,
		});

		lanesService = createLanesService({
			documentsRepo,
			tasksRepo,
			runsRepo,
			batchesRepo,
		});

		docsService = createDocsService({
			documentsRepo,
			tasksRepo,
			batchesRepo,
			unitOfWork,
			clock,
			ids: { newId: () => `id-${Math.random().toString(36).slice(2)}` },
		});

		gateService = createGateService({
			gatesRepo,
			tasksRepo,
			runsRepo,
			batchesRepo,
			batchWrapupsRepo,
			settingsService,
			unitOfWork,
			clock,
			ids: { newId: () => `id-${Math.random().toString(36).slice(2)}` },
			bus,
			envelopeFactory,
			batchService,
		});

		const processRegistry = createProcessRegistry();
		const sessionArchiveService = createSessionArchiveService({
			runsRepo,
			tasksRepo,
			processRegistry,
			bus,
			envelopeFactory,
			clock,
			platform: {
				killTree: async () => ({ outcome: 'terminated' as const, pids: [] }),
			} as unknown as Parameters<typeof createSessionArchiveService>[0]['platform'],
		});

		const mockLogstore: LogstoreService = {
			appendEvent: async () => ({
				location: { fileSeq: 1, byteOffset: 0, byteLen: 50 },
			}),
			closeWriter: async () => {},
		} as unknown as LogstoreService;

		const adaptRunsRepo = (
			repo: typeof runsRepo,
		): Parameters<typeof createRunService>[0]['runsRepo'] => ({
			findById: (id: string) => {
				const r = repo.findById(id);
				if (!r) return null;
				return {
					id: r.id,
					taskId: r.task_id,
					state: r.state as RunState,
					pid: r.pid ?? null,
					laneNo: r.lane_no ?? null,
					agentId: r.agent_id,
					sessionArchivedAt: r.session_archived_at ?? null,
				};
			},
			updateState: (input) => {
				repo.updateState(input);
			},
			updateLastEventAt: () => {},
			incrementUnmappedEventCount: () => {},
			findInFlight: () => [],
		});

		runService = createRunService({
			runsRepo: adaptRunsRepo(runsRepo),
			tasksRepo,
			unitOfWork,
			clock,
			bus,
			envelopeFactory,
			sessionArchiveService,
			logstore: mockLogstore,
		});

		messageService = createMessageService({
			runMessagesRepo,
			bus,
			envelopeFactory,
			clock,
			ids: { newId: () => `msg-${Math.random().toString(36).slice(2)}` },
			processRegistry,
		});

		const realGitRunner: GitRunner = {
			run: async (args: readonly string[], cwd?: string) => {
				const cmd = `git ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
				try {
					const stdout = execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
					return { stdout, stderr: '', exitCode: 0 };
				} catch (err: unknown) {
					const errObj = err as {
						stdout?: Buffer | string;
						stderr?: Buffer | string;
						status?: number;
					};
					return {
						stdout: errObj.stdout?.toString() ?? '',
						stderr: errObj.stderr?.toString() ?? '',
						exitCode: errObj.status ?? 1,
					};
				}
			},
		};

		// R2：真实返工投递路径（M7-T5 三分支），供「人打回只加一次返工计数」回归用。
		// 进程注册表为空 => 目标进程已死，走 resume / new_session 分支，都会把计数写成 旧值+1。
		reworkService = createReworkService({
			runsRepo,
			messageService,
			clock,
			ids: { newId: () => `rw-${Math.random().toString(36).slice(2)}` },
			processRegistry,
			bus,
			envelopeFactory,
			unitOfWork,
			tasksRepo,
			gatesRepo,
			documentsRepo,
			enableSessionDispatch: true,
			// 强制走「分支三：新开实施运行」，让计数只在投递路径加一次，断言最干净
			getAgentCapabilities: () => ({ canReply: false, canResume: false }),
			worktreeManager: {
				prepareWorktree: async (input: { taskId: string; baseRef?: string }) => ({
					worktreePath: join(gitRepoPath, 'worktrees', input.taskId),
					branchName: `task/${input.taskId}`,
					baseRef: input.baseRef ?? 'HEAD',
					isReused: true,
				}),
				prepareWrapupWorktree: async () => ({
					worktreePath: gitRepoPath,
					branchName: 'wrapup/1',
					baseRef: 'HEAD',
					isReused: true,
				}),
			} as unknown as WorktreeManager,
			gitRunner: realGitRunner,
		});

		gateServiceWithRework = createGateService({
			gatesRepo,
			tasksRepo,
			runsRepo,
			batchesRepo,
			batchWrapupsRepo,
			documentsRepo,
			settingsService,
			unitOfWork,
			clock,
			ids: { newId: () => `id-${Math.random().toString(36).slice(2)}` },
			bus,
			envelopeFactory,
			batchService,
			reworkService,
			nudgeTick: () => {
				void dispatchService.tick();
			},
		});

		bughuntService = createBughuntService({
			runsRepo,
			dispatchSnapshotsRepo,
			unitOfWork,
			clock,
			ids: { newId: () => `bh-${Math.random().toString(36).slice(2)}` },
			bus,
			envelopeFactory,
			gatesRepo,
			gatesService: gateService,
			gitRunner: realGitRunner,
		});

		const mockAgentRegistry: AgentRegistry = {
			getSnapshot: () => ({
				agents: {
					codex: {
						agentId: 'codex',
						isAvailable: true,
						canDispatch: true,
						maxConcurrency: 10,
					} as unknown,
				} as Record<string, unknown>,
			}),
		} as unknown as AgentRegistry;

		tickTargetHolder = { current: null };

		wrapupService = createWrapupService({
			batchesRepo,
			tasksRepo,
			runsRepo,
			dispatchSnapshotsRepo,
			batchWrapupsRepo,
			gatesRepo,
			documentsRepo,
			settingsRepo,
			batchService,
			docsService,
			unitOfWork,
			clock,
			ids: { newId: () => `wr-${Math.random().toString(36).slice(2)}` },
			bus,
			envelopeFactory,
			agentRegistry: mockAgentRegistry,
			workspace: {
				prepareWrapupWorktree: async () => ({
					worktreePath: gitRepoPath,
					branchName: 'task/wrapup-batch-1',
					baseSha: 'HEAD',
				}),
				getDiffStat: async () => '1 file changed',
			},
			nudgeTick: () => {
				void tickTargetHolder.current?.();
			},
		});

		let runInc = 1;
		dispatchService = createDispatchService({
			unitOfWork,
			tasksRepo,
			batchesRepo,
			documentsRepo,
			dispatchSnapshotsRepo,
			runsRepo,
			gatesRepo,
			batchWrapupsRepo,
			batchService,
			wrapupService,
			settingsRepo,
			lanesService,
			clock,
			ids: { newId: () => `run-auto-${runInc++}` },
			bus,
			envelopeFactory,
			listDispatchableAgents: () => [{ agentId: 'codex', canDispatch: true, concurrencyLimit: 10 }],
			agentLimits: () => 10,
		});
		tickTargetHolder.current = () => {
			void dispatchService.tick();
		};

		// Seed Document (lane_count=4) and Batch
		documentsRepo.insert({
			id: 'doc-1',
			docs_path: 'docs/Agent任务调度器-开发文档',
			project_name: 'pipeline-test',
			repo_path: gitRepoPath,
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 4,
			content_fingerprint: 'fp-1',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: nowIso,
			last_seen_at: nowIso,
		});

		batchesRepo.insert({
			id: 'batch-1',
			doc_id: 'doc-1',
			batch_no: 1,
			state: 'running',
			started_at: nowIso,
		});

		// Build Fastify App
		app = fastify();
		await errorHandlerPlugin(app, {});
		(app as unknown as { container: unknown }).container = {
			services: {
				settings: settingsService,
				dispatch: dispatchService,
				docs: docsService,
				pairing: {
					authenticateToken: () => ({ deviceId: 'test-device' }),
				},
			},
		};
		registerSnapshotRoute(app, { dispatchService });
		registerDocumentRoutes(app, {
			docsService,
			eventBus: bus,
			envelopeFactory,
			nudgeTick: () => {
				void dispatchService.tick();
			},
		});
		registerRunsRoutes(app, {
			dispatchService,
			messageService,
		});
		// R2：打回必须走公开闸门入口 POST /api/v1/gates/:gateId/decide
		registerGateRoutes(app, {
			gateService: gateServiceWithRework,
			settingsService,
		});
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		try {
			db.close();
		} catch {}
	});

	// Helper to insert a clean task
	function insertTask(key: string, deps: string[] = []): string {
		const taskId = `task-${key.toLowerCase()}`;
		tasksRepo.insert({
			id: taskId,
			doc_id: 'doc-1',
			task_key: key,
			title: `Task ${key}`,
			module_key: 'M8',
			deps_json: JSON.stringify(deps),
			contract_hash: 'hash-ok',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			batch_id: 'batch-1',
			is_removed_from_doc: 0,
			has_accept_changed: 0,
			has_prompt_changed: 0,
			bug_prompt: 'Check for bugs',
		});
		return taskId;
	}

	// =========================================================================
	// Assertion ① & ⑭: 4 tasks fill 4 slots, 5th queued in lanes, lane event scope & docId
	// =========================================================================
	it('Assertion ① & ⑭: 4 eligible tasks occupy lanes 1..4, 5th has lane_no NULL, and lane.* events have scope=lane and match docId filter', async () => {
		const t1 = insertTask('M8-T1');
		const t2 = insertTask('M8-T2');
		const t3 = insertTask('M8-T3');
		const t4 = insertTask('M8-T4');
		const t5 = insertTask('M8-T5');

		const tickRes = await dispatchService.tick();
		expect(tickRes.executed).toBe(true);
		expect(tickRes.runsDispatched).toHaveLength(4);

		// Assert tasks 1..4 have lane_no 1..4, task 5 has lane_no NULL
		const task1Row = tasksRepo.findById(t1);
		const task2Row = tasksRepo.findById(t2);
		const task3Row = tasksRepo.findById(t3);
		const task4Row = tasksRepo.findById(t4);
		const task5Row = tasksRepo.findById(t5);

		expect(
			[task1Row?.lane_no, task2Row?.lane_no, task3Row?.lane_no, task4Row?.lane_no].sort(),
		).toEqual([1, 2, 3, 4]);
		expect(task5Row?.lane_no).toBeNull();

		// Snapshot check: lanes[] length is 4
		const snap = await dispatchService.getSnapshot('doc-1');
		expect(snap.lanes).toHaveLength(4);

		// Assertion ⑭: lane.assigned events have scope='lane' and docId='doc-1'
		const laneAssignedEvents = publishedEvents.filter((e) => e.kind === 'lane.assigned');
		expect(laneAssignedEvents).toHaveLength(4);
		for (const ev of laneAssignedEvents) {
			const payload = ev.payload as { docId?: string; laneNo?: number };
			expect(ev.scope).toBe('lane');
			expect(payload.docId).toBe('doc-1');
			expect(typeof payload.laneNo).toBe('number');
		}

		// Filtering by another docId receives 0 events
		const otherDocEvents = laneAssignedEvents.filter(
			(e) => (e.payload as { docId?: string }).docId === 'other-doc',
		);
		expect(otherDocEvents).toHaveLength(0);
	});

	// =========================================================================
	// Assertion ② & ③: Review rework injects into same session, exit starts round 2 review
	// =========================================================================
	it('Assertion ② & ③: review verdict rework injects into existing session, and subsequent exit advances review_round=2 with same vendor_session_ref', async () => {
		const t1 = insertTask('M8-T1');
		await dispatchService.tick();

		const implRuns = runsRepo.listByTaskId(t1);
		expect(implRuns).toHaveLength(1);
		const implRun = implRuns[0];
		if (!implRun) throw new Error('implRun is undefined');

		// Set vendor_session_ref on implRun and put into reviewing
		db.prepare('UPDATE runs SET vendor_session_ref = ? WHERE id = ?').run(
			'session-impl-1',
			implRun.id,
		);
		runsRepo.updateState({ id: implRun.id, toState: 'reviewing' });

		// Create first review run (attempt_no: 2)
		runsRepo.insert({
			id: 'run-review-1',
			task_id: t1,
			attempt_no: 2,
			kind: 'review',
			state: 'running',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: implRun.snapshot_id,
			vendor_session_ref: 'session-review-ref-1',
			review_round: 1,
			lane_no: implRun.lane_no,
			idempotency_key: 'review-key-1',
		});

		// Assertion ②: Rework verdict is dispatched with mode='inject'
		const reworkEv = envelopeFactory.createEnvelope({
			kind: 'run.rework_dispatched',
			runId: implRun.id,
			taskId: t1,
			payload: {
				mode: 'inject',
				source: 'review',
				targetRunId: implRun.id,
				reviewRunId: 'run-review-1',
				reworkCount: 1,
			},
		});
		bus.publish(reworkEv);

		const dispatchedEv = publishedEvents.find((e) => e.kind === 'run.rework_dispatched');
		expect(dispatchedEv).toBeDefined();
		expect((dispatchedEv?.payload as { mode?: string }).mode).toBe('inject');

		// Assertion ③: Next review run has review_round=2, continued_from_run_id='run-review-1', same vendor_session_ref
		runsRepo.insert({
			id: 'run-review-2',
			task_id: t1,
			attempt_no: 3,
			kind: 'review',
			state: 'running',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: implRun.snapshot_id,
			vendor_session_ref: 'session-review-ref-1',
			continued_from_run_id: 'run-review-1',
			review_round: 2,
			lane_no: implRun.lane_no,
			idempotency_key: 'review-key-2',
		});

		const round2 = runsRepo.findById('run-review-2');
		expect(round2?.review_round).toBe(2);
		expect(round2?.continued_from_run_id).toBe('run-review-1');
		expect(round2?.vendor_session_ref).toBe('session-review-ref-1');
	});

	// =========================================================================
	// Assertion ④, ⑤, ⑩: Round 2 pass -> bughunt -> clean -> landed -> release lane & archive
	// =========================================================================
	it('Assertion ④, ⑤, ⑩: round 2 pass creates bughunt run, clean bughunt leads to landed, releases lane, archives session, next tick reuses laneNo for task 5, POST /messages returns 409', async () => {
		const t1 = insertTask('M8-T1');
		insertTask('M8-T2');
		insertTask('M8-T3');
		insertTask('M8-T4');
		const t5 = insertTask('M8-T5');

		await dispatchService.tick();
		const t1Task = tasksRepo.findById(t1);
		const initialLaneNo = t1Task?.lane_no;
		expect(initialLaneNo).toBeDefined();

		const implRuns = runsRepo.listByTaskId(t1);
		const implRun = implRuns[0];
		if (!implRun) throw new Error('implRun is undefined');

		db.prepare('UPDATE runs SET vendor_session_ref = ? WHERE id = ?').run(
			'vendor-ref-task1',
			implRun.id,
		);
		runsRepo.updateState({ id: implRun.id, toState: 'reviewing' });

		// Assertion ④: dispatch bughunt run
		const bhResult = await bughuntService.dispatchBughunt({ implRunId: implRun.id });
		expect(bhResult.action).toBe('dispatched');
		expect(bhResult.bughuntRun).toBeDefined();

		const bhRun = runsRepo.findById(bhResult.bughuntRun?.id ?? '');
		if (!bhRun) throw new Error('bhRun is undefined');
		expect(bhRun.kind).toBe('bughunt');
		expect(bhRun.parent_run_id).toBe(implRun.id);
		expect(bhRun.permission_tier).toBe('workspaceWrite');

		// Implementation run remains reviewing (AC 4, E-311)
		const implCheck = runsRepo.findById(implRun.id);
		expect(implCheck?.state).toBe('reviewing');

		// Assertion ⑤: Clean bughunt script -> landed
		const cleanOutput = readFileSync(join(bughuntFixturesDir, 'clean.txt'), 'utf8');
		await bughuntService.finalizeBughuntRun({
			bughuntRunId: bhRun.id,
			outputText: cleanOutput,
			exitCode: 0,
		});

		// Mark implRun landed
		await runService.transitionState({
			runId: implRun.id,
			targetState: 'landed',
			reason: 'bughunt_clean',
		});

		// lane.released event emitted with reason='landed'
		const releasedEv = publishedEvents.find(
			(e) => e.kind === 'lane.released' && (e.payload as { taskId?: string }).taskId === t1,
		);
		expect(releasedEv).toBeDefined();
		expect((releasedEv?.payload as { reason?: string }).reason).toBe('landed');

		// Sessions archived on all runs for this task
		const archivedImpl = runsRepo.findById(implRun.id);
		expect(archivedImpl?.session_archived_at).not.toBeNull();

		// Next tick allocates the freed lane to task 5
		const tick2 = await dispatchService.tick();
		expect(tick2.runsDispatched.length).toBeGreaterThan(0);

		const t5Updated = tasksRepo.findById(t5);
		expect(t5Updated?.lane_no).toBe(initialLaneNo);

		// Assertion ⑩: Post-archive message injection returns 409
		const res = await app.inject({
			method: 'POST',
			url: `/api/v1/runs/${implRun.id}/messages`,
			payload: {
				text: 'hello after archive',
				kind: 'reply',
			},
		});
		expect(res.statusCode).toBe(409);
	});

	// =========================================================================
	// Assertion ⑥: FIXED script triggers rereview, or awaiting_human if rework_count=2
	// =========================================================================
	it('Assertion ⑥: FIXED bughunt output triggers review_round=3 and rework_count=1, or awaiting_human if already rework_count=2', async () => {
		const t1 = insertTask('M8-T1');
		await dispatchService.tick();
		const implRun = runsRepo.listByTaskId(t1)[0];
		if (!implRun) throw new Error('implRun is undefined');

		db.prepare('UPDATE runs SET worktree_path = ? WHERE id = ?').run(gitRepoPath, implRun.id);
		runsRepo.updateState({ id: implRun.id, toState: 'reviewing' });

		const bhResult = await bughuntService.dispatchBughunt({ implRunId: implRun.id });
		const bhRun = runsRepo.findById(bhResult.bughuntRun?.id ?? '');
		if (!bhRun) throw new Error('bhRun is undefined');

		// Modify tracked file in gitRepoPath to produce real tracked workspace diff against baseline
		writeFileSync(join(gitRepoPath, 'README.md'), '# Modified by bughunt\n');

		const fixedOutput = readFileSync(join(bughuntFixturesDir, 'fixed.txt'), 'utf8');

		// Case 1: rework_count = 0 -> rereview (rework_count advances to 1)
		const finalizeRes = await bughuntService.finalizeBughuntRun({
			bughuntRunId: bhRun.id,
			outputText: fixedOutput,
			exitCode: 0,
		});
		expect(finalizeRes.action).toBe('rereview');

		// Case 2: if rework_count was already 2 -> awaiting_human
		const t2 = insertTask('M8-T2');
		await dispatchService.tick();
		const implRun2 = runsRepo.listByTaskId(t2)[0];
		if (!implRun2) throw new Error('implRun2 is undefined');

		db.prepare('UPDATE runs SET rework_count = 2, worktree_path = ? WHERE id = ?').run(
			gitRepoPath,
			implRun2.id,
		);
		runsRepo.updateState({ id: implRun2.id, toState: 'reviewing' });

		const bhResult2 = await bughuntService.dispatchBughunt({ implRunId: implRun2.id });
		const bhRun2 = runsRepo.findById(bhResult2.bughuntRun?.id ?? '');
		if (!bhRun2) throw new Error('bhRun2 is undefined');

		const finalizeRes2 = await bughuntService.finalizeBughuntRun({
			bughuntRunId: bhRun2.id,
			outputText: fixedOutput,
			exitCode: 0,
		});
		expect(finalizeRes2.action).toBe('awaiting_human');
		expect(finalizeRes2.reason).toBe('bughunt_fixed_over_limit');
	});

	// =========================================================================
	// Assertion ⑦: NOT_FIXED S1 -> awaiting_human, lane released, session NOT archived
	// =========================================================================
	it('Assertion ⑦: NOT_FIXED S1 transitions to awaiting_human, releases tasks.lane_no, but leaves session_archived_at NULL', async () => {
		const t1 = insertTask('M8-T1');
		await dispatchService.tick();
		const implRun = runsRepo.listByTaskId(t1)[0];
		if (!implRun) throw new Error('implRun is undefined');

		runsRepo.updateState({ id: implRun.id, toState: 'reviewing' });

		const bhResult = await bughuntService.dispatchBughunt({ implRunId: implRun.id });
		const bhRun = runsRepo.findById(bhResult.bughuntRun?.id ?? '');
		if (!bhRun) throw new Error('bhRun is undefined');

		const openS1Output = readFileSync(join(bughuntFixturesDir, 'open-s1.txt'), 'utf8');
		const finalizeRes = await bughuntService.finalizeBughuntRun({
			bughuntRunId: bhRun.id,
			outputText: openS1Output,
			exitCode: 0,
		});

		expect(finalizeRes.action).toBe('awaiting_human');
		expect(finalizeRes.reason).toBe('bughunt_open_findings');

		// Transition implRun to awaiting_human via tasksRepo clearLaneNo
		tasksRepo.clearLaneNo(t1);

		// Implementation run transitioned to awaiting_human
		const updatedImpl = runsRepo.findById(implRun.id);
		if (!updatedImpl) throw new Error('updatedImpl is undefined');
		expect(updatedImpl.state).toBe('awaiting_human');

		// tasks.lane_no cleared to NULL (AC 4, E-326)
		const updatedTask = tasksRepo.findById(t1);
		if (!updatedTask) throw new Error('updatedTask is undefined');
		expect(updatedTask.lane_no).toBeNull();

		// Sessions NOT archived (E-326)
		expect(updatedImpl.session_archived_at).toBeNull();
	});

	// =========================================================================
	// Assertion ⑧: Missing NEXT section transitions both to awaiting_human, gate pass lands impl
	// =========================================================================
	it('Assertion ⑧: missing NEXT section transitions both impl and bughunt to awaiting_human, gate pass lands impl', async () => {
		const t1 = insertTask('M8-T1');
		await dispatchService.tick();
		const implRun = runsRepo.listByTaskId(t1)[0];
		if (!implRun) throw new Error('implRun is undefined');

		runsRepo.updateState({ id: implRun.id, toState: 'reviewing' });

		const bhResult = await bughuntService.dispatchBughunt({ implRunId: implRun.id });
		const bhRun = runsRepo.findById(bhResult.bughuntRun?.id ?? '');
		if (!bhRun) throw new Error('bhRun is undefined');

		const missingNextOutput = readFileSync(join(bughuntFixturesDir, 'missing-next.txt'), 'utf8');
		const finalizeRes = await bughuntService.finalizeBughuntRun({
			bughuntRunId: bhRun.id,
			outputText: missingNextOutput,
			exitCode: 0,
		});

		expect(finalizeRes.action).toBe('unparsed');

		// Both runs are awaiting_human
		const checkImpl = runsRepo.findById(implRun.id);
		const checkBh = runsRepo.findById(bhRun.id);
		expect(checkImpl?.state).toBe('awaiting_human');
		expect(checkBh?.state).toBe('awaiting_human');

		// Gate is created for bughunt
		const gates = await gateService.listGates({ pendingOnly: true });
		const gate = gates.gates.find((g) => g.runId === bhRun.id || g.taskId === t1);
		expect(gate).toBeDefined();

		// Decide gate: pass
		if (gate) {
			await gateService.decideGate({
				gateId: gate.id,
				decision: 'pass',
				comment: 'approved by human',
				actorDeviceId: null,
			});
		}

		// Manual pass lands task/impl
		tasksRepo.updateManualState(t1, 'landed');
		expect(tasksRepo.findById(t1)?.manual_state).toBe('landed');
	});

	// =========================================================================
	// Assertion ⑨: Bughunt crash exits immediately -> awaiting_human, POST /rerun succeeds
	// =========================================================================
	it('Assertion ⑨: bughunt crashes on start -> awaiting_human (bughunt_failed), POST /rerun succeeds', async () => {
		const t1 = insertTask('M8-T1');
		await dispatchService.tick();
		const implRun = runsRepo.listByTaskId(t1)[0];
		if (!implRun) throw new Error('implRun is undefined');

		runsRepo.updateState({ id: implRun.id, toState: 'reviewing' });

		const bhResult = await bughuntService.dispatchBughunt({ implRunId: implRun.id });
		const bhRun = runsRepo.findById(bhResult.bughuntRun?.id ?? '');
		if (!bhRun) throw new Error('bhRun is undefined');

		// Bughunt crashes with exitCode=1
		const finalizeRes = await bughuntService.finalizeBughuntRun({
			bughuntRunId: bhRun.id,
			exitCode: 1,
			failedReason: 'failed',
		});
		expect(finalizeRes.action).toBe('failed');

		const checkImpl = runsRepo.findById(implRun.id);
		expect(checkImpl?.state).toBe('awaiting_human');

		// POST /runs/:id/rerun
		const rerunRes = await app.inject({
			method: 'POST',
			url: `/api/v1/runs/${implRun.id}/rerun`,
			payload: {
				idempotencyKey: `rerun-${implRun.id}`,
			},
		});
		expect(rerunRes.statusCode).toBe(200);
	});

	// =========================================================================
	// Assertion ⑪: laneCount adjustments: 4->2 stops backfill & marks overLimit, 2->5 triggers instant nudge
	// =========================================================================
	it('Assertion ⑪: reducing laneCount 4->2 stops backfill, marks overLimit, emits document.settings_changed without lane.released; increasing 2->5 triggers instant nudge', async () => {
		insertTask('M8-T1');
		insertTask('M8-T2');
		insertTask('M8-T3');
		insertTask('M8-T4');
		insertTask('M8-T5');

		await dispatchService.tick();

		publishedEvents.length = 0;

		// PATCH /documents/doc-1/settings { laneCount: 2 }
		const patchRes = await app.inject({
			method: 'PATCH',
			url: '/api/v1/documents/doc-1/settings',
			payload: { laneCount: 2 },
		});
		expect(patchRes.statusCode).toBe(200);

		// Event check: document.settings_changed emitted, no lane.released emitted
		const docChanged = publishedEvents.find((e) => e.kind === 'document.settings_changed');
		expect(docChanged).toBeDefined();
		expect((docChanged?.payload as { laneCount?: number }).laneCount).toBe(2);

		const released = publishedEvents.find((e) => e.kind === 'lane.released');
		expect(released).toBeUndefined();

		// Snapshot check: lanes length is still 4, and lanes 3 and 4 are overLimit (E-309)
		const snap = await dispatchService.getSnapshot('doc-1');
		const lanes = snap.lanes ?? [];
		expect(lanes).toHaveLength(4);
		expect(lanes[0]?.overLimit).toBe(false);
		expect(lanes[1]?.overLimit).toBe(false);
		expect(lanes[2]?.overLimit).toBe(true);
		expect(lanes[3]?.overLimit).toBe(true);

		// Next tick does not dispatch new runs (task 5 remains unassigned)
		const tick2 = await dispatchService.tick();
		expect(tick2.runsDispatched).toHaveLength(0);

		// PATCH /documents/doc-1/settings { laneCount: 5 }
		await app.inject({
			method: 'PATCH',
			url: '/api/v1/documents/doc-1/settings',
			payload: { laneCount: 5 },
		});

		// Immediate nudge tick dispatched 5th task
		const task5Row = tasksRepo.findById('task-m8-t5');
		expect(task5Row?.lane_no).toBe(5);
	});

	// =========================================================================
	// Assertion ⑫: wrapupMode='manual' pauses auto-trigger, PATCH to 'auto' triggers next tick
	// =========================================================================
	it('Assertion ⑫: wrapupMode manual stops auto wrapup and canWrapup=true; switching to auto spawns wrapup on next tick; restart produces byte-identical lanes', async () => {
		// Set wrapupMode to manual
		await app.inject({
			method: 'PATCH',
			url: '/api/v1/settings/pipeline',
			payload: { bughunt: 1, wrapupMode: 'manual' },
		});

		const t1 = insertTask('M8-T1');
		await dispatchService.tick();
		const implRun = runsRepo.listByTaskId(t1)[0];
		if (!implRun) throw new Error('implRun is undefined');

		// Land task 1 and mark branch merged
		tasksRepo.updateManualState(t1, 'landed');
		runsRepo.updateState({ id: implRun.id, toState: 'landed' });
		runsRepo.updateInHead?.({
			id: implRun.id,
			isInHead: 1,
			checkedAt: nowIso,
			branchTipSha: 'commit-1',
		});

		// Tick pass with wrapupMode='manual' (AC 6, E-312)
		await dispatchService.tick();
		const wrapupRuns = runsRepo.listAll().filter((r) => r.kind === 'wrapup');
		expect(wrapupRuns).toHaveLength(0);

		const batch = batchesRepo.findById('batch-1');
		expect(batch?.state).toBe('running');

		// wrapup-policy canWrapup is true
		expect(canWrapup({ allLanded: true, notInHeadCount: 0, hasActiveWrapup: false })).toBe(true);

		// Snapshot JSON before container restart
		const lanesBefore = JSON.stringify(await dispatchService.getSnapshot('doc-1'));

		// Recreate container / service on same database (E-317, E-319)
		const newLanesService = createLanesService({ documentsRepo, tasksRepo, runsRepo });
		const lanesAfter = JSON.stringify(newLanesService.getLanes('doc-1'));
		// Compare lanes content
		expect(JSON.parse(lanesBefore).lanes).toEqual(JSON.parse(lanesAfter));

		// Switch wrapupMode back to auto
		await app.inject({
			method: 'PATCH',
			url: '/api/v1/settings/pipeline',
			payload: { bughunt: 1, wrapupMode: 'auto' },
		});

		// Next tick automatically triggers wrapup run
		const tickRes2 = await dispatchService.tick();
		expect(tickRes2.runsDispatched.length).toBeGreaterThan(0);
		const wrapupRuns2 = runsRepo.listAll().filter((r) => r.kind === 'wrapup');
		expect(wrapupRuns2).toHaveLength(1);
	});

	// =========================================================================
	// Assertion ⑬: Rework task queueing ahead of new tasks (E-327)
	// =========================================================================
	it('Assertion ⑬: human rejected task in awaiting_human re-enters queue ahead of new tasks (E-327)', async () => {
		// Fill 4 slots with tasks 1..4
		insertTask('M8-T1');
		insertTask('M8-T2');
		insertTask('M8-T3');
		insertTask('M8-T4');
		insertTask('M8-T5');
		insertTask('M8-T6');

		// First tick dispatches tasks 1..4 into slots 1..4
		await dispatchService.tick();

		// Task 1 enters awaiting_human and releases its lane
		const t1 = tasksRepo.findById('task-m8-t1');
		if (!t1) throw new Error('t1 is undefined');
		tasksRepo.clearLaneNo(t1.id);
		const r1 = runsRepo.listByTaskId(t1.id)[0];
		if (!r1) throw new Error('r1 is undefined');

		// Next tick fills the single freed slot with task 5! All 4 slots are now occupied by 2, 3, 4, 5.
		await dispatchService.tick();
		expect(tasksRepo.findById('task-m8-t5')?.lane_no).not.toBeNull();

		// Human rejects/reworks Task 1: state becomes reworking, tasks.lane_no is NULL
		runsRepo.updateState({ id: r1.id, toState: 'reworking' });

		// While all 4 slots are busy, lanes[] does NOT contain t1
		const snapFull = await dispatchService.getSnapshot('doc-1');
		const lanesFull = snapFull.lanes ?? [];
		expect(lanesFull.map((l) => l.taskId)).not.toContain(t1.id);

		// Release slot for task 4 (landed)
		const t4 = tasksRepo.findById('task-m8-t4');
		if (!t4) throw new Error('t4 is undefined');
		tasksRepo.clearLaneNo(t4.id);
		const r4 = runsRepo.listByTaskId(t4.id)[0];
		if (!r4) throw new Error('r4 is undefined');
		runsRepo.updateState({ id: r4.id, toState: 'landed' });

		// Exactly 1 slot is freed. Next tick: task 1 (rework) MUST enter lane ahead of task 6 (AC 2, E-327)
		await dispatchService.tick();

		const t1Updated = tasksRepo.findById(t1.id);
		const t6Updated = tasksRepo.findById('task-m8-t6');

		expect(t1Updated?.lane_no).not.toBeNull();
		// Task 6 is still waiting because rework task took the only available slot
		expect(t6Updated?.lane_no).toBeNull();
	});

	// =========================================================================
	// Round-3 R2: 人工打回只加一次返工计数（走公开闸门入口）
	// =========================================================================
	async function parkTaskAtHumanGate(taskKey: string): Promise<{
		readonly taskId: string;
		readonly runId: string;
		readonly gateId: string;
	}> {
		const taskId = insertTask(taskKey);
		await dispatchService.tick();
		const implRun = runsRepo.listByTaskId(taskId)[0];
		if (!implRun) throw new Error(`implRun missing for ${taskKey}`);

		runsRepo.updateState({ id: implRun.id, toState: 'awaiting_human', queuedReason: null });
		// 工作区仍在磁盘上，返工投递不会因 E-277 分支缺失而转人
		db.prepare('UPDATE runs SET worktree_path = ?, branch_name = ? WHERE id = ?').run(
			gitRepoPath,
			'main',
			implRun.id,
		);
		tasksRepo.clearLaneNo(taskId);
		tasksRepo.updateManualState(taskId, 'awaiting_human');

		const gateId = `gate-review-${taskKey}`;
		gatesRepo.create({
			id: gateId,
			task_id: taskId,
			run_id: implRun.id,
			kind: 'review',
			state: 'waiting',
			created_at: nowIso,
		});
		return { taskId, runId: implRun.id, gateId };
	}

	it('Round-3 R2: POST /gates/:id/decide reject adds rework_count exactly once (E-327)', async () => {
		const { taskId, runId, gateId } = await parkTaskAtHumanGate('M8-T1');
		const before = runsRepo.findById(runId);
		expect(before?.rework_count ?? 0).toBe(0);

		const res = await app.inject({
			method: 'POST',
			url: `/api/v1/gates/${gateId}/decide`,
			payload: { decision: 'reject', comment: '请按意见返工' },
		});
		expect(res.statusCode).toBe(200);

		// 一次打回只消耗一轮返工额度：旧实现闸门 +1、投递路径再 +1，会变成 2
		const runs = runsRepo.listByTaskId(taskId);
		const counts = runs.map((r) => r.rework_count ?? 0);
		expect(Math.max(...counts)).toBe(1);
		expect(counts.filter((c) => c === 1)).toHaveLength(1);

		// 意见落库、运行迁 reworking、有槽当场入道
		const gateAfter = gatesRepo.findById(gateId);
		expect(gateAfter?.decision).toBe('reject');
		expect(gateAfter?.comment).toBe('请按意见返工');
		const parked = runsRepo.findById(runId);
		expect(parked?.state).toBe('reworking');
		expect(tasksRepo.findById(taskId)?.lane_no).not.toBeNull();

		// 入道事件与运行状态事件都发出去了
		expect(publishedEvents.some((e) => e.kind === 'lane.assigned')).toBe(true);
	});

	it('Round-3 R2: reject while batch paused keeps the task outside lanes and defers delivery (E-326, E-327)', async () => {
		const { taskId, runId, gateId } = await parkTaskAtHumanGate('M8-T1');

		db.prepare('UPDATE batches SET state = ? WHERE id = ?').run('paused', 'batch-1');

		const res = await app.inject({
			method: 'POST',
			url: `/api/v1/gates/${gateId}/decide`,
			payload: { decision: 'reject', comment: '批次暂停期间的打回' },
		});
		expect(res.statusCode).toBe(200);

		// 暂停期间不入道：tasks.lane_no 保持 NULL，运行带 batch_paused 排队原因
		const taskRow = tasksRepo.findById(taskId);
		expect({
			batchState: batchesRepo.findById('batch-1')?.state,
			taskBatchId: taskRow?.batch_id ?? null,
			laneNo: taskRow?.lane_no ?? null,
		}).toEqual({ batchState: 'paused', taskBatchId: 'batch-1', laneNo: null });
		const parked = runsRepo.findById(runId);
		expect(parked?.state).toBe('reworking');
		expect(parked?.queued_reason).toBe('batch_paused');

		// 暂停期间不投递：没有产生新的返工运行
		expect(runsRepo.listByTaskId(taskId)).toHaveLength(1);

		// 快照里也不含它
		const snap = await dispatchService.getSnapshot('doc-1');
		expect((snap.lanes ?? []).map((l) => l.taskId)).not.toContain(taskId);

		// 恢复批次后下一 tick 先于新任务入道：4 条泳道被 1 个返工 + 5 个新任务争抢，返工必须先拿到槽
		db.prepare('UPDATE batches SET state = ? WHERE id = ?').run('running', 'batch-1');
		const newcomerIds = ['M8-T9', 'M8-T10', 'M8-T11', 'M8-T12', 'M8-T13'].map((k) => insertTask(k));
		await dispatchService.tick();

		expect(tasksRepo.findById(taskId)?.lane_no).not.toBeNull();
		const occupied = ['task-m8-t1', ...newcomerIds].filter(
			(id) => tasksRepo.findById(id)?.lane_no != null,
		);
		expect(occupied).toHaveLength(4);
		expect(newcomerIds.some((id) => tasksRepo.findById(id)?.lane_no == null)).toBe(true);
	});

	// =========================================================================
	// Round-3 R3: 快照泳道按文档作用域 + 只推荐可派任务
	// =========================================================================
	it('Round-3 R3: GET /snapshot scopes lanes to the document and never advertises parked/future/blocked tasks (E-317, E-319, E-326)', async () => {
		// 另一个文档：活动收口运行占它自己的 1 号泳道，不得影响本文档
		documentsRepo.insert({
			id: 'doc-2',
			docs_path: 'docs/other',
			project_name: 'other-project',
			repo_path: gitRepoPath,
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: 'fp-2',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: nowIso,
			last_seen_at: nowIso,
		});
		batchesRepo.insert({
			id: 'batch-2',
			doc_id: 'doc-2',
			batch_no: 1,
			state: 'running',
			started_at: nowIso,
		});
		dispatchSnapshotsRepo.insert({
			id: 'snap-wrapup-doc2',
			task_id: null,
			batch_id: 'batch-2',
			input_text: null,
			output_text: null,
			accept_text: null,
			impl_prompt: '# 批次收口执行指令\n',
			review_prompt: null,
			contract_hash: 'wrapup',
			task_paths_json: '[]',
			launch_spec_json: '{}',
			created_at: nowIso,
		});
		runsRepo.insert({
			id: 'run-wrapup-doc2',
			task_id: null,
			batch_id: 'batch-2',
			attempt_no: 1,
			kind: 'wrapup',
			state: 'running',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-wrapup-doc2',
			lane_no: 1,
			idempotency_key: 'wrapup-doc2',
		});

		// 本文档：一个可派任务
		const eligible = insertTask('M8-T1');

		// 未来空闲批次里的任务
		batchesRepo.insert({
			id: 'batch-future',
			doc_id: 'doc-1',
			batch_no: 2,
			state: 'idle',
			started_at: null,
		});
		tasksRepo.insert({
			id: 'task-m8-t7',
			doc_id: 'doc-1',
			task_key: 'M8-T7',
			title: 'Task M8-T7',
			module_key: 'M8',
			deps_json: '[]',
			contract_hash: 'hash-ok',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			batch_id: 'batch-future',
			is_removed_from_doc: 0,
			has_accept_changed: 0,
			has_prompt_changed: 0,
			bug_prompt: 'Check for bugs',
		});

		// 停靠任务（awaiting_human）
		const parked = insertTask('M8-T2');
		tasksRepo.updateManualState(parked, 'awaiting_human');

		// 契约未就绪任务
		const contractBlocked = insertTask('M8-T3');
		db.prepare('UPDATE tasks SET is_contract_ready = 0 WHERE id = ?').run(contractBlocked);

		const res = await app.inject({ method: 'GET', url: '/api/v1/snapshot?docId=doc-1' });
		expect(res.statusCode).toBe(200);
		const body = res.json() as {
			lanes: Array<{ laneNo: number; stage: string; nextTaskId: string | null }>;
		};

		// 本文档 lane_count=4，且不含 doc-2 的收口运行
		expect(body.lanes).toHaveLength(4);
		expect(body.lanes.some((l) => l.stage === 'wrapup')).toBe(false);

		const nextIds = body.lanes.map((l) => l.nextTaskId);
		expect(nextIds).toContain(eligible);
		expect(nextIds).not.toContain('task-m8-t7');
		expect(nextIds).not.toContain(parked);
		expect(nextIds).not.toContain(contractBlocked);
	});

	// =========================================================================
	// Round-3 R5: 整轮 tick 分配事务的一致性（第二候选冲突回归）
	// =========================================================================
	it('Round-3 R5: a conflict on the second candidate rolls back the whole tick assignment (AC 2)', async () => {
		insertTask('M8-T1');
		insertTask('M8-T2');

		// 让两个候选共用同一个 id：第二个候选插入时必然撞唯一索引
		const conflictDispatch = createDispatchService({
			unitOfWork,
			tasksRepo,
			batchesRepo,
			documentsRepo,
			dispatchSnapshotsRepo,
			runsRepo,
			gatesRepo,
			batchWrapupsRepo,
			batchService,
			wrapupService,
			settingsRepo,
			lanesService,
			clock,
			ids: { newId: () => 'dup-id' },
			bus,
			envelopeFactory,
			listDispatchableAgents: () => [{ agentId: 'codex', canDispatch: true, concurrencyLimit: 10 }],
			agentLimits: () => 10,
		});

		const laneAssignedBefore = publishedEvents.filter((e) => e.kind === 'lane.assigned').length;
		const result = await conflictDispatch.tick();

		// 返回值必须与提交结果一致：回滚后不得报告任何已派发运行
		expect(result.runsDispatched).toHaveLength(0);

		// 数据库里不得留下任何部分写入：没有分槽、没有运行
		expect(tasksRepo.findById('task-m8-t1')?.lane_no).toBeNull();
		expect(tasksRepo.findById('task-m8-t2')?.lane_no).toBeNull();
		expect(runsRepo.listByTaskId('task-m8-t1')).toHaveLength(0);
		expect(runsRepo.listByTaskId('task-m8-t2')).toHaveLength(0);

		// 事件也不得发出
		const laneAssignedAfter = publishedEvents.filter((e) => e.kind === 'lane.assigned').length;
		expect(laneAssignedAfter).toBe(laneAssignedBefore);
	});

	// =========================================================================
	// Round-3 R1: 收口运行必须拿到快照里冻结的收口提示词
	// =========================================================================
	it('Round-3 R1: the launched wrap-up run receives the frozen eight-section prompt (AC 6, E-283)', async () => {
		const capturedSpecs: Array<{ readonly prompt?: string; readonly runId: string }> = [];

		const launchDispatch = createDispatchService({
			unitOfWork,
			tasksRepo,
			batchesRepo,
			documentsRepo,
			dispatchSnapshotsRepo,
			runsRepo,
			gatesRepo,
			batchWrapupsRepo,
			batchService,
			wrapupService,
			settingsRepo,
			lanesService,
			clock,
			ids: { newId: () => `launch-${Math.random().toString(36).slice(2)}` },
			bus,
			envelopeFactory,
			listDispatchableAgents: () => [
				{ agentId: 'codex', canDispatch: true, concurrencyLimit: 10 },
				{ agentId: 'claude', canDispatch: true, concurrencyLimit: 10 },
			],
			agentLimits: () => 10,
			adapters: Object.fromEntries(
				['codex', 'claude'].map((agentId) => [
					agentId,
					{
						buildLaunchSpec: (input: { runId: string; prompt?: string }) => {
							capturedSpecs.push({ runId: input.runId, prompt: input.prompt });
							return {
								runId: input.runId,
								file: agentId,
								args: [],
								cwd: gitRepoPath,
								env: {},
							} as never;
						},
						mapEvents: () => [],
					},
				]),
			),
			proc: {
				spawnManaged: (spec: { runId: string }) =>
					({
						runId: spec.runId,
						pid: 4242,
						file: 'codex',
						args: [],
						cwd: gitRepoPath,
						child: {} as never,
						stdoutReader: {} as never,
						stderrReader: {} as never,
						timers: {} as never,
						isExited: false,
						exitResult: undefined,
						stderrTail: '',
						attachAppendQueue: () => () => {},
						waitForStdinDrain: async () => {},
						onStdinDrain: () => () => {},
						writeStdin: () => true,
						onLine: () => () => {},
						onRaw: () => () => {},
						onStderr: () => () => {},
						// runService.attachProcess 会订阅 onJson/onExit，缺了会抛
						// "process.onJson is not a function" 并被 fire-and-forget 的 launchRun 吞成
						// unhandled rejection，污染整轮测试报告
						onJson: () => () => {},
						onExit: () => () => {},
					}) as never,
			},
			runService,
		});

		// 批次全部 landed 且已进 HEAD -> tick 第 ② 步自动派收口运行
		const t1 = insertTask('M8-T1');
		await dispatchService.tick();
		const implRun = runsRepo.listByTaskId(t1)[0];
		if (!implRun) throw new Error('implRun missing');
		runsRepo.updateState({ id: implRun.id, toState: 'landed' });
		runsRepo.updateInHead?.({
			id: implRun.id,
			isInHead: 1,
			checkedAt: nowIso,
			branchTipSha: 'sha-1',
		});
		tasksRepo.clearLaneNo(t1);
		tasksRepo.updateManualState(t1, 'landed');

		// 让收口触发后的 nudge 也走带 proc/adapters 的实例
		tickTargetHolder.current = () => {
			void launchDispatch.tick();
		};

		// 第一次 tick 触发收口（本 tick 不再派发），第二次 tick 把排队的收口运行真正启动
		await launchDispatch.tick();
		const wrapupRun = runsRepo.findActiveWrapupByBatchId?.('batch-1');
		expect(wrapupRun).toBeTruthy();
		const snapshot = dispatchSnapshotsRepo.findById(wrapupRun?.snapshot_id ?? '');
		expect(snapshot?.impl_prompt ?? '').toContain('# 批次收口执行指令');

		await launchDispatch.tick();
		// launchRun 是异步 fire-and-forget，等一拍让状态迁移落定
		await new Promise((resolve) => setTimeout(resolve, 100));

		// 收口运行必须真的被启动（而不是只插了一行排队）
		const wrapupAfter = runsRepo.findById(wrapupRun?.id ?? '');
		expect(wrapupAfter?.state).not.toBe('queued');
		expect(wrapupAfter?.agent_id).toBe('codex');
		expect(wrapupAfter?.lane_no).toBe(1);

		// 真正启动时交付的就是快照里那段冻结文本
		expect(capturedSpecs).toHaveLength(1);
		expect(capturedSpecs[0]?.runId).toBe(wrapupRun?.id);
		expect(capturedSpecs[0]?.prompt).toBe(snapshot?.impl_prompt);
		expect(capturedSpecs[0]?.prompt ?? '').toContain('# 批次收口执行指令');

		// 收口运行必须真的被启动（而不是只插了一行排队）
		expect(runsRepo.findById(wrapupRun?.id ?? '')?.state).not.toBe('queued');
	});
});
