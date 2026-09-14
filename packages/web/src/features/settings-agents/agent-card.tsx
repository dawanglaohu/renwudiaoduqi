import { useRef, useState } from 'react';
import type { ProbeAgentResponse } from '../../../../shared/src/api/agents.ts';
import { FieldLayersRow } from './field-layers-row.tsx';
import { ModelPicker } from './model-picker.tsx';
import {
	type AgentFieldKey,
	FIELD_LABELS,
	type FieldLayerValues,
	type RegisteredAgentItem,
} from './types.ts';

export interface AgentCardProps {
	readonly agent: RegisteredAgentItem;
	readonly getFieldLayers: (agent: RegisteredAgentItem, field: AgentFieldKey) => FieldLayerValues;
	readonly onUpdateField: (
		agentId: string,
		field: AgentFieldKey,
		value: string | number,
	) => Promise<boolean>;
	readonly onRestoreDefault: (agentId: string, field: AgentFieldKey) => Promise<boolean>;
	readonly onAdoptDefault: (agentId: string, field: AgentFieldKey) => Promise<boolean>;
	readonly onProbe: (agentId: string) => Promise<ProbeAgentResponse | undefined>;
	readonly validationError?: Partial<Record<AgentFieldKey, string>>;
	readonly isProbing?: boolean;
	readonly isUpdating?: boolean;
}

/**
 * 单个 Agent 的设置卡片组件（M9-T14）
 * 覆盖验收标准：
 * - AC 1 & E-92: 每个字段显示「内置默认 / 你的覆盖 / 当前生效」并带「恢复默认」与「一键采纳」；
 * - AC 4 & E-88: agent 不可用时置灰并写明缺什么，点击可跳到该项配置；
 * - AC 5 & E-183: 短码可编辑、保存时唯一性校验，撞车要求改一个；
 * - AC 6 & E-184: 字母组配合完整名称出现，悬停/长按出全名，字母组不得成为唯一标识；
 * - AC 9 & E-95: reason 精确等于 session-dir-overlap 时显示「会话记录可能互相覆盖」，不直出英文。
 */
export function AgentCard({
	agent,
	getFieldLayers,
	onUpdateField,
	onRestoreDefault,
	onAdoptDefault,
	onProbe,
	validationError,
	isProbing = false,
	isUpdating = false,
}: AgentCardProps) {
	const [editingMonogram, setEditingMonogram] = useState<string>(agent.monogram);
	const [editingExecPath, setEditingExecPath] = useState<string>(agent.execPath ?? '');
	const [editingConcurrency, setEditingConcurrency] = useState<number>(agent.maxConcurrency);
	const [editingPermission, setEditingPermission] = useState<string>(agent.permissionTier);

	const execPathInputRef = useRef<HTMLInputElement>(null);

	// E-95: 检查是否有 reason === 'session-dir-overlap' 的告警
	const hasSessionOverlap =
		agent.warningBanner?.message === 'Session records may overwrite each other' ||
		agent.errorDetails?.reason === 'session-dir-overlap' ||
		(agent.warningBanner as { reason?: string })?.reason === 'session-dir-overlap' ||
		agent.warnings?.some((w) => w.reason === 'session-dir-overlap');

	// E-88: 不可用状态判定与缺失项提取
	const isUnavailable = !agent.isAvailable;
	const missingText =
		agent.missingRequirements && agent.missingRequirements.length > 0
			? agent.missingRequirements.join('，')
			: agent.unavailableReason || '路径无效或未检测到可执行文件';

	// E-88: 点击跳转到配置项
	const handleJumpToConfig = () => {
		if (execPathInputRef.current) {
			execPathInputRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
			execPathInputRef.current.focus();
		}
	};

	// 字段图层数据
	const monogramLayers = getFieldLayers(agent, 'monogram');
	const execPathLayers = getFieldLayers(agent, 'execPath');
	const modelLayers = getFieldLayers(agent, 'defaultModel');
	const concurrencyLayers = getFieldLayers(agent, 'maxConcurrency');
	const permissionLayers = getFieldLayers(agent, 'permissionTier');

	return (
		<div
			data-testid={`agent-card-${agent.id}`}
			data-available={agent.isAvailable}
			className={`flex flex-col gap-4 rounded border bg-bg p-4 transition-opacity ${
				isUnavailable ? 'opacity-75 border-border-strong' : 'border-border'
			}`}
		>
			{/* 卡片头部：身份识别（E-184）、状态徽标、操作按钮 */}
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
				{/* AC 6 & E-184: 紧凑档/窄屏下字母组配合完整名称出现，字母组不得成为唯一标识 */}
				<div className="flex items-center gap-3">
					<span
						data-testid={`monogram-chip-${agent.id}`}
						title={agent.name}
						aria-label={agent.name}
						className="flex h-7 w-7 items-center justify-center rounded-sm border border-border bg-panel-2 font-mono text-dense font-bold text-ink-1 select-none"
					>
						{agent.monogram}
					</span>
					<div className="flex flex-col">
						<div className="flex items-center gap-2">
							<span
								data-testid={`agent-name-${agent.id}`}
								className="font-ui text-lead font-semibold text-ink-1"
							>
								{agent.name}
							</span>
							<span className="font-mono text-micro text-ink-3">({agent.id})</span>
						</div>
					</div>
				</div>

				{/* 状态徽标与探测按钮 */}
				<div className="flex items-center gap-2">
					{/* 可用状态标识 */}
					<span
						data-testid={`agent-status-badge-${agent.id}`}
						className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-ui text-micro font-medium ${
							agent.isAvailable
								? 'border border-auto bg-auto-soft text-auto'
								: 'border border-down bg-down-soft text-down'
						}`}
					>
						<span aria-hidden="true">{agent.isAvailable ? '✓' : '✕'}</span>
						<span>{agent.isAvailable ? '可用' : '不可用'}</span>
					</span>

					{/* 重新探测按钮 */}
					<button
						type="button"
						onClick={() => void onProbe(agent.id)}
						disabled={isProbing}
						data-testid={`probe-agent-btn-${agent.id}`}
						className="inline-flex h-btn items-center gap-1.5 rounded-sm border border-border bg-panel-2 px-3 font-ui text-dense font-medium text-ink-2 hover:bg-bg hover:text-ink-1 disabled:opacity-40"
					>
						{isProbing ? '探测中...' : '重新探测'}
					</button>
				</div>
			</div>

			{/* AC 4 & E-88: agent 不可用时置灰并写明缺什么，点击可跳到该项配置 */}
			{isUnavailable && (
				<button
					type="button"
					onClick={handleJumpToConfig}
					data-testid={`unavailable-banner-${agent.id}`}
					className="flex flex-col items-start gap-1 rounded-sm border border-down bg-down-soft p-3 text-left transition-colors hover:brightness-105"
				>
					<div className="flex items-center gap-2 text-dense font-semibold text-down">
						<span>不可用（路径无效）</span>
						<span className="text-micro underline">点击前往修改配置 →</span>
					</div>
					<div className="text-meta text-ink-2">
						缺失项：<span className="font-mono text-ink-1">{missingText}</span>
					</div>
				</button>
			)}

			{/* AC 9 & E-95: 收到 reason 精确等于 session-dir-overlap 的告警时显示「会话记录可能互相覆盖」 */}
			{hasSessionOverlap && (
				<div
					data-testid={`session-overlap-warning-${agent.id}`}
					className="flex items-center justify-between rounded-sm border border-needs bg-needs-soft p-3 text-meta text-needs"
				>
					<div className="flex items-center gap-2">
						<span className="font-bold" aria-hidden="true">
							!
						</span>
						<span className="font-ui font-medium">会话记录可能互相覆盖</span>
					</div>
					<span className="text-micro text-ink-2">请检查两处的会话存储路径是否相同</span>
				</div>
			)}

			{/* 配置字段列表（AC 1 / E-92 的 3 行表呈现） */}
			<div className="flex flex-col gap-3">
				{/* 1. 两字符短码（AC 5 / E-183） */}
				<FieldLayersRow
					layers={monogramLayers}
					fieldLabel={FIELD_LABELS.monogram}
					onRestoreDefault={() => void onRestoreDefault(agent.id, 'monogram')}
					onAdoptDefault={() => void onAdoptDefault(agent.id, 'monogram')}
				>
					<div className="flex flex-col gap-1">
						<div className="flex items-center gap-2">
							<input
								type="text"
								maxLength={2}
								value={editingMonogram}
								onChange={(e) => setEditingMonogram(e.target.value.toUpperCase())}
								onBlur={() => {
									if (editingMonogram.length === 2 && editingMonogram !== agent.monogram) {
										void onUpdateField(agent.id, 'monogram', editingMonogram);
									}
								}}
								placeholder="2字符短码"
								aria-label="两字符短码"
								aria-invalid={Boolean(validationError?.monogram)}
								aria-describedby={
									validationError?.monogram ? `monogram-error-${agent.id}` : undefined
								}
								data-testid={`input-monogram-${agent.id}`}
								className={`h-input w-28 rounded-sm border bg-bg px-2.5 font-mono text-dense text-ink-1 focus:outline-none ${
									validationError?.monogram ? 'border-down' : 'border-border focus:border-needs'
								}`}
							/>
							{editingMonogram !== agent.monogram && (
								<button
									type="button"
									onClick={() => void onUpdateField(agent.id, 'monogram', editingMonogram)}
									disabled={isUpdating || editingMonogram.length !== 2}
									className="rounded-sm bg-needs px-2 py-1 font-ui text-micro font-medium text-on-needs hover:opacity-90 disabled:opacity-40"
								>
									保存短码
								</button>
							)}
						</div>
						{/* AC 5: 撞车错误提示 */}
						{validationError?.monogram && (
							<div
								id={`monogram-error-${agent.id}`}
								data-testid={`monogram-error-${agent.id}`}
								className="text-micro text-down"
							>
								{validationError.monogram}
							</div>
						)}
					</div>
				</FieldLayersRow>

				{/* 2. 可执行路径（AC 4 / E-88 挂钩点） */}
				<FieldLayersRow
					layers={execPathLayers}
					fieldLabel={FIELD_LABELS.execPath}
					onRestoreDefault={() => void onRestoreDefault(agent.id, 'execPath')}
					onAdoptDefault={() => void onAdoptDefault(agent.id, 'execPath')}
				>
					<div className="flex items-center gap-2">
						<input
							ref={execPathInputRef}
							id={`agent-${agent.id}-execPath`}
							type="text"
							value={editingExecPath}
							onChange={(e) => setEditingExecPath(e.target.value)}
							onBlur={() => {
								if (editingExecPath !== (agent.execPath ?? '')) {
									void onUpdateField(agent.id, 'execPath', editingExecPath);
								}
							}}
							placeholder="输入可执行文件绝对路径或命令名..."
							aria-label="可执行路径"
							data-testid={`input-execPath-${agent.id}`}
							className="h-input flex-1 rounded-sm border border-border bg-bg px-2.5 font-mono text-dense text-ink-1 focus:border-needs focus:outline-none"
						/>
						{editingExecPath !== (agent.execPath ?? '') && (
							<button
								type="button"
								onClick={() => void onUpdateField(agent.id, 'execPath', editingExecPath)}
								disabled={isUpdating}
								className="rounded-sm bg-needs px-2.5 py-1 font-ui text-micro font-medium text-on-needs hover:opacity-90 disabled:opacity-40"
							>
								更新路径
							</button>
						)}
					</div>
				</FieldLayersRow>

				{/* 3. 默认模型（AC 2 / AC 3 / E-38） */}
				<FieldLayersRow
					layers={modelLayers}
					fieldLabel={FIELD_LABELS.defaultModel}
					onRestoreDefault={() => void onRestoreDefault(agent.id, 'defaultModel')}
					onAdoptDefault={() => void onAdoptDefault(agent.id, 'defaultModel')}
				>
					<ModelPicker
						agentId={agent.id}
						selectedModel={agent.defaultModel}
						onSelectModel={(model) => void onUpdateField(agent.id, 'defaultModel', model)}
					/>
				</FieldLayersRow>

				{/* 4. 最大并发数 */}
				<FieldLayersRow
					layers={concurrencyLayers}
					fieldLabel={FIELD_LABELS.maxConcurrency}
					onRestoreDefault={() => void onRestoreDefault(agent.id, 'maxConcurrency')}
					onAdoptDefault={() => void onAdoptDefault(agent.id, 'maxConcurrency')}
				>
					<div className="flex items-center gap-2">
						<input
							type="number"
							min={0}
							max={32}
							value={editingConcurrency}
							onChange={(e) => setEditingConcurrency(Number(e.target.value))}
							onBlur={() => {
								if (editingConcurrency !== agent.maxConcurrency) {
									void onUpdateField(agent.id, 'maxConcurrency', editingConcurrency);
								}
							}}
							aria-label="最大并发数"
							data-testid={`input-maxConcurrency-${agent.id}`}
							className="h-input w-24 rounded-sm border border-border bg-bg px-2.5 font-mono text-dense text-ink-1 focus:border-needs focus:outline-none"
						/>
						{editingConcurrency !== agent.maxConcurrency && (
							<button
								type="button"
								onClick={() => void onUpdateField(agent.id, 'maxConcurrency', editingConcurrency)}
								disabled={isUpdating}
								className="rounded-sm bg-needs px-2 py-1 font-ui text-micro font-medium text-on-needs hover:opacity-90 disabled:opacity-40"
							>
								保存并发
							</button>
						)}
					</div>
				</FieldLayersRow>

				{/* 5. 权限档 */}
				<FieldLayersRow
					layers={permissionLayers}
					fieldLabel={FIELD_LABELS.permissionTier}
					onRestoreDefault={() => void onRestoreDefault(agent.id, 'permissionTier')}
					onAdoptDefault={() => void onAdoptDefault(agent.id, 'permissionTier')}
				>
					<select
						value={editingPermission}
						onChange={(e) => {
							const val = e.target.value;
							setEditingPermission(val);
							void onUpdateField(agent.id, 'permissionTier', val);
						}}
						aria-label="权限档"
						data-testid={`select-permissionTier-${agent.id}`}
						className="h-input rounded-sm border border-border bg-bg px-2.5 font-ui text-dense text-ink-1 focus:border-needs focus:outline-none"
					>
						<option value="readOnly">readOnly（只读模式）</option>
						<option value="workspaceWrite">workspaceWrite（工作区写权限）</option>
						<option value="unrestricted">unrestricted（无限制）</option>
					</select>
				</FieldLayersRow>
			</div>
		</div>
	);
}
