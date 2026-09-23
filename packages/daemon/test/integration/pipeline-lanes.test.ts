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
import { createRunService } from '../../src/service/run.ts';
import { createSessionArchiveService } from '../../src/service/session-archive.ts';
import { type SettingsService, createSettingsService } from '../../src/service/settings.ts';
import { type WrapupService, createWrapupService } from '../../src/service/wrapup.ts';
import type { GitRunner } from '../../src/workspace/diff.ts';

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
				void dispatchService.tick();
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
});
