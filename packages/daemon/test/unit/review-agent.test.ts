import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { describe, expect, it, vi } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import type { DatabaseConnection } from '../../src/db/open-database.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { AppError } from '../../src/errors/app-error.ts';
import type { EventBus } from '../../src/events/bus.ts';
import type { EnvelopeFactory } from '../../src/events/envelope.ts';
import { createRunsRepo } from '../../src/repo/runs.ts';
import {
	DEFAULT_MAX_DIFF_CHARS,
	PARTIAL_DIFF_ANNOTATION,
	PARTIAL_DIFF_NOTICE,
	buildReviewAgentPrompt,
	buildReviewLaunchSpec,
	dispatchReviewRun,
	formatFullDiffStat,
	isAcceptanceMatchedFile,
	prepareReviewRun,
	pruneDiff,
	readDefaultReviewAssignment,
} from '../../src/service/review-agent.ts';
import type { ReviewContext } from '../../src/service/review-context.ts';
import type { DiffFileStat, DiffStatResult } from '../../src/workspace/diff.ts';

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

function setupTestDb(): DatabaseConnection {
	const db = openDatabase(':memory:');
	const runner = createMigrationRunner({
		database: db,
		clock: { now: () => '2026-09-15T12:00:00.000Z' },
		fileSystem: {
			readDirectory: (p: string) => readdirSync(p),
			readFile: (p: string) => readFileSync(p, 'utf8'),
		},
	});
	runner.run(migrationsDirectory);

	try {
		db.prepare('ALTER TABLE runs ADD COLUMN assignment_source TEXT').run();
	} catch {}

	db.prepare(
		"INSERT INTO documents (id, docs_path, project_name, content_fingerprint, imported_at, last_seen_at) VALUES ('doc-1', '/doc/path', 'project', 'hash1', '2026-09-15T12:00:00.000Z', '2026-09-15T12:00:00.000Z')",
	).run();
	db.prepare(
		"INSERT INTO devices (id, name, token_hash, token_salt, paired_at, last_seen_at) VALUES ('dev-client-1', 'Test Device', 'hash', 'salt', '2026-09-15T12:00:00.000Z', '2026-09-15T12:00:00.000Z')",
	).run();
	db.prepare(
		"INSERT INTO tasks (id, doc_id, task_key, title, module_key, deps_json, contract_hash, contract_reasons_json) VALUES ('task-m7-t2-uuid', 'doc-1', 'M7-T2', 'title', 'M7', '[]', '81ad0fe05b6b8019d1fde21aa63d3df520864efe689ddc2a7dd24fe689cae3ef', '[]')",
	).run();
	db.prepare(
		"INSERT INTO dispatch_snapshots (id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at) VALUES ('snap-001', 'task-m7-t2-uuid', '81ad0fe05b6b8019d1fde21aa63d3df520864efe689ddc2a7dd24fe689cae3ef', '[]', '{}', '2026-09-15T12:00:00.000Z')",
	).run();
	db.prepare(
		"INSERT INTO runs (id, task_id, attempt_no, kind, state, agent_id, permission_tier, snapshot_id) VALUES ('impl-run-xyz', 'task-m7-t2-uuid', 1, 'implement', 'exited', 'codex', 'workspaceWrite', 'snap-001')",
	).run();
	db.prepare(
		"INSERT INTO runs (id, task_id, attempt_no, kind, state, agent_id, permission_tier, snapshot_id) VALUES ('impl-run-uow', 'task-m7-t2-uuid', 2, 'implement', 'exited', 'claude', 'workspaceWrite', 'snap-001')",
	).run();
	return db;
}

function makeFakeDiffStat(files: readonly DiffFileStat[]): DiffStatResult {
	let insertions = 0;
	let deletions = 0;
	for (const f of files) {
		insertions += f.insertions;
		deletions += f.deletions;
	}
	return Object.freeze({
		filesChanged: files.length,
		changedFileCount: files.length,
		insertions,
		deletions,
		hasChanges: files.length > 0,
		baseline: 'HEAD',
		files: Object.freeze([...files]),
	});
}

function makeFakeReviewContext(overrides?: Partial<ReviewContext>): ReviewContext {
	return Object.freeze({
		taskId: 'task-m7-t2-uuid',
		taskKey: 'M7-T2',
		snapshotId: 'snap-001',
		reviewPrompt:
			'请审查 M7-T2 代码。审查通过后请在工作树执行 git commit，并运行 maintain_docs.py sync。',
		contractHash: '81ad0fe05b6b8019d1fde21aa63d3df520864efe689ddc2a7dd24fe689cae3ef',
		acceptText:
			'1) 默认审查者逐字取被审实施运行行的 agent_id / model_name / effort_tier\n2) 审查运行固定只读档 packages/daemon/src/service/review-agent.ts\n3) diff 超出上下文时给出 packages/daemon/src/repo/runs.ts 全文',
		inputText: 'M3-T5 的审查提示词；M4-T7 的只读档',
		outputText: '审查运行的启动路径',
		taskPaths: Object.freeze([
			'packages/daemon/src/service/review-agent.ts',
			'packages/daemon/src/repo/runs.ts',
		]),
		launchSpecJson: '{"agentId":"codex","model":"o3-mini"}',
		createdAt: '2026-09-15T12:00:00.000Z',
		isSnapshot: true,
		isReadOnly: true,
		docChangedSinceDispatch: false,
		...overrides,
	});
}

describe('M7-T2: 审查 agent 派发与 diff 裁剪 (AC 1-4, E-135, E-347, E-65)', () => {
	// ─────────────────────────────────────────────────────────────────────────────
	// AC 1 & E-347: 默认审查者的 agent、模型与思考强度逐字取实施运行行（决策 107）
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 1 & E-347: Default reviewer assignment extracted verbatim from implementation run', () => {
		it('extracts agent_id, model_name, and effort_tier verbatim without consulting registry defaults', () => {
			const implRun = {
				id: 'run-impl-1',
				task_id: 'task-m7-t2-uuid',
				agent_id: 'codex',
				model_name: 'o3-mini-custom-model',
				effort_tier: 'high' as const,
			};

			const assignment = readDefaultReviewAssignment(implRun);

			expect(assignment).toEqual({
				agentId: 'codex',
				modelName: 'o3-mini-custom-model',
				effortTier: 'high',
			});
		});

		it('supports camelCase properties and preserves effortVendor if present', () => {
			const implRun = {
				id: 'run-impl-2',
				taskId: 'task-m7-t2-uuid',
				agentId: 'pi',
				modelName: 'claude-3-7-sonnet',
				effortTier: null,
				effortVendor: 'xhigh',
			};

			const assignment = readDefaultReviewAssignment(implRun);

			expect(assignment).toEqual({
				agentId: 'pi',
				modelName: 'claude-3-7-sonnet',
				effortTier: null,
				effortVendor: 'xhigh',
			});
		});

		it('allows modelName and effortTier to be null/undefined, passing them as null', () => {
			const implRun = {
				id: 'run-impl-3',
				task_id: 'task-m7-t2-uuid',
				agent_id: 'claude',
				model_name: null,
				effort_tier: null,
			};

			const assignment = readDefaultReviewAssignment(implRun);

			expect(assignment).toEqual({
				agentId: 'claude',
				modelName: null,
				effortTier: null,
			});
		});

		it('throws E_VALIDATION if agent_id is missing or empty', () => {
			expect(() =>
				readDefaultReviewAssignment({ id: 'bad-run' } as unknown as { agent_id: string }),
			).toThrowError(AppError);
			expect(() => readDefaultReviewAssignment({ id: 'bad-run', agent_id: '   ' })).toThrow(
				/missing required agent_id/,
			);
		});

		it('creates an independent new session (vendor_session_ref is null) without implementation context', () => {
			const implRun = {
				id: 'run-impl-1',
				task_id: 'task-m7-t2-uuid',
				agent_id: 'codex',
				model_name: 'gpt-4o',
				effort_tier: 'medium' as const,
				vendor_session_ref: 'session-impl-secret-ref-12345',
				worktree_path: '/path/to/worktree',
				branch_name: 'task/M7-T2',
			};
			const reviewContext = makeFakeReviewContext();
			const diffStat = makeFakeDiffStat([
				{
					path: 'packages/daemon/src/service/review-agent.ts',
					insertions: 20,
					deletions: 5,
					status: 'modified',
				},
			]);
			const diffText =
				'diff --git a/packages/daemon/src/service/review-agent.ts b/packages/daemon/src/service/review-agent.ts\n@@ -1,1 +1,2 @@\n+line';

			const prepared = prepareReviewRun(
				{
					implRun,
					reviewContext,
					diffText,
					diffStat,
				},
				{
					ids: { newId: () => 'review-run-001' },
					clock: { now: () => '2026-09-15T12:00:00.000Z' },
				},
			);

			// AC 1: vendor_session_ref MUST be null (independent new session)
			expect(prepared.runInsert.vendor_session_ref).toBeNull();
			// Parent run id links to implementation run
			expect(prepared.runInsert.parent_run_id).toBe('run-impl-1');
			// Verbatim values transferred
			expect(prepared.runInsert.agent_id).toBe('codex');
			expect(prepared.runInsert.model_name).toBe('gpt-4o');
			expect(prepared.runInsert.effort_tier).toBe('medium');
			// Source is task assignment (Decision 107, E-347)
			expect(prepared.runInsert.assignment_source).toBe('task');
			// Prompt does NOT contain implementation session secret
			expect(prepared.promptResult.prompt).not.toContain('session-impl-secret-ref-12345');
		});

		it('allows assignment to be explicitly passed as an argument from caller (E-347 single entry point)', () => {
			const implRun = {
				id: 'run-impl-1',
				task_id: 'task-m7-t2-uuid',
				agent_id: 'codex',
				model_name: 'impl-model',
				effort_tier: 'low' as const,
			};
			const reviewContext = makeFakeReviewContext();
			const diffStat = makeFakeDiffStat([]);
			const explicitAssignment = {
				agentId: 'claude',
				modelName: 'claude-3-5-sonnet',
				effortTier: 'high' as const,
				effortVendor: '32768',
			};

			const prepared = prepareReviewRun(
				{
					implRun,
					reviewContext,
					diffText: '',
					diffStat,
					assignment: explicitAssignment,
				},
				{
					ids: { newId: () => 'review-run-002' },
					clock: { now: () => '2026-09-15T12:00:00.000Z' },
				},
			);

			expect(prepared.runInsert.agent_id).toBe('claude');
			expect(prepared.runInsert.model_name).toBe('claude-3-5-sonnet');
			expect(prepared.runInsert.effort_tier).toBe('high');
			expect(prepared.runInsert.effort_vendor).toBe('32768');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 2 & E-135: 审查运行固定只读档，严禁修改代码、执行写操作或接手写入修复
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 2 & E-135: Fixed read-only permission tier & prompt directives', () => {
		it('sets permission_tier strictly to readOnly on RunInsertRow regardless of input', () => {
			const implRun = {
				id: 'run-impl-1',
				task_id: 'task-m7-t2-uuid',
				agent_id: 'codex',
				permission_tier: 'unrestricted', // implementation was unrestricted
			};
			const reviewContext = makeFakeReviewContext();
			const diffStat = makeFakeDiffStat([]);

			const prepared = prepareReviewRun(
				{
					implRun,
					reviewContext,
					diffText: '',
					diffStat,
				},
				{
					ids: { newId: () => 'review-run-003' },
					clock: { now: () => '2026-09-15T12:00:00.000Z' },
				},
			);

			expect(prepared.runInsert.permission_tier).toBe('readOnly');
		});

		it('maps readOnly permission correctly to process arguments for codex, claude, grok, pi, and dsh', () => {
			// 1. Codex
			const codexSpec = buildReviewLaunchSpec({
				runId: 'r-codex',
				taskId: 't-1',
				worktreePath: '/w/codex',
				assignment: { agentId: 'codex', modelName: 'o3-mini', effortTier: 'high' },
				prompt: 'review test',
				execPath: '/opt/codex-custom',
			});
			expect(codexSpec.file).toBe('/opt/codex-custom');
			expect(codexSpec.args.slice(0, 2)).toEqual(['exec', '--json']);
			expect(codexSpec.args).toContain('read-only');
			expect(codexSpec.args.at(-1)).toBe('review test');
			expect(codexSpec.stdinMode).toBe('closed');

			// 2. Claude
			const claudeSpec = buildReviewLaunchSpec({
				runId: 'r-claude',
				taskId: 't-1',
				worktreePath: '/w/claude',
				assignment: { agentId: 'claude', modelName: 'claude-3-7-sonnet', effortTier: 'low' },
				prompt: 'review test',
			});
			expect(claudeSpec.args).toContain('--permission-mode');
			expect(claudeSpec.args).toContain('plan');

			// 3. Grok
			const grokSpec = buildReviewLaunchSpec({
				runId: 'r-grok',
				taskId: 't-1',
				worktreePath: '/w/grok',
				assignment: { agentId: 'grok', modelName: 'grok-3', effortTier: 'medium' },
				prompt: 'review test',
			});
			expect(grokSpec.args).toContain('--permission-mode');
			expect(grokSpec.args).toContain('plan');

			// 4. Pi
			const piSpec = buildReviewLaunchSpec({
				runId: 'r-pi',
				taskId: 't-1',
				worktreePath: '/w/pi',
				assignment: { agentId: 'pi', modelName: 'deepseek-r1', effortTier: 'high' },
				prompt: 'review test',
			});
			expect(piSpec.args).toContain('--tools');
			expect(piSpec.args).toContain('read,grep,find,ls');

			// 5. Dsh
			const dshSpec = buildReviewLaunchSpec({
				runId: 'r-dsh',
				taskId: 't-1',
				worktreePath: '/w/dsh',
				assignment: { agentId: 'dsh', modelName: 'deepseek-v3', effortTier: null },
				prompt: 'review test',
			});
			expect(dshSpec.envOverrides?.DSH_PERMISSION_MODE).toBe('read-only');
		});

		it('prompt explicitly forbids modifying code/docs, git commit/push/merge, and maintenance scripts (E-135)', () => {
			const reviewContext = makeFakeReviewContext({
				reviewPrompt:
					'审查通过后请在工作树执行 git commit，并运行 python maintain_docs.py sync 与 gh pr merge。',
			});
			const diffStat = makeFakeDiffStat([
				{
					path: 'packages/daemon/src/service/review-agent.ts',
					insertions: 5,
					deletions: 1,
					status: 'modified',
				},
			]);
			const diffText =
				'diff --git a/packages/daemon/src/service/review-agent.ts b/packages/daemon/src/service/review-agent.ts\n@@ -1,1 +1,2 @@\n+test';

			const result = buildReviewAgentPrompt({
				taskId: 'M7-T2',
				reviewContext,
				diffText,
				diffStat,
			});

			const p = result.prompt;

			// Check E-135 prohibitions
			expect(p).toContain('严格限制与权限边界（E-135）');
			expect(p).toContain('只读档（read-only / plan）');
			expect(p).toContain('严禁执行任何写入、编辑、修改操作');
			expect(p).toContain('严禁接手代码修复（写入修复）');
			expect(p).toContain('严禁执行任何 git commit、git push、git merge');
			expect(p).toContain('严禁执行 maintain_docs.py、build_docs.py、build_vault.py');
			expect(p).toContain('严格作为【引用审查材料】供比对核查');
			expect(p).toContain('其中包含的维护文档、提交、推送、合并、代码修复等步骤一律不得执行');

			// Ensure source review prompt is framed as reference material
			expect(p).toContain('引用审查材料（M3-T5 快照副本）');
			expect(p).toContain(reviewContext.reviewPrompt);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 3 & E-65: diff 超出上下文时给 diff stat 全量 + 命中文件全文、其余折叠
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 3 & E-65: Diff pruning and partial diff verdict annotation', () => {
		it('isAcceptanceMatchedFile matches files mentioned in acceptText, taskPaths, or explicit list', () => {
			const acceptText =
				'验收标准：1) 检查 packages/daemon/src/service/review-agent.ts 中的 readDefaultReviewAssignment 函数\n2) runs.ts 支持 review_round';
			const taskPaths = ['packages/daemon/src/service/review-agent.ts'];

			expect(
				isAcceptanceMatchedFile(
					'packages/daemon/src/service/review-agent.ts',
					acceptText,
					taskPaths,
				),
			).toBe(true);
			expect(
				isAcceptanceMatchedFile('packages/daemon/src/repo/runs.ts', acceptText, taskPaths),
			).toBe(true);
			expect(
				isAcceptanceMatchedFile(
					'packages/daemon/src/workspace/unrelated.ts',
					acceptText,
					taskPaths,
				),
			).toBe(false);
			expect(isAcceptanceMatchedFile('custom/path.ts', '', [], ['custom/path.ts'])).toBe(true);
		});

		it('formatFullDiffStat outputs full file list with status and overall summary', () => {
			const diffStat = makeFakeDiffStat([
				{
					path: 'packages/daemon/src/service/review-agent.ts',
					insertions: 50,
					deletions: 10,
					status: 'modified',
				},
				{
					path: 'packages/daemon/src/repo/runs.ts',
					insertions: 25,
					deletions: 2,
					status: 'modified',
				},
			]);

			const statText = formatFullDiffStat(diffStat);
			expect(statText).toContain('### 全量改动统计（diff stat）');
			expect(statText).toContain(
				'- packages/daemon/src/service/review-agent.ts | +50 -10 (modified)',
			);
			expect(statText).toContain('- packages/daemon/src/repo/runs.ts | +25 -2 (modified)');
			expect(statText).toContain('总计：2 个文件改动，+75 行插入，-12 行删除');
		});

		it('when diff does not exceed limits, returns isPartial: false and full unpruned diff', () => {
			const diffStat = makeFakeDiffStat([
				{
					path: 'packages/daemon/src/service/review-agent.ts',
					insertions: 10,
					deletions: 2,
					status: 'modified',
				},
			]);
			const diffText =
				'diff --git a/packages/daemon/src/service/review-agent.ts b/packages/daemon/src/service/review-agent.ts\n@@ -1,1 +1,2 @@\n+line';

			const pruned = pruneDiff({
				diffText,
				diffStat,
			});

			expect(pruned.isPartial).toBe(false);
			expect(pruned.annotationRequired).toBe(false);
			expect(pruned.foldedFiles.length).toBe(0);
			expect(pruned.diffText).toBe(diffText);
		});

		it('when changed files exceed threshold (>100 files, E-65), folds non-matching files and mandates 基于部分 diff', () => {
			const files: DiffFileStat[] = [];
			const diffChunks: string[] = [];

			// File 0: matched file in acceptance criteria
			files.push({
				path: 'packages/daemon/src/service/review-agent.ts',
				insertions: 20,
				deletions: 5,
				status: 'modified',
			});
			diffChunks.push(
				'diff --git a/packages/daemon/src/service/review-agent.ts b/packages/daemon/src/service/review-agent.ts\nindex 111..222 100644\n--- a/packages/daemon/src/service/review-agent.ts\n+++ b/packages/daemon/src/service/review-agent.ts\n@@ -1,5 +1,6 @@\n+full diff line of matched file',
			);

			// Files 1 to 105: non-matching files (exceeding 100 files)
			for (let i = 1; i <= 105; i++) {
				const p = `packages/daemon/src/other/module-${i}.ts`;
				files.push({
					path: p,
					insertions: 10,
					deletions: 2,
					status: 'modified',
				});
				diffChunks.push(
					`diff --git a/${p} b/${p}\nindex 111..222 100644\n--- a/${p}\n+++ b/${p}\n@@ -1,5 +1,6 @@\n+body line ${i}`,
				);
			}

			const diffStat = makeFakeDiffStat(files);
			expect(diffStat.filesChanged).toBe(106);

			const fullDiffText = diffChunks.join('\n');
			const acceptText = '核对 packages/daemon/src/service/review-agent.ts 的实现';

			const pruned = pruneDiff({
				diffText: fullDiffText,
				diffStat,
				options: {
					acceptText,
					maxDiffFiles: 100, // E-65 threshold
				},
			});

			// AC 3 & E-65 assertions:
			expect(pruned.isPartial).toBe(true);
			expect(pruned.annotationRequired).toBe(true);
			expect(pruned.annotationNotice).toBe(PARTIAL_DIFF_NOTICE);

			// Matched file retains full diff
			expect(pruned.matchedFiles).toContain('packages/daemon/src/service/review-agent.ts');
			expect(pruned.diffText).toContain('+full diff line of matched file');

			// Non-matched files are folded
			expect(pruned.foldedFiles.length).toBe(105);
			expect(pruned.diffText).toContain('折叠：此文件未直接命中验收标准，改动全文已折叠省略');
			expect(pruned.diffText).not.toContain('+body line 1');

			// Full diff stat table contains all 106 files
			expect(pruned.fullDiffStatText).toContain(
				'- packages/daemon/src/service/review-agent.ts | +20 -5 (modified)',
			);
			expect(pruned.fullDiffStatText).toContain(
				'- packages/daemon/src/other/module-1.ts | +10 -2 (modified)',
			);
			expect(pruned.fullDiffStatText).toContain(
				'- packages/daemon/src/other/module-105.ts | +10 -2 (modified)',
			);
			expect(pruned.fullDiffStatText).toContain('总计：106 个文件改动');
		});

		it('when diff character length exceeds maxDiffChars, triggers diff pruning', () => {
			const files: DiffFileStat[] = [
				{
					path: 'packages/daemon/src/service/review-agent.ts',
					insertions: 500,
					deletions: 10,
					status: 'modified',
				},
				{
					path: 'packages/daemon/src/other/huge.ts',
					insertions: 2000,
					deletions: 50,
					status: 'modified',
				},
			];
			const diffStat = makeFakeDiffStat(files);
			// Simulate huge diff text exceeding 80k chars
			const hugeBody = '+x'.repeat(45_000);
			const diffText = [
				'diff --git a/packages/daemon/src/service/review-agent.ts b/packages/daemon/src/service/review-agent.ts\n@@ -1,1 +1,2 @@\n+matched content',
				`diff --git a/packages/daemon/src/other/huge.ts b/packages/daemon/src/other/huge.ts\n@@ -1,1 +1,2 @@\n${hugeBody}`,
			].join('\n');

			expect(diffText.length).toBeGreaterThan(DEFAULT_MAX_DIFF_CHARS);

			const pruned = pruneDiff({
				diffText,
				diffStat,
				options: {
					acceptText: 'review-agent.ts',
				},
			});

			expect(pruned.isPartial).toBe(true);
			expect(pruned.matchedFiles).toContain('packages/daemon/src/service/review-agent.ts');
			expect(pruned.foldedFiles).toContain('packages/daemon/src/other/huge.ts');
			expect(pruned.diffText).toContain('+matched content');
			expect(pruned.diffText).toContain('折叠：此文件未直接命中验收标准，改动全文已折叠省略');
		});

		it('prompt includes Diff 裁剪说明 and mandates 「基于部分 diff」 in verdict when pruned', () => {
			const diffStat = makeFakeDiffStat([
				{
					path: 'packages/daemon/src/service/review-agent.ts',
					insertions: 10,
					deletions: 2,
					status: 'modified',
				},
			]);
			const diffText =
				'diff --git a/packages/daemon/src/service/review-agent.ts b/packages/daemon/src/service/review-agent.ts\n@@ -1,1 +1,2 @@\n+test';

			const result = buildReviewAgentPrompt({
				taskId: 'M7-T2',
				reviewContext: makeFakeReviewContext(),
				diffText,
				diffStat,
				pruneOptions: { forcePartial: true }, // force pruning
			});

			expect(result.isPartialDiff).toBe(true);
			expect(result.prompt).toContain('Diff 裁剪说明（E-65）');
			expect(result.prompt).toContain(
				`你的最终审查裁定结论中，必须明确包含标注：「${PARTIAL_DIFF_ANNOTATION}」`,
			);
			expect(result.prompt).toContain(`必须明确标注：「${PARTIAL_DIFF_ANNOTATION}」`);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 4 & 决策 89: 仅负责第 1 轮审查会话新建（review_round=1、continued_from_run_id=null）
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 4 & 决策 89: Round 1 review session creation only', () => {
		it('sets review_round = 1 and continued_from_run_id = null unconditionally (no round branching)', () => {
			const implRun = {
				id: 'run-impl-88',
				task_id: 'task-uuid-88',
				agent_id: 'pi',
				model_name: 'model-a',
				effort_tier: 'low' as const,
			};
			const reviewContext = makeFakeReviewContext({ taskId: 'task-uuid-88' });
			const diffStat = makeFakeDiffStat([]);

			const prepared = prepareReviewRun(
				{
					implRun,
					reviewContext,
					diffText: '',
					diffStat,
				},
				{
					ids: { newId: () => 'review-run-round-1' },
					clock: { now: () => '2026-09-15T12:00:00.000Z' },
				},
			);

			// AC 4: strictly review_round=1 and continued_from_run_id=null
			expect(prepared.runInsert.review_round).toBe(1);
			expect(prepared.runInsert.continued_from_run_id).toBeNull();
			expect(prepared.runInsert.kind).toBe('review');
			expect(prepared.runInsert.parent_run_id).toBe('run-impl-88');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// Dispatch Lifecycle & Database Persistence Integration
	// ─────────────────────────────────────────────────────────────────────────────
	describe('Dispatch review run integration & persistence', () => {
		let db: DatabaseConnection;

		it('persists review run into runsRepo and emits run.started event', async () => {
			db = setupTestDb();
			const runsRepo = createRunsRepo(db);
			const publishedEvents: EventEnvelope[] = [];
			const fakeBus = {
				publish(envelope: EventEnvelope) {
					publishedEvents.push(envelope);
					return { event: envelope, subscriberErrors: [] };
				},
				subscribe() {
					return () => {};
				},
				subscribeWithFilter() {
					return () => {};
				},
			} as unknown as EventBus;
			const fakeEnvelopeFactory: EnvelopeFactory = {
				createEnvelope(input) {
					return {
						id: 1,
						ts: '2026-09-15T12:00:00.000Z',
						seq: 1,
						kind: input.kind,
						runId: input.runId ?? null,
						taskId: input.taskId ?? null,
						scope: 'run',
						payload: input.payload,
						actorDeviceId: input.actorDeviceId ?? null,
					};
				},
			};

			const implRun = {
				id: 'impl-run-xyz',
				task_id: 'task-m7-t2-uuid',
				agent_id: 'codex',
				model_name: 'o3-mini',
				effort_tier: 'medium' as const,
				worktree_path: '/path/to/worktree',
				branch_name: 'task/M7-T2',
				lane_no: 2,
			};
			const reviewContext = makeFakeReviewContext();
			const diffStat = makeFakeDiffStat([
				{
					path: 'packages/daemon/src/service/review-agent.ts',
					insertions: 30,
					deletions: 5,
					status: 'modified',
				},
			]);
			const diffText =
				'diff --git a/packages/daemon/src/service/review-agent.ts b/packages/daemon/src/service/review-agent.ts\n@@ -1,1 +1,2 @@\n+dispatch test';

			const dispatchResult = await dispatchReviewRun(
				{
					implRun,
					reviewContext,
					diffText,
					diffStat,
					actorDeviceId: 'dev-client-1',
				},
				{
					ids: { newId: () => 'review-run-dispatched' },
					clock: { now: () => '2026-09-15T12:00:00.000Z' },
					runsRepo,
					bus: fakeBus,
					envelopeFactory: fakeEnvelopeFactory,
				},
			);

			// Verify returned DTO
			expect(dispatchResult.run.id).toBe('review-run-dispatched');
			expect(dispatchResult.run.kind).toBe('review');
			expect(dispatchResult.run.agentId).toBe('codex');
			expect(dispatchResult.run.modelName).toBe('o3-mini');
			expect(dispatchResult.run.effortTier).toBe('medium');
			expect(dispatchResult.run.permissionTier).toBe('readOnly');
			expect(dispatchResult.run.parentRunId).toBe('impl-run-xyz');
			expect(dispatchResult.run.laneNo).toBe(2);

			// Verify DB persistence
			const saved = runsRepo.findById('review-run-dispatched');
			expect(saved).not.toBeNull();
			expect(saved?.agent_id).toBe('codex');
			expect(saved?.model_name).toBe('o3-mini');
			expect(saved?.permission_tier).toBe('readOnly');
			expect(saved?.parent_run_id).toBe('impl-run-xyz');
			expect(saved?.review_round).toBe(1);
			expect(saved?.continued_from_run_id).toBeNull();
			expect(saved?.assignment_source).toBe('task');

			// Verify event published
			expect(publishedEvents.length).toBe(1);
			const firstEvent = publishedEvents[0];
			expect(firstEvent).toBeDefined();
			expect(firstEvent?.kind).toBe('run.started');
			expect(firstEvent?.runId).toBe('review-run-dispatched');
			const payload = firstEvent?.payload as { kind?: string; agentId?: string } | undefined;
			expect(payload?.kind).toBe('review');
			expect(payload?.agentId).toBe('codex');

			db.close();
		});

		it('executes within unitOfWork transaction when provided', async () => {
			db = setupTestDb();
			const runsRepo = createRunsRepo(db);
			const unitOfWork = createUnitOfWork(db);

			const implRun = {
				id: 'impl-run-uow',
				task_id: 'task-m7-t2-uuid',
				agent_id: 'claude',
				model_name: 'claude-3-5-sonnet',
				effort_tier: 'low' as const,
			};
			const reviewContext = makeFakeReviewContext();
			const diffStat = makeFakeDiffStat([]);

			const dispatchResult = await dispatchReviewRun(
				{
					implRun,
					reviewContext,
					diffText: '',
					diffStat,
				},
				{
					ids: { newId: () => 'review-run-uow' },
					clock: { now: () => '2026-09-15T12:00:00.000Z' },
					runsRepo,
					unitOfWork,
				},
			);

			expect(dispatchResult.run.id).toBe('review-run-uow');
			const saved = runsRepo.findById('review-run-uow');
			expect(saved).not.toBeNull();
			expect(saved?.agent_id).toBe('claude');

			db.close();
		});

		it('spawns managed process when autoSpawn is true and spawnManaged is injected', async () => {
			const fakeSpawnManaged = vi.fn().mockReturnValue({
				pid: 9988,
				kill: vi.fn().mockResolvedValue({ killed: true }),
			});

			const implRun = {
				id: 'impl-run-spawn',
				task_id: 'task-m7-t2-uuid',
				agent_id: 'codex',
				model_name: 'o3-mini',
				effort_tier: 'high' as const,
				worktree_path: '/path/to/worktree',
			};
			const reviewContext = makeFakeReviewContext();
			const diffStat = makeFakeDiffStat([]);

			const dispatchResult = await dispatchReviewRun(
				{
					implRun,
					reviewContext,
					diffText: '',
					diffStat,
					autoSpawn: true,
				},
				{
					ids: { newId: () => 'review-run-spawn' },
					clock: { now: () => '2026-09-15T12:00:00.000Z' },
					spawnManaged: fakeSpawnManaged as unknown as typeof fakeSpawnManaged,
				},
			);

			expect(fakeSpawnManaged).toHaveBeenCalledTimes(1);
			expect(dispatchResult.managedProcess?.pid).toBe(9988);
			expect(dispatchResult.run.pid).toBe(9988);
		});
	});
});
