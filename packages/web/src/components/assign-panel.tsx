/**
 * packages/web/src/components/assign-panel.tsx
 *
 * 逐任务指派面板与并发瓶颈说明组件（M9-T18 / AC 1-4, E-108, E-31, E-47, E-52）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 四步引导第三步是「逐任务指派」而不是「给整批选一个模型」：每行一个任务，各自选 agent／模型／思考强度，已指派行显示所选值可点回改（AC 1, E-108）
 * - 同一个 agent 允许被指派多次，每次是一个独立会话并显示将要使用的会话序号（AC 2, E-31, 决策 7, 决策 52）
 * - 第四步显示并发三者取 min 的结果，并明确指出是并行窗口、该 agent 上限还是用户设定成了瓶颈，不只给一个可放行数字（AC 3, E-52）
 * - 某 agent 已达并发上限时其余任务仍可指派给别家，不空转等待（AC 4, E-47 的呈现侧）
 * - 用户可向下调用户设定，向上超过窗口数需显式解锁并提示后果（E-52）
 * - 模型下拉只列当前 agent 的清单，切换 agent 时清空覆盖（M4-T6, E-34）
 * - 不支持思考强度的 agent 显示「—」，绝不补默认档冒充（M4-T6, E-254）
 * - 模型为空时允许留空表示「跟随 agent 配置」（E-35, E-41）
 * - 纯展示组件（components 纯 props in / callback out），颜色全走 CSS 变量（check-forbidden 机检）
 */

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
	readonly defaultAgentId?: string;
	readonly defaultModel?: string | null;
	readonly defaultEffortTier?: string | null;
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
	readonly maxConcurrency: number;
	readonly supportsEffort?: boolean;
	readonly models?: readonly string[];
}

/**
 * 单个任务的指派草稿。
 */
export interface TaskAssignmentDraft {
	readonly taskId: string;
	readonly taskKey: string;
	readonly title: string;
	readonly agentKey: string;
	readonly modelName: string;
	readonly effortTier?: string | null;
	readonly sessionIndex?: number;
}

/**
 * 并发瓶颈分类枚举（与 daemon CONCURRENCY_BOTTLENECKS 一致）。
 */
export const CONCURRENCY_BOTTLENECK_TYPES = {
	USER_SETTING: 'user_setting',
	WINDOW_COUNT: 'window_count',
	AGENT_LIMIT: 'agent_limit',
	MACHINE_RESOURCE: 'machine_resource',
	PATH_CONFLICT: 'path_conflict',
} as const;

export type ConcurrencyBottleneckType =
	(typeof CONCURRENCY_BOTTLENECK_TYPES)[keyof typeof CONCURRENCY_BOTTLENECK_TYPES];

/**
 * 并发审计与瓶颈数据。
 */
export interface ConcurrencyAuditData {
	/** 实际有效并发容量：min(窗口数, 每 agent 上限, 用户设定...)，读 daemon 字段 */
	readonly effectiveCapacity?: number | string | null;
	/** 拓扑并行窗口数 */
	readonly windowCount?: number | string | null;
	/** 活跃 Agent 单体并发上限 */
	readonly agentLimit?: number | string | null;
	/** 用户设定并发上限 */
	readonly userSetting?: number | null;
	/** 瓶颈标识 */
	readonly bottleneckSource?: ConcurrencyBottleneckType | string | null;
	/** 瓶颈详细说明文案 */
	readonly bottleneckDescription?: string | null;
	/** 是否退化为纯串行 (E-48) */
	readonly isDegradedToSerial?: boolean;
	/** 是否显式解锁超过窗口数 (E-52) */
	readonly isUnlockedAboveWindow?: boolean;
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
	readonly assignments?: Readonly<Record<string, TaskAssignmentDraft>>;
	/** 单任务指派完成或更新回调 */
	readonly onAssignTask?: (taskId: string, draft: TaskAssignmentDraft) => void;
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
	/** 直接传入有效并发容量（当未传 audit 对象时兜底） */
	readonly effectiveCapacity?: number | string | null;
	/** 直接传入并行窗口数 */
	readonly windowCount?: number | string | null;
	/** 直接传入 Agent 单体并发上限 */
	readonly agentLimit?: number | string | null;
	/** 直接传入用户设定并发上限 */
	readonly userSetting?: number | null;
	/** 直接传入瓶颈标识 */
	readonly bottleneckSource?: ConcurrencyBottleneckType | string | null;
	/** 直接传入瓶颈描述 */
	readonly bottleneckDescription?: string | null;
	/** 是否显式解锁超过窗口数 */
	readonly isUnlockedAboveWindow?: boolean;
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
	readonly assignments?: Readonly<Record<string, TaskAssignmentDraft>>;
	/** 单任务指派回调 */
	readonly onAssignTask?: (taskId: string, draft: TaskAssignmentDraft) => void;
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
	readonly isUnlockedAboveWindow?: boolean;
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
 * 格式化数值字段，缺失时显示「—」（严格禁绝前端造假默认值）。
 */
function renderFieldOrFallback(val: number | string | null | undefined): string {
	if (val === null || val === undefined || val === '') {
		return EMPTY_VALUE_FALLBACK;
	}
	return String(val);
}

/**
 * 依据瓶颈标识派生人类可读中文说明（E-52）。
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

	switch (source) {
		case CONCURRENCY_BOTTLENECK_TYPES.WINDOW_COUNT:
			return {
				label: '并行窗口数 (依赖拓扑)',
				explanation: `瓶颈归因：受批次内任务依赖或路径冲突限制，并行窗口上限为 ${renderFieldOrFallback(
					details?.windowCount,
				)}。`,
			};
		case CONCURRENCY_BOTTLENECK_TYPES.AGENT_LIMIT:
			return {
				label: 'Agent 单体并发上限',
				explanation: `瓶颈归因：所指派 Agent 的单体最大并发上限为 ${renderFieldOrFallback(
					details?.agentLimit,
				)}，已满额时空位可顺延给别家（E-47）。`,
			};
		case CONCURRENCY_BOTTLENECK_TYPES.USER_SETTING:
			return {
				label: '用户设定并发上限',
				explanation: `瓶颈归因：受用户偏好设定上限 (${renderFieldOrFallback(
					details?.userSetting,
				)}) 约束，可按需在下方调节上限。`,
			};
		case CONCURRENCY_BOTTLENECK_TYPES.MACHINE_RESOURCE:
			return {
				label: '宿主机系统资源',
				explanation: '瓶颈归因：宿主机 CPU / 内存资源限制，调度器自动降低并发上限以保障稳定性。',
			};
		case CONCURRENCY_BOTTLENECK_TYPES.PATH_CONFLICT:
			return {
				label: '同批任务路径冲突 (E-46)',
				explanation: '瓶颈归因：同批任务间修改的文件路径存在交集，排队等待前置任务落地后方可放行。',
			};
		default:
			return {
				label: String(source),
				explanation: `瓶颈归因：${String(source)}`,
			};
	}
}

/**
 * 单任务指派行编辑状态管理（私有行组件）。
 */
interface TaskAssignRowProps {
	readonly task: TaskItem;
	readonly agents: readonly AssignableAgent[];
	readonly assignment?: TaskAssignmentDraft;
	readonly assignedSessionIndex: number;
	readonly agentUsageCounts: Readonly<Record<string, number>>;
	readonly onSave: (draft: TaskAssignmentDraft) => void;
	readonly onReset?: () => void;
}

function TaskAssignRow({
	task,
	agents,
	assignment,
	assignedSessionIndex,
	agentUsageCounts,
	onSave,
	onReset,
}: TaskAssignRowProps) {
	const rowId = useId();
	const isAlreadyAssigned = Boolean(assignment);
	// 是否处于修改回改模式（AC 1: 已指派行显示所选值可点回改）
	const [isEditing, setIsEditing] = useState<boolean>(!isAlreadyAssigned);

	// 当前选择的 agent
	const initialAgentId = assignment?.agentKey ?? task.defaultAgentId ?? agents[0]?.id ?? '';
	const [selectedAgentId, setSelectedAgentId] = useState<string>(initialAgentId);

	// 查找所选 Agent 对象
	const currentAgent = useMemo(() => {
		return agents.find((a) => a.id === selectedAgentId) ?? agents[0] ?? null;
	}, [agents, selectedAgentId]);

	// 当前 Agent 的可用模型列表（M4-T6, E-34: 下拉只列当前 agent 清单，切 agent 清空）
	const availableModels = useMemo(() => {
		return currentAgent?.models ?? [];
	}, [currentAgent]);

	// 模型名称（空字符串代表「跟随 agent 配置」，E-35, E-41）
	const initialModel =
		assignment?.modelName ?? task.defaultModel ?? currentAgent?.defaultModel ?? '';
	const [selectedModel, setSelectedModel] = useState<string>(initialModel);

	// 思考强度（支持 low / medium / high / null，E-254）
	const supportsEffort = currentAgent?.supportsEffort ?? false;
	const initialEffort =
		assignment?.effortTier ?? (supportsEffort ? (task.defaultEffortTier ?? 'medium') : null);
	const [selectedEffort, setSelectedEffort] = useState<string | null>(initialEffort);

	// 切换 Agent 联动（M4-T6, E-34, E-254）
	const handleAgentChange = (newAgentId: string) => {
		setSelectedAgentId(newAgentId);
		const newAgent = agents.find((a) => a.id === newAgentId);
		// 切换 agent 时清空单任务模型覆盖，回落该 agent 默认（E-34）
		setSelectedModel(newAgent?.defaultModel ?? '');
		// 思考强度同构处理：不支持则置为 null，绝不伪造默认档（E-254）
		if (newAgent?.supportsEffort) {
			setSelectedEffort(newAgent.defaultEffortTier ?? 'medium');
		} else {
			setSelectedEffort(null);
		}
	};

	// 保存指派
	const handleSave = () => {
		if (!currentAgent) return;
		const draft: TaskAssignmentDraft = {
			taskId: task.id,
			taskKey: task.taskKey,
			title: task.title,
			agentKey: currentAgent.id,
			modelName: selectedModel,
			effortTier: currentAgent.supportsEffort ? selectedEffort : null,
			sessionIndex: assignedSessionIndex,
		};
		onSave(draft);
		setIsEditing(false);
	};

	// 针对当前选定 Agent 统计已占用会话数
	const currentAgentUsedCount = currentAgent ? (agentUsageCounts[currentAgent.id] ?? 0) : 0;
	// 若当前任务原本已指派给该 Agent，则编辑时不重复计算自身
	const effectiveAgentUsed =
		isAlreadyAssigned && assignment?.agentKey === currentAgent?.id
			? currentAgentUsedCount
			: currentAgentUsedCount + 1;
	const isAgentLimitExceeded = currentAgent
		? effectiveAgentUsed > currentAgent.maxConcurrency
		: false;

	// ─────────────────────────────────────────────────────────────
	// 态 1：已指派展示态（回显所选值，提供回改入口，AC 1, AC 2, E-108, E-31）
	// ─────────────────────────────────────────────────────────────
	if (isAlreadyAssigned && !isEditing && assignment) {
		const assignedAgentObj = agents.find((a) => a.id === assignment.agentKey);
		const agentMonogram =
			assignedAgentObj?.monogram ?? assignment.agentKey.slice(0, 2).toUpperCase();
		const agentName = assignedAgentObj?.name ?? assignment.agentKey;
		const modelDisplay = assignment.modelName ? assignment.modelName : '跟随 agent 配置';
		const effortDisplay = assignment.effortTier ? assignment.effortTier : EMPTY_VALUE_FALLBACK;
		const sessionDisplay = assignment.sessionIndex ?? assignedSessionIndex;

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
						{/* 独立会话序号徽标（AC 2, E-31, 决策 7） */}
						<span
							data-session-badge={sessionDisplay}
							className="px-2 py-0.5 rounded border border-auto-soft bg-auto-soft text-auto font-bold text-micro"
							title={`同一个 agent 允许多次指派，此任务为独立会话 #${sessionDisplay}（E-31）`}
						>
							会话 #{sessionDisplay}
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

				{/* 回改修改动作按钮（AC 1: 已指派行显示所选值可点回改） */}
				<div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
					<button
						type="button"
						data-action="edit-assignment"
						onClick={() => setIsEditing(true)}
						className="h-btn px-3 rounded-sm border border-border bg-bg text-ink-2 hover:text-ink-1 hover:border-needs text-dense transition-colors"
						aria-label={`修改任务 ${task.taskKey} 的指派`}
					>
						修改指派
					</button>
					{onReset && (
						<button
							type="button"
							data-action="reset-assignment"
							onClick={() => onReset()}
							className="h-btn px-2 rounded-sm border border-transparent text-ink-3 hover:text-down text-micro transition-colors"
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
	// 态 2：编辑指派表单态（逐任务单独指派，AC 1, AC 2, AC 4, E-47, E-108）
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
					{/* 即将分配的会话序号预告（AC 2, E-31） */}
					<span
						data-next-session-preview={assignedSessionIndex}
						className="text-micro font-mono text-auto bg-auto-soft border border-auto-soft px-2 py-0.5 rounded"
					>
						将分配会话 #{assignedSessionIndex}
					</span>
				</div>
			</div>

			{/* Agent 已达上限提示条（AC 4, E-47 呈现侧：某 agent 已达并发上限时其余任务仍可指派给别家，不空转等待） */}
			{isAgentLimitExceeded && currentAgent && (
				<div
					data-testid="agent-limit-warning"
					className="flex items-center justify-between text-micro text-needs p-2 rounded bg-needs-soft border border-needs font-mono"
				>
					<span>
						⚠️ Agent「{currentAgent.name}」已达并发上限 ({currentAgent.maxConcurrency}/
						{currentAgent.maxConcurrency})。本任务启动时需排队；其余任务可继续指派给别家
						Agent，不空转等待（E-47）。
					</span>
				</div>
			)}

			{/* 表单控件区：三联控件（Agent / 模型 / 思考强度） */}
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
						className="h-input px-2.5 rounded-sm border border-border bg-panel-2 text-ink-1 text-dense font-mono focus:border-needs outline-none transition-colors"
					>
						{agents.map((ag) => {
							const used = agentUsageCounts[ag.id] ?? 0;
							const isFull = used >= ag.maxConcurrency;
							return (
								<option key={ag.id} value={ag.id}>
									{ag.name} ({ag.monogram}) — {used}/{ag.maxConcurrency}
									{isFull ? ' [已满额]' : ' [可用]'}
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
						className="h-input px-2.5 rounded-sm border border-border bg-panel-2 text-ink-1 text-dense font-mono focus:border-needs outline-none transition-colors"
					>
						<option value="">跟随 agent 默认配置 (不传 --model)</option>
						{availableModels.map((m) => (
							<option key={m} value={m}>
								{m}
							</option>
						))}
					</select>
				</div>

				{/* 3. 选择思考强度（若不支持显示「—」，绝不补假默认档，M4-T6, E-254） */}
				<div className="flex flex-col gap-1">
					<label htmlFor={`effort-select-${rowId}`} className="text-micro text-ink-3 font-mono">
						思考强度 {supportsEffort ? '(可调)' : '(不支持)'}
					</label>
					{supportsEffort ? (
						<select
							id={`effort-select-${rowId}`}
							data-testid={`select-effort-${task.taskKey}`}
							value={selectedEffort ?? ''}
							onChange={(e) => setSelectedEffort(e.target.value || null)}
							className="h-input px-2.5 rounded-sm border border-border bg-panel-2 text-ink-1 text-dense font-mono focus:border-needs outline-none transition-colors"
						>
							<option value="low">低档 (low)</option>
							<option value="medium">中档 (medium)</option>
							<option value="high">高档 (high)</option>
						</select>
					) : (
						<div
							id={`effort-select-${rowId}`}
							data-testid={`effort-unsupported-${task.taskKey}`}
							className="flex h-input items-center px-2.5 rounded-sm border border-border bg-panel-2 text-ink-3 font-mono text-dense select-none cursor-not-allowed"
							title="该 Agent 原生不支持思考强度参数，UI 显示 —，派发不传参（E-254）"
						>
							<span>{EMPTY_VALUE_FALLBACK}</span>
							<span className="text-micro ml-2 text-ink-3">(不支持思考档位)</span>
						</div>
					)}
				</div>
			</div>

			{/* 底部确认与取消 */}
			<div className="flex items-center justify-between pt-1 border-t border-border mt-1">
				<div className="text-micro text-ink-3 font-mono">
					{isAlreadyAssigned ? '修改单任务指派' : '逐任务独立指定，严禁整批统一套用'}
				</div>
				<div className="flex items-center gap-2">
					{isAlreadyAssigned && (
						<button
							type="button"
							onClick={() => setIsEditing(false)}
							className="h-btn px-3 rounded-sm border border-border bg-panel-2 text-ink-2 hover:text-ink-1 text-dense"
						>
							取消
						</button>
					)}
					<button
						type="button"
						data-action="confirm-task-assign"
						onClick={handleSave}
						className="h-btn px-4 rounded-sm bg-needs text-on-needs font-bold text-dense hover:brightness-105 transition-colors"
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
	onAssignTask,
	onResetAssignment,
	className = '',
}: TaskAssignmentListProps) {
	// 统计各 Agent 已指派的任务数（用于容量分配与 E-47 满额呈现）
	const agentUsageCounts = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const draft of Object.values(assignments)) {
			if (draft.agentKey) {
				counts[draft.agentKey] = (counts[draft.agentKey] ?? 0) + 1;
			}
		}
		return counts;
	}, [assignments]);

	// 计算某一特定任务归属 Agent 的独立会话序号（AC 2, E-31）
	const getSessionIndexForTask = (taskId: string, agentKey: string): number => {
		let count = 0;
		for (const t of tasks) {
			const a = assignments[t.id];
			if (a && a.agentKey === agentKey) {
				count++;
				if (t.id === taskId) {
					return count;
				}
			}
		}
		// 若当前尚未正式入库，则序号为已存在数 + 1
		return (agentUsageCounts[agentKey] ?? 0) + 1;
	};

	// 汇总已指派和待指派数量
	const assignedCount = Object.keys(assignments).length;
	const totalTasks = tasks.length;

	return (
		<div
			data-testid="task-assignment-list"
			className={`flex flex-col gap-3 rounded border border-border bg-bg p-4 ${className}`}
		>
			{/* 顶栏：指派进度与容量总览（AC 1, AC 4, E-47） */}
			<div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pb-2 border-b border-border">
				<div>
					<h4 className="text-dense font-semibold text-ink-1">
						逐任务执行指派 ({assignedCount}/{totalTasks})
					</h4>
					<p className="text-meta text-ink-2">
						每行任务独立配置 Agent、模型与思考强度；已指派行可随时点回改（E-108）。
					</p>
				</div>
				{/* 动态 Agent 容量指标行（AC 4, E-47） */}
				<div
					data-testid="agent-capacity-overview"
					className="flex items-center gap-2 flex-wrap text-micro font-mono"
				>
					{agents.map((ag) => {
						const used = agentUsageCounts[ag.id] ?? 0;
						const isFull = used >= ag.maxConcurrency;
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
										? `${ag.name} 单体并发已满 (${used}/${ag.maxConcurrency})，空位顺延给其他 Agent，不空转等待（E-47）`
										: `${ag.name} 当前已分配 ${used}/${ag.maxConcurrency}`
								}
							>
								{ag.name}: {used}/{ag.maxConcurrency}
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
						const agentKeyForTask =
							currentAssignment?.agentKey ?? task.defaultAgentId ?? agents[0]?.id ?? '';
						const sessionIndex = getSessionIndexForTask(task.id, agentKeyForTask);

						return (
							<TaskAssignRow
								key={task.id}
								task={task}
								agents={agents}
								assignment={currentAssignment}
								assignedSessionIndex={sessionIndex}
								agentUsageCounts={agentUsageCounts}
								onSave={(draft) => onAssignTask?.(task.id, draft)}
								onReset={() => onResetAssignment?.(task.id)}
							/>
						);
					})}
				</div>
			) : (
				<div
					data-testid="empty-tasks-placeholder"
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
 * 并发限制审计与瓶颈归因卡片（AC 3, E-52, E-47, E-48）
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
	isUnlockedAboveWindow = false,
	onChangeUserSetting,
	onToggleUnlockAboveWindow,
	className = '',
}: ConcurrencyBottleneckCardProps) {
	// 属性融合（优先读 audit 字段，无则读平铺 props）
	const effCap = audit?.effectiveCapacity ?? effectiveCapacity;
	const winCount = audit?.windowCount ?? windowCount;
	const agLimit = audit?.agentLimit ?? agentLimit;
	const usrSet = audit?.userSetting ?? userSetting ?? 2;
	const bSource = audit?.bottleneckSource ?? bottleneckSource ?? null;
	const bDesc = audit?.bottleneckDescription ?? bottleneckDescription ?? null;
	const isUnlocked = audit?.isUnlockedAboveWindow ?? isUnlockedAboveWindow;

	// 解析瓶颈分析人类说明
	const bottleneckInfo = deriveBottleneckSummary(bSource, {
		windowCount: winCount,
		agentLimit: agLimit,
		userSetting: usrSet,
	});

	// 用户上调是否越界（E-52: 向上超过窗口数需显式解锁并提示后果）
	const numericWinCount = typeof winCount === 'number' ? winCount : Number(winCount);
	const isExceedingWindow =
		!Number.isNaN(numericWinCount) && numericWinCount > 0 && usrSet > numericWinCount;

	// 用户调节设定动作
	const handleDecrease = () => {
		if (onChangeUserSetting && usrSet > 1) {
			onChangeUserSetting(usrSet - 1);
		}
	};

	const handleIncrease = () => {
		if (!onChangeUserSetting) return;
		if (usrSet >= 6) return;
		// 若增加后将超过窗口数且尚未解锁，则提示必须显式解锁
		const nextVal = usrSet + 1;
		if (
			!Number.isNaN(numericWinCount) &&
			numericWinCount > 0 &&
			nextVal > numericWinCount &&
			!isUnlocked
		) {
			// 未解锁时阻止继续上调
			return;
		}
		onChangeUserSetting(nextVal);
	};

	return (
		<div
			data-testid="concurrency-bottleneck-card"
			className={`flex flex-col gap-4 p-4 rounded border border-border bg-panel-2 text-meta ${className}`}
		>
			{/* 头部：有效并发容量（min 三者取 min 结果） */}
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

			{/* 三因子对比网格（明确指出三者数值与哪一个是瓶颈，AC 3, E-52） */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 font-mono text-micro">
				{/* 因子 1：并行窗口数 */}
				<div
					data-factor="window_count"
					className={`flex flex-col justify-between p-2.5 rounded bg-bg border ${
						bSource === CONCURRENCY_BOTTLENECK_TYPES.WINDOW_COUNT
							? 'border-needs bg-needs-soft'
							: 'border-border'
					}`}
				>
					<div className="flex items-center justify-between">
						<span className="text-ink-3">并行窗口数</span>
						{bSource === CONCURRENCY_BOTTLENECK_TYPES.WINDOW_COUNT && (
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
						bSource === CONCURRENCY_BOTTLENECK_TYPES.AGENT_LIMIT
							? 'border-needs bg-needs-soft'
							: 'border-border'
					}`}
				>
					<div className="flex items-center justify-between">
						<span className="text-ink-3">Agent 基础上限</span>
						{bSource === CONCURRENCY_BOTTLENECK_TYPES.AGENT_LIMIT && (
							<span
								data-testid="bottleneck-badge-agent"
								className="px-1 py-0.2 rounded bg-needs text-on-needs font-bold text-micro"
							>
								瓶颈
							</span>
						)}
					</div>
					<div className="text-dense font-bold text-ink-1 mt-2">
						{renderFieldOrFallback(agLimit)}
					</div>
					<span className="text-micro text-ink-3 mt-1">单 Agent 最大会话配额</span>
				</div>

				{/* 因子 3：用户设定上限（可调节，E-52） */}
				<div
					data-factor="user_setting"
					className={`flex flex-col justify-between p-2.5 rounded bg-bg border ${
						bSource === CONCURRENCY_BOTTLENECK_TYPES.USER_SETTING
							? 'border-needs bg-needs-soft'
							: 'border-border'
					}`}
				>
					<div className="flex items-center justify-between">
						<span className="text-ink-3">用户偏好设定</span>
						{bSource === CONCURRENCY_BOTTLENECK_TYPES.USER_SETTING && (
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
									disabled={usrSet <= 1}
									className="h-6 w-6 flex items-center justify-center text-ink-2 hover:text-ink-1 disabled:opacity-30"
									aria-label="调小用户并发设定"
								>
									-
								</button>
								<button
									type="button"
									data-action="increase-user-setting"
									onClick={handleIncrease}
									disabled={
										usrSet >= 6 ||
										(!isUnlocked &&
											!Number.isNaN(numericWinCount) &&
											numericWinCount > 0 &&
											usrSet >= numericWinCount)
									}
									className="h-6 w-6 flex items-center justify-center text-ink-2 hover:text-ink-1 disabled:opacity-30"
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

			{/* 向上超过窗口数显式解锁与后果提示（E-52） */}
			{onChangeUserSetting && onToggleUnlockAboveWindow && (
				<div
					data-testid="unlock-above-window-container"
					className="flex flex-col gap-2 p-2.5 rounded bg-bg border border-border text-micro font-mono"
				>
					<label className="flex items-center gap-2 cursor-pointer text-ink-1">
						<input
							type="checkbox"
							data-action="toggle-unlock-above-window"
							checked={isUnlocked}
							onChange={(e) => onToggleUnlockAboveWindow(e.target.checked)}
							className="h-4 w-4 rounded border-border bg-panel-2 text-needs focus:ring-0 cursor-pointer"
						/>
						<span className="font-semibold">显式解锁超过并行窗口数设定 (E-52)</span>
					</label>

					{isExceedingWindow && (
						<div
							data-testid="exceed-window-warning"
							className="text-needs bg-needs-soft border border-needs p-2 rounded text-micro"
						>
							⚠️ 后果提示：当前用户设定 ({usrSet}) 已超过依赖窗口数 ({winCount}
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
	onAssignTask,
	onResetAssignment,
	audit,
	effectiveCapacity,
	windowCount,
	agentLimit,
	userSetting,
	bottleneckSource,
	bottleneckDescription,
	isUnlockedAboveWindow,
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
					isUnlockedAboveWindow={isUnlockedAboveWindow}
					onChangeUserSetting={onChangeUserSetting}
					onToggleUnlockAboveWindow={onToggleUnlockAboveWindow}
				/>
			)}
		</div>
	);
}

export default AssignPanel;
