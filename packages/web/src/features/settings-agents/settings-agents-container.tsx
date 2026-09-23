import { AgentCard, type AgentEntryWithLayers } from '../../components/agent-card.tsx';
import type {
	AgentFieldKey,
	FieldErrorInfo,
	FieldLayerValues,
} from '../../components/field-layers-row.tsx';
import { InlineNotice } from '../../components/inline-notice.tsx';
import { LaneCountSetting } from '../../components/lane-count-setting.tsx';
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
	readonly validationError?: Partial<Record<AgentFieldKey, FieldErrorInfo>>;
	readonly isProbing?: boolean;
	readonly isUpdating?: boolean;
}

function AgentCardItem({
	agent,
	getFieldLayers,
	onUpdateField,
	onProbe,
	validationError,
	isProbing,
	isUpdating,
}: AgentCardItemProps) {
	const { models, isComplete, isLoading, isRefreshing, refresh, addCustomModel } = useAgentModels(
		agent.id,
	);

	return (
		<AgentCard
			agent={agent}
			getFieldLayers={getFieldLayers}
			onUpdateField={onUpdateField}
			onProbe={onProbe}
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
		hasTargetDoc,
		targetDocName,
		laneCountError,
		probingAgentId,
		updatingAgentId,
		validationErrors,
		probeAgent,
		updateAgentField,
		setLaneCount,
		getFieldLayers,
	} = useSettingsAgents({ targetDocId });

	if (isLoading && agents.length === 0) {
		return (
			<div
				data-component="settings-agents-container"
				data-testid="settings-agents-container"
				className="flex flex-col gap-4"
			>
				<div className="flex items-center justify-center p-8">
					<InlineNotice tone="muted" message="正在加载 Agent 注册表..." />
				</div>
			</div>
		);
	}

	return (
		<div
			data-component="settings-agents-container"
			data-testid="settings-agents-container"
			className="flex flex-col gap-6"
		>
			{/* 错误提示：中文文案在展示层，daemon 英文 message 只进技术详情 */}
			{error && (
				<div className="flex flex-col gap-2">
					<InlineNotice
						tone="down"
						testId="settings-agents-error-notice"
						message="加载 Agent 列表失败，请重试"
						technical={error.message}
					/>
				</div>
			)}

			{/* 1. 任务并行窗口数设置（AC 8, E-248 & R5: 定位不到不渲染写入口） */}
			<LaneCountSetting
				laneCount={laneCount}
				onChangeLaneCount={(count) => void setLaneCount(count)}
				hasTargetDoc={hasTargetDoc}
				targetDocName={targetDocName}
				error={laneCountError}
			/>

			{/* 2. Agent 列表 */}
			<div className="flex flex-col gap-4">
				{agents.map((agent) => (
					<AgentCardItem
						key={agent.id}
						agent={agent}
						getFieldLayers={getFieldLayers}
						onUpdateField={updateAgentField}
						onProbe={probeAgent}
						validationError={validationErrors[agent.id]}
						isProbing={probingAgentId === agent.id}
						isUpdating={updatingAgentId === agent.id}
					/>
				))}
			</div>
		</div>
	);
}
