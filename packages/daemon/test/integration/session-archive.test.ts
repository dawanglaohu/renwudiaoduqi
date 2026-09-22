import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import type { RunState } from '../../src/domain/run-state-machine.ts';
import { AppError } from '../../src/errors/app-error.ts';
import type { EventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createProcessRegistry } from '../../src/proc/registry.ts';
import type { ManagedProcess } from '../../src/proc/spawn.ts';
import { createSqliteRunMessagesRepo } from '../../src/repo/run-messages-repo.ts';
import { createRunsRepo } from '../../src/repo/runs.ts';
import { createTasksRepo } from '../../src/repo/tasks.ts';
import type { LogstoreService } from '../../src/service/logstore.ts';
import { createMessageService } from '../../src/service/message.ts';
import {
	type RunRecord,
	type RunsRepo as ServiceRunsRepo,
	createRunService,
} from '../../src/service/run.ts';
import { createSessionArchiveService } from '../../src/service/session-archive.ts';
import { assertNotArchived, assertSessionRefFree } from '../../src/service/session-guard.ts';

function runMigrations(db: DatabaseConnection) {
	const migrationsDir = join(__dirname, '../../migrations');
	const files = readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const file of files) {
		const sql = readFileSync(join(migrationsDir, file), 'utf8');
		db.exec(sql);
	}
}

describe('M6-T10 Integration: Task Session Archiving and Isolation Assertion', () => {
	let db: DatabaseConnection;
	let runsRepo: ReturnType<typeof createRunsRepo>;
	let tasksRepo: ReturnType<typeof createTasksRepo>;
	let unitOfWork: ReturnType<typeof createUnitOfWork>;
	let envelopeFactory: ReturnType<typeof createEnvelopeFactory>;
	let publishedEvents: EventEnvelope[];
	let mockBus: EventBus;
	let nowIso: string;
	const clock = { now: () => nowIso };

	beforeEach(() => {
		nowIso = '2026-09-15T10:00:00.000Z';
		db = openDatabase(':memory:');
		runMigrations(db);

		runsRepo = createRunsRepo(db);
		tasksRepo = createTasksRepo(db);
		unitOfWork = createUnitOfWork(db);
		let eventId = 1;
		envelopeFactory = createEnvelopeFactory({
			clock,
			idAllocator: { allocate: () => eventId++ },
		});
		publishedEvents = [];
		mockBus = {
			publish: (env: EventEnvelope) => {
				publishedEvents.push(env);
			},
			subscribe: () => () => {},
			listenerCount: () => 0,
		} as unknown as EventBus;

		// Seed required foreign keys: document
		db.prepare(`
			INSERT INTO documents (
				id, docs_path, project_name, repo_path, main_branch, branch_prefix,
				lane_count, content_fingerprint, is_source_readable, is_takeover_notified,
				imported_at, last_seen_at
			) VALUES (
				'doc-1', 'docs/Agent任务调度器-开发文档', 'scheduler', '/repo', 'main', 'task/',
				2, 'fp-1', 1, 0, '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z'
			);
		`).run();
	});

	afterEach(() => {
		try {
			db.close();
		} catch {}
	});

	// =========================================================================
	// AC 1, AC 2, AC 7: Core Lifecycle, KillTree, and Residual PIDs
	// =========================================================================
	it('AC 1, AC 2 & E-302, E-322: implement terminal state triggers archive in tx, terminates process trees after tx, collects residual PIDs without blocking lane release', async () => {
		// 1. Seed task with lane_no = 1
		tasksRepo.insert({
			id: 'task-1',
			doc_id: 'doc-1',
			task_key: 'M6-T10',
			title: '会话归档',
			module_key: 'M6',
			deps_json: '[]',
			contract_hash: 'hash-1',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			lane_no: 1,
		});

		db.prepare(`
			INSERT INTO dispatch_snapshots (
				id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at
			) VALUES (
				'snap-1', 'task-1', 'hash-1', '[]', '{}', '2026-09-15T00:00:00.000Z'
			);
		`).run();

		// 2. Seed 3 runs for task-1:
		// Run 1: implement, reviewing, PID 1001, vendor_session_ref
		runsRepo.insert({
			id: 'run-impl-1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'reviewing',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			pid: 1001,
			vendor_session_ref: '~/.codex/sessions/task1-impl-ref',
			lane_no: 1,
			session_archived_at: null,
		});

		// Run 2: review, running, PID 1002, vendor_session_ref
		runsRepo.insert({
			id: 'run-rev-1',
			task_id: 'task-1',
			attempt_no: 2,
			kind: 'review',
			parent_run_id: 'run-impl-1',
			state: 'running',
			agent_id: 'codex',
			permission_tier: 'readOnly',
			snapshot_id: 'snap-1',
			pid: 1002,
			vendor_session_ref: '~/.codex/sessions/task1-rev-ref',
			lane_no: 1,
			session_archived_at: null,
		});

		// Run 3: exited run without PID
		runsRepo.insert({
			id: 'run-old-1',
			task_id: 'task-1',
			attempt_no: 3,
			kind: 'review',
			state: 'exited',
			agent_id: 'claude',
			permission_tier: 'readOnly',
			snapshot_id: 'snap-1',
			pid: null,
			vendor_session_ref: '~/.claude/projects/task1-old-ref',
			lane_no: 1,
			session_archived_at: null,
		});

		// 3. Setup process registry with managed processes
		const processRegistry = createProcessRegistry();
		// PID 1001 terminates successfully
		processRegistry.register({
			runId: 'run-impl-1',
			pid: 1001,
			kill: async () => ({ outcome: 'terminated', attempts: [] }),
		} as unknown as ManagedProcess);
		// PID 1002 survives 2-stage killTree (E-322 residual process)
		processRegistry.register({
			runId: 'run-rev-1',
			pid: 1002,
			kill: async () => ({ outcome: 'survived', attempts: [] }),
		} as unknown as ManagedProcess);

		let loggedInfo: unknown;
		let loggedWarn: unknown;
		const mockLogger = {
			info: (data: unknown) => {
				loggedInfo = data;
			},
			warn: (data: unknown) => {
				loggedWarn = data;
			},
		};

		const sessionArchiveService = createSessionArchiveService({
			runsRepo,
			tasksRepo,
			processRegistry,
			clock,
			envelopeFactory,
			bus: mockBus,
			logger: mockLogger,
		});

		const mockLogstore: LogstoreService = {
			appendEvent: async () => ({
				location: { fileSeq: 1, byteOffset: 0, byteLen: 50 },
			}),
			closeWriter: async () => {},
		} as unknown as LogstoreService;

		const adaptRunsRepo = (repo: typeof runsRepo): ServiceRunsRepo => ({
			findById: (id: string): RunRecord | null => {
				const r = repo.findById(id);
				if (!r) return null;
				return {
					id: r.id,
					taskId: r.task_id ?? '',
					state: r.state as RunState,
					pid: r.pid,
					kind: r.kind,
					session_archived_at: r.session_archived_at,
					lane_no: r.lane_no,
				};
			},
			updateState: (input) => {
				repo.updateState(input);
			},
			updateLastEventAt: () => {},
			incrementUnmappedEventCount: () => {},
			findInFlight: () => [],
		});

		const runService = createRunService({
			logstore: mockLogstore,
			clock,
			envelopeFactory,
			bus: mockBus,
			unitOfWork,
			runsRepo: adaptRunsRepo(runsRepo),
			tasksRepo,
			sessionArchiveService,
		});

		// 4. Trigger terminal transition: kind='implement' transitions to 'landed' (AC 1)
		const transitionResult = await runService.transitionState({
			runId: 'run-impl-1',
			targetState: 'landed',
			reason: 'Task acceptance completed',
		});

		expect(transitionResult.currentState).toBe('landed');

		// 5. Verify database changes in the same transaction:
		// All 3 runs for task-1 now have session_archived_at set to current timestamp
		const updatedRuns = runsRepo.listByTask('task-1');
		expect(updatedRuns).toHaveLength(3);
		for (const r of updatedRuns) {
			expect(r.session_archived_at).toBe(nowIso);
		}

		// tasks.lane_no was set to NULL
		const updatedTask = tasksRepo.findById('task-1');
		expect(updatedTask?.lane_no).toBeNull();

		// vendor_session_ref preserved read-only without deletion or alteration (E-96, E-302)
		expect(updatedRuns.find((r) => r.id === 'run-impl-1')?.vendor_session_ref).toBe(
			'~/.codex/sessions/task1-impl-ref',
		);
		expect(updatedRuns.find((r) => r.id === 'run-rev-1')?.vendor_session_ref).toBe(
			'~/.codex/sessions/task1-rev-ref',
		);

		// 6. Verify killTree termination outcomes and published event (AC 2, E-322)
		const archiveEvent = publishedEvents.find((e) => e.kind === 'task.sessions_archived');
		expect(archiveEvent).toBeDefined();
		expect(archiveEvent?.payload).toMatchObject({
			taskId: 'task-1',
			runIds: expect.arrayContaining(['run-impl-1', 'run-rev-1', 'run-old-1']),
			killedPids: [1001],
			residualPids: [1002],
		});

		// R1: lane.released published with correct payload (laneNo=1, reason='landed', docId correct)
		const laneEvent = publishedEvents.find((e) => e.kind === 'lane.released');
		expect(laneEvent).toBeDefined();
		expect(laneEvent?.payload).toMatchObject({
			taskId: 'task-1',
			laneNo: 1,
			runId: 'run-impl-1',
			reason: 'landed',
			docId: 'doc-1',
		});

		// Observability: section 16 point 15 logged warn because residualPids is non-empty (E-322)
		expect(loggedWarn).toBeDefined();
		expect(loggedWarn).toMatchObject({
			taskId: 'task-1',
			archivedRunCount: 3,
			killedPids: [1001],
			residualPids: [1002],
		});
		// R4: Phase durations present in log data
		expect(typeof (loggedWarn as { phase1DurationMs?: number }).phase1DurationMs).toBe('number');
		expect(typeof (loggedWarn as { phase2DurationMs?: number }).phase2DurationMs).toBe('number');
	});

	// =========================================================================
	// AC 3 & E-326, E-54: awaiting_human releases lane but does NOT archive
	// =========================================================================
	it('AC 3 & E-326, E-54: awaiting_human releases lane_no to NULL, does NOT write session_archived_at, does NOT kill processes', async () => {
		tasksRepo.insert({
			id: 'task-2',
			doc_id: 'doc-1',
			task_key: 'M6-T1',
			title: '状态机',
			module_key: 'M6',
			deps_json: '[]',
			contract_hash: 'hash-1',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			lane_no: 2,
		});

		db.prepare(`
			INSERT INTO dispatch_snapshots (
				id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at
			) VALUES (
				'snap-2', 'task-2', 'hash-1', '[]', '{}', '2026-09-15T00:00:00.000Z'
			);
		`).run();

		runsRepo.insert({
			id: 'run-impl-2',
			task_id: 'task-2',
			attempt_no: 1,
			kind: 'implement',
			state: 'reviewing',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-2',
			pid: 2001,
			vendor_session_ref: '~/.codex/sessions/task2-ref',
			lane_no: 2,
			session_archived_at: null,
		});

		const sessionArchiveService = createSessionArchiveService({
			runsRepo,
			tasksRepo,
			clock,
			envelopeFactory,
			bus: mockBus,
		});

		const mockLogstore: LogstoreService = {
			appendEvent: async () => ({
				location: { fileSeq: 1, byteOffset: 0, byteLen: 50 },
			}),
			closeWriter: async () => {},
		} as unknown as LogstoreService;

		const adaptRunsRepo = (repo: typeof runsRepo): ServiceRunsRepo => ({
			findById: (id: string): RunRecord | null => {
				const r = repo.findById(id);
				if (!r) return null;
				return {
					id: r.id,
					taskId: r.task_id ?? '',
					state: r.state as RunState,
					pid: r.pid,
					kind: r.kind,
					session_archived_at: r.session_archived_at,
					lane_no: r.lane_no,
				};
			},
			updateState: (input) => {
				repo.updateState(input);
			},
			updateLastEventAt: () => {},
			incrementUnmappedEventCount: () => {},
			findInFlight: () => [],
		});

		const runService = createRunService({
			logstore: mockLogstore,
			clock,
			envelopeFactory,
			bus: mockBus,
			unitOfWork,
			runsRepo: adaptRunsRepo(runsRepo),
			tasksRepo,
			sessionArchiveService,
		});

		// Transition to awaiting_human
		await runService.transitionState({
			runId: 'run-impl-2',
			targetState: 'awaiting_human',
			reason: 'Gate confirmation waiting',
		});

		// tasks.lane_no is set to NULL (lane released for next tick)
		const task = tasksRepo.findById('task-2');
		expect(task?.lane_no).toBeNull();

		// session_archived_at remains NULL (sessions remain reinjectable and resumable)
		const run = runsRepo.findById('run-impl-2');
		expect(run?.session_archived_at).toBeNull();

		// No task.sessions_archived event was published
		const archiveEvent = publishedEvents.find((e) => e.kind === 'task.sessions_archived');
		expect(archiveEvent).toBeUndefined();

		// R1(c): lane.released published with reason='awaiting_human'
		const laneEvent = publishedEvents.find((e) => e.kind === 'lane.released');
		expect(laneEvent).toBeDefined();
		expect(laneEvent?.payload).toMatchObject({
			taskId: 'task-2',
			laneNo: 2,
			runId: 'run-impl-2',
			reason: 'awaiting_human',
		});

		// assertNotArchived succeeds
		expect(run).toBeDefined();
		expect(() => {
			if (run) assertNotArchived(run, { runsRepo });
		}).not.toThrow();
	});

	// =========================================================================
	// R1: lane_no already NULL → no lane.released emitted
	// =========================================================================
	it('R1: tasks.lane_no already NULL at terminal → no lane.released event emitted (E-326)', async () => {
		tasksRepo.insert({
			id: 'task-no-lane',
			doc_id: 'doc-1',
			task_key: 'M6-NOLANE',
			title: 'Already released',
			module_key: 'M6',
			deps_json: '[]',
			contract_hash: 'hash-nl',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			// lane_no is NOT set → NULL
		});

		db.prepare(`
			INSERT INTO dispatch_snapshots (
				id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at
			) VALUES (
				'snap-nl', 'task-no-lane', 'hash-nl', '[]', '{}', '2026-09-15T00:00:00.000Z'
			);
		`).run();

		runsRepo.insert({
			id: 'run-no-lane',
			task_id: 'task-no-lane',
			attempt_no: 1,
			kind: 'implement',
			state: 'reviewing',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-nl',
			pid: null,
			lane_no: null,
			session_archived_at: null,
		});

		const sessionArchiveService = createSessionArchiveService({
			runsRepo,
			tasksRepo,
			clock,
			envelopeFactory,
			bus: mockBus,
		});

		const mockLogstore: LogstoreService = {
			appendEvent: async () => ({
				location: { fileSeq: 1, byteOffset: 0, byteLen: 50 },
			}),
			closeWriter: async () => {},
		} as unknown as LogstoreService;

		const adaptRunsRepo = (repo: typeof runsRepo): ServiceRunsRepo => ({
			findById: (id: string): RunRecord | null => {
				const r = repo.findById(id);
				if (!r) return null;
				return {
					id: r.id,
					taskId: r.task_id ?? '',
					state: r.state as RunState,
					pid: r.pid,
					kind: r.kind,
					session_archived_at: r.session_archived_at,
					lane_no: r.lane_no,
				};
			},
			updateState: (input) => {
				repo.updateState(input);
			},
			updateLastEventAt: () => {},
			incrementUnmappedEventCount: () => {},
			findInFlight: () => [],
		});

		const runService = createRunService({
			logstore: mockLogstore,
			clock,
			envelopeFactory,
			bus: mockBus,
			unitOfWork,
			runsRepo: adaptRunsRepo(runsRepo),
			tasksRepo,
			sessionArchiveService,
		});

		publishedEvents.length = 0;
		await runService.transitionState({
			runId: 'run-no-lane',
			targetState: 'landed',
			reason: 'already had no lane',
		});

		// tasks.lane_no was already NULL → clearLaneNo returns changes=0 → no lane.released
		const laneEvent = publishedEvents.find((e) => e.kind === 'lane.released');
		expect(laneEvent).toBeUndefined();
	});

	// =========================================================================
	// R3: not-process-owner goes to residualPids
	// =========================================================================
	it('R3 & E-322: outcome not-process-owner (EPERM) lands in residualPids, not killedPids; logs warn', async () => {
		tasksRepo.insert({
			id: 'task-eperm',
			doc_id: 'doc-1',
			task_key: 'M6-EPERM',
			title: 'EPERM test',
			module_key: 'M6',
			deps_json: '[]',
			contract_hash: 'hash-ep',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			lane_no: 1,
		});

		db.prepare(`
			INSERT INTO dispatch_snapshots (
				id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at
			) VALUES (
				'snap-ep', 'task-eperm', 'hash-ep', '[]', '{}', '2026-09-15T00:00:00.000Z'
			);
		`).run();

		runsRepo.insert({
			id: 'run-eperm',
			task_id: 'task-eperm',
			attempt_no: 1,
			kind: 'implement',
			state: 'reviewing',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-ep',
			pid: 5001,
			lane_no: 1,
			session_archived_at: null,
		});

		const processRegistry = createProcessRegistry();
		processRegistry.register({
			runId: 'run-eperm',
			pid: 5001,
			kill: async () => ({
				outcome: 'not-process-owner' as const,
				attempts: [
					{
						attempt: 1,
						method: 'sigterm' as const,
						result: 'not-process-owner' as const,
						at: '2026-09-15T10:00:00.000Z',
					},
					{
						attempt: 2,
						method: 'sigkill' as const,
						result: 'not-process-owner' as const,
						at: '2026-09-15T10:00:03.000Z',
					},
				],
			}),
		} as unknown as ManagedProcess);

		let epermWarn: unknown;
		let epermInfo: unknown;
		const epermLogger = {
			warn: (data: unknown) => {
				epermWarn = data;
			},
			info: (data: unknown) => {
				epermInfo = data;
			},
		};

		const sessionArchiveService = createSessionArchiveService({
			runsRepo,
			tasksRepo,
			processRegistry,
			clock,
			envelopeFactory,
			bus: mockBus,
			logger: epermLogger,
		});

		const archiveCtx = sessionArchiveService.archiveTaskInTx({
			taskId: 'task-eperm',
			runId: 'run-eperm',
		});
		const result = await sessionArchiveService.terminateArchived(archiveCtx);

		// not-process-owner must land in residualPids, NOT killedPids
		expect(result.residualPids).toContain(5001);
		expect(result.killedPids).not.toContain(5001);

		// warn branch triggered (residualPids non-empty)
		expect(epermWarn).toBeDefined();
		expect(epermInfo).toBeUndefined();

		// R4: phase durations present and numeric
		expect(typeof (epermWarn as { phase1DurationMs?: number }).phase1DurationMs).toBe('number');
		expect(typeof (epermWarn as { phase2DurationMs?: number }).phase2DurationMs).toBe('number');
		// phase1 ≈ 3000ms (3s between attempt timestamps)
		expect((epermWarn as { phase1DurationMs: number }).phase1DurationMs).toBeGreaterThanOrEqual(
			2900,
		);
	});

	// =========================================================================
	// AC 6 Scenario 1: 归档后投递 409 (POST /runs/:id/messages on archived session)
	// =========================================================================
	it('AC 6 Scenario 1: 「归档后投递 409」: delivering message to archived session throws 409 E_SESSION_ARCHIVED', async () => {
		tasksRepo.insert({
			id: 'task-msg',
			doc_id: 'doc-1',
			task_key: 'M6-MSG',
			title: '消息测试',
			module_key: 'M6',
			deps_json: '[]',
			contract_hash: 'hash-m',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
		});

		db.prepare(`
			INSERT INTO dispatch_snapshots (
				id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at
			) VALUES (
				'snap-msg', 'task-msg', 'hash-m', '[]', '{}', '2026-09-15T00:00:00.000Z'
			);
		`).run();

		runsRepo.insert({
			id: 'run-archived-msg',
			task_id: 'task-msg',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-msg',
			vendor_session_ref: '~/.codex/sessions/archived-session',
			session_archived_at: '2026-09-15T09:00:00.000Z',
		});

		// Use the real SQLite-backed runMessagesRepo (R2: no hand-injection of runsRepo)
		const realRunMessagesRepo = createSqliteRunMessagesRepo(db);
		const processRegistry = createProcessRegistry();
		const messageService = createMessageService({
			runMessagesRepo: realRunMessagesRepo,
			processRegistry,
			clock,
			ids: { newId: () => 'msg-1' },
		});

		let thrown: unknown;
		try {
			await messageService.deliverMessage({
				runId: 'run-archived-msg',
				text: 'Hello to archived run',
				kind: 'reply',
			});
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(AppError);
		const appErr = thrown as AppError;
		expect(appErr.code).toBe('E_SESSION_ARCHIVED');
		expect(appErr.details?.runId).toBe('run-archived-msg');

		// vendor_session_ref remains untouched and read-only
		const runRow = runsRepo.findById('run-archived-msg');
		expect(runRow?.vendor_session_ref).toBe('~/.codex/sessions/archived-session');
	});

	// =========================================================================
	// AC 6 Scenario 2: 跨任务复用引用 409 (E-303)
	// =========================================================================
	it('AC 6 Scenario 2: 「跨任务复用引用 409」: reusing vendorSessionRef from another task throws E_SESSION_ARCHIVED with conflictTaskKey', () => {
		tasksRepo.insert({
			id: 'task-a',
			doc_id: 'doc-1',
			task_key: 'M6-T1',
			title: 'Task A',
			module_key: 'M6',
			deps_json: '[]',
			contract_hash: 'hash-a',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
		});
		tasksRepo.insert({
			id: 'task-b',
			doc_id: 'doc-1',
			task_key: 'M6-T2',
			title: 'Task B',
			module_key: 'M6',
			deps_json: '[]',
			contract_hash: 'hash-b',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
		});

		db.prepare(`
			INSERT INTO dispatch_snapshots (
				id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at
			) VALUES (
				'snap-a', 'task-a', 'hash-a', '[]', '{}', '2026-09-15T00:00:00.000Z'
			);
		`).run();

		runsRepo.insert({
			id: 'run-a1',
			task_id: 'task-a',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-a',
			vendor_session_ref: 'session/shared-token-xyz',
			session_archived_at: '2026-09-15T09:00:00.000Z',
		});

		let thrown: unknown;
		try {
			assertSessionRefFree(
				{
					taskId: 'task-b',
					vendorSessionRef: 'session/shared-token-xyz',
				},
				{ runsRepo, tasksRepo },
			);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(AppError);
		const appErr = thrown as AppError;
		expect(appErr.code).toBe('E_SESSION_ARCHIVED');
		expect(appErr.details).toMatchObject({
			conflictTaskKey: 'M6-T1',
			conflictRunId: 'run-a1',
			vendorSessionRef: 'session/shared-token-xyz',
			taskId: 'task-b',
		});
	});

	// =========================================================================
	// AC 6 Scenario 3: 同任务第 2 轮共享引用 200 (放行)
	// =========================================================================
	it('AC 6 Scenario 3: 「同任务第 2 轮共享引用 200」: multi-round review continuation sharing session ref in same task is permitted', () => {
		tasksRepo.insert({
			id: 'task-same',
			doc_id: 'doc-1',
			task_key: 'M7-T7',
			title: '审查续接',
			module_key: 'M7',
			deps_json: '[]',
			contract_hash: 'hash-s',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
		});

		db.prepare(`
			INSERT INTO dispatch_snapshots (
				id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at
			) VALUES (
				'snap-same', 'task-same', 'hash-s', '[]', '{}', '2026-09-15T00:00:00.000Z'
			);
		`).run();

		runsRepo.insert({
			id: 'run-round-1',
			task_id: 'task-same',
			attempt_no: 1,
			kind: 'review',
			state: 'exited',
			agent_id: 'codex',
			permission_tier: 'readOnly',
			snapshot_id: 'snap-same',
			vendor_session_ref: 'session/same-task-round-ref',
		});

		// Second round for the same task ('task-same') shares the same session ref -> MUST NOT throw
		expect(() =>
			assertSessionRefFree(
				{
					taskId: 'task-same',
					vendorSessionRef: 'session/same-task-round-ref',
				},
				{ runsRepo, tasksRepo },
			),
		).not.toThrow();
	});

	// =========================================================================
	// AC 6 Scenario 4: 续接目标已归档 409
	// =========================================================================
	it('AC 6 Scenario 4: 「续接目标已归档 409」: continuation targeting archived session throws 409 E_SESSION_ARCHIVED', () => {
		tasksRepo.insert({
			id: 'task-cont',
			doc_id: 'doc-1',
			task_key: 'M7-CONT',
			title: '续接测试',
			module_key: 'M7',
			deps_json: '[]',
			contract_hash: 'hash-c',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
		});

		db.prepare(`
			INSERT INTO dispatch_snapshots (
				id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at
			) VALUES (
				'snap-cont', 'task-cont', 'hash-c', '[]', '{}', '2026-09-15T00:00:00.000Z'
			);
		`).run();

		runsRepo.insert({
			id: 'run-target-archived',
			task_id: 'task-cont',
			attempt_no: 1,
			kind: 'review',
			state: 'landed',
			agent_id: 'codex',
			permission_tier: 'readOnly',
			snapshot_id: 'snap-cont',
			session_archived_at: '2026-09-15T08:00:00.000Z',
		});

		let thrown: unknown;
		try {
			assertNotArchived('run-target-archived', { runsRepo });
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(AppError);
		const appErr = thrown as AppError;
		expect(appErr.code).toBe('E_SESSION_ARCHIVED');
		expect(appErr.details?.runId).toBe('run-target-archived');
		expect(appErr.details?.sessionArchivedAt).toBe('2026-09-15T08:00:00.000Z');
	});
});
