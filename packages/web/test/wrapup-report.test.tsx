/**
 * packages/web/test/wrapup-report.test.tsx
 *
 * M9-T20 收口泳道泳道面板、收口报告面板与批次落地清单测试
 * 验收标准与边界（AC 1, AC 2, AC 3, AC 5, E-106, E-157, E-236, E-274, E-286, E-297, E-74）
 *
 * 覆盖四层：展示组件（只吃 daemon 字段）、批次收口控件（在途禁用 + 具名拒绝原因）、
 * 容器（POST 不改状态、等 batch.wrapup_started 回流）、批次级落地清单（复制而不执行、inHead 打勾）。
 */

// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
	BatchWrapupDto,
	GetBatchWrapupsResponse,
	WrapupFindingDto,
} from '@agent-scheduler/shared/api/batches';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../src/api/event-bus.ts';
import { ApiError } from '../src/api/http-client.ts';
import {
	BatchWrapupControl,
	WrapupReport,
	formatFindingSummary,
	isDeclaredVerdictMismatch,
} from '../src/components/wrapup-report.tsx';
import {
	WrapupPanelContainer,
	type WrapupPanelResult,
	buildBatchLandingList,
	composeBatchLandingCommand,
	toWrapupFailureView,
} from '../src/features/run-deck/wrapup-panel-container.tsx';
import { getWrapupFailureMessage, resolveWrapupFailureReason } from '../src/i18n/error-messages.ts';
import { LandingPage } from '../src/pages/landing-page.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPO_ROOT = resolve(__dirname, '../../..');

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

			// tests 段
			expect(html).toContain('data-field="tests-status"');
			expect(html).toContain('data-tests-status="fail"');
			expect(html).toContain('vitest run → 3 failed');

			// findings 段
			expect(html).toContain('data-finding-id="B1"');
			expect(html).toContain('data-finding-id="B2"');

			// unassigned 段（标题「未归属 N 条」）
			expect(html).toContain('未归属 1 条');
			expect(html).toContain('B3 没有任务 ID 的条目');

			// landing 段
			expect(html).toContain('data-landing-field="worktree"');
			expect(html).toContain('D:/xiangmu/agent-scheduler-batch-13');
			expect(html).toContain('batch/13-20260920');

			// reportText 收进可展开块
			expect(html).toContain('data-segment="report-text"');
			expect(html).toContain('data-field="report-text"');
		});

		it('marks isWellFormed=false rows with a「格式不全」chip and keeps them clickable rows', () => {
			const html = renderToStaticMarkup(
				createElement(WrapupReport, { entry: { kind: 'parsed', wrapup: makeWrapup() } }),
			);

			expect(html).toContain('data-chip="ill-formed"');
			expect(html).toContain('格式不全');
			// 只有 B2 一行格式不全
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
			// 有效裁定仍是 open（有遗留），绝不按自报 clean 放行
			expect(html).toContain('data-verdict="open"');
			expect(html).toContain('有遗留');

			const matched = renderToStaticMarkup(
				createElement(WrapupReport, {
					entry: { kind: 'parsed', wrapup: makeWrapup({ declaredVerdict: 'open' }) },
				}),
			);
			expect(isDeclaredVerdictMismatch(makeWrapup({ declaredVerdict: 'open' }))).toBe(false);
			expect(matched).not.toContain('data-chip="declared-mismatch"');
		});

		it('makes every finding row clickable to jump to its task', () => {
			const onOpenTask = vi.fn();
			const html = renderToStaticMarkup(
				createElement(WrapupReport, {
					entry: { kind: 'parsed', wrapup: makeWrapup() },
					onOpenTask,
				}),
			);

			// 整行是按钮，data-task-key 直达目标任务
			expect(html).toContain('data-task-key="M9-T20"');
			expect(html).toContain('data-task-key="M9-T21"');
			expect(html).not.toContain('data-task-key="" ');
			expect(onOpenTask).not.toHaveBeenCalled();
		});

		it('formats the finding row as id [severity] 涉及 taskKey（跨批）：symptom', () => {
			const [wellFormed, illFormed] = makeWrapup().findings as readonly WrapupFindingDto[];
			expect(wellFormed).toBeDefined();
			expect(illFormed).toBeDefined();
			expect(formatFindingSummary(wellFormed as WrapupFindingDto)).toBe(
				'B1 [S2] 涉及 M9-T20（跨批）：投递按钮点了没反应',
			);
			// severity 缺失显示「—」，绝不猜
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
			const onOpenRun = vi.fn();
			const html = renderToStaticMarkup(
				createElement(WrapupReport, {
					entry: {
						kind: 'unparsable',
						round: 2,
						runId: 'run-wrapup-2',
						missingSections: ['BUGS', 'FIXED'],
						rawText: '原始输出全文，未结构化',
					},
					onOpenRun,
				}),
			);

			expect(html).toContain('data-entry-kind="unparsable"');
			expect(html).toContain('第 2 轮');
			expect(html).toContain('解析失败');
			expect(html).toContain('缺段：BUGS、FIXED');
			expect(html).toContain('data-action="goto-raw-report"');
			expect(html).toContain('href="#/run/run-wrapup-2"');
			expect(html).toContain('直链原文');
			// 原文原样展示，不裁剪
			expect(html).toContain('data-field="unparsable-raw"');
			expect(html).toContain('原始输出全文，未结构化');
			expect(onOpenRun).not.toHaveBeenCalled();
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
			it(`has no parsing of the eight-section原文 in ${relativePath}`, () => {
				const source = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
				for (const pattern of FORBIDDEN_PARSING) {
					expect(source).not.toMatch(pattern);
				}
			});
		}
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 3 & E-157：批次收口按钮的门控、在途禁用与具名拒绝原因
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 3 & E-157: batch wrapup control gating, in-flight disable and named reasons', () => {
		it('renders the 收口 button only when canWrapup and not a phone tier', () => {
			const desktop = renderToStaticMarkup(
				createElement(BatchWrapupControl, { canWrapup: true, isPhoneTier: false }),
			);
			expect(desktop).toContain('data-action="wrapup-batch"');
			expect(desktop).toContain('收口');
			expect(desktop).toContain('data-placement="under-batch-title"');

			// canWrapup 为假：不出按钮
			expect(
				renderToStaticMarkup(createElement(BatchWrapupControl, { canWrapup: false })),
			).not.toContain('data-action="wrapup-batch"');

			// 手机档：不出按钮（E-297）
			const phone = renderToStaticMarkup(
				createElement(BatchWrapupControl, { canWrapup: true, isPhoneTier: true }),
			);
			expect(phone).not.toContain('data-action="wrapup-batch"');
			// 手机档但无失败提示时整块不渲染
			expect(phone).toBe('');
		});

		it('disables the button while the request is in flight / awaiting the回流 event', () => {
			const html = renderToStaticMarkup(
				createElement(BatchWrapupControl, {
					canWrapup: true,
					isPhoneTier: false,
					isPending: true,
				}),
			);
			expect(html).toContain('data-pending="true"');
			expect(html).toContain('disabled=""');
			expect(html).toContain('收口中…');
		});

		it('does not render the button when pending but canWrapup is false', () => {
			const html = renderToStaticMarkup(
				createElement(BatchWrapupControl, { canWrapup: false, isPending: true }),
			);
			expect(html).toBe('');
		});

		it('names E_BATCH_NOT_WRAPPABLE reasons from details.reason, with the offending task keys', () => {
			expect(resolveWrapupFailureReason('E_BATCH_NOT_WRAPPABLE', { reason: 'done' })).toBe('done');
			expect(getWrapupFailureMessage('E_BATCH_NOT_WRAPPABLE', { reason: 'done' })).toContain(
				'该批已收口完成',
			);
			expect(
				getWrapupFailureMessage('E_BATCH_NOT_WRAPPABLE', {
					reason: 'not_all_landed',
					notLandedTaskKeys: ['M9-T21', 'M9-T22'],
				}),
			).toBe('该批仍有任务未落地，无法收口（未落地：M9-T21、M9-T22）');
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
			expect(resolveWrapupFailureReason('E_WRAPUP_ROUND_LIMIT', { trigger: 'manual' })).toBe(
				'round_limit_hard',
			);
			expect(
				getWrapupFailureMessage('E_WRAPUP_ROUND_LIMIT', {
					trigger: 'auto',
					validRound: 2,
					autoLimit: 2,
				}),
			).toBe('自动收口轮次已达上限，需人工确认后再收口（上限 2 轮）');
			expect(
				getWrapupFailureMessage('E_WRAPUP_ROUND_LIMIT', {
					trigger: 'manual',
					physicalAttempts: 6,
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

		it('renders the named failure line under the batch title with its reason code', () => {
			const html = renderToStaticMarkup(
				createElement(BatchWrapupControl, {
					canWrapup: true,
					isPhoneTier: false,
					failure: toWrapupFailureView(
						new ApiError({
							code: 'E_BATCH_NOT_WRAPPABLE',
							message: 'Not all tasks in batch are landed.',
							requestId: 'req-7',
							details: { reason: 'not_all_landed', notLandedTaskKeys: ['M9-T21'] },
						}),
					),
				}),
			);

			expect(html).toContain('data-region="batch-wrapup-failure"');
			expect(html).toContain('data-failure-reason="not_all_landed"');
			expect(html).toContain('data-field="wrapup-failure-message"');
			expect(html).toContain('该批仍有任务未落地，无法收口（未落地：M9-T21）');
			expect(html).toContain('E_BATCH_NOT_WRAPPABLE');
			expect(html).toContain('requestId=req-7');
		});

		it('keeps the failure line visible on a phone tier even though the button is gone', () => {
			const html = renderToStaticMarkup(
				createElement(BatchWrapupControl, {
					canWrapup: true,
					isPhoneTier: true,
					failure: { reason: 'done', message: '该批已收口完成，无需再次收口' },
				}),
			);
			expect(html).not.toContain('data-action="wrapup-batch"');
			expect(html).toContain('data-region="batch-wrapup-failure"');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 3 & E-157：容器 POST 后不改状态，等 batch.wrapup_started 回流
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 3 & E-157: container never flips state from the POST response', () => {
		it('disables the button after acceptance and only clears on batch.wrapup_started', async () => {
			const bus = createEventBus();
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
			const fetcher = vi.fn().mockResolvedValue({ wrapups: [] } as GetBatchWrapupsResponse);

			const mounted = await mountWrapupPanel({
				batchId: 'batch-13',
				canWrapup: true,
				initialWrapups: [],
				wrapupPoster: poster,
				fetcher,
				bus,
			});

			expect(mounted.html()).toContain('data-pending="false"');
			expect(mounted.result().isWrapupPending).toBe(false);

			await act(async () => {
				mounted.clickWrapup();
			});
			await act(async () => {});

			// 已接受：控件置为在途；响应体里的 state='wrapping' 绝不被拿来当界面状态（E-157）
			expect(poster).toHaveBeenCalledTimes(1);
			expect(mounted.result().isWrapupPending).toBe(true);
			expect(mounted.html()).toContain('data-pending="true"');
			expect(mounted.html()).toContain('disabled=""');

			// 回流事件到达才清在途并重取
			await act(async () => {
				bus.push({
					id: 900,
					ts: new Date().toISOString(),
					runId: 'run-wrapup-1',
					taskId: null,
					scope: 'batch',
					kind: 'batch.wrapup_started',
					seq: 1,
					actorDeviceId: null,
					payload: {
						batchId: 'batch-13',
						batchNo: 13,
						runId: 'run-wrapup-1',
						round: 1,
						trigger: 'manual',
						promptSource: 'docs',
						branchName: 'batch/13-20260920',
					},
				});
			});

			expect(mounted.result().isWrapupPending).toBe(false);
			expect(fetcher).toHaveBeenCalledTimes(1);
			await mounted.unmount();
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

			const mounted = await mountWrapupPanel({
				batchId: 'batch-13',
				canWrapup: true,
				initialWrapups: [],
				wrapupPoster: poster,
				bus: createEventBus(),
			});

			await act(async () => {
				mounted.clickWrapup();
			});
			await act(async () => {});
			await act(async () => {
				mounted.clickWrapup();
			});
			await act(async () => {});

			expect(poster).toHaveBeenCalledTimes(2);
			const firstKey = poster.mock.calls[0]?.[1]?.idempotencyKey;
			const secondKey = poster.mock.calls[1]?.[1]?.idempotencyKey;
			expect(typeof firstKey).toBe('string');
			expect(secondKey).toBe(firstKey);
			// 被拒后清掉在途并给出具名原因
			expect(mounted.result().isWrapupPending).toBe(false);
			expect(mounted.result().failure?.reason).toBe('wrapup_in_flight');
			expect(mounted.html()).toContain('data-failure-reason="wrapup_in_flight"');
			await mounted.unmount();
		});

		it('records a 解析失败 entry when batch.wrapup_finished says verdict=unparsed (E-274/E-297)', async () => {
			const bus = createEventBus();
			const mounted = await mountWrapupPanel({
				batchId: 'batch-13',
				initialWrapups: [],
				bus,
			});

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

			expect(mounted.html()).toContain('data-entry-kind="unparsable"');
			expect(mounted.html()).toContain('解析失败');
			expect(mounted.html()).toContain('#/run/run-wrapup-9');
			await mounted.unmount();
		});

		it('ignores wrapup events belonging to another batch', async () => {
			const bus = createEventBus();
			const mounted = await mountWrapupPanel({
				batchId: 'batch-13',
				initialWrapups: [],
				bus,
			});

			await act(async () => {
				bus.push({
					id: 902,
					ts: new Date().toISOString(),
					runId: 'run-wrapup-other',
					taskId: null,
					scope: 'batch',
					kind: 'batch.wrapup_finished',
					seq: 3,
					actorDeviceId: null,
					payload: {
						batchId: 'batch-14',
						batchNo: 14,
						runId: 'run-wrapup-other',
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

			expect(mounted.html()).not.toContain('data-entry-kind="unparsable"');
			await mounted.unmount();
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

			expect(list.batchId).toBe('batch-13');
			expect(list.batchNo).toBe(13);
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
			expect(list.rows[2]?.label).toBe('第 2 轮收口');
		});

		it('leaves inHead null when the run row is unknown, never guessing', () => {
			const list = buildBatchLandingList({
				batchId: 'batch-13',
				wrapups: [makeWrapup({ fixRunIds: ['run-missing'] })],
				runs: [],
			});
			expect(list.rows[0]?.inHead).toBeNull();
			expect(list.rows[1]?.inHead).toBeNull();
			expect(list.rows[0]?.branchName).toBe('batch/13-20260920');
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
			// inHead 为真的行打勾
			expect(html).toContain('data-in-head="true"');
			expect(html).toContain('✓ 已进 HEAD');
			expect(html).toContain('data-in-head="false"');
			expect(html).toContain('未进 HEAD');
			// 可复制命令
			expect(html).toContain('data-field="batch-landing-command"');
			expect(html).toContain(
				'cd &quot;D:/xiangmu/agent-scheduler-batch-13&quot; &amp;&amp; gh stack push',
			);
			expect(html.match(/data-copy-token="batch-landing:/g)?.length).toBe(2);
			// 只读、复制而不执行
			expect(html).toContain('复制而不执行');
		});

		it('omits the batch section entirely when no batch landing data is provided', () => {
			const html = renderToStaticMarkup(createElement(LandingPage, { taskId: 'M9-T20' }));
			expect(html).not.toContain('data-component="batch-landing-list"');
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

// ─────────────────────────────────────────────────────────────────────────────
// 容器测试挂载辅助
// ─────────────────────────────────────────────────────────────────────────────

interface MountedWrapupPanel {
	readonly result: () => WrapupPanelResult;
	readonly html: () => string;
	readonly clickWrapup: () => void;
	readonly unmount: () => Promise<void>;
}

async function mountWrapupPanel(
	props: Parameters<typeof WrapupPanelContainer>[0],
): Promise<MountedWrapupPanel> {
	const observed: { value?: WrapupPanelResult } = {};
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);

	await act(async () => {
		root.render(
			createElement(WrapupPanelContainer, {
				...props,
				onResult: (value: WrapupPanelResult) => {
					observed.value = value;
				},
			}),
		);
	});
	await act(async () => {});

	return {
		result: () => {
			if (!observed.value) throw new Error('WrapupPanelContainer did not render');
			return observed.value;
		},
		html: () => container.innerHTML,
		clickWrapup: () => {
			const button = container.querySelector('button[data-action="wrapup-batch"]');
			if (!button) throw new Error('wrapup button is not rendered');
			(button as HTMLButtonElement).click();
		},
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}
