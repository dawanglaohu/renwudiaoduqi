import { AddAgentSection } from './add-agent-section.tsx';
import { AgentCard } from './agent-card.tsx';
import { LaneCountSetting } from './lane-count-setting.tsx';
import { useSettingsAgents } from './use-settings-agents.ts';

/**
 * 设置页 Agent 注册表与模型选择容器（M9-T14）
 * 规范约束（07 节前端架构）：
 * - 容器里只许写 grid/flex/gap 类名，禁止在容器里写颜色、字号、圆角；
 * - 唯一允许连接 API 与调用 useSettingsAgents 的层。
 */
export function SettingsAgentsContainer() {
	const {
		agents,
		isLoading,
		error,
		laneCount,
		laneCountError,
		probingAgentId,
		updatingAgentId,
		validationErrors,
		probeAgent,
		updateAgentField,
		restoreDefaultField,
		adoptDefaultField,
		setLaneCount,
		addCustomAgent,
		getFieldLayers,
		validateMonogram,
	} = useSettingsAgents();

	if (isLoading && agents.length === 0) {
		return (
			<div data-testid="settings-agents-container" className="flex flex-col gap-4">
				<div className="flex items-center justify-center p-8">
					<span className="font-ui text-dense text-ink-3">正在加载 Agent 注册表...</span>
				</div>
			</div>
		);
	}

	return (
		<div data-testid="settings-agents-container" className="flex flex-col gap-6">
			{/* 错误提示 */}
			{error && (
				<div className="flex flex-col gap-2">
					<div
						data-testid="settings-agents-error-notice"
						className="rounded border border-down bg-down-soft p-3 text-meta text-down"
					>
						加载 Agent 列表失败：{error.message}
					</div>
				</div>
			)}

			{/* 1. 任务并行窗口数设置（AC 8 & E-248） */}
			<LaneCountSetting
				laneCount={laneCount}
				onChangeLaneCount={(count) => void setLaneCount(count)}
				error={laneCountError}
			/>

			{/* 2. Agent 列表 */}
			<div className="flex flex-col gap-4">
				{agents.map((agent) => (
					<AgentCard
						key={agent.id}
						agent={agent}
						getFieldLayers={getFieldLayers}
						onUpdateField={updateAgentField}
						onRestoreDefault={restoreDefaultField}
						onAdoptDefault={adoptDefaultField}
						onProbe={probeAgent}
						validationError={validationErrors[agent.id]}
						isProbing={probingAgentId === agent.id}
						isUpdating={updatingAgentId === agent.id}
					/>
				))}
			</div>

			{/* 3. 接入新 Agent 区块（AC 7 & E-185） */}
			<AddAgentSection
				onAddAgent={addCustomAgent}
				existingAgentIds={agents.map((a) => a.id)}
				validateMonogram={validateMonogram}
			/>
		</div>
	);
}
