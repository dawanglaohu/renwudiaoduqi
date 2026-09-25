/**
 * packages/web/src/components/stream-head-meta.tsx
 *
 * 流头部参照条与会话序号组件（M9-T17 / AC 1..5, E-136, E-254, E-256, E-31, E-347, E-357, E-37 / 07 节前端架构）
 *
 * 规范依据：
 * - 纯展示组件（components 纯 props in / callback out），禁止 import api/store/features/shell（07 节）
 * - 每条流头部之下常驻一条「模型 · 思考强度 · 权限档 · 来源」参照条，回答四问中的「它凭什么这么干」，不可折叠（AC 1）
 * - 四段网格：`auto auto auto minmax(0,1fr)`，第四段可截断、前三段不截断（AC 1）
 * - 第四段读 RunDto.assignmentSource / followedTaskId，前端不读快照不算取值链（AC 1, E-347, E-357）
 *   - task → 「来源：任务指派」
 *   - review_override → 「来源：审查覆盖」
 *   - wrapup_settings → 「来源：收口设置（跟随 〈taskKey〉）」，无 taskKey 显示「来源：收口设置（跟随任务未记录）」
 *   - agent_default → 「来源：任务指派（agent 默认）」括注可见，title 说明「按 agent 当前生效默认运行」
 *   - 四值之外或缺失 → 「来源：—」并把原始值放 title
 *   - compact / narrow 档用短文案「任务／审查／收口」（E-357）
 * - RunDto.effort 为 {vendor} 时第二段显示原串并 title「厂商原值，未映射到三档」（AC 1）
 * - 思考强度不支持的 agent 显示「—」并在 title 说明原因，不补默认档冒充（AC 2, E-254）
 * - 自报值与所选不一致时两者都显示并转 --needs，模型与思考强度同规则（AC 3, E-37, E-256）
 * - 权限档为最高档（unrestricted）时该段转 --down 且持续显示，不是一次性提示（AC 4, E-136）
 * - 同一 agent 的多个并发会话在 monogram 右下角带中性会话序号角标，序号不占色相（AC 5, E-31, 决策 33）
 */

import type { EffortTier, EffortValue } from '@agent-scheduler/shared/api/agents';
import type {
	AssignmentResolutionSource,
	RunDto,
	RunPermissionTier,
} from '@agent-scheduler/shared/api/runs';
import type { HTMLAttributes, ReactNode } from 'react';
import type { DensityTier } from '../hooks/use-breakpoint.ts';
import { UI_STRINGS } from '../i18n/ui-strings.ts';

// ─────────────────────────────────────────────────────────────
// AgentMonogram：带有中性会话序号角标的双字符字母组组件（AC 5, E-31, 决策 33）
// ─────────────────────────────────────────────────────────────

export interface AgentMonogramProps extends HTMLAttributes<HTMLSpanElement> {
	/** 双字符字母组（例如 CX、GK、PI） */
	readonly monogram: string;
	/** 会话序号（同一 agent 独立并发会话，E-31，决策 33） */
	readonly sessionNo?: number | null;
	/** 外部自定义类名 */
	readonly className?: string;
	/** 自定义悬停提示 */
	readonly title?: string;
}

/**
 * 带有中性会话序号角标的 Agent Monogram Chip。
 * 序号不占色相——它是身份的一部分不是状态（决策 33）。
 */
export function AgentMonogram({
	monogram,
	sessionNo,
	className,
	title,
	...rest
}: AgentMonogramProps) {
	const hasSession = sessionNo !== null && sessionNo !== undefined;
	const computedTitle =
		title ??
		(hasSession ? `${monogram}（${UI_STRINGS.refBar.sessionOrdinalTitle(sessionNo)}）` : monogram);

	return (
		<span
			data-agent-monogram="true"
			title={computedTitle}
			className={[
				'relative inline-flex items-center justify-center flex-shrink-0 select-none',
				className ?? '',
			].join(' ')}
			{...rest}
		>
			{/* 双字符中性 chip，禁止厂商品牌色（11 节） */}
			<span className="px-1.5 py-0.5 rounded-[4px] bg-[var(--panel-2)] text-[var(--ink-1)] border border-[var(--border)] font-mono font-bold text-[10px] tracking-wider">
				{monogram}
			</span>

			{/* 中性会话序号角标：右下角常驻，不占色相（AC 5, E-31, 决策 33） */}
			{hasSession && (
				<span
					data-session-ordinal={sessionNo}
					className="absolute -bottom-1 -right-1 px-1 min-w-[12px] h-[12px] flex items-center justify-center rounded-[3px] bg-[var(--bg)] text-[var(--ink-2)] border border-[var(--border-strong)] font-mono text-[8.5px] font-semibold leading-none pointer-events-none select-none"
					title={UI_STRINGS.refBar.sessionOrdinalTitle(sessionNo)}
				>
					{sessionNo}
				</span>
			)}
		</span>
	);
}

// ─────────────────────────────────────────────────────────────
// StreamHeadMeta：流头部常驻参照条（AC 1..4）
// ─────────────────────────────────────────────────────────────

export interface StreamHeadMetaProps extends Omit<HTMLAttributes<HTMLDivElement>, 'slot'> {
	/** 运行 DTO（可选，若提供则作为各字段默认值） */
	readonly run?: Partial<RunDto> | null;
	/** 所选模型名称 */
	readonly modelName?: string | null;
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
	/** 会话序号（E-31） */
	readonly sessionNo?: number | null;
	/** Agent 双字符 monogram */
	readonly agentMonogram?: string | null;
	/** 是否在参照条左侧内联呈现 AgentMonogram */
	readonly includeMonogram?: boolean;
	/** 密度档位（compact / narrow 使用短文案，E-357） */
	readonly tier?: DensityTier;
	/** 外部自定义类名 */
	readonly className?: string;
	/** 参照条尾部自定义插槽 */
	readonly slot?: ReactNode;
	readonly tailSlot?: ReactNode;
}

interface MetaItem {
	readonly text: string;
	readonly title: string;
	readonly isMismatch?: boolean;
	readonly isElevated?: boolean;
	readonly isVendor?: boolean;
	readonly isSupported?: boolean;
}

/**
 * 规整化自报思考强度标签为展示文本。
 */
function normalizeReportedEffort(raw: string): string {
	const trimmed = raw.trim().toLowerCase();
	if (trimmed === 'low' || trimmed === 'minimal' || raw === '低') {
		return UI_STRINGS.refBar.effortTiers.low;
	}
	if (trimmed === 'medium' || raw === '中') {
		return UI_STRINGS.refBar.effortTiers.medium;
	}
	if (trimmed === 'high' || raw === '高') {
		return UI_STRINGS.refBar.effortTiers.high;
	}
	return raw;
}

/**
 * 解析思考强度段展示属性（AC 1, AC 2, AC 3, E-254, E-256）。
 */
function resolveEffortMeta(
	effort: EffortValue | undefined,
	effortTier: EffortTier | null | undefined,
	effortVendor: string | null | undefined,
	reportedEffort: string | null | undefined,
): MetaItem {
	let selectedText: string | null = null;
	let selectedTitle: string | null = null;
	let isVendor = false;
	let isSupported = true;

	// 1. 优先解析 EffortValue 对象
	if (effort !== undefined && effort !== null) {
		if ('vendor' in effort && effort.vendor) {
			selectedText = effort.vendor;
			selectedTitle = UI_STRINGS.refBar.vendorEffortTitle;
			isVendor = true;
		} else if ('tier' in effort && effort.tier) {
			const tierLabel = UI_STRINGS.refBar.effortTiers[effort.tier] ?? effort.tier;
			selectedText = tierLabel;
			selectedTitle = `思考强度: ${tierLabel}`;
		}
	}

	// 2. 检查单独的 effortVendor
	if (!selectedText && effortVendor) {
		selectedText = effortVendor;
		selectedTitle = UI_STRINGS.refBar.vendorEffortTitle;
		isVendor = true;
	}

	// 3. 检查单独的 effortTier
	if (!selectedText && effortTier) {
		const tierLabel = UI_STRINGS.refBar.effortTiers[effortTier] ?? effortTier;
		selectedText = tierLabel;
		selectedTitle = `思考强度: ${tierLabel}`;
	}

	// 4. 思考强度不支持的 agent（E-254）：显示「—」并在 title 说明原因，不补默认档冒充
	if (!selectedText) {
		selectedText = UI_STRINGS.refBar.fallback;
		selectedTitle = UI_STRINGS.refBar.effortUnsupportedTitle;
		isSupported = false;
	}

	// 5. 自报思考强度比对（E-256）：自报值与所选不一致时两者都显示并转 --needs
	const hasReported = Boolean(reportedEffort && reportedEffort.trim() !== '');
	if (hasReported && reportedEffort) {
		const normalizedReported = normalizeReportedEffort(reportedEffort);
		// 判断是否不一致
		const isMismatch =
			!isSupported ||
			(selectedText !== UI_STRINGS.refBar.fallback && selectedText !== normalizedReported);

		if (isMismatch) {
			const combinedText = UI_STRINGS.refBar.formatMismatch(selectedText, normalizedReported);
			const mismatchTitle = `自报思考强度与所选不一致（所选: ${selectedText}，实际: ${normalizedReported}）`;
			return {
				text: combinedText,
				title: mismatchTitle,
				isMismatch: true,
				isVendor,
				isSupported,
			};
		}
	}

	return {
		text: selectedText,
		title: selectedTitle ?? `思考强度: ${selectedText}`,
		isMismatch: false,
		isVendor,
		isSupported,
	};
}

/**
 * 解析模型段展示属性（AC 1, AC 3, E-37）。
 */
function resolveModelMeta(
	modelName: string | null | undefined,
	reportedModel: string | null | undefined,
): MetaItem {
	const selected = modelName?.trim() || null;
	const reported = reportedModel?.trim() || null;

	const fallback = UI_STRINGS.refBar.fallback;
	if (reported && reported !== selected) {
		// 自报值与所选不一致：两者都显示并转 --needs（E-37）
		const selectedDisplay = selected ?? fallback;
		return {
			text: UI_STRINGS.refBar.formatMismatch(selectedDisplay, reported),
			title: `自报模型与所选不一致（所选: ${selectedDisplay}，实际: ${reported}）`,
			isMismatch: true,
		};
	}

	const displayText = selected ?? fallback;
	return {
		text: displayText,
		title: selected ? `模型: ${selected}` : fallback,
		isMismatch: false,
	};
}

/**
 * 解析权限档展示属性（AC 1, AC 4, E-136）。
 */
function resolvePermissionMeta(tier: string | null | undefined): MetaItem {
	if (tier === 'unrestricted') {
		// 最高档时该段转 --down 且持续显示，不是一次性提示（E-136）
		return {
			text: UI_STRINGS.refBar.permissionTiers.unrestricted,
			title: UI_STRINGS.refBar.unrestrictedWarningTitle,
			isElevated: true,
		};
	}

	if (tier === 'readOnly') {
		return {
			text: UI_STRINGS.refBar.permissionTiers.readOnly,
			title: `权限档: ${UI_STRINGS.refBar.permissionTiers.readOnly}`,
			isElevated: false,
		};
	}

	if (tier === 'workspaceWrite') {
		return {
			text: UI_STRINGS.refBar.permissionTiers.workspaceWrite,
			title: `权限档: ${UI_STRINGS.refBar.permissionTiers.workspaceWrite}`,
			isElevated: false,
		};
	}

	// 缺失或自定义值 fallback
	const fallbackText = tier ?? UI_STRINGS.refBar.permissionTiers.workspaceWrite;
	return {
		text: fallbackText,
		title: `权限档: ${fallbackText}`,
		isElevated: false,
	};
}

/**
 * 解析来源段展示属性（AC 1, E-347, E-357）。
 */
function resolveSourceMeta(
	source: string | null | undefined,
	followedTaskId: string | null | undefined,
	isShort: boolean,
): MetaItem {
	// task
	if (source === 'task') {
		return {
			text: isShort ? UI_STRINGS.refBar.sourceTaskShort : UI_STRINGS.refBar.sourceTask,
			title: UI_STRINGS.refBar.sourceTask,
		};
	}

	// review_override
	if (source === 'review_override') {
		return {
			text: isShort
				? UI_STRINGS.refBar.sourceReviewOverrideShort
				: UI_STRINGS.refBar.sourceReviewOverride,
			title: UI_STRINGS.refBar.sourceReviewOverride,
		};
	}

	// wrapup_settings
	if (source === 'wrapup_settings') {
		const hasFollowed = Boolean(followedTaskId && followedTaskId.trim() !== '');
		const text = isShort
			? UI_STRINGS.refBar.sourceWrapupSettingsShort(hasFollowed ? followedTaskId : null)
			: UI_STRINGS.refBar.sourceWrapupSettings(hasFollowed ? followedTaskId : null);
		const title = UI_STRINGS.refBar.sourceWrapupSettings(hasFollowed ? followedTaskId : null);
		return { text, title };
	}

	// agent_default：括注可见，title 说明「按 agent 当前生效默认运行」
	if (source === 'agent_default') {
		return {
			text: isShort
				? UI_STRINGS.refBar.sourceAgentDefaultShort
				: UI_STRINGS.refBar.sourceAgentDefault,
			title: UI_STRINGS.refBar.sourceAgentDefaultTitle,
		};
	}

	// 四值之外或缺失显示「来源：—」并把原始值放 title
	const rawTitle = source ? String(source) : UI_STRINGS.refBar.fallback;
	return {
		text: isShort ? UI_STRINGS.refBar.sourceFallbackShort : UI_STRINGS.refBar.sourceFallback,
		title: rawTitle,
	};
}

/**
 * 流头部参照条组件（StreamHeadMeta）。
 *
 * 每条流头部之下常驻一条「模型 · 思考强度 · 权限档 · 来源」参照条，
 * 网格 `auto auto auto minmax(0,1fr)`，第四段可截断、前三段不截断，不可折叠（AC 1）。
 */
export function StreamHeadMeta(props: StreamHeadMetaProps) {
	const {
		run,
		modelName,
		reportedModel,
		effort,
		effortTier,
		effortVendor,
		reportedEffort,
		permissionTier,
		assignmentSource,
		followedTaskId,
		sessionNo,
		agentMonogram,
		includeMonogram = false,
		tier,
		className,
		slot,
		tailSlot,
		...rest
	} = props;
	const effectiveSlot = slot ?? tailSlot;

	// 提取生效字段（props 优先于 run DTO）
	const effectiveModel = modelName !== undefined ? modelName : (run?.modelName ?? null);
	const effectiveReportedModel =
		reportedModel !== undefined ? reportedModel : (run?.reportedModel ?? null);

	const effectiveEffort = effort !== undefined ? effort : (run?.effort ?? undefined);
	const effectiveEffortTier =
		effortTier !== undefined ? effortTier : (run?.effortTier ?? undefined);
	const effectiveEffortVendor =
		effortVendor !== undefined ? effortVendor : (run?.effortVendor ?? undefined);
	const effectiveReportedEffort =
		reportedEffort !== undefined ? reportedEffort : (run?.reportedEffort ?? null);

	const effectivePermissionTier =
		permissionTier !== undefined ? permissionTier : (run?.permissionTier ?? 'workspaceWrite');

	const effectiveSource =
		assignmentSource !== undefined ? assignmentSource : (run?.assignmentSource ?? null);
	const effectiveFollowedTaskId =
		followedTaskId !== undefined ? followedTaskId : (run?.followedTaskId ?? null);

	const effectiveSessionNo = sessionNo !== undefined ? sessionNo : (run?.sessionNo ?? null);

	const isShort =
		tier === 'compact' || tier === 'narrow' || tier === 'phone' || tier === 'phone-xs';

	// 各段元数据解析
	const modelMeta = resolveModelMeta(effectiveModel, effectiveReportedModel);
	const effortMeta = resolveEffortMeta(
		effectiveEffort,
		effectiveEffortTier,
		effectiveEffortVendor,
		effectiveReportedEffort,
	);
	const permissionMeta = resolvePermissionMeta(effectivePermissionTier);
	const sourceMeta = resolveSourceMeta(effectiveSource, effectiveFollowedTaskId, isShort);

	const showMonogram = includeMonogram && Boolean(agentMonogram);

	return (
		<div
			data-component="stream-head-meta"
			data-resident="true"
			data-tier={tier ?? ''}
			className={['flex items-center gap-2 w-full select-none', className ?? ''].join(' ')}
			{...rest}
		>
			{/* 可选前置 Monogram（带中性会话序号角标，AC 5） */}
			{showMonogram && agentMonogram && (
				<AgentMonogram
					monogram={agentMonogram}
					sessionNo={effectiveSessionNo}
					className="flex-shrink-0"
				/>
			)}

			{/* ─────────────────────────────────────────────────────────────
			    四段常驻网格参照条（AC 1）：auto auto auto minmax(0,1fr)
			    前三段不截断，第四段可截断
			    ───────────────────────────────────────────────────────────── */}
			<div
				data-ref-bar="true"
				data-resident="true"
				className="grid grid-cols-[auto_auto_auto_minmax(0,1fr)] items-center gap-x-2 text-[11px] font-mono text-[var(--ink-2)] min-w-0 flex-1 leading-normal"
			>
				{/* 段 1：模型（不截断，自报不一致时显示两者并转 --needs，AC 1, AC 3, E-37） */}
				<div
					data-segment-cell="model"
					className="flex items-center gap-1.5 whitespace-nowrap flex-shrink-0"
				>
					<span
						data-field="model-name"
						title={modelMeta.title}
						data-mismatch={modelMeta.isMismatch ? 'model' : undefined}
						className={
							modelMeta.isMismatch ? 'text-[var(--needs)] font-medium' : 'text-[var(--ink-2)]'
						}
					>
						{modelMeta.text}
					</span>
					<span className="text-[var(--ink-3)] select-none opacity-60" aria-hidden="true">
						·
					</span>
				</div>

				{/* 段 2：思考强度（不截断，vendor 显示原串，不支持显示 —，自报不一致两者都显示并转 --needs，AC 1, AC 2, AC 3, E-254, E-256） */}
				<div
					data-segment-cell="effort"
					className="flex items-center gap-1.5 whitespace-nowrap flex-shrink-0"
				>
					<span
						data-field="effort"
						title={effortMeta.title}
						data-mismatch={effortMeta.isMismatch ? 'effort' : undefined}
						data-vendor={effortMeta.isVendor ? 'true' : undefined}
						data-unsupported={!effortMeta.isSupported ? 'true' : undefined}
						className={
							effortMeta.isMismatch ? 'text-[var(--needs)] font-medium' : 'text-[var(--ink-2)]'
						}
					>
						{effortMeta.text}
					</span>
					<span className="text-[var(--ink-3)] select-none opacity-60" aria-hidden="true">
						·
					</span>
				</div>

				{/* 段 3：权限档（不截断，最高档转 --down 持续显示，AC 1, AC 4, E-136） */}
				<div
					data-segment-cell="permission"
					className="flex items-center gap-1.5 whitespace-nowrap flex-shrink-0"
				>
					<span
						data-field="permission-tier"
						title={permissionMeta.title}
						data-elevated={permissionMeta.isElevated ? 'true' : undefined}
						className={
							permissionMeta.isElevated ? 'text-[var(--down)] font-semibold' : 'text-[var(--ink-2)]'
						}
					>
						{permissionMeta.text}
					</span>
					<span className="text-[var(--ink-3)] select-none opacity-60" aria-hidden="true">
						·
					</span>
				</div>

				{/* 段 4：来源（可截断，读 assignmentSource / followedTaskId，AC 1, E-347, E-357） */}
				<div data-segment-cell="source" className="min-w-0 truncate">
					<span
						data-field="ref-source"
						title={sourceMeta.title}
						className="truncate block text-[var(--ink-3)]"
					>
						{sourceMeta.text}
					</span>
				</div>
			</div>

			{effectiveSlot}
		</div>
	);
}
