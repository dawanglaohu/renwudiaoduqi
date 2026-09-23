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
import type { HTMLAttributes, MouseEvent, ReactNode } from 'react';
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
// 批次收口控件（挂在批次标题下：按钮 + 具名拒绝原因）
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

export interface BatchWrapupControlProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
	/** daemon 下发的能否收口（缺失一律按不可收口处理，不用前端逻辑补齐） */
	readonly canWrapup?: boolean;
	/** 是否手机档（手机端不出「收口」按钮，E-297） */
	readonly isPhoneTier?: boolean;
	/** 请求是否在途 / 已接受待回流事件（在途禁用，E-157） */
	readonly isPending?: boolean;
	/** 上次收口被拒的具名原因 */
	readonly failure?: BatchWrapupFailureView | null;
	/** 点击「收口」回调（发起 POST，不在本组件里改任何状态） */
	readonly onWrapup?: () => void;
	/** 粗指针触控环境 */
	readonly isTouch?: boolean;
	/** 按钮文案（默认「收口」） */
	readonly wrapupLabel?: string;
	/** 在途文案（默认「收口中…」） */
	readonly pendingLabel?: string;
	/** 附加说明（如批次号） */
	readonly children?: ReactNode;
}

/**
 * 批次收口控件：按钮只在 canWrapup 且非手机档渲染；请求在途禁用；
 * 具名拒绝原因贴在该批标题下（`data-placement="under-batch-title"`）。最终状态等 `batch.wrapup_started`。
 */
export function BatchWrapupControl(props: BatchWrapupControlProps) {
	const {
		canWrapup = false,
		isPhoneTier = false,
		isPending = false,
		failure = null,
		onWrapup,
		isTouch = false,
		wrapupLabel = '收口',
		pendingLabel = '收口中…',
		children,
		className,
		...rest
	} = props;

	const showButton = Boolean(canWrapup) && !isPhoneTier;

	if (!showButton && !failure) {
		return null;
	}

	const touchClass = isTouch ? 'min-h-[var(--h-btn-lg,44px)]' : 'h-[var(--h-btn,32px)]';

	return (
		<div
			data-region="batch-wrapup"
			data-placement="under-batch-title"
			data-can-wrapup={canWrapup ? 'true' : 'false'}
			data-phone-tier={isPhoneTier ? 'true' : 'false'}
			className={['flex flex-col gap-1.5', className ?? ''].join(' ').trim()}
			{...rest}
		>
			{showButton && (
				<div className="flex items-center gap-2">
					{children}
					<button
						type="button"
						data-action="wrapup-batch"
						data-pending={isPending ? 'true' : 'false'}
						disabled={isPending}
						title={
							isPending ? '收口请求已接受，等待 batch.wrapup_started 回流' : '对本批发起一轮收口'
						}
						onClick={() => {
							if (!isPending) {
								onWrapup?.();
							}
						}}
						className={[
							'inline-flex items-center justify-center ml-auto px-2.5 rounded-[var(--r-sm,9px)]',
							'border border-[var(--border)] bg-[var(--panel-2)] font-ui text-[12px] font-medium',
							isPending
								? 'text-[var(--stopped)] cursor-not-allowed opacity-80'
								: 'text-[var(--ink-1)] cursor-pointer hover:border-[var(--border-strong)]',
							'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--needs-soft)]',
							touchClass,
						].join(' ')}
					>
						{isPending ? pendingLabel : wrapupLabel}
					</button>
				</div>
			)}

			{failure && (
				<div
					data-region="batch-wrapup-failure"
					data-failure-reason={failure.reason ?? 'unknown'}
					className="flex flex-col gap-1 rounded-[var(--r-sm,9px)] border border-[var(--down)] bg-[var(--down-soft)] px-2 py-1.5 font-ui text-[12px] text-[var(--down)]"
				>
					<span data-field="wrapup-failure-message">{failure.message}</span>
					{failure.technical && (
						<details className="text-[11px] text-[var(--ink-3)]">
							<summary className="cursor-pointer hover:text-[var(--ink-2)]">技术详情</summary>
							<div className="font-mono break-all">{failure.technical}</div>
						</details>
					)}
				</div>
			)}
		</div>
	);
}

export default WrapupReport;
