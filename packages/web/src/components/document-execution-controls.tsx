/**
 * 文档级开始、暂停、继续与批次进度（M9-T30）。
 * 纯 props。进度、能力位和阻断原因都来自调用方传入的 daemon 字段。
 */

import type { EffortValue } from '@agent-scheduler/shared/api/agents';
import type { ListAgentModelsResponse } from '@agent-scheduler/shared/api/agents';
import type {
	DocumentDefaultAssignment,
	DocumentExecutionBlocker,
	DocumentExecutionDto,
} from '@agent-scheduler/shared/api/document-execution';
import { UI_STRINGS } from '../i18n/ui-strings.ts';
import type { AssignableAgent } from './assign-panel.tsx';
import { EffortPicker } from './effort-picker.tsx';
import { InlineNotice } from './inline-notice.tsx';
import { ModelPicker } from './model-picker.tsx';

export interface DocumentBatchProgress {
	readonly taskCount?: number;
	readonly landedCount?: number;
	readonly runningCount?: number;
	readonly waitingCount?: number;
}

export interface DocumentExecutionControlsProps {
	readonly docId: string | null;
	readonly execution: DocumentExecutionDto | null;
	readonly assignment: DocumentDefaultAssignment;
	readonly agents: readonly AssignableAgent[];
	readonly catalog: ListAgentModelsResponse | null;
	readonly isRefreshingModels?: boolean;
	readonly batchProgress: DocumentBatchProgress | null;
	readonly occupiedLaneCount: number | null;
	readonly laneCount: number | null;
	readonly pendingAction: string | null;
	readonly errorMessage?: string | null;
	readonly errorTechnical?: string | null;
	readonly canControl: boolean;
	readonly canStart: boolean;
	readonly canPause: boolean;
	readonly canResume: boolean;
	readonly needsSourceConfirm: boolean;
	readonly sourceConfirmed: boolean;
	readonly isTouch?: boolean;
	readonly onAgentId: (agentId: string) => void;
	readonly onModelName: (modelName: string | null) => void;
	readonly onEffort: (effort: EffortValue) => void;
	readonly onStart: () => void;
	readonly onPause: () => void;
	readonly onResume: () => void;
	readonly onConfirmSource: () => void;
	readonly onRefreshAgent: () => void;
	readonly onOpenTasks: (taskIds: readonly string[]) => void;
	readonly onOpenLanding: (taskId: string) => void;
	readonly onWrapup: (batchId: string) => void;
	readonly onOpenBatch: (batchId: string) => void;
}

const COPY = UI_STRINGS.documentExecution;

function countOrNull(value: number | undefined): number | null {
	return typeof value === 'number' ? value : null;
}

function stateLabel(execution: DocumentExecutionDto | null): string {
	if (!execution) return COPY.loading;
	if (execution.state === 'completed') return COPY.stateCompleted;
	if (execution.state === 'running') return COPY.stateRunning;
	if (execution.state === 'paused') {
		const reason = execution.pauseReason
			? COPY.pauseReasons[execution.pauseReason as keyof typeof COPY.pauseReasons]
			: null;
		return reason ?? COPY.statePaused;
	}
	return COPY.stateIdle;
}

function controlHeight(isTouch: boolean): string {
	return isTouch ? 'h-btn-lg' : 'h-btn';
}

export function DocumentExecutionControls({
	docId,
	execution,
	assignment,
	agents,
	catalog,
	isRefreshingModels = false,
	batchProgress,
	occupiedLaneCount,
	laneCount,
	pendingAction,
	errorMessage,
	errorTechnical,
	canControl,
	canStart,
	canPause,
	canResume,
	needsSourceConfirm,
	sourceConfirmed,
	isTouch = false,
	onAgentId,
	onModelName,
	onEffort,
	onStart,
	onPause,
	onResume,
	onConfirmSource,
	onRefreshAgent,
	onOpenTasks,
	onOpenLanding,
	onWrapup,
	onOpenBatch,
}: DocumentExecutionControlsProps) {
	const height = controlHeight(isTouch);
	const selectedAgent = agents.find((agent) => agent.id === assignment.agentId) ?? null;
	const assignmentLocked = execution !== null && execution.state !== 'idle';
	const fieldsDisabled = assignmentLocked || !canControl || pendingAction !== null;
	const hasAgentUnavailable = execution?.blockers.some(
		(blocker) => blocker.code === 'agent_unavailable',
	);
	const waitingForRuns = execution?.blockers.some(
		(blocker) => blocker.code === 'source_runs_pending',
	);
	const modelEffortOptions = catalog?.models.find(
		(model) => model.name === assignment.modelName,
	)?.effortOptions;

	return (
		<section
			data-testid="document-execution"
			data-execution-state={execution?.state ?? 'missing'}
			data-complete={execution?.state === 'completed' ? 'true' : 'false'}
			data-source-confirmed={sourceConfirmed ? 'true' : 'false'}
			aria-busy={pendingAction !== null}
			aria-label={COPY.title}
			className="flex min-w-0 flex-col gap-3"
		>
			<div className="flex min-w-0 flex-col gap-1">
				<h2 className="font-ui text-dense font-semibold text-ink-1">{COPY.title}</h2>
				<p className="font-ui text-meta text-ink-2">{COPY.summary}</p>
			</div>

			{!docId ? (
				<p className="font-ui text-meta text-ink-3">{COPY.chooseDocument}</p>
			) : (
				<div className="flex min-w-0 flex-col gap-3 rounded border border-border bg-panel-2 p-3.5">
					{!canControl && (
						<InlineNotice tone="muted" testId="document-execution-offline" message={COPY.offline} />
					)}
					<p data-testid="document-execution-state" className="font-ui text-dense text-ink-1">
						{stateLabel(execution)}
					</p>
					<dl className="flex min-w-0 flex-col gap-1 font-ui text-meta text-ink-2">
						<div className="flex flex-wrap gap-2">
							<dt className="text-ink-3">
								{COPY.batchPosition(
									execution?.currentBatchNo ?? null,
									execution?.totalBatchCount ?? null,
								)}
							</dt>
						</div>
						<div>
							{COPY.completedBatches(
								execution?.completedBatchCount ?? null,
								execution?.totalBatchCount ?? null,
							)}
						</div>
						<div>
							{COPY.batchProgress(
								countOrNull(batchProgress?.landedCount),
								countOrNull(batchProgress?.taskCount),
								countOrNull(batchProgress?.runningCount),
								countOrNull(batchProgress?.waitingCount),
							)}
						</div>
						<div>{COPY.windowOccupancy(occupiedLaneCount, laneCount)}</div>
						<div data-testid="document-wrapup-progress">
							{execution?.wrapupProgress
								? COPY.wrapupProgress(
										execution.wrapupProgress.generationId,
										execution.wrapupProgress.validRounds,
										execution.wrapupProgress.physicalAttempts,
									)
								: COPY.wrapupEmpty}
						</div>
					</dl>

					{execution && execution.state === 'running' && hasAgentUnavailable && (
						<p data-testid="agent-unavailable-wait" className="font-ui text-meta text-needs">
							{COPY.planWaiting}
						</p>
					)}
					{waitingForRuns && (
						<p data-testid="source-runs-pending" className="font-ui text-meta text-ink-2">
							{COPY.waitingRuns}
						</p>
					)}

					{execution && execution.blockers.length > 0 && (
						<ul className="flex min-w-0 flex-col gap-2" data-testid="document-execution-blockers">
							{execution.blockers.map((blocker, index) => (
								<BlockerRow
									key={`${blocker.code}:${blocker.batchId ?? ''}:${index}`}
									blocker={blocker}
									height={height}
									disabled={!canControl || pendingAction !== null}
									onOpenTasks={onOpenTasks}
									onOpenLanding={onOpenLanding}
									onWrapup={onWrapup}
									onOpenBatch={onOpenBatch}
									onConfirmSource={onConfirmSource}
									onRefreshAgent={onRefreshAgent}
								/>
							))}
						</ul>
					)}

					<div className="flex min-w-0 flex-col gap-2">
						<span className="font-ui text-meta font-semibold text-ink-1">
							{COPY.defaultAssignment}
						</span>
						<p className="font-ui text-micro text-ink-3">{COPY.draftNote}</p>
						{assignmentLocked && (
							<p className="font-ui text-micro text-ink-3">{COPY.assignmentFrozen}</p>
						)}
						<label className="flex min-w-0 flex-col gap-1 font-ui text-meta text-ink-2">
							{COPY.agentLabel}
							<select
								data-testid="document-default-agent"
								aria-label={COPY.agentLabel}
								value={assignment.agentId}
								disabled={fieldsDisabled}
								onChange={(event) => onAgentId(event.target.value)}
								className={`${height} min-w-0 rounded border border-border bg-bg px-3 text-ink-1 disabled:opacity-50`}
							>
								<option value="">{COPY.agentPlaceholder}</option>
								{agents.map((agent) => (
									<option key={agent.id} value={agent.id}>
										{agent.name}
										{agent.isAvailable === false ? COPY.agentUnavailableSuffix : ''}
									</option>
								))}
							</select>
						</label>
						<div className="flex min-w-0 flex-col gap-1">
							<span className="font-ui text-meta text-ink-2">{COPY.modelLabel}</span>
							<ModelPicker
								catalog={selectedAgent?.catalog ?? catalog}
								selectedModel={assignment.modelName}
								onSelectModel={(model) => onModelName(model)}
								login={selectedAgent?.login}
								isRefreshing={isRefreshingModels}
								onRefresh={onRefreshAgent}
								disabled={fieldsDisabled || !assignment.agentId}
							/>
						</div>
						<div className="flex min-w-0 flex-col gap-1">
							<span className="font-ui text-meta text-ink-2">{COPY.effortLabel}</span>
							<EffortPicker
								vendorMap={selectedAgent?.effortVendorMap}
								value={assignment.effort}
								onChange={onEffort}
								currentConfigEffort={selectedAgent?.currentConfig?.effort}
								selectedModelEffortOptions={modelEffortOptions}
								agentEffortOptions={selectedAgent?.effortOptions}
								disabled={fieldsDisabled || !assignment.agentId}
							/>
						</div>
					</div>

					{needsSourceConfirm && !sourceConfirmed && (
						<p className="font-ui text-meta text-needs">{COPY.confirmSourceHint}</p>
					)}

					<div className="flex flex-wrap gap-2">
						{execution?.canStart && (
							<button
								type="button"
								data-action="start-document"
								disabled={!canStart}
								onClick={onStart}
								className={`${height} rounded-sm bg-needs px-4 font-ui text-dense font-semibold text-on-needs shadow-glow disabled:opacity-50`}
							>
								{COPY.start}
							</button>
						)}
						{execution?.canPause && (
							<button
								type="button"
								data-action="pause-document"
								disabled={!canPause}
								onClick={onPause}
								className={`${height} rounded-sm border border-border-strong bg-panel-2 px-4 font-ui text-dense text-ink-1 disabled:opacity-50`}
							>
								{COPY.pause}
							</button>
						)}
						{execution?.canResume && (
							<button
								type="button"
								data-action="resume-document"
								disabled={!canResume}
								onClick={onResume}
								className={`${height} rounded-sm bg-needs px-4 font-ui text-dense font-semibold text-on-needs disabled:opacity-50`}
							>
								{COPY.resume}
							</button>
						)}
						{needsSourceConfirm && (
							<button
								type="button"
								data-action="confirm-document-source"
								disabled={!canControl || pendingAction !== null}
								onClick={onConfirmSource}
								className={`${height} rounded-sm border border-border px-3 font-ui text-meta text-ink-1 disabled:opacity-50`}
							>
								{COPY.confirmSource}
							</button>
						)}
						{hasAgentUnavailable && (
							<button
								type="button"
								data-action="refresh-agent"
								disabled={!canControl || pendingAction !== null || !assignment.agentId}
								onClick={onRefreshAgent}
								className={`${height} rounded-sm border border-border px-3 font-ui text-meta text-ink-1 disabled:opacity-50`}
							>
								{COPY.refreshAgent}
							</button>
						)}
					</div>
					{errorMessage && (
						<InlineNotice
							tone="down"
							testId="document-execution-error"
							message={errorMessage}
							technical={errorTechnical ?? undefined}
						/>
					)}
				</div>
			)}
		</section>
	);
}

function BlockerRow({
	blocker,
	height,
	disabled,
	onOpenTasks,
	onOpenLanding,
	onWrapup,
	onOpenBatch,
	onConfirmSource,
	onRefreshAgent,
}: {
	readonly blocker: DocumentExecutionBlocker;
	readonly height: string;
	readonly disabled: boolean;
	readonly onOpenTasks: (taskIds: readonly string[]) => void;
	readonly onOpenLanding: (taskId: string) => void;
	readonly onWrapup: (batchId: string) => void;
	readonly onOpenBatch: (batchId: string) => void;
	readonly onConfirmSource: () => void;
	readonly onRefreshAgent: () => void;
}) {
	const label = COPY.blockers[blocker.code];
	const taskId = blocker.taskIds[0];
	let action: { readonly label: string; readonly onClick: () => void } | null = null;
	if (
		blocker.code === 'gate_waiting' ||
		blocker.code === 'task_failed' ||
		blocker.code === 'contract_pending'
	) {
		action = taskId
			? { label: COPY.openTasks, onClick: () => onOpenTasks(blocker.taskIds) }
			: blocker.batchId
				? { label: COPY.openBatch, onClick: () => onOpenBatch(blocker.batchId as string) }
				: null;
	} else if (blocker.code === 'awaiting_landing' && taskId) {
		action = { label: COPY.openLanding, onClick: () => onOpenLanding(taskId) };
	} else if (
		(blocker.code === 'wrapup_manual' || blocker.code === 'wrapup_attention') &&
		blocker.batchId
	) {
		action = { label: COPY.openWrapup, onClick: () => onWrapup(blocker.batchId as string) };
	} else if (blocker.code === 'source_unreadable' || blocker.code === 'doc_changed') {
		action = { label: COPY.confirmSource, onClick: onConfirmSource };
	} else if (blocker.code === 'agent_unavailable') {
		action = { label: COPY.refreshAgent, onClick: onRefreshAgent };
	} else if (blocker.code === 'legacy_batches_active' && blocker.batchId) {
		action = { label: COPY.openBatch, onClick: () => onOpenBatch(blocker.batchId as string) };
	}

	return (
		<li
			data-blocker={blocker.code}
			className="flex min-w-0 flex-wrap items-center justify-between gap-2 font-ui text-meta text-ink-1"
		>
			<span>{label}</span>
			{action && (
				<button
					type="button"
					data-blocker-action={blocker.code}
					disabled={disabled}
					onClick={action.onClick}
					className={`${height} rounded-sm border border-border px-3 text-ink-1 disabled:opacity-50`}
				>
					{action.label}
				</button>
			)}
		</li>
	);
}
