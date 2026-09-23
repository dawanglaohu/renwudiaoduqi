/**
 * packages/web/test/wrapup-report.test.tsx
 *
 * M9-T20 收口泳道、收口报告面板与批次落地清单测试（含返工第 1 轮 R1–R5）
 * 验收标准与边界（AC 1–AC 5, E-106, E-113, E-117, E-157, E-236, E-274, E-278, E-286, E-297, E-74）
 *
 * 覆盖五层：展示组件（只吃 daemon 字段）、批次树收口按钮的在途与拒绝态、
 * 模块级批次收口 store（POST 不改状态、等 batch.wrapup_started 回流）、
 * 真实泳道拼装（收口运行占普通泳道）与批次级落地清单。
 */

// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
	BatchWrapupDto,
	GetBatchWrapupsResponse,
	WrapupFindingDto,
} from '@agent-scheduler/shared/api/batches';
import type { GateDto } from '@agent-scheduler/shared/api/gates';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../src/api/event-bus.ts';
import { ApiError } from '../src/api/http-client.ts';
import { BatchTree } from '../src/components/batch-tree.tsx';
import {
	BatchWrapupFailureLine,
	WrapupReport,
	formatFindingSummary,
	isDeclaredVerdictMismatch,
} from '../src/components/wrapup-report.tsx';
import {
	type BuildDeckLanesInput,
	buildDeckLanes,
} from '../src/features/run-deck/run-deck-container.tsx';
import {
	WrapupPanelContainer,
	buildBatchLandingList,
	clearBatchWrapupState,
	composeBatchLandingCommand,
	getBatchWrapupEntry,
	initBatchWrapupEvents,
	startBatchWrapup,
	toWrapupFailureView,
} from '../src/features/run-deck/wrapup-panel-container.tsx';
import { getWrapupFailureMessage, resolveWrapupFailureReason } from '../src/i18n/error-messages.ts';
import { LandingPage } from '../src/pages/landing-page.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPO_ROOT = resolve(__dirname, '../../..');

afterEach(() => {
	clearBatchWrapupState();
});

function makeWrapup(overrides: Partial<BatchWrapupDto> = {}): BatchWrapupDto {
	return {
		id: 'wrapup-1',
		batchId: 'batch-13',
		batchNo: 13,
		tasks: ['M9-T19', 'M9-T20'],
		round: 1,
		runId: 'run-wrapup-1',
		verdict: 'open',
		declaredVerdict: 'clean',
		isHumanVerdict: false,
		promptSource: 'builtin',
		tests: { status: 'fail', items: ['vitest run → 3 failed'] },
		summaryText: '本批交付了收口泳道',
		findings: [
			{
				id: 'B1',
				kind: 'bug',
				severity: 'S2',
				taskKey: 'M9-T20',
				crossBatch: true,
				isFixed: false,
				isWellFormed: true,
				raw: 'B1 [S2 功能错] 涉及 M9-T20（跨批）：现象 → 复现 → 根因 → a.ts:12',
				symptom: '投递按钮点了没反应',
			},
			{
				id: 'B2',
				kind: 'not_fixed',
				severity: null,
				taskKey: 'M9-T21',
				crossBatch: false,
				isFixed: false,
				isWellFormed: false,
				raw: 'B2 只有三段箭头',
				symptom: '泳道数不对',
			},
		],
		unassigned: ['B3 没有任务 ID 的条目'],
		fixRunIds: ['run-fix-1'],
		reportText: 'BATCH_SUMMARY\n本批交付了收口泳道\nTESTS\n- fail\nBUGS\n- B1 ...',
		createdAt: '2026-09-20T10:00:00.000Z',
		landing: {
			worktreePath: 'D:/xiangmu/agent-scheduler-batch-13',
			branchName: 'batch/13-20260920',
			diffStat: '4 files changed, 120 insertions(+), 8 deletions(-)',
		},
		...overrides,
	};
}

function makeRun(overrides: Partial<RunDto> = {}): RunDto {
	return {
		id: 'run-wrapup-1',
		taskId: null,
		attemptNo: 1,
		kind: 'wrapup',
		parentRunId: null,
		state: 'landed',
		reviewVerdict: null,
		agentId: 'codex',
		modelName: 'gpt-5-codex',
		reportedModel: null,
		effortTier: null,
		reportedEffort: null,
		permissionTier: 'workspaceWrite',
		worktreePath: 'D:/xiangmu/agent-scheduler-batch-13',
		branchName: 'batch/13-20260920',
		pid: null,
		exitCode: 0,
		exitSignal: null,
		changedFileCount: 4,
		tokenUsage: null,
		isStallSuspected: false,
		reworkCount: 0,
		queuedReason: null,
		idempotencyKey: 'key-1',
		actorDeviceId: null,
		startedAt: '2026-09-20T09:00:00.000Z',
		lastEventAt: '2026-09-20T10:00:00.000Z',
		endedAt: '2026-09-20T10:00:00.000Z',
		isInHead: false,
		...overrides,
	};
}

function makeTask(overrides: Partial<TaskDto> = {}): TaskDto {
	return {
		id: 'task-20',
		docId: 'doc-1',
		taskKey: 'M9-T20',
		title: '收口泳道、收口报告面板与批次落地清单',
		moduleKey: 'M9',
		deps: [],
		estDays: 1,
		batchId: 'batch-13',
		state: 'running',
		...overrides,
	};
}

function makeGate(overrides: Partial<GateDto> = {}): GateDto {
	return {
		id: 'gate-1',
		taskId: 'task-20',
		runId: 'run-review-1',
		kind: 'review',
		state: 'waiting',
		decision: null,
		comment: null,
		decidedByDeviceId: null,
		createdAt: '2026-09-20T09:30:00.000Z',
		decidedAt: null,
		...overrides,
	};
}

describe('M9-T20: 收口泳道、收口报告面板与批次落地清单', () => {
	// ─────────────────────────────────────────────────────────────────────────────
	// AC 2 & E-297 / E-286：收口报告面板只展示 daemon 已解析字段
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 2 & E-297: wrapup report panel renders daemon-parsed fields only', () => {
		it('renders tests / findings / unassigned / landing / reportText from the daemon DTO', () => {
			const html = renderToStaticMarkup(
				createElement(WrapupReport, { entry: { kind: 'parsed', wrapup: makeWrapup() } }),
			);

			expect(html).toContain('data-component="wrapup-report"');
			expect(html).toContain('data-entry-kind="parsed"');
			expect(html).toContain('data-round="1"');
			expect(html).toContain('第 1 轮');
			expect(html).toContain('data-verdict="open"');

			expect(html).toContain('data-field="tests-status"');
			expect(html).toContain('data-tests-status="fail"');
			expect(html).toContain('vitest run → 3 failed');

			expect(html).toContain('data-finding-id="B1"');
			expect(html).toContain('data-finding-id="B2"');

			expect(html).toContain('未归属 1 条');
			expect(html).toContain('B3 没有任务 ID 的条目');

			expect(html).toContain('data-landing-field="worktree"');
			expect(html).toContain('D:/xiangmu/agent-scheduler-batch-13');
			expect(html).toContain('batch/13-20260920');

			expect(html).toContain('data-segment="report-text"');
			expect(html).toContain('data-field="report-text"');
		});

		it('marks isWellFormed=false rows with a「格式不全」chip', () => {
			const html = renderToStaticMarkup(
				createElement(WrapupReport, { entry: { kind: 'parsed', wrapup: makeWrapup() } }),
			);

			expect(html).toContain('data-chip="ill-formed"');
			expect(html).toContain('格式不全');
			expect(html.match(/data-chip="ill-formed"/g)?.length).toBe(1);
		});

		it('renders the「文档未提供收口提示词」chip only when promptSource=builtin', () => {
			const builtin = renderToStaticMarkup(
				createElement(WrapupReport, { entry: { kind: 'parsed', wrapup: makeWrapup() } }),
			);
			expect(builtin).toContain('data-chip="builtin-prompt"');
			expect(builtin).toContain('文档未提供收口提示词');

			const docs = renderToStaticMarkup(
				createElement(WrapupReport, {
					entry: { kind: 'parsed', wrapup: makeWrapup({ promptSource: 'docs' }) },
				}),
			);
			expect(docs).not.toContain('data-chip="builtin-prompt"');
		});

		it('shows the effective verdict and the declared verdict side by side on mismatch (E-286)', () => {
			expect(isDeclaredVerdictMismatch(makeWrapup())).toBe(true);

			const html = renderToStaticMarkup(
				createElement(WrapupReport, { entry: { kind: 'parsed', wrapup: makeWrapup() } }),
			);
			expect(html).toContain('data-chip="declared-mismatch"');
			expect(html).toContain('data-field="declared-verdict"');
			expect(html).toContain('自报：干净');
			expect(html).toContain('data-verdict="open"');
			expect(html).toContain('有遗留');

			expect(isDeclaredVerdictMismatch(makeWrapup({ declaredVerdict: 'open' }))).toBe(false);
		});

		it('makes every finding row clickable to jump to its task', () => {
			const html = renderToStaticMarkup(
				createElement(WrapupReport, {
					entry: { kind: 'parsed', wrapup: makeWrapup() },
					onOpenTask: () => {},
				}),
			);

			expect(html).toContain('data-task-key="M9-T20"');
			expect(html).toContain('data-task-key="M9-T21"');
		});

		it('formats the finding row as id [severity] 涉及 taskKey（跨批）：symptom', () => {
			const [wellFormed, illFormed] = makeWrapup().findings as readonly WrapupFindingDto[];
			expect(formatFindingSummary(wellFormed as WrapupFindingDto)).toBe(
				'B1 [S2] 涉及 M9-T20（跨批）：投递按钮点了没反应',
			);
			expect(formatFindingSummary(illFormed as WrapupFindingDto)).toBe(
				'B2 [—] 涉及 M9-T21：泳道数不对',
			);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 2 & E-274 / E-297：解析失败只显示「解析失败」并直链原文
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 2 & E-274: unparsable round shows 解析失败 and links to the raw output', () => {
		it('renders the 解析失败 badge, the missing-section list and a direct link to the run', () => {
			const html = renderToStaticMarkup(
				createElement(WrapupReport, {
					entry: {
						kind: 'unparsable',
						round: 2,
						runId: 'run-wrapup-2',
						missingSections: ['BUGS', 'FIXED'],
						rawText: '原始输出全文，未结构化',
					},
					onOpenRun: () => {},
				}),
			);

			expect(html).toContain('data-entry-kind="unparsable"');
			expect(html).toContain('第 2 轮');
			expect(html).toContain('解析失败');
			expect(html).toContain('缺段：BUGS、FIXED');
			expect(html).toContain('data-action="goto-raw-report"');
			expect(html).toContain('href="#/run/run-wrapup-2"');
			expect(html).toContain('直链原文');
			expect(html).toContain('data-field="unparsable-raw"');
			expect(html).toContain('原始输出全文，未结构化');
		});

		it('does not render any verdict badge on an unparsable round', () => {
			const html = renderToStaticMarkup(
				createElement(WrapupReport, {
					entry: { kind: 'unparsable', round: 3, runId: 'run-wrapup-3' },
				}),
			);
			expect(html).not.toContain('data-verdict=');
			expect(html).not.toContain('data-segment="findings"');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 2 & E-297：代码中不存在前端解析 reportText 的路径
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 2 & E-297: no front-end parsing path for reportText', () => {
		const sources = [
			'packages/web/src/components/wrapup-report.tsx',
			'packages/web/src/features/run-deck/wrapup-panel-container.tsx',
			'packages/web/src/features/run-deck/run-deck-container.tsx',
		] as const;

		const FORBIDDEN_PARSING = [
			/BATCH_SUMMARY/,
			/parseWrapup/,
			/reportText\s*\.\s*(split|match|matchAll|replace|indexOf|search|slice)/,
			/JSON\.parse\(\s*[a-zA-Z_.]*reportText/,
			/NOT_FIXED/,
			/RECORD\s*段/,
		] as const;

		for (const relativePath of sources) {
			it(`has no parsing of the eight-section 原文 in ${relativePath}`, () => {
				const source = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
				for (const pattern of FORBIDDEN_PARSING) {
					expect(source).not.toMatch(pattern);
				}
			});
		}
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// R5：前端不重复写 API URL 字面量
	// ─────────────────────────────────────────────────────────────────────────────
	describe('R5: no duplicated API URL literals in the wrapup wiring', () => {
		const sources = [
			'packages/web/src/features/run-deck/wrapup-panel-container.tsx',
			'packages/web/src/features/run-deck/use-gate-card.ts',
			'packages/web/src/features/run-deck/run-deck-container.tsx',
			'packages/web/src/features/landing/landing-container.tsx',
		] as const;

		for (const relativePath of sources) {
			it(`routes by shared table fields, not by a URL literal, in ${relativePath}`, () => {
				const source = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
				expect(source).not.toMatch(/['"`]\/api\/v1\//);
				expect(source).toContain('ROUTES.find');
			});
		}
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 3 & E-157：批次收口按钮的门控、在途禁用与具名拒绝原因
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 3 & E-157: batch wrapup button gating, in-flight disable and named reasons', () => {
		const batches = [
			{
				id: 'batch-13',
				batchNo: 13,
				canWrapup: true,
				taskCount: 2,
				landedCount: 2,
				runningCount: 0,
				waitingCount: 0,
			},
		];

		it('renders the 收口 button only when canWrapup and not a phone tier (batch tree owns it)', () => {
			const desktop = renderToStaticMarkup(
				createElement(BatchTree, {
					batches,
					expandedIds: new Set<string>(),
					densityTier: 'full',
				}),
			);
			expect(desktop).toContain('data-action="wrapup-batch"');
			// 一屏只有一颗收口按钮（R2：不重复画）
			expect(desktop.match(/data-action="wrapup-batch"/g)?.length).toBe(1);

			const phone = renderToStaticMarkup(
				createElement(BatchTree, {
					batches,
					expandedIds: new Set<string>(),
					densityTier: 'phone',
				}),
			);
			expect(phone).not.toContain('data-action="wrapup-batch"');
		});

		it('disables the batch button while that batch is in flight and leaves other batches alone', () => {
			const html = renderToStaticMarkup(
				createElement(BatchTree, {
					batches: [...batches, { id: 'batch-14', batchNo: 14, canWrapup: true }],
					expandedIds: new Set<string>(),
					densityTier: 'full',
					wrapupPendingBatchId: 'batch-13',
				}),
			);

			const pendingIndex = html.indexOf('data-pending="true"');
			expect(pendingIndex).toBeGreaterThan(-1);
			expect(html).toContain('收口中…');
			expect(html).toContain('data-pending="false"');
			expect(html.slice(Math.max(0, pendingIndex - 300), pendingIndex + 300)).toContain(
				'disabled=""',
			);
		});

		it('renders the named failure line under the batch title in the tree', () => {
			const failure = toWrapupFailureView(
				new ApiError({
					code: 'E_BATCH_NOT_WRAPPABLE',
					message: 'Not all tasks in batch are landed.',
					requestId: 'req-7',
					details: { reason: 'not_all_landed', notLandedTaskKeys: ['M9-T21'] },
				}),
			);
			const html = renderToStaticMarkup(
				createElement(BatchTree, {
					batches,
					expandedIds: new Set<string>(),
					densityTier: 'full',
					wrapupFailureByBatch: new Map([['batch-13', failure]]),
				}),
			);

			expect(html).toContain('data-region="batch-wrapup-failure"');
			expect(html).toContain('data-placement="under-batch-title"');
			expect(html).toContain('data-failure-reason="not_all_landed"');
			expect(html).toContain('该批仍有任务未落地，无法收口（未落地：M9-T21）');
			expect(html).toContain('E_BATCH_NOT_WRAPPABLE');
			expect(html).toContain('requestId=req-7');
		});

		it('renders nothing for the failure line when there is no failure', () => {
			expect(renderToStaticMarkup(createElement(BatchWrapupFailureLine, {}))).toBe('');
		});

		it('names E_BATCH_NOT_WRAPPABLE reasons from details.reason', () => {
			expect(resolveWrapupFailureReason('E_BATCH_NOT_WRAPPABLE', { reason: 'done' })).toBe('done');
			expect(getWrapupFailureMessage('E_BATCH_NOT_WRAPPABLE', { reason: 'done' })).toContain(
				'该批已收口完成',
			);
			expect(
				getWrapupFailureMessage('E_BATCH_NOT_WRAPPABLE', {
					reason: 'not_in_head',
					notInHeadTaskKeys: ['M9-T19'],
				}),
			).toBe('该批仍有落地分支未进 HEAD，无法收口（未进 HEAD：M9-T19）');
			expect(
				getWrapupFailureMessage('E_BATCH_NOT_WRAPPABLE', { reason: 'wrapup_in_flight' }),
			).toContain('已有一轮收口在跑');
			expect(
				getWrapupFailureMessage('E_BATCH_NOT_WRAPPABLE', {
					reason: 'fix_runs_in_flight',
					fixRunId: 'run-fix-9',
				}),
			).toBe('上一轮的修复运行还没结束，等它落地后再收口（修复运行 run-fix-9）');
		});

		it('names E_WRAPUP_ROUND_LIMIT by details.trigger (daemon sends no reason)', () => {
			expect(resolveWrapupFailureReason('E_WRAPUP_ROUND_LIMIT', { trigger: 'auto' })).toBe(
				'round_limit_auto',
			);
			expect(
				getWrapupFailureMessage('E_WRAPUP_ROUND_LIMIT', {
					trigger: 'auto',
					autoLimit: 2,
				}),
			).toBe('自动收口轮次已达上限，需人工确认后再收口（上限 2 轮）');
			expect(
				getWrapupFailureMessage('E_WRAPUP_ROUND_LIMIT', {
					trigger: 'manual',
					hardLimit: 6,
				}),
			).toBe('收口尝试次数已达硬上限，需人工确认后再收口（上限 6 轮）');
		});

		it('falls back to the generic error-code message for unknown reasons (不猜语义)', () => {
			expect(resolveWrapupFailureReason('E_BATCH_NOT_WRAPPABLE', { reason: '???' })).toBeNull();
			expect(getWrapupFailureMessage('E_BATCH_NOT_WRAPPABLE', { reason: '???' })).toBe(
				'当前批次尚不满足收口条件',
			);
			expect(getWrapupFailureMessage('E_NOT_FOUND', {})).toBe('请求的资源不存在或已被移除');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 3 & E-157：POST 后不改状态，等 batch.wrapup_started 回流
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 3 & E-157: store never flips state from the POST response', () => {
		it('keeps the batch pending after acceptance and clears only on batch.wrapup_started', async () => {
			const bus = createEventBus();
			const fetcher = vi.fn().mockResolvedValue({ wrapups: [] } as GetBatchWrapupsResponse);
			const cleanup = initBatchWrapupEvents(bus, fetcher);
			const poster = vi.fn().mockResolvedValue({
				run: makeRun({ state: 'queued' }),
				batch: {
					id: 'batch-13',
					docId: 'doc-1',
					batchNo: 13,
					state: 'wrapping',
					startedAt: null,
					finishedAt: null,
				},
			});

			expect(getBatchWrapupEntry('batch-13').isPending).toBe(false);

			await act(async () => {
				await startBatchWrapup('batch-13', undefined, poster);
			});

			// 已接受：控件置在途；响应体里的 batch.state='wrapping' 绝不被拿来当界面状态（E-157）
			expect(poster).toHaveBeenCalledTimes(1);
			expect(getBatchWrapupEntry('batch-13').isPending).toBe(true);

			await act(async () => {
				bus.push({
					id: 900,
					ts: new Date().toISOString(),
					runId: 'run-wrapup-9',
					taskId: null,
					scope: 'batch',
					kind: 'batch.wrapup_started',
					seq: 1,
					actorDeviceId: null,
					payload: {
						batchId: 'batch-13',
						batchNo: 13,
						runId: 'run-wrapup-9',
						round: 1,
						trigger: 'manual',
						promptSource: 'docs',
						branchName: 'batch/13-20260920',
					},
				});
			});

			expect(getBatchWrapupEntry('batch-13').isPending).toBe(false);
			expect(fetcher).toHaveBeenCalledTimes(1);
			cleanup();
		});

		it('reuses one idempotency key when the same wrapup is retried', async () => {
			const poster = vi.fn().mockRejectedValue(
				new ApiError({
					code: 'E_BATCH_NOT_WRAPPABLE',
					message: 'Wrapup run is already in flight.',
					requestId: 'req-1',
					details: { reason: 'wrapup_in_flight' },
				}),
			);

			await act(async () => {
				await startBatchWrapup('batch-13', undefined, poster);
			});
			await act(async () => {
				await startBatchWrapup('batch-13', undefined, poster);
			});

			expect(poster).toHaveBeenCalledTimes(2);
			const firstKey = poster.mock.calls[0]?.[1]?.idempotencyKey;
			const secondKey = poster.mock.calls[1]?.[1]?.idempotencyKey;
			expect(typeof firstKey).toBe('string');
			expect(secondKey).toBe(firstKey);

			const entry = getBatchWrapupEntry('batch-13');
			expect(entry.isPending).toBe(false);
			expect(entry.failure?.reason).toBe('wrapup_in_flight');
		});

		it('records a 解析失败 entry when batch.wrapup_finished says verdict=unparsed (E-274/E-297)', async () => {
			const bus = createEventBus();
			const cleanup = initBatchWrapupEvents(bus, vi.fn().mockResolvedValue({ wrapups: [] }));

			await act(async () => {
				bus.push({
					id: 901,
					ts: new Date().toISOString(),
					runId: 'run-wrapup-9',
					taskId: null,
					scope: 'batch',
					kind: 'batch.wrapup_finished',
					seq: 2,
					actorDeviceId: null,
					payload: {
						batchId: 'batch-13',
						batchNo: 13,
						runId: 'run-wrapup-9',
						round: 2,
						wrapupId: null,
						verdict: 'unparsed',
						declaredVerdict: null,
						fixRunIds: [],
						unassignedCount: 0,
						batchState: 'needs_attention',
					},
				});
			});

			const entry = getBatchWrapupEntry('batch-13');
			expect(entry.unparsable).toHaveLength(1);
			expect(entry.unparsable[0]?.round).toBe(2);
			cleanup();
		});

		it('ignores wrapup events belonging to another batch', async () => {
			const bus = createEventBus();
			const cleanup = initBatchWrapupEvents(bus, vi.fn().mockResolvedValue({ wrapups: [] }));

			await act(async () => {
				bus.push({
					id: 902,
					ts: new Date().toISOString(),
					runId: 'run-other',
					taskId: null,
					scope: 'batch',
					kind: 'batch.wrapup_finished',
					seq: 3,
					actorDeviceId: null,
					payload: {
						batchId: 'batch-14',
						batchNo: 14,
						runId: 'run-other',
						round: 1,
						wrapupId: null,
						verdict: 'unparsed',
						declaredVerdict: null,
						fixRunIds: [],
						unassignedCount: 0,
						batchState: 'needs_attention',
					},
				});
			});

			expect(getBatchWrapupEntry('batch-13').unparsable).toHaveLength(0);
			expect(getBatchWrapupEntry('batch-14').unparsable).toHaveLength(1);
			cleanup();
		});

		it('renders the panel from the store including an unparsable round with a direct link', () => {
			const bus = createEventBus();
			const cleanup = initBatchWrapupEvents(bus, vi.fn().mockResolvedValue({ wrapups: [] }));
			bus.push({
				id: 903,
				ts: new Date().toISOString(),
				runId: 'run-wrapup-9',
				taskId: null,
				scope: 'batch',
				kind: 'batch.wrapup_finished',
				seq: 4,
				actorDeviceId: null,
				payload: {
					batchId: 'batch-13',
					batchNo: 13,
					runId: 'run-wrapup-9',
					round: 2,
					wrapupId: null,
					verdict: 'unparsed',
					declaredVerdict: null,
					fixRunIds: [],
					unassignedCount: 0,
					batchState: 'needs_attention',
				},
			});

			const html = renderToStaticMarkup(
				createElement(WrapupPanelContainer, { batchId: 'batch-13', initialWrapups: [] }),
			);
			expect(html).toContain('data-entry-kind="unparsable"');
			expect(html).toContain('解析失败');
			expect(html).toContain('#/run/run-wrapup-9');
			cleanup();
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// R1 & E-297：收口运行占一条普通泳道，头部写轮次与批次号
	// ─────────────────────────────────────────────────────────────────────────────
	describe('R1 & E-297: buildDeckLanes puts a wrapup run on an ordinary lane', () => {
		it('gives a wrapup run kind=wrapup with the batch number and the round from daemon data', () => {
			const input: BuildDeckLanesInput = {
				runs: [
					makeRun({
						id: 'run-impl-1',
						kind: 'implement',
						taskId: 'task-20',
						state: 'running',
						batchId: 'batch-13',
						startedAt: '2026-09-20T09:00:00.000Z',
					}),
					makeRun({
						id: 'run-wrapup-9',
						kind: 'wrapup',
						taskId: null,
						state: 'reviewing',
						batchId: 'batch-13',
						startedAt: '2026-09-20T09:30:00.000Z',
					}),
				],
				tasks: [makeTask()],
				batches: [
					{
						id: 'batch-13',
						docId: 'doc-1',
						batchNo: 13,
						state: 'wrapping',
						startedAt: null,
						finishedAt: null,
					},
				],
				wrapupRoundByRunId: new Map([['run-wrapup-9', 2]]),
			};

			const lanes = buildDeckLanes(input);
			expect(lanes).toHaveLength(2);
			expect(lanes[0]?.kind).toBe('task');
			expect(lanes[0]?.taskKey).toBe('M9-T20');
			expect(lanes[1]?.kind).toBe('wrapup');
			expect(lanes[1]?.wrapupRound).toBe(2);
			expect(lanes[1]?.wrapupBatchNo).toBe(13);
			expect(lanes[1]?.batchId).toBe('batch-13');
			// 收口运行没有 task_id：不伪造任务号
			expect(lanes[1]?.taskKey).toBeUndefined();
		});

		it('keeps five concurrent runs as five lanes (E-106 多流并置)', () => {
			const runs = Array.from({ length: 5 }, (_, index) =>
				makeRun({
					id: `run-${index}`,
					kind: 'implement',
					taskId: `task-${index}`,
					state: 'running',
					startedAt: `2026-09-20T09:0${index}:00.000Z`,
				}),
			);
			const lanes = buildDeckLanes({ runs });
			expect(lanes).toHaveLength(5);
			expect(lanes.map((lane) => lane.laneNo)).toEqual([1, 2, 3, 4, 5]);
		});

		it('numbers lanes from the daemon laneNo when it is present', () => {
			const lanes = buildDeckLanes({
				runs: [
					makeRun({ id: 'run-b', state: 'running', laneNo: 2 }),
					makeRun({ id: 'run-a', state: 'running', laneNo: 1 }),
				],
			});
			expect(lanes.map((lane) => lane.currentRunId)).toEqual(['run-a', 'run-b']);
		});

		it('drops terminal runs from the deck instead of drawing an empty lane', () => {
			const lanes = buildDeckLanes({
				runs: [
					makeRun({ id: 'run-landed', state: 'landed' }),
					makeRun({ id: 'run-aborted', state: 'aborted' }),
					makeRun({ id: 'run-live', state: 'running' }),
				],
			});
			expect(lanes.map((lane) => lane.currentRunId)).toEqual(['run-live']);
		});

		it('carries the target implementation run capability bit and the raw text for the card (E-117, E-278)', () => {
			const lanes = buildDeckLanes({
				runs: [
					makeRun({
						id: 'run-impl-1',
						kind: 'implement',
						taskId: 'task-20',
						state: 'awaiting_human',
						capabilities: { canReply: false, canResume: true },
					}),
					makeRun({
						id: 'run-review-1',
						kind: 'review',
						taskId: 'task-20',
						parentRunId: 'run-impl-1',
						state: 'awaiting_human',
						reviewVerdict: 'incomplete',
						reworkText: 'R1 未满足验收标准第 2 条',
						capabilities: { canReply: true, canResume: false },
					}),
				],
				tasks: [makeTask()],
				gates: [makeGate({ id: 'gate-9', runId: 'run-review-1' })],
			});

			const reviewLane = lanes.find((lane) => lane.currentRunId === 'run-review-1');
			expect(reviewLane?.reworkText).toBe('R1 未满足验收标准第 2 条');
			expect(reviewLane?.reviewVerdict).toBe('incomplete');
			// 投递目标是实施会话，能力位取实施运行那一份（不是审查运行的）
			expect(reviewLane?.deliverTargetRunId).toBe('run-impl-1');
			expect(reviewLane?.deliverTargetCanReply).toBe(false);
			// 待处理闸门给出审批卡的挂载点
			expect(reviewLane?.gateId).toBe('gate-9');
		});

		it('leaves the capability bit null when the daemon did not send it (不猜能力)', () => {
			const lanes = buildDeckLanes({
				runs: [
					makeRun({
						id: 'run-impl-1',
						kind: 'implement',
						taskId: 'task-20',
						state: 'awaiting_human',
					}),
					makeRun({
						id: 'run-review-1',
						kind: 'review',
						taskId: 'task-20',
						parentRunId: 'run-impl-1',
						state: 'awaiting_human',
						reviewVerdict: 'incomplete',
						reworkText: 'R1 原文',
					}),
				],
				tasks: [makeTask()],
			});
			const reviewLane = lanes.find((lane) => lane.currentRunId === 'run-review-1');
			expect(reviewLane?.deliverTargetCanReply).toBeNull();
			expect(reviewLane?.gateId).toBeNull();
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 5 & E-74：批次级落地清单
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 5 & E-74: batch-level landing checklist', () => {
		it('lists one row per wrapup round and one row per fix branch, with inHead from RunDto', () => {
			const wrapups = [
				makeWrapup({ id: 'wrapup-1', round: 1, fixRunIds: ['run-fix-1'] }),
				makeWrapup({
					id: 'wrapup-2',
					round: 2,
					runId: 'run-wrapup-2',
					fixRunIds: [],
					landing: {
						worktreePath: 'D:/xiangmu/agent-scheduler-batch-13',
						branchName: 'batch/13-round-2',
						diffStat: '1 file changed',
					},
				}),
			];
			const runs = [
				makeRun({ id: 'run-wrapup-1', isInHead: true }),
				makeRun({
					id: 'run-fix-1',
					kind: 'implement',
					taskId: 'M9-T21',
					origin: 'wrapup-fix',
					branchName: 'task/M9-T21',
					worktreePath: 'D:/xiangmu/agent-scheduler-m9-t21',
					isInHead: false,
				}),
				makeRun({ id: 'run-wrapup-2', isInHead: false }),
			];

			const list = buildBatchLandingList({ batchId: 'batch-13', batchNo: 13, wrapups, runs });

			expect(list.rows.map((row) => row.id)).toEqual([
				'wrapup:wrapup-1',
				'fix:run-fix-1',
				'wrapup:wrapup-2',
			]);
			expect(list.rows.map((row) => row.kind)).toEqual(['wrapup', 'fix', 'wrapup']);
			expect(list.rows[0]?.inHead).toBe(true);
			expect(list.rows[1]?.inHead).toBe(false);
			expect(list.rows[1]?.branchName).toBe('task/M9-T21');
			expect(list.rows[1]?.label).toBe('第 1 轮修复 · M9-T21');
		});

		it('composes a copyable command without executing anything (复制而不执行)', () => {
			expect(composeBatchLandingCommand('D:/wt/batch-13', 'batch/13-20260920')).toBe(
				'cd "D:/wt/batch-13" && gh stack push',
			);
			expect(composeBatchLandingCommand(null, 'task/M9-T20')).toBe(
				'git push -u origin "task/M9-T20"',
			);
			expect(composeBatchLandingCommand(null, null)).toBe('gh stack push');
		});

		it('renders the checklist with a checkmark on inHead rows and one copy button per row', () => {
			const batchLanding = buildBatchLandingList({
				batchId: 'batch-13',
				batchNo: 13,
				wrapups: [makeWrapup({ fixRunIds: ['run-fix-1'] })],
				runs: [
					makeRun({ id: 'run-wrapup-1', isInHead: true }),
					makeRun({
						id: 'run-fix-1',
						kind: 'implement',
						taskId: 'M9-T21',
						branchName: 'task/M9-T21',
						worktreePath: 'D:/xiangmu/agent-scheduler-m9-t21',
						isInHead: false,
					}),
				],
			});

			const html = renderToStaticMarkup(
				createElement(LandingPage, { taskId: 'M9-T20', batchLanding }),
			);

			expect(html).toContain('data-component="batch-landing-list"');
			expect(html).toContain('data-batch-no="13"');
			expect(html).toContain('data-row-count="2"');
			expect(html).toContain('data-batch-landing-row="wrapup"');
			expect(html).toContain('data-batch-landing-row="fix"');
			expect(html).toContain('data-in-head="true"');
			expect(html).toContain('✓ 已进 HEAD');
			expect(html).toContain('data-in-head="false"');
			expect(html).toContain('未进 HEAD');
			expect(html).toContain(
				'cd &quot;D:/xiangmu/agent-scheduler-batch-13&quot; &amp;&amp; gh stack push',
			);
			expect(html.match(/data-copy-token="batch-landing:/g)?.length).toBe(2);
			expect(html).toContain('复制而不执行');
		});

		it('shows an explicit empty state instead of a fake row when the batch has no wrapup branch', () => {
			const html = renderToStaticMarkup(
				createElement(LandingPage, {
					taskId: 'M9-T20',
					batchLanding: { batchId: 'batch-13', batchNo: 13, rows: [] },
				}),
			);
			expect(html).toContain('data-testid="batch-landing-empty"');
			expect(html).toContain('该批还没有可落地的收口分支');
		});
	});
});
