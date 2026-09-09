import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import type { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { RUN_TRANSITION_REASONS, type RunState } from '../../src/domain/run-state-machine.ts';
import { AppError } from '../../src/errors/app-error.ts';
import type { EventBus } from '../../src/events/bus.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import { registerRunsRoutes } from '../../src/http/routes/runs.ts';
import type {
	KillTreeAttemptResult,
	KillTreeProcessOps,
} from '../../src/platform/kill-tree-contract.ts';
import { createProcessRegistry } from '../../src/proc/registry.ts';
import type { ManagedProcess } from '../../src/proc/spawn.ts';
import {
	REASON_ABORTED_WITH_UNREVIEWED_CHANGES,
	type RunAbortRunRecord,
	type RunsAbortRepo,
	type WorktreeInspector,
	createRunAbortService,
	createSqliteRunsAbortRepo,
} from '../../src/service/run-abort.ts';

const FIXED_NOW = '2026-09-09T10:00:00.000Z';
const clock = Object.freeze({ now: () => FIXED_NOW });

function createMockRunsRepo(initialRuns: readonly RunAbortRunRecord[]): {
	repo: RunsAbortRepo;
	runs: Map<string, RunAbortRunRecord>;
	updates: Array<{
		id: string;
		fromState: RunState;
		toState: RunState;
		endedAt: string;
		actorDeviceId?: string | null;
		changedFileCount?: number | null;
		queuedReason?: string | null;
	}>;
} {
	const runs = new Map<string, RunAbortRunRecord>(initialRuns.map((r) => [r.id, { ...r }]));
	const updates: Array<{
		id: string;
		fromState: RunState;
		toState: RunState;
		endedAt: string;
		actorDeviceId?: string | null;
		changedFileCount?: number | null;
		queuedReason?: string | null;
	}> = [];

	const repo: RunsAbortRepo = {
		findById(id: string): RunAbortRunRecord | null {
			const run = runs.get(id);
			return run ? { ...run } : null;
		},
		updateState(input): void {
			const run = runs.get(input.id);
			if (!run) throw new AppError('E_NOT_FOUND', `Run ${input.id} not found`);
			if (run.state !== input.fromState) {
				throw new AppError(
					'E_INVALID_STATE_TRANSITION',
					`Expected state ${input.fromState} but got ${run.state}`,
				);
			}
			const updated: RunAbortRunRecord = {
				...run,
				state: input.toState,
				changedFileCount:
					input.changedFileCount !== undefined ? input.changedFileCount : run.changedFileCount,
			};
			runs.set(input.id, updated);
			updates.push({ ...input });
		},
	};

	return { repo, runs, updates };
}

function createMockProcessOps(overrides: Partial<KillTreeProcessOps> = {}): KillTreeProcessOps {
	return {
		now: () => FIXED_NOW,
		wait: vi.fn(async () => undefined),
		taskkill: vi.fn(async () => 'still-running' as const),
		signalGroup: vi.fn(() => 'still-running' as const),
		probeTree: vi.fn(async () => 'still-running' as const),
		probeGroup: vi.fn(() => 'still-running' as const),
		...overrides,
	};
}

describe('M6-T5 run-abort service & routes', () => {
	describe('Acceptance Criterion 1 & E-119: Process tree termination via platform killTree', () => {
		it('POSIX: calls posixKillTree with two-stage termination (SIGTERM then SIGKILL)', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-posix-1',
					taskId: 'T-1',
					state: 'running',
					pid: 5001,
					worktreePath: null,
					changedFileCount: 0,
				},
			]);

			const sigResults: KillTreeAttemptResult[] = ['still-running', 'terminated'];
			const ops = createMockProcessOps({
				signalGroup: vi.fn(() => sigResults.shift() ?? 'terminated'),
			});

			const service = createRunAbortService({
				runsRepo: repo,
				clock,
				platform: 'linux',
				processOps: ops,
			});

			const result = await service.abortRun('run-posix-1');

			expect(result.accepted).toBe(true);
			expect(result.currentState).toBe('aborted');
			expect(ops.signalGroup).toHaveBeenNthCalledWith(1, 5001, 'SIGTERM');
			expect(ops.wait).toHaveBeenCalledWith(3000);
			expect(ops.signalGroup).toHaveBeenNthCalledWith(2, 5001, 'SIGKILL');
			expect(result.killTreeResult?.outcome).toBe('terminated');
			expect(result.killTreeResult?.attempts.map((a) => a.method)).toEqual(['sigterm', 'sigkill']);
		});

		it('Windows: calls windowsKillTree with two-stage termination (taskkill /T then /F)', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-win-1',
					taskId: 'T-2',
					state: 'running',
					pid: 8001,
					worktreePath: null,
					changedFileCount: 0,
				},
			]);

			const taskkillResults: KillTreeAttemptResult[] = ['still-running', 'terminated'];
			const ops = createMockProcessOps({
				taskkill: vi.fn(async () => taskkillResults.shift() ?? 'terminated'),
			});

			const service = createRunAbortService({
				runsRepo: repo,
				clock,
				platform: 'win32',
				processOps: ops,
			});

			const result = await service.abortRun('run-win-1');

			expect(result.accepted).toBe(true);
			expect(result.currentState).toBe('aborted');
			expect(ops.taskkill).toHaveBeenNthCalledWith(1, ['/PID', '8001', '/T']);
			expect(ops.wait).toHaveBeenCalledWith(3000);
			expect(ops.taskkill).toHaveBeenNthCalledWith(2, ['/PID', '8001', '/T', '/F']);
			expect(result.killTreeResult?.outcome).toBe('terminated');
			expect(result.killTreeResult?.attempts.map((a) => a.method)).toEqual([
				'taskkill-soft',
				'taskkill-force',
			]);
		});

		it('delegates to managedProcess.kill() when process is registered in processRegistry', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-managed-1',
					taskId: 'T-3',
					state: 'running',
					pid: 9001,
					worktreePath: null,
					changedFileCount: 0,
				},
			]);

			const registry = createProcessRegistry();
			const killMock = vi.fn(async () =>
				Object.freeze({
					outcome: 'terminated' as const,
					attempts: [
						Object.freeze({
							attempt: 1,
							method: 'sigterm' as const,
							result: 'terminated' as const,
							at: FIXED_NOW,
						}),
					],
				}),
			);
			const dummyManagedProcess = {
				runId: 'run-managed-1',
				pid: 9001,
				isExited: false,
				kill: killMock,
			} as unknown as ManagedProcess;
			registry.register(dummyManagedProcess);

			const service = createRunAbortService({
				runsRepo: repo,
				clock,
				processRegistry: registry,
			});

			const result = await service.abortRun({ runId: 'run-managed-1', graceMs: 1500 });

			expect(result.accepted).toBe(true);
			expect(killMock).toHaveBeenCalledWith({ graceMs: 1500 });
			expect(result.killTreeResult?.outcome).toBe('terminated');
		});
	});

	describe('Acceptance Criterion 2 & E-118: Retains worktree and diff, records "已中止（有未验收改动）"', () => {
		it('records "已中止（有未验收改动）" and updates changedFileCount when inspector finds modifications', async () => {
			const { repo, updates } = createMockRunsRepo([
				{
					id: 'run-changes-1',
					taskId: 'T-10',
					state: 'running',
					pid: null,
					worktreePath: '/path/to/worktree',
					changedFileCount: 0,
				},
			]);

			const inspector: WorktreeInspector = {
				inspect: vi.fn(async () => ({
					hasChanges: true,
					changedFileCount: 3,
					diff: 'diff --git a/foo b/foo...',
				})),
			};

			const ringBuffer = createRingBuffer();
			const bus = createEventBus({ ringBuffer });
			const idAllocator = { allocate: vi.fn(() => 101) };
			const envelopeFactory = createEnvelopeFactory({ clock, idAllocator });

			const service = createRunAbortService({
				runsRepo: repo,
				clock,
				worktreeInspector: inspector,
				bus,
				envelopeFactory,
			});

			const result = await service.abortRun({
				runId: 'run-changes-1',
				reason: 'user stopped',
			});

			expect(result.accepted).toBe(true);
			expect(result.hasUnreviewedChanges).toBe(true);
			expect(result.changedFileCount).toBe(3);
			expect(result.currentState).toBe('aborted');

			// Check DB update
			expect(updates).toHaveLength(1);
			expect(updates[0]?.queuedReason).toBe(REASON_ABORTED_WITH_UNREVIEWED_CHANGES);
			expect(updates[0]?.changedFileCount).toBe(3);

			// Check inspector was called on the worktree path (not deleted, not rolled back)
			expect(inspector.inspect).toHaveBeenCalledWith('/path/to/worktree');

			// Check published events carry the E-118 reason
			const bufferedEvents = ringBuffer.getAll();
			const stateChangedEvent = bufferedEvents.find((e) => e.kind === 'run.state_changed');
			expect(stateChangedEvent).toBeDefined();
			expect(stateChangedEvent?.payload).toMatchObject({
				from: 'running',
				to: 'aborted',
				reason: REASON_ABORTED_WITH_UNREVIEWED_CHANGES,
			});

			const abortedEvent = bufferedEvents.find((e) => e.kind === 'run.aborted');
			expect(abortedEvent).toBeDefined();
			expect(abortedEvent?.payload).toMatchObject({
				reason: REASON_ABORTED_WITH_UNREVIEWED_CHANGES,
				hasUnreviewedChanges: true,
				changedFileCount: 3,
			});
		});

		it('uses stored changed_file_count when inspector is not provided and files were changed', async () => {
			const { repo, updates } = createMockRunsRepo([
				{
					id: 'run-changes-2',
					taskId: 'T-11',
					state: 'awaiting_reply',
					pid: null,
					worktreePath: '/path/to/worktree',
					changedFileCount: 2,
				},
			]);

			const service = createRunAbortService({
				runsRepo: repo,
				clock,
			});

			const result = await service.abortRun('run-changes-2');

			expect(result.accepted).toBe(true);
			expect(result.hasUnreviewedChanges).toBe(true);
			expect(updates[0]?.queuedReason).toBe(REASON_ABORTED_WITH_UNREVIEWED_CHANGES);
		});

		it('uses default manual_abort reason when no worktree changes exist', async () => {
			const { repo, updates } = createMockRunsRepo([
				{
					id: 'run-clean-1',
					taskId: 'T-12',
					state: 'running',
					pid: null,
					worktreePath: '/clean/worktree',
					changedFileCount: 0,
				},
			]);

			const inspector: WorktreeInspector = {
				inspect: async () => ({ hasChanges: false, changedFileCount: 0 }),
			};

			const service = createRunAbortService({
				runsRepo: repo,
				clock,
				worktreeInspector: inspector,
			});

			const result = await service.abortRun('run-clean-1');

			expect(result.accepted).toBe(true);
			expect(result.hasUnreviewedChanges).toBe(false);
			expect(updates[0]?.queuedReason).toBe(RUN_TRANSITION_REASONS.MANUAL_ABORT);
		});
	});

	describe('Acceptance Criterion 3: Idempotency: already terminal returns accepted directly', () => {
		it('returns accepted directly without killTree or DB update if already landed', async () => {
			const { repo, updates } = createMockRunsRepo([
				{
					id: 'run-landed-1',
					taskId: 'T-20',
					state: 'landed',
					pid: 1234,
					worktreePath: null,
					changedFileCount: 0,
				},
			]);

			const killTreeSpy = vi.fn();
			const service = createRunAbortService({
				runsRepo: repo,
				clock,
				killTree: killTreeSpy,
			});

			const result = await service.abortRun('run-landed-1');

			expect(result.accepted).toBe(true);
			expect(result.alreadyTerminal).toBe(true);
			expect(result.currentState).toBe('landed');
			expect(updates).toHaveLength(0);
			expect(killTreeSpy).not.toHaveBeenCalled();
		});

		it('returns accepted directly without killTree or DB update if already aborted', async () => {
			const { repo, updates } = createMockRunsRepo([
				{
					id: 'run-aborted-1',
					taskId: 'T-21',
					state: 'aborted',
					pid: 1235,
					worktreePath: null,
					changedFileCount: 2,
				},
			]);

			const killTreeSpy = vi.fn();
			const service = createRunAbortService({
				runsRepo: repo,
				clock,
				killTree: killTreeSpy,
			});

			const result = await service.abortRun('run-aborted-1');

			expect(result.accepted).toBe(true);
			expect(result.alreadyTerminal).toBe(true);
			expect(result.currentState).toBe('aborted');
			expect(result.hasUnreviewedChanges).toBe(true);
			expect(updates).toHaveLength(0);
			expect(killTreeSpy).not.toHaveBeenCalled();
		});

		it('returns accepted directly for failed and interrupted terminal states', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-failed-1',
					taskId: 'T-22',
					state: 'failed',
					pid: null,
					worktreePath: null,
					changedFileCount: 0,
				},
				{
					id: 'run-interrupted-1',
					taskId: 'T-23',
					state: 'interrupted',
					pid: null,
					worktreePath: null,
					changedFileCount: 0,
				},
			]);

			const service = createRunAbortService({ runsRepo: repo, clock });

			const failedResult = await service.abortRun('run-failed-1');
			expect(failedResult.accepted).toBe(true);
			expect(failedResult.alreadyTerminal).toBe(true);

			const interruptedResult = await service.abortRun('run-interrupted-1');
			expect(interruptedResult.accepted).toBe(true);
			expect(interruptedResult.alreadyTerminal).toBe(true);
		});
	});

	describe('Acceptance Criterion 4 & E-02: Provides kill entry for orphaned runs', () => {
		it('terminates process tree of orphaned run and transitions state to aborted', async () => {
			const { repo, updates } = createMockRunsRepo([
				{
					id: 'run-orphaned-1',
					taskId: 'T-30',
					state: 'orphaned',
					pid: 7777,
					worktreePath: null,
					changedFileCount: 0,
				},
			]);

			const ops = createMockProcessOps({
				signalGroup: vi.fn(() => 'terminated' as const),
			});

			const service = createRunAbortService({
				runsRepo: repo,
				clock,
				platform: 'linux',
				processOps: ops,
			});

			const result = await service.abortRun('run-orphaned-1');

			expect(result.accepted).toBe(true);
			expect(result.previousState).toBe('orphaned');
			expect(result.currentState).toBe('aborted');
			expect(ops.signalGroup).toHaveBeenCalledWith(7777, 'SIGTERM');
			expect(updates[0]?.toState).toBe('aborted');
			expect(updates[0]?.queuedReason).toBe(RUN_TRANSITION_REASONS.HUMAN_KILLED);
		});
	});

	describe('State machine validation & error handling', () => {
		it('throws E_NOT_FOUND when run does not exist', async () => {
			const { repo } = createMockRunsRepo([]);
			const service = createRunAbortService({ runsRepo: repo, clock });

			await expect(service.abortRun('non-existent')).rejects.toMatchObject({
				code: 'E_NOT_FOUND',
			});
		});

		it('throws E_INVALID_STATE_TRANSITION when run is in an invalid non-terminal state (e.g. exited)', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-exited-1',
					taskId: 'T-40',
					state: 'exited',
					pid: null,
					worktreePath: null,
					changedFileCount: 0,
				},
			]);
			const service = createRunAbortService({ runsRepo: repo, clock });

			await expect(service.abortRun('run-exited-1')).rejects.toMatchObject({
				code: 'E_INVALID_STATE_TRANSITION',
			});
		});
	});

	describe('UnitOfWork and transaction safety', () => {
		it('publishes events strictly outside of unitOfWork.run()', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-uow-1',
					taskId: 'T-50',
					state: 'running',
					pid: null,
					worktreePath: null,
					changedFileCount: 0,
				},
			]);

			let inTransaction = false;
			const unitOfWork = {
				run: vi.fn(async (work: () => void) => {
					inTransaction = true;
					try {
						work();
					} finally {
						inTransaction = false;
					}
				}),
				isInTransaction: () => inTransaction,
			};

			const publishedWhileInTransaction: boolean[] = [];
			const ringBuffer = createRingBuffer();
			const realBus = createEventBus({ ringBuffer });
			const bus: EventBus = {
				...realBus,
				publish: vi.fn((env, ref) => {
					publishedWhileInTransaction.push(inTransaction);
					return realBus.publish(env, ref);
				}),
			};

			const idAllocator = { allocate: vi.fn(() => 200) };
			const envelopeFactory = createEnvelopeFactory({ clock, idAllocator });

			const service = createRunAbortService({
				runsRepo: repo,
				clock,
				unitOfWork: unitOfWork as unknown as ReturnType<typeof createUnitOfWork>,
				bus,
				envelopeFactory,
			});

			await service.abortRun('run-uow-1');

			expect(unitOfWork.run).toHaveBeenCalledTimes(1);
			expect(publishedWhileInTransaction).toEqual([false, false]);
		});
	});

	describe('Fastify HTTP routes: POST /api/v1/runs/:id/abort & POST /runs/:id/abort', () => {
		it('POST /api/v1/runs/:id/abort returns 200 with { accepted: true }', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-http-1',
					taskId: 'T-60',
					state: 'running',
					pid: null,
					worktreePath: null,
					changedFileCount: 0,
				},
			]);
			const service = createRunAbortService({ runsRepo: repo, clock });

			const app = Fastify({ logger: false });
			registerRunsRoutes(app, { runAbortService: service });

			const response = await app.inject({
				method: 'POST',
				url: '/api/v1/runs/run-http-1/abort',
				payload: { reason: 'user requested' },
			});

			expect(response.statusCode).toBe(200);
			expect(JSON.parse(response.body)).toEqual({ accepted: true });
			await app.close();
		});

		it('POST /runs/:id/abort alias route returns 200 with { accepted: true }', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-http-2',
					taskId: 'T-61',
					state: 'awaiting_reply',
					pid: null,
					worktreePath: null,
					changedFileCount: 0,
				},
			]);
			const service = createRunAbortService({ runsRepo: repo, clock });

			const app = Fastify({ logger: false });
			registerRunsRoutes(app, { runAbortService: service });

			const response = await app.inject({
				method: 'POST',
				url: '/runs/run-http-2/abort',
			});

			expect(response.statusCode).toBe(200);
			expect(JSON.parse(response.body)).toEqual({ accepted: true });
			await app.close();
		});

		it('rejects additionalProperties in request body with 400 when removeAdditional is false', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-http-3',
					taskId: 'T-62',
					state: 'running',
					pid: null,
					worktreePath: null,
					changedFileCount: 0,
				},
			]);
			const service = createRunAbortService({ runsRepo: repo, clock });

			const app = Fastify({
				logger: false,
				ajv: { customOptions: { removeAdditional: false } },
			});
			registerRunsRoutes(app, { runAbortService: service });

			const response = await app.inject({
				method: 'POST',
				url: '/api/v1/runs/run-http-3/abort',
				payload: { reason: 'ok', unknownField: 'bad' },
			});

			expect(response.statusCode).toBe(400);
			await app.close();
		});
	});

	describe('Real SQLite integration with createSqliteRunsAbortRepo', () => {
		it('persists state transition to aborted in real SQLite database', async () => {
			const db: DatabaseConnection = openDatabase(':memory:');
			db.exec(`
				CREATE TABLE documents (
					id TEXT PRIMARY KEY, docs_path TEXT NOT NULL UNIQUE, project_name TEXT NOT NULL,
					content_fingerprint TEXT NOT NULL, imported_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
				);
				CREATE TABLE tasks (
					id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, task_key TEXT NOT NULL, title TEXT NOT NULL,
					module_key TEXT NOT NULL, deps_json TEXT NOT NULL, contract_hash TEXT NOT NULL,
					contract_reasons_json TEXT NOT NULL
				);
				CREATE TABLE dispatch_snapshots (
					id TEXT PRIMARY KEY, task_id TEXT NOT NULL, contract_hash TEXT NOT NULL,
					task_paths_json TEXT NOT NULL, launch_spec_json TEXT NOT NULL, created_at TEXT NOT NULL
				);
				CREATE TABLE runs (
					id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
					kind TEXT NOT NULL, state TEXT NOT NULL, agent_id TEXT NOT NULL,
					permission_tier TEXT NOT NULL, snapshot_id TEXT NOT NULL, worktree_path TEXT,
					pid INTEGER, changed_file_count INTEGER, queued_reason TEXT, actor_device_id TEXT,
					ended_at TEXT
				);

				INSERT INTO documents VALUES ('doc-1', 'doc.md', 'test', 'fp', '2026-01-01', '2026-01-01');
				INSERT INTO tasks VALUES ('task-1', 'doc-1', 'T-1', 'Title', 'M1', '[]', 'hash', '[]');
				INSERT INTO dispatch_snapshots VALUES ('snap-1', 'task-1', 'hash', '[]', '{}', '2026-01-01');
				INSERT INTO runs (id, task_id, attempt_no, kind, state, agent_id, permission_tier, snapshot_id, pid, worktree_path, changed_file_count)
				VALUES ('run-db-1', 'task-1', 1, 'implement', 'running', 'agent-1', 'workspaceWrite', 'snap-1', 12345, '/tmp/wt', 0);
			`);

			const repo = createSqliteRunsAbortRepo(db);
			const ops = createMockProcessOps({
				signalGroup: vi.fn(() => 'terminated' as const),
			});

			const service = createRunAbortService({
				runsRepo: repo,
				clock,
				platform: 'linux',
				processOps: ops,
			});

			const result = await service.abortRun('run-db-1');
			expect(result.accepted).toBe(true);
			expect(result.currentState).toBe('aborted');

			// Read back from SQLite directly
			const row = db
				.prepare('SELECT state, ended_at, queued_reason FROM runs WHERE id = ?')
				.get('run-db-1') as {
				state: string;
				ended_at: string;
				queued_reason: string;
			};
			expect(row.state).toBe('aborted');
			expect(row.ended_at).toBe(FIXED_NOW);
			expect(row.queued_reason).toBe(RUN_TRANSITION_REASONS.MANUAL_ABORT);

			db.close();
		});
	});
});
