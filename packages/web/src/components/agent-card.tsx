import { useEffect, useRef, useState } from 'react';
import type {
	AgentEntryDto,
	AgentModelItem,
	EffortValue,
	ListAgentModelsResponse,
} from '../../../shared/src/api/agents.ts';
import { UI_STRINGS } from '../i18n/ui-strings.ts';
import { EffortPicker } from './effort-picker.tsx';
import type { AgentFieldKey, FieldErrorInfo, FieldLayerValues } from './field-layers-row.tsx';
import { FieldLayersRow } from './field-layers-row.tsx';
import { LoginBadge } from './login-badge.tsx';
import { LoginHint } from './login-hint.tsx';
import { ModelPicker } from './model-picker.tsx';

/**
 * 卡片渲染的 agent 模型：daemon 的 `AgentEntryDto` 加上可选的分层字段。
 * `layers` 由 M4-T14 交付，本页只读它，不在前端补算出厂默认。
 */
export type AgentEntryWithLayers = AgentEntryDto;

export interface AgentCardProps {
	readonly agent: AgentEntryWithLayers;
	readonly getFieldLayers: (agent: AgentEntryWithLayers, field: AgentFieldKey) => FieldLayerValues;
	readonly onUpdateField: (
		agentId: string,
		field: AgentFieldKey,
		value: string | number,
	) => Promise<boolean>;
	readonly onProbe: (agentId: string) => Promise<unknown>;
	readonly models: readonly (AgentModelItem | string)[];
	readonly isModelsComplete?: boolean;
	readonly isModelsLoading?: boolean;
	readonly isModelsRefreshing?: boolean;
	readonly onRefreshModels?: () => void;
	readonly onAddCustomModel?: (model: string) => void;
	readonly validationError?: Partial<Record<AgentFieldKey | 'defaultEffortTier', FieldErrorInfo>>;
	readonly isProbing?: boolean;
	readonly isUpdating?: boolean;
	readonly catalog?: ListAgentModelsResponse | null;
	readonly onClearOverride?: (
		agentId: string,
		field: 'defaultModel' | 'defaultEffortTier',
	) => Promise<boolean>;
	readonly onUpdateEffortTier?: (agentId: string, value: EffortValue) => Promise<boolean>;
}

export const UNAVAILABLE_CODE_TITLES: Readonly<Record<string, string>> = Object.freeze({
	E_AGENT_EXEC_NOT_FOUND: '未找到可执行文件',
	E_AGENT_EXEC_NOT_EXECUTABLE: '可执行文件不可执行',
	E_AGENT_EXEC_INVALID_TARGET: '可执行路径格式不匹配当前平台',
	E_AGENT_VERSION_UNRECOGNIZED: '版本未识别',
	E_AGENT_UNAVAILABLE: '当前不可用',
	E_VALIDATION: '参数校验未通过',
	E_TIMEOUT: '探测超时',
});

function formatEffortValue(val: EffortValue | undefined | null): string {
	if (!val) return '—';
	if ('tier' in val) {
		return UI_STRINGS.refBar.effortTiers[val.tier] ?? val.tier;
	}
	if ('vendor' in val) {
		return val.vendor;
	}
	return '—';
}

/**
 * 单个 Agent 的设置卡片组件（M9-T14, M9-T23）
 * 规范约束（R3, R4, R6, R7, R8, AC 7, E-358）：
 * - 纯 props in / callback out，落 packages/web/src/components/；
 * - 卡片头部徽标 + 引导行，「刷新清单」与「重新探测」两个按钮；
 * - 三行表加「思考强度」列；
 * - dsh 的思考强度块显示「该 agent 不支持」，不渲染三行与按钮；
 * - 内置默认/你的覆盖读 layers，当前生效读顶层字段；
 * - 你的覆盖模型名不在 catalog.models 时加 chip「清单未列」；
 * - <400px 竖排，恢复默认按钮排在三行下方。
 */
export function AgentCard({
	agent,
	getFieldLayers,
	onUpdateField,
	onProbe,
	models,
	isModelsComplete = true,
	isModelsLoading = false,
	isModelsRefreshing = false,
	onRefreshModels,
	onAddCustomModel,
	validationError,
	isProbing = false,
	isUpdating = false,
	catalog = null,
	onClearOverride,
	onUpdateEffortTier,
}: AgentCardProps) {
	// R4: editing* 状态随 props 同步
	const [editingMonogram, setEditingMonogram] = useState<string>(agent.monogram);
	const [editingExecPath, setEditingExecPath] = useState<string>(agent.execPath ?? '');
	const [editingConcurrency, setEditingConcurrency] = useState<number>(agent.maxConcurrency);
	const [editingPermission, setEditingPermission] = useState<string>(agent.permissionTier);

	useEffect(() => {
		setEditingMonogram(agent.monogram);
	}, [agent.monogram]);

	useEffect(() => {
		setEditingExecPath(agent.execPath ?? '');
	}, [agent.execPath]);

	useEffect(() => {
		setEditingConcurrency(agent.maxConcurrency);
	}, [agent.maxConcurrency]);

	useEffect(() => {
		setEditingPermission(agent.permissionTier);
	}, [agent.permissionTier]);

	const execPathInputRef = useRef<HTMLInputElement>(null);

	// R3: 只按 reason === 'session-dir-overlap' 分支，不匹配英文 message
	const hasSessionOverlap =
		agent.errorDetails?.reason === 'session-dir-overlap' ||
		(agent.warningBanner?.details as { reason?: string } | undefined)?.reason ===
			'session-dir-overlap';

	// R8: 按 unavailableCode 映射中文标题，不写死「路径无效」
	const isUnavailable = !agent.isAvailable;
	const unavailableTitle = UNAVAILABLE_CODE_TITLES[agent.unavailableCode ?? ''] ?? '未就绪';

	// E-88: 点击跳转到配置项
	const handleJumpToConfig = () => {
		if (execPathInputRef.current) {
			execPathInputRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
			execPathInputRef.current.focus();
		}
	};

	// 字段图层数据（AC 1 / R1: 纯读 daemon 字段，未提供层显示「—」）
	const monogramLayers = getFieldLayers(agent, 'monogram');
	const execPathLayers = getFieldLayers(agent, 'execPath');
	const concurrencyLayers = getFieldLayers(agent, 'maxConcurrency');
	const permissionLayers = getFieldLayers(agent, 'permissionTier');

	// 默认模型分层信息（AC 7）
	const modelBuiltin = agent.layers?.defaultModel?.builtin ?? '—';
	const hasModelOverride = Boolean(agent.layers?.defaultModel?.hasOverride);
	const modelOverride = hasModelOverride ? (agent.layers?.defaultModel?.override ?? '—') : '—';
	const modelEffective = agent.defaultModel ?? '—';
	const isModelOverrideUnlisted = Boolean(
		hasModelOverride &&
			agent.layers?.defaultModel?.override &&
			catalog?.models &&
			catalog.models.length > 0 &&
			!catalog.models.some((m) => m.name === agent.layers?.defaultModel?.override),
	);

	// 思考强度支持性判定（AC 7, E-254, E-358: 检查 effortVendorMap，绝不按 agentId 判）
	const isEffortSupported = agent.effortVendorMap !== null && agent.effortVendorMap !== undefined;
	const effortBuiltin = formatEffortValue(agent.layers?.defaultEffortTier?.builtin);
	const hasEffortOverride = Boolean(agent.layers?.defaultEffortTier?.hasOverride);
	const effortOverride = hasEffortOverride
		? agent.layers?.defaultEffortTier?.override === null
			? UI_STRINGS.effortPicker.follow
			: formatEffortValue(agent.layers?.defaultEffortTier?.override)
		: '—';
	const effortEffective = formatEffortValue(agent.defaultEffortTier);

	return (
		<div
			data-testid={`agent-card-${agent.id}`}
			data-available={agent.isAvailable}
			className={`flex flex-col gap-4 rounded border bg-bg p-4 transition-opacity ${
				isUnavailable ? 'opacity-75 border-border-strong' : 'border-border'
			}`}
		>
			{/* 卡片头部：身份识别（E-184）、登录态徽标、状态徽标、刷新与探测按钮 */}
			<div className="flex flex-col gap-2 border-b border-border pb-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					{/* AC 6 & E-184 & E-185: 字母组配合完整名称出现，短码纯文本中性 chip 渲染，无外部素材 */}
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
								{/* AC 7: 卡片头部登录态徽标 */}
								<LoginBadge login={agent.login} />
							</div>
						</div>
					</div>

					{/* 状态徽标、刷新清单按钮与探测按钮 */}
					<div className="flex items-center gap-2">
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

						{/* AC 7: 刷新清单按钮 */}
						<button
							type="button"
							onClick={onRefreshModels}
							disabled={isModelsRefreshing}
							data-testid={`refresh-models-btn-${agent.id}`}
							className="inline-flex h-btn items-center gap-1.5 rounded-sm border border-border bg-panel-2 px-3 font-ui text-dense font-medium text-ink-2 hover:bg-bg hover:text-ink-1 disabled:opacity-40"
						>
							{isModelsRefreshing ? '刷新中...' : UI_STRINGS.agentCard.refreshModels}
						</button>

						{/* AC 7: 重新探测按钮 */}
						<button
							type="button"
							onClick={() => void onProbe(agent.id)}
							disabled={isProbing}
							data-testid={`probe-agent-btn-${agent.id}`}
							className="inline-flex h-btn items-center gap-1.5 rounded-sm border border-border bg-panel-2 px-3 font-ui text-dense font-medium text-ink-2 hover:bg-bg hover:text-ink-1 disabled:opacity-40"
						>
							{isProbing ? '探测中...' : UI_STRINGS.agentCard.reprobe}
						</button>
					</div>
				</div>

				{/* AC 7: 登录引导行（未登录/未知时渲染） */}
				<LoginHint login={agent.login} agentName={agent.name} />
			</div>

			{/* AC 4, E-88 & R8: 不可用态提示（中文映射标题，英文进入可展开技术详情） */}
			{isUnavailable && (
				<div
					data-testid={`unavailable-banner-${agent.id}`}
					className="flex flex-col gap-1 rounded-sm border border-down bg-down-soft p-3 text-left"
				>
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2 text-dense font-semibold text-down">
							<span>不可用（{unavailableTitle}）</span>
						</div>
						<button
							type="button"
							onClick={handleJumpToConfig}
							className="text-micro text-down underline hover:opacity-80"
						>
							修改配置 →
						</button>
					</div>

					{/* R8: 英文 requirement/reason 放入可展开技术详情 */}
					{(agent.unavailableReason ||
						(agent.missingRequirements && agent.missingRequirements.length > 0)) && (
						<details className="mt-1 text-meta">
							<summary className="cursor-pointer text-micro text-ink-3 hover:text-ink-2">
								技术详情
							</summary>
							<div className="mt-1 font-mono text-micro text-ink-2 break-all">
								{agent.missingRequirements?.join(', ') || agent.unavailableReason}
							</div>
						</details>
					)}
				</div>
			)}

			{/* AC 9, E-95 & R3: 收到 reason === session-dir-overlap 告警时显示中文提示 */}
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
					<span className="text-micro text-ink-2">请检查两处的会话存储路径配置</span>
				</div>
			)}

			{/* 配置字段列表 */}
			<div className="flex flex-col gap-3">
				{/* 1. 两字符短码（AC 5 / E-183） */}
				<FieldLayersRow layers={monogramLayers} fieldLabel={monogramLayers.label}>
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
						{/* AC 5 & R4: 中文错误提示及技术详情 */}
						{validationError?.monogram && (
							<div
								id={`monogram-error-${agent.id}`}
								data-testid={`monogram-error-${agent.id}`}
								className="flex flex-col gap-0.5 text-micro text-down"
							>
								<span>{validationError.monogram.message}</span>
								{validationError.monogram.technical && (
									<details className="mt-0.5 text-micro text-ink-3">
										<summary className="cursor-pointer hover:text-ink-2">技术详情</summary>
										<div className="font-mono text-micro text-ink-3 break-all">
											{validationError.monogram.technical}
										</div>
									</details>
								)}
							</div>
						)}
					</div>
				</FieldLayersRow>

				{/* 2. 可执行路径（AC 4 / E-88 挂钩点） */}
				<FieldLayersRow layers={execPathLayers} fieldLabel={execPathLayers.label}>
					<div className="flex flex-col gap-1">
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
						{validationError?.execPath && (
							<div
								data-testid={`execPath-error-${agent.id}`}
								className="flex flex-col gap-0.5 text-micro text-down"
							>
								<span>{validationError.execPath.message}</span>
								{validationError.execPath.technical && (
									<details className="mt-0.5 text-micro text-ink-3">
										<summary className="cursor-pointer hover:text-ink-2">技术详情</summary>
										<div className="font-mono text-micro text-ink-3 break-all">
											{validationError.execPath.technical}
										</div>
									</details>
								)}
							</div>
						)}
					</div>
				</FieldLayersRow>

				{/* 3. 默认模型（AC 2 / AC 3 / AC 7 / E-38 / E-358） */}
				<div className="flex flex-col gap-2 rounded-sm border border-border bg-panel-2 p-3 text-body">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							<span className="font-ui font-semibold text-ink-1 text-dense">默认模型</span>
						</div>
					</div>

					{/* 三行表（内置默认 / 你的覆盖 / 当前生效），<400px 竖排 */}
					<div className="grid grid-cols-1 gap-1 text-meta sm:grid-cols-3 max-[400px]:grid-cols-1">
						<div className="flex flex-col rounded bg-bg px-2 py-1">
							<span className="text-micro text-ink-3">内置默认</span>
							<span
								className="font-mono text-dense text-ink-2 truncate"
								title={modelBuiltin}
								data-testid="layer-builtin-defaultModel"
							>
								{modelBuiltin}
							</span>
						</div>
						<div className="flex flex-col rounded bg-bg px-2 py-1">
							<div className="flex items-center gap-1.5">
								<span className="text-micro text-ink-3">你的覆盖</span>
								{isModelOverrideUnlisted && (
									<span
										data-testid={`unlisted-model-chip-${agent.id}`}
										className="px-1 py-0.2 rounded-[3px] bg-panel-2 border border-border font-mono text-[9px] text-ink-3"
									>
										{UI_STRINGS.modelPicker.unlistedChip}
									</span>
								)}
							</div>
							<span
								className={`font-mono text-dense truncate ${
									hasModelOverride ? 'text-needs font-medium' : 'text-ink-3'
								}`}
								title={modelOverride}
								data-testid="layer-override-defaultModel"
							>
								{modelOverride}
							</span>
						</div>
						<div className="flex flex-col rounded bg-bg px-2 py-1">
							<span className="text-micro text-ink-3">当前生效</span>
							<span
								className="font-mono text-dense text-ink-1 font-medium truncate"
								title={modelEffective}
								data-testid="layer-effective-defaultModel"
							>
								{modelEffective}
							</span>
						</div>
					</div>

					{/* 恢复默认按钮排在三行下方 */}
					<div className="flex items-center justify-end">
						<button
							type="button"
							disabled={!hasModelOverride || isUpdating}
							title={!hasModelOverride ? UI_STRINGS.agentCard.noOverrideTitle : undefined}
							onClick={() => void onClearOverride?.(agent.id, 'defaultModel')}
							data-testid={`restore-default-defaultModel-${agent.id}`}
							className="rounded-sm border border-border bg-bg px-2 py-0.5 font-ui text-micro text-ink-2 hover:bg-panel-2 hover:text-ink-1 disabled:opacity-40 disabled:hover:bg-bg disabled:hover:text-ink-2"
						>
							{UI_STRINGS.agentCard.restoreDefault}
						</button>
					</div>

					{/* 模型选择控件 */}
					<div className="mt-1">
						<ModelPicker
							catalog={catalog}
							models={models}
							selectedModel={agent.defaultModel}
							onSelectModel={(model) => void onUpdateField(agent.id, 'defaultModel', model)}
							error={validationError?.defaultModel}
							isComplete={isModelsComplete}
							isLoading={isModelsLoading}
							isRefreshing={isModelsRefreshing}
							onRefresh={onRefreshModels}
							onAddCustomModel={onAddCustomModel}
							disabled={isUpdating}
						/>
					</div>
				</div>

				{/* 4. 思考强度（AC 7, E-254, E-351, E-358） */}
				{!isEffortSupported ? (
					/* dsh 等不支持思考强度的 agent：显示该 agent 不支持，不渲染三行与按钮（E-358） */
					<div
						data-testid={`effort-unsupported-block-${agent.id}`}
						className="flex flex-col gap-2 rounded-sm border border-border bg-panel-2 p-3 text-body"
					>
						<div className="flex items-center gap-2">
							<span className="font-ui font-semibold text-ink-1 text-dense">思考强度</span>
						</div>
						<div className="font-ui text-dense text-ink-3">
							{UI_STRINGS.agentCard.effortUnsupported}
						</div>
					</div>
				) : (
					/* 支持思考强度：三行表 + 恢复默认按钮 + EffortPicker */
					<div
						data-testid={`effort-block-${agent.id}`}
						className="flex flex-col gap-2 rounded-sm border border-border bg-panel-2 p-3 text-body"
					>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex items-center gap-2">
								<span className="font-ui font-semibold text-ink-1 text-dense">思考强度</span>
							</div>
						</div>

						{/* 三行表（内置默认 / 你的覆盖 / 当前生效），<400px 竖排 */}
						<div className="grid grid-cols-1 gap-1 text-meta sm:grid-cols-3 max-[400px]:grid-cols-1">
							<div className="flex flex-col rounded bg-bg px-2 py-1">
								<span className="text-micro text-ink-3">内置默认</span>
								<span
									className="font-mono text-dense text-ink-2 truncate"
									title={effortBuiltin}
									data-testid="layer-builtin-defaultEffortTier"
								>
									{effortBuiltin}
								</span>
							</div>
							<div className="flex flex-col rounded bg-bg px-2 py-1">
								<span className="text-micro text-ink-3">你的覆盖</span>
								<span
									className={`font-mono text-dense truncate ${
										hasEffortOverride ? 'text-needs font-medium' : 'text-ink-3'
									}`}
									title={effortOverride}
									data-testid="layer-override-defaultEffortTier"
								>
									{effortOverride}
								</span>
							</div>
							<div className="flex flex-col rounded bg-bg px-2 py-1">
								<span className="text-micro text-ink-3">当前生效</span>
								<span
									className="font-mono text-dense text-ink-1 font-medium truncate"
									title={effortEffective}
									data-testid="layer-effective-defaultEffortTier"
								>
									{effortEffective}
								</span>
							</div>
						</div>

						{/* 恢复默认按钮排在三行下方 */}
						<div className="flex items-center justify-end">
							<button
								type="button"
								disabled={!hasEffortOverride || isUpdating}
								title={!hasEffortOverride ? UI_STRINGS.agentCard.noOverrideTitle : undefined}
								onClick={() => void onClearOverride?.(agent.id, 'defaultEffortTier')}
								data-testid={`restore-default-defaultEffortTier-${agent.id}`}
								className="rounded-sm border border-border bg-bg px-2 py-0.5 font-ui text-micro text-ink-2 hover:bg-panel-2 hover:text-ink-1 disabled:opacity-40 disabled:hover:bg-bg disabled:hover:text-ink-2"
							>
								{UI_STRINGS.agentCard.restoreDefault}
							</button>
						</div>

						{/* 思考强度选择控件 */}
						<div className="mt-1">
							<EffortPicker
								vendorMap={agent.effortVendorMap ?? null}
								selectedModelEffortOptions={
									catalog?.models?.find((m) => m.name === agent.defaultModel)?.effortOptions ?? []
								}
								currentConfigEffort={catalog?.currentConfig?.effort ?? null}
								effortRecognized={catalog?.currentConfig?.effortRecognized ?? true}
								allowVendor={true}
								value={agent.defaultEffortTier ?? null}
								onChange={(newVal) => void onUpdateEffortTier?.(agent.id, newVal)}
								disabled={isUpdating}
							/>
							{validationError?.defaultEffortTier && (
								<div
									data-testid={`defaultEffortTier-error-${agent.id}`}
									className="flex flex-col gap-0.5 text-micro text-down mt-1"
								>
									<span>{validationError.defaultEffortTier.message}</span>
									{validationError.defaultEffortTier.technical && (
										<details className="mt-0.5 text-micro text-ink-3">
											<summary className="cursor-pointer hover:text-ink-2">技术详情</summary>
											<div className="font-mono text-micro text-ink-3 break-all">
												{validationError.defaultEffortTier.technical}
											</div>
										</details>
									)}
								</div>
							)}
						</div>
					</div>
				)}

				{/* 4. 最大并发数 */}
				<FieldLayersRow layers={concurrencyLayers} fieldLabel={concurrencyLayers.label}>
					<div className="flex flex-col gap-1">
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
						{validationError?.maxConcurrency && (
							<div className="text-micro text-down">{validationError.maxConcurrency.message}</div>
						)}
					</div>
				</FieldLayersRow>

				{/* 5. 权限档 */}
				<FieldLayersRow layers={permissionLayers} fieldLabel={permissionLayers.label}>
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
					{validationError?.permissionTier && (
						<div
							data-testid={`permissionTier-error-${agent.id}`}
							className="flex flex-col gap-0.5 text-micro text-down"
						>
							<span>{validationError.permissionTier.message}</span>
							{validationError.permissionTier.technical && (
								<details className="mt-0.5 text-micro text-ink-3">
									<summary className="cursor-pointer hover:text-ink-2">技术详情</summary>
									<div className="font-mono text-micro text-ink-3 break-all">
										{validationError.permissionTier.technical}
									</div>
								</details>
							)}
						</div>
					)}
				</FieldLayersRow>
			</div>
		</div>
	);
}
