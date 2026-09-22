/**
 * packages/web/src/components/assign-panel.tsx
 *
 * 逐任务指派面板与并发瓶颈说明组件（M9-T18 / AC 1-4, E-108, E-31, E-47, E-52）
 *
 * 规范依据（11 节 UI 与 07 节前端架构，返工第 1 轮 R1-R3）：
 * - R1: 彻底删除组件层对默认 agent／模型／思考强度、会话序号、Agent 容量、用户并发缺省和越界能力的补算。
 *   全部由 daemon/feature 明确下发 props，缺失统一显示「—」（严格禁绝前端造假默认值与业务判定）。
 * - R2: 通过 EmptyOnboarding 的 step3Slot/step4Slot 接入真实零运行流程；从 PR 当前 head 的真实服务录制 GIF 并嵌入 PR body。
 * - R3: 全部交互控件补规定的 focus-visible 环（box-shadow 0 0 0 3px var(--needs-soft)），彻底移除无替代的 outline-none；
 *   手机档点击目标至少 44×44（min-h-[44px] min-w-[44px]），并补键盘和窄屏证据。
 * - 四步引导第三步是逐任务指派，每行一个任务，各自选 agent／模型／思考强度，已指派行显示所选值可点回改（AC 1, E-108）。
 * - 同一个 agent 允许被指派多次，每次是一个独立会话并显示将要使用的会话序号（AC 2, E-31, 决策 7, 决策 52）。
 * - 第四步显示并发三者取 min 的结果，并明确指出是并行窗口、该 agent 上限还是用户设定成了瓶颈（AC 3, E-52）。
 * - 某 agent 已达并发上限时其余任务仍可指派给别家，不空转等待（AC 4, E-47 的呈现侧）。
 * - 纯展示组件（components 纯 props in / callback out），颜色全走 CSS 变量（check-forbidden 机检）。
 */

import type { EffortTier, EffortValue } from '@agent-scheduler/shared/api/agents';
import {
	CONCURRENCY_PREVIEW_BOTTLENECKS,
	type ConcurrencyPreviewBottleneck,
} from '@agent-scheduler/shared/api/batches';
import { useId, useMemo, useState } from 'react';

/**
 * 待指派任务项。
 */
export interface TaskItem {
	readonly id: string;
	readonly taskKey: string;
	readonly title: string;
	readonly moduleKey?: string;
	readonly description?: string;
	readonly defaultAgentId?: string | null;
	readonly defaultModel?: string | null;
	readonly defaultEffortTier?: string | null;
	/** daemon/feature 下发的会话序号，缺失显示「—」，严禁前端补算 (R1) */
	readonly sessionIndex?: number | null;
}

/**
 * 可指派 Agent 容量状态。
 */
export interface AgentCapacityInfo {
	readonly used?: number | null;
	readonly max?: number | null;
	readonly isFull?: boolean | null;
}

/**
 * 可指派 Agent 数据模型。
 */
export interface AssignableAgent {
	readonly id: string;
	readonly name: string;
	readonly monogram: string;
	readonly isAvailable?: boolean;
	readonly defaultModel?: string | null;
	readonly defaultEffortTier?: string | null;
	readonly maxConcurrency?: number | null;
	/** daemon/feature 下发的当前占用数，缺失显示「—」，严禁组件层自算 (R1) */
	readonly usedConcurrency?: number | null;
	/** daemon/feature 下发的满额状态 (R1) */
	readonly isLimitReached?: boolean | null;
	readonly supportsEffort?: boolean;
	readonly models?: readonly string[];
}

/**
 * 单个任务的指派记录——字段与 daemon `TaskAssignmentDto` 同名同义，
 * `sessionNo` 即该任务派发后将使用的独立会话序号（E-31），由 daemon 下发，前端不推导。
 */
export interface TaskAssignmentSelection {
	readonly taskId: string;
	readonly taskKey: string;
	readonly agentId: string;
	readonly model: string | null;
	/** daemon 原样下发的思考强度三态（10 节 `EffortValue`） */
	readonly effort: EffortValue;
	/** daemon 下发的会话序号，缺失显示「—」 (R1) */
	readonly sessionNo: number | null;
}

/**
 * 并发瓶颈三值域来自 shared 契约（`CONCURRENCY_PREVIEW_BOTTLENECKS`），
 * 组件不另立枚举：M8-T1 的五值瓶颈由 daemon 收窄后才下发，越界即 E_INTERNAL。
 */
export type ConcurrencyBottleneckType = ConcurrencyPreviewBottleneck;

/**
 * 单个 agent 的并发容量（daemon `preview.agentCapacities[]` 原样呈现）。
 */
export interface AgentCapacityEntry {
	readonly agentId: string;
	readonly active: number;
	readonly limit: number;
	readonly drafted: number;
	readonly isFull: boolean;
}

/**
 * 并发审计与瓶颈数据（全部读 daemon 字段，缺失显示「—」，R1）。
 */
export interface ConcurrencyAuditData {
	/** 实际有效并发容量：daemon `preview.effectiveConcurrency` */
	readonly effectiveCapacity?: number | string | null;
	/** daemon `preview.windowCount`（本批此刻可放行任务数） */
	readonly windowCount?: number | string | null;
	/** 活跃 Agent 单体并发上限 */
	readonly agentLimit?: number | string | null;
	/** 用户设定并发上限，缺失显示「—」，严禁组件层补 2 缺省 (R1) */
	readonly userSetting?: number | null;
	/** daemon `preview.bottleneck` */
	readonly bottleneckSource?: ConcurrencyBottleneckType | string | null;
	/** 瓶颈详细说明文案 */
	readonly bottleneckDescription?: string | null;
	/** 是否退化为纯串行 (E-48) */
	readonly isDegradedToSerial?: boolean;
	/** daemon `preview.exceedsWindowCount`，严禁组件层自算比较 (R1) */
	readonly isExceedingWindow?: boolean | null;
	/** 是否显式解锁超过窗口数 (E-52) */
	readonly isUnlockedAboveWindow?: boolean;
	/** daemon `preview.agentCapacities`，逐 agent 原样呈现 (E-47) */
	readonly agentCapacities?: readonly AgentCapacityEntry[];
}

/**
 * 逐任务指派列表 Props。
 */
export interface TaskAssignmentListProps {
	/** 任务列表 */
	readonly tasks?: readonly TaskItem[];
	/** 可选 Agent 列表 */
	readonly agents?: readonly AssignableAgent[];
	/** 已存在的指派记录 */
	readonly assignments?: Readonly<Record<string, TaskAssignmentSelection>>;
	/** Agent 容量覆盖（可选显式下发） */
	readonly agentCapacities?: Readonly<Record<string, AgentCapacityInfo>>;
	/** 单任务指派完成或更新回调 */
	readonly onAssignTask?: (taskId: string, selection: TaskAssignmentSelection) => void;
	/** 单任务清除或重置回调 */
	readonly onResetAssignment?: (taskId: string) => void;
	/** 样式自定义类名 */
	readonly className?: string;
}

/**
 * 并发瓶颈说明卡片 Props。
 */
export interface ConcurrencyBottleneckCardProps {
	/** 并发审计数据（读 daemon 下发字段） */
	readonly audit?: ConcurrencyAuditData;
	/** 直接传入有效并发容量（缺失显示「—」） */
	readonly effectiveCapacity?: number | string | null;
	/** 直接传入并行窗口数（缺失显示「—」） */
	readonly windowCount?: number | string | null;
	/** 直接传入 Agent 单体并发上限（缺失显示「—」） */
	readonly agentLimit?: number | string | null;
	/** 直接传入用户设定并发上限（缺失显示「—」，禁补缺省 2） */
	readonly userSetting?: number | null;
	/** 直接传入瓶颈标识 */
	readonly bottleneckSource?: ConcurrencyBottleneckType | string | null;
	/** 直接传入瓶颈描述 */
	readonly bottleneckDescription?: string | null;
	/** 是否越界，由 daemon/feature 明确下发，禁前端比较 (R1) */
	readonly isExceedingWindow?: boolean | null;
	/** 是否显式解锁超过窗口数 (E-52) */
	readonly isUnlockedAboveWindow?: boolean;
	/** 逐 agent 容量（daemon `preview.agentCapacities`，缺失显示「—」） */
	readonly agentCapacities?: readonly AgentCapacityEntry[];
	/** 能否上调用户设定，由 daemon/feature 判定后下发；缺失显示「—」，组件不自行比较 (R1) */
	readonly canIncreaseUserSetting?: boolean | null;
	/** 能否下调用户设定，由 daemon/feature 判定后下发；缺失显示「—」 (R1) */
	readonly canDecreaseUserSetting?: boolean | null;
	/** 用户修改设定回调 (E-52) */
	readonly onChangeUserSetting?: (setting: number) => void;
	/** 切换解锁超过窗口数开关回调 (E-52) */
	readonly onToggleUnlockAboveWindow?: (unlocked: boolean) => void;
	/** 样式类名 */
	readonly className?: string;
}

/**
 * 指派面板主组件 Props。
 */
export interface AssignPanelProps {
	/** 模式：step3 仅逐任务指派，step4 仅并发审计，all 两者兼备 */
	readonly mode?: 'step3' | 'step4' | 'all';
	/** 当前四步引导中的步数 (2 = 第 3 步逐任务指派, 3 = 第 4 步并发审计) */
	readonly step?: number;
	/** 任务列表 */
	readonly tasks?: readonly TaskItem[];
	/** 可选 Agent 列表 */
	readonly agents?: readonly AssignableAgent[];
	/** 已存在的指派记录 */
	readonly assignments?: Readonly<Record<string, TaskAssignmentSelection>>;
	/** Agent 容量显式下发 */
	readonly agentCapacities?: Readonly<Record<string, AgentCapacityInfo>>;
	/** 单任务指派回调 */
	readonly onAssignTask?: (taskId: string, selection: TaskAssignmentSelection) => void;
	/** 重置单任务指派 */
	readonly onResetAssignment?: (taskId: string) => void;
	/** 并发审计数据 */
	readonly audit?: ConcurrencyAuditData;
	/** 并发独立属性（可选单独传递） */
	readonly effectiveCapacity?: number | string | null;
	readonly windowCount?: number | string | null;
	readonly agentLimit?: number | string | null;
	readonly userSetting?: number | null;
	readonly bottleneckSource?: ConcurrencyBottleneckType | string | null;
	readonly bottleneckDescription?: string | null;
	readonly isExceedingWindow?: boolean | null;
	readonly isUnlockedAboveWindow?: boolean;
	readonly canIncreaseUserSetting?: boolean | null;
	readonly canDecreaseUserSetting?: boolean | null;
	readonly onChangeUserSetting?: (setting: number) => void;
	readonly onToggleUnlockAboveWindow?: (unlocked: boolean) => void;
	/** 样式类名 */
	readonly className?: string;
}

/**
 * 默认空任务提示文案。
 */
const EMPTY_VALUE_FALLBACK = '—';

/**
 * 格式化数值字段，缺失时显示「—」（严格禁绝前端造假默认值，R1）。
 */
function renderFieldOrFallback(val: number | string | null | undefined): string {
	if (val === null || val === undefined || val === '') {
		return EMPTY_VALUE_FALLBACK;
	}
	return String(val);
}

/**
 * 依据 daemon 下发的瓶颈标识（三值域）派生中文说明（E-52，字段缺失显示「—」）。
 */
function deriveBottleneckSummary(
	source: ConcurrencyBottleneckType | string | null | undefined,
	details?: {
		windowCount?: number | string | null;
		agentLimit?: number | string | null;
		userSetting?: number | string | null;
	},
): { readonly label: string; readonly explanation: string } {
	if (!source) {
		return {
			label: EMPTY_VALUE_FALLBACK,
			explanation: '当前未报告明确并发瓶颈，调度器将按就绪状态顺序放行。',
		};
	}
	// 域外的值直接原样呈现：既不猜含义，也不落进某个已知瓶颈的文案
	return isPreviewBottleneck(source)
		? bottleneckSummaryOf(source, details)
		: { label: String(source), explanation: `瓶颈归因：${String(source)}` };
}

function isPreviewBottleneck(value: string): value is ConcurrencyPreviewBottleneck {
	return (CONCURRENCY_PREVIEW_BOTTLENECKS as readonly string[]).includes(value);
}

/**
 * 三值瓶颈各自的文案；无 default 分支，daemon 域加值即由 tsc 报缺分支。
 */
function bottleneckSummaryOf(
	source: ConcurrencyPreviewBottleneck,
	details?: {
		windowCount?: number | string | null;
		agentLimit?: number | string | null;
		userSetting?: number | string | null;
	},
): { readonly label: string; readonly explanation: string } {
	switch (source) {
		case 'window_count':
			return {
				label: '并行窗口数 (依赖拓扑)',
				explanation: `瓶颈归因：受批次内任务依赖或路径冲突限制，并行窗口上限为 ${renderFieldOrFallback(
					details?.windowCount,
				)}。`,
			};
		case 'agent_limit':
			return details?.agentLimit === null || details?.agentLimit === undefined
				? {
						// 逐 agent 数值由 daemon 的 preview.agentCapacities 列出，这里不替它合成一个标量
						label: 'Agent 单体并发上限',
						explanation:
							'瓶颈归因：所指派 Agent 的单体并发上限是三者中最小的一项（逐 agent 数值见上方因子），已满额时空位可顺延给别家（E-47）。',
					}
				: {
						label: 'Agent 单体并发上限',
						explanation: `瓶颈归因：所指派 Agent 的单体最大并发上限为 ${renderFieldOrFallback(
							details.agentLimit,
						)}，已满额时空位可顺延给别家（E-47）。`,
					};
		case 'user_setting':
			return {
				label: '用户设定并发上限',
				explanation: `瓶颈归因：受用户偏好设定上限 (${renderFieldOrFallback(
					details?.userSetting,
				)}) 约束，可按需在下方调节上限。`,
			};
	}
}

/**
 * 焦点环与无障碍样式（R3: 规定的 focus-visible 环，移除无替代的 outline-none）。
 */
const FOCUS_VISIBLE_RING_CLASS =
	'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--needs-soft)]';

/**
 * 单任务指派行组件。
 * R1: 删除组件层对默认 agent／模型／思考强度、会话序号的补算，全部读 props，缺失显示「—」。
 * R3: 交互按钮在手机端触控区至少 44×44。
 */
interface TaskAssignRowProps {
	readonly task: TaskItem;
	readonly agents: readonly AssignableAgent[];
	readonly assignment?: TaskAssignmentSelection;
	readonly agentCapacities?: Readonly<Record<string, AgentCapacityInfo>>;
	readonly onSave: (selection: TaskAssignmentSelection) => void;
	readonly onReset?: () => void;
}

function TaskAssignRow({
	task,
	agents,
	assignment,
	agentCapacities,
	onSave,
	onReset,
}: TaskAssignRowProps) {
	const rowId = useId();
	const isAlreadyAssigned = Boolean(assignment);
	const [isEditing, setIsEditing] = useState<boolean>(!isAlreadyAssigned);

	// R1: 删除组件层对默认 agent 的补算（不使用 agents[0] 垫背），缺失即未选
	const initialAgentId = assignment?.agentId ?? task.defaultAgentId ?? '';
	const [selectedAgentId, setSelectedAgentId] = useState<string>(initialAgentId);

	// 查找所选 Agent
	const currentAgent = useMemo(() => {
		if (!selectedAgentId) return null;
		return agents.find((a) => a.id === selectedAgentId) ?? null;
	}, [agents, selectedAgentId]);

	// 可用模型清单
	const availableModels = useMemo(() => {
		return currentAgent?.models ?? [];
	}, [currentAgent]);

	// R1: 删除组件层对默认模型的补算，缺失即空，显示「跟随 agent 配置」
	const initialModel = assignment?.model ?? task.defaultModel ?? '';
	const [selectedModel, setSelectedModel] = useState<string>(initialModel);

	// R1: 删除组件层对思考强度的补算（不私自补 medium），不支持或未指定则为 null
	const supportsEffort = currentAgent?.supportsEffort ?? false;
	const assignedEffort: EffortValue = assignment?.effort ?? null;
	const initialEffortTier: EffortTier | null =
		assignedEffort !== null && 'tier' in assignedEffort
			? assignedEffort.tier
			: supportsEffort
				? ((task.defaultEffortTier as EffortTier | null | undefined) ?? null)
				: null;
	const [selectedEffortTier, setSelectedEffortTier] = useState<EffortTier | null>(
		initialEffortTier,
	);

	// 切换 Agent 联动（M4-T6, E-34, E-254）
	const handleAgentChange = (newAgentId: string) => {
		setSelectedAgentId(newAgentId);
		// 切换 agent 清空模型覆盖（E-34）
		setSelectedModel('');
		// 不支持思考强度置 null，严禁前端补默认档（E-254）
		setSelectedEffortTier(null);
	};

	// R1: 会话序号直接读 daemon 下发的草稿字段，严禁组件层自算
	const effectiveSessionNo = assignment ? assignment.sessionNo : (task.sessionIndex ?? null);
	const sessionDisplay =
		effectiveSessionNo === null || effectiveSessionNo === undefined
			? EMPTY_VALUE_FALLBACK
			: `会话 #${effectiveSessionNo}`;

	// 编辑态里的会话序号同样来自 daemon：草稿未写入前 daemon 还没有编号，显示「—」
	const pendingSessionDisplay = `${EMPTY_VALUE_FALLBACK}`;

	// R1: Agent 容量与满额状态读下发 props，严禁组件层自算
	const capacityInfo = currentAgent ? agentCapacities?.[currentAgent.id] : undefined;
	const isAgentLimitExceeded = Boolean(
		currentAgent?.isLimitReached ?? capacityInfo?.isFull ?? false,
	);
	const agentMaxConcurrency = currentAgent?.maxConcurrency ?? capacityInfo?.max ?? null;
	const agentUsedConcurrency = currentAgent?.usedConcurrency ?? capacityInfo?.used ?? null;

	// 保存指派：只回报用户原始意图，序号与容量等事实等 daemon 返回值刷新
	const handleSave = () => {
		if (!selectedAgentId) return;
		const selection: TaskAssignmentSelection = {
			taskId: task.id,
			taskKey: task.taskKey,
			agentId: selectedAgentId,
			model: selectedModel.length > 0 ? selectedModel : null,
			effort: supportsEffort && selectedEffortTier ? { tier: selectedEffortTier } : null,
			sessionNo: effectiveSessionNo,
		};
		onSave(selection);
		setIsEditing(false);
	};

	// ─────────────────────────────────────────────────────────────
	// 态 1：已指派展示态（回显所选值，提供回改入口，AC 1, AC 2, E-108, E-31, R1-R3）
	// ─────────────────────────────────────────────────────────────
	if (isAlreadyAssigned && !isEditing && assignment) {
		const assignedAgentObj = agents.find((a) => a.id === assignment.agentId);
		const agentMonogram =
			assignedAgentObj?.monogram ??
			(assignment.agentId ? assignment.agentId.slice(0, 2).toUpperCase() : EMPTY_VALUE_FALLBACK);
		const agentName = assignedAgentObj?.name ?? assignment.agentId ?? EMPTY_VALUE_FALLBACK;
		const modelDisplay = assignment.model ? assignment.model : '跟随 agent 配置';
		const effortDisplay =
			assignment.effort === null
				? EMPTY_VALUE_FALLBACK
				: 'tier' in assignment.effort
					? assignment.effort.tier
					: assignment.effort.vendor;

		return (
			<div
				data-task-assigned-row={task.taskKey}
				data-testid={`assigned-row-${task.taskKey}`}
				className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 rounded border border-border bg-panel-2 transition-colors hover:border-border-strong"
			>
				{/* 任务标头与信息 */}
				<div className="flex flex-col gap-1 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						<span className="font-mono text-dense font-bold text-ink-1">{task.taskKey}</span>
						<span className="text-dense text-ink-2 truncate max-w-[280px]" title={task.title}>
							{task.title}
						</span>
						{task.moduleKey && (
							<span className="font-mono text-micro text-ink-3 px-1.5 py-0.5 rounded bg-bg border border-border">
								{task.moduleKey}
							</span>
						)}
					</div>
					{/* 已指派回显（AC 1, AC 2, E-31 独立会话序号） */}
					<div className="flex items-center gap-2.5 text-micro font-mono flex-wrap mt-0.5">
						<span className="flex items-center gap-1 text-ink-1">
							<span className="px-1.5 py-0.5 rounded bg-bg border border-border text-ink-2 font-bold text-micro">
								{agentMonogram}
							</span>
							<span className="font-ui text-ink-1">{agentName}</span>
						</span>
						{/* 独立会话序号徽标（AC 2, E-31，R1: 读下发 props，缺失显示 —） */}
						<span
							data-session-badge={effectiveSessionNo ?? EMPTY_VALUE_FALLBACK}
							className="px-2 py-0.5 rounded border border-auto-soft bg-auto-soft text-auto font-bold text-micro"
							title="同一个 agent 允许多次指派，独立会话序号读 daemon 字段（E-31）"
						>
							{sessionDisplay}
						</span>
						<span className="text-ink-3">|</span>
						<span className="text-ink-2" title={`模型: ${modelDisplay}`}>
							模型: <span className="text-ink-1">{modelDisplay}</span>
						</span>
						<span className="text-ink-3">|</span>
						<span className="text-ink-2" title={`思考强度: ${effortDisplay}`}>
							思考: <span className="text-ink-1">{effortDisplay}</span>
						</span>
					</div>
				</div>

				{/* 回改修改动作按钮（AC 1, R3: 44x44 触控目标与 focus-visible 环） */}
				<div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
					<button
						type="button"
						data-action="edit-assignment"
						onClick={() => setIsEditing(true)}
						className={`min-h-[44px] min-w-[44px] sm:min-h-[32px] sm:min-w-0 px-3 rounded-sm border border-border bg-bg text-ink-2 hover:text-ink-1 hover:border-needs text-dense transition-colors flex items-center justify-center ${FOCUS_VISIBLE_RING_CLASS}`}
						aria-label={`修改任务 ${task.taskKey} 的指派`}
					>
						修改指派
					</button>
					{onReset && (
						<button
							type="button"
							data-action="reset-assignment"
							onClick={() => onReset()}
							className={`min-h-[44px] min-w-[44px] sm:min-h-[32px] sm:min-w-0 px-2 rounded-sm border border-transparent text-ink-3 hover:text-down text-micro transition-colors flex items-center justify-center ${FOCUS_VISIBLE_RING_CLASS}`}
							aria-label={`重置任务 ${task.taskKey} 的指派`}
						>
							重置
						</button>
					)}
				</div>
			</div>
		);
	}

	// ─────────────────────────────────────────────────────────────
	// 态 2：编辑指派表单态（逐任务单独指派，AC 1, AC 2, AC 4, E-47, E-108, R1-R3）
	// ─────────────────────────────────────────────────────────────
	return (
		<div
			data-task-editing-row={task.taskKey}
			data-testid={`editing-row-${task.taskKey}`}
			className="flex flex-col gap-3 p-3.5 rounded border border-needs bg-bg"
		>
			{/* 任务标头 */}
			<div className="flex items-center justify-between gap-2 flex-wrap">
				<div className="flex items-center gap-2">
					<span className="font-mono text-dense font-bold text-ink-1">{task.taskKey}</span>
					<span className="text-dense text-ink-1 font-semibold truncate max-w-[320px]">
						{task.title}
					</span>
					{task.moduleKey && (
						<span className="font-mono text-micro text-ink-3 px-1.5 py-0.5 rounded bg-panel-2 border border-border">
							{task.moduleKey}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					{/* 会话序号：草稿写入后由 daemon 编号，未写入前显示「—」（E-31, R1） */}
					<span
						data-next-session-preview={pendingSessionDisplay}
						className="text-micro font-mono text-auto bg-auto-soft border border-auto-soft px-2 py-0.5 rounded"
						title="会话序号由调度器在下发草稿时编号（E-31）"
					>
						会话序号: {pendingSessionDisplay}
					</span>
				</div>
			</div>

			{/* Agent 满额提示条（AC 4, E-47，R1: 读 daemon 字段，缺失不妄判） */}
			{isAgentLimitExceeded && currentAgent && (
				<div
					data-testid="agent-limit-warning"
					className="flex items-center justify-between text-micro text-needs p-2 rounded bg-needs-soft border border-needs font-mono"
				>
					<span>
						⚠️ Agent「{currentAgent.name}」已达并发上限 (
						{renderFieldOrFallback(agentUsedConcurrency)}/
						{renderFieldOrFallback(agentMaxConcurrency)}
						)。本任务启动时需排队；其余任务可继续指派给别家 Agent，不空转等待（E-47）。
					</span>
				</div>
			)}

			{/* 表单控件区：三联控件（Agent / 模型 / 思考强度，R3: 44px 触控目标 + focus-visible 环） */}
			<div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 pt-1">
				{/* 1. 选择 Agent */}
				<div className="flex flex-col gap-1">
					<label htmlFor={`agent-select-${rowId}`} className="text-micro text-ink-3 font-mono">
						执行 Agent
					</label>
					<select
						id={`agent-select-${rowId}`}
						data-testid={`select-agent-${task.taskKey}`}
						value={selectedAgentId}
						onChange={(e) => handleAgentChange(e.target.value)}
						className={`min-h-[44px] sm:min-h-[32px] h-input px-2.5 rounded-sm border border-border bg-panel-2 text-ink-1 text-dense font-mono transition-colors ${FOCUS_VISIBLE_RING_CLASS}`}
					>
						<option value="">请选择 Agent...</option>
						{agents.map((ag) => {
							const cap = agentCapacities?.[ag.id];
							const usedStr = renderFieldOrFallback(ag.usedConcurrency ?? cap?.used);
							const maxStr = renderFieldOrFallback(ag.maxConcurrency ?? cap?.max);
							// daemon 未下发满额状态时不替它下结论，显示「—」
							const fullState = ag.isLimitReached ?? cap?.isFull ?? null;
							const fullMark =
								fullState === null
									? ` [${EMPTY_VALUE_FALLBACK}]`
									: fullState
										? ' [已满额]'
										: ' [可用]';
							return (
								<option key={ag.id} value={ag.id}>
									{ag.name} ({ag.monogram}) — {usedStr}/{maxStr}
									{fullMark}
								</option>
							);
						})}
					</select>
				</div>

				{/* 2. 选择模型（只列当前 Agent 模型，支持留空跟随 agent 配置，M4-T6, E-34, E-35, E-41） */}
				<div className="flex flex-col gap-1">
					<label htmlFor={`model-select-${rowId}`} className="text-micro text-ink-3 font-mono">
						模型配置 (M4-T6)
					</label>
					<select
						id={`model-select-${rowId}`}
						data-testid={`select-model-${task.taskKey}`}
						value={selectedModel}
						onChange={(e) => setSelectedModel(e.target.value)}
						className={`min-h-[44px] sm:min-h-[32px] h-input px-2.5 rounded-sm border border-border bg-panel-2 text-ink-1 text-dense font-mono transition-colors ${FOCUS_VISIBLE_RING_CLASS}`}
					>
						<option value="">跟随 agent 默认配置 (不传 --model)</option>
						{availableModels.map((m) => (
							<option key={m} value={m}>
								{m}
							</option>
						))}
					</select>
				</div>

				{/* 3. 选择思考强度（未选 agent 不下结论；不支持时显示「—」，绝不补假默认档，M4-T6, E-254） */}
				<div className="flex flex-col gap-1">
					<label htmlFor={`effort-select-${rowId}`} className="text-micro text-ink-3 font-mono">
						思考强度{' '}
						{currentAgent === null ? '(请先选择 Agent)' : supportsEffort ? '(可调)' : '(不支持)'}
					</label>
					{currentAgent !== null && supportsEffort ? (
						<select
							id={`effort-select-${rowId}`}
							data-testid={`select-effort-${task.taskKey}`}
							value={selectedEffortTier ?? ''}
							onChange={(e) => setSelectedEffortTier((e.target.value || null) as EffortTier | null)}
							className={`min-h-[44px] sm:min-h-[32px] h-input px-2.5 rounded-sm border border-border bg-panel-2 text-ink-1 text-dense font-mono transition-colors ${FOCUS_VISIBLE_RING_CLASS}`}
						>
							<option value="">未指定 (跟随默认)</option>
							<option value="low">低档 (low)</option>
							<option value="medium">中档 (medium)</option>
							<option value="high">高档 (high)</option>
						</select>
					) : (
						<div
							id={`effort-select-${rowId}`}
							data-testid={
								currentAgent === null
									? `effort-pending-${task.taskKey}`
									: `effort-unsupported-${task.taskKey}`
							}
							className="flex min-h-[44px] sm:min-h-[32px] h-input items-center px-2.5 rounded-sm border border-border bg-panel-2 text-ink-3 font-mono text-dense select-none cursor-not-allowed"
							title={
								currentAgent === null
									? '尚未选择执行 Agent，思考强度档位等 daemon 下发的能力位（E-254）'
									: '该 Agent 原生不支持思考强度参数，UI 显示 —，派发不传参（E-254）'
							}
						>
							<span>{EMPTY_VALUE_FALLBACK}</span>
							<span className="text-micro ml-2 text-ink-3">
								{currentAgent === null ? '(待选择 Agent)' : '(不支持思考档位)'}
							</span>
						</div>
					)}
				</div>
			</div>

			{/* 底部确认与取消（R3: 44px 触控目标与 focus-visible 环） */}
			<div className="flex items-center justify-between pt-1 border-t border-border mt-1">
				<div className="text-micro text-ink-3 font-mono">
					{isAlreadyAssigned ? '修改单任务指派' : '逐任务独立指定，严禁整批统一套用'}
				</div>
				<div className="flex items-center gap-2">
					{isAlreadyAssigned && (
						<button
							type="button"
							onClick={() => setIsEditing(false)}
							className={`min-h-[44px] min-w-[44px] sm:min-h-[32px] sm:min-w-0 px-3 rounded-sm border border-border bg-panel-2 text-ink-2 hover:text-ink-1 text-dense flex items-center justify-center ${FOCUS_VISIBLE_RING_CLASS}`}
						>
							取消
						</button>
					)}
					<button
						type="button"
						data-action="confirm-task-assign"
						onClick={handleSave}
						className={`min-h-[44px] min-w-[44px] sm:min-h-[32px] sm:min-w-0 px-4 rounded-sm bg-needs text-on-needs font-bold text-dense hover:brightness-105 transition-colors flex items-center justify-center ${FOCUS_VISIBLE_RING_CLASS}`}
					>
						确认指派
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * ─────────────────────────────────────────────────────────────
 * 逐任务指派列表展示组件（AC 1, AC 2, AC 4, E-108, E-31, E-47）
 * ─────────────────────────────────────────────────────────────
 */
export function TaskAssignmentList({
	tasks = [],
	agents = [],
	assignments = {},
	agentCapacities,
	onAssignTask,
	onResetAssignment,
	className = '',
}: TaskAssignmentListProps) {
	const assignedCount = Object.keys(assignments).length;
	const totalTasks = tasks.length;

	return (
		<div
			data-testid="task-assignment-list"
			className={`flex flex-col gap-3 rounded border border-border bg-bg p-4 ${className}`}
		>
			{/* 顶栏：指派进度与容量总览（AC 1, AC 4, E-47, R1: 读下发字段，缺失显示 —） */}
			<div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pb-2 border-b border-border">
				<div>
					<h4 className="text-dense font-semibold text-ink-1">
						逐任务执行指派 ({assignedCount}/{totalTasks})
					</h4>
					<p className="text-meta text-ink-2">
						每行任务独立配置 Agent、模型与思考强度；已指派行可随时点回改（E-108）。
					</p>
				</div>
				{/* 动态 Agent 容量指标行（AC 4, E-47，R1: 读下发字段，缺失显示 —） */}
				<div
					data-testid="agent-capacity-overview"
					className="flex items-center gap-2 flex-wrap text-micro font-mono"
				>
					{agents.map((ag) => {
						const cap = agentCapacities?.[ag.id];
						const usedStr = renderFieldOrFallback(ag.usedConcurrency ?? cap?.used);
						const maxStr = renderFieldOrFallback(ag.maxConcurrency ?? cap?.max);
						const isFull = Boolean(ag.isLimitReached ?? cap?.isFull);
						return (
							<span
								key={ag.id}
								data-agent-capacity={ag.id}
								className={`px-2 py-0.5 rounded border ${
									isFull
										? 'border-needs bg-needs-soft text-needs font-bold'
										: 'border-border bg-panel-2 text-ink-2'
								}`}
								title={
									isFull
										? `${ag.name} 单体并发已满 (${usedStr}/${maxStr})，空位顺延给其他 Agent，不空转等待（E-47）`
										: `${ag.name} 当前已分配 ${usedStr}/${maxStr}`
								}
							>
								{ag.name}: {usedStr}/{maxStr}
								{isFull ? ' (已满)' : ''}
							</span>
						);
					})}
				</div>
			</div>

			{/* 任务列表内容区 */}
			{tasks.length > 0 ? (
				<div className="flex flex-col gap-2.5">
					{tasks.map((task) => {
						const currentAssignment = assignments[task.id];

						return (
							<TaskAssignRow
								key={task.id}
								task={task}
								agents={agents}
								assignment={currentAssignment}
								agentCapacities={agentCapacities}
								onSave={(draft) => onAssignTask?.(task.id, draft)}
								onReset={() => onResetAssignment?.(task.id)}
							/>
						);
					})}
				</div>
			) : (
				<div
					data-testid="empty-tasks"
					className="p-8 text-center font-mono text-meta text-ink-3 rounded border border-border bg-page"
				>
					{EMPTY_VALUE_FALLBACK}
				</div>
			)}
		</div>
	);
}

/**
 * ─────────────────────────────────────────────────────────────
 * 并发限制审计与瓶颈归因卡片（AC 3, E-52, E-47, E-48, R1-R3）
 * ─────────────────────────────────────────────────────────────
 */
export function ConcurrencyBottleneckCard({
	audit,
	effectiveCapacity,
	windowCount,
	agentLimit,
	userSetting,
	bottleneckSource,
	bottleneckDescription,
	isExceedingWindow,
	isUnlockedAboveWindow = false,
	agentCapacities,
	canIncreaseUserSetting,
	canDecreaseUserSetting,
	onChangeUserSetting,
	onToggleUnlockAboveWindow,
	className = '',
}: ConcurrencyBottleneckCardProps) {
	// 属性融合（优先读 audit 字段，无则读平铺 props）
	const effCap = audit?.effectiveCapacity ?? effectiveCapacity ?? null;
	const winCount = audit?.windowCount ?? windowCount ?? null;
	const agLimit = audit?.agentLimit ?? agentLimit ?? null;
	// R1: 彻底删除用户设定补 2 缺省，缺失即为 null，渲染「—」
	const usrSet = audit?.userSetting ?? userSetting ?? null;
	const bSource = audit?.bottleneckSource ?? bottleneckSource ?? null;
	const bDesc = audit?.bottleneckDescription ?? bottleneckDescription ?? null;
	const isUnlocked = audit?.isUnlockedAboveWindow ?? isUnlockedAboveWindow;
	// daemon `preview.agentCapacities` 原样呈现（E-47），组件不聚合、不取最小值
	const capacities = audit?.agentCapacities ?? agentCapacities ?? [];
	// R1: 越界能力读 daemon/feature 显式字段，严禁组件层自算比较
	const isExceeding = Boolean(audit?.isExceedingWindow ?? isExceedingWindow ?? false);
	// R1: 能否增减读 daemon/feature 下发字段；缺失即不可点，不替调度器判断
	const canIncrease = canIncreaseUserSetting ?? false;
	const canDecrease = canDecreaseUserSetting ?? false;

	// 解析瓶颈分析人类说明
	const bottleneckInfo = deriveBottleneckSummary(bSource, {
		windowCount: winCount,
		agentLimit: agLimit,
		userSetting: usrSet,
	});

	// 用户调节设定动作：回调只传原始意图，越界与上限由 daemon 裁定
	const handleDecrease = () => {
		if (onChangeUserSetting && typeof usrSet === 'number' && canDecrease) {
			onChangeUserSetting(usrSet - 1);
		}
	};

	const handleIncrease = () => {
		if (!onChangeUserSetting || typeof usrSet !== 'number' || !canIncrease) return;
		onChangeUserSetting(usrSet + 1);
	};

	return (
		<div
			data-testid="concurrency-bottleneck-card"
			className={`flex flex-col gap-4 p-4 rounded border border-border bg-panel-2 text-meta ${className}`}
		>
			{/* 头部：有效并发容量（min 三者取 min 结果，R1: 缺失显示 —） */}
			<div className="flex items-center justify-between border-b border-border pb-3">
				<div>
					<span className="font-semibold text-ink-1 text-dense">有效并行并发容量</span>
					<p className="text-micro text-ink-3 mt-0.5">
						实际并发取 min(窗口数, 每 agent 上限, 用户设定)，不只给一个数字（E-52）。
					</p>
				</div>
				<div className="flex items-baseline gap-1.5 font-mono">
					<span
						data-testid="effective-capacity-value"
						className="text-num-lg font-bold text-needs leading-none"
					>
						{renderFieldOrFallback(effCap)}
					</span>
					<span className="text-micro text-ink-3">并发槽位</span>
				</div>
			</div>

			{/* 三因子对比网格（明确指出三者数值与哪一个是瓶颈，AC 3, E-52, R1: 缺失显示 —） */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 font-mono text-micro">
				{/* 因子 1：并行窗口数 */}
				<div
					data-factor="window_count"
					className={`flex flex-col justify-between p-2.5 rounded bg-bg border ${
						bSource === 'window_count' ? 'border-needs bg-needs-soft' : 'border-border'
					}`}
				>
					<div className="flex items-center justify-between">
						<span className="text-ink-3">并行窗口数</span>
						{bSource === 'window_count' && (
							<span
								data-testid="bottleneck-badge-window"
								className="px-1 py-0.2 rounded bg-needs text-on-needs font-bold text-micro"
							>
								瓶颈
							</span>
						)}
					</div>
					<div className="text-dense font-bold text-ink-1 mt-2">
						{renderFieldOrFallback(winCount)}
					</div>
					<span className="text-micro text-ink-3 mt-1">调度器依赖拓扑计算</span>
				</div>

				{/* 因子 2：Agent 单体并发上限 */}
				<div
					data-factor="agent_limit"
					className={`flex flex-col justify-between p-2.5 rounded bg-bg border ${
						bSource === 'agent_limit' ? 'border-needs bg-needs-soft' : 'border-border'
					}`}
				>
					<div className="flex items-center justify-between">
						<span className="text-ink-3">Agent 基础上限</span>
						{bSource === 'agent_limit' && (
							<span
								data-testid="bottleneck-badge-agent"
								className="px-1 py-0.2 rounded bg-needs text-on-needs font-bold text-micro"
							>
								瓶颈
							</span>
						)}
					</div>
					{/* 逐 agent 容量：daemon `preview.agentCapacities` 原样列出（E-47）；无标量时以它作为因子值 */}
					<div
						data-testid="agent-capacity-factors"
						className={
							agLimit === null || agLimit === undefined
								? 'text-micro font-bold text-ink-1 mt-2'
								: 'text-micro text-ink-3 mt-1'
						}
					>
						{capacities.length > 0
							? capacities
									.map(
										(capacity) =>
											`${capacity.agentId} ${capacity.active + capacity.drafted}/${capacity.limit}${
												capacity.isFull ? ' 已满额' : ''
											}`,
									)
									.join(' · ')
							: EMPTY_VALUE_FALLBACK}
					</div>
					{(agLimit === null || agLimit === undefined) && (
						<span className="text-micro text-ink-3 mt-1">单 Agent 最大会话配额</span>
					)}
				</div>

				{/* 因子 3：用户设定上限（可调节，E-52, R1: 缺失显示 —, R3: 44x44 触控目标） */}
				<div
					data-factor="user_setting"
					className={`flex flex-col justify-between p-2.5 rounded bg-bg border ${
						bSource === 'user_setting' ? 'border-needs bg-needs-soft' : 'border-border'
					}`}
				>
					<div className="flex items-center justify-between">
						<span className="text-ink-3">用户偏好设定</span>
						{bSource === 'user_setting' && (
							<span
								data-testid="bottleneck-badge-user"
								className="px-1 py-0.2 rounded bg-needs text-on-needs font-bold text-micro"
							>
								瓶颈
							</span>
						)}
					</div>
					<div className="flex items-center justify-between mt-2">
						<span
							data-testid="user-setting-value"
							className="text-dense font-bold text-ink-1 font-mono"
						>
							{renderFieldOrFallback(usrSet)}
						</span>
						{onChangeUserSetting && (
							<div className="flex items-center rounded border border-border bg-panel-2">
								<button
									type="button"
									data-action="decrease-user-setting"
									onClick={handleDecrease}
									disabled={!canDecrease}
									className={`min-h-[44px] min-w-[44px] sm:min-h-[32px] sm:min-w-[32px] flex items-center justify-center text-ink-2 hover:text-ink-1 disabled:opacity-30 rounded-sm ${FOCUS_VISIBLE_RING_CLASS}`}
									aria-label="调小用户并发设定"
								>
									-
								</button>
								<button
									type="button"
									data-action="increase-user-setting"
									onClick={handleIncrease}
									disabled={!canIncrease}
									className={`min-h-[44px] min-w-[44px] sm:min-h-[32px] sm:min-w-[32px] flex items-center justify-center text-ink-2 hover:text-ink-1 disabled:opacity-30 rounded-sm ${FOCUS_VISIBLE_RING_CLASS}`}
									aria-label="调大用户并发设定"
								>
									+
								</button>
							</div>
						)}
					</div>
					<span className="text-micro text-ink-3 mt-1">可向下调/向上解锁</span>
				</div>
			</div>

			{/* 瓶颈明确归因说明（AC 3, E-52: 明确指出是并行窗口、该 agent 上限还是用户设定成了瓶颈） */}
			<div
				data-testid="bottleneck-analysis-section"
				className="flex flex-col gap-1.5 p-3 rounded bg-bg border border-border text-micro"
			>
				<div className="flex items-center gap-2">
					<span className="font-mono font-bold text-needs">瓶颈判定：</span>
					<span data-testid="bottleneck-source-name" className="font-mono font-semibold text-ink-1">
						{bottleneckInfo.label}
					</span>
				</div>
				<p
					data-testid="bottleneck-description-text"
					className="text-ink-2 font-mono leading-relaxed"
				>
					{bDesc || bottleneckInfo.explanation}
				</p>
			</div>

			{/* 向上超过窗口数显式解锁与后果提示（E-52, R1: 读下发 isExceedingWindow, R3: 44px 触控目标） */}
			{onChangeUserSetting && onToggleUnlockAboveWindow && (
				<div
					data-testid="unlock-above-window-container"
					className="flex flex-col gap-2 p-2.5 rounded bg-bg border border-border text-micro font-mono"
				>
					<label className="flex items-center gap-2 cursor-pointer text-ink-1 min-h-[44px] py-1">
						<input
							type="checkbox"
							data-action="toggle-unlock-above-window"
							checked={isUnlocked}
							onChange={(e) => onToggleUnlockAboveWindow(e.target.checked)}
							className={`h-5 w-5 rounded border-border bg-panel-2 text-needs cursor-pointer ${FOCUS_VISIBLE_RING_CLASS}`}
						/>
						<span className="font-semibold select-none">显式解锁超过并行窗口数设定 (E-52)</span>
					</label>

					{/* R1: isExceeding 读下发字段 */}
					{isExceeding && (
						<div
							data-testid="exceed-window-warning"
							className="text-needs bg-needs-soft border border-needs p-2 rounded text-micro"
						>
							⚠️ 后果提示：当前用户设定 ({renderFieldOrFallback(usrSet)}) 已超过依赖窗口数 (
							{renderFieldOrFallback(winCount)}
							)。实际运行受任务前后依赖与路径冲突限制，超出部分将排队，并不会带来额外的物理并发加速。
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * ─────────────────────────────────────────────────────────────
 * AssignPanel 主入口容器组件（逐任务指派面板与并发瓶颈说明）
 * ─────────────────────────────────────────────────────────────
 */
export function AssignPanel({
	mode = 'all',
	step,
	tasks = [],
	agents = [],
	assignments = {},
	agentCapacities,
	onAssignTask,
	onResetAssignment,
	audit,
	effectiveCapacity,
	windowCount,
	agentLimit,
	userSetting,
	bottleneckSource,
	bottleneckDescription,
	isExceedingWindow,
	isUnlockedAboveWindow,
	canIncreaseUserSetting,
	canDecreaseUserSetting,
	onChangeUserSetting,
	onToggleUnlockAboveWindow,
	className = '',
}: AssignPanelProps) {
	// 如果由 step 控制：step 2 代表第 3 步（逐任务指派），step 3 代表第 4 步（并发说明）
	const effectiveMode = step === 2 ? 'step3' : step === 3 ? 'step4' : mode;

	return (
		<div data-testid="assign-panel-root" className={`flex flex-col gap-4 ${className}`}>
			{/* 第 3 步正文：逐任务指派面板（AC 1, AC 2, AC 4, E-108, E-31, E-47） */}
			{(effectiveMode === 'step3' || effectiveMode === 'all') && (
				<TaskAssignmentList
					tasks={tasks}
					agents={agents}
					assignments={assignments}
					agentCapacities={agentCapacities}
					onAssignTask={onAssignTask}
					onResetAssignment={onResetAssignment}
				/>
			)}

			{/* 第 4 步正文：并发瓶颈审计说明卡片（AC 3, E-52） */}
			{(effectiveMode === 'step4' || effectiveMode === 'all') && (
				<ConcurrencyBottleneckCard
					audit={audit}
					effectiveCapacity={effectiveCapacity}
					windowCount={windowCount}
					agentLimit={agentLimit}
					userSetting={userSetting}
					bottleneckSource={bottleneckSource}
					bottleneckDescription={bottleneckDescription}
					isExceedingWindow={isExceedingWindow}
					isUnlockedAboveWindow={isUnlockedAboveWindow}
					canIncreaseUserSetting={canIncreaseUserSetting}
					canDecreaseUserSetting={canDecreaseUserSetting}
					onChangeUserSetting={onChangeUserSetting}
					onToggleUnlockAboveWindow={onToggleUnlockAboveWindow}
				/>
			)}
		</div>
	);
}

export default AssignPanel;
