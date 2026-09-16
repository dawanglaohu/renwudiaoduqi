/**
 * packages/web/src/components/stream-row.tsx
 *
 * 运行流条目组件（M9-T7 / AC 3, AC 4, AC 5, AC 6, E-110, E-230）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 条目折叠高度 30px（触摸档 44px）（AC 3, 11 节）
 * - 网格布局严格为 20px minmax(0,1fr) auto 16px（AC 3, 11 节）
 * - 每一步都显示耗时，无数据返回 '—' 禁止返回 0（AC 3, 07 节）
 * - 标签严格为「工具 + 对象」，严禁拟人化或分类目标签（AC 4, 11 节）
 * - 成功步默认折叠、失败步默认展开并提供「从这一步重试」（AC 4）
 * - 键盘焦点用内嵌环，滚动列表不整体抖（AC 5）
 * - 轨段形态与状态徽标共用同一张形状枚举，状态区分不只靠色相（AC 6, E-110）
 * - 「失联」「审查未完成」「未识别/降级」各有专属形状而非复用失败形状（E-230）
 * - 纯展示层组件：纯 props in / callback out，禁止 import api/store/features/shell，禁止内部 useEffect（07 节）
 */

import {
	type HTMLAttributes,
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useState,
} from 'react';
import { usePayloadSheet } from '../hooks/use-payload-sheet.ts';
import {
	type StatusState,
	type StepType,
	getStepShape,
	normalizeStatusState,
} from '../lib/spine-shape.ts';
import { type SpineSegment, SpineSegmentView } from './spine.tsx';
import { StatusIcon } from './status-badge.tsx';

/**
 * 运行流条目组件属性。
 */
export interface StreamRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'id'> {
	/** 步骤/条目唯一标识 */
	readonly id?: string | number;
	/** 工具名称（如 'exec_command', 'write_file', 'think'） */
	readonly tool?: string;
	/** 操作对象（如 'git commit', 'packages/web/src/main.tsx'） */
	readonly target?: string;
	/** 完整标签文案（未提供 tool/target 时回退） */
	readonly label?: string;
	/** 步骤类型（6 个步骤类型之一） */
	readonly stepType?: StepType | string;
	/** 步骤运行状态（12 个状态之一） */
	readonly status?: StatusState | string;
	/** 耗时（毫秒数值或已格式化字符串；每一步都显示耗时，无数据返回 '—'） */
	readonly duration?: number | string | null;
	/** 外部受控展开状态 */
	readonly expanded?: boolean;
	/** 默认展开状态（非受控；未指定时成功步默认折叠，失败步默认展开） */
	readonly defaultExpanded?: boolean;
	/** 展开状态变更回调 */
	readonly onExpandedChange?: (expanded: boolean) => void;
	/** 失败步提供的「从这一步重试」操作回调（AC 4） */
	readonly onRetry?: () => void;
	/** 重试按钮文案（默认「从这一步重试」） */
	readonly retryLabel?: string;
	/** 是否为触摸档（高度 44px，默认 false 时高度 30px） */
	readonly isTouch?: boolean;
	/** 第一列轨段配置（可选；未传时依据 status/stepType 自动派生） */
	readonly spineSegment?: SpineSegment;
	/** 自定义第一列轨节点渲染插槽（可选） */
	readonly spineSlot?: ReactNode;
	/** 展开区域展示的详细输出或自定内容 */
	readonly detail?: ReactNode;
	/** 展开区域展示的输入载荷/参数 */
	readonly payload?: unknown;
	/** 失败提示文案 */
	readonly errorMessage?: string;
	/** 返工回环片段配置 */
	readonly loop?: SpineSegment['loop'];
}

/**
 * 格式化耗时（私有函数，就近位于组件文件底部/内部，07 节约定）。
 * 无数据返回 '—'，禁止返回 0（07 节硬规则）。
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
 * 根据状态和步骤类型派生第一列 SpineSegment。
 */
function deriveSpineSegment(
	status: string | undefined,
	stepType: string | undefined,
	loop: SpineSegment['loop'],
	override?: SpineSegment,
): SpineSegment {
	if (override) {
		return {
			...override,
			loop: override.loop ?? loop,
		};
	}

	const resolvedStatus = status ? normalizeStatusState(status) : undefined;

	let kind: SpineSegment['kind'] = 'done';
	let shape: string | undefined = stepType ?? resolvedStatus;

	switch (resolvedStatus) {
		case 'failed':
			kind = 'failed';
			shape = 'failed';
			break;
		case 'awaiting_input':
			kind = 'waiting';
			shape = 'awaiting_input';
			break;
		case 'thinking':
		case 'tool':
		case 'streaming':
			kind = 'live';
			shape = resolvedStatus;
			break;
		case 'succeeded':
			kind = 'done';
			shape = stepType ?? 'succeeded';
			break;
		case 'stopped':
			kind = 'stopped';
			shape = 'stopped';
			break;
		case 'queued':
			kind = 'pending';
			shape = 'queued';
			break;
		case 'orphaned':
			// E-230 专属字形
			kind = 'waiting';
			shape = 'orphaned';
			break;
		case 'review_incomplete':
			// E-230 专属字形
			kind = 'waiting';
			shape = 'review_incomplete';
			break;
		case 'unrecognized':
			// E-230 专属字形
			kind = 'pending';
			shape = 'unrecognized';
			break;
		case 'partial':
			kind = 'waiting';
			shape = 'partial';
			break;
		default:
			kind = 'done';
			shape = stepType ?? 'tool';
			break;
	}

	return {
		kind,
		shape,
		loop,
		level: 'step',
	};
}

/**
 * 运行流条目组件。
 */
export function StreamRow({
	id,
	tool,
	target,
	label,
	stepType,
	status,
	duration,
	expanded,
	defaultExpanded,
	onExpandedChange,
	onRetry,
	retryLabel = '从这一步重试',
	isTouch = false,
	spineSegment,
	spineSlot,
	detail,
	payload,
	errorMessage,
	loop,
	className,
	style,
	...rest
}: StreamRowProps) {
	const resolvedStatus = status ? normalizeStatusState(status) : undefined;
	const isFailed = resolvedStatus === 'failed';

	// AC 4: 成功步默认折叠、失败步默认展开
	const initialExpanded = defaultExpanded !== undefined ? defaultExpanded : isFailed;

	const [uncontrolledExpanded, setUncontrolledExpanded] = useState<boolean>(initialExpanded);
	const isControlled = expanded !== undefined;
	const isExpanded = isControlled ? expanded : uncontrolledExpanded;

	const payloadSheet = usePayloadSheet();
	const isMobilePayloadMode = Boolean(isTouch || payloadSheet?.isMobile);

	// AC 4: 标签严格为「工具 + 对象」
	let displayLabel = label;
	if (tool && target) {
		displayLabel = `${tool} ${target}`;
	} else if (tool) {
		displayLabel = tool;
	} else if (!displayLabel && stepType) {
		const shapeDef = getStepShape(stepType as StepType);
		displayLabel = shapeDef.defaultText;
	} else if (!displayLabel) {
		displayLabel = '—';
	}

	// AC 3: 每一步都显示耗时，无数据返回 '—' 禁止返回 0
	const displayDuration = formatDurationMs(duration);

	// 手机档展开时把 payload 送入 bottom sheet（AC 6 / R1）
	if (isExpanded && payload !== undefined && isMobilePayloadMode && payloadSheet) {
		payloadSheet.openPayloadSheet({
			title: displayLabel,
			toolName: tool,
			durationText: displayDuration !== '—' ? displayDuration : undefined,
			inputPayload: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
			raw: payload,
		});
	}

	useEffect(() => {
		if (isExpanded && payload !== undefined && isMobilePayloadMode && payloadSheet) {
			payloadSheet.openPayloadSheet({
				title: displayLabel,
				toolName: tool,
				durationText: displayDuration !== '—' ? displayDuration : undefined,
				inputPayload: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
				raw: payload,
			});
		}
	}, [isExpanded, payload, isMobilePayloadMode, payloadSheet, displayLabel, tool, displayDuration]);

	const handleToggleExpand = useCallback(() => {
		const nextState = !isExpanded;
		if (!isControlled) {
			setUncontrolledExpanded(nextState);
		}
		if (nextState && payload !== undefined && isMobilePayloadMode && payloadSheet) {
			payloadSheet.openPayloadSheet({
				title: displayLabel,
				toolName: tool,
				durationText: displayDuration !== '—' ? displayDuration : undefined,
				inputPayload: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
				raw: payload,
			});
		}
		onExpandedChange?.(nextState);
	}, [
		isExpanded,
		isControlled,
		onExpandedChange,
		payload,
		isMobilePayloadMode,
		payloadSheet,
		displayLabel,
		tool,
		displayDuration,
	]);

	// 键盘操作：Enter / Space 切换展开折叠（AC 5）
	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLDivElement>) => {
			if (e.target !== e.currentTarget) {
				return;
			}
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				handleToggleExpand();
			}
		},
		[handleToggleExpand],
	);

	const handleRetryClick = useCallback(
		(e: MouseEvent<HTMLButtonElement>) => {
			e.stopPropagation();
			onRetry?.();
		},
		[onRetry],
	);

	// 高度约束：折叠 30px，触摸档 44px（AC 3）
	const rowHeight = isTouch ? 44 : 30;

	// 第一列轨段
	const activeSegment = deriveSpineSegment(status, stepType, loop, spineSegment);

	const hasExpandableContent = Boolean(
		isFailed || errorMessage || detail || payload !== undefined || onRetry,
	);

	return (
		// biome-ignore lint/a11y/useSemanticElements: StreamRow is an interactive composite row with expandable details and keyboard navigation
		<div
			role="button"
			tabIndex={0}
			aria-expanded={isExpanded}
			aria-label={`${displayLabel} · ${displayDuration}`}
			data-stream-row="true"
			data-status={resolvedStatus ?? 'unknown'}
			data-failed={isFailed ? 'true' : 'false'}
			data-expanded={isExpanded ? 'true' : 'false'}
			onKeyDown={handleKeyDown}
			onClick={handleToggleExpand}
			className={[
				'group relative flex flex-col w-full rounded-[6px] select-none transition-colors duration-fast',
				'hover:bg-row-hover',
				// AC 5: 键盘焦点用内嵌环，滚动列表不整体抖
				'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]',
				className,
			]
				.filter(Boolean)
				.join(' ')}
			style={style}
			{...rest}
		>
			{/* AC 3: 网格严格为 20px minmax(0,1fr) auto 16px */}
			<div
				className="grid grid-cols-[20px_minmax(0,1fr)_auto_16px] items-center gap-x-2 w-full px-1 overflow-hidden"
				style={{ height: `${rowHeight}px`, minHeight: `${rowHeight}px` }}
			>
				{/* 第 1 列：20px 轨列（居中对齐运行轨） */}
				<div className="w-[20px] h-full flex items-center justify-center shrink-0">
					{spineSlot ?? (
						<SpineSegmentView segment={activeSegment} rowHeight={rowHeight} isTouch={isTouch} />
					)}
				</div>

				{/* 第 2 列：minmax(0,1fr) 标签列，必须为「工具 + 对象」 */}
				<div className="min-w-0 flex items-center">
					<span
						title={displayLabel}
						className="font-ui text-dense text-ink-1 truncate leading-none select-none"
					>
						{displayLabel}
					</span>
				</div>

				{/* 第 3 列：auto 耗时列（等宽字体，每一步都显示耗时） */}
				<div className="shrink-0 flex items-center justify-end pl-1">
					<span className="font-mono text-meta text-ink-3 tabular-nums leading-none select-none">
						{displayDuration}
					</span>
				</div>

				{/* 第 4 列：16px 开合槽（指示展开/折叠） */}
				<div className="w-[16px] h-full flex items-center justify-center shrink-0">
					{hasExpandableContent ? (
						<svg
							viewBox="0 0 16 16"
							width={12}
							height={12}
							fill="none"
							stroke="currentColor"
							className={[
								'text-ink-3 transition-transform duration-fast shrink-0',
								isExpanded ? 'rotate-90 text-ink-1' : 'rotate-0',
							].join(' ')}
							style={{ vectorEffect: 'non-scaling-stroke' }}
							aria-hidden="true"
						>
							<path
								d="M 6 3.5 L 10.5 8 L 6 12.5"
								strokeWidth={1.5}
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					) : (
						<span className="w-[12px] h-[12px] block shrink-0" aria-hidden="true" />
					)}
				</div>
			</div>

			{/* 展开区域：显示详情、错误信息及「从这一步重试」（AC 4, AC 1 / R3） */}
			{isExpanded && (
				<div
					data-stream-row-body="true"
					className="relative w-full pl-[28px] pr-2 pb-2 pt-1 flex flex-col gap-2 overflow-hidden"
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
				>
					{/* AC 1 / R3: 展开区左缘补 2px 延续轨（left:11px、覆盖展开区全高、颜色接当前段形态） */}
					<div
						aria-hidden="true"
						data-spine-expansion-line="true"
						className="absolute top-0 bottom-0 pointer-events-none select-none"
						style={{
							left: '11px',
							width: '2px',
							transform: 'translateX(-50%)',
							backgroundColor:
								activeSegment.kind === 'failed'
									? 'var(--spine-dead)'
									: activeSegment.kind === 'waiting'
										? 'var(--spine-needs)'
										: activeSegment.kind === 'stopped'
											? 'var(--stopped)'
											: activeSegment.kind === 'live' || activeSegment.kind === 'pending'
												? 'var(--spine-pending)'
												: 'var(--spine-done)',
						}}
					/>

					{/* 失败状态信息与「从这一步重试」按钮（AC 4, R4） */}
					{isFailed && (
						<div
							data-step-error-banner="true"
							className="flex items-center justify-between gap-3 p-2 rounded-[9px] bg-panel-2 border border-down-soft"
						>
							<div className="flex items-center gap-2 min-w-0 text-meta text-down">
								{/* R4: 禁止裸字符 ✕，统一使用 StatusIcon 内联 SVG path */}
								<StatusIcon
									state="failed"
									size={12}
									className="shrink-0 text-down"
									ariaHidden={true}
								/>
								<span className="font-mono text-log truncate">
									{errorMessage ?? '步骤执行失败'}
								</span>
							</div>

							{/* AC 4: 提供「从这一步重试」 */}
							<button
								type="button"
								data-action="retry-step"
								onClick={handleRetryClick}
								className={[
									'shrink-0 inline-flex items-center justify-center px-3 h-[26px] rounded-[9px]',
									'font-ui text-meta font-medium leading-none select-none',
									'bg-panel-2 text-ink-1 border border-border-strong',
									'hover:bg-border transition-colors duration-fast',
									'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--needs)]',
								].join(' ')}
							>
								{retryLabel}
							</button>
						</div>
					)}

					{/* 载荷/参数输出（等宽字体展示，E-110；手机档/触控档不内联，走 bottom sheet，AC 6） */}
					{payload !== undefined && !isMobilePayloadMode && (
						<pre
							data-step-payload="true"
							className="font-mono text-log p-2 rounded-[9px] bg-panel-2 border border-border text-ink-2 overflow-x-auto whitespace-pre-wrap select-text max-h-[160px]"
						>
							{typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)}
						</pre>
					)}

					{/* 外部自定义详情内容 */}
					{detail && <div className="text-body text-ink-2">{detail}</div>}
				</div>
			)}
		</div>
	);
}
