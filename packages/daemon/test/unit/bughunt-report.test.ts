import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import { describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../../src/config/registry.ts';
import type { UnitOfWork } from '../../src/db/unit-of-work.ts';
import { BUILTIN_BUGHUNT_PROMPT } from '../../src/domain/bughunt-builtin-prompt.ts';
import { assembleBughuntPrompt } from '../../src/domain/bughunt-prompt.ts';
import {
	type BughuntSectionName,
	decideBughuntOutcome,
	parseBughuntReport,
} from '../../src/domain/bughunt-report.ts';
import { RUN_TRANSITION_REASONS } from '../../src/domain/run-state-machine.ts';
import { WRAPUP_PROHIBITED_COMMANDS } from '../../src/domain/wrapup-prompt.ts';
import type {
	DispatchSnapshotInsertRow,
	DispatchSnapshotRow,
	DispatchSnapshotsRepo,
} from '../../src/repo/dispatch-snapshots.ts';
import type { GateInsertRow, GatesRepo } from '../../src/repo/gates.ts';
import type { RunInsertRow, RunRow, RunsRepo } from '../../src/repo/runs.ts';
import type { BughuntService } from '../../src/service/bughunt.ts';
import { createBughuntService } from '../../src/service/bughunt.ts';
import type { GateService } from '../../src/service/gates.ts';
import type { ReviewRunsRepo } from '../../src/service/review.ts';
import { createReviewService } from '../../src/service/review.ts';
import type { PipelineSettingsSummary, SettingsService } from '../../src/service/settings.ts';

const fixturesDir = resolve(__dirname, '../fixtures/bughunt');

function loadFixture(name: string): string {
	return readFileSync(resolve(fixturesDir, name), 'utf-8');
}

interface TestRunRecord {
	id: string;
	task_id: string | null;
	attempt_no: number;
	kind: string;
	parent_run_id: string | null;
	state: string;
	review_verdict: string | null;
	agent_id: string;
	model_name: string | null;
	reported_model: string | null;
	effort_tier: string | null;
	reported_effort: string | null;
	effort_vendor?: string | null;
	permission_tier: string;
	snapshot_id: string;
	worktree_path: string | null;
	branch_name: string | null;
	pid: number | null;
	exit_code: number | null;
	exit_signal: string | null;
	vendor_session_ref: string | null;
	changed_file_count: number | null;
	token_usage_json: string | null;
	unmapped_event_count: number;
	is_stall_suspected: number;
	rework_count: number;
	queued_reason: string | null;
	idempotency_key: string | null;
	actor_device_id: string | null;
	started_at: string | null;
	last_event_at: string | null;
	ended_at: string | null;
	lane_no?: number | null;
}

function createTestRunRecord(
	overrides: Partial<TestRunRecord> & { id: string; agent_id: string },
): TestRunRecord {
	return {
		task_id: 'task-1',
		attempt_no: 1,
		kind: 'implement',
		parent_run_id: null,
		state: 'reviewing',
		review_verdict: null,
		model_name: null,
		reported_model: null,
		effort_tier: null,
		reported_effort: null,
		permission_tier: 'workspaceWrite',
		snapshot_id: 'snap-1',
		worktree_path: null,
		branch_name: null,
		pid: null,
		exit_code: null,
		exit_signal: null,
		vendor_session_ref: null,
		changed_file_count: null,
		token_usage_json: null,
		unmapped_event_count: 0,
		is_stall_suspected: 0,
		rework_count: 0,
		queued_reason: null,
		idempotency_key: null,
		actor_device_id: null,
		started_at: null,
		last_event_at: null,
		ended_at: null,
		...overrides,
	};
}

describe('domain/bughunt-report (AC 4, AC 5, AC 6, E-307, E-308, E-320, E-321, 17 节)', () => {
	it('parses complete 5 sections successfully from clean fixture', () => {
		const text = loadFixture('clean.txt');
		const result = parseBughuntReport(text);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.bugs).toHaveLength(0);
		expect(result.fixed).toHaveLength(0);
		expect(result.notFixed).toHaveLength(0);
		expect(result.suspect).toHaveLength(0);
		expect(result.next).toHaveLength(1);
		expect(result.next[0]).toContain('全部测试通过');
		expect(result.maxOpenSeverity).toBeNull();
	});

	it('parses complete 5 sections from fixed fixture with bug items linked', () => {
		const text = loadFixture('fixed.txt');
		const result = parseBughuntReport(text);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.bugs).toHaveLength(1);
		expect(result.bugs[0]?.id).toBe('B1');
		expect(result.bugs[0]?.severity).toBe('S2');
		expect(result.bugs[0]?.isFixed).toBe(true);
		expect(result.fixed).toHaveLength(1);
		expect(result.fixed[0]?.id).toBe('B1');
		expect(result.notFixed).toHaveLength(0);
		expect(result.maxOpenSeverity).toBeNull();
	});

	it('parses complete 5 sections from open-s1 fixture and detects S1 severity', () => {
		const text = loadFixture('open-s1.txt');
		const result = parseBughuntReport(text);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.bugs).toHaveLength(1);
		expect(result.bugs[0]?.severity).toBe('S1');
		expect(result.bugs[0]?.isFixed).toBe(false);
		expect(result.notFixed).toHaveLength(1);
		expect(result.notFixed[0]?.severity).toBe('S1');
		expect(result.maxOpenSeverity).toBe('S1');
	});

	it('handles markdown headers and code fence wrappers', () => {
		const text = `\`\`\`markdown
# BUGS
- none

# FIXED
- none

# NOT_FIXED
- none

# SUSPECT
- none

# NEXT
- Done
\`\`\``;
		const result = parseBughuntReport(text);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.next).toEqual(['- Done']);
	});

	// 参数化测试：缺任一段返回精确缺段清单且不做部分解析（E-320）
	const sections: BughuntSectionName[] = ['BUGS', 'FIXED', 'NOT_FIXED', 'SUSPECT', 'NEXT'];
	for (const missingSection of sections) {
		it(`returns ok:false with missingSections=['${missingSection}'] when ${missingSection} is absent (E-320)`, () => {
			const reportWithoutSection = sections
				.filter((s) => s !== missingSection)
				.map((s) => `${s}\n- none`)
				.join('\n\n');

			const result = parseBughuntReport(reportWithoutSection);
			expect(result.ok).toBe(false);
			if (result.ok) return;

			expect(result.missingSections).toContain(missingSection);
			expect('bugs' in result).toBe(false);
			expect('fixed' in result).toBe(false);
			expect(result.error).toContain(missingSection);
		});
	}

	it('returns missing NEXT section for missing-next.txt fixture', () => {
		const text = loadFixture('missing-next.txt');
		const result = parseBughuntReport(text);

		expect(result.ok).toBe(false);
		if (result.ok) return;

		expect(result.missingSections).toEqual(['NEXT']);
	});

	describe('decideBughuntOutcome 6 combinations (AC 4, E-307, E-308, E-321, 17 节)', () => {
		it('1. FIXED non-empty and workspace diff non-empty -> rereview (reworkCount < 2)', () => {
			const parsed = parseBughuntReport(loadFixture('fixed.txt'));
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;

			const outcome = decideBughuntOutcome({
				report: parsed,
				hasWorkspaceDiff: true,
				reworkCount: 0,
			});

			expect(outcome.outcome).toBe('rereview');
			if (outcome.outcome === 'rereview') {
				expect(outcome.newReworkCount).toBe(1);
				expect(outcome.fixedItems).toHaveLength(1);
				expect(outcome.fixedItems[0]).toContain('B1');
			}
		});

		it('2. FIXED non-empty but diff is empty -> treat as NOT_FIXED with S2 (E-321)', () => {
			const parsed = parseBughuntReport(loadFixture('fixed.txt'));
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;

			const outcome = decideBughuntOutcome({
				report: parsed,
				hasWorkspaceDiff: false,
				reworkCount: 0,
			});

			expect(outcome.outcome).toBe('awaiting_human');
			if (outcome.outcome === 'awaiting_human') {
				expect(outcome.reason).toBe('bughunt_open_findings');
				expect(outcome.selfReportedFixedNoDiff).toBe(true);
				expect(outcome.notFixedItems?.some((i) => i.includes('自报已修但无改动'))).toBe(true);
			}
		});

		it('3. NOT_FIXED contains S1 -> open_findings (E-308)', () => {
			const parsed = parseBughuntReport(loadFixture('open-s1.txt'));
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;

			const outcome = decideBughuntOutcome({
				report: parsed,
				hasWorkspaceDiff: true,
				reworkCount: 0,
			});

			expect(outcome.outcome).toBe('awaiting_human');
			if (outcome.outcome === 'awaiting_human') {
				expect(outcome.reason).toBe('bughunt_open_findings');
			}
		});

		it('4. Only S3 and FIXED is empty -> gate (E-308, E-321)', () => {
			const text = `BUGS
- B1 [S3] 涉及 M7-T8：轻微排版问题 → 复现：略 → 根因：略 → style.css:10

FIXED
- none

NOT_FIXED
- B1 [S3] 涉及 M7-T8：排版留待后续批次统一调整 → 略 → 略 → style.css:10

SUSPECT
- none

NEXT
- 干净，仅剩 S3
`;
			const parsed = parseBughuntReport(text);
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;

			const outcome = decideBughuntOutcome({
				report: parsed,
				hasWorkspaceDiff: false,
				reworkCount: 0,
			});

			expect(outcome.outcome).toBe('gate');
		});

		it('5. All empty (clean) -> gate (E-321)', () => {
			const parsed = parseBughuntReport(loadFixture('clean.txt'));
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;

			const outcome = decideBughuntOutcome({
				report: parsed,
				hasWorkspaceDiff: false,
				reworkCount: 0,
			});

			expect(outcome.outcome).toBe('gate');
		});

		it('6. rereview but reworkCount >= 2 -> bughunt_fixed_over_limit (E-307)', () => {
			const parsed = parseBughuntReport(loadFixture('fixed.txt'));
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;

			const outcome = decideBughuntOutcome({
				report: parsed,
				hasWorkspaceDiff: true,
				reworkCount: 2,
			});

			expect(outcome.outcome).toBe('awaiting_human');
			if (outcome.outcome === 'awaiting_human') {
				expect(outcome.reason).toBe('bughunt_fixed_over_limit');
				expect(outcome.comment).toBe('bughunt_fixed_over_limit');
			}
		});
	});

	describe('bughunt-prompt checks (AC 2, 17 节)', () => {
		it('preserves 4-section order, verbatim material, and prohibitions without "允许 commit"', () => {
			const prompt = assembleBughuntPrompt({
				worktreePath: '/wt',
				branchName: 'b1',
				promptSource: 'builtin',
				task: { taskId: 't1', title: 'Task 1' },
			});

			for (const cmd of WRAPUP_PROHIBITED_COMMANDS) {
				expect(prompt).toContain(cmd);
			}
			expect(prompt).not.toContain('允许 commit');
			expect(prompt).toContain(BUILTIN_BUGHUNT_PROMPT.trim());
		});
	});

	describe('dispatchBughunt and agent assignment checks (AC 1, AC 2, E-328, E-341, 17 节)', () => {
		it('copies agent_id, model_name, effort_tier verbatim from implementation run and turns to human if agent is unavailable', async () => {
			const runs: TestRunRecord[] = [
				createTestRunRecord({
					id: 'impl-1',
					agent_id: 'offline-agent',
					model_name: 'gpt-4o-custom',
					effort_tier: 'high',
					worktree_path: '/wt/1',
					branch_name: 'task/1',
					lane_no: 1,
				}),
			];

			const gates: Array<{ id: string; comment: string }> = [];

			const mockRunsRepo: Partial<RunsRepo> = {
				findById: (id: string) => (runs.find((r) => r.id === id) as RunRow) ?? null,
				findByParentRunIdAndKind: (pid: string, k: string) =>
					(runs.find((r) => r.parent_run_id === pid && r.kind === k) as RunRow) ?? null,
				listByTaskId: (tid: string) => runs.filter((r) => r.task_id === tid) as RunRow[],
				insert: (row: RunInsertRow) => {
					runs.push(
						createTestRunRecord({
							id: row.id,
							task_id: row.task_id,
							attempt_no: row.attempt_no,
							kind: row.kind,
							parent_run_id: row.parent_run_id ?? null,
							state: row.state,
							agent_id: row.agent_id,
							model_name: row.model_name ?? null,
							effort_tier: row.effort_tier ?? null,
							worktree_path: row.worktree_path ?? null,
							branch_name: row.branch_name ?? null,
							lane_no: row.lane_no ?? null,
						}),
					);
				},
				updateState: (input: { id: string; toState?: string; queuedReason?: string | null }) => {
					const r = runs.find((x) => x.id === input.id);
					if (r) {
						if (input.toState) r.state = input.toState;
						if (input.queuedReason) r.queued_reason = input.queuedReason;
					}
				},
			};

			const mockGatesRepo: Partial<GatesRepo> = {
				create: (row: GateInsertRow) => {
					gates.push({ id: row.id, comment: row.comment ?? '' });
					return row as unknown as ReturnType<GatesRepo['create']>;
				},
			};

			const mockAgentRegistry: Partial<AgentRegistry> = {
				getSnapshot: () =>
					({
						version: 1,
						agents: {},
						defaults: { defaultModel: 'm', defaultEffortTier: 'low' },
					}) as unknown as ReturnType<AgentRegistry['getSnapshot']>,
			};

			const mockUnitOfWork: UnitOfWork = {
				run: <T>(fn: () => T): T => fn(),
			};

			const service = createBughuntService({
				runsRepo: mockRunsRepo as RunsRepo,
				gatesRepo: mockGatesRepo as GatesRepo,
				agentRegistry: mockAgentRegistry as AgentRegistry,
				unitOfWork: mockUnitOfWork,
				clock: { now: () => '2026-09-22T00:00:00.000Z' },
				ids: { newId: () => 'id-1' },
			});

			const result = await service.dispatchBughunt({ implRunId: 'impl-1' });
			expect(result.action).toBe('agent_unavailable');

			const impl = runs.find((r) => r.id === 'impl-1');
			expect(impl?.state).toBe('awaiting_human');
			expect(impl?.queued_reason).toBe(RUN_TRANSITION_REASONS.BUGHUNT_AGENT_UNAVAILABLE);
			expect(gates).toHaveLength(1);
			expect(gates[0]?.comment).toBe(RUN_TRANSITION_REASONS.BUGHUNT_AGENT_UNAVAILABLE);
		});

		it('dispatches bughunt with verbatim assignment when agent is available', async () => {
			const runs: TestRunRecord[] = [
				createTestRunRecord({
					id: 'impl-1',
					agent_id: 'online-agent',
					model_name: 'gpt-4o-custom',
					effort_tier: 'high',
					effort_vendor: null,
					worktree_path: '/wt/1',
					branch_name: 'task/1',
					lane_no: 2,
				}),
			];

			const mockRunsRepo: Partial<RunsRepo> = {
				findById: (id: string) => (runs.find((r) => r.id === id) as RunRow) ?? null,
				findByParentRunIdAndKind: (pid: string, k: string) =>
					(runs.find((r) => r.parent_run_id === pid && r.kind === k) as RunRow) ?? null,
				listByTaskId: (tid: string) => runs.filter((r) => r.task_id === tid) as RunRow[],
				insert: (row: RunInsertRow) => {
					runs.push(
						createTestRunRecord({
							id: row.id,
							task_id: row.task_id,
							attempt_no: row.attempt_no,
							kind: row.kind,
							parent_run_id: row.parent_run_id ?? null,
							state: row.state,
							agent_id: row.agent_id,
							model_name: row.model_name ?? null,
							effort_tier: row.effort_tier ?? null,
							effort_vendor: row.effort_vendor ?? null,
							worktree_path: row.worktree_path ?? null,
							branch_name: row.branch_name ?? null,
							lane_no: row.lane_no ?? null,
						}),
					);
				},
				updateState: (input: { id: string; toState?: string }) => {
					const r = runs.find((x) => x.id === input.id);
					if (r && input.toState) {
						r.state = input.toState;
					}
				},
			};

			const mockAgentRegistry: Partial<AgentRegistry> = {
				getSnapshot: () =>
					({
						version: 1,
						agents: {
							'online-agent': {
								id: 'online-agent',
								name: 'Online Agent',
								command: 'agent',
								args: [],
								env: {},
								capabilities: [],
							},
						},
						defaults: { defaultModel: 'm', defaultEffortTier: 'low' },
					}) as unknown as ReturnType<AgentRegistry['getSnapshot']>,
			};

			const mockUnitOfWork: UnitOfWork = {
				run: <T>(fn: () => T): T => fn(),
			};

			const service = createBughuntService({
				runsRepo: mockRunsRepo as RunsRepo,
				agentRegistry: mockAgentRegistry as AgentRegistry,
				unitOfWork: mockUnitOfWork,
				clock: { now: () => '2026-09-22T00:00:00.000Z' },
				ids: { newId: () => 'bughunt-1' },
			});

			const result = await service.dispatchBughunt({ implRunId: 'impl-1' });
			expect(result.action).toBe('dispatched');

			const bughunt = runs.find((r) => r.id === 'bughunt-1');
			expect(bughunt).toBeDefined();
			expect(bughunt?.kind).toBe('bughunt');
			expect(bughunt?.parent_run_id).toBe('impl-1');
			expect(bughunt?.state).toBe('queued');
			expect(bughunt?.agent_id).toBe('online-agent');
			expect(bughunt?.model_name).toBe('gpt-4o-custom');
			expect(bughunt?.effort_tier).toBe('high');
			expect(bughunt?.effort_vendor).toBeNull();
			expect(bughunt?.lane_no).toBe(2);

			// Implementation run stays reviewing
			const impl = runs.find((r) => r.id === 'impl-1');
			expect(impl?.state).toBe('reviewing');
		});

		it('creates dedicated snapshot with 4-section prompt and associates bughunt run (R1, AC 1, AC 2, E-316, E-329)', async () => {
			const runs: TestRunRecord[] = [
				createTestRunRecord({
					id: 'impl-1',
					agent_id: 'online-agent',
					model_name: 'gpt-4o-custom',
					effort_tier: 'high',
					effort_vendor: null,
					worktree_path: '/wt/1',
					branch_name: 'task/1',
					snapshot_id: 'snap-impl-orig',
					lane_no: 2,
				}),
			];

			const implSnapshotRow: DispatchSnapshotInsertRow = {
				id: 'snap-impl-orig',
				task_id: 'task-1',
				impl_prompt: '原始实施提示词',
				review_prompt: '原始审查提示词',
				bug_prompt: '文档提供的查 bug 提示词',
				accept_text: '验收标准原文',
				input_text: '输入段原文',
				output_text: '输出段原文',
				contract_hash: 'hash-impl',
				task_paths_json: '["packages/daemon/src/service/bughunt.ts"]',
				launch_spec_json: '{"agentId":"online-agent"}',
				created_at: '2026-09-21T00:00:00.000Z',
			};
			const snapshots: DispatchSnapshotInsertRow[] = [];
			const mockSnapshotsRepo: Partial<DispatchSnapshotsRepo> = {
				insert: (row) => {
					snapshots.push(row);
				},
				findById: (id: string) =>
					id === implSnapshotRow.id
						? (implSnapshotRow as DispatchSnapshotRow)
						: ((snapshots.find((s) => s.id === id) as DispatchSnapshotRow) ?? null),
			};

			const mockRunsRepo: Partial<RunsRepo> = {
				findById: (id: string) => (runs.find((r) => r.id === id) as RunRow) ?? null,
				findByParentRunIdAndKind: (pid: string, k: string) =>
					(runs.find((r) => r.parent_run_id === pid && r.kind === k) as RunRow) ?? null,
				listByTaskId: (tid: string) => runs.filter((r) => r.task_id === tid) as RunRow[],
				insert: (row: RunInsertRow) => {
					runs.push(
						createTestRunRecord({
							id: row.id,
							task_id: row.task_id,
							attempt_no: row.attempt_no,
							kind: row.kind,
							parent_run_id: row.parent_run_id ?? null,
							state: row.state,
							agent_id: row.agent_id,
							model_name: row.model_name ?? null,
							effort_tier: row.effort_tier ?? null,
							effort_vendor: row.effort_vendor ?? null,
							snapshot_id: row.snapshot_id,
							worktree_path: row.worktree_path ?? null,
							branch_name: row.branch_name ?? null,
							lane_no: row.lane_no ?? null,
						}),
					);
				},
			};

			const mockAgentRegistry: Partial<AgentRegistry> = {
				getSnapshot: () =>
					({
						version: 1,
						agents: {
							'online-agent': {
								id: 'online-agent',
								name: 'Online Agent',
								command: 'agent',
								args: [],
								env: {},
								capabilities: [],
							},
						},
						defaults: { defaultModel: 'm', defaultEffortTier: 'low' },
					}) as unknown as ReturnType<AgentRegistry['getSnapshot']>,
			};

			const mockUnitOfWork: UnitOfWork = {
				run: <T>(fn: () => T): T => fn(),
			};

			let idCounter = 0;
			const service = createBughuntService({
				runsRepo: mockRunsRepo as RunsRepo,
				dispatchSnapshotsRepo: mockSnapshotsRepo as DispatchSnapshotsRepo,
				agentRegistry: mockAgentRegistry as AgentRegistry,
				unitOfWork: mockUnitOfWork,
				clock: { now: () => '2026-09-22T00:00:00.000Z' },
				ids: { newId: () => `id-${++idCounter}` },
			});

			const result = await service.dispatchBughunt({ implRunId: 'impl-1' });
			expect(result.action).toBe('dispatched');

			// 新快照存在且包含四段提示词
			expect(snapshots).toHaveLength(1);
			const newSnapshot = snapshots[0];
			expect(newSnapshot).toBeDefined();
			expect(newSnapshot?.impl_prompt).toContain('# 查 bug 执行指令');
			expect(newSnapshot?.impl_prompt).toContain('## 引用材料');
			expect(newSnapshot?.impl_prompt).toContain('## 工作区指针与测试指令');
			expect(newSnapshot?.impl_prompt).toContain('不要提问、不要等待确认。');

			// bughunt 运行行关联到新快照，不再复用实施运行快照
			const bughuntRun = runs.find((r) => r.kind === 'bughunt');
			expect(bughuntRun).toBeDefined();
			expect(bughuntRun?.snapshot_id).toBe(newSnapshot?.id);
			const implRun = runs.find((r) => r.id === 'impl-1');
			expect(bughuntRun?.snapshot_id).not.toBe(implRun?.snapshot_id);

			// 子快照：parent 指向实施快照，文本列与契约信息逐字复制（09 节，「最近快照」查询按 parent_snapshot_id IS NULL 跳过）
			expect(newSnapshot?.parent_snapshot_id).toBe('snap-impl-orig');
			expect(newSnapshot?.bug_prompt).toBe('文档提供的查 bug 提示词');
			expect(newSnapshot?.review_prompt).toBe('原始审查提示词');
			expect(newSnapshot?.accept_text).toBe('验收标准原文');
			expect(newSnapshot?.contract_hash).toBe('hash-impl');
			expect(newSnapshot?.task_paths_json).toBe('["packages/daemon/src/service/bughunt.ts"]');
			expect(newSnapshot?.impl_prompt).not.toBe('原始实施提示词');

			// 第二次派发仍从实施快照取文档材料（E-316：取派发快照那一刻的文档，不回落内置版）
			const second = await service.dispatchBughunt({ implRunId: 'impl-1' });
			expect(second.action).toBe('already_exists');
			expect(snapshots).toHaveLength(1);
		});
	});

	describe('finalizeReviewRun and pipeline toggle (AC 1, E-306, 17 节)', () => {
		it('when pipeline.bughunt=0, does not create bughunt run and proceeds to landing gate', async () => {
			const runs: TestRunRecord[] = [
				createTestRunRecord({
					id: 'impl-1',
					agent_id: 'test-agent',
				}),
				createTestRunRecord({
					id: 'review-1',
					attempt_no: 2,
					kind: 'review',
					parent_run_id: 'impl-1',
					state: 'running',
					agent_id: 'test-agent',
					permission_tier: 'readOnly',
				}),
			];

			let landingGateCalled = false;
			let bughuntDispatched = false;

			const mockRunsRepo: ReviewRunsRepo = {
				findById: (id: string) => runs.find((r) => r.id === id) ?? null,
				updateState: () => {},
				findByParentRunIdAndKind: (pid: string, k: string) =>
					(runs.find((r) => r.parent_run_id === pid && r.kind === k) as RunRow) ?? null,
			};

			const mockSettingsService: Partial<SettingsService> = {
				getPipeline: (): PipelineSettingsSummary => ({
					bughunt: 0,
					wrapupMode: 'auto',
					reviewOverride: null,
					wrapupAssignment: { mode: 'follow' },
				}),
			};

			const mockBughuntService: Partial<BughuntService> = {
				dispatchBughunt: async () => {
					bughuntDispatched = true;
					return { action: 'dispatched' };
				},
			};

			const mockGatesService: Partial<GateService> = {
				resolveAfterReviewAndApply: async () => {
					landingGateCalled = true;
					return { outcome: 'landed', by: 'auto', gateKind: 'landing' } as const;
				},
			};

			const reviewService = createReviewService({
				runsRepo: mockRunsRepo,
				settingsService: mockSettingsService as SettingsService,
				bughuntService: mockBughuntService as BughuntService,
				gatesService: mockGatesService as GateService,
			});

			const res = await reviewService.finalizeReviewRun({
				reviewRunId: 'review-1',
				verdict: 'pass',
			});

			expect(res.action).toBe('landing_gate');
			expect(bughuntDispatched).toBe(false);
			expect(landingGateCalled).toBe(true);
		});

		it('when pipeline.bughunt=1, dispatches bughunt and implementation row stays reviewing', async () => {
			const runs: TestRunRecord[] = [
				createTestRunRecord({
					id: 'impl-1',
					agent_id: 'test-agent',
				}),
				createTestRunRecord({
					id: 'review-1',
					attempt_no: 2,
					kind: 'review',
					parent_run_id: 'impl-1',
					state: 'running',
					agent_id: 'test-agent',
					permission_tier: 'readOnly',
				}),
			];

			let bughuntDispatched = false;

			const mockRunsRepo: ReviewRunsRepo = {
				findById: (id: string) => runs.find((r) => r.id === id) ?? null,
				updateState: () => {},
				findByParentRunIdAndKind: (pid: string, k: string) =>
					(runs.find((r) => r.parent_run_id === pid && r.kind === k) as RunRow) ?? null,
			};

			const mockSettingsService: Partial<SettingsService> = {
				getPipeline: (): PipelineSettingsSummary => ({
					bughunt: 1,
					wrapupMode: 'auto',
					reviewOverride: null,
					wrapupAssignment: { mode: 'follow' },
				}),
			};

			const mockBughuntService: Partial<BughuntService> = {
				dispatchBughunt: async () => {
					bughuntDispatched = true;
					return { action: 'dispatched', bughuntRun: { id: 'bughunt-1' } as unknown as RunDto };
				},
			};

			const reviewService = createReviewService({
				runsRepo: mockRunsRepo,
				settingsService: mockSettingsService as SettingsService,
				bughuntService: mockBughuntService as BughuntService,
			});

			const res = await reviewService.finalizeReviewRun({
				reviewRunId: 'review-1',
				verdict: 'pass',
			});

			expect(res.action).toBe('bughunt_dispatched');
			expect(bughuntDispatched).toBe(true);
			expect(res.bughuntRunId).toBe('bughunt-1');
		});
	});
});
