import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createBatchesRepo } from '../../src/repo/batches.ts';
import { createDispatchSnapshotsRepo } from '../../src/repo/dispatch-snapshots.ts';
import { createDocumentsRepo } from '../../src/repo/documents.ts';
import { createGatesRepo } from '../../src/repo/gates.ts';
import { createRunsRepo } from '../../src/repo/runs.ts';
import { createTasksRepo } from '../../src/repo/tasks.ts';
import {
	type RerunServiceDeps,
	checkBatchAlignment,
	checkDocSnapshotStale,
	createRerunService,
} from '../../src/service/rerun.ts';

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

function createTestEnvironment(options?: {
	readonly onlineAgents?: readonly string[];
}) {
	const db = setupTestDatabase();

	const documentsRepo = createDocumentsRepo(db);
	const batchesRepo = createBatchesRepo(db);
	const tasksRepo = createTasksRepo(db);
	const dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
	const runsRepo = createRunsRepo(db);

	let currentTime = '2026-09-15T12:00:00.000Z';
	let idCounter = 1;

	const onlineSet = new Set(options?.onlineAgents ?? ['codex', 'claude', 'pi', 'grok']);

	const clock = {
		now: () => currentTime,
		advance: (ms: number) => {
			currentTime = new Date(Date.parse(currentTime) + ms).toISOString();
		},
	};

	const ids = {
		newId: () => `run_${String(idCounter++).padStart(4, '0')}`,
	};

	const publishedEvents: Array<{ kind: string; payload: unknown }> = [];
	const bus = {
		publish: (envelope: { kind: string; payload: unknown }) => {
			publishedEvents.push(envelope);
		},
	};

	const envelopeFactory = {
		createEnvelope: (input: {
			kind: string;
			runId?: string;
			taskId?: string;
			actorDeviceId?: string | null;
			payload: unknown;
		}) => ({
			kind: input.kind,
			runId: input.runId,
			taskId: input.taskId,
			actorDeviceId: input.actorDeviceId,
			payload: input.payload,
		}),
	};

	const gatesRepo = createGatesRepo(db);

	let unitOfWorkRunCount = 0;
	const unitOfWork = {
		run: <T>(fn: () => T): T => {
			unitOfWorkRunCount++;
			return fn();
		},
	};

	const appendedEvents: Array<{ runId: string; envelope: unknown }> = [];
	const logstore = {
		appendEvent: async (runId: string, envelope: unknown) => {
			appendedEvents.push({ runId, envelope });
			return { location: { fileSeq: 0, byteOffset: 0, byteLen: 100 } };
		},
	};

	const service = createRerunService({
		unitOfWork: unitOfWork as unknown as NonNullable<RerunServiceDeps['unitOfWork']>,
		logstore: logstore as unknown as NonNullable<RerunServiceDeps['logstore']>,
		runsRepo,
		gatesRepo,
		tasksRepo,
		batchesRepo,
		documentsRepo,
		dispatchSnapshotsRepo,
		clock,
		ids,
		bus: bus as unknown as NonNullable<RerunServiceDeps['bus']>,
		envelopeFactory: envelopeFactory as unknown as NonNullable<RerunServiceDeps['envelopeFactory']>,
		isAgentDispatchable: (agentId: string) => onlineSet.has(agentId),
		listDispatchableAgents: () =>
			Array.from(onlineSet).map((agentId) => ({ agentId, canDispatch: true })),
	});

	// Seed helper
	documentsRepo.insert({
		id: 'doc-1',
		docs_path: '/path/to/docs-data.js',
		project_name: 'Test Project',
		repo_path: '/path/to/repo',
		main_branch: 'main',
		branch_prefix: 'task/',
		lane_count: 2,
		content_fingerprint: 'fp-1',
		is_source_readable: 1,
		is_takeover_notified: 0,
		imported_at: currentTime,
		last_seen_at: currentTime,
	});

	return {
		db,
		documentsRepo,
		batchesRepo,
		tasksRepo,
		gatesRepo,
		dispatchSnapshotsRepo,
		runsRepo,
		clock,
		ids,
		onlineSet,
		publishedEvents,
		appendedEvents,
		getUnitOfWorkRunCount: () => unitOfWorkRunCount,
		service,
	};
}

describe('M8-T5: 重派、换 agent 与原样重跑', () => {
	describe('AC 1 & E-121: 换 agent 重派', () => {
		it('新建运行记录、旧运行转只读留存，attemptNo 递增', async () => {
			const env = createTestEnvironment();
			env.batchesRepo.insert({ id: 'b1', doc_id: 'doc-1', batch_no: 1, state: 'running' });
			env.tasksRepo.insert({
				id: 'task-1',
				doc_id: 'doc-1',
				batch_id: 'b1',
				task_key: 'M8-T5',
				title: 'Task Title',
				module_key: 'M8',
				deps_json: '[]',
				contract_hash: 'hash-c1',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
			});

			// Attempt 1 with codex finishes or fails
			const snap1 = env.dispatchSnapshotsRepo.takeSnapshotForTask({
				taskId: 'task-1',
				launchSpecJson: JSON.stringify({ agentId: 'codex', model: 'gpt-5' }),
				createdAt: env.clock.now(),
			});
			env.runsRepo.insert({
				id: 'run-1',
				task_id: 'task-1',
				attempt_no: 1,
				kind: 'implement',
				state: 'failed',
				agent_id: 'codex',
				model_name: 'gpt-5',
				permission_tier: 'workspaceWrite',
				snapshot_id: snap1.id,
				idempotency_key: 'attempt-1-key',
				started_at: env.clock.now(),
				ended_at: env.clock.now(),
			});

			// User decides codex is inappropriate and redispatches to claude (E-121)
			const res = await env.service.redispatchRun({
				taskId: 'task-1',
				agentId: 'claude',
				model: 'claude-3-7-sonnet',
				permissionTier: 'workspaceWrite',
				idempotencyKey: 'attempt-2-redispatch',
			});

			expect(res.isExisting).toBe(false);
			expect(res.run.attemptNo).toBe(2);
			expect(res.run.agentId).toBe('claude');
			expect(res.run.modelName).toBe('claude-3-7-sonnet');
			expect(res.run.state).toBe('starting');

			// Old run is kept as read-only historical record in the database
			const allRuns = env.runsRepo.listByTaskId('task-1');
			expect(allRuns.length).toBe(2);
			const oldRun = allRuns.find((r) => r.id === 'run-1');
			expect(oldRun?.state).toBe('failed');
			expect(oldRun?.agent_id).toBe('codex');

			// New snapshot created for the new agent configuration
			expect(res.run.id).not.toBe('run-1');
		});

		it('默认开干净 worktree（fresh），除非显式选「在原改动上继续」（reuse）（E-121）', async () => {
			const env = createTestEnvironment();
			env.batchesRepo.insert({ id: 'b1', doc_id: 'doc-1', batch_no: 1, state: 'running' });
			env.tasksRepo.insert({
				id: 'task-wt',
				doc_id: 'doc-1',
				batch_id: 'b1',
				task_key: 'M8-WT',
				title: 'Worktree Test',
				module_key: 'M8',
				deps_json: '[]',
				contract_hash: 'hash-wt',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
			});

			// Default: no worktreeMode specified -> defaults to 'fresh'
			const resFresh = await env.service.redispatchRun({
				taskId: 'task-wt',
				agentId: 'codex',
				idempotencyKey: 'redispatch-fresh-key',
			});

			const latestSnapFresh = env.dispatchSnapshotsRepo.findLatestByTaskId('task-wt');
			expect(latestSnapFresh).not.toBeNull();
			const parsedFresh = JSON.parse(latestSnapFresh?.launch_spec_json ?? '{}');
			expect(parsedFresh.worktreeMode).toBe('fresh');

			// Transition attempt 1 to terminal state and advance time
			env.runsRepo.updateState({ id: resFresh.run.id, state: 'failed' });
			env.clock.advance(1000);

			// Explicitly passing 'reuse' -> launch spec records 'reuse'
			const resReuse = await env.service.redispatchRun({
				taskId: 'task-wt',
				agentId: 'claude',
				worktreeMode: 'reuse',
				idempotencyKey: 'redispatch-reuse-key',
			});

			const latestSnapReuse = env.dispatchSnapshotsRepo.findLatestByTaskId('task-wt');
			const parsedReuse = JSON.parse(latestSnapReuse?.launch_spec_json ?? '{}');
			expect(parsedReuse.worktreeMode).toBe('reuse');
			expect(resReuse.run.attemptNo).toBe(2);
		});
	});

	describe('AC 2 & E-177: 「原样重跑」严格复用原派发载荷', () => {
		it('严格复用原派发载荷（任务／agent／模型／批次／权限档／snapshot_id），不新建快照（AC 2, 决策 129）', async () => {
			const env = createTestEnvironment();
			env.batchesRepo.insert({ id: 'b1', doc_id: 'doc-1', batch_no: 1, state: 'running' });
			env.tasksRepo.insert({
				id: 'task-original',
				doc_id: 'doc-1',
				batch_id: 'b1',
				task_key: 'M8-T5-ORIG',
				title: 'Original Task',
				module_key: 'M8',
				deps_json: '[]',
				contract_hash: 'hash-orig',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
			});

			const originalSnapshot = env.dispatchSnapshotsRepo.takeSnapshotForTask({
				taskId: 'task-original',
				launchSpecJson: JSON.stringify({
					agentId: 'codex',
					model: 'gpt-5.6-sol',
					permissionTier: 'workspaceWrite',
				}),
				createdAt: env.clock.now(),
			});

			env.runsRepo.insert({
				id: 'run-dead-orig',
				task_id: 'task-original',
				attempt_no: 1,
				kind: 'implement',
				state: 'failed',
				agent_id: 'codex',
				model_name: 'gpt-5.6-sol',
				permission_tier: 'workspaceWrite',
				snapshot_id: originalSnapshot.id,
				idempotency_key: 'orig-attempt-key',
				started_at: env.clock.now(),
				ended_at: env.clock.now(),
			});

			const snapCountBefore = env.dispatchSnapshotsRepo.listByTaskId('task-original').length;

			// Trigger rerun: strictly reuse original dispatch payload, no selectors accepted
			const rerunRes = await env.service.rerunRun({
				runId: 'run-dead-orig',
				idempotencyKey: 'rerun-confirm-key-1',
			});

			expect(rerunRes.run.attemptNo).toBe(2);
			expect(rerunRes.run.agentId).toBe('codex');
			expect(rerunRes.run.modelName).toBe('gpt-5.6-sol');
			expect(rerunRes.run.permissionTier).toBe('workspaceWrite');
			expect(rerunRes.run.parentRunId).toBe('run-dead-orig');
			expect(rerunRes.run.state).toBe('starting');

			// CRITICAL (AC 2, Decision 129): snapshot_id is identical to original, no new snapshot created
			const createdRunRow = env.runsRepo.findById(rerunRes.run.id);
			expect(createdRunRow?.snapshot_id).toBe(originalSnapshot.id);
			const snapCountAfter = env.dispatchSnapshotsRepo.listByTaskId('task-original').length;
			expect(snapCountAfter).toBe(snapCountBefore);
		});

		it('手机重跑撞上已在跑时幂等拦截，绝不产生第二次运行（E-177）', async () => {
			const env = createTestEnvironment();
			env.batchesRepo.insert({ id: 'b1', doc_id: 'doc-1', batch_no: 1, state: 'running' });
			env.tasksRepo.insert({
				id: 'task-racing',
				doc_id: 'doc-1',
				batch_id: 'b1',
				task_key: 'RACE-1',
				title: 'Racing Task',
				module_key: 'M8',
				deps_json: '[]',
				contract_hash: 'hash-race',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
			});

			const snap = env.dispatchSnapshotsRepo.takeSnapshotForTask({
				taskId: 'task-racing',
				launchSpecJson: JSON.stringify({ agentId: 'codex' }),
				createdAt: env.clock.now(),
			});

			// Task is already active (starting/running)
			env.runsRepo.insert({
				id: 'run-already-running',
				task_id: 'task-racing',
				attempt_no: 1,
				kind: 'implement',
				state: 'running',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: snap.id,
				idempotency_key: 'active-key',
				started_at: env.clock.now(),
			});

			// Rerun request hits while active -> intercepted, returns existing run
			const rerunRes = await env.service.rerunRun({
				runId: 'run-already-running',
				idempotencyKey: 'mobile-rerun-clash-key',
			});

			expect(rerunRes.run.id).toBe('run-already-running');
			expect(rerunRes.run.state).toBe('running');

			// Ensure no second run is created
			const allRuns = env.runsRepo.listByTaskId('task-racing');
			expect(allRuns.length).toBe(1);
		});

		it('幂等键拦截：相同 idempotencyKey 返回既有 run（E-126）', async () => {
			const env = createTestEnvironment();
			env.batchesRepo.insert({ id: 'b1', doc_id: 'doc-1', batch_no: 1, state: 'running' });
			env.tasksRepo.insert({
				id: 'task-idem',
				doc_id: 'doc-1',
				batch_id: 'b1',
				task_key: 'IDEM',
				title: 'Idempotency Task',
				module_key: 'M8',
				deps_json: '[]',
				contract_hash: 'hash-idem',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
			});

			const snap = env.dispatchSnapshotsRepo.takeSnapshotForTask({
				taskId: 'task-idem',
				launchSpecJson: JSON.stringify({ agentId: 'codex' }),
				createdAt: env.clock.now(),
			});

			env.runsRepo.insert({
				id: 'run-failed-idem',
				task_id: 'task-idem',
				attempt_no: 1,
				kind: 'implement',
				state: 'failed',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: snap.id,
				idempotency_key: 'key-attempt-1',
				started_at: env.clock.now(),
				ended_at: env.clock.now(),
			});

			const first = await env.service.rerunRun({
				runId: 'run-failed-idem',
				idempotencyKey: 'rerun-fixed-key',
			});
			expect(first.run.attemptNo).toBe(2);

			const second = await env.service.rerunRun({
				runId: 'run-failed-idem',
				idempotencyKey: 'rerun-fixed-key',
			});
			expect(second.run.id).toBe(first.run.id);

			const allRuns = env.runsRepo.listByTaskId('task-idem');
			expect(allRuns.length).toBe(2);
		});
	});

	describe('AC 3 & E-178: 重跑时原 agent 不在线', () => {
		it('原 agent 不可达时立即失败并明示，禁止静默回退到别的 agent 或模型（E-178）', async () => {
			// Environment where only 'claude' is online, 'codex' is offline
			const env = createTestEnvironment({ onlineAgents: ['claude'] });
			env.batchesRepo.insert({ id: 'b1', doc_id: 'doc-1', batch_no: 1, state: 'running' });
			env.tasksRepo.insert({
				id: 'task-offline',
				doc_id: 'doc-1',
				batch_id: 'b1',
				task_key: 'OFFLINE',
				title: 'Offline Agent Task',
				module_key: 'M8',
				deps_json: '[]',
				contract_hash: 'hash-off',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
			});

			const snap = env.dispatchSnapshotsRepo.takeSnapshotForTask({
				taskId: 'task-offline',
				launchSpecJson: JSON.stringify({ agentId: 'codex', model: 'gpt-5' }),
				createdAt: env.clock.now(),
			});

			env.runsRepo.insert({
				id: 'run-codex-dead',
				task_id: 'task-offline',
				attempt_no: 1,
				kind: 'implement',
				state: 'failed',
				agent_id: 'codex',
				model_name: 'gpt-5',
				permission_tier: 'workspaceWrite',
				snapshot_id: snap.id,
				idempotency_key: 'codex-fail-key',
				started_at: env.clock.now(),
				ended_at: env.clock.now(),
			});

			// When trying to rerun, codex is offline -> must reject with E_AGENT_UNAVAILABLE
			await expect(
				env.service.rerunRun({
					runId: 'run-codex-dead',
					idempotencyKey: 'rerun-offline-key',
				}),
			).rejects.toSatisfy((err: unknown) => {
				expect(err).toBeInstanceOf(AppError);
				const appErr = err as AppError;
				expect(appErr.code).toBe('E_AGENT_UNAVAILABLE');
				expect(appErr.message).toContain('not online');
				expect(appErr.details).toMatchObject({ agentId: 'codex' });
				return true;
			});

			// Ensure no run was created and no fallback to claude occurred
			const runs = env.runsRepo.listByTaskId('task-offline');
			expect(runs.length).toBe(1);
		});
	});

	describe('AC 4 & E-180: 文档快照已变更时禁止重跑', () => {
		it('决策 13 的三个标记（has_accept_changed/has_prompt_changed/is_removed_from_doc）任一为 1 时禁止重跑并抛 E_SNAPSHOT_STALE（E-180）', async () => {
			const env = createTestEnvironment();
			env.batchesRepo.insert({ id: 'b1', doc_id: 'doc-1', batch_no: 1, state: 'running' });

			// Task with has_accept_changed = 1
			env.tasksRepo.insert({
				id: 'task-accept-changed',
				doc_id: 'doc-1',
				batch_id: 'b1',
				task_key: 'TAC',
				title: 'Accept Changed',
				module_key: 'M8',
				deps_json: '[]',
				contract_hash: 'hash-tac',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
				has_accept_changed: 1,
			});

			const snap1 = env.dispatchSnapshotsRepo.takeSnapshotForTask({
				taskId: 'task-accept-changed',
				launchSpecJson: JSON.stringify({ agentId: 'codex' }),
				createdAt: env.clock.now(),
			});

			// Document changes after dispatch (Decision 13)
			env.dispatchSnapshotsRepo.updateTaskChangedFlags('task-accept-changed', {
				hasAcceptChanged: 1,
				hasPromptChanged: 0,
			});

			env.runsRepo.insert({
				id: 'run-tac',
				task_id: 'task-accept-changed',
				attempt_no: 1,
				kind: 'implement',
				state: 'failed',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: snap1.id,
				idempotency_key: 'tac-key',
				started_at: env.clock.now(),
				ended_at: env.clock.now(),
			});

			await expect(
				env.service.rerunRun({
					runId: 'run-tac',
					idempotencyKey: 'rerun-tac',
				}),
			).rejects.toSatisfy((err: unknown) => {
				expect(err).toBeInstanceOf(AppError);
				const appErr = err as AppError;
				expect(appErr.code).toBe('E_SNAPSHOT_STALE');
				expect(appErr.message).toContain('desktop');
				expect(appErr.details).toMatchObject({
					hasAcceptChanged: true,
				});
				return true;
			});

			// Task with has_prompt_changed = 1
			env.tasksRepo.insert({
				id: 'task-prompt-changed',
				doc_id: 'doc-1',
				batch_id: 'b1',
				task_key: 'TPC',
				title: 'Prompt Changed',
				module_key: 'M8',
				deps_json: '[]',
				contract_hash: 'hash-tpc',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
				has_prompt_changed: 1,
			});

			const snap2 = env.dispatchSnapshotsRepo.takeSnapshotForTask({
				taskId: 'task-prompt-changed',
				launchSpecJson: JSON.stringify({ agentId: 'codex' }),
				createdAt: env.clock.now(),
			});

			// Document changes after dispatch (Decision 13)
			env.dispatchSnapshotsRepo.updateTaskChangedFlags('task-prompt-changed', {
				hasAcceptChanged: 0,
				hasPromptChanged: 1,
			});

			env.runsRepo.insert({
				id: 'run-tpc',
				task_id: 'task-prompt-changed',
				attempt_no: 1,
				kind: 'implement',
				state: 'failed',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: snap2.id,
				idempotency_key: 'tpc-key',
				started_at: env.clock.now(),
				ended_at: env.clock.now(),
			});

			await expect(
				env.service.rerunRun({
					runId: 'run-tpc',
					idempotencyKey: 'rerun-tpc',
				}),
			).rejects.toSatisfy((err: unknown) => {
				expect(err).toBeInstanceOf(AppError);
				const appErr = err as AppError;
				expect(appErr.code).toBe('E_SNAPSHOT_STALE');
				return true;
			});
		});

		it('checkDocSnapshotStale helper function throws correctly on stale snapshot', () => {
			const taskNormal = {
				has_accept_changed: 0,
				has_prompt_changed: 0,
				is_removed_from_doc: 0,
			} as unknown as import('../../src/repo/tasks.ts').TaskRow;
			expect(() => checkDocSnapshotStale(taskNormal)).not.toThrow();

			const taskStale = {
				id: 'task-stale',
				has_accept_changed: 1,
				has_prompt_changed: 0,
				is_removed_from_doc: 0,
			} as unknown as import('../../src/repo/tasks.ts').TaskRow;
			expect(() => checkDocSnapshotStale(taskStale)).toThrow(AppError);
		});
	});

	describe('AC 5 & E-179: 所属批次已被超越时允许重跑但提示批次错位', () => {
		it('所属批次被后续批次超越时返回批次错位警告但放行重跑（E-179）', async () => {
			const env = createTestEnvironment();
			// Batch 1 has finished, Batch 2 is currently done, Batch 3 is running
			env.batchesRepo.insert({ id: 'b1', doc_id: 'doc-1', batch_no: 1, state: 'done' });
			env.batchesRepo.insert({ id: 'b2', doc_id: 'doc-1', batch_no: 2, state: 'done' });
			env.batchesRepo.insert({ id: 'b3', doc_id: 'doc-1', batch_no: 3, state: 'running' });

			// Task belongs to Batch 1
			env.tasksRepo.insert({
				id: 'task-batch-1',
				doc_id: 'doc-1',
				batch_id: 'b1',
				task_key: 'M8-T1-TASK',
				title: 'Batch 1 Task',
				module_key: 'M8',
				deps_json: '[]',
				contract_hash: 'hash-b1',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
			});

			const snap = env.dispatchSnapshotsRepo.takeSnapshotForTask({
				taskId: 'task-batch-1',
				launchSpecJson: JSON.stringify({ agentId: 'codex' }),
				createdAt: env.clock.now(),
			});

			env.runsRepo.insert({
				id: 'run-b1-failed',
				task_id: 'task-batch-1',
				attempt_no: 1,
				kind: 'implement',
				state: 'failed',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: snap.id,
				idempotency_key: 'b1-failed-key',
				started_at: env.clock.now(),
				ended_at: env.clock.now(),
			});

			// Verify checkBatchAlignment detects misalignment
			const taskRow = env.tasksRepo.findById('task-batch-1');
			expect(taskRow).not.toBeNull();
			if (!taskRow) {
				throw new Error('taskRow not found');
			}
			const alignment = checkBatchAlignment(taskRow, env.batchesRepo);
			expect(alignment.isMisaligned).toBe(true);
			expect(alignment.taskBatchNo).toBe(1);
			expect(alignment.currentMaxBatchNo).toBe(3);
			expect(alignment.message).toBe('批次 3 已开始，本条属批次 1');

			// Rerun IS ALLOWED and succeeds (告警优于阻断)
			const rerunRes = await env.service.rerunRun({
				runId: 'run-b1-failed',
				idempotencyKey: 'rerun-misaligned-key',
			});

			expect(rerunRes.run.attemptNo).toBe(2);
			expect(rerunRes.run.state).toBe('starting');
		});
	});

	describe('AC 6 & E-36: 模型名在派发时已失效', () => {
		it('不做前置白名单校验、直接透传模型名', async () => {
			const env = createTestEnvironment();
			env.batchesRepo.insert({ id: 'b1', doc_id: 'doc-1', batch_no: 1, state: 'running' });
			env.tasksRepo.insert({
				id: 'task-custom-model',
				doc_id: 'doc-1',
				batch_id: 'b1',
				task_key: 'MODEL-X',
				title: 'Model Task',
				module_key: 'M8',
				deps_json: '[]',
				contract_hash: 'hash-mx',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
			});

			// Dispatch with completely unknown/non-whitelisted model name
			const nonWhitelistedModel = 'unknown-experimental-model-v99';
			const res = await env.service.redispatchRun({
				taskId: 'task-custom-model',
				agentId: 'codex',
				model: nonWhitelistedModel,
				idempotencyKey: 'unknown-model-key',
			});

			expect(res.run.modelName).toBe(nonWhitelistedModel);

			// Terminal state to allow rerun
			env.runsRepo.updateState({ id: res.run.id, state: 'failed' });

			// Rerun also preserves the unknown model name verbatim without whitelist check
			const rerunRes = await env.service.rerunRun({
				runId: res.run.id,
				idempotencyKey: 'rerun-unknown-model-key',
			});

			expect(rerunRes.run.modelName).toBe(nonWhitelistedModel);
		});

		it('失败后标「派发失败·模型无效」且该任务不占用窗口名额（E-36）', async () => {
			const env = createTestEnvironment();
			env.batchesRepo.insert({ id: 'b1', doc_id: 'doc-1', batch_no: 1, state: 'running' });
			env.tasksRepo.insert({
				id: 'task-failed-model',
				doc_id: 'doc-1',
				batch_id: 'b1',
				task_key: 'FAIL-M',
				title: 'Failed Model Task',
				module_key: 'M8',
				deps_json: '[]',
				contract_hash: 'hash-fm',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
			});

			const snap = env.dispatchSnapshotsRepo.takeSnapshotForTask({
				taskId: 'task-failed-model',
				launchSpecJson: JSON.stringify({ agentId: 'codex', model: 'bad-model' }),
				createdAt: env.clock.now(),
			});

			env.runsRepo.insert({
				id: 'run-starting-bad-model',
				task_id: 'task-failed-model',
				attempt_no: 1,
				kind: 'implement',
				state: 'starting',
				agent_id: 'codex',
				model_name: 'bad-model',
				permission_tier: 'workspaceWrite',
				snapshot_id: snap.id,
				idempotency_key: 'bad-model-run-key',
				started_at: env.clock.now(),
			});

			// Set lane on task and pending gate to verify cleanup (E-36)
			env.tasksRepo.setLaneNo('task-failed-model', 1);
			env.gatesRepo.create({
				id: 'gate-bad-model',
				task_id: 'task-failed-model',
				run_id: 'run-starting-bad-model',
				kind: 'review',
				state: 'waiting',
				created_at: env.clock.now(),
			});

			// While starting, it is active and occupies slot
			expect(env.runsRepo.findActiveByTaskId('task-failed-model')).not.toBeNull();

			// Agent fails due to invalid model (E-36 / R1: atomic commit + logstore persist before bus)
			const initialTxCount = env.getUnitOfWorkRunCount();
			const updated = await env.service.handleModelInvalid({
				runId: 'run-starting-bad-model',
				agentStderrTail: 'Error: unknown model bad-model',
			});

			expect(updated.state).toBe('failed');
			expect(updated.queuedReason).toBe('派发失败·模型无效');
			expect(updated.reworkCount ?? 0).toBe(0);

			// R1: DB updates (state, lane_no, gates supersede) are wrapped in atomic unitOfWork transaction
			expect(env.getUnitOfWorkRunCount()).toBe(initialTxCount + 1);

			// Lane is released (tasks.lane_no set to NULL) and lane.released event is published (E-36)
			expect(env.tasksRepo.findById('task-failed-model')?.lane_no).toBeNull();
			const laneReleasedEvent = env.publishedEvents.find((e) => e.kind === 'lane.released');
			expect(laneReleasedEvent).toBeDefined();
			expect((laneReleasedEvent?.payload as { reason?: string })?.reason).toBe('failed');

			// R1: Events are persisted to logstore
			const persistedKinds = env.appendedEvents.map((e) => (e.envelope as { kind: string }).kind);
			expect(persistedKinds).toContain('run.state_changed');
			expect(persistedKinds).toContain('lane.released');

			// Pending gate is superseded so the approval card disappears (E-36)
			const gate = env.gatesRepo.findById('gate-bad-model');
			expect(gate?.state).toBe('decided');
			expect(gate?.comment).toBe('superseded');

			// Once marked failed, it is no longer active and does not occupy window quota
			expect(env.runsRepo.findActiveByTaskId('task-failed-model')).toBeNull();

			// Idempotency: calling again on terminal run does nothing and does not open new tx
			const txAfterFirst = env.getUnitOfWorkRunCount();
			const secondCall = await env.service.handleModelInvalid({
				runId: 'run-starting-bad-model',
			});
			expect(secondCall.state).toBe('failed');
			expect(env.getUnitOfWorkRunCount()).toBe(txAfterFirst);
		});
	});
});
