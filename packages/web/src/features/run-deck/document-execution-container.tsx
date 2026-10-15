/**
 * 文档执行控制的容器（M9-T30）。只做排列，颜色和文案在展示层。
 */

import type { LaneView } from '@agent-scheduler/shared/api/lanes';
import { ROUTE_PATHS, navigateTo } from '../../app/routes.tsx';
import type { BatchTreeItem } from '../../components/batch-tree.tsx';
import { DocumentExecutionControls } from '../../components/document-execution-controls.tsx';
import { useSelectionStore } from '../../store/selection-store.ts';
import { type DocumentExecutionClient, useDocumentExecution } from './use-document-execution.ts';

export interface DocumentExecutionContainerProps {
	readonly lanes?: readonly LaneView[];
	readonly batches?: readonly BatchTreeItem[];
	readonly isTouch?: boolean;
	readonly isPhoneTier?: boolean;
	readonly client?: DocumentExecutionClient;
	readonly onOpenTask?: (taskId: string) => void;
	readonly onOpenBatch?: (batchId: string) => void;
	readonly onWrapup?: (batchId: string) => void;
}

export function DocumentExecutionContainer({
	lanes,
	batches,
	isTouch = false,
	isPhoneTier = false,
	client,
	onOpenTask,
	onOpenBatch,
	onWrapup,
}: DocumentExecutionContainerProps) {
	const docId = useSelectionStore((state) => state.selectedDocId);
	const model = useDocumentExecution(docId, { client });
	const currentBatch =
		model.execution?.currentBatchId && batches
			? (batches.find((batch) => batch.id === model.execution?.currentBatchId) ?? null)
			: null;
	const occupiedLaneCount = lanes ? lanes.filter((lane) => lane.currentRunId).length : null;

	return (
		<div data-component="document-execution-container" className="flex min-w-0 flex-col gap-3">
			<DocumentExecutionControls
				docId={docId}
				documents={model.documents}
				onDocumentId={(id) => {
					const selection = useSelectionStore.getState();
					if (selection.selectedDocId === id) return;
					selection.setSelectedDocId(id);
					selection.setSelectedBatchId(null);
				}}
				onOpenAgents={() => navigateTo(ROUTE_PATHS.settingsAgents)}
				execution={model.execution}
				assignment={model.assignment}
				agents={model.agents}
				catalog={model.catalog}
				isRefreshingModels={model.isRefreshingModels}
				batchProgress={currentBatch}
				occupiedLaneCount={occupiedLaneCount}
				laneCount={model.document?.laneCount ?? null}
				pendingAction={model.pendingAction}
				errorMessage={model.error?.message}
				errorTechnical={model.error?.technical}
				canControl={model.canControl}
				canStart={model.canStart}
				canPause={model.canPause}
				canResume={model.canResume}
				needsSourceConfirm={model.needsSourceConfirm}
				sourceConfirmed={model.sourceConfirmed}
				isTouch={isTouch}
				isPhoneTier={isPhoneTier}
				onAgentId={model.setAgentId}
				onModelName={model.setModelName}
				onEffort={model.setEffort}
				onStart={() => {
					void model.start();
				}}
				onPause={() => {
					void model.pause();
				}}
				onResume={() => {
					void model.resume();
				}}
				onConfirmSource={() => {
					void model.confirmSource();
				}}
				onRefreshAgent={() => {
					void model.refreshAgent();
				}}
				onOpenTasks={(taskIds) => {
					const taskId = taskIds[0];
					if (taskId) onOpenTask?.(taskId);
				}}
				onOpenLanding={(taskId) => navigateTo(`#/landing/${taskId}`)}
				onWrapup={(batchId) => onWrapup?.(batchId)}
				onOpenBatch={(batchId) => onOpenBatch?.(batchId)}
			/>
		</div>
	);
}
