import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import {
	buildConcurrencyPreview,
	listReleasableTaskIds,
	numberDraftSessions,
} from '../../src/domain/concurrency.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { type BatchesRepo, createBatchesRepo } from '../../src/repo/batches.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../../src/repo/documents.ts';
import { type RunsRepo, createRunsRepo } from '../../src/repo/runs.ts';
import { type TasksRepo, createTasksRepo } from '../../src/repo/tasks.ts';
import {
	type AssignmentsService,
	type RegistryAgentSummary,
	createAssignmentsService,
	parseAssignmentDraft,
} from '../../src/service/assignments.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(currentDir, '../../migrations');
const daemonSrc = resolve(currentDir, '../../src');

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
	{ agentId: 'dsh', maxConcurrency: 1, effortVendorMap: null },
]);

describe('M8-T11 assignments service (unit)', () => {
	let db: DatabaseConnection;
	let documentsRepo: DocumentsRepo;
	let batchesRepo: BatchesRepo;
	let tasksRepo: TasksRepo;
	let runsRepo: RunsRepo;
	let service: AssignmentsService;
	let testTime = '2026-09-19T02:11:04.120Z';
	let snapshotCounter = 1;

	const clock = { now: () => testTime };

	beforeEach(() => {
		testTime = '2026-09-19T02:11:04.120Z';
		snapshotCounter = 1;
		db = setupTestDatabase();
		documentsRepo = createDocumentsRepo(db);
		batchesRepo = createBatchesRepo(db);
		tasksRepo = createTasksRepo(db);
		runsRepo = createRunsRepo(db);

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
			state: 'idle',
			started_at: null,
			finished_at: null,
		});

		service = createAssignmentsService({
			unitOfWork: createUnitOfWork(db),
			tasksRepo,
			batchesRepo,
			documentsRepo,
			runsRepo,
			clock,
			listRegistryAgents: () => REGISTRY_AGENTS,
		});
	});

	afterEach(() => {
		db.close();
	});

	function seedTask(input: {
		readonly id: string;
		readonly taskKey: string;
		readonly batchId?: string;
		readonly deps?: readonly string[];
		readonly manualState?: string | null;
		readonly isRemovedFromDoc?: number;
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
			is_removed_from_doc: input.isRemovedFromDoc ?? 0,
			manual_state: input.manualState ?? null,
		});
	}

	function seedRun(input: {
		readonly id: string;
		readonly taskId: string;
		readonly agentId: string;
		readonly state: string;
		readonly attemptNo?: number;
	}) {
		const snapshotId = `snap_${snapshotCounter++}`;
		db.prepare(
			'INSERT INTO dispatch_snapshots (id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
		).run(snapshotId, input.taskId, 'hash', '[]', '{}', testTime);
		runsRepo.insert({
			id: input.id,
			task_id: input.taskId,
			attempt_no: input.attemptNo ?? 1,
			kind: 'implement',
			state: input.state,
			agent_id: input.agentId,
			permission_tier: 'workspaceWrite',
			snapshot_id: snapshotId,
			started_at: testTime,
		});
	}

	async function expectValidation(
		promise: Promise<unknown>,
		field: string,
		reason?: string,
	): Promise<void> {
		let caught: unknown;
		try {
			await promise;
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(AppError);
		const error = caught as AppError;
		expect(error.code).toBe('E_VALIDATION');
		expect(error.details?.field).toBe(field);
		if (reason) {
			expect(error.details?.reason).toBe(reason);
		}
	}

	describe('AC 1 & E-108: whole-batch overwrite and validation', () => {
		it('overwrites the whole batch: tasks left out of the array lose their draft', async () => {
			seedTask({ id: 'task-a', taskKey: 'M1-T1' });
			seedTask({ id: 'task-b', taskKey: 'M1-T2' });
			seedTask({ id: 'task-c', taskKey: 'M1-T3' });

			const first = await service.putDrafts({
				batchId: 'batch-1',
				assignments: [
					{ taskId: 'task-a', agentId: 'codex', model: 'gpt-5.6-sol', effort: { tier: 'high' } },
					{ taskId: 'task-b', agentId: 'claude' },
				],
			});
			expect(first.drafts.map((d) => d.taskId)).toEqual(['task-a', 'task-b']);
			expect(tasksRepo.findById('task-a')?.assignment_draft_json).toContain('"gpt-5.6-sol"');
			expect(tasksRepo.findById('task-c')?.assignment_draft_json).toBeNull();

			const second = await service.putDrafts({
				batchId: 'batch-1',
				assignments: [{ taskId: 'task-c', agentId: 'codex' }],
			});
			expect(second.drafts.map((d) => d.taskId)).toEqual(['task-c']);
			expect(tasksRepo.findById('task-a')?.assignment_draft_json).toBeNull();
			expect(tasksRepo.findById('task-b')?.assignment_draft_json).toBeNull();
			expect(parseAssignmentDraft(tasksRepo.findById('task-c')?.assignment_draft_json)).toEqual({
				agentId: 'codex',
				model: null,
				effort: null,
				draftedAt: testTime,
			});

			// An empty array clears every draft (E-108: back to the four-step empty state).
			const cleared = await service.putDrafts({ batchId: 'batch-1', assignments: [] });
			expect(cleared.drafts).toEqual([]);
			expect(service.readDrafts('batch-1')).toEqual([]);
		});

		it('rejects a taskId that belongs to another batch with details.field', async () => {
			batchesRepo.insert({
				id: 'batch-2',
				doc_id: 'doc-1',
				batch_no: 2,
				state: 'idle',
				started_at: null,
				finished_at: null,
			});
			seedTask({ id: 'task-a', taskKey: 'M1-T1' });
			seedTask({ id: 'task-other', taskKey: 'M2-T1', batchId: 'batch-2' });

			await expectValidation(
				service.putDrafts({
					batchId: 'batch-1',
					assignments: [
						{ taskId: 'task-a', agentId: 'codex' },
						{ taskId: 'task-other', agentId: 'codex' },
					],
				}),
				'assignments[1].taskId',
				'task_not_in_batch',
			);
			// Validation happens before any write: task-a keeps no draft.
			expect(tasksRepo.findById('task-a')?.assignment_draft_json).toBeNull();
		});

		it('rejects a task that has already been dispatched (active run or landed)', async () => {
			seedTask({ id: 'task-a', taskKey: 'M1-T1' });
			seedTask({ id: 'task-b', taskKey: 'M1-T2', manualState: 'landed' });
			seedRun({ id: 'run-a', taskId: 'task-a', agentId: 'codex', state: 'running' });

			await expectValidation(
				service.putDrafts({
					batchId: 'batch-1',
					assignments: [{ taskId: 'task-a', agentId: 'codex' }],
				}),
				'assignments[0].taskId',
				'task_dispatched',
			);
			await expectValidation(
				service.putDrafts({
					batchId: 'batch-1',
					assignments: [{ taskId: 'task-b', agentId: 'codex' }],
				}),
				'assignments[0].taskId',
				'task_landed',
			);
		});

		it('rejects duplicate taskIds in one body', async () => {
			seedTask({ id: 'task-a', taskKey: 'M1-T1' });
			await expectValidation(
				service.putDrafts({
					batchId: 'batch-1',
					assignments: [
						{ taskId: 'task-a', agentId: 'codex' },
						{ taskId: 'task-a', agentId: 'claude' },
					],
				}),
				'assignments[1].taskId',
				'duplicate_task',
			);
		});

		it('rejects an agentId that is not in the registry', async () => {
			seedTask({ id: 'task-a', taskKey: 'M1-T1' });
			await expectValidation(
				service.putDrafts({
					batchId: 'batch-1',
					assignments: [{ taskId: 'task-a', agentId: 'ghost-agent' }],
				}),
				'assignments[0].agentId',
				'agent_not_registered',
			);
		});

		it('E-336: a registered but logged_out agent is written as-is (no login gate in the write path)', async () => {
			seedTask({ id: 'task-a', taskKey: 'M1-T1' });
			// The registry projection carries no login state at all; the service cannot even ask.
			const loggedOutAware = createAssignmentsService({
				tasksRepo,
				batchesRepo,
				documentsRepo,
				runsRepo,
				clock,
				listRegistryAgents: () => REGISTRY_AGENTS,
			});
			const result = await loggedOutAware.putDrafts({
				batchId: 'batch-1',
				assignments: [{ taskId: 'task-a', agentId: 'claude', model: 'opus[1m]' }],
			});
			expect(result.drafts[0]?.agentId).toBe('claude');
			expect(result.drafts[0]?.model).toBe('opus[1m]');

			const serviceSource = readFileSync(resolve(daemonSrc, 'service/assignments.ts'), 'utf8');
			const dispatchSource = readFileSync(resolve(daemonSrc, 'service/dispatch.ts'), 'utf8');
			for (const source of [serviceSource, dispatchSource]) {
				expect(source).not.toMatch(/logged_out|getLogin\(|loginCache|refreshLogin/);
			}
		});

		it('validates effort against the agent domain via assertVendorEffortInDomain (M4-T14)', async () => {
			seedTask({ id: 'task-a', taskKey: 'M1-T1' });
			await expectValidation(
				service.putDrafts({
					batchId: 'batch-1',
					assignments: [{ taskId: 'task-a', agentId: 'claude', effort: { vendor: '999' } }],
				}),
				'assignments[0].effort',
			);
			await expectValidation(
				service.putDrafts({
					batchId: 'batch-1',
					assignments: [{ taskId: 'task-a', agentId: 'dsh', effort: { tier: 'high' } }],
				}),
				'assignments[0].effort',
				'effort_unsupported',
			);
			const ok = await service.putDrafts({
				batchId: 'batch-1',
				assignments: [{ taskId: 'task-a', agentId: 'claude', effort: { vendor: '8192' } }],
			});
			expect(ok.drafts[0]?.effort).toEqual({ vendor: '8192' });
		});

		it('returns E_NOT_FOUND for an unknown batch', async () => {
			await expect(service.putDrafts({ batchId: 'nope', assignments: [] })).rejects.toMatchObject({
				code: 'E_NOT_FOUND',
			});
			expect(() => service.readAssignments('nope')).toThrowError(AppError);
		});
	});

	describe('AC 2 & E-31: sessionNo = occupying runs + rank among same-agent drafts', () => {
		it('codex with one active run and two drafts -> 2 and 3; claude idle with one draft -> 1', async () => {
			seedTask({ id: 'task-busy', taskKey: 'M0-T1' });
			seedTask({ id: 'tsk_M4T5', taskKey: 'M4-T5' });
			seedTask({ id: 'tsk_M4T2', taskKey: 'M4-T2' });
			seedTask({ id: 'tsk_M5T1', taskKey: 'M5-T1' });
			seedRun({ id: 'run-busy', taskId: 'task-busy', agentId: 'codex', state: 'running' });

			const result = await service.putDrafts({
				batchId: 'batch-1',
				assignments: [
					{ taskId: 'tsk_M4T5', agentId: 'codex' },
					{ taskId: 'tsk_M4T2', agentId: 'codex', model: 'gpt-5.6-sol', effort: { tier: 'high' } },
					{ taskId: 'tsk_M5T1', agentId: 'claude', model: 'opus[1m]' },
				],
			});

			expect(result.drafts).toEqual([
				{
					taskId: 'tsk_M4T2',
					taskKey: 'M4-T2',
					agentId: 'codex',
					model: 'gpt-5.6-sol',
					effort: { tier: 'high' },
					sessionNo: 2,
					draftedAt: testTime,
				},
				{
					taskId: 'tsk_M4T5',
					taskKey: 'M4-T5',
					agentId: 'codex',
					model: null,
					effort: null,
					sessionNo: 3,
					draftedAt: testTime,
				},
				{
					taskId: 'tsk_M5T1',
					taskKey: 'M5-T1',
					agentId: 'claude',
					model: 'opus[1m]',
					effort: null,
					sessionNo: 1,
					draftedAt: testTime,
				},
			]);
		});

		it('does not count awaiting_human, orphaned or terminal runs as occupying (E-54, E-115)', async () => {
			seedTask({ id: 'task-1', taskKey: 'M0-T1' });
			seedTask({ id: 'task-2', taskKey: 'M0-T2' });
			seedTask({ id: 'task-3', taskKey: 'M0-T3' });
			seedTask({ id: 'task-4', taskKey: 'M0-T4' });
			seedTask({ id: 'task-d', taskKey: 'M1-T1' });
			seedRun({ id: 'run-1', taskId: 'task-1', agentId: 'codex', state: 'awaiting_human' });
			seedRun({ id: 'run-2', taskId: 'task-2', agentId: 'codex', state: 'orphaned' });
			seedRun({ id: 'run-3', taskId: 'task-3', agentId: 'codex', state: 'failed' });
			seedRun({ id: 'run-4', taskId: 'task-4', agentId: 'codex', state: 'awaiting_reply' });

			const result = await service.putDrafts({
				batchId: 'batch-1',
				assignments: [{ taskId: 'task-d', agentId: 'codex' }],
			});
			expect(result.drafts[0]?.sessionNo).toBe(2);
			expect(result.preview.agentCapacities.find((a) => a.agentId === 'codex')?.active).toBe(1);
		});

		it('numberDraftSessions is a pure function of taskKey order and active counts', () => {
			const numbered = numberDraftSessions(
				[
					{ taskId: 'b', taskKey: 'M4-T5', agentId: 'codex' },
					{ taskId: 'a', taskKey: 'M4-T2', agentId: 'codex' },
					{ taskId: 'c', taskKey: 'M5-T1', agentId: 'claude' },
				],
				(agentId) => (agentId === 'codex' ? 1 : 0),
			);
			expect(numbered.get('a')).toBe(2);
			expect(numbered.get('b')).toBe(3);
			expect(numbered.get('c')).toBe(1);
		});
	});

	describe('AC 3, E-52 & E-245: preview from calculateBatchConcurrency()', () => {
		function previewWith(input: {
			readonly userSetting: number;
			readonly windowCount: number;
			readonly drafts: readonly { taskId: string; agentId: string }[];
			readonly active?: Record<string, number>;
			readonly limits?: Record<string, number>;
		}) {
			return buildConcurrencyPreview({
				userSetting: input.userSetting,
				windowCount: input.windowCount,
				drafts: input.drafts,
				agentIds: ['codex', 'claude'],
				activeRunsByAgent: (agentId) => input.active?.[agentId] ?? 0,
				agentLimits: (agentId) => input.limits?.[agentId] ?? 2,
			});
		}

		it('user_setting bottleneck: two lanes, three releasable tasks, agents have room', () => {
			const preview = previewWith({
				userSetting: 2,
				windowCount: 3,
				drafts: [
					{ taskId: 'a', agentId: 'codex' },
					{ taskId: 'b', agentId: 'codex' },
					{ taskId: 'c', agentId: 'claude' },
				],
				active: { codex: 1 },
			});
			expect(preview.effectiveConcurrency).toBe(2);
			expect(preview.bottleneck).toBe('user_setting');
			expect(preview.userSetting).toBe(2);
			expect(preview.windowCount).toBe(3);
			expect(preview.exceedsWindowCount).toBe(false);
			expect(preview.agentCapacities).toEqual([
				{ agentId: 'codex', active: 1, limit: 2, drafted: 2, isFull: true },
				{ agentId: 'claude', active: 0, limit: 2, drafted: 1, isFull: false },
			]);
		});

		it('window_count bottleneck: one releasable task while lanes and agents allow more', () => {
			const preview = previewWith({
				userSetting: 4,
				windowCount: 1,
				drafts: [
					{ taskId: 'a', agentId: 'codex' },
					{ taskId: 'b', agentId: 'claude' },
				],
			});
			expect(preview.effectiveConcurrency).toBe(1);
			expect(preview.bottleneck).toBe('window_count');
			// E-245 / E-52: the user setting is echoed, not rewritten, and the unlock hint is set.
			expect(preview.userSetting).toBe(4);
			expect(preview.exceedsWindowCount).toBe(true);
		});

		it('agent_limit bottleneck: every draft points at a single-slot agent', () => {
			const preview = previewWith({
				userSetting: 3,
				windowCount: 3,
				drafts: [
					{ taskId: 'a', agentId: 'codex' },
					{ taskId: 'b', agentId: 'codex' },
					{ taskId: 'c', agentId: 'codex' },
				],
				limits: { codex: 1 },
			});
			expect(preview.effectiveConcurrency).toBe(1);
			expect(preview.bottleneck).toBe('agent_limit');
			expect(preview.agentCapacities[0]).toEqual({
				agentId: 'codex',
				active: 0,
				limit: 1,
				drafted: 3,
				isFull: true,
			});
		});

		it('service preview: windowCount is the releasable task count, userSetting is lane_count', async () => {
			seedTask({ id: 'task-a', taskKey: 'M1-T1' });
			seedTask({ id: 'task-b', taskKey: 'M1-T2' });
			seedTask({ id: 'task-c', taskKey: 'M1-T3', deps: ['M1-T1'] });
			seedTask({ id: 'task-d', taskKey: 'M1-T4', manualState: 'landed' });
			seedTask({ id: 'task-e', taskKey: 'M1-T5', deps: ['M1-T4'] });

			const empty = service.readAssignments('batch-1');
			// a, b (no deps) and e (dep landed) are releasable; c waits on a; d is landed.
			expect(empty.preview.windowCount).toBe(3);
			expect(empty.preview.userSetting).toBe(2);
			expect(empty.preview.exceedsWindowCount).toBe(false);
			expect(empty.drafts).toEqual([]);
			// With nothing drafted, calculateBatchConcurrency() evaluates an agent limit of 1 (M8-T1).
			expect(empty.preview.effectiveConcurrency).toBe(1);
			expect(empty.preview.bottleneck).toBe('agent_limit');
			// Every registry agent is listed even with zero drafts, alphabetically after drafted ones.
			expect(empty.preview.agentCapacities.map((a) => a.agentId)).toEqual([
				'claude',
				'codex',
				'dsh',
			]);

			const drafted = await service.putDrafts({
				batchId: 'batch-1',
				assignments: [
					{ taskId: 'task-a', agentId: 'codex' },
					{ taskId: 'task-b', agentId: 'codex' },
					{ taskId: 'task-e', agentId: 'claude' },
				],
			});
			// Agents could take 3, the window allows 3, the two lanes are the ceiling (E-52).
			expect(drafted.preview.effectiveConcurrency).toBe(2);
			expect(drafted.preview.bottleneck).toBe('user_setting');
			expect(drafted.preview.agentCapacities.map((a) => a.agentId)).toEqual([
				'codex',
				'claude',
				'dsh',
			]);
		});

		it('service preview flags exceedsWindowCount when lane_count exceeds releasable tasks', async () => {
			documentsRepo.updateLaneCount('doc-1', 6);
			seedTask({ id: 'task-a', taskKey: 'M1-T1' });
			seedTask({ id: 'task-b', taskKey: 'M1-T2', deps: ['M1-T1'] });

			// Both tasks are draftable, but only task-a is releasable until it lands.
			const view = await service.putDrafts({
				batchId: 'batch-1',
				assignments: [
					{ taskId: 'task-a', agentId: 'codex' },
					{ taskId: 'task-b', agentId: 'codex' },
				],
			});
			expect(view.preview.windowCount).toBe(1);
			expect(view.preview.userSetting).toBe(6);
			expect(view.preview.exceedsWindowCount).toBe(true);
			expect(view.preview.bottleneck).toBe('window_count');
			expect(view.preview.effectiveConcurrency).toBe(1);
			// E-245: the setting is echoed and stays untouched in the database.
			expect(documentsRepo.findById('doc-1')?.lane_count).toBe(6);
		});

		it('listReleasableTaskIds skips landed, active, removed, terminal-failed and dep-blocked tasks', () => {
			const releasable = listReleasableTaskIds(
				[
					{
						taskId: 'a',
						taskKey: 'A',
						deps: [],
						isLanded: false,
						hasActiveRun: false,
						isRemovedFromDoc: false,
						isTerminalFailed: false,
					},
					{
						taskId: 'b',
						taskKey: 'B',
						deps: ['A'],
						isLanded: false,
						hasActiveRun: false,
						isRemovedFromDoc: false,
						isTerminalFailed: false,
					},
					{
						taskId: 'c',
						taskKey: 'C',
						deps: ['Z'],
						isLanded: false,
						hasActiveRun: false,
						isRemovedFromDoc: false,
						isTerminalFailed: false,
					},
					{
						taskId: 'd',
						taskKey: 'D',
						deps: [],
						isLanded: true,
						hasActiveRun: false,
						isRemovedFromDoc: false,
						isTerminalFailed: false,
					},
					{
						taskId: 'e',
						taskKey: 'E',
						deps: [],
						isLanded: false,
						hasActiveRun: true,
						isRemovedFromDoc: false,
						isTerminalFailed: false,
					},
					{
						taskId: 'f',
						taskKey: 'F',
						deps: [],
						isLanded: false,
						hasActiveRun: false,
						isRemovedFromDoc: true,
						isTerminalFailed: false,
					},
					{
						taskId: 'g',
						taskKey: 'G',
						deps: [],
						isLanded: false,
						hasActiveRun: false,
						isRemovedFromDoc: false,
						isTerminalFailed: true,
					},
				],
				new Set(['Z']),
			);
			expect(releasable).toEqual(['a', 'c']);
		});
	});

	describe('E-47: one agent full does not touch other agents in the preview', () => {
		it('marks only the saturated agent as isFull', async () => {
			seedTask({ id: 'task-1', taskKey: 'M0-T1' });
			seedTask({ id: 'task-2', taskKey: 'M0-T2' });
			seedTask({ id: 'task-a', taskKey: 'M1-T1' });
			seedTask({ id: 'task-b', taskKey: 'M1-T2' });
			seedRun({ id: 'run-1', taskId: 'task-1', agentId: 'codex', state: 'running' });
			seedRun({ id: 'run-2', taskId: 'task-2', agentId: 'codex', state: 'running' });

			const view = await service.putDrafts({
				batchId: 'batch-1',
				assignments: [
					{ taskId: 'task-a', agentId: 'codex' },
					{ taskId: 'task-b', agentId: 'claude' },
				],
			});
			const codex = view.preview.agentCapacities.find((a) => a.agentId === 'codex');
			const claude = view.preview.agentCapacities.find((a) => a.agentId === 'claude');
			expect(codex).toEqual({ agentId: 'codex', active: 2, limit: 2, drafted: 1, isFull: true });
			expect(claude).toEqual({
				agentId: 'claude',
				active: 0,
				limit: 2,
				drafted: 1,
				isFull: false,
			});
			expect(view.drafts.find((d) => d.taskId === 'task-a')?.sessionNo).toBe(3);
			expect(view.drafts.find((d) => d.taskId === 'task-b')?.sessionNo).toBe(1);
		});
	});

	describe('parseAssignmentDraft', () => {
		it('reads only complete drafts and treats anything else as no draft', () => {
			expect(parseAssignmentDraft(null)).toBeNull();
			expect(parseAssignmentDraft('')).toBeNull();
			expect(parseAssignmentDraft('{not json')).toBeNull();
			expect(parseAssignmentDraft('{"agentId":"codex"}')).toBeNull();
			expect(
				parseAssignmentDraft('{"agentId":"codex","draftedAt":"t","effort":{"tier":"ultra"}}'),
			).toBeNull();
			expect(
				parseAssignmentDraft(
					'{"agentId":"codex","model":"gpt","effort":{"vendor":"xhigh"},"draftedAt":"t"}',
				),
			).toEqual({ agentId: 'codex', model: 'gpt', effort: { vendor: 'xhigh' }, draftedAt: 't' });
		});
	});
});
