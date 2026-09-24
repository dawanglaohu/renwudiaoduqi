/**
 * packages/web/src/components/wrapup-report.tsx
 *
 * 收口报告面板与批次收口控件（M9-T20 / AC 2, AC 3, E-286, E-297, E-157）
 *
 * 规范依据（07 节前端架构、11 节 UI、12 节 UX）：
 * - 只展示 daemon 已解析字段：tests / findings / unassigned / landing / reportText；
 *   **代码中不存在前端解析 `reportText` 的路径**（E-297）——原文只当字符串进可展开块
 * - 解析失败时显示「解析失败」并直链原文，不做部分解析、不猜语义（E-274 的呈现侧）
 * - 有效裁定与自报裁定不一致时同时显示两者（E-286 的呈现侧），绝不按自报放行
 * - `promptSource='builtin'` 时头部 chip「文档未提供收口提示词」
 * - `isWellFormed=false` 的 findings 行尾 chip「格式不全」
 * - 「收口」按钮只在 canWrapup 且非手机档渲染（手机端不出收口按钮，E-297）；
 *   请求在途禁用，具名拒绝原因贴在批次标题下，最终状态一律等回流事件（E-157）
 * - 纯 props in / callback out，禁止 import api/store/features/shell，禁止内部 useEffect 取数
 * - 颜色字号圆角全部走 tokens.css 的 CSS 变量与既定字号，无颜色字面量（E-170）
 */

import type { BatchWrapupDto, WrapupFindingDto } from '@agent-scheduler/shared/api/batches';
import type { HTMLAttributes, MouseEvent } from 'react';
import type { DensityTier } from '../hooks/use-breakpoint.ts';
import type { WrapupFailureReason } from '../i18n/error-messages.ts';
import type { StatusState } from '../lib/spine-shape.ts';
import { StatusBadge } from './status-badge.tsx';

// ─────────────────────────────────────────────────────────────────────────────
// 数据形状：只吃 daemon 下发的字段，组件不补算任何业务判定
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析失败的一轮收口（daemon 未持久化 batch_wrapups 行，只有 run 与原文）。
 * `rawText` 有就原样展示；没有则只给直链原文的入口。
 */
export interface WrapupUnparsableEntry {
	readonly kind: 'unparsable';
	/** 收口轮次（daemon 下发的 batch.wrapup_finished.round） */
	readonly round: number;
	/** 收口运行 ID（直链原文用） */
	readonly runId: string;
	/** 缺失段清单（daemon 解析器给的精确缺段清单，可选） */
	readonly missingSections?: readonly string[];
	/** 原始输出全文（有则原样展示，绝不裁剪、绝不解析） */
	readonly rawText?: string | null;
}

/** 解析成功的一轮收口。 */
export interface WrapupParsedEntry {
	readonly kind: 'parsed';
	readonly wrapup: BatchWrapupDto;
}

export type WrapupReportEntry = WrapupParsedEntry | WrapupUnparsableEntry;

// ─────────────────────────────────────────────────────────────────────────────
// 呈现映射（纯查表，不含业务判定）
// ─────────────────────────────────────────────────────────────────────────────

export const WRAPUP_VERDICT_LABELS = Object.freeze({
	clean: '干净',
	fixed: '已修',
	open: '有遗留',
} as const);

export const WRAPUP_TESTS_STATUS_LABELS = Object.freeze({
	pass: '通过',
	fail: '失败',
	skipped: '跳过',
	unknown: '未识别',
} as const);

export const WRAPUP_FINDING_KIND_LABELS = Object.freeze({
	bug: '缺陷',
	not_fixed: '未修',
	test_failure: '测试失败',
} as const);

/**
 * 裁定 → 状态徽标状态。与批次树收口徽标的既有映射保持一致
 * （clean/fixed 用 succeeded 形状 + 各自文案，open 用 partial 暖色，绝不把 open 渲染成绿）。
 */
export function resolveVerdictBadgeState(verdict: BatchWrapupDto['verdict']): StatusState {
	return verdict === 'open' ? 'partial' : 'succeeded';
}

/**
 * 自报裁定与实际有效裁定是否不一致（E-286 的呈现侧判定：只比较 daemon 已下发的两个字段）。
 */
export function isDeclaredVerdictMismatch(wrapup: BatchWrapupDto): boolean {
	return wrapup.declaredVerdict !== null && wrapup.declaredVerdict !== wrapup.verdict;
}

/**
 * findings 整行摘要：`{id} [{severity}] 涉及 {taskKey}（跨批）：{现象}`。
 * 现象缺失时原样回落到 daemon 保留的 `raw`，不裁剪、不猜。
 */
export function formatFindingSummary(finding: WrapupFindingDto): string {
	const severity = finding.severity && finding.severity.length > 0 ? finding.severity : '—';
	const target = finding.taskKey && finding.taskKey.length > 0 ? finding.taskKey : '未标注任务';
	const crossBatch = finding.crossBatch ? '（跨批）' : '';
	const symptom =
		finding.symptom && finding.symptom.length > 0
			? finding.symptom
			: finding.raw.length > 0
				? finding.raw
				: '—';
	return `${finding.id} [${severity}] 涉及 ${target}${crossBatch}：${symptom}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 收口报告面板（每轮一张卡）
// ─────────────────────────────────────────────────────────────────────────────

export interface WrapupReportProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
	/** 一轮收口的入口数据（解析成功或解析失败） */
	readonly entry: WrapupReportEntry;
	/** findings 整行点击：跳到该任务 */
	readonly onOpenTask?: (taskKey: string) => void;
	/** 直链原文：跳到该收口运行的会话详情 */
	readonly onOpenRun?: (runId: string) => void;
	/** 复制回调（token 由调用方约定，本组件只发起请求并显示已复制态） */
	readonly onCopyField?: (token: string, text: string) => void;
	/** 当前已复制的 token（null 表示无） */
	readonly copiedToken?: string | null;
	/** 密度档位（由外层单点计算下传） */
	readonly tier?: DensityTier;
	/** 是否粗指针触控环境（按钮撑到 44px） */
	readonly isTouch?: boolean;
}

/**
 * 收口报告卡片：解析成功展示 daemon 八段字段，解析失败只显示「解析失败」+ 直链原文。
 */
export function WrapupReport(props: WrapupReportProps) {
	const {
		entry,
		onOpenTask,
		onOpenRun,
		onCopyField,
		copiedToken,
		tier,
		isTouch = false,
		className,
		...rest
	} = props;

	const touchClass = isTouch ? 'min-h-[var(--h-btn-lg,44px)]' : 'h-[var(--h-btn,32px)]';

	if (entry.kind === 'unparsable') {
		const rawHref = `#/run/${encodeURIComponent(entry.runId)}`;
		return (
			<section
				data-component="wrapup-report"
				data-entry-kind="unparsable"
				data-round={entry.round}
				data-tier={tier}
				className={[
					'flex flex-col gap-2 rounded-[var(--r,14px)] border border-[var(--border)] bg-[var(--bg)] p-3 select-text',
					className ?? '',
				]
					.join(' ')
					.trim()}
				{...rest}
			>
				<header data-segment="head" className="flex items-center gap-2 flex-wrap">
					<span className="font-mono text-[13px] font-semibold text-[var(--ink-1)]">
						第 {entry.round} 轮
					</span>
					{/* 解析失败不做部分解析：只给这一枚徽标与直链原文（E-274 呈现侧） */}
					<StatusBadge state="unrecognized" text="解析失败" />
					{entry.missingSections && entry.missingSections.length > 0 && (
						<span
							data-chip="missing-sections"
							title={entry.missingSections.join('、')}
							className="font-mono text-[11px] text-[var(--ink-3)] truncate"
						>
							缺段：{entry.missingSections.join('、')}
						</span>
					)}
					<a
						href={rawHref}
						data-action="goto-raw-report"
						data-run-id={entry.runId}
						onClick={(e: MouseEvent<HTMLAnchorElement>) => {
							if (!onOpenRun) {
								return;
							}
							e.preventDefault();
							onOpenRun(entry.runId);
						}}
						className={[
							'inline-flex items-center gap-1.5 ml-auto px-2.5 rounded-[var(--r-sm,9px)] font-ui text-[12px]',
							'border border-[var(--border)] text-[var(--needs)] hover:underline',
							'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--needs-soft)]',
							touchClass,
						].join(' ')}
					>
						<span aria-hidden="true">↗</span>
						<span>直链原文</span>
					</a>
				</header>

				{entry.rawText && entry.rawText.length > 0 && (
					<div
						data-field="unparsable-raw"
						className="font-mono text-[12px] whitespace-pre-wrap break-all rounded-[var(--r-sm,9px)] border border-[var(--border)] bg-[var(--panel-2)] p-2.5 max-h-[var(--payload-max-h,240px)] overflow-y-auto text-[var(--ink-2)]"
					>
						{entry.rawText}
					</div>
				)}
			</section>
		);
	}

	const wrapup = entry.wrapup;
	const isMismatch = isDeclaredVerdictMismatch(wrapup);
	const testsStatus = wrapup.tests.status;

	return (
		<section
			data-component="wrapup-report"
			data-entry-kind="parsed"
			data-round={wrapup.round}
			data-run-id={wrapup.runId}
			data-verdict={wrapup.verdict}
			data-declared-verdict={wrapup.declaredVerdict ?? 'null'}
			data-prompt-source={wrapup.promptSource}
			data-tier={tier}
			className={[
				'flex flex-col gap-2.5 rounded-[var(--r,14px)] border border-[var(--border)] bg-[var(--bg)] p-3 select-text',
				className ?? '',
			]
				.join(' ')
				.trim()}
			{...rest}
		>
			{/* 头部：第 N 轮 · 裁定徽标（+ 自报不一致、文档未提供收口提示词） */}
			<header data-segment="head" className="flex items-center gap-2 flex-wrap">
				<span className="font-mono text-[13px] font-semibold text-[var(--ink-1)]">
					第 {wrapup.round} 轮
				</span>
				<StatusBadge
					state={resolveVerdictBadgeState(wrapup.verdict)}
					text={WRAPUP_VERDICT_LABELS[wrapup.verdict]}
				/>
				{isMismatch && (
					<>
						{/* E-286：自报与实际不一致时两者同时显示，warn 只作提示，绝不按自报放行 */}
						<span
							data-chip="declared-mismatch"
							title="自报裁定与实际裁定不一致，已按内容算出的裁定处理"
							className="h-[20px] px-1.5 inline-flex items-center rounded-[6px] border border-[var(--warn)] bg-[var(--needs-soft)] font-ui text-[11px] text-[var(--needs)]"
						>
							自报与实际不一致
						</span>
						<span
							data-field="declared-verdict"
							className="font-mono text-[11px] text-[var(--ink-3)]"
						>
							自报：{wrapup.declaredVerdict ? WRAPUP_VERDICT_LABELS[wrapup.declaredVerdict] : '—'}
						</span>
					</>
				)}
				{wrapup.isHumanVerdict && (
					<span
						data-chip="human-verdict"
						className="h-[20px] px-1.5 inline-flex items-center rounded-[6px] border border-[var(--border)] bg-[var(--panel-2)] font-ui text-[11px] text-[var(--ink-3)]"
					>
						人工裁定
					</span>
				)}
				{wrapup.promptSource === 'builtin' && (
					<span
						data-chip="builtin-prompt"
						title="项目文档没有收口提示词，本次收口用的是内置版"
						className="h-[20px] px-1.5 inline-flex items-center rounded-[6px] border border-[var(--warn)] bg-[var(--needs-soft)] font-ui text-[11px] text-[var(--needs)]"
					>
						文档未提供收口提示词
					</span>
				)}
			</header>

			{/* TESTS 段：状态词 + 条目 */}
			<section data-segment="tests" className="flex flex-col gap-1">
				<div className="flex items-center gap-2">
					<span className="font-ui text-[12px] font-semibold text-[var(--ink-2)]">测试</span>
					<span
						data-field="tests-status"
						data-tests-status={testsStatus}
						className={[
							'font-mono text-[12px]',
							testsStatus === 'pass'
								? 'text-[var(--auto)]'
								: testsStatus === 'fail'
									? 'text-[var(--down)]'
									: 'text-[var(--ink-3)]',
						].join(' ')}
					>
						{WRAPUP_TESTS_STATUS_LABELS[testsStatus]}
					</span>
					<span className="font-mono text-[11px] text-[var(--ink-3)]">
						{wrapup.tests.items.length} 条
					</span>
				</div>
				{wrapup.tests.items.map((item) => (
					<div
						key={item}
						data-tests-item="true"
						className="font-mono text-[12px] text-[var(--ink-2)] whitespace-pre-wrap break-all"
					>
						{item}
					</div>
				))}
			</section>

			{/* findings 段：整行可点跳该任务；格式不全行尾 chip */}
			<section data-segment="findings" className="flex flex-col gap-1">
				<div className="flex items-center gap-2">
					<span className="font-ui text-[12px] font-semibold text-[var(--ink-2)]">发现</span>
					<span className="font-mono text-[11px] text-[var(--ink-3)]">
						{wrapup.findings.length} 条
					</span>
				</div>
				{wrapup.findings.map((finding) => {
					const canOpen = Boolean(finding.taskKey && onOpenTask);
					return (
						<button
							key={finding.id}
							type="button"
							data-finding-id={finding.id}
							data-finding-kind={finding.kind}
							data-task-key={finding.taskKey ?? ''}
							data-well-formed={finding.isWellFormed ? 'true' : 'false'}
							data-is-fixed={finding.isFixed ? 'true' : 'false'}
							disabled={!canOpen}
							title={canOpen ? `跳到任务 ${finding.taskKey}` : '该条未标注任务，无法跳转'}
							onClick={() => {
								if (finding.taskKey) {
									onOpenTask?.(finding.taskKey);
								}
							}}
							className={[
								'w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-[var(--r-sm,9px)]',
								'border border-[var(--border)] bg-[var(--panel-2)] font-mono text-[12px] text-[var(--ink-2)]',
								canOpen ? 'cursor-pointer hover:border-[var(--border-strong)]' : 'cursor-default',
								'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--needs-soft)]',
							].join(' ')}
						>
							<span className="min-w-0 flex-1 truncate">{formatFindingSummary(finding)}</span>
							<span
								data-chip="finding-kind"
								className="shrink-0 font-ui text-[11px] text-[var(--ink-3)]"
							>
								{WRAPUP_FINDING_KIND_LABELS[finding.kind]}
							</span>
							{finding.isFixed && (
								<span
									data-chip="finding-fixed"
									className="shrink-0 font-ui text-[11px] text-[var(--auto)]"
								>
									已修
								</span>
							)}
							{!finding.isWellFormed && (
								<span
									data-chip="ill-formed"
									title="该条只有三段箭头，缺少现象/复现/根因/文件:行 中的字段"
									className="shrink-0 h-[20px] px-1.5 inline-flex items-center rounded-[6px] border border-[var(--warn)] bg-[var(--needs-soft)] font-ui text-[11px] text-[var(--needs)]"
								>
									格式不全
								</span>
							)}
						</button>
					);
				})}
			</section>

			{/* unassigned 段：标题「未归属 N 条」+ 原文逐条保留 */}
			<section data-segment="unassigned" className="flex flex-col gap-1">
				<span className="font-ui text-[12px] font-semibold text-[var(--ink-2)]">
					未归属 {wrapup.unassigned.length} 条
				</span>
				{wrapup.unassigned.map((item) => (
					<div
						key={item}
						data-unassigned-item="true"
						className="font-mono text-[12px] text-[var(--ink-3)] whitespace-pre-wrap break-all"
					>
						{item}
					</div>
				))}
			</section>

			{/* landing 段：worktree / 分支 / diffStat / 可复制命令（E-74 的收口侧） */}
			<section data-segment="landing" className="flex flex-col gap-1.5">
				<span className="font-ui text-[12px] font-semibold text-[var(--ink-2)]">收口分支</span>
				<WrapupLandingField
					token={`landing-worktree:${wrapup.id}`}
					label="worktree"
					value={wrapup.landing?.worktreePath ?? null}
					onCopyField={onCopyField}
					copiedToken={copiedToken}
					touchClass={touchClass}
				/>
				<WrapupLandingField
					token={`landing-branch:${wrapup.id}`}
					label="分支"
					value={wrapup.landing?.branchName ?? null}
					onCopyField={onCopyField}
					copiedToken={copiedToken}
					touchClass={touchClass}
				/>
				<WrapupLandingField
					token={`landing-diff:${wrapup.id}`}
					label="diff"
					value={wrapup.landing?.diffStat ?? null}
					onCopyField={onCopyField}
					copiedToken={copiedToken}
					touchClass={touchClass}
				/>
			</section>

			{/* reportText 收进可展开「八段原文」块；**不在前端解析原文**（E-297） */}
			<details data-segment="report-text" className="group">
				<summary className="cursor-pointer font-ui text-[12px] text-[var(--ink-3)] hover:text-[var(--ink-2)] select-none">
					八段原文
				</summary>
				<div
					data-field="report-text"
					className="mt-1.5 font-mono text-[12px] whitespace-pre-wrap break-all rounded-[var(--r-sm,9px)] border border-[var(--border)] bg-[var(--panel-2)] p-2.5 max-h-[var(--payload-max-h,240px)] overflow-y-auto text-[var(--ink-2)]"
				>
					{wrapup.reportText}
				</div>
			</details>
		</section>
	);
}

interface WrapupLandingFieldProps {
	readonly token: string;
	readonly label: string;
	readonly value: string | null;
	readonly onCopyField?: (token: string, text: string) => void;
	readonly copiedToken?: string | null;
	readonly touchClass: string;
}

/**
 * 只读落地字段一行：值缺失显示「—」，复制按钮在无值或无人接复制时禁用（不伪造、不执行）。
 */
function WrapupLandingField(props: WrapupLandingFieldProps) {
	const { token, label, value, onCopyField, copiedToken, touchClass } = props;
	const display = value && value.length > 0 ? value : '—';
	const canCopy = display !== '—' && Boolean(onCopyField);
	const isCopied = copiedToken === token;

	return (
		<div data-landing-field={label} className="flex items-center gap-2">
			<span className="shrink-0 w-[7ch] font-ui text-[11px] text-[var(--ink-3)]">{label}</span>
			<span
				title={display}
				className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--ink-1)] select-all"
			>
				{display}
			</span>
			<button
				type="button"
				data-copy-token={token}
				disabled={!canCopy}
				onClick={() => {
					if (canCopy) {
						onCopyField?.(token, display);
					}
				}}
				className={[
					'shrink-0 px-2 rounded-[var(--r-sm,9px)] border border-[var(--border)] bg-[var(--panel-2)]',
					'font-ui text-[11px]',
					canCopy
						? 'text-[var(--ink-2)] hover:text-[var(--ink-1)] cursor-pointer'
						: 'text-[var(--stopped)] cursor-not-allowed opacity-80',
					'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--needs-soft)]',
					touchClass,
				].join(' ')}
			>
				{isCopied ? '✓ 已复制' : '复制'}
			</button>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 批次收口拒绝行（挂在批次标题下：只呈现，按钮归批次树）
// ─────────────────────────────────────────────────────────────────────────────

/** 收口被拒的就地提示内容（文案由 i18n/error-messages.ts 生成，组件只呈现）。 */
export interface BatchWrapupFailureView {
	/** daemon 的机器可读原因（认不出时为 null，此时只呈现通用文案） */
	readonly reason: WrapupFailureReason | null;
	/** 中文具名文案 */
	readonly message: string;
	/** 可展开的技术详情（错误码 + requestId + daemon 英文短句） */
	readonly technical?: string;
}

export interface BatchWrapupFailureLineProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
	/** 上次收口被拒的具名原因；null 时整行不渲染 */
	readonly failure?: BatchWrapupFailureView | null;
}

/**
 * 批次收口被拒的具名原因行，直接渲染在该批标题行之下（`data-placement="under-batch-title"`）。
 *
 * 收口按钮本身归批次树（`batch-tree.tsx` 第 4 槽的既有按钮），这里只画拒绝原因，
 * 保证一屏里不会出现两颗「收口」按钮（E-157、E-297）。
 */
export function BatchWrapupFailureLine(props: BatchWrapupFailureLineProps) {
	const { failure = null, className, ...rest } = props;

	if (!failure) {
		return null;
	}

	return (
		<div
			data-region="batch-wrapup-failure"
			data-placement="under-batch-title"
			data-failure-reason={failure.reason ?? 'unknown'}
			className={[
				'flex flex-col gap-1 rounded-[var(--r-sm,9px)] border border-[var(--down)] bg-[var(--down-soft)] px-2 py-1.5 font-ui text-[12px] text-[var(--down)]',
				className ?? '',
			]
				.join(' ')
				.trim()}
			{...rest}
		>
			<span data-field="wrapup-failure-message">{failure.message}</span>
			{failure.technical && (
				<details className="text-[11px] text-[var(--ink-3)]">
					<summary className="cursor-pointer hover:text-[var(--ink-2)]">技术详情</summary>
					<div className="font-mono break-all">{failure.technical}</div>
				</details>
			)}
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 批次级落地清单（E-74 批次侧：每轮收口一行 + 各修复分支一行，复制而不执行）
// ─────────────────────────────────────────────────────────────────────────────

/** 批次级落地清单的一行（行数据由 features 层从 daemon 的收口记录与运行行拼出）。 */
export interface BatchLandingChecklistRow {
	readonly id: string;
	readonly kind: 'wrapup' | 'fix';
	readonly round: number;
	readonly label: string;
	readonly branchName: string | null;
	readonly worktreePath: string | null;
	readonly diffStat: string | null;
	/** daemon 的 RunDto.isInHead，缺失一律 null（不在前端推断是否进 HEAD） */
	readonly inHead: boolean | null;
	/** 可一键复制的命令文本（只生成，绝不执行） */
	readonly command: string;
	readonly runId: string | null;
}

export interface BatchLandingChecklistProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
	readonly batchNo?: number | null;
	readonly rows: readonly BatchLandingChecklistRow[];
	/** 复制回调（token, text） */
	readonly onCopyField?: (token: string, text: string) => void;
	/** 当前已复制的 token */
	readonly copiedToken?: string | null;
	readonly isTouch?: boolean;
}

/**
 * 批次级只读落地清单：逐轮收口分支与各修复分支各一行，`inHead` 为真的行打勾，命令可复制不可执行（E-74）。
 */
export function BatchLandingChecklist(props: BatchLandingChecklistProps) {
	const { batchNo, rows, onCopyField, copiedToken, isTouch = false, className, ...rest } = props;

	const touchClass = isTouch ? 'min-h-[var(--h-btn-lg,44px)]' : 'h-[var(--h-btn,32px)]';

	return (
		<section
			data-component="batch-landing-list"
			data-batch-no={batchNo ?? 'null'}
			data-row-count={rows.length}
			className={['flex flex-col gap-3', className ?? ''].join(' ').trim()}
			{...rest}
		>
			<div className="flex flex-col gap-1 border-b border-[var(--border)] pb-2">
				<div className="flex items-center gap-2">
					<span className="font-mono text-[14px] font-bold text-[var(--needs)]">
						{batchNo !== null && batchNo !== undefined ? `第 ${batchNo} 批` : '—'}
					</span>
					<span className="text-[var(--ink-3)]">·</span>
					<span className="text-[14px] text-[var(--ink-2)]">批次级落地清单</span>
				</div>
				<p className="text-[12px] text-[var(--ink-3)] m-0">
					每轮收口分支与各修复分支各一行，命令只供复制、系统不代为执行（E-74）。
				</p>
			</div>

			{rows.length === 0 ? (
				<div
					data-testid="batch-landing-empty"
					className="rounded-[var(--r-sm,9px)] border border-[var(--border)] bg-[var(--bg)] p-4 font-mono text-[12px] text-[var(--ink-3)]"
				>
					该批还没有可落地的收口分支
				</div>
			) : (
				<ul className="flex flex-col gap-2 list-none m-0 p-0">
					{rows.map((row) => {
						const inHeadText =
							row.inHead === true ? '✓ 已进 HEAD' : row.inHead === false ? '未进 HEAD' : '—';
						const commandToken = `batch-landing:${row.id}`;
						const canCopy = Boolean(onCopyField);
						return (
							<li
								key={row.id}
								data-batch-landing-row={row.kind}
								data-round={row.round}
								data-run-id={row.runId ?? ''}
								data-in-head={
									row.inHead === true ? 'true' : row.inHead === false ? 'false' : 'null'
								}
								className="flex flex-col gap-2 rounded-[var(--r-sm,9px)] border border-[var(--border)] bg-[var(--bg)] p-3"
							>
								<div className="flex items-center gap-2 flex-wrap">
									<span className="font-ui text-[14px] font-semibold text-[var(--ink-1)]">
										{row.label}
									</span>
									<span
										data-field="batch-landing-in-head"
										className={
											row.inHead === true
												? 'font-mono text-[12px] text-[var(--auto)]'
												: 'font-mono text-[12px] text-[var(--ink-3)]'
										}
									>
										{inHeadText}
									</span>
								</div>

								<div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[12.5px]">
									<div data-field="batch-landing-branch" className="truncate text-[var(--ink-1)]">
										<span className="text-[var(--ink-3)] font-ui text-[12px]">分支 </span>
										{row.branchName ?? '—'}
									</div>
									<div data-field="batch-landing-worktree" className="truncate text-[var(--ink-2)]">
										<span className="text-[var(--ink-3)] font-ui text-[12px]">worktree </span>
										{row.worktreePath ?? '—'}
									</div>
									<div data-field="batch-landing-diff" className="truncate text-[var(--ink-2)]">
										<span className="text-[var(--ink-3)] font-ui text-[12px]">diff </span>
										{row.diffStat ?? '—'}
									</div>
								</div>

								<div className="flex items-center gap-2">
									<pre
										data-field="batch-landing-command"
										className="flex-1 m-0 rounded-[var(--r-sm,9px)] bg-[var(--panel-2)] border border-[var(--border)] p-2 font-mono text-[12.5px] text-[var(--ink-1)] overflow-x-auto select-all"
									>
										{row.command}
									</pre>
									<button
										type="button"
										data-copy-token={commandToken}
										disabled={!canCopy}
										onClick={() => {
											if (canCopy) {
												onCopyField?.(commandToken, row.command);
											}
										}}
										className={[
											'shrink-0 px-3 rounded-[var(--r-sm,9px)] border border-[var(--border-strong)] bg-[var(--panel-2)]',
											'font-mono text-[12px]',
											canCopy
												? 'text-[var(--ink-1)] hover:border-[var(--needs)] cursor-pointer'
												: 'text-[var(--stopped)] cursor-not-allowed opacity-80',
											'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--needs-soft)]',
											touchClass,
										].join(' ')}
									>
										{copiedToken === commandToken ? '✓ 已复制' : '复制命令'}
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

export default WrapupReport;
