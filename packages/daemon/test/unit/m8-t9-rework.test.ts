import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EffortTier } from '@agent-scheduler/shared/api/agents';
import { describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../../src/config/registry.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createBatchesRepo } from '../../src/repo/batches.ts';
import { createDispatchSnapshotsRepo } from '../../src/repo/dispatch-snapshots.ts';
import { createDocumentsRepo } from '../../src/repo/documents.ts';
import { createEventSeqRepo } from '../../src/repo/event-seq-repo.ts';
import { createRunsRepo, toRunDto } from '../../src/repo/runs.ts';
import { createTasksRepo } from '../../src/repo/tasks.ts';
import { createDispatchService } from '../../src/service/dispatch.ts';
import { readRunExitedStderrTail } from '../../src/service/logstore.ts';

function setupTestDatabase(): DatabaseConnection {
	const db = openDatabase(':memory:');
	const currentDir = resolve(import.meta.dirname, '../../migrations');
	const migrationFiles = readdirSync(currentDir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	const runner = createMigrationRunner({
		clock: { now: () => '2026-09-15T00:00:00.000Z' },
		database: db,
		fileSystem: {
			readDirectory: () => migrationFiles,
			readFile: (p: string) => readFileSync(resolve(currentDir, p), 'utf8'),
		},
	});
	runner.run(currentDir);
	return db;
}

describe('R1: 首派和自动补位的 runs 模型、思考强度及启动载荷须与 resolveAssignment 结果一致；旧行 assignment_source=NULL 的 DTO 读作 task', () => {
	it('旧行 assignment_source=NULL 的 DTO 读作 task', () => {
		const legacyRow = {
			id: 'run-legacy-1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'running',
			agent_id: 'claude',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			assignment_source: null,
		} as const;

		const dto = toRunDto(legacyRow as unknown as Parameters<typeof toRunDto>[0]);
		expect(dto.assignmentSource).toBe('task');
	});

	it('首派和自动补位写入 runs 的模型、思考强度及启动载荷与 resolveAssignment 一致', async () => {
		const db = setupTestDatabase();
		const documentsRepo = createDocumentsRepo(db);
		const batchesRepo = createBatchesRepo(db);
		const tasksRepo = createTasksRepo(db);
		const dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		const runsRepo = createRunsRepo(db);
		const eventSeqRepo = createEventSeqRepo(db);
		const testTime = '2026-09-15T10:00:00.000Z';
		let idCounter = 1;
		const ids = {
			newId: () => `id_${idCounter++}`,
		};

		documentsRepo.insert({
			id: 'doc-1',
			docs_path: '/abs/path/docs',
			project_name: 'test-project',
			repo_path: '/abs/path/repo',
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
			batch_id: 'batch-1',
			task_key: 'M1-T1',
			title: 'Task 1',
			module_key: 'M1',
			deps_json: '[]',
			task_paths_json: '["src/a.ts"]',
			contract_hash: 'hash-1',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1,
			manual_state: 'none',
			impl_prompt: 'prompt-1',
		});

		const fakeRegistry: AgentRegistry = {
			getSnapshot: () => ({
				version: 1,
				loadedAt: testTime,
				agents: {
					codex: {
						id: 'codex',
						name: 'Codex',
						family: 'openai',
						description: 'desc',
						command: 'codex',
						defaultModel: 'o3-mini',
						defaultEffortTier: { tier: 'high' },
						effortVendorMap: { high: 'high' },
						models: ['o3-mini'],
						availableEffortTiers: ['high'] as readonly EffortTier[],
					},
				},
				errors: [],
			}),
		} as unknown as AgentRegistry;

		const dispatchService = createDispatchService({
			tasksRepo,
			batchesRepo,
			documentsRepo,
			dispatchSnapshotsRepo,
			runsRepo,
			eventSeqRepo,
			clock: { now: () => testTime },
			ids,
			agentRegistry: fakeRegistry,
			agentLimits: 2,
			listDispatchableAgents: () => [{ agentId: 'codex', canDispatch: true, concurrencyLimit: 2 }],
		});

		// 首派：不传 model 和 effort，依赖 resolveAssignment 取默认
		const createResult = await dispatchService.createRun({
			taskId: 'task-1',
			agentId: 'codex',
			idempotencyKey: 'idemp-create-1',
		});

		const runInDb = runsRepo.findById(createResult.run.id);
		expect(runInDb?.model_name).toBe('o3-mini');
		expect(runInDb?.effort_tier).toBe('high');

		const snap = dispatchSnapshotsRepo.findById(runInDb?.snapshot_id ?? '');
		const launchSpec = JSON.parse(snap?.launch_spec_json ?? '{}');
		expect(launchSpec.model).toBe('o3-mini');
		expect(launchSpec.effort).toBe('high');

		// 自动补位（tick）：同样验证
		tasksRepo.insert({
			id: 'task-2',
			doc_id: 'doc-1',
			batch_id: 'batch-1',
			task_key: 'M1-T2',
			title: 'Task 2',
			module_key: 'M1',
			deps_json: '[]',
			task_paths_json: '["src/b.ts"]',
			contract_hash: 'hash-2',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1,
			manual_state: 'none',
			impl_prompt: 'prompt-2',
		});

		// 结束 task-1 的运行，让出 lane
		runsRepo.updateState({
			id: createResult.run.id,
			toState: 'landed',
			endedAt: testTime,
		});
		tasksRepo.updateManualState('task-1', 'landed');
		tasksRepo.clearLaneNo('task-1');

		const tickResult = await dispatchService.tick();
		expect(tickResult.runsDispatched.length).toBe(1);
		const autoRunId = tickResult.runsDispatched[0];
		const autoRunInDb = runsRepo.findById(autoRunId ?? '');
		expect(autoRunInDb?.model_name).toBe('o3-mini');
		expect(autoRunInDb?.effort_tier).toBe('high');

		const autoSnap = dispatchSnapshotsRepo.findById(autoRunInDb?.snapshot_id ?? '');
		const autoLaunchSpec = JSON.parse(autoSnap?.launch_spec_json ?? '{}');
		expect(autoLaunchSpec.model).toBe('o3-mini');
		expect(autoLaunchSpec.effort).toBe('high');

		db.close();
	});
});

describe('R2: rework、bughunt、wrapup-fix 逐字使用任务指派；显式 null 不回落旧运行列，修复快照保留任务指派', () => {
	it('rework: 显式 null 不回落旧运行列，修复快照保留任务指派', async () => {
		const db = setupTestDatabase();
		const documentsRepo = createDocumentsRepo(db);
		const tasksRepo = createTasksRepo(db);
		const dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		const runsRepo = createRunsRepo(db);
		const testTime = '2026-09-15T10:00:00.000Z';
		let idCounter = 100;
		const ids = {
			newId: () => `id_${idCounter++}`,
		};

		documentsRepo.insert({
			id: 'doc-1',
			docs_path: '/abs/path/docs',
			project_name: 'test-project',
			repo_path: '/abs/path/repo',
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: 'fp-1',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: testTime,
			last_seen_at: testTime,
		});

		tasksRepo.insert({
			id: 'task-rework-1',
			doc_id: 'doc-1',
			task_key: 'M2-T1',
			title: 'Task Rework 1',
			module_key: 'M2',
			deps_json: '[]',
			task_paths_json: '["src/rework.ts"]',
			contract_hash: 'hash-r1',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1,
			manual_state: 'none',
			impl_prompt: 'original prompt',
		});

		// 实施快照中任务指派明确为 modelName: null, effortTier: null
		const snap1 = dispatchSnapshotsRepo.takeSnapshotForTask({
			taskId: 'task-rework-1',
			launchSpecJson: JSON.stringify({ adapterKind: 'native', agentId: 'dsh', model: null }),
			createdAt: testTime,
			assignmentJson: JSON.stringify({
				agentId: 'dsh',
				modelName: null,
				effortTier: null,
				effortVendor: null,
				source: 'task',
				capturedAt: testTime,
			}),
		});

		// 旧运行列因历史原因残留了旧模型和旧思考强度
		runsRepo.insert({
			id: 'run-target-1',
			task_id: 'task-rework-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'reviewing',
			agent_id: 'dsh',
			model_name: 'old-claude-model',
			effort_tier: 'high',
			permission_tier: 'workspaceWrite',
			snapshot_id: snap1.id,
			assignment_source: 'task',
			started_at: testTime,
			worktree_path: '/abs/path/repo/worktree',
			branch_name: 'task/M2-T1',
		});

		const { createReworkService } = await import('../../src/service/rework.ts');
		const reworkService = createReworkService({
			messageService: {} as unknown as never,
			runsRepo,
			snapshotsRepo: dispatchSnapshotsRepo,
			tasksRepo,
			documentsRepo,
			processRegistry: { get: () => undefined } as unknown as never,
			clock: { now: () => testTime },
			ids,
			enableSessionDispatch: true,
			spawnReworkRun: async ({ run }: { readonly run: { readonly id: string } }) => {
				runsRepo.updateState({ id: run.id, toState: 'running' });
			},
		} as unknown as Parameters<typeof createReworkService>[0]);

		const result = await reworkService.dispatchRework({
			targetRunId: 'run-target-1',
			reworkText: 'Fix this bug',
			source: 'review',
		});

		expect(result.action).toBe('new_session_spawned');
		const spawnedResult = result as { newRunId?: string };
		expect(spawnedResult.newRunId).toBeDefined();

		const newRun = runsRepo.findById(spawnedResult.newRunId ?? '');
		expect(newRun).toBeDefined();
		// 显式 null 绝不回落到旧运行列 'old-claude-model'
		expect(newRun?.model_name).toBeNull();
		expect(newRun?.effort_tier).toBeNull();

		// 修复快照必须保留任务指派
		const newSnap = dispatchSnapshotsRepo.findById(newRun?.snapshot_id ?? '');
		expect(newSnap).toBeDefined();
		expect(newSnap?.assignment_json).toBeDefined();
		const parsedAssignment = JSON.parse(newSnap?.assignment_json ?? '{}');
		expect(parsedAssignment.modelName).toBeNull();
		expect(parsedAssignment.agentId).toBe('dsh');

		db.close();
	});

	it('bughunt: 显式 null 不回落旧运行列，子快照保留任务指派', async () => {
		const db = setupTestDatabase();
		const documentsRepo = createDocumentsRepo(db);
		const tasksRepo = createTasksRepo(db);
		const dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		const runsRepo = createRunsRepo(db);
		const testTime = '2026-09-15T10:00:00.000Z';
		let idCounter = 200;
		const ids = {
			newId: () => `id_${idCounter++}`,
		};

		documentsRepo.insert({
			id: 'doc-1',
			docs_path: '/abs/path/docs',
			project_name: 'test-project',
			repo_path: '/abs/path/repo',
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: 'fp-1',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: testTime,
			last_seen_at: testTime,
		});

		tasksRepo.insert({
			id: 'task-bughunt-1',
			doc_id: 'doc-1',
			task_key: 'M2-T2',
			title: 'Task Bughunt 1',
			module_key: 'M2',
			deps_json: '[]',
			task_paths_json: '["src/bughunt.ts"]',
			contract_hash: 'hash-b1',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1,
			manual_state: 'none',
			impl_prompt: 'original prompt',
		});

		const snap1 = dispatchSnapshotsRepo.takeSnapshotForTask({
			taskId: 'task-bughunt-1',
			launchSpecJson: JSON.stringify({ agentId: 'codex', model: null }),
			createdAt: testTime,
			assignmentJson: JSON.stringify({
				agentId: 'codex',
				modelName: null,
				effortTier: null,
				effortVendor: null,
				source: 'task',
				capturedAt: testTime,
			}),
		});

		runsRepo.insert({
			id: 'run-impl-1',
			task_id: 'task-bughunt-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'reviewing',
			agent_id: 'codex',
			model_name: 'old-model-from-impl',
			effort_vendor: 'old-vendor-effort',
			permission_tier: 'workspaceWrite',
			snapshot_id: snap1.id,
			assignment_source: 'task',
			started_at: testTime,
			worktree_path: '/abs/path/repo/worktree',
			branch_name: 'task/M2-T2',
		});

		const { createBughuntService } = await import('../../src/service/bughunt.ts');
		const bughuntService = createBughuntService({
			runsRepo,
			tasksRepo,
			dispatchSnapshotsRepo,
			gitRunner: {
				run: async (args: readonly string[]) => ({
					exitCode: 0,
					stdout: args[0] === 'status' ? '' : `${'a'.repeat(40)}\n`,
					stderr: '',
				}),
			},
			clock: { now: () => testTime },
			ids,
			unitOfWork: { run: (fn: (result?: unknown) => void) => fn() } as unknown as never,
			agentRegistry: {
				getSnapshot: () => ({
					agents: { codex: { id: 'codex' } },
				}),
			} as unknown as never,
			agentService: {
				getAvailability: () => ({ canDispatch: true }),
			} as unknown as never,
		} as unknown as Parameters<typeof createBughuntService>[0]);

		const result = await bughuntService.dispatchBughunt({
			implRunId: 'run-impl-1',
		});

		expect(result.action).toBe('dispatched');
		expect(result.bughuntRun?.id).toBeDefined();

		const bughuntRun = runsRepo.findById(result.bughuntRun?.id ?? '');
		// 显式 null 绝不回落到旧运行列 'old-model-from-impl'
		expect(bughuntRun?.model_name).toBeNull();
		expect(bughuntRun?.effort_vendor).toBeNull();

		const bughuntSnap = dispatchSnapshotsRepo.findById(bughuntRun?.snapshot_id ?? '');
		expect(bughuntSnap?.assignment_json).toBeDefined();
		const parsedSnap = JSON.parse(bughuntSnap?.assignment_json ?? '{}');
		expect(parsedSnap.modelName).toBeNull();
		expect(parsedSnap.agentId).toBe('codex');

		db.close();
	});

	it('wrapup-fix: 显式 null 不回落旧运行列，修复快照保留任务指派', async () => {
		const db = setupTestDatabase();
		const documentsRepo = createDocumentsRepo(db);
		const batchesRepo = createBatchesRepo(db);
		const tasksRepo = createTasksRepo(db);
		const dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		const runsRepo = createRunsRepo(db);
		const { createBatchWrapupsRepo } = await import('../../src/repo/batch-wrapups.ts');
		const { createGatesRepo } = await import('../../src/repo/gates.ts');
		const batchWrapupsRepo = createBatchWrapupsRepo(db);
		const gatesRepo = createGatesRepo(db);
		const testTime = '2026-09-15T10:00:00.000Z';
		let idCounter = 300;
		const ids = {
			newId: () => `id_${idCounter++}`,
		};

		documentsRepo.insert({
			id: 'doc-1',
			docs_path: '/abs/path/docs',
			project_name: 'test-project',
			repo_path: '/abs/path/repo',
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
			id: 'task-wrapup-1',
			doc_id: 'doc-1',
			batch_id: 'batch-1',
			task_key: 'M2-T3',
			title: 'Task Wrapup 1',
			module_key: 'M2',
			deps_json: '[]',
			task_paths_json: '["src/wrapup.ts"]',
			contract_hash: 'hash-w1',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1,
			manual_state: 'none',
			impl_prompt: 'original prompt',
		});

		const snap1 = dispatchSnapshotsRepo.takeSnapshotForTask({
			taskId: 'task-wrapup-1',
			launchSpecJson: JSON.stringify({ agentId: 'codex', model: null }),
			createdAt: testTime,
			assignmentJson: JSON.stringify({
				agentId: 'codex',
				modelName: null,
				effortTier: null,
				effortVendor: null,
				source: 'task',
				capturedAt: testTime,
			}),
		});

		runsRepo.insert({
			id: 'run-impl-wrapup-1',
			task_id: 'task-wrapup-1',
			batch_id: 'batch-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'landed',
			agent_id: 'codex',
			model_name: 'old-wrapup-impl-model',
			effort_vendor: 'old-wrapup-effort-vendor',
			permission_tier: 'workspaceWrite',
			snapshot_id: snap1.id,
			assignment_source: 'task',
			started_at: testTime,
			worktree_path: '/abs/path/repo/worktree',
			branch_name: 'task/M2-T3',
		});

		const wrapupRunId = 'run-wrapup-main-1';
		runsRepo.insert({
			id: wrapupRunId,
			batch_id: 'batch-1',
			task_id: null,
			attempt_no: 1,
			kind: 'wrapup',
			state: 'running',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: snap1.id,
			assignment_source: 'task',
			started_at: testTime,
			worktree_path: '/abs/path/repo/worktree',
			branch_name: 'wrapup/batch-1-1',
		});

		const { createWrapupService } = await import('../../src/service/wrapup.ts');
		const wrapupService = createWrapupService({
			batchesRepo,
			tasksRepo,
			runsRepo,
			dispatchSnapshotsRepo,
			batchWrapupsRepo,
			gatesRepo,
			documentsRepo,
			batchService: {
				transitionBatchInTx: () => ({
					updatedBatch: { id: 'batch-1', state: 'running' },
					envelope: { kind: 'batch.state_changed', payload: {} },
				}),
			} as unknown as never,
			docsService: {} as unknown as never,
			unitOfWork: { run: (fn: (result?: unknown) => void) => fn() } as unknown as never,
			clock: { now: () => testTime },
			ids,
			agentRegistry: {
				getSnapshot: () => ({
					agents: { codex: { id: 'codex' } },
				}),
			} as unknown as never,
			agentService: {
				getAvailability: () => ({ canDispatch: true }),
			} as unknown as never,
		});

		const openReport = `## BATCH_SUMMARY
发现 1 处未修复问题

## TESTS
pass

## BUGS
- B1 [S2] 涉及 M2-T3: 格式错误 → parse → err → wrapup.ts:10

## FIXED
- none

## NOT_FIXED
- none

## SUSPECT
- none

## RECORD
verdict: open

## NEXT
需派发修复运行。`;

		await wrapupService.recordWrapupResult({
			runId: wrapupRunId,
			rawText: openReport,
			exitCode: 0,
		});

		const allRuns = runsRepo.listByTaskId('task-wrapup-1');
		const fixRun = allRuns.find((r) => r.origin === 'wrapup-fix');
		expect(fixRun).toBeDefined();
		// 显式 null 绝不回落到旧运行列 'old-wrapup-impl-model'
		expect(fixRun?.model_name).toBeNull();
		expect(fixRun?.effort_vendor).toBeNull();

		const fixSnap = dispatchSnapshotsRepo.findById(fixRun?.snapshot_id ?? '');
		expect(fixSnap?.assignment_json).toBeDefined();
		const parsedSnap = JSON.parse(fixSnap?.assignment_json ?? '{}');
		expect(parsedSnap.modelName).toBeNull();
		expect(parsedSnap.agentId).toBe('codex');

		db.close();
	});
});

describe('R3: 跨家审查子快照与审查运行行在同一事务插入；审查行插入失败时两者均回滚', () => {
	it('跨家审查行插入失败时，子快照必须一同回滚，不得残留孤立子快照', async () => {
		const db = setupTestDatabase();
		const { mkdtempSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const fakeWorktree = mkdtempSync(join(tmpdir(), 'r3-wt-'));
		const fakeRepo = mkdtempSync(join(tmpdir(), 'r3-repo-'));
		const { createUnitOfWork } = await import('../../src/db/unit-of-work.ts');
		const unitOfWork = createUnitOfWork(db);
		const documentsRepo = createDocumentsRepo(db);
		const tasksRepo = createTasksRepo(db);
		const dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		const baseRunsRepo = createRunsRepo(db);
		const testTime = '2026-09-15T10:00:00.000Z';
		let idCounter = 400;
		const ids = {
			newId: () => `id_${idCounter++}`,
		};

		documentsRepo.insert({
			id: 'doc-1',
			docs_path: '/abs/path/docs',
			project_name: 'test-project',
			repo_path: fakeRepo,
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: 'fp-1',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: testTime,
			last_seen_at: testTime,
		});

		tasksRepo.insert({
			id: 'task-r3-1',
			doc_id: 'doc-1',
			task_key: 'M3-T1',
			title: 'Task R3 1',
			module_key: 'M3',
			deps_json: '[]',
			task_paths_json: '["src/review.ts"]',
			contract_hash: 'hash-r3',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1,
			manual_state: 'none',
			impl_prompt: 'original prompt',
		});

		const snap1 = dispatchSnapshotsRepo.takeSnapshotForTask({
			taskId: 'task-r3-1',
			launchSpecJson: JSON.stringify({ agentId: 'claude', model: 'claude-3-7-sonnet' }),
			createdAt: testTime,
			assignmentJson: JSON.stringify({
				agentId: 'claude',
				modelName: 'claude-3-7-sonnet',
				effortTier: 'high',
				effortVendor: null,
				source: 'task',
				capturedAt: testTime,
			}),
		});

		baseRunsRepo.insert({
			id: 'run-impl-r3-1',
			task_id: 'task-r3-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'reviewing',
			agent_id: 'claude',
			model_name: 'claude-3-7-sonnet',
			effort_tier: 'high',
			permission_tier: 'workspaceWrite',
			snapshot_id: snap1.id,
			assignment_source: 'task',
			started_at: testTime,
			worktree_path: fakeWorktree,
			branch_name: 'task/M3-T1',
		});

		// 模拟审查行插入失败（例如数据库崩溃或约束冲突）
		const mockRunsRepo = {
			...baseRunsRepo,
			insert: (row: Parameters<typeof baseRunsRepo.insert>[0]) => {
				if (row.kind === 'review') {
					throw new Error('Simulated review run insert failure in R3 test');
				}
				return baseRunsRepo.insert(row);
			},
		};

		const { createReviewService } = await import('../../src/service/review.ts');
		const reviewService = createReviewService({
			runsRepo: mockRunsRepo,
			tasksRepo,
			dispatchSnapshotsRepo,
			documentsRepo,
			unitOfWork,
			clock: { now: () => testTime },
			ids,
			settingsService: {
				getPipeline: () => ({ reviewOverride: { agentId: 'codex' } }),
			} as unknown as never,
			agentRegistry: {
				getSnapshot: () => ({
					agents: {
						claude: { id: 'claude', family: 'anthropic' },
						codex: { id: 'codex', family: 'openai' },
					},
				}),
			} as unknown as never,
			spawnManaged: (() => ({ pid: 9999 })) as unknown as never,
		} as unknown as Parameters<typeof createReviewService>[0]);

		// 触发机械检查与审查派发
		const checkEvalRes = await reviewService.evaluateMechanicalCheck({
			runId: 'run-impl-r3-1',
			worktreePath: fakeWorktree,
			mainRepoPath: fakeRepo,
			exitCode: 0,
			diffStat: {
				hasChanges: true,
				filesChanged: 1,
				changedFileCount: 1,
				baseline: 'HEAD',
				insertions: 10,
				deletions: 0,
				files: [
					{ path: 'src/review.ts', insertions: 10, deletions: 0, status: 'modified' as const },
				],
			},
			diffText: 'diff --git a/src/review.ts b/src/review.ts\n+accept criteria\n+hello world',
			acceptText: 'accept criteria',
		});

		// 核心断言：审查运行插入失败时，子快照必须回滚，不得残留任何 parent_snapshot_id === snap1.id 的子快照
		const subSnap = db
			.prepare('SELECT id, parent_snapshot_id FROM dispatch_snapshots WHERE parent_snapshot_id = ?')
			.get(snap1.id);

		try {
			expect(subSnap).toBeUndefined();
		} finally {
			db.close();
			rmSync(fakeWorktree, { recursive: true, force: true });
			rmSync(fakeRepo, { recursive: true, force: true });
		}
	});
});

describe('R4: 零产出的状态两跳、闸门和泳道释放在同一事务完成；事件和登录复探在事务外', () => {
	it('闸门创建失败时，状态两跳与泳道释放必须回滚', async () => {
		const db = setupTestDatabase();
		const { createUnitOfWork } = await import('../../src/db/unit-of-work.ts');
		const unitOfWork = createUnitOfWork(db);
		const documentsRepo = createDocumentsRepo(db);
		const tasksRepo = createTasksRepo(db);
		const runsRepo = createRunsRepo(db);
		const { createGatesRepo } = await import('../../src/repo/gates.ts');
		const baseGatesRepo = createGatesRepo(db);
		const { createRunService } = await import('../../src/service/run.ts');
		const { createEnvelopeFactory } = await import('../../src/events/envelope.ts');
		const testTime = '2026-09-15T10:00:00.000Z';
		let envIdCounter = 1;
		const envelopeFactory = createEnvelopeFactory({
			idAllocator: { allocate: () => envIdCounter++ },
			clock: { now: () => testTime },
		});

		documentsRepo.insert({
			id: 'doc-1',
			docs_path: '/abs/path/docs',
			project_name: 'test-project',
			repo_path: '/abs/path/repo',
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: 'fp-1',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: testTime,
			last_seen_at: testTime,
		});

		tasksRepo.insert({
			id: 'task-r4-1',
			doc_id: 'doc-1',
			task_key: 'M4-T1',
			title: 'Task R4 1',
			module_key: 'M4',
			deps_json: '[]',
			task_paths_json: '["src/run.ts"]',
			contract_hash: 'hash-r4',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1,
			manual_state: 'none',
			impl_prompt: 'prompt',
		});
		tasksRepo.assignLaneNo('task-r4-1', 1);

		const dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		const snapR4 = dispatchSnapshotsRepo.takeSnapshotForTask({
			taskId: 'task-r4-1',
			launchSpecJson: '{}',
			createdAt: testTime,
		});

		runsRepo.insert({
			id: 'run-r4-1',
			task_id: 'task-r4-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'running',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: snapR4.id,
			assignment_source: 'task',
			started_at: testTime,
			lane_no: 1,
		});

		// 模拟闸门创建失败
		const mockGatesRepo = {
			...baseGatesRepo,
			create: () => {
				throw new Error('Simulated gate create error in R4 test');
			},
		};

		const runService = createRunService({
			logFailure: () => {},
			logstore: {
				appendRaw: async () => ({ location: { fileSeq: 0, byteOffset: 0, byteLen: 0 } }),
				appendEvent: async () => ({ location: { fileSeq: 0, byteOffset: 0, byteLen: 0 } }),
			} as unknown as never,
			bus: { publish: () => {} } as unknown as never,
			envelopeFactory,
			runsRepo: runsRepo as unknown as never,
			tasksRepo,
			gatesRepo: mockGatesRepo,
			unitOfWork,
			clock: { now: () => testTime },
			ids: { newId: () => 'id-r4' },
		});

		const onExitListeners = new Set<(res: unknown) => void>();
		const mockProc = {
			pid: 1234,
			stderrTail: '',
			onRaw: () => () => {},
			onJson: () => () => {},
			onExit: (fn: (result?: unknown) => void) => {
				onExitListeners.add(fn);
				return () => onExitListeners.delete(fn);
			},
			onError: () => () => {},
			kill: async () => ({ outcome: 'terminated', attempts: [] }),
			finalize: async () => {},
			emitExit: (exitCode = 0) => {
				for (const fn of onExitListeners) {
					fn({ runId: 'run-r4-1', pid: 1234, exitCode, signal: null, reason: 'exited' });
				}
			},
		};

		const controller = runService.attachProcess('run-r4-1', mockProc as unknown as never);
		mockProc.emitExit(0);
		await controller.waitForCompletion();

		const run = runsRepo.findById('run-r4-1');
		const task = tasksRepo.findById('task-r4-1');
		// 核心断言：因为闸门创建失败，同一事务全部回滚，运行行状态不得停留在 awaiting_human 或 reviewing！
		expect(run?.state).toBe('running');
		// 泳道不得被释放
		expect(task?.lane_no).toBe(1);

		db.close();
	});
});

describe('R5: follow 只选 state=landed 的实施运行；全人工落地返回 follow_source_missing', () => {
	it('当任务为人工落地但实施运行为 failed 时，findLandedImplementationRunsByBatchId 不得返回该运行，triggerWrapup 抛出 follow_source_missing', async () => {
		const db = setupTestDatabase();
		const documentsRepo = createDocumentsRepo(db);
		const batchesRepo = createBatchesRepo(db);
		const tasksRepo = createTasksRepo(db);
		const dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		const runsRepo = createRunsRepo(db);
		const { createBatchWrapupsRepo } = await import('../../src/repo/batch-wrapups.ts');
		const { createGatesRepo } = await import('../../src/repo/gates.ts');
		const batchWrapupsRepo = createBatchWrapupsRepo(db);
		const gatesRepo = createGatesRepo(db);
		const testTime = '2026-09-15T10:00:00.000Z';

		documentsRepo.insert({
			id: 'doc-1',
			docs_path: '/abs/path/docs',
			project_name: 'test-project',
			repo_path: '/abs/path/repo',
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
			id: 'batch-r5',
			doc_id: 'doc-1',
			batch_no: 1,
			state: 'running',
			started_at: testTime,
			finished_at: null,
		});

		// 任务全人工落地：manual_state = 'landed'
		tasksRepo.insert({
			id: 'task-r5-manual',
			doc_id: 'doc-1',
			batch_id: 'batch-r5',
			task_key: 'M5-T1',
			title: 'Task R5 Manual',
			module_key: 'M5',
			deps_json: '[]',
			task_paths_json: '["src/r5.ts"]',
			contract_hash: 'hash-r5',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1,
			manual_state: 'landed',
			impl_prompt: 'prompt',
		});

		const snapR5 = dispatchSnapshotsRepo.takeSnapshotForTask({
			taskId: 'task-r5-manual',
			launchSpecJson: '{}',
			createdAt: testTime,
		});

		// 实施运行状态为 failed，并非 landed，但代码已进 HEAD
		runsRepo.insert({
			id: 'run-r5-failed',
			task_id: 'task-r5-manual',
			batch_id: 'batch-r5',
			attempt_no: 1,
			kind: 'implement',
			state: 'failed',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: snapR5.id,
			assignment_source: 'task',
			is_in_head: 1,
			started_at: testTime,
			ended_at: testTime,
		});

		// 1. 测试 findLandedImplementationRunsByBatchId：只选 state='landed' 的实施运行
		const landedRuns = runsRepo.findLandedImplementationRunsByBatchId?.('batch-r5') ?? [];
		expect(landedRuns).toEqual([]);

		// 2. 测试 triggerWrapup：全人工落地返回 follow_source_missing
		const { createWrapupService } = await import('../../src/service/wrapup.ts');
		const wrapupService = createWrapupService({
			batchesRepo,
			tasksRepo,
			runsRepo,
			dispatchSnapshotsRepo,
			batchWrapupsRepo,
			gatesRepo,
			documentsRepo,
			batchService: {
				transitionBatch: async () => ({}),
			} as unknown as never,
			docsService: {} as unknown as never,
			unitOfWork: { run: (fn: (result?: unknown) => void) => fn() } as unknown as never,
			clock: { now: () => testTime },
			ids: { newId: () => 'id-r5' },
			agentRegistry: {
				getSnapshot: () => ({
					agents: { codex: { id: 'codex' } },
				}),
			} as unknown as never,
			agentService: {
				getAvailability: () => ({ canDispatch: true }),
			} as unknown as never,
		});

		let caughtError: unknown = null;
		try {
			await wrapupService.triggerWrapup({ batchId: 'batch-r5' });
		} catch (err) {
			caughtError = err;
		}

		expect(caughtError).toBeDefined();
		expect((caughtError as { details?: { reason?: string } })?.details?.reason).toBe(
			'follow_source_missing',
		);

		db.close();
	});
});

describe('R6: run.exited.stderrTail 即使进程只提供 stderrTail 字符串也必须先脱敏', () => {
	it('进程只提供包含密钥的 stderrTail 字符串时，run.exited.stderrTail 必须已被脱敏', async () => {
		const db = setupTestDatabase();
		const documentsRepo = createDocumentsRepo(db);
		const tasksRepo = createTasksRepo(db);
		const dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		const runsRepo = createRunsRepo(db);
		const { createGatesRepo } = await import('../../src/repo/gates.ts');
		const gatesRepo = createGatesRepo(db);
		const { createRunService } = await import('../../src/service/run.ts');
		const { createEnvelopeFactory } = await import('../../src/events/envelope.ts');
		const testTime = '2026-09-15T10:00:00.000Z';
		let envIdCounter = 1;
		const envelopeFactory = createEnvelopeFactory({
			idAllocator: { allocate: () => envIdCounter++ },
			clock: { now: () => testTime },
		});

		documentsRepo.insert({
			id: 'doc-1',
			docs_path: '/abs/path/docs',
			project_name: 'test-project',
			repo_path: '/abs/path/repo',
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: 'fp-1',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: testTime,
			last_seen_at: testTime,
		});

		tasksRepo.insert({
			id: 'task-r6-1',
			doc_id: 'doc-1',
			task_key: 'M6-T1',
			title: 'Task R6 1',
			module_key: 'M6',
			deps_json: '[]',
			task_paths_json: '["src/r6.ts"]',
			contract_hash: 'hash-r6',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1,
			manual_state: 'none',
			impl_prompt: 'prompt',
		});

		const snapR6 = dispatchSnapshotsRepo.takeSnapshotForTask({
			taskId: 'task-r6-1',
			launchSpecJson: '{}',
			createdAt: testTime,
		});

		runsRepo.insert({
			id: 'run-r6-1',
			task_id: 'task-r6-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'running',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: snapR6.id,
			assignment_source: 'task',
			started_at: testTime,
		});

		const publishedEvents: unknown[] = [];
		const ingestedEvents: unknown[] = [];

		const runService = createRunService({
			logFailure: () => {},
			logstore: {
				appendRaw: async () => ({ location: { fileSeq: 0, byteOffset: 0, byteLen: 0 } }),
				appendEvent: async (_runId: string, event: unknown) => {
					ingestedEvents.push(event);
					return { location: { fileSeq: 0, byteOffset: 0, byteLen: 0 } };
				},
			} as unknown as never,
			bus: {
				publish: (event: unknown) => {
					publishedEvents.push(event);
				},
			} as unknown as never,
			envelopeFactory,
			runsRepo: runsRepo as unknown as never,
			tasksRepo,
			gatesRepo,
			clock: { now: () => testTime },
			ids: { newId: () => 'id-r6' },
		});

		const onExitListeners = new Set<(res: unknown) => void>();
		// 模拟进程：只提供 stderrTail 字符串，且包含敏感 API KEY，stderrTailLines 为 undefined
		const secretKey = 'sk-ant-api03-abcdefghijklmnop1234567890';
		const mockProc = {
			pid: 1234,
			stderrTail: `fatal auth error: Bearer ${secretKey}`,
			stderrTailLines: undefined,
			onRaw: () => () => {},
			onJson: () => () => {},
			onExit: (fn: (result?: unknown) => void) => {
				onExitListeners.add(fn);
				return () => onExitListeners.delete(fn);
			},
			onError: () => () => {},
			kill: async () => ({ outcome: 'terminated', attempts: [] }),
			finalize: async () => {},
			emitExit: (exitCode = 1) => {
				for (const fn of onExitListeners) {
					fn({ runId: 'run-r6-1', pid: 1234, exitCode, signal: null, reason: 'exited' });
				}
			},
		};

		const controller = runService.attachProcess('run-r6-1', mockProc as unknown as never);
		mockProc.emitExit(1);
		await controller.waitForCompletion();

		const exitedEvent = (
			ingestedEvents as { kind?: string; payload?: { stderrTail?: unknown } }[]
		).find((e) => e.kind === 'run.exited');
		expect(exitedEvent).toBeDefined();

		const rawTail = exitedEvent?.payload?.stderrTail;
		const tailString = Array.isArray(rawTail) ? rawTail.join('\n') : String(rawTail);

		// 核心断言：即使只提供 stderrTail 字符串，敏感密钥必须被脱敏，绝不能出现在 run.exited 的 payload 中
		expect(tailString).not.toContain(secretKey);

		db.close();
	});
});

describe('R7 闸门 GET 经 logstore 有界读取末条 run.exited，处理旧事件、缺文件及大日志，不在 service 同步读整份文件', () => {
	it('新分段没有退出事件时，读取前一分段的末条 run.exited', async () => {
		const oldFile = join('/runs/run-r7', 'events.ndjson');
		const newFile = join('/runs/run-r7', 'events-1.ndjson');
		const files = new Map([
			[
				oldFile,
				Buffer.from(
					`${JSON.stringify({ kind: 'run.exited', payload: { stderrTail: ['older'] } })}\n${JSON.stringify({ kind: 'run.exited', payload: { stderrTail: ['latest'] } })}\n`,
				),
			],
			[newFile, Buffer.from(`${JSON.stringify({ kind: 'run.state_changed', payload: {} })}\n`)],
		]);
		const readRanges: Array<{ path: string; length: number }> = [];
		const fs = {
			listDirectory: () => ['events.ndjson', 'events-1.ndjson'],
			fileLenSync: (path: string) => files.get(path)?.length ?? null,
			readRange: async (path: string, start: number, end: number) => {
				readRanges.push({ path, length: end - start + 1 });
				return files.get(path)?.subarray(start, end + 1) ?? new Uint8Array();
			},
		};
		const result = await readRunExitedStderrTail({
			paths: {
				rootDir: '/runs',
				runDir: (runId: string) => `/runs/${runId}`,
				segmentPath: () => '',
			},
			fs: fs as never,
			runId: 'run-r7',
		});
		expect(readRanges.map((read) => read.path)).toEqual([newFile, oldFile]);
		expect(result).toEqual({ kind: 'lines', lines: ['latest'] });
		expect(readRanges.every((read) => read.length <= 64 * 1024)).toBe(true);
	});

	function setupR7Env(db: DatabaseConnection, idSuffix: string, testTime: string) {
		const documentsRepo = createDocumentsRepo(db);
		const batchesRepo = createBatchesRepo(db);
		const tasksRepo = createTasksRepo(db);
		const dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		const runsRepo = createRunsRepo(db);

		documentsRepo.insert({
			id: `doc-r7-${idSuffix}`,
			docs_path: '/abs/path/docs',
			project_name: 'test-project',
			repo_path: '/abs/path/repo',
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: 'fp-r7',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: testTime,
			last_seen_at: testTime,
		});

		batchesRepo.insert({
			id: `batch-r7-${idSuffix}`,
			doc_id: `doc-r7-${idSuffix}`,
			batch_no: 1,
			state: 'running',
			started_at: testTime,
			finished_at: null,
		});

		tasksRepo.insert({
			id: `task-r7-${idSuffix}`,
			doc_id: `doc-r7-${idSuffix}`,
			batch_id: `batch-r7-${idSuffix}`,
			task_key: `M7-${idSuffix}`,
			title: `Task R7 ${idSuffix}`,
			module_key: 'M7',
			deps_json: '[]',
			task_paths_json: '[]',
			contract_hash: 'hash-r7',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			est_days: 1,
			manual_state: 'none',
			impl_prompt: 'prompt',
		});

		const snapId = `snap-r7-${idSuffix}`;
		dispatchSnapshotsRepo.insert({
			id: snapId,
			task_id: `task-r7-${idSuffix}`,
			contract_hash: 'hash-r7',
			task_paths_json: '[]',
			assignment_json: '{}',
			launch_spec_json: '{}',
			created_at: testTime,
		});

		return { runsRepo, snapshotId: snapId, taskId: `task-r7-${idSuffix}` };
	}

	it('大日志场景：经 logstore.readRange 有界读取末条 run.exited，不读取整份大文件', async () => {
		const db = setupTestDatabase();
		const testTime = '2026-09-15T10:00:00.000Z';
		const { runsRepo, snapshotId, taskId } = setupR7Env(db, 'large', testTime);
		const { createGatesRepo } = await import('../../src/repo/gates.ts');
		const { createGateService } = await import('../../src/service/gates.ts');
		const gatesRepo = createGatesRepo(db);

		runsRepo.insert({
			id: 'run-r7-large',
			task_id: taskId,
			attempt_no: 1,
			kind: 'implement',
			state: 'awaiting_human',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: snapshotId,
			assignment_source: 'task',
			exit_code: 1,
			exit_signal: null,
			started_at: testTime,
		});

		gatesRepo.create({
			id: 'gate-r7-large',
			run_id: 'run-r7-large',
			task_id: taskId,
			kind: 'landing',
			state: 'waiting',
			comment: 'exited_before_output',
			created_at: testTime,
		});

		// 构造一个 200KB 的大日志内容，前面全是 dummy 行，末尾是 run.exited
		const dummyLine = `${JSON.stringify({
			kind: 'agent_message_chunk',
			payload: { chunk: 'x'.repeat(500) },
		})}\n`;
		const padding = dummyLine.repeat(350); // ~180KB
		const exitedLine = `${JSON.stringify({
			kind: 'run.exited',
			payload: {
				exitCode: 1,
				exitSignal: null,
				stderrTail: ['Line 1 from large log', 'Line 2 from large log'],
			},
		})}\n`;
		const fullLogContent = padding + exitedLine;
		const fullLogBytes = Buffer.from(fullLogContent, 'utf8');

		const readRangeCalls: { start: number; endInclusive: number }[] = [];
		let readFileCalled = false;

		const mockLogFs = {
			mkdirSync: () => {},
			listDirectory: () => ['events.ndjson'],
			appendFile: async () => {},
			readFile: async () => {
				readFileCalled = true;
				return fullLogBytes;
			},
			readRange: async (_path: string, start: number, endInclusive: number) => {
				readRangeCalls.push({ start, endInclusive });
				return fullLogBytes.subarray(start, endInclusive + 1);
			},
			fileLenSync: () => fullLogBytes.length,
			deleteFile: async () => {},
			truncateFile: async () => {},
			statfs: async () => ({ bavail: 1000, bsize: 4096 }),
		};

		const mockPaths = {
			rootDir: '/fake/runs',
			runDir: (id: string) => `/fake/runs/${id}`,
			segmentPath: (id: string, stream: string, seq: number) =>
				`/fake/runs/${id}/${stream}${seq === 0 ? '' : `-${seq}`}.ndjson`,
		};

		const gateService = createGateService({
			gatesRepo,
			runsRepo,
			clock: { now: () => testTime },
			ids: { newId: () => 'id-r7' },
			bus: { publish: () => {} } as unknown as never,
			envelopeFactory: {} as unknown as never,
			unitOfWork: { run: (fn: (result?: unknown) => void) => fn() } as unknown as never,
			settingsService: {} as unknown as never,
			logstorePaths: mockPaths,
			logFs: mockLogFs as unknown as never,
		});

		const response = await gateService.listGates();
		const gate = response.gates.find((g) => g.id === 'gate-r7-large');

		expect(gate).toBeDefined();
		expect(gate?.context?.exitCode).toBe(1);
		// 成功解析出末条 run.exited 的 stderrTail
		expect(gate?.context?.stderrTail).toEqual({
			kind: 'lines',
			lines: ['Line 1 from large log', 'Line 2 from large log'],
		});

		// 核心断言：经 logstore.readRange 有界读取，不读整份大文件
		expect(readFileCalled).toBe(false);
		expect(readRangeCalls.length).toBeGreaterThan(0);
		// 每次读取范围不超过 64KB (65536)
		for (const call of readRangeCalls) {
			expect(call.endInclusive - call.start + 1).toBeLessThanOrEqual(64 * 1024);
		}

		db.close();
	});

	it('缺文件场景：日志文件不存在时返回 event_missing，不抛异常崩溃', async () => {
		const db = setupTestDatabase();
		const testTime = '2026-09-15T10:00:00.000Z';
		const { runsRepo, snapshotId, taskId } = setupR7Env(db, 'missing', testTime);
		const { createGatesRepo } = await import('../../src/repo/gates.ts');
		const { createGateService } = await import('../../src/service/gates.ts');
		const gatesRepo = createGatesRepo(db);

		runsRepo.insert({
			id: 'run-r7-missing',
			task_id: taskId,
			attempt_no: 1,
			kind: 'implement',
			state: 'awaiting_human',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: snapshotId,
			assignment_source: 'task',
			exit_code: 1,
			exit_signal: null,
			started_at: testTime,
		});

		gatesRepo.create({
			id: 'gate-r7-missing',
			run_id: 'run-r7-missing',
			task_id: taskId,
			kind: 'landing',
			state: 'waiting',
			comment: 'exited_before_output',
			created_at: testTime,
		});

		const mockLogFs = {
			mkdirSync: () => {},
			listDirectory: () => {
				throw new Error('ENOENT: no such directory');
			},
			appendFile: async () => {},
			readFile: async () => {
				throw new Error('ENOENT: file missing');
			},
			readRange: async () => {
				throw new Error('ENOENT: file missing');
			},
			fileLenSync: () => null,
			deleteFile: async () => {},
			truncateFile: async () => {},
			statfs: async () => ({ bavail: 1000, bsize: 4096 }),
		};

		const mockPaths = {
			rootDir: '/fake/runs',
			runDir: (id: string) => `/fake/runs/${id}`,
			segmentPath: (id: string, stream: string, seq: number) =>
				`/fake/runs/${id}/${stream}${seq === 0 ? '' : `-${seq}`}.ndjson`,
		};

		const gateService = createGateService({
			gatesRepo,
			runsRepo,
			clock: { now: () => testTime },
			ids: { newId: () => 'id-r7' },
			bus: { publish: () => {} } as unknown as never,
			envelopeFactory: {} as unknown as never,
			unitOfWork: { run: (fn: (result?: unknown) => void) => fn() } as unknown as never,
			settingsService: {} as unknown as never,
			logstorePaths: mockPaths,
			logFs: mockLogFs as unknown as never,
		});

		const response = await gateService.listGates();
		const gate = response.gates.find((g) => g.id === 'gate-r7-missing');

		expect(gate).toBeDefined();
		expect(gate?.context?.stderrTail).toEqual({
			kind: 'unavailable',
			reason: 'event_missing',
			lines: [],
		});

		db.close();
	});

	it('旧事件场景：末条 run.exited 缺失 stderrTail 时返回 legacy_run', async () => {
		const db = setupTestDatabase();
		const testTime = '2026-09-15T10:00:00.000Z';
		const { runsRepo, snapshotId, taskId } = setupR7Env(db, 'legacy', testTime);
		const { createGatesRepo } = await import('../../src/repo/gates.ts');
		const { createGateService } = await import('../../src/service/gates.ts');
		const gatesRepo = createGatesRepo(db);

		runsRepo.insert({
			id: 'run-r7-legacy',
			task_id: taskId,
			attempt_no: 1,
			kind: 'implement',
			state: 'awaiting_human',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: snapshotId,
			assignment_source: 'task',
			exit_code: 1,
			exit_signal: null,
			started_at: testTime,
		});

		gatesRepo.create({
			id: 'gate-r7-legacy',
			run_id: 'run-r7-legacy',
			task_id: taskId,
			kind: 'landing',
			state: 'waiting',
			comment: 'exited_before_output',
			created_at: testTime,
		});

		// 旧版 run.exited 事件，没有 stderrTail
		const legacyExitedLine = `${JSON.stringify({
			kind: 'run.exited',
			payload: {
				exitCode: 1,
				exitSignal: null,
			},
		})}\n`;
		const logBytes = Buffer.from(legacyExitedLine, 'utf8');

		const mockLogFs = {
			mkdirSync: () => {},
			listDirectory: () => ['events.ndjson'],
			appendFile: async () => {},
			readFile: async () => logBytes,
			readRange: async (_path: string, start: number, endInclusive: number) => {
				return logBytes.subarray(start, endInclusive + 1);
			},
			fileLenSync: () => logBytes.length,
			deleteFile: async () => {},
			truncateFile: async () => {},
			statfs: async () => ({ bavail: 1000, bsize: 4096 }),
		};

		const mockPaths = {
			rootDir: '/fake/runs',
			runDir: (id: string) => `/fake/runs/${id}`,
			segmentPath: (id: string, stream: string, seq: number) =>
				`/fake/runs/${id}/${stream}${seq === 0 ? '' : `-${seq}`}.ndjson`,
		};

		const gateService = createGateService({
			gatesRepo,
			runsRepo,
			clock: { now: () => testTime },
			ids: { newId: () => 'id-r7' },
			bus: { publish: () => {} } as unknown as never,
			envelopeFactory: {} as unknown as never,
			unitOfWork: { run: (fn: (result?: unknown) => void) => fn() } as unknown as never,
			settingsService: {} as unknown as never,
			logstorePaths: mockPaths,
			logFs: mockLogFs as unknown as never,
		});

		const response = await gateService.listGates();
		const gate = response.gates.find((g) => g.id === 'gate-r7-legacy');

		expect(gate).toBeDefined();
		expect(gate?.context?.stderrTail).toEqual({
			kind: 'unavailable',
			reason: 'legacy_run',
			lines: [],
		});

		db.close();
	});
});
