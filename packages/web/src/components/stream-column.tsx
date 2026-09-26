/**
 * packages/web/src/components/stream-column.tsx
 *
 * 多流监看泳道外壳组件（M9-T9 / AC 1, AC 4, AC 5, AC 6, AC 12, E-106, E-165, E-166, E-236, E-237, E-311, E-317）
 * 收口泳道分支（M9-T20 / AC 1, E-297, E-106）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 泳道外壳采用五段网格：[head][refBar][body][afterBody][foot]（AC 12）
 * - 停止控件、参照条、审批槽位与运行轨槽位必须渲染在所有档位与 kind 分支之外（AC 5, E-236, E-106, E-297）：
 *   `kind` 只允许影响头部文案，绝不参与任何控件的存在性判定
 * - narrow 档停止键仍常驻可见，禁止 hover 显示或收进 ⋯（AC 6, E-237）
 * - 状态徽标为矩形非药丸，字形 + 文字，禁止降级成纯色点（AC 4, E-166, E-110）
 * - 紧凑档列宽 min 260px；展开某条时该条占满全宽（col-span-full），其余保持 260px 留在同屏绝不折叠消失（AC 3, E-165）
 * - 停止键不是红的（红留给拒绝/删除），保持原位与边框，仅淡化文字（11 节）
 * - `kind='wrapup'` 的运行没有 task_id，头部写「批次收口 · 第 N 轮 · 第 M 批」，N/M 缺失显示「—」（E-297）
 * - 纯展示层组件：纯 props in / callback out，禁止 import api/store/features/shell，禁止内部 useEffect（07 节）
 * - 界面不含业务判定：只呈现上层下发字段，缺失一律显示 '—'（07 节）
 */

import type { EffortTier, EffortValue } from '@agent-scheduler/shared/api/agents';
import type {
	AssignmentResolutionSource,
	RunDto,
	RunPermissionTier,
} from '@agent-scheduler/shared/api/runs';
import {
	type HTMLAttributes,
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	useCallback,
} from 'react';
import type { DensityTier } from '../hooks/use-breakpoint.ts';
import { type StatusState, normalizeStatusState } from '../lib/spine-shape.ts';
import { StatusBadge } from './status-badge.tsx';
import { StreamHeadMeta } from './stream-head-meta.tsx';

/**
 * 泳道类型（E-297）：`task` 任务流水线、`wrapup` 批次收口运行、`idle` 空闲泳道。
 * 只影响头部文案，绝不影响停止控件 / 参照条 / 审批槽位 / 运行轨槽位的存在性（E-236）。
 */
export type StreamColumnKind = 'task' | 'wrapup' | 'idle';

/**
 * 泳道外壳组件属性。
 */
export interface StreamColumnProps extends Omit<HTMLAttributes<HTMLElement>, 'id' | 'title'> {
	/** 泳道序号（1-based 整数，与 lanes[].laneNo 对齐，AC 12） */
	readonly laneNo: number;
	/** 泳道类型（默认 task；只影响头部文案，AC 1, E-297） */
	readonly kind?: StreamColumnKind;
	/** 泳道 ID（可选，由 daemon 下发） */
	readonly laneId?: string;
	/** 当前运行 ID（指向当前阶段运行，E-311） */
	readonly currentRunId?: string | null;
	/** 任务标识符（如 M9-T9） */
	readonly taskKey?: string;
	/** 任务标题 */
	readonly title?: string;
	/** 收口轮次（kind='wrapup' 时头部用，缺失显示「—」，E-297） */
	readonly wrapupRound?: number | null;
	/** 收口所属批次序号（kind='wrapup' 时头部用，缺失显示「—」，E-297） */
	readonly wrapupBatchNo?: number | null;
	/** 运行状态（九个标准状态或扩展状态；缺失一律降级为「未识别」，禁止用前端默认值补齐） */
	readonly status?: StatusState | string;
	/** 密度档位（由 useDensityTier() 单点计算下传，AC 1, E-235） */
	readonly tier?: DensityTier;
	/** 是否在紧凑档展开（占满宽度，AC 3, E-165） */
	readonly isExpanded?: boolean;
	/** 切换展开状态回调 */
	readonly onToggleExpand?: () => void;
	/** 停止按钮点击回调 */
	readonly onStop?: () => void;
	/** 是否处于停止中（乐观呈现态，11 节） */
	readonly isStopping?: boolean;
	/** 是否允许停止（默认 true） */
	readonly canStop?: boolean;
	/** 停止按钮文案（默认「停止」） */
	readonly stopLabel?: string;
	/** Agent 身份双字符缩写（中性 chip，禁止厂商品牌色，11 节） */
	readonly agentMonogram?: string;
	/** Agent 名称 */
	readonly agentName?: string;
	/** 模型名称 */
	readonly modelName?: string;
	/** 耗时（毫秒数值或已格式化字符串，无数据返回 '—'） */
	readonly duration?: number | string | null;
	/** Token 消耗显示（无数据返回 '—' 禁止返回 0） */
	readonly tokenCount?: number | string | null;
	/** 费用收据（文本或数值，无数据返回 '—'） */
	readonly cost?: string | number | null;
	/** 错误信息文案 */
	readonly errorMessage?: string;
	/** 是否超出并行窗口限制（AC 7, E-309，头部展示「超出窗口数」chip） */
	readonly overLimit?: boolean;
	/** 空闲提示文本（AC 7, E-319） */
	readonly idleText?: string;
	/** 是否为粗指针触控环境（增大命中区至 44px，E-239） */
	readonly isTouch?: boolean;
	/** 插槽：头部扩展 */
	readonly headSlot?: ReactNode;
	/** 插槽：参照条扩展 */
	readonly refBarSlot?: ReactNode;
	/** 插槽：主内容区（阶段链 / 运行条目，由 M9-T21 填充，AC 12） */
	readonly bodySlot?: ReactNode;
	/** 插槽：主内容区 children 别名 */
	readonly children?: ReactNode;
	/**
	 * 插槽：运行轨列（贯穿全高的 2px 竖线，11 节）。
	 * 与 kind / densityTier 无关地常驻渲染，`kind='wrapup'` 的收口泳道与实施流共用同一条轨（E-297, E-236）。
	 */
	readonly spineSlot?: ReactNode;
	/** 插槽：就地审批卡 / 闸门卡（必须常驻渲染在所有档位分支之外，AC 5, E-236） */
	readonly gateSlot?: ReactNode;
	/** 插槽：审批卡别名 */
	readonly approvalSlot?: ReactNode;
	/** 插槽：body 之后扩展槽位 */
	readonly afterBodySlot?: ReactNode;
	/** 插槽：底栏收据扩展 */
	readonly footSlot?: ReactNode;

	/** 当前运行 DTO（供 StreamHeadMeta 渲染四段参照条，M9-T17） */
	readonly run?: Partial<RunDto> | null;
	/** 会话序号（E-31） */
	readonly sessionNo?: number | null;
	/** 自报模型名称（E-37） */
	readonly reportedModel?: string | null;
	/** 思考强度复合值（EffortValue，M4-T14） */
	readonly effort?: EffortValue;
	/** 思考强度三档抽象（'low' | 'medium' | 'high'） */
	readonly effortTier?: EffortTier | null;
	/** 思考强度厂商原值 */
	readonly effortVendor?: string | null;
	/** 自报思考强度（E-256） */
	readonly reportedEffort?: string | null;
	/** 权限档位（'readOnly' | 'workspaceWrite' | 'unrestricted'，E-136） */
	readonly permissionTier?: RunPermissionTier | string | null;
	/** 来源类别（'task' | 'review_override' | 'wrapup_settings' | 'agent_default'，E-357） */
	readonly assignmentSource?: AssignmentResolutionSource | string | null;
	/** 跟随的任务标识（E-357） */
	readonly followedTaskId?: string | null;
}

/**
 * 泳道外壳组件（StreamColumn）。
 */
export function StreamColumn(props: StreamColumnProps) {
	const {
		laneNo,
		kind = 'task',
		laneId,
		currentRunId,
		taskKey,
		title,
		wrapupRound,
		wrapupBatchNo,
		status,
		tier = 'full',
		isExpanded = false,
		onToggleExpand,
		onStop,
		isStopping = false,
		canStop = true,
		stopLabel = '停止',
		agentMonogram,
		agentName,
		modelName,
		duration,
		tokenCount,
		cost,
		errorMessage,
		overLimit = false,
		idleText,
		isTouch = false,
		headSlot,
		refBarSlot,
		bodySlot,
		children,
		spineSlot,
		gateSlot,
		approvalSlot,
		afterBodySlot,
		footSlot,
		className,
		run,
		sessionNo,
		reportedModel,
		effort,
		effortTier,
		effortVendor,
		reportedEffort,
		permissionTier,
		assignmentSource,
		followedTaskId,
		...rest
	} = props;

	const normalizedStatus = normalizeStatusState(status);

	const handleStopClick = useCallback(
		(e: MouseEvent<HTMLButtonElement>) => {
			e.stopPropagation();
			if (!canStop || isStopping) {
				return;
			}
			onStop?.();
		},
		[canStop, isStopping, onStop],
	);

	const handleToggleExpandClick = useCallback(
		(e: MouseEvent<HTMLButtonElement>) => {
			e.stopPropagation();
			onToggleExpand?.();
		},
		[onToggleExpand],
	);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLElement>) => {
			if (e.key === 'Escape' && isExpanded && onToggleExpand) {
				e.stopPropagation();
				onToggleExpand();
			}
		},
		[isExpanded, onToggleExpand],
	);

	// 格式化呈现
	const displayTaskKey = taskKey && taskKey.trim().length > 0 ? taskKey.trim() : '—';
	const displayTitle = title && title.trim().length > 0 ? title.trim() : '—';
	const displayDuration = formatDurationMs(duration);
	const displayTokens = formatTokenCount(tokenCount);
	const displayCost = formatCost(cost);
	const resolvedCanStop = kind === 'idle' ? false : canStop;
	const displayMonogram = formatMonogram(agentMonogram, agentName);

	// 收口泳道头部（E-297）：第 N 轮 / 第 M 批缺失一律显示「—」，不用前端逻辑补齐
	const displayWrapupRound = formatOrdinal(wrapupRound);
	const displayWrapupBatchNo = formatOrdinal(wrapupBatchNo);

	// 按钮高度（桌面 32px，触屏 44px）
	const buttonHeightClass = isTouch ? 'h-[44px] min-w-[44px]' : 'h-[32px]';

	// 审批槽位内容（AC 5, E-236: 审批槽位必须常驻渲染在所有档位分支之外）
	const activeApprovalContent = gateSlot ?? approvalSlot ?? afterBodySlot ?? null;

	return (
		<article
			data-stream-column="true"
			data-kind={kind}
			data-lane-no={laneNo}
			data-lane-id={laneId ?? `lane-${laneNo}`}
			data-tier={tier}
			data-expanded={isExpanded ? 'true' : 'false'}
			data-status={normalizedStatus}
			onKeyDown={handleKeyDown}
			className={[
				// 五段网格布局：[head][refBar][body][afterBody][foot]（AC 12）
				'group relative flex flex-col grid-rows-[auto_auto_1fr_auto_auto]',
				'h-full rounded-[14px] border border-[var(--border)] bg-[var(--bg)]',
				'transition-shadow duration-180 overflow-hidden',
				// 键盘焦点内嵌环
				'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]',
				// 紧凑档展开某条时占满宽度（AC 3, E-165）
				isExpanded ? 'col-span-full shadow-lg ring-1 ring-[var(--border-strong)]' : '',
				// 各档位基础尺寸约束（AC 2, AC 4, E-164, E-166）
				tier === 'compact' ? 'min-w-[var(--stream-min-dense,260px)] flex-1' : '',
				tier === 'full'
					? 'min-w-[var(--stream-min,320px)] max-w-[var(--stream-max,460px)] flex-1'
					: '',
				tier === 'narrow' ? 'w-full' : '',
				tier === 'phone' || tier === 'phone-xs' ? 'w-full' : '',
				className ?? '',
			].join(' ')}
			{...rest}
		>
			{/* ─────────────────────────────────────────────────────────────
			    第 1 段：[head] 头部与常驻停止控件（AC 5, AC 6, AC 12, E-106, E-236, E-237, E-297）
			    kind 只在这里分支头部文案，禁止参与任何控件的存在性判定（E-236）
			    ───────────────────────────────────────────────────────────── */}
			<header
				data-segment="head"
				className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--border)] min-h-[40px] select-none bg-[var(--bg)]"
			>
				{/* 左侧：泳道号、任务标识、标题 */}
				<div className="flex items-center gap-2 min-w-0 flex-1">
					<span
						data-lane-badge="true"
						className="font-mono text-[11px] px-1.5 py-0.5 rounded-[4px] bg-[var(--panel-2)] text-[var(--ink-2)] border border-[var(--border)] flex-shrink-0"
					>
						泳道 {laneNo}
					</span>

					{/* kind 分支只换头部文案（E-297, E-236） */}
					{kind === 'wrapup' ? (
						<span
							data-field="wrapup-head"
							data-wrapup-round={wrapupRound ?? ''}
							data-wrapup-batch-no={wrapupBatchNo ?? ''}
							title={`批次收口 · 第 ${displayWrapupRound} 轮 · 第 ${displayWrapupBatchNo} 批`}
							className="font-ui text-[13px] font-semibold text-[var(--ink-1)] truncate"
						>
							批次收口 · 第 {displayWrapupRound} 轮 · 第 {displayWrapupBatchNo} 批
						</span>
					) : kind === 'idle' ? (
						<span
							data-field="idle-head"
							className="font-ui text-[13px] text-[var(--ink-2)] truncate"
						>
							空闲
						</span>
					) : (
						<>
							<span
								data-field="task-key"
								className="font-mono text-[13px] font-semibold text-[var(--ink-1)] tracking-tight flex-shrink-0"
							>
								{displayTaskKey}
							</span>
							<span
								data-field="task-title"
								title={displayTitle}
								className="font-ui text-[13px] text-[var(--ink-2)] truncate max-w-[160px]"
							>
								{displayTitle}
							</span>
						</>
					)}
					{overLimit && (
						<span
							data-chip="over-limit"
							className="px-1.5 py-0.5 rounded-[4px] bg-[var(--panel-2)] text-[var(--warn)] border border-[var(--border)] font-ui text-[11px] font-medium flex-shrink-0"
						>
							超出窗口数
						</span>
					)}
					{headSlot}
				</div>

				{/* 右侧：状态徽标、紧凑档展开切换、停止控件 */}
				<div className="flex items-center gap-2 flex-shrink-0">
					{/* 状态徽标：字形 + 文字，严禁降级成纯色点（AC 4, E-166, E-110） */}
					<StatusBadge
						state={normalizedStatus}
						className="flex-shrink-0"
						data-status-badge="true"
					/>

					{/* 紧凑档展开/收起切换按钮（AC 3, E-165） */}
					{tier === 'compact' && onToggleExpand && (
						<button
							type="button"
							data-action="toggle-expand"
							onClick={handleToggleExpandClick}
							title={isExpanded ? '收起此泳道' : '展开此泳道'}
							className={`
								inline-flex items-center justify-center px-2 rounded-[6px]
								font-ui text-[11px] text-[var(--ink-2)] bg-[var(--panel-2)]
								border border-[var(--border)] hover:text-[var(--ink-1)]
								focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--needs-soft)]
								cursor-pointer ${buttonHeightClass}
							`}
						>
							{isExpanded ? '收起' : '展开'}
						</button>
					)}

					{/* 停止控件：必须渲染在所有档位与 kind 分支之外，绝不收进 ⋯，绝不 hover 隐藏（AC 5, AC 6, E-106, E-236, E-237） */}
					<button
						type="button"
						data-action="stop-stream"
						data-resident="true"
						onClick={handleStopClick}
						disabled={!resolvedCanStop || isStopping}
						aria-label={`停止泳道 ${laneNo}`}
						className={`
							inline-flex items-center justify-center gap-1.5 px-3 rounded-[9px]
							font-ui text-[12px] font-medium transition-colors
							border border-[var(--border-strong)]
							focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--needs-soft)]
							hover:brightness-105 active:brightness-95 select-none
							${buttonHeightClass}
							${
								!resolvedCanStop || isStopping
									? 'bg-[var(--panel-2)] text-[var(--stopped)] cursor-not-allowed opacity-80'
									: 'bg-[var(--panel-2)] text-[var(--ink-1)] cursor-pointer'
							}
						`}
					>
						{/* 停止方块图标：中性色方块，非红（11 节） */}
						<span
							data-glyph="stop-square"
							className="inline-block w-2.5 h-2.5 bg-current rounded-[1px] flex-shrink-0"
							aria-hidden="true"
						/>
						<span>{isStopping ? '停止中...' : stopLabel}</span>
					</button>
				</div>
			</header>

			{/* ─────────────────────────────────────────────────────────────
			    第 2 段：[refBar] 参照条（AC 12, M9-T17 四段参照条与会话序号）
			    ───────────────────────────────────────────────────────────── */}
			<div
				data-segment="refBar"
				className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] font-mono text-[var(--ink-3)] border-b border-[var(--border)] bg-[var(--page)] select-none"
			>
				<StreamHeadMeta
					run={run}
					modelName={modelName !== undefined ? modelName : (run?.modelName ?? null)}
					reportedModel={reportedModel !== undefined ? reportedModel : (run?.reportedModel ?? null)}
					effort={effort !== undefined ? effort : (run?.effort ?? undefined)}
					effortTier={effortTier !== undefined ? effortTier : (run?.effortTier ?? null)}
					effortVendor={effortVendor !== undefined ? effortVendor : (run?.effortVendor ?? null)}
					reportedEffort={
						reportedEffort !== undefined ? reportedEffort : (run?.reportedEffort ?? null)
					}
					permissionTier={
						permissionTier !== undefined ? permissionTier : (run?.permissionTier ?? null)
					}
					assignmentSource={
						assignmentSource !== undefined ? assignmentSource : (run?.assignmentSource ?? null)
					}
					followedTaskId={
						followedTaskId !== undefined ? followedTaskId : (run?.followedTaskId ?? null)
					}
					sessionNo={sessionNo !== undefined ? sessionNo : (run?.sessionNo ?? null)}
					agentMonogram={displayMonogram}
					includeMonogram={true}
					tier={tier}
					className="min-w-0 flex-1"
					slot={refBarSlot}
				/>
			</div>

			{/* ─────────────────────────────────────────────────────────────
			    第 3 段：[body] 主内容槽位（AC 12，阶段链由 M9-T21 填充）
			    轨列与 kind / densityTier 无关地常驻：收口泳道与实施流共用同一条运行轨（E-297, E-236）
			    ───────────────────────────────────────────────────────────── */}
			<div data-segment="body" className="flex flex-1 min-h-0 overflow-hidden">
				{spineSlot !== undefined && (
					<div
						data-slot="spine"
						data-resident-slot="true"
						className="relative w-[20px] min-w-[20px] shrink-0"
					>
						{spineSlot}
					</div>
				)}
				<div className="flex-1 overflow-y-auto min-h-0 relative p-3 text-[13px] font-ui">
					{bodySlot ??
						children ??
						(idleText ? (
							<div
								data-slot="idle-text"
								className="flex items-center justify-center h-full min-h-[120px] text-[13px] text-[var(--ink-3)] font-ui select-none text-center px-4"
							>
								{idleText}
							</div>
						) : (
							<div
								data-slot="stage-placeholder"
								className="flex items-center justify-center h-full min-h-[120px] text-[12px] text-[var(--ink-3)] font-mono select-none"
							>
								— 等待阶段分配 —
							</div>
						))}
				</div>
			</div>

			{/* ─────────────────────────────────────────────────────────────
			    第 4 段：[afterBody] 审批槽位（AC 5, AC 12, E-236，必须常驻渲染）
			    ───────────────────────────────────────────────────────────── */}
			<div data-segment="afterBody" className="border-t border-[var(--border)] bg-[var(--bg)]">
				{/* 审批槽位：必须渲染在所有档位分支之外（AC 5, E-236） */}
				<div
					data-slot="approval"
					data-resident-slot="true"
					className={activeApprovalContent ? 'p-3' : 'empty:hidden'}
				>
					{activeApprovalContent}
				</div>
			</div>

			{/* ─────────────────────────────────────────────────────────────
			    第 5 段：[foot] 底部收据与度量（AC 12）
			    ───────────────────────────────────────────────────────────── */}
			<footer
				data-segment="foot"
				className="flex items-center justify-between gap-3 px-3 py-2 border-t border-[var(--border)] text-[12px] font-mono text-[var(--ink-3)] bg-[var(--bg)] min-h-[36px] select-none"
			>
				<div className="flex items-center gap-3 truncate">
					<span data-receipt="duration">耗时: {displayDuration}</span>
					<span data-receipt="tokens">Tokens: {displayTokens}</span>
					<span data-receipt="cost">费用: {displayCost}</span>
					{footSlot}
				</div>

				{errorMessage && (
					<div
						data-segment-error="true"
						className="text-[11px] font-ui text-[var(--down)] truncate max-w-[180px]"
						title={errorMessage}
					>
						{errorMessage}
					</div>
				)}
			</footer>
		</article>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 私有辅助纯函数（就近位于组件文件底部，07 节约定）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 格式化耗时（毫秒数值或已格式化文本；无数据返回 '—'，禁止返回 0）。
 */
function formatDurationMs(raw: number | string | null | undefined): string {
	if (raw === null || raw === undefined) {
		return '—';
	}
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : '—';
	}
	if (!Number.isFinite(raw) || raw <= 0) {
		return '—';
	}
	if (raw < 1000) {
		return `${Math.round(raw)}ms`;
	}
	if (raw < 60000) {
		return `${(raw / 1000).toFixed(1)}s`;
	}
	const minutes = Math.floor(raw / 60000);
	const seconds = Math.round((raw % 60000) / 1000);
	return `${minutes}m ${seconds}s`;
}

/**
 * 格式化 Token 计数（07 节：format-token-count 无数据返回 '—' 禁止返回 0）。
 */
function formatTokenCount(raw: number | string | null | undefined): string {
	if (raw === null || raw === undefined) {
		return '—';
	}
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : '—';
	}
	if (!Number.isFinite(raw) || raw <= 0) {
		return '—';
	}
	if (raw < 1000) {
		return String(Math.round(raw));
	}
	if (raw < 1000000) {
		return `${(raw / 1000).toFixed(1)}k`;
	}
	return `${(raw / 1000000).toFixed(2)}M`;
}

/**
 * 格式化费用显示（无数据返回 '—'）。
 */
function formatCost(raw: number | string | null | undefined): string {
	if (raw === null || raw === undefined) {
		return '—';
	}
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : '—';
	}
	if (!Number.isFinite(raw) || raw <= 0) {
		return '—';
	}
	return `$${raw.toFixed(3)}`;
}

/**
 * 派生 Agent 双字符字母组（monogram，11 节约定）。
 */
function formatMonogram(override?: string, name?: string): string {
	if (override && override.trim().length >= 2) {
		return override.trim().slice(0, 2).toUpperCase();
	}
	if (!name || name.trim().length === 0) {
		return 'AG';
	}
	const clean = name.trim();
	if (clean.length >= 2) {
		return clean.slice(0, 2).toUpperCase();
	}
	return (clean + clean).toUpperCase();
}

/**
 * 收口头部用的序号呈现（E-297）：daemon 没给 N / M 时显示「—」，绝不用前端序号补齐。
 */
function formatOrdinal(raw: number | null | undefined): string {
	if (raw === null || raw === undefined || !Number.isFinite(raw)) {
		return '—';
	}
	return String(raw);
}
