import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitOfWork } from '../../src/db/unit-of-work.ts';
import type { EventBus } from '../../src/events/bus.ts';
import type { EnvelopeFactory } from '../../src/events/envelope.ts';
import type { ProcessRegistry } from '../../src/proc/registry.ts';
import type { ManagedProcess } from '../../src/proc/spawn.ts';
import type { DocumentsRepo } from '../../src/repo/documents.ts';
import type { GateInsertRow, GateRow, GatesRepo } from '../../src/repo/gates.ts';
import type { RunInsertRow, RunRow, RunsRepo } from '../../src/repo/runs.ts';
import type { TaskRow, TasksRepo } from '../../src/repo/tasks.ts';
import type { MessageService } from '../../src/service/message.ts';
import { type ReworkSnapshotsRepo, createReworkService } from '../../src/service/rework.ts';
import type { GitCommandResult, GitRunner, WorktreeManager } from '../../src/workspace/worktree.ts';

interface TestEnvelope {
	readonly id: string;
	readonly ts: string;
	readonly runId: string | null;
	readonly taskId: string | null;
	readonly scope: string;
	readonly kind: string;
	readonly seq: number;
	readonly actorDeviceId: string | null;
	readonly payload: {
		readonly mode?: string;
		readonly source?: string;
		readonly targetRunId?: string;
		readonly reviewRunId?: string | null;
		readonly reworkRunId?: string;
		readonly reworkCount?: number;
		readonly from?: string;
		readonly to?: string;
		readonly reason?: string;
		readonly gate?: string;
		readonly comment?: string;
		readonly [key: string]: unknown;
	};
}

describe('M7-T5: Rework session dispatch across 3 branches (AC 1-5, E-112, E-277, E-279, E-55, E-59, E-93)', () => {
	let runsStore: Map<string, RunRow>;
	let snapshotsStore: Map<
		string,
		{
			id?: string;
			task_id?: string;
			launch_spec_json: string;
			impl_prompt?: string | null;
			review_prompt?: string | null;
			bug_prompt?: string | null;
			contract_hash?: string;
			task_paths_json?: string;
			input_text?: string | null;
			output_text?: string | null;
			accept_text?: string | null;
			created_at?: string;
		}
	>;
	let gatesStore: Map<string, GateRow>;
	let publishedEvents: TestEnvelope[];
	let sentMessages: Array<{ runId: string; text: string; kind: string }>;
	let mockProcessRegistry: Map<string, ManagedProcess>;
	let mockMessageService: MessageService;
	let mockRunsRepo: RunsRepo;
	let mockSnapshotsRepo: ReworkSnapshotsRepo;
	let mockGatesRepo: GatesRepo;
	let mockTasksRepo: TasksRepo;
	let mockDocumentsRepo: DocumentsRepo;
	let mockUnitOfWork: UnitOfWork;
	let mockBus: EventBus;
	let mockEnvelopeFactory: EnvelopeFactory;
	let mockGitRunner: GitRunner;
	let mockWorktreeManager: WorktreeManager;
	let mockFs: {
		stat?: (path: string) => Promise<{ isDirectory(): boolean }>;
		access?: (path: string) => Promise<void>;
	};
	let resumeSessionMock: ReturnType<typeof vi.fn>;

	function createDummyRun(overrides?: Partial<RunRow>): RunRow {
		return {
			id: 'run-impl-1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			parent_run_id: null,
			state: 'reviewing',
			review_verdict: null,
			agent_id: 'codex',
			model_name: 'gpt-5-codex',
			reported_model: null,
			effort_tier: 'medium',
			reported_effort: null,
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			worktree_path: 'D:/worktrees/task-1',
			branch_name: 'task/M7-T5',
			pid: 12345,
			exit_code: null,
			exit_signal: null,
			vendor_session_ref: 'session-ref-1',
			changed_file_count: 3,
			token_usage_json: null,
			unmapped_event_count: 0,
			is_stall_suspected: 0,
			rework_count: 0,
			queued_reason: null,
			idempotency_key: 'idem-1',
			actor_device_id: 'device-1',
			started_at: '2026-09-16T08:00:00.000Z',
			last_event_at: '2026-09-16T08:05:00.000Z',
			ended_at: null,
			lane_no: 1,
			session_archived_at: null,
			origin: 'dispatch',
			spawned_by_run_id: null,
			...overrides,
		};
	}

	function createMockProcess(runId: string, alive = true): ManagedProcess {
		const mockStdin = {
			writable: alive,
			destroyed: !alive,
		} as unknown as Writable;

		const mockChild = {
			pid: 12345,
			killed: !alive,
			exitCode: alive ? null : 0,
			stdin: mockStdin,
		} as unknown as ChildProcess;

		return {
			runId,
			child: mockChild,
			isExited: !alive,
		} as unknown as ManagedProcess;
	}

	beforeEach(() => {
		runsStore = new Map();
		snapshotsStore = new Map();
		gatesStore = new Map();
		publishedEvents = [];
		sentMessages = [];
		mockProcessRegistry = new Map();

		mockRunsRepo = {
			insert: vi.fn().mockImplementation((row: RunInsertRow) => {
				runsStore.set(row.id, {
					...row,
					parent_run_id: row.parent_run_id ?? null,
					review_verdict: row.review_verdict ?? null,
					model_name: row.model_name ?? null,
					reported_model: row.reported_model ?? null,
					effort_tier: row.effort_tier ?? null,
					reported_effort: row.reported_effort ?? null,
					worktree_path: row.worktree_path ?? null,
					branch_name: row.branch_name ?? null,
					pid: row.pid ?? null,
					exit_code: row.exit_code ?? null,
					exit_signal: row.exit_signal ?? null,
					vendor_session_ref: row.vendor_session_ref ?? null,
					changed_file_count: row.changed_file_count ?? null,
					token_usage_json: row.token_usage_json ?? null,
					unmapped_event_count: row.unmapped_event_count ?? 0,
					is_stall_suspected: row.is_stall_suspected ?? 0,
					rework_count: row.rework_count ?? 0,
					queued_reason: row.queued_reason ?? null,
					idempotency_key: row.idempotency_key ?? null,
					actor_device_id: row.actor_device_id ?? null,
					started_at: row.started_at ?? null,
					last_event_at: row.last_event_at ?? null,
					ended_at: row.ended_at ?? null,
					origin: row.origin ?? 'dispatch',
					spawned_by_run_id: row.spawned_by_run_id ?? null,
				});
			}),
			findById: vi.fn().mockImplementation((id: string) => runsStore.get(id) ?? null),
			listByTaskId: vi.fn().mockImplementation((taskId: string) => {
				return Array.from(runsStore.values()).filter((r) => r.task_id === taskId);
			}),
			updateReworkCount: vi.fn().mockImplementation((input) => {
				const existing = runsStore.get(input.id);
				if (existing) {
					runsStore.set(input.id, {
						...existing,
						rework_count: input.reworkCount,
						state: input.state ?? existing.state,
					});
				}
			}),
			updateState: vi.fn().mockImplementation((input) => {
				const existing = runsStore.get(input.id);
				if (existing) {
					runsStore.set(input.id, {
						...existing,
						state: input.state ?? existing.state,
						queued_reason: input.queuedReason ?? existing.queued_reason,
					});
				}
			}),
			findByIdempotencyKey: vi.fn(),
			findByVendorSessionRef: vi.fn(),
			findActiveByTaskId: vi.fn(),
			listByTask: vi.fn(),
			listActive: vi.fn(),
			listAll: vi.fn(),
			markSessionsArchived: vi.fn(),
			listSucceededModelNames: vi.fn(),
		};

		mockSnapshotsRepo = {
			findById: vi.fn().mockImplementation((id: string) => snapshotsStore.get(id) ?? null),
			insert: vi.fn().mockImplementation((snapshot) => {
				snapshotsStore.set(snapshot.id, snapshot);
			}),
		};

		mockGatesRepo = {
			findById: vi.fn().mockImplementation((id: string) => gatesStore.get(id) ?? null),
			findLatestByTaskIdAndKind: vi.fn().mockImplementation((taskId: string, kind: string) => {
				const matching = Array.from(gatesStore.values()).filter(
					(g) => g.task_id === taskId && g.kind === kind,
				);
				return matching.length > 0 ? matching[matching.length - 1] : null;
			}),
			list: vi.fn().mockReturnValue([]),
			create: vi.fn().mockImplementation((gate: GateInsertRow) => {
				gatesStore.set(gate.id, {
					...gate,
					run_id: gate.run_id ?? null,
					decision: gate.decision ?? null,
					comment: gate.comment ?? null,
					decided_by_device_id: gate.decided_by_device_id ?? null,
					decided_at: gate.decided_at ?? null,
				});
			}),
			updateDecision: vi
				.fn()
				.mockImplementation((id, decision, comment, decidedByDeviceId, decidedAt) => {
					const existing = gatesStore.get(id);
					if (existing) {
						gatesStore.set(id, {
							...existing,
							decision,
							comment,
							decided_by_device_id: decidedByDeviceId,
							decided_at: decidedAt,
						});
						return true;
					}
					return false;
				}),
		};

		mockTasksRepo = {
			findById: vi.fn().mockReturnValue({
				id: 'task-1',
				doc_id: 'doc-1',
				task_key: 'M7-T5',
				title: 'Task M7-T5',
				batch_id: 'batch-1',
			} as unknown as TaskRow),
		} as unknown as TasksRepo;

		mockDocumentsRepo = {
			findById: vi.fn().mockReturnValue({
				id: 'doc-1',
				repo_path: 'D:/repo/main',
			}),
		} as unknown as DocumentsRepo;

		mockMessageService = {
			sendMessage: vi.fn().mockImplementation(async (input) => {
				sentMessages.push(input);
				return {
					delivered: true,
					messageId: `msg-${sentMessages.length}`,
					text: input.text,
					deliveryState: 'delivered' as const,
					runId: input.runId,
				};
			}),
			deliverMessage: vi.fn(),
			canReply: vi.fn().mockResolvedValue(true),
			getCapabilities: vi.fn().mockReturnValue({ canReply: true, canResume: true }),
			getMessage: vi.fn(),
			getRunMessages: vi.fn().mockResolvedValue([]),
			getUndeliveredMessages: vi.fn().mockResolvedValue([]),
		};

		mockUnitOfWork = {
			run: <T>(fn: () => T): T => fn(),
		};

		mockBus = {
			publish: (ev: unknown) => publishedEvents.push(ev as TestEnvelope),
			subscribe: vi.fn(),
			close: vi.fn(),
		} as unknown as EventBus;

		let eventSeq = 1;
		mockEnvelopeFactory = {
			createEnvelope: (input: {
				kind: string;
				runId?: string | null;
				taskId?: string | null;
				actorDeviceId?: string | null;
				payload: Record<string, unknown>;
			}) =>
				({
					id: `ev-${eventSeq++}`,
					ts: '2026-09-16T08:10:00.000Z',
					runId: input.runId ?? null,
					taskId: input.taskId ?? null,
					scope: 'run',
					kind: input.kind,
					seq: 1,
					actorDeviceId: input.actorDeviceId ?? null,
					payload: input.payload,
				}) as unknown as ReturnType<EnvelopeFactory['createEnvelope']>,
		} as unknown as EnvelopeFactory;

		mockGitRunner = {
			run: vi.fn().mockResolvedValue({
				exitCode: 0,
				stdout: 'commit-sha\n',
				stderr: '',
			} satisfies GitCommandResult),
		};

		mockWorktreeManager = {
			prepareWorktree: vi.fn().mockResolvedValue({
				worktreePath: 'D:/worktrees/rebuilt-task-1',
				branchName: 'task/M7-T5',
				baseRef: 'main',
				isReused: true,
			}),
		} as unknown as WorktreeManager;

		mockFs = {
			stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
			access: vi.fn().mockResolvedValue(undefined),
		};

		resumeSessionMock = vi.fn().mockResolvedValue({
			newRunId: 'run-resume-1',
			messageId: 'msg-resume-1',
			delivered: true,
		});
	});

	function makeService(overrides?: Partial<Parameters<typeof createReworkService>[0]>) {
		return createReworkService({
			runsRepo: mockRunsRepo,
			snapshotsRepo: mockSnapshotsRepo,
			tasksRepo: mockTasksRepo,
			documentsRepo: mockDocumentsRepo,
			gatesRepo: mockGatesRepo,
			messageService: mockMessageService,
			processRegistry: {
				get: (id: string) => mockProcessRegistry.get(id),
			} as unknown as ProcessRegistry,
			unitOfWork: mockUnitOfWork,
			bus: mockBus,
			envelopeFactory: mockEnvelopeFactory,
			gitRunner: mockGitRunner,
			worktreeManager: mockWorktreeManager,
			fs: mockFs,
			resumeSession: resumeSessionMock,
			clock: { now: () => '2026-09-16T08:10:00.000Z' },
			ids: { newId: () => 'new-run-id-789' },
			enableSessionDispatch: true,
			...overrides,
		});
	}

	describe('AC 1 & E-93: Capability-driven 3 branches without downgrade', () => {
		it('Branch 1 (inject): reinjects into living process when canReply=true and process is alive', async () => {
			const run = createDummyRun({ agent_id: 'codex', rework_count: 0 });
			runsStore.set(run.id, run);
			snapshotsStore.set('snap-1', {
				launch_spec_json: JSON.stringify({ adapterKind: 'native', agentId: 'codex' }),
			});
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: 'run-rev-1',
				targetRunId: run.id,
				reworkText: '- R1: 修复边界问题',
				source: 'review',
			});

			expect(result.success).toBe(true);
			expect(result.action).toBe('injected');
			expect(result.mode).toBe('inject');
			expect(result.reworkCount).toBe(1);

			// 检查消息已发送
			expect(mockMessageService.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					runId: run.id,
					text: '- R1: 修复边界问题',
					kind: 'reply',
				}),
			);

			// AC 4: 事务后发布 run.rework_dispatched{mode: 'inject', source: 'review'}
			const reworkEvent = publishedEvents.find((e) => e.kind === 'run.rework_dispatched');
			expect(reworkEvent).toBeDefined();
			expect(reworkEvent?.payload.mode).toBe('inject');
			expect(reworkEvent?.payload.source).toBe('review');
			expect(reworkEvent?.payload.reworkCount).toBe(1);
		});

		it('Branch 2 (resume, E-112): resumes session and creates new run when process ended and canResume=true', async () => {
			// codex native supports canResume; process has ended
			const run = createDummyRun({
				agent_id: 'codex',
				state: 'exited',
				rework_count: 0,
				vendor_session_ref: 'session-ref-original',
			});
			runsStore.set(run.id, run);
			snapshotsStore.set('snap-1', {
				launch_spec_json: JSON.stringify({ adapterKind: 'native', agentId: 'codex' }),
			});
			mockProcessRegistry.set(run.id, createMockProcess(run.id, false));

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: 'run-rev-1',
				targetRunId: run.id,
				reworkText: '- R1: 会话结束后的返工',
				source: 'review',
			});

			expect(result.success).toBe(true);
			expect(result.action).toBe('resumed');
			expect(result.mode).toBe('resume');
			if (result.action === 'resumed') {
				expect(result.newRunId).toBe('new-run-id-789');
				expect(result.reworkCount).toBe(1);
			}

			// 验证新运行记录创建及字段继承（E-112, AC 1）
			const createdRun = runsStore.get('new-run-id-789');
			expect(createdRun).toBeDefined();
			expect(createdRun?.origin).toBe('rework');
			expect(createdRun?.spawned_by_run_id).toBe('run-rev-1');
			expect(createdRun?.attempt_no).toBe(2);
			expect(createdRun?.rework_count).toBe(1);
			expect(createdRun?.branch_name).toBe(run.branch_name);
			expect(createdRun?.worktree_path).toBe(run.worktree_path);

			// 验证 resumeSession 得到调用
			expect(resumeSessionMock).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: 'task-1',
					agentId: 'codex',
					text: '- R1: 会话结束后的返工',
					kind: 'reply',
				}),
			);

			// AC 4: 事务后发布 run.rework_dispatched{mode: 'resume'}
			const reworkEvent = publishedEvents.find((e) => e.kind === 'run.rework_dispatched');
			expect(reworkEvent).toBeDefined();
			expect(reworkEvent?.payload.mode).toBe('resume');
			expect(reworkEvent?.payload.source).toBe('review');
			expect(reworkEvent?.payload.reworkRunId).toBe('new-run-id-789');
		});

		it('Branch 3 (new_session, E-279): spawns new implementation run when neither reply nor resume is supported', async () => {
			// dsh headless: canReply=false, canResume=false
			const run = createDummyRun({
				agent_id: 'dsh',
				state: 'reviewing',
				rework_count: 0,
			});
			runsStore.set(run.id, run);
			snapshotsStore.set('snap-1', {
				id: 'snap-1',
				task_id: 'task-1',
				launch_spec_json: JSON.stringify({ adapterKind: 'native', agentId: 'dsh' }),
				impl_prompt: `
# 实现任务 M7-T5
## 收到返工指令时
1. 自定义实施返工规则
## 结束
`,
			});
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: 'run-rev-99',
				targetRunId: run.id,
				reworkText: '```rework\n- R1: dsh 需要自包含提示词新开运行\n```',
				source: 'review',
			});

			expect(result.success).toBe(true);
			expect(result.action).toBe('new_session_spawned');
			expect(result.mode).toBe('new_session');
			if (result.action === 'new_session_spawned') {
				expect(result.newRunId).toBe('new-run-id-789');
				expect(result.reworkCount).toBe(1);
				expect(result.reworkPrompt).toContain('1. 自定义实施返工规则');
				expect(result.reworkPrompt).toContain('只改列出条目、不 commit/push');
			}

			// 验证新运行属性
			const createdRun = runsStore.get('new-run-id-789');
			expect(createdRun).toBeDefined();
			expect(createdRun?.origin).toBe('rework');
			expect(createdRun?.spawned_by_run_id).toBe('run-rev-99');
			expect(createdRun?.attempt_no).toBe(2);
			expect(createdRun?.rework_count).toBe(1);
			expect(createdRun?.branch_name).toBe(run.branch_name);
			expect(createdRun?.worktree_path).toBe(run.worktree_path);

			// AC 4: 事务后发布 run.rework_dispatched{mode: 'new_session'}
			const reworkEvent = publishedEvents.find((e) => e.kind === 'run.rework_dispatched');
			expect(reworkEvent).toBeDefined();
			expect(reworkEvent?.payload.mode).toBe('new_session');
			expect(reworkEvent?.payload.source).toBe('review');
			expect(reworkEvent?.payload.reworkRunId).toBe('new-run-id-789');
		});

		it('AC 1 & E-93: reads capability bit from snapshot launch_spec_json.adapterKind, ignoring runtime agent capability changes', async () => {
			// 快照中记录 adapterKind 为 generic-acp（此时 canReply=false, canResume=false）
			const run = createDummyRun({ agent_id: 'codex' });
			runsStore.set(run.id, run);
			snapshotsStore.set('snap-1', {
				launch_spec_json: JSON.stringify({ adapterKind: 'generic-acp', agentId: 'codex' }),
			});
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: 'run-rev-1',
				targetRunId: run.id,
				reworkText: '- R1: 依据快照 generic-acp 强制走新会话',
				source: 'review',
			});

			// 因为快照中为 generic-acp，即便 agentId 是 codex，也强制走分支三（new_session）
			expect(result.action).toBe('new_session_spawned');
			expect(result.mode).toBe('new_session');
			expect(mockMessageService.sendMessage).not.toHaveBeenCalled();
		});
	});

	describe('AC 2 & E-279: Self-contained rework prompt in new session', () => {
		it('generates self-contained prompt with fallback 4 rules when impl_prompt is missing', async () => {
			const run = createDummyRun({ agent_id: 'dsh' });
			runsStore.set(run.id, run);
			snapshotsStore.set('snap-1', {
				launch_spec_json: JSON.stringify({ adapterKind: 'native', agentId: 'dsh' }),
				impl_prompt: null,
			});

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: 'run-rev-1',
				targetRunId: run.id,
				reworkText: '- R1: 缺少提示词快照时的返工',
				source: 'review',
			});

			expect(result.action).toBe('new_session_spawned');
			if (result.action === 'new_session_spawned') {
				expect(result.reworkPrompt).toContain('只改指令列出的编号条目，不借机重构；');
				expect(result.reworkPrompt).toContain('工作区目录: D:/worktrees/task-1');
				expect(result.reworkPrompt).toContain('工作分支: task/M7-T5');
				expect(result.reworkPrompt).toContain('只改列出条目、不 commit/push');
			}
		});
	});

	describe('AC 3 & E-277: Missing worktree and branch validation', () => {
		it('rebuilds worktree on existing branch using M5-T1 reuse mode when directory is deleted', async () => {
			const run = createDummyRun({ agent_id: 'dsh' });
			runsStore.set(run.id, run);
			snapshotsStore.set('snap-1', {
				launch_spec_json: JSON.stringify({ adapterKind: 'native', agentId: 'dsh' }),
			});

			// 模拟 worktree 目录在磁盘上已不存在
			mockFs.stat = vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory'));
			mockFs.access = vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory'));

			// 模拟原分支在 git 中存在
			mockGitRunner.run = vi.fn().mockResolvedValue({
				exitCode: 0,
				stdout: 'commit-sha',
				stderr: '',
			});

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: 'run-rev-1',
				targetRunId: run.id,
				reworkText: '- R1: 重建工作区返工',
				source: 'review',
			});

			expect(result.success).toBe(true);
			expect(result.action).toBe('new_session_spawned');

			// 验证调用了 M5-T1 prepareWorktree 以 reuse 模式重建
			expect(mockWorktreeManager.prepareWorktree).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: 'task-1',
					preferredBranchName: 'task/M7-T5',
					worktreeMode: 'reuse',
				}),
			);

			// 新运行指向重建后的路径
			const createdRun = runsStore.get('new-run-id-789');
			expect(createdRun?.worktree_path).toBe('D:/worktrees/rebuilt-task-1');
		});

		it('transfers to awaiting_human and records branch_missing in gate comment when branch is missing (E-277)', async () => {
			const run = createDummyRun({ agent_id: 'dsh' });
			runsStore.set(run.id, run);
			snapshotsStore.set('snap-1', {
				launch_spec_json: JSON.stringify({ adapterKind: 'native', agentId: 'dsh' }),
			});

			// 模拟目录不存在
			mockFs.stat = vi.fn().mockRejectedValue(new Error('ENOENT'));
			mockFs.access = vi.fn().mockRejectedValue(new Error('ENOENT'));

			// 模拟分支在 git 仓库中也不存在 (exitCode !== 0)
			mockGitRunner.run = vi.fn().mockResolvedValue({
				exitCode: 128,
				stdout: '',
				stderr: 'fatal: Needed a single revision',
			});

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: 'run-rev-1',
				targetRunId: run.id,
				reworkText: '- R1: 分支丢失的返工',
				source: 'review',
			});

			expect(result.success).toBe(false);
			expect(result.action).toBe('awaiting_human');
			expect(result.mode).toBe('awaiting_human');
			if (result.action === 'awaiting_human') {
				expect(result.reason).toBe('branch_missing');
				expect(result.message).toContain('branch_missing');
			}

			// 不得调用 prepareWorktree 新开干净 worktree（E-277）
			expect(mockWorktreeManager.prepareWorktree).not.toHaveBeenCalled();

			// 目标运行转为 awaiting_human
			const updatedRun = runsStore.get(run.id);
			expect(updatedRun?.state).toBe('awaiting_human');
			expect(updatedRun?.queued_reason).toBe('branch_missing');

			// 闸门 comment 必须写入 branch_missing
			const gate = Array.from(gatesStore.values()).find((g) => g.task_id === 'task-1');
			expect(gate).toBeDefined();
			expect(gate?.comment).toBe('branch_missing');

			// 不得发出 run.rework_dispatched 事件
			const reworkEvent = publishedEvents.find((e) => e.kind === 'run.rework_dispatched');
			expect(reworkEvent).toBeUndefined();
		});
	});

	describe('AC 4 & E-55: Retry limit and rework_count increment', () => {
		it('increments rework_count and inherits previous count on new runs (+1)', async () => {
			const run = createDummyRun({
				agent_id: 'dsh',
				rework_count: 1, // 已有 1 次返工
			});
			runsStore.set(run.id, run);
			snapshotsStore.set('snap-1', {
				launch_spec_json: JSON.stringify({ adapterKind: 'native', agentId: 'dsh' }),
			});

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: 'run-rev-1',
				targetRunId: run.id,
				reworkText: '- R1: 第 2 次返工',
				source: 'review',
			});

			expect(result.success).toBe(true);
			expect(result.reworkCount).toBe(2);

			const newRun = runsStore.get('new-run-id-789');
			expect(newRun?.rework_count).toBe(2);
		});

		it('directly transfers reviewing to awaiting_human when rework_count already reached 2 (E-55)', async () => {
			const run = createDummyRun({
				agent_id: 'codex',
				state: 'reviewing',
				rework_count: 2, // 已达默认上限 2
			});
			runsStore.set(run.id, run);
			snapshotsStore.set('snap-1', {
				launch_spec_json: JSON.stringify({ adapterKind: 'native', agentId: 'codex' }),
			});
			mockProcessRegistry.set(run.id, createMockProcess(run.id, true));

			const service = makeService();
			const result = await service.dispatchRework({
				reviewRunId: 'run-rev-2',
				targetRunId: run.id,
				reworkText: '- R1: 达到上限的返工',
				source: 'review',
			});

			expect(result.success).toBe(false);
			expect(result.action).toBe('awaiting_human');
			expect(result.mode).toBe('awaiting_human');
			if (result.action === 'awaiting_human') {
				expect(result.reason).toBe('rework_limit_reached');
			}

			// 不进入任何三分支，不发送消息
			expect(mockMessageService.sendMessage).not.toHaveBeenCalled();
			expect(resumeSessionMock).not.toHaveBeenCalled();

			// 目标运行转为 awaiting_human
			const updatedRun = runsStore.get(run.id);
			expect(updatedRun?.state).toBe('awaiting_human');

			// 不得发布 run.rework_dispatched 事件
			const reworkEvent = publishedEvents.find((e) => e.kind === 'run.rework_dispatched');
			expect(reworkEvent).toBeUndefined();
		});
	});

	describe('AC 5 & E-59: Human rejection and review verdict share the same entrance', () => {
		it('handles human rework with source=human or source=manual through same pathway and increments count', async () => {
			const run = createDummyRun({
				agent_id: 'dsh',
				rework_count: 0,
			});
			runsStore.set(run.id, run);
			snapshotsStore.set('snap-1', {
				launch_spec_json: JSON.stringify({ adapterKind: 'native', agentId: 'dsh' }),
			});

			const service = makeService();
			const result = await service.dispatchRework({
				targetRunId: run.id,
				reworkText: '人工打回意见：测试不充分，请补测边界',
				source: 'human',
				actorDeviceId: 'device-human-1',
			});

			expect(result.success).toBe(true);
			expect(result.action).toBe('new_session_spawned');
			expect(result.source).toBe('human');
			expect(result.reworkCount).toBe(1);

			// 事件 payload 的 source 标明 human
			const reworkEvent = publishedEvents.find((e) => e.kind === 'run.rework_dispatched');
			expect(reworkEvent).toBeDefined();
			expect(reworkEvent?.payload.source).toBe('human');
			expect(reworkEvent?.actorDeviceId).toBe('device-human-1');
		});

		it('rejects empty rework comment for manual rework (E-59)', async () => {
			const run = createDummyRun({ agent_id: 'codex' });
			runsStore.set(run.id, run);

			const service = makeService();
			await expect(
				service.dispatchRework({
					targetRunId: run.id,
					reworkText: '   ',
					source: 'manual',
				}),
			).rejects.toThrow('Manual rework requires an attached comment.');
		});
	});
});
