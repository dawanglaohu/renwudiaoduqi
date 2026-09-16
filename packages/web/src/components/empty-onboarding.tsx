/**
 * packages/web/src/components/empty-onboarding.tsx
 *
 * 空态四步引导与文档变更横幅组件（M9-T16 / AC 1, AC 4, E-108, E-19, E-110, E-52, E-47）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 空态是「选文档 → 选批次 → 逐任务指派 → 派发」四步引导，当前步高亮、已完成步显示所选值可点回改，不是插画（AC 1, E-108）
 * - 四步引导第三步与第四步并发说明正文留给 M9-T18（assign-panel.tsx），本任务只保留四步外壳、步骤槽位、已完成步回显、派发动作
 * - 并发说明与瓶颈来源一律读 daemon 下发字段（props），缺失显示「—」，严禁前端自行计算（E-52, E-47）
 * - 删掉所有内置演示用的文档/批次/任务/agent/模型清单与假计数，第二步须按 batch.docId === selectedDocId 联动过滤
 * - 文档变更横幅显示「本文档已更新，N 个任务的依据已变」并可进入受影响任务的过滤列表（AC 4, E-19）
 * - 长时间盯屏下深色为默认、路径与代码等宽（AC 6, E-110）
 * - 纯展示组件（components 纯 props in / callback out），颜色全走 CSS 变量（check-forbidden 机检）
 */

import { type ReactNode, useState } from 'react';

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
	readonly taskCount?: number;
	readonly moduleKeys?: readonly string[];
	readonly description?: string;
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
	readonly effortTier?: string;
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
	/** 初始激活步骤（默认为 0） */
	readonly initialStep?: number;
	/** 当前激活步骤（受控模式，0=选文档, 1=选批次, 2=逐任务指派, 3=派发） */
	readonly currentStep?: number;
	/** 步骤切换回调 */
	readonly onStepChange?: (step: number) => void;
	/** 可选文档列表（必填 props，缺失或空时渲染「—」） */
	readonly documents?: readonly OnboardingDocOption[];
	/** 可选批次列表（第二步按 selectedDocId 过滤，缺失或空时渲染「—」） */
	readonly batches?: readonly OnboardingBatchOption[];
	/** 当前待指派的任务清单（用于槽位回显或派发） */
	readonly tasks?: readonly { id: string; taskKey: string; title: string }[];
	/** 步骤 3 槽位（正文由 M9-T18 assign-panel.tsx 提供，本任务保留外壳与槽位） */
	readonly step3Slot?: ReactNode;
	/** 步骤 3 已完成步回显文案（例如 "8 个任务已分别指派"） */
	readonly step3Summary?: string;
	/** 步骤 4 槽位（正文由 M9-T18 扩展，本任务保留外壳与槽位） */
	readonly step4Slot?: ReactNode;
	/** 有效并行并发容量（读 daemon 下发字段，缺失显示「—」，严禁前端计算） */
	readonly effectiveCapacity?: number | string | null;
	/** 并行窗口数上限（读 daemon 下发字段，缺失显示「—」） */
	readonly laneCount?: number | string | null;
	/** Agent 单体并发上限（读 daemon 下发字段，缺失显示「—」） */
	readonly agentConcurrencyLimit?: number | string | null;
	/** 瓶颈标识或瓶颈描述（读 daemon 下发字段，缺失显示「—」） */
	readonly bottleneckSource?: string | null;
	readonly bottleneckDescription?: string | null;
	/** 文档变更横幅信息（AC 4 / E-19） */
	readonly docChangeNotice?: DocChangeNotice | null;
	/** 查看受影响任务列表回调（AC 4 / E-19） */
	readonly onViewAffectedTasks?: (taskIds: readonly string[]) => void;
	/** 派发成功提交回调 */
	readonly onDispatch?: (payload: {
		docId: string;
		batchId: string;
		assignments?: readonly TaskAssignmentDraft[];
	}) => void;
	/** 样式自定义扩展 */
	readonly className?: string;
}

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
 * 空态四步引导控制台（AC 1, E-108, E-52, E-47）。
 * 选文档 → 选批次 → 逐任务指派 → 派发。
 */
export function EmptyOnboarding({
	initialStep = 0,
	currentStep: controlledStep,
	onStepChange,
	documents,
	batches,
	tasks,
	step3Slot,
	step3Summary,
	step4Slot,
	effectiveCapacity = null,
	laneCount = null,
	agentConcurrencyLimit = null,
	bottleneckSource = null,
	bottleneckDescription = null,
	docChangeNotice,
	onViewAffectedTasks,
	onDispatch,
	className = '',
}: EmptyOnboardingProps) {
	// 步进索引：0=选文档, 1=选批次, 2=逐任务指派, 3=派发
	const [internalStep, setInternalStep] = useState<number>(initialStep);
	const currentStep = controlledStep !== undefined ? controlledStep : internalStep;

	const changeStep = (next: number) => {
		setInternalStep(next);
		onStepChange?.(next);
	};

	// 第一步：选定文档（初始为空或首个传入的真实文档）
	const [selectedDocId, setSelectedDocId] = useState<string>(() => documents?.[0]?.id ?? '');

	// 第二步：选定批次（联动：初始选对应文档的第一个批次）
	const [selectedBatchId, setSelectedBatchId] = useState<string>(() => {
		const docId = documents?.[0]?.id ?? '';
		const firstMatchingBatch = batches?.find((b) => b.docId === docId);
		return firstMatchingBatch?.id ?? '';
	});

	const selectedDoc = documents?.find((d) => d.id === selectedDocId);

	// R5: 第二步按 batch.docId === selectedDocId 过滤批次
	const visibleBatches = batches ? batches.filter((b) => b.docId === selectedDocId) : [];
	const selectedBatch = visibleBatches.find((b) => b.id === selectedBatchId) ?? visibleBatches[0];

	// 切换选中文档时联动更新批次选择
	const handleSelectDoc = (docId: string) => {
		setSelectedDocId(docId);
		const matchingBatch = batches?.find((b) => b.docId === docId);
		setSelectedBatchId(matchingBatch?.id ?? '');
	};

	// 派发触发
	const handleTriggerDispatch = () => {
		onDispatch?.({
			docId: selectedDocId,
			batchId: selectedBatchId,
		});
	};

	// R4: 并发字段缺失显示「—」，严禁使用前端计算瓶颈
	const capacityText =
		effectiveCapacity !== null && effectiveCapacity !== undefined
			? typeof effectiveCapacity === 'number'
				? `${effectiveCapacity} 路`
				: String(effectiveCapacity)
			: '—';

	const laneCountText =
		laneCount !== null && laneCount !== undefined
			? typeof laneCount === 'number'
				? `${laneCount} 路`
				: String(laneCount)
			: '—';

	const agentLimitText =
		agentConcurrencyLimit !== null && agentConcurrencyLimit !== undefined
			? typeof agentConcurrencyLimit === 'number'
				? `${agentConcurrencyLimit} 路`
				: String(agentConcurrencyLimit)
			: '—';

	const bottleneckText =
		bottleneckDescription ??
		(bottleneckSource !== null && bottleneckSource !== undefined
			? `当前瓶颈：${bottleneckSource}`
			: '—');

	// 步骤元数据
	const steps = [
		{
			title: '选文档',
			completedSummary: selectedDoc ? selectedDoc.title : '—',
		},
		{
			title: '选批次',
			completedSummary: selectedBatch
				? `${selectedBatch.name} (${selectedBatch.taskCount !== undefined ? `${selectedBatch.taskCount} 项` : '—'})`
				: '—',
		},
		{
			title: '逐任务指派',
			completedSummary:
				step3Summary ?? (tasks && tasks.length > 0 ? `${tasks.length} 个任务已分别指派` : '—'),
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
									changeStep(idx);
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
						{documents && documents.length > 0 ? (
							documents.map((doc) => {
								const isSelected = doc.id === selectedDocId;
								return (
									<button
										type="button"
										key={doc.id}
										data-doc-id={doc.id}
										data-selected={isSelected ? 'true' : 'false'}
										onClick={() => handleSelectDoc(doc.id)}
										className={[
											'flex items-center justify-between p-3 rounded border text-left cursor-pointer transition-colors w-full',
											isSelected
												? 'border-needs bg-panel-2'
												: 'border-border bg-bg hover:border-border-strong',
										].join(' ')}
									>
										<div className="flex flex-col">
											<span className="font-ui text-dense font-semibold text-ink-1">
												{doc.title}
											</span>
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
							})
						) : (
							<div
								data-testid="empty-documents"
								className="p-6 text-center font-mono text-meta text-ink-3"
							>
								—
							</div>
						)}
					</div>

					<div className="flex justify-end pt-2">
						<button
							type="button"
							data-action="next-step-1"
							onClick={() => changeStep(1)}
							className="h-btn px-5 rounded-sm bg-needs text-on-needs font-semibold text-dense transition-colors hover:brightness-105"
						>
							下一步：选批次 →
						</button>
					</div>
				</section>
			)}

			{/* ─────────────────────────────────────────────────────────────
			    步骤 2 内容区：选批次（E-108, R5: 按 selectedDocId 联动过滤）
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
						{visibleBatches.length > 0 ? (
							visibleBatches.map((batch) => {
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
												{batch.moduleKeys && batch.moduleKeys.length > 0 && (
													<span className="font-mono text-micro text-ink-3 px-1.5 py-0.5 rounded bg-panel-2 border border-border">
														{batch.moduleKeys.join(', ')}
													</span>
												)}
											</div>
											{batch.description && (
												<span className="text-meta text-ink-3 mt-0.5">{batch.description}</span>
											)}
										</div>
										<div className="flex items-center gap-3 text-micro text-ink-2 font-mono">
											{batch.taskCount !== undefined && <span>{batch.taskCount} 个任务</span>}
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
							})
						) : (
							<div
								data-testid="empty-batches"
								className="p-6 text-center font-mono text-meta text-ink-3"
							>
								—
							</div>
						)}
					</div>

					<div className="flex items-center justify-between pt-2">
						<button
							type="button"
							data-action="prev-step"
							onClick={() => changeStep(0)}
							className="h-btn px-4 rounded-sm border border-border bg-panel-2 text-ink-2 hover:text-ink-1 text-dense"
						>
							← 返回选文档
						</button>
						<button
							type="button"
							data-action="next-step-2"
							onClick={() => changeStep(2)}
							className="h-btn px-5 rounded-sm bg-needs text-on-needs font-semibold text-dense transition-colors hover:brightness-105"
						>
							下一步：逐任务指派 →
						</button>
					</div>
				</section>
			)}

			{/* ─────────────────────────────────────────────────────────────
			    步骤 3 内容区：逐任务指派（外壳与步骤槽位，正文由 M9-T18 提供）
			    ───────────────────────────────────────────────────────────── */}
			{currentStep === 2 && (
				<section
					data-step-content="2"
					aria-label="第 3 步：逐任务指派"
					className="flex flex-col gap-4 rounded border border-border bg-bg p-4"
				>
					<div className="flex items-center justify-between">
						<div>
							<h3 className="text-dense font-semibold text-ink-1">第三步：逐任务指派</h3>
							<p className="text-meta text-ink-2">
								严禁「给整批一键统一套用模型」；每个任务独立指定会话参数（19 节第 7 条归 M9-T18）。
							</p>
						</div>
					</div>

					<div data-slot="step-3-assign" className="flex flex-col gap-2.5">
						{step3Slot ?? (
							<div
								data-testid="step-3-placeholder"
								className="p-6 rounded border border-border bg-page text-center font-mono text-meta text-ink-3"
							>
								{tasks && tasks.length > 0 ? (
									<div className="flex flex-col gap-2">
										<span className="font-semibold text-ink-2">
											就绪任务清单 ({tasks.length} 项)
										</span>
										<div className="flex flex-wrap gap-2 justify-center">
											{tasks.map((t) => (
												<span
													key={t.id}
													data-task-row={t.taskKey}
													className="px-2 py-1 rounded bg-panel-2 border border-border text-micro text-ink-1"
												>
													{t.taskKey}: {t.title}
												</span>
											))}
										</div>
									</div>
								) : (
									'—'
								)}
							</div>
						)}
					</div>

					<div className="flex items-center justify-between pt-2">
						<button
							type="button"
							data-action="prev-step"
							onClick={() => changeStep(1)}
							className="h-btn px-4 rounded-sm border border-border bg-panel-2 text-ink-2 hover:text-ink-1 text-dense"
						>
							← 返回选批次
						</button>
						<button
							type="button"
							data-action="next-step-3"
							onClick={() => changeStep(3)}
							className="h-btn px-5 rounded-sm bg-needs text-on-needs font-semibold text-dense transition-colors hover:brightness-105"
						>
							下一步：检查并发与派发 →
						</button>
					</div>
				</section>
			)}

			{/* ─────────────────────────────────────────────────────────────
			    步骤 4 内容区：并发限制审计与确认派发（AC 1, E-108, E-52, E-47）
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
								调度器遵循并发限制，呈现当前有效容量与瓶颈说明（E-52, E-47）。
							</p>
						</div>
					</div>

					{/* 并发说明卡片（读 daemon 下发字段，缺失显示「—」，R4） */}
					{step4Slot ?? (
						<div
							data-testid="concurrency-bottleneck-card"
							className="flex flex-col gap-3 p-3.5 rounded border border-border bg-panel-2 text-meta"
						>
							<div className="flex items-center justify-between">
								<span className="font-semibold text-ink-1">有效并行并发容量</span>
								<span className="font-mono text-num font-bold text-needs">{capacityText}</span>
							</div>

							<div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-micro font-mono">
								<div className="flex justify-between p-2 rounded bg-bg border border-border">
									<span className="text-ink-3">并行窗口数 (调度器)</span>
									<span className="text-ink-1 font-bold">{laneCountText}</span>
								</div>
								<div className="flex justify-between p-2 rounded bg-bg border border-border">
									<span className="text-ink-3">Agent 基础并发上限</span>
									<span className="text-ink-1 font-bold">{agentLimitText}</span>
								</div>
							</div>

							<div className="text-micro text-ink-2 border-t border-border pt-2">
								<span className="text-needs font-semibold font-mono">瓶颈分析：</span>
								<span>{bottleneckText}</span>
							</div>
						</div>
					)}

					{/* 派发清单摘要 */}
					<div className="flex items-center justify-between text-meta text-ink-2 p-3 rounded border border-border bg-page">
						<div>
							<span className="text-ink-3">就绪任务：</span>
							<span className="font-mono font-bold text-ink-1 ml-1">
								{tasks && tasks.length > 0 ? `${tasks.length} 个` : '—'}
							</span>
							<span className="text-ink-3 ml-3">所属文档：</span>
							<span className="font-mono text-ink-1 ml-1">
								{selectedDoc ? selectedDoc.title : '—'}
							</span>
							<span className="text-ink-3 ml-3">所属批次：</span>
							<span className="font-mono text-ink-1 ml-1">
								{selectedBatch ? selectedBatch.name : '—'}
							</span>
						</div>
						<div className="font-mono text-micro text-ink-3">状态: 待派发</div>
					</div>

					<div className="flex items-center justify-between pt-2">
						<button
							type="button"
							data-action="prev-step"
							onClick={() => changeStep(2)}
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
							启动批次派发
						</button>
					</div>
				</section>
			)}
		</div>
	);
}

export default EmptyOnboarding;
