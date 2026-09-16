/**
 * packages/web/src/components/gate-card.tsx
 *
 * 审批卡与闸门交互组件（M9-T10 / AC 1..5, E-109, E-182）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * 1) 审批卡就地插在该流时间轴里，禁止 import dialog、禁止 createPortal，不弹全局模态打断其他还在跑的流（AC 1, E-109）
 * 2) 四段固定顺序：要做什么（14px/600）／影响什么（26px 等宽大数）／凭什么（带可点链接回产出该结论的那一步）／三个动作，「改一下」不是可选项（AC 2）
 * 3) 底部写明「无人应答不会自动批准，任务保持等待」（AC 3）
 * 4) 全局只用一个未处理计数徽标提示（AC 4, E-109, GatePendingBadge）
 * 5) 手机上审批派发前闸门时文案必须写「批准派发」，不得含糊成「同意」（AC 5, E-182）
 * 6) 样式规则：整卡染色 + 1px --needs 全边框，不用左侧 3px 彩条；颜色一律使用 tokens.css 的 CSS 变量
 * 7) 纯展示层组件：纯 props in / callback out，禁止 import api/store/features/shell，禁止内部 useEffect 取数
 */

import type { GateDto } from '@agent-scheduler/shared/api/gates';
import {
	type HTMLAttributes,
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	useCallback,
	useId,
	useState,
} from 'react';
import type { DensityTier } from '../hooks/use-breakpoint.ts';

/**
 * 零产出退出上下文 stderr 数据形状（E-348 / E-359 / M9-T23 预留契约）。
 */
export type StderrTailKind =
	| { readonly kind: 'lines'; readonly lines: readonly string[] }
	| { readonly kind: 'unavailable'; readonly reason: 'legacy_run' | 'event_missing' };

/**
 * 闸门附带上下文数据（零产出退出或其他附加诊断，E-348 / E-359）。
 */
export interface GateContextDto {
	readonly exitCode?: number | null;
	readonly exitSignal?: string | null;
	readonly stderrTail?: StderrTailKind | null;
	readonly login?: {
		readonly status: 'logged_in' | 'logged_out' | 'unknown';
		readonly probedAt?: string;
		readonly hint?: string;
	} | null;
	readonly [key: string]: unknown;
}

/**
 * 审批卡组件属性。
 */
export interface GateCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children'> {
	/** 闸门 DTO 数据（来自 M8-T4，可选） */
	readonly gate?: GateDto | null;
	/** 闸门类型（dispatch: 派发前 | review: 审查前/确认 | landing: 落地前） */
	readonly gateKind?: 'dispatch' | 'review' | 'landing';
	/** 关联任务唯一标识（如 M9-T10） */
	readonly taskKey?: string;
	/** 关联任务标题 */
	readonly taskTitle?: string;

	// ── 第 1 段：要做什么 ──
	/** 第 1 段标题文案（14px/600，未指定则由 gateKind 自动推导） */
	readonly title?: ReactNode;
	/** what 属性别名 */
	readonly what?: ReactNode;

	// ── 第 2 段：影响什么 ──
	/** 吓人的指标数值（26px 等宽，--needs 或 --down）；未提供时显示「—」 */
	readonly impactValue?: string | number;
	/** 指标数值单位（如 "个文件", "token", "项改动"） */
	readonly impactUnit?: string;
	/** 影响范围详细描述说明（12px） */
	readonly impactDescription?: ReactNode;
	/** 是否属于不可逆操作（为 true 时数值显示为 --down 红色） */
	readonly isIrreversible?: boolean;

	// ── 第 3 段：凭什么（必须带链接回产出结论的一步） ──
	/** 决策依据/证据说明（12px） */
	readonly evidence?: ReactNode;
	/** basisDescription 属性别名 */
	readonly basisDescription?: ReactNode;
	/** 产出该结论的步骤序号（如 4） */
	readonly stepNumber?: number;
	/** 产出该结论的步骤标签（如 "步骤 4 · 运行审查"） */
	readonly stepLabel?: string;
	/** 步骤唯一标识符 */
	readonly stepId?: string | number;
	/** 步骤跳转链接（可选 hash / URL） */
	readonly stepHref?: string;
	/** 点击链接回溯到产出该结论步骤的回调函数（AC 2 核心指标） */
	readonly onStepClick?: (stepId?: string | number) => void;

	// M9-T20 扩展（未结构化返工原文展示）
	/** 审查裁定枚举（'incomplete' 时展示返工原文块与条件动作） */
	readonly reviewVerdict?: string;
	/** 返工原文（未结构化时默认折叠 3 行） */
	readonly reworkText?: string;

	// M9-T23 扩展（零产出退出附加诊断）
	/** 零产出退出上下文（E-348 / E-359） */
	readonly context?: GateContextDto | null;

	// ── 第 4 段：三个动作 ──
	/** 动作 1：批准回调 */
	readonly onApprove?: () => void;
	/** 动作 2：改一下回调（「改一下」不是可选项，必须提供操作通道） */
	readonly onEdit?: () => void;
	/** 动作 3：拒绝回调 */
	readonly onReject?: () => void;
	/** 条件动作：投递原文到实施会话回调（E-278） */
	readonly onDeliverRaw?: () => void;

	/** 动作 1 按钮文案（手机端派发闸门严格强制为「批准派发」，E-182） */
	readonly approveLabel?: string;
	/** 动作 2 按钮文案（默认「改一下」） */
	readonly editLabel?: string;
	/** 动作 3 按钮文案（默认「拒绝」） */
	readonly rejectLabel?: string;
	/** 条件动作按钮文案（默认「投递原文到实施会话」） */
	readonly deliverRawLabel?: string;

	/** 目标运行是否支持回话（若为 false 则条件动作禁用并带 title 提示，E-117） */
	readonly canReply?: boolean;

	// ── 交互控制与状态 ──
	/** 是否在请求处理中（禁用所有按钮防重复点击） */
	readonly isSubmitting?: boolean;
	/** 是否整体禁用操作 */
	readonly disabled?: boolean;

	// ── 响应式与档位感知 ──
	/** 密度档位（由外层通过 prop 下传） */
	readonly tier?: DensityTier;
	/** 是否处于手机档环境（AC 5, E-182） */
	readonly isMobile?: boolean;
	/** 是否为粗指针触控设备（增大按钮命中区至 44px） */
	readonly isTouch?: boolean;

	// ── 底部超时说明 ──
	/** 自定义底部超时策略说明（默认「无人应答不会自动批准，任务保持等待」） */
	readonly timeoutPolicyText?: string;
}

/**
 * 依据设备类型与闸门性质计算动作 1（批准）文案（AC 5, E-182）。
 *
 * 核心规则：
 * - 手机档审批「派发前闸门」时文案必须如实写「批准派发」，不得含糊成「同意」（E-182）。
 * - 任何情况下严禁回退为含糊的「同意」。
 */
export function resolveApproveActionLabel(params: {
	readonly isMobileView: boolean;
	readonly isDispatchGate: boolean;
	readonly customLabel?: string;
}): string {
	const { isMobileView, isDispatchGate, customLabel } = params;

	// 手机档派发闸门：如实写「批准派发」，绝不含糊成「同意」（E-182）
	if (isMobileView && isDispatchGate) {
		return '批准派发';
	}

	// 桌面档派发闸门
	if (isDispatchGate) {
		// 若传入含糊的「同意」，强制替换为具名文案「批准派发」
		if (customLabel === '同意' || !customLabel) {
			return '批准派发';
		}
		return customLabel;
	}

	// 非派发闸门（如审查确认、落地确认）
	if (customLabel && customLabel !== '同意') {
		return customLabel;
	}

	return '批准并继续';
}

/**
 * 默认推导「要做什么」文案。
 */
function resolveWhatText(
	gateKind: 'dispatch' | 'review' | 'landing',
	customTitle?: ReactNode,
	taskKey?: string,
): ReactNode {
	if (customTitle !== undefined && customTitle !== null) {
		return customTitle;
	}

	const taskPrefix = taskKey ? `任务 ${taskKey}：` : '';
	switch (gateKind) {
		case 'dispatch':
			return `${taskPrefix}批准派发任务并启动执行`;
		case 'review':
			return `${taskPrefix}确认审查裁定结果并推进后续流程`;
		case 'landing':
			return `${taskPrefix}批准合并分支并将改动记录落地`;
		default:
			return `${taskPrefix}等待人工审批放行`;
	}
}

/**
 * 默认推导「影响什么」描述与指标。
 *
 * 指标数值只来自 daemon 下发的字段；调用方未提供时显示「—」，不用前端常量补齐（07 节：缺失就显示「—」）。
 * 不可逆标记按闸门性质给出保守默认：分支落地合入主干不可撤销，其余闸门按调用方传入值。
 */
function resolveImpactDefaults(
	gateKind: 'dispatch' | 'review' | 'landing',
	impactValue?: string | number,
	impactUnit?: string,
	impactDescription?: ReactNode,
	isIrreversible?: boolean,
): {
	value: string | number;
	unit?: string;
	description: ReactNode;
	irreversible: boolean;
} {
	if (impactValue !== undefined && impactValue !== null) {
		return {
			value: impactValue,
			unit: impactUnit,
			description: impactDescription ?? '本次操作将影响任务流水线推进状态',
			irreversible: Boolean(isIrreversible),
		};
	}

	switch (gateKind) {
		case 'dispatch':
			return {
				value: '—',
				description: impactDescription ?? '将在本泳道创建进程并启动 Agent 自主实施',
				irreversible: false,
			};
		case 'review':
			return {
				value: '—',
				description: impactDescription ?? '确认验收证据并推进至查 bug 或落地环节',
				irreversible: false,
			};
		case 'landing':
			return {
				value: '—',
				description: impactDescription ?? '改动将合入主干并在知识库沉淀记录（不可逆）',
				irreversible: true,
			};
		default:
			return {
				value: '—',
				description: impactDescription ?? '放行当前受阻的任务流水线',
				irreversible: Boolean(isIrreversible),
			};
	}
}

/**
 * 审批卡组件（GateCard）。
 *
 * 就地插在对应运行流的时间轴里，绝不使用全局弹窗，不打断其他流推进（AC 1, E-109）。
 */
export function GateCard(props: GateCardProps) {
	const {
		gate,
		gateKind: explicitGateKind,
		taskKey,
		taskTitle,
		title,
		what,
		impactValue,
		impactUnit,
		impactDescription,
		isIrreversible,
		evidence,
		basisDescription,
		stepNumber,
		stepLabel,
		stepId,
		stepHref,
		onStepClick,
		reviewVerdict,
		reworkText,
		context,
		onApprove,
		onEdit,
		onReject,
		onDeliverRaw,
		approveLabel,
		editLabel = '改一下',
		rejectLabel = '拒绝',
		deliverRawLabel = '投递原文到实施会话',
		canReply = true,
		isSubmitting = false,
		disabled = false,
		tier,
		isMobile = false,
		isTouch = false,
		timeoutPolicyText = '无人应答不会自动批准，任务保持等待',
		className,
		...rest
	} = props;

	// 生成唯一控件 ID
	const cardId = useId();
	const whatId = `${cardId}-what`;
	const whyId = `${cardId}-why`;

	// 未结构化返工原文折叠状态控制（M9-T20，默认折叠 3 行）
	const [isReworkExpanded, setIsReworkExpanded] = useState(false);
	const toggleReworkExpand = useCallback(() => {
		setIsReworkExpanded((prev) => !prev);
	}, []);

	// 零产出退出 context stderr 展开状态控制（E-359，手机档默认折叠 5 行）
	const [isStderrExpanded, setIsStderrExpanded] = useState(false);
	const toggleStderrExpand = useCallback(() => {
		setIsStderrExpanded((prev) => !prev);
	}, []);

	// 推导当前闸门类型
	const resolvedKind: 'dispatch' | 'review' | 'landing' =
		explicitGateKind ?? gate?.kind ?? 'review';

	// 判定是否处于手机端视口（AC 5, E-182）
	const isPhoneView = isMobile || tier === 'phone' || tier === 'phone-xs';
	const isTouchTarget = isTouch || isPhoneView;

	// 是否属于派发闸门
	const isDispatch = resolvedKind === 'dispatch';

	// 动作 1 批准按钮文案判定（严格遵守 E-182：手机端派发闸门写「批准派发」，绝不含糊为「同意」）
	const resolvedApproveLabel = resolveApproveActionLabel({
		isMobileView: isPhoneView,
		isDispatchGate: isDispatch,
		customLabel: approveLabel,
	});

	// 推导第 1 段「要做什么」文案
	const resolvedWhat = resolveWhatText(resolvedKind, title ?? what, taskKey);

	// 推导第 2 段「影响什么」数值与文案
	const impact = resolveImpactDefaults(
		resolvedKind,
		impactValue,
		impactUnit,
		impactDescription,
		isIrreversible,
	);

	// 步骤回溯点击事件处理
	const handleStepClick = useCallback(
		(e: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => {
			if (stepHref && !onStepClick) {
				return;
			}
			e.preventDefault();
			onStepClick?.(stepId ?? stepNumber);
		},
		[stepHref, onStepClick, stepId, stepNumber],
	);

	// 步骤回溯键盘触发
	const handleStepKeyDown = useCallback(
		(e: KeyboardEvent<HTMLButtonElement | HTMLAnchorElement>) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				onStepClick?.(stepId ?? stepNumber);
			}
		},
		[onStepClick, stepId, stepNumber],
	);

	// 是否展示 M9-T20 审查未结构化第 4 个条件动作「投递原文到实施会话」
	const hasConditionDeliverRaw =
		reviewVerdict === 'incomplete' &&
		Boolean(reworkText && reworkText.trim().length > 0) &&
		Boolean(onDeliverRaw);

	// 是否处于零产出退出 context 特殊形态（E-348 / E-359 / M9-T23）
	const hasZeroOutputContext = context !== undefined && context !== null;

	return (
		<section
			data-component="gate-card"
			data-resident-card="true"
			data-gate-kind={resolvedKind}
			data-tier={tier}
			aria-labelledby={whatId}
			aria-describedby={whyId}
			className={[
				'w-full box-border select-text',
				'rounded-[var(--r,14px)] p-[14px]',
				'border border-[var(--needs)] bg-[var(--needs-soft)]',
				'text-[var(--ink-1)] font-ui text-[13px] leading-[var(--lh-ui,1.45)]',
				'transition-colors duration-[var(--dur-fast,120ms)]',
				className ?? '',
			].join(' ')}
			{...rest}
		>
			{/* ─────────────────────────────────────────────────────────────
			    第 1 段：要做什么（14px/600，AC 2）
			    ───────────────────────────────────────────────────────────── */}
			<section data-segment="what" className="mb-3">
				<div className="flex items-start justify-between gap-2">
					<h3
						id={whatId}
						data-field="what-title"
						className="font-ui text-[14px] font-semibold text-[var(--ink-1)] tracking-tight m-0 leading-snug flex-1"
					>
						{hasZeroOutputContext ? 'agent 未产出任何内容就退出' : resolvedWhat}
					</h3>
					{taskKey && (
						<span
							data-field="task-badge"
							className="font-mono text-[11px] px-1.5 py-0.5 rounded-[4px] bg-[var(--panel-2)] text-[var(--ink-2)] border border-[var(--border)] flex-shrink-0"
						>
							{taskKey}
						</span>
					)}
				</div>
				{taskTitle && !hasZeroOutputContext && (
					<p
						className="font-ui text-[12px] text-[var(--ink-2)] mt-0.5 mb-0 truncate"
						title={taskTitle}
					>
						{taskTitle}
					</p>
				)}
			</section>

			{/* ─────────────────────────────────────────────────────────────
			    第 2 段：影响什么（26px 等宽大数，AC 2）
			    不可逆动作使用 --down 红色，可逆与常规操作使用 --needs 暖色
			    ───────────────────────────────────────────────────────────── */}
			<section data-segment="impact" className="mb-3.5">
				{hasZeroOutputContext ? (
					/* 零产出退出 context 形态下的退出码展示（E-348 / E-359） */
					<div>
						<div className="flex items-baseline gap-2">
							<span
								data-field="exit-code"
								className="font-mono text-[var(--fs-num-lg,26px)] font-semibold leading-none text-[var(--needs)]"
							>
								{context.exitCode !== null && context.exitCode !== undefined
									? `exit: ${context.exitCode}`
									: context.exitSignal
										? `sig: ${context.exitSignal}`
										: '—'}
							</span>
						</div>
						<p className="font-ui text-[12px] text-[var(--ink-2)] mt-1 mb-0 leading-normal">
							agent 未产出任何内容就退出，常见原因：未登录、模型名不可用、参数被拒
						</p>
					</div>
				) : (
					/* 常规闸门影响大数展示 */
					<div>
						<div className="flex items-baseline gap-2 flex-wrap">
							<span
								data-field="impact-metric"
								className={[
									'font-mono text-[var(--fs-num-lg,26px)] font-semibold leading-none tracking-tight',
									impact.irreversible ? 'text-[var(--down)]' : 'text-[var(--needs)]',
								].join(' ')}
							>
								{impact.value}
							</span>
							{impact.unit && (
								<span
									data-field="impact-unit"
									className="font-ui text-[12px] text-[var(--ink-2)] font-medium"
								>
									{impact.unit}
								</span>
							)}
							{impact.irreversible && (
								<span
									data-field="irreversible-chip"
									className="font-ui text-[11px] px-1.5 py-0.5 rounded-[4px] bg-[var(--down-soft)] text-[var(--down)] font-medium"
								>
									不可逆操作
								</span>
							)}
						</div>
						<p
							data-field="impact-description"
							className="font-ui text-[12px] text-[var(--ink-2)] mt-1 mb-0 leading-normal"
						>
							{impact.description}
						</p>
					</div>
				)}
			</section>

			{/* ─────────────────────────────────────────────────────────────
			    第 3 段：凭什么（12px，必须带可点链接回产出该结论的那一步，AC 2）
			    ───────────────────────────────────────────────────────────── */}
			<section
				id={whyId}
				data-segment="why"
				className="mb-4 rounded-[var(--r-sm,9px)] p-2.5 bg-[var(--panel-2)] border border-[var(--border)] text-[12px]"
			>
				{/* 证据与决策依据正文 */}
				<div className="flex items-start justify-between gap-2 mb-2">
					<div className="flex-1 text-[var(--ink-1)] leading-relaxed">
						{evidence ??
							basisDescription ??
							(hasZeroOutputContext
								? '该运行在首条内容事件到达之前异常退出，未产出任何有效输出。'
								: '系统依据前序执行产物与机械检查判定触发本次人工审核。')}
					</div>
				</div>

				{/* 必须带一个可点的链接回产出该结论的那一步（AC 2 核心指标） */}
				<div
					data-field="producing-step-link"
					className="mt-1 pt-1.5 border-t border-[var(--border)]"
				>
					{stepHref && !onStepClick ? (
						<a
							href={stepHref}
							data-action="goto-step"
							data-step-number={stepNumber}
							className="inline-flex items-center gap-1.5 font-mono text-[12px] text-[var(--needs)] hover:underline cursor-pointer select-none focus-visible:ring-2 focus-visible:ring-[var(--needs)] focus-visible:outline-none rounded-[4px]"
							title={`跳转回产出该审批的步骤（${stepLabel ?? `第 ${stepNumber ?? '—'} 步`}）`}
						>
							<span aria-hidden="true">←</span>
							<span>
								{stepLabel
									? `回到步骤：${stepLabel}`
									: stepNumber !== undefined
										? `回到产出结论的第 ${stepNumber} 步`
										: '回到产出该结论的执行步骤'}
							</span>
						</a>
					) : (
						<button
							type="button"
							data-action="goto-step"
							data-step-number={stepNumber}
							onClick={handleStepClick}
							onKeyDown={handleStepKeyDown}
							className="inline-flex items-center gap-1.5 font-mono text-[12px] text-[var(--needs)] hover:underline cursor-pointer select-none bg-transparent border-none p-0 focus-visible:ring-2 focus-visible:ring-[var(--needs)] focus-visible:outline-none rounded-[4px]"
							title={`跳转回产出该审批的步骤（${stepLabel ?? `第 ${stepNumber ?? '—'} 步`}）`}
						>
							<span aria-hidden="true">←</span>
							<span>
								{stepLabel
									? `回到步骤：${stepLabel}`
									: stepNumber !== undefined
										? `回到产出结论的第 ${stepNumber} 步`
										: '回到产出该结论的执行步骤'}
							</span>
						</button>
					)}
				</div>

				{/* M9-T20 扩展：审查未结构化时的返工原文展示（默认折叠 3 行） */}
				{reviewVerdict === 'incomplete' && reworkText && (
					<div
						data-field="rework-text-block"
						className="mt-2.5 pt-2 border-t border-[var(--border)]"
					>
						<div className="flex items-center justify-between text-[11px] text-[var(--ink-2)] mb-1">
							<span className="font-semibold">审查意见原文（未结构化）</span>
							<button
								type="button"
								data-action="toggle-rework"
								onClick={toggleReworkExpand}
								className="text-[var(--needs)] hover:underline bg-transparent border-none p-0 cursor-pointer font-mono text-[11px]"
							>
								{isReworkExpanded ? '收起' : '展开全文'}
							</button>
						</div>
						<div
							className={[
								'font-mono text-[11px] p-2 rounded-[6px] bg-[var(--bg)] border border-[var(--border)] whitespace-pre-wrap break-all',
								isReworkExpanded
									? 'max-h-[var(--payload-max-h,240px)] overflow-y-auto'
									: 'line-clamp-3',
							].join(' ')}
						>
							{reworkText}
						</div>
					</div>
				)}

				{/* M9-T23 扩展：零产出退出 context stderr 末 20 行（E-348 / E-359） */}
				{hasZeroOutputContext && (
					<div data-field="stderr-block" className="mt-2.5 pt-2 border-t border-[var(--border)]">
						<div className="flex items-center justify-between text-[11px] text-[var(--ink-2)] mb-1">
							<span className="font-semibold">stderr 诊断记录</span>
							{context.stderrTail &&
								context.stderrTail.kind === 'lines' &&
								context.stderrTail.lines.length > 5 &&
								isPhoneView && (
									<button
										type="button"
										data-action="toggle-stderr"
										onClick={toggleStderrExpand}
										className="text-[var(--needs)] hover:underline bg-transparent border-none p-0 cursor-pointer font-mono text-[11px]"
									>
										{isStderrExpanded ? '折叠至 5 行' : '展开至 20 行'}
									</button>
								)}
						</div>
						<section
							aria-label="stderr 末 20 行"
							className="font-mono text-[11px] p-2 rounded-[6px] bg-[var(--bg)] border border-[var(--border)] max-h-[var(--payload-max-h,240px)] overflow-y-auto whitespace-pre-wrap break-all text-[var(--ink-2)]"
						>
							{(() => {
								const tail = context.stderrTail;
								if (!tail) {
									return <span className="text-[var(--ink-3)]">事件缺失</span>;
								}
								if (tail.kind === 'unavailable') {
									return (
										<span className="text-[var(--ink-3)]">
											{tail.reason === 'legacy_run' ? '无记录（旧运行）' : '事件缺失'}
										</span>
									);
								}
								if (tail.lines.length === 0) {
									return <span className="text-[var(--ink-3)]">无 stderr 输出</span>;
								}
								const linesToRender =
									isPhoneView && !isStderrExpanded ? tail.lines.slice(-5) : tail.lines.slice(-20);

								return linesToRender.map((line, idx) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: lines in log tail have no unique ID
									<div key={idx} className="leading-tight">
										{line.includes('[REDACTED]') ? line.replaceAll('[REDACTED]', '[已脱敏]') : line}
									</div>
								));
							})()}
						</section>
						{/* 登录态信息行 */}
						{context.login && (
							<div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-[var(--ink-3)] font-mono">
								<span>登录态探测:</span>
								<span
									className={[
										'px-1 py-0.2 rounded-[3px] border',
										context.login.status === 'logged_in'
											? 'border-[var(--auto)] text-[var(--auto)]'
											: 'border-[var(--down)] text-[var(--down)]',
									].join(' ')}
								>
									{context.login.status === 'logged_in'
										? '已登录'
										: context.login.status === 'logged_out'
											? '未登录'
											: '探测未知'}
								</span>
								{context.login.hint && <span className="truncate">{context.login.hint}</span>}
							</div>
						)}
					</div>
				)}
			</section>

			{/* ─────────────────────────────────────────────────────────────
			    第 4 段：三个动作（AC 2, AC 5, E-182）
			    [批准并继续] (primary)
			    [改一下] (ghost) —— 「改一下」不是可选项，必须支持
			    [拒绝] (danger outline)
			    + 条件动作 [投递原文到实施会话] (ghost)
			    ───────────────────────────────────────────────────────────── */}
			<section data-segment="actions" className="flex items-center gap-2 flex-wrap">
				{/* 动作 1：批准按钮（Primary，整卡染色实底，无 --glow） */}
				<button
					type="button"
					data-action="approve"
					onClick={onApprove}
					disabled={isSubmitting || disabled}
					className={[
						'inline-flex items-center justify-center font-ui font-semibold text-[13px]',
						'bg-[var(--needs)] text-[var(--on-needs)] border border-transparent',
						'rounded-[var(--r-sm,9px)] px-3.5',
						isTouchTarget ? 'min-h-[var(--h-btn-lg,44px)]' : 'h-[var(--h-btn,32px)]',
						'hover:brightness-105 active:scale-[0.98]',
						'focus-visible:ring-2 focus-visible:ring-[var(--needs)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] focus-visible:outline-none',
						'disabled:opacity-45 disabled:cursor-not-allowed disabled:active:scale-100',
						'transition-all duration-[var(--dur-fast,120ms)] cursor-pointer select-none',
					].join(' ')}
				>
					{isSubmitting ? '提交中…' : resolvedApproveLabel}
				</button>

				{/* 动作 2：改一下按钮（Ghost，AC 2: 「改一下」不是可选项） */}
				{/* 在零产出 context 手机档下不渲染该按钮（E-359 规定），其余均常驻提供 */}
				{(!hasZeroOutputContext || !isPhoneView) && (
					<button
						type="button"
						data-action="edit"
						onClick={onEdit}
						disabled={isSubmitting || disabled}
						className={[
							'inline-flex items-center justify-center font-ui font-medium text-[13px]',
							'bg-transparent text-[var(--ink-2)] border border-[var(--border)]',
							'rounded-[var(--r-sm,9px)] px-3',
							isTouchTarget ? 'min-h-[var(--h-btn-lg,44px)]' : 'h-[var(--h-btn,32px)]',
							'hover:text-[var(--ink-1)] hover:border-[var(--border-strong)] hover:brightness-105 active:scale-[0.98]',
							'focus-visible:ring-2 focus-visible:ring-[var(--needs)] focus-visible:outline-none',
							'disabled:opacity-45 disabled:cursor-not-allowed disabled:active:scale-100',
							'transition-all duration-[var(--dur-fast,120ms)] cursor-pointer select-none',
						].join(' ')}
					>
						{hasZeroOutputContext ? '换 agent 重派' : editLabel}
					</button>
				)}

				{/* 动作 3：拒绝按钮（Danger outline，红留给拒绝/删除，11 节） */}
				<button
					type="button"
					data-action="reject"
					onClick={onReject}
					disabled={isSubmitting || disabled}
					className={[
						'inline-flex items-center justify-center font-ui font-medium text-[13px]',
						'bg-transparent text-[var(--down)] border border-[var(--down)]',
						'rounded-[var(--r-sm,9px)] px-3',
						isTouchTarget ? 'min-h-[var(--h-btn-lg,44px)]' : 'h-[var(--h-btn,32px)]',
						'hover:bg-[var(--down-soft)] hover:brightness-105 active:scale-[0.98]',
						'focus-visible:ring-2 focus-visible:ring-[var(--down)] focus-visible:outline-none',
						'disabled:opacity-45 disabled:cursor-not-allowed disabled:active:scale-100',
						'transition-all duration-[var(--dur-fast,120ms)] cursor-pointer select-none',
					].join(' ')}
				>
					{hasZeroOutputContext ? '标失败' : rejectLabel}
				</button>

				{/* 动作 4：条件动作 [投递原文到实施会话]（M9-T20 / E-278 / E-117） */}
				{hasConditionDeliverRaw && (
					<button
						type="button"
						data-action="deliver-raw"
						onClick={onDeliverRaw}
						disabled={isSubmitting || disabled || !canReply}
						title={!canReply ? '目标运行不支持回话' : undefined}
						className={[
							'inline-flex items-center justify-center font-ui font-medium text-[13px]',
							'bg-transparent text-[var(--ink-2)] border border-[var(--border)]',
							'rounded-[var(--r-sm,9px)] px-3',
							isTouchTarget ? 'min-h-[var(--h-btn-lg,44px)]' : 'h-[var(--h-btn,32px)]',
							'hover:text-[var(--ink-1)] hover:border-[var(--border-strong)] active:scale-[0.98]',
							'focus-visible:ring-2 focus-visible:ring-[var(--needs)] focus-visible:outline-none',
							'disabled:opacity-45 disabled:cursor-not-allowed disabled:active:scale-100',
							'transition-all duration-[var(--dur-fast,120ms)] cursor-pointer select-none',
						].join(' ')}
					>
						{deliverRawLabel}
					</button>
				)}
			</section>

			{/* ─────────────────────────────────────────────────────────────
			    第 5 段：底部超时策略（AC 3: 底部写明「无人应答不会自动批准，任务保持等待」）
			    ───────────────────────────────────────────────────────────── */}
			<footer
				data-segment="timeout-policy"
				className="flex items-center gap-1.5 mt-3 pt-2.5 border-t border-[var(--border)] text-[11px] text-[var(--ink-3)] font-ui select-none"
			>
				<span
					className="w-1.5 h-1.5 rounded-full bg-[var(--needs)] flex-shrink-0"
					aria-hidden="true"
				/>
				<span data-field="timeout-text">{timeoutPolicyText}</span>
			</footer>
		</section>
	);
}

/**
 * 全局未处理计数徽标组件属性（AC 4, E-109）。
 *
 * 规范：全局只用一个未处理计数徽标提示，不得弹全局模态。
 */
export interface GatePendingBadgeProps extends HTMLAttributes<HTMLSpanElement> {
	/** 待处理审批闸门数量 */
	readonly count: number;
	/** 点击回调（如定位到待审批流或打开审批抽屉） */
	readonly onClick?: () => void;
	/** 是否为触控环境（增大命中区） */
	readonly isTouch?: boolean;
}

/**
 * 全局未处理计数徽标（GatePendingBadge / PendingApprovalBadge）。
 *
 * 用于在顶栏或流头部提供全局唯一的审批等待指示，矩形非药丸（AC 4, E-109, 11 节）。
 */
export function GatePendingBadge(props: GatePendingBadgeProps) {
	const { count, onClick, isTouch = false, className, ...rest } = props;

	if (count <= 0) {
		return null;
	}

	const isClickable = Boolean(onClick);

	return (
		<span
			data-pending-badge="true"
			data-count={count}
			role={isClickable ? 'button' : 'status'}
			tabIndex={isClickable ? 0 : undefined}
			onClick={onClick}
			onKeyDown={
				isClickable
					? (e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								onClick?.();
							}
						}
					: undefined
			}
			aria-label={`有 ${count} 项待处理审批`}
			title={`当前有 ${count} 项待处理审批，点击查看`}
			className={[
				'inline-flex items-center justify-center gap-1 font-mono text-[11px] font-semibold select-none',
				'rounded-[6px] border border-[var(--needs)] bg-[var(--needs-soft)] text-[var(--needs)]',
				'h-[var(--badge-h,20px)] px-1.5',
				isTouch ? 'min-h-[32px] min-w-[32px]' : '',
				isClickable
					? 'cursor-pointer hover:brightness-110 active:scale-95 focus-visible:ring-2 focus-visible:ring-[var(--needs)] focus-visible:outline-none'
					: '',
				className ?? '',
			].join(' ')}
			{...rest}
		>
			{/* 静态暖点：呼吸环是全页唯一的连续动画，只出现在运行轨当前步与批次树执行行（11 节） */}
			<span
				className="w-1.5 h-1.5 rounded-full bg-[var(--needs)] flex-shrink-0"
				aria-hidden="true"
			/>
			<span>{count}</span>
		</span>
	);
}

/**
 * 别名导出。
 */
export const PendingApprovalBadge = GatePendingBadge;
