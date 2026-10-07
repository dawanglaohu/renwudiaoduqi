import type { EffortValue } from '../../../../shared/src/api/agents.ts';
import { AgentCard, type AgentEntryWithLayers } from '../../components/agent-card.tsx';
import type {
	AgentFieldKey,
	FieldErrorInfo,
	FieldLayerValues,
} from '../../components/field-layers-row.tsx';
import { InlineNotice } from '../../components/inline-notice.tsx';
import { LaneCountSetting } from '../../components/lane-count-setting.tsx';
import { UI_STRINGS } from '../../i18n/ui-strings.ts';
import { useAgentModels } from './use-agent-models.ts';
import { useSettingsAgents } from './use-settings-agents.ts';

interface AgentCardItemProps {
	readonly agent: AgentEntryWithLayers;
	readonly getFieldLayers: (agent: AgentEntryWithLayers, field: AgentFieldKey) => FieldLayerValues;
	readonly onUpdateField: (
		agentId: string,
		field: AgentFieldKey,
		value: string | number,
	) => Promise<boolean>;
	readonly onProbe: (agentId: string) => Promise<unknown>;
	readonly onClearOverride: (
		agentId: string,
		field: 'defaultModel' | 'defaultEffortTier',
	) => Promise<boolean>;
	readonly onUpdateEffortTier: (agentId: string, value: EffortValue) => Promise<boolean>;
	readonly validationError?: Partial<Record<AgentFieldKey | 'defaultEffortTier', FieldErrorInfo>>;
	readonly isProbing?: boolean;
	readonly isUpdating?: boolean;
}

function AgentCardItem({
	agent,
	getFieldLayers,
	onUpdateField,
	onProbe,
	onClearOverride,
	onUpdateEffortTier,
	validationError,
	isProbing,
	isUpdating,
}: AgentCardItemProps) {
	const { catalog, models, isComplete, isLoading, isRefreshing, refresh, addCustomModel } =
		useAgentModels(agent.id);

	return (
		<AgentCard
			agent={agent}
			getFieldLayers={getFieldLayers}
			onUpdateField={onUpdateField}
			onProbe={onProbe}
			onClearOverride={onClearOverride}
			onUpdateEffortTier={onUpdateEffortTier}
			catalog={catalog}
			models={models}
			isModelsComplete={isComplete}
			isModelsLoading={isLoading}
			isModelsRefreshing={isRefreshing}
			onRefreshModels={refresh}
			onAddCustomModel={addCustomModel}
			validationError={validationError}
			isProbing={isProbing}
			isUpdating={isUpdating}
		/>
	);
}

/**
 * 设置页 Agent 注册表与模型选择容器（M9-T14）
 * 规范约束（07 节前端架构与 R7）：
 * - features 是唯一允许调用 API 与管理数据 Hook 的层；
 * - 展示组件（AgentCard / LaneCountSetting / InlineNotice）在 components/，纯 props in / callback out；
 * - 容器里只许写 grid/flex/gap 类名，禁止在容器里写颜色、字号、圆角。
 */
export function SettingsAgentsContainer({ targetDocId }: { readonly targetDocId?: string | null }) {
	const {
		agents,
		isLoading,
		error,
		laneCount,
		documents,
		targetDocId: selectedDocId,
		selectTargetDoc,
		isSavingLaneCount,
		hasTargetDoc,
		targetDocName,
		laneCountError,
		probingAgentId,
		updatingAgentId,
		validationErrors,
		probeAgent,
		updateAgentField,
		clearAgentOverride,
		updateAgentEffortTier,
		setLaneCount,
		getFieldLayers,
	} = useSettingsAgents({ targetDocId });

	if (isLoading && agents.length === 0) {
		return (
			<div
				data-component="settings-agents-container"
				data-testid="settings-agents-container"
				className="flex flex-col gap-[var(--sp-3)]"
			>
				<div className="flex items-start p-3.5">
					<InlineNotice tone="muted" message={UI_STRINGS.settingsAgents.loading} />
				</div>
			</div>
		);
	}

	return (
		<div
			data-component="settings-agents-container"
			data-testid="settings-agents-container"
			className="flex flex-col gap-[var(--sp-3)]"
		>
			{/* 错误提示：中文文案在展示层，daemon 英文 message 只进技术详情 */}
			{error && (
				<div className="flex flex-col gap-2">
					<InlineNotice
						tone="down"
						testId="settings-agents-error-notice"
						message={UI_STRINGS.settingsAgents.loadFailed}
						technical={error.message}
					/>
				</div>
			)}

			{/* 1. 任务并行窗口数设置（AC 8, E-248 & R5: 定位不到不渲染写入口） */}
			<LaneCountSetting
				key={selectedDocId ?? 'unselected'}
				laneCount={laneCount}
				documents={documents}
				targetDocId={selectedDocId}
				onChangeTargetDoc={targetDocId ? undefined : selectTargetDoc}
				disabled={isSavingLaneCount}
				onChangeLaneCount={(count) => void setLaneCount(count)}
				hasTargetDoc={hasTargetDoc}
				targetDocName={targetDocName}
				error={laneCountError}
			/>

			{/* 2. Agent 列表 */}
			<div className="agent-settings-grid grid grid-cols-[repeat(auto-fit,minmax(min(100%,560px),1fr))] items-start">
				{agents.map((agent) => (
					<AgentCardItem
						key={agent.id}
						agent={agent}
						getFieldLayers={getFieldLayers}
						onUpdateField={updateAgentField}
						onProbe={probeAgent}
						onClearOverride={clearAgentOverride}
						onUpdateEffortTier={updateAgentEffortTier}
						validationError={validationErrors[agent.id]}
						isProbing={probingAgentId === agent.id}
						isUpdating={updatingAgentId === agent.id}
					/>
				))}
			</div>
		</div>
	);
}
