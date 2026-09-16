/**
 * packages/web/src/components/empty-onboarding.tsx
 *
 * 空态四步引导与文档变更横幅组件（M9-T16 / AC 1, AC 4, E-108, E-19, E-110）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 空态是「选文档 → 选批次 → 逐任务指派 → 派发」四步引导，当前步高亮、已完成步显示所选值可点回改，不是插画（AC 1, E-108）
 * - 四步引导第三步是逐任务指派而不是「给整批选一个模型」：每行一个任务，各自选 agent／模型／思考强度，已指派行显示所选值可点回改（E-108, E-31, 决策 52）
 * - 第四步显示并发与瓶颈说明，明确指出是并行窗口、agent 上限还是用户配置成为瓶颈（E-52）
 * - 文档变更横幅显示「本文档已更新，N 个任务的依据已变」并可进入受影响任务的过滤列表（AC 4, E-19）
 * - 长时间盯屏下深色为默认、路径与代码等宽（AC 6, E-110）
 * - 纯展示组件（components 纯 props in / callback out），颜色全走 CSS 变量（check-forbidden 机检）
 */

import { useId, useState } from 'react';

/**
 * 文档选项数据模型。
 */
export interface OnboardingDocOption {
	readonly id: string;
	readonly title: string;
	readonly path: string;
	readonly batchCount?: number;
	readonly totalTasks?: number;
}

/**
 * 批次选项数据模型。
 */
export interface OnboardingBatchOption {
	readonly id: string;
	readonly name: string;
	readonly docId: string;
	readonly taskCount: number;
	readonly moduleKeys: readonly string[];
	readonly description?: string;
}

/**
 * 思考强度档位（决策 52 / E-254：三档抽象 + 留空）。
 */
export type ReasoningEffortTier = 'low' | 'medium' | 'high' | 'none';

/**
 * 单个任务的指派草稿。
 */
export interface TaskAssignmentDraft {
	readonly taskId: string;
	readonly taskKey: string;
	readonly title: string;
	readonly agentKey: string;
	readonly modelName: string;
	readonly effortTier: ReasoningEffortTier;
}

/**
 * 文档变更横幅数据模型（AC 4, E-19）。
 */
export interface DocChangeNotice {
	readonly docId?: string;
	readonly affectedCount: number;
	readonly affectedTaskIds?: readonly string[];
	readonly summary?: string;
}

export interface EmptyOnboardingProps {
	/** 可选文档列表（未传时提供演示内置默认） */
	readonly documents?: readonly OnboardingDocOption[];
	/** 可选批次列表（未传时提供演示内置默认） */
	readonly batches?: readonly OnboardingBatchOption[];
	/** 当前已配置或待指派的任务清单 */
	readonly tasks?: readonly { id: string; taskKey: string; title: string }[];
	/** 可用的 Agent 标识清单 */
	readonly availableAgents?: readonly { key: string; name: string }[];
	/** 可用的模型清单 */
	readonly availableModels?: readonly string[];
	/** 并行窗口上限配置（用于第 4 步并发瓶颈说明，E-52） */
	readonly laneCount?: number;
	/** Agent 单体并发上限（用于第 4 步并发瓶颈说明，E-47, E-52） */
	readonly agentConcurrencyLimit?: number;
	/** 文档变更横幅信息（AC 4 / E-19） */
	readonly docChangeNotice?: DocChangeNotice | null;
	/** 查看受影响任务列表回调（AC 4 / E-19） */
	readonly onViewAffectedTasks?: (taskIds: readonly string[]) => void;
	/** 派发成功提交回调 */
	readonly onDispatch?: (payload: {
		docId: string;
		batchId: string;
		assignments: readonly TaskAssignmentDraft[];
	}) => void;
	/** 样式自定义扩展 */
	readonly className?: string;
}

const DEFAULT_DOCUMENTS: readonly OnboardingDocOption[] = Object.freeze([
	{
		id: 'doc-main',
		title: 'Agent任务调度器-开发文档',
		path: 'docs/Agent任务调度器-开发文档',
		batchCount: 6,
		totalTasks: 97,
	},
]);

const DEFAULT_BATCHES: readonly OnboardingBatchOption[] = Object.freeze([
	{
		id: 'batch-1',
		name: '第 1 批 (M1, M2)',
		docId: 'doc-main',
		taskCount: 8,
		moduleKeys: ['M1', 'M2'],
		description: '基础骨架与 REST/SSE 服务端管线',
	},
	{
		id: 'batch-2',
		name: '第 2 批 (M3, M4)',
		docId: 'doc-main',
		taskCount: 12,
		moduleKeys: ['M3', 'M4'],
		description: '文档导入与 Agent 适配器层',
	},
	{
		id: 'batch-3',
		name: '第 3 批 (M5, M6)',
		docId: 'doc-main',
		taskCount: 14,
		moduleKeys: ['M5', 'M6'],
		description: 'Git 工作树与运行日志管理',
	},
]);

const DEFAULT_TASKS = Object.freeze([
	{ id: 't-1', taskKey: 'M1-T1', title: '全项目目录结构与 workspace 骨架' },
	{ id: 't-2', taskKey: 'M1-T2', title: '配置集中加载与 5 个环境变量' },
	{ id: 't-3', taskKey: 'M1-T3', title: 'SQLite 迁移执行器与 WAL 模式' },
]);

const DEFAULT_AGENTS = Object.freeze([
	{ key: 'codex', name: 'Codex' },
	{ key: 'claude', name: 'Claude Code' },
	{ key: 'dsh', name: 'dsh Headless' },
	{ key: 'pi', name: 'Pi Agent' },
]);

const DEFAULT_MODELS = Object.freeze(['gpt-4o', 'claude-3-5-sonnet', 'o3-mini', 'default']);

const EFFORT_OPTIONS: readonly { tier: ReasoningEffortTier; label: string }[] = Object.freeze([
	{ tier: 'none', label: '— 不传' },
	{ tier: 'low', label: '低 (low)' },
	{ tier: 'medium', label: '中 (medium)' },
	{ tier: 'high', label: '高 (high)' },
]);

/**
 * 文档变更横幅组件（AC 4, E-19 独立导出）。
 * 显示「本文档已更新，N 个任务的依据已变」并提供进入受影响任务的过滤列表入口。
 */
export function DocChangeBanner({
	notice,
	onViewAffected,
	className = '',
}: {
	readonly notice: DocChangeNotice;
	readonly onViewAffected?: (taskIds: readonly string[]) => void;
	readonly className?: string;
}) {
	const count = notice.affectedCount;
	const taskIds = notice.affectedTaskIds ?? [];

	if (count <= 0) {
		return null;
	}

	return (
		<aside
			data-testid="doc-change-banner"
			role="alert"
			className={[
				'flex flex-wrap items-center justify-between gap-3 rounded border border-needs bg-needs-soft px-4 py-2.5 text-needs font-ui select-none',
				className,
			].join(' ')}
		>
			<div className="flex items-center gap-2">
				{/* 警告字形（单色内联，E-110 / E-172） */}
				<span className="flex h-5 w-5 items-center justify-center rounded-sm bg-needs text-on-needs font-mono text-micro font-bold">
					!
				</span>
				<div className="flex flex-col">
					<span className="text-dense font-semibold">本文档已更新，{count} 个任务的依据已变</span>
					{notice.summary && (
						<span className="font-mono text-micro text-ink-2">{notice.summary}</span>
					)}
				</div>
			</div>

			<div className="flex items-center gap-2">
				<button
					type="button"
					data-action="view-affected"
					onClick={() => onViewAffected?.(taskIds)}
					className="h-btn-sm px-3 rounded-sm bg-needs text-on-needs font-ui text-micro font-semibold transition-colors hover:brightness-105 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--needs-soft)]"
				>
					查看受影响任务 ({count})
				</button>
			</div>
		</aside>
	);
}

/**
 * 空态四步引导控制台（AC 1, E-108）。
 * 选文档 → 选批次 → 逐任务指派 → 派发。
 */
export function EmptyOnboarding({
	documents = DEFAULT_DOCUMENTS,
	batches = DEFAULT_BATCHES,
	tasks: initialTasks = DEFAULT_TASKS,
	availableAgents = DEFAULT_AGENTS,
	availableModels = DEFAULT_MODELS,
	laneCount = 3,
	agentConcurrencyLimit = 2,
	docChangeNotice,
	onViewAffectedTasks,
	onDispatch,
	className = '',
}: EmptyOnboardingProps) {
	const componentId = useId();

	// 步进索引：0=选文档, 1=选批次, 2=逐任务指派, 3=派发
	const [currentStep, setCurrentStep] = useState<number>(0);

	// 第一步：选定文档
	const [selectedDocId, setSelectedDocId] = useState<string>(documents[0]?.id ?? '');

	// 第二步：选定批次
	const [selectedBatchId, setSelectedBatchId] = useState<string>(batches[0]?.id ?? '');

	// 第三步：逐任务指派状态记录（E-108 / E-31 / 决策 52）
	const [assignments, setAssignments] = useState<Record<string, TaskAssignmentDraft>>(() => {
		const initial: Record<string, TaskAssignmentDraft> = {};
		for (const task of initialTasks) {
			initial[task.id] = {
				taskId: task.id,
				taskKey: task.taskKey,
				title: task.title,
				agentKey: availableAgents[0]?.key ?? 'codex',
				modelName: availableModels[0] ?? 'default',
				effortTier: 'none',
			};
		}
		return initial;
	});

	// 当前正在行内编辑指派的任务 ID（null 表示全部完成预览）
	const [editingTaskId, setEditingTaskId] = useState<string | null>(null);

	const selectedDoc = documents.find((d) => d.id === selectedDocId) ?? documents[0];
	const selectedBatch = batches.find((b) => b.id === selectedBatchId) ?? batches[0];
	const taskList = initialTasks;

	// 处理某行指派字段更新
	const handleUpdateAssignment = (
		taskId: string,
		field: 'agentKey' | 'modelName' | 'effortTier',
		value: string,
	) => {
		setAssignments((prev) => {
			const current = prev[taskId];
			if (!current) return prev;
			return {
				...prev,
				[taskId]: {
					...current,
					[field]: value,
				},
			};
		});
	};

	// 最终派发
	const handleTriggerDispatch = () => {
		onDispatch?.({
			docId: selectedDocId,
			batchId: selectedBatchId,
			assignments: Object.values(assignments),
		});
	};

	// 计算并发瓶颈（E-52）
	const effectiveBottleneck = Math.min(laneCount, agentConcurrencyLimit);
	const isWindowBottleneck = laneCount <= agentConcurrencyLimit;

	// 步骤元数据
	const steps = [
		{
			title: '选文档',
			completedSummary: selectedDoc ? selectedDoc.title : undefined,
		},
		{
			title: '选批次',
			completedSummary: selectedBatch
				? `${selectedBatch.name} (${selectedBatch.taskCount} 项)`
				: undefined,
		},
		{
			title: '逐任务指派',
			completedSummary: `${taskList.length} 个任务已分别指派`,
		},
		{
			title: '派发',
			completedSummary: undefined,
		},
	];

	return (
		<div
			data-testid="empty-onboarding-console"
			className={[
				'flex flex-col gap-6 rounded-lg border border-border bg-page p-4 sm:p-6 text-ink-1 font-ui max-w-4xl mx-auto w-full select-none',
				className,
			].join(' ')}
		>
			{/* AC 4 & E-19: 文档变更横幅常驻检测区 */}
			{docChangeNotice && docChangeNotice.affectedCount > 0 && (
				<DocChangeBanner notice={docChangeNotice} onViewAffected={onViewAffectedTasks} />
			)}

			{/* 头部标题与控制塔说明（不是插画，AC 1 / E-108） */}
			<header className="flex flex-col gap-1 border-b border-border pb-4">
				<div className="flex items-center gap-2">
					<span className="font-mono text-micro uppercase tracking-wider text-ink-3">
						Workbench Console
					</span>
					<span className="text-ink-3">/</span>
					<span className="font-mono text-micro text-needs">零运行调度向导</span>
				</div>
				<h2 className="font-ui text-lead font-semibold tracking-tight text-ink-1">
					开始调度任务流
				</h2>
				<p className="text-meta text-ink-2">
					当前暂无活跃运行流。请按四步指引完成文档、批次与任务配置，直接进入多流监看工作台。
				</p>
			</header>

			{/* ─────────────────────────────────────────────────────────────
			    四步导航条（AC 1 / E-108）
			    当前步高亮、已完成步显示所选值可点回改，严禁插画
			    ───────────────────────────────────────────────────────────── */}
			<nav
				data-testid="onboarding-stepper"
				aria-label="调度向导步骤"
				className="grid grid-cols-1 sm:grid-cols-4 gap-2"
			>
				{steps.map((step, idx) => {
					const isCurrent = currentStep === idx;
					const isCompleted = currentStep > idx;
					const isPending = currentStep < idx;

					return (
						<button
							key={step.title}
							type="button"
							data-step-index={idx}
							data-step-active={isCurrent ? 'true' : 'false'}
							data-step-completed={isCompleted ? 'true' : 'false'}
							disabled={isPending}
							onClick={() => {
								if (isCompleted) {
									setCurrentStep(idx);
								}
							}}
							className={[
								'flex flex-col items-start gap-1 p-2.5 rounded border text-left transition-all',
								isCurrent
									? 'border-needs bg-panel-2 shadow-[0_0_0_2px_var(--needs-soft)] text-ink-1'
									: '',
								isCompleted
									? 'border-border-strong bg-bg text-ink-2 hover:border-needs cursor-pointer'
									: '',
								isPending ? 'border-border bg-page text-ink-3 opacity-60 cursor-not-allowed' : '',
							]
								.filter(Boolean)
								.join(' ')}
						>
							<div className="flex items-center gap-1.5 w-full">
								<span
									className={[
										'flex h-5 w-5 items-center justify-center rounded-sm font-mono text-micro font-bold',
										isCurrent ? 'bg-needs text-on-needs' : '',
										isCompleted ? 'bg-auto text-on-auto' : '',
										isPending ? 'bg-panel-2 text-ink-3 border border-border' : '',
									]
										.filter(Boolean)
										.join(' ')}
								>
									{isCompleted ? '✓' : idx + 1}
								</span>
								<span className="font-ui text-dense font-semibold">{step.title}</span>
								{isCompleted && (
									<span className="ml-auto text-micro text-needs font-mono">修改 ↩</span>
								)}
							</div>

							{/* 已完成步骤展示所选值并可点回改（AC 1） */}
							{isCompleted && step.completedSummary && (
								<span className="font-mono text-micro text-ink-2 truncate w-full pl-6">
									{step.completedSummary}
								</span>
							)}
						</button>
					);
				})}
			</nav>

			{/* ─────────────────────────────────────────────────────────────
			    步骤 1 内容区：选文档（E-108）
			    ───────────────────────────────────────────────────────────── */}
			{currentStep === 0 && (
				<section
					data-step-content="0"
					aria-label="第 1 步：选文档"
					className="flex flex-col gap-4 rounded border border-border bg-bg p-4"
				>
					<div className="flex items-center justify-between">
						<div>
							<h3 className="text-dense font-semibold text-ink-1">
								第一步：选择调度目标需求开发文档
							</h3>
							<p className="text-meta text-ink-2">
								选择后系统将根据文档中的模块规划与任务图谱准备批次清单。
							</p>
						</div>
					</div>

					<div className="flex flex-col gap-2">
						{documents.map((doc) => {
							const isSelected = doc.id === selectedDocId;
							return (
								<button
									type="button"
									key={doc.id}
									data-doc-id={doc.id}
									data-selected={isSelected ? 'true' : 'false'}
									onClick={() => setSelectedDocId(doc.id)}
									className={[
										'flex items-center justify-between p-3 rounded border text-left cursor-pointer transition-colors w-full',
										isSelected
											? 'border-needs bg-panel-2'
											: 'border-border bg-bg hover:border-border-strong',
									].join(' ')}
								>
									<div className="flex flex-col">
										<span className="font-ui text-dense font-semibold text-ink-1">{doc.title}</span>
										<span className="font-mono text-micro text-ink-3">{doc.path}</span>
									</div>
									<div className="flex items-center gap-3 text-micro text-ink-2 font-mono">
										{doc.batchCount !== undefined && <span>{doc.batchCount} 个批次</span>}
										{doc.totalTasks !== undefined && <span>{doc.totalTasks} 个任务</span>}
										<div
											className={[
												'h-4 w-4 rounded-sm border flex items-center justify-center font-bold text-micro',
												isSelected
													? 'border-needs bg-needs text-on-needs'
													: 'border-border text-transparent',
											].join(' ')}
										>
											✓
										</div>
									</div>
								</button>
							);
						})}
					</div>

					<div className="flex justify-end pt-2">
						<button
							type="button"
							data-action="next-step-1"
							onClick={() => setCurrentStep(1)}
							className="h-btn px-5 rounded-sm bg-needs text-on-needs font-semibold text-dense transition-colors hover:brightness-105"
						>
							下一步：选批次 →
						</button>
					</div>
				</section>
			)}

			{/* ─────────────────────────────────────────────────────────────
			    步骤 2 内容区：选批次（E-108）
			    ───────────────────────────────────────────────────────────── */}
			{currentStep === 1 && (
				<section
					data-step-content="1"
					aria-label="第 2 步：选批次"
					className="flex flex-col gap-4 rounded border border-border bg-bg p-4"
				>
					<div className="flex items-center justify-between">
						<div>
							<h3 className="text-dense font-semibold text-ink-1">第二步：选择要派发的任务批次</h3>
							<p className="text-meta text-ink-2">
								批次代表有依赖层级的分组，派发后整批任务进入调度泳道。
							</p>
						</div>
					</div>

					<div className="flex flex-col gap-2">
						{batches.map((batch) => {
							const isSelected = batch.id === selectedBatchId;
							return (
								<button
									type="button"
									key={batch.id}
									data-batch-id={batch.id}
									data-selected={isSelected ? 'true' : 'false'}
									onClick={() => setSelectedBatchId(batch.id)}
									className={[
										'flex items-center justify-between p-3 rounded border text-left cursor-pointer transition-colors w-full',
										isSelected
											? 'border-needs bg-panel-2'
											: 'border-border bg-bg hover:border-border-strong',
									].join(' ')}
								>
									<div className="flex flex-col">
										<div className="flex items-center gap-2">
											<span className="font-ui text-dense font-semibold text-ink-1">
												{batch.name}
											</span>
											<span className="font-mono text-micro text-ink-3 px-1.5 py-0.5 rounded bg-panel-2 border border-border">
												{batch.moduleKeys.join(', ')}
											</span>
										</div>
										{batch.description && (
											<span className="text-meta text-ink-3 mt-0.5">{batch.description}</span>
										)}
									</div>
									<div className="flex items-center gap-3 text-micro text-ink-2 font-mono">
										<span>{batch.taskCount} 个任务</span>
										<div
											className={[
												'h-4 w-4 rounded-sm border flex items-center justify-center font-bold text-micro',
												isSelected
													? 'border-needs bg-needs text-on-needs'
													: 'border-border text-transparent',
											].join(' ')}
										>
											✓
										</div>
									</div>
								</button>
							);
						})}
					</div>

					<div className="flex items-center justify-between pt-2">
						<button
							type="button"
							data-action="prev-step"
							onClick={() => setCurrentStep(0)}
							className="h-btn px-4 rounded-sm border border-border bg-panel-2 text-ink-2 hover:text-ink-1 text-dense"
						>
							← 返回选文档
						</button>
						<button
							type="button"
							data-action="next-step-2"
							onClick={() => setCurrentStep(2)}
							className="h-btn px-5 rounded-sm bg-needs text-on-needs font-semibold text-dense transition-colors hover:brightness-105"
						>
							下一步：逐任务指派 →
						</button>
					</div>
				</section>
			)}

			{/* ─────────────────────────────────────────────────────────────
			    步骤 3 内容区：逐任务指派（AC 1, E-108, E-31, 决策 52）
			    每行一个任务，各自选 agent／模型／思考强度，已指派行显示所选值可点回改
			    ───────────────────────────────────────────────────────────── */}
			{currentStep === 2 && (
				<section
					data-step-content="2"
					aria-label="第 3 步：逐任务指派"
					className="flex flex-col gap-4 rounded border border-border bg-bg p-4"
				>
					<div className="flex items-center justify-between">
						<div>
							<h3 className="text-dense font-semibold text-ink-1">
								第三步：逐任务独立指派 Agent、模型与思考强度
							</h3>
							<p className="text-meta text-ink-2">
								严禁「给整批一键统一套用模型」；每个任务独立指定会话参数，支持同一 Agent
								开设多个会话（决策 52 / E-31）。
							</p>
						</div>
					</div>

					{/* 任务行清单 */}
					<div className="flex flex-col gap-2.5">
						{taskList.map((task) => {
							const draft = assignments[task.id] ?? {
								taskId: task.id,
								taskKey: task.taskKey,
								title: task.title,
								agentKey: availableAgents[0]?.key ?? 'codex',
								modelName: availableModels[0] ?? 'default',
								effortTier: 'none',
							};

							const isEditing = editingTaskId === task.id;

							return (
								<div
									key={task.id}
									data-task-row={task.taskKey}
									className="flex flex-col gap-2 p-3 rounded border border-border bg-page"
								>
									{/* 任务标识行 */}
									<div className="flex flex-wrap items-center justify-between gap-2">
										<div className="flex items-center gap-2">
											<span className="font-mono text-micro font-bold px-1.5 py-0.5 rounded bg-panel-2 text-ink-1 border border-border">
												{task.taskKey}
											</span>
											<span className="font-ui text-dense font-medium text-ink-1">
												{task.title}
											</span>
										</div>

										{/* 已指派概要摘要与修改入口（AC 1） */}
										{!isEditing && (
											<button
												type="button"
												data-action={`edit-task-${task.taskKey}`}
												onClick={() => setEditingTaskId(task.id)}
												className="flex items-center gap-2 text-micro text-ink-2 font-mono hover:text-needs cursor-pointer"
											>
												<span>
													{draft.agentKey} · {draft.modelName} ·{' '}
													{draft.effortTier === 'none' ? '—' : draft.effortTier}
												</span>
												<span className="text-needs underline">改动</span>
											</button>
										)}
									</div>

									{/* 展开编辑表单行（或默认平铺展示） */}
									<div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 border-t border-border">
										{/* 1. Agent 选择 */}
										<label className="flex flex-col gap-1">
											<span className="text-micro text-ink-3">执行 Agent</span>
											<select
												data-field={`agent-${task.taskKey}`}
												value={draft.agentKey}
												onChange={(e) =>
													handleUpdateAssignment(task.id, 'agentKey', e.target.value)
												}
												className="h-btn-sm rounded-sm bg-panel-2 border border-border px-2 text-meta text-ink-1 font-mono focus-visible:border-needs"
											>
												{availableAgents.map((ag) => (
													<option key={ag.key} value={ag.key}>
														{ag.name}
													</option>
												))}
											</select>
										</label>

										{/* 2. 模型选择 */}
										<label className="flex flex-col gap-1">
											<span className="text-micro text-ink-3">模型配置</span>
											<select
												data-field={`model-${task.taskKey}`}
												value={draft.modelName}
												onChange={(e) =>
													handleUpdateAssignment(task.id, 'modelName', e.target.value)
												}
												className="h-btn-sm rounded-sm bg-panel-2 border border-border px-2 text-meta text-ink-1 font-mono focus-visible:border-needs"
											>
												{availableModels.map((m) => (
													<option key={m} value={m}>
														{m}
													</option>
												))}
											</select>
										</label>

										{/* 3. 思考强度选择（三档抽象 + 留空，决策 52 / E-254） */}
										<label className="flex flex-col gap-1">
											<span className="text-micro text-ink-3">思考强度 (Reasoning)</span>
											<select
												data-field={`effort-${task.taskKey}`}
												value={draft.effortTier}
												onChange={(e) =>
													handleUpdateAssignment(
														task.id,
														'effortTier',
														e.target.value as ReasoningEffortTier,
													)
												}
												className="h-btn-sm rounded-sm bg-panel-2 border border-border px-2 text-meta text-ink-1 font-mono focus-visible:border-needs"
											>
												{EFFORT_OPTIONS.map((opt) => (
													<option key={opt.tier} value={opt.tier}>
														{opt.label}
													</option>
												))}
											</select>
										</label>
									</div>
								</div>
							);
						})}
					</div>

					<div className="flex items-center justify-between pt-2">
						<button
							type="button"
							data-action="prev-step"
							onClick={() => setCurrentStep(1)}
							className="h-btn px-4 rounded-sm border border-border bg-panel-2 text-ink-2 hover:text-ink-1 text-dense"
						>
							← 返回选批次
						</button>
						<button
							type="button"
							data-action="next-step-3"
							onClick={() => setCurrentStep(3)}
							className="h-btn px-5 rounded-sm bg-needs text-on-needs font-semibold text-dense transition-colors hover:brightness-105"
						>
							下一步：检查并发与派发 →
						</button>
					</div>
				</section>
			)}

			{/* ─────────────────────────────────────────────────────────────
			    步骤 4 内容区：并发瓶颈说明与确认派发（AC 1, E-108, E-52, E-47）
			    ───────────────────────────────────────────────────────────── */}
			{currentStep === 3 && (
				<section
					data-step-content="3"
					aria-label="第 4 步：派发"
					className="flex flex-col gap-4 rounded border border-border bg-bg p-4"
				>
					<div className="flex items-center justify-between">
						<div>
							<h3 className="text-dense font-semibold text-ink-1">
								第四步：并发限制审计与启动派发
							</h3>
							<p className="text-meta text-ink-2">
								调度器执行并发三者取 min 规则，明确列出当前并发瓶颈来源（E-52）。
							</p>
						</div>
					</div>

					{/* 并发说明卡片（E-52 / E-47） */}
					<div
						data-testid="concurrency-bottleneck-card"
						className="flex flex-col gap-3 p-3.5 rounded border border-border bg-panel-2 text-meta"
					>
						<div className="flex items-center justify-between">
							<span className="font-semibold text-ink-1">有效并行并发容量</span>
							<span className="font-mono text-num font-bold text-needs">
								{effectiveBottleneck} 路
							</span>
						</div>

						<div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-micro font-mono">
							<div className="flex justify-between p-2 rounded bg-bg border border-border">
								<span className="text-ink-3">并行窗口数 (调度器)</span>
								<span className="text-ink-1 font-bold">{laneCount} 路</span>
							</div>
							<div className="flex justify-between p-2 rounded bg-bg border border-border">
								<span className="text-ink-3">Agent 基础并发上限</span>
								<span className="text-ink-1 font-bold">{agentConcurrencyLimit} 路</span>
							</div>
						</div>

						{/* 明确瓶颈判定说明（E-52） */}
						<div className="text-micro text-ink-2 border-t border-border pt-2">
							<span className="text-needs font-semibold font-mono">瓶颈分析：</span>
							{isWindowBottleneck ? (
								<span>
									当前受限于系统配置的并行窗口数（{laneCount} 路），该 Agent 剩余配额仍可接单。
								</span>
							) : (
								<span>
									当前受限于 Agent 单体并发限制（{agentConcurrencyLimit}{' '}
									路），空闲窗口将优先分配给其余 Agent（E-47）。
								</span>
							)}
						</div>
					</div>

					{/* 派发清单摘要 */}
					<div className="flex items-center justify-between text-meta text-ink-2 p-3 rounded border border-border bg-page">
						<div>
							<span className="text-ink-3">就绪任务：</span>
							<span className="font-mono font-bold text-ink-1 ml-1">{taskList.length} 个</span>
							<span className="text-ink-3 ml-3">所属文档：</span>
							<span className="font-mono text-ink-1 ml-1">{selectedDoc?.title}</span>
						</div>
						<div className="font-mono text-micro text-ink-3">状态: 待派发</div>
					</div>

					<div className="flex items-center justify-between pt-2">
						<button
							type="button"
							data-action="prev-step"
							onClick={() => setCurrentStep(2)}
							className="h-btn px-4 rounded-sm border border-border bg-panel-2 text-ink-2 hover:text-ink-1 text-dense"
						>
							← 返回修改指派
						</button>
						<button
							type="button"
							data-action="confirm-dispatch"
							onClick={handleTriggerDispatch}
							className="h-btn-lg px-8 rounded-sm bg-needs text-on-needs font-bold text-body shadow-glow transition-all hover:brightness-105 active:scale-98"
						>
							启动批次派发 (开启 {effectiveBottleneck} 路)
						</button>
					</div>
				</section>
			)}
		</div>
	);
}

export default EmptyOnboarding;
