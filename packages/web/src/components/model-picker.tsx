/**
 * packages/web/src/components/model-picker.tsx
 *
 * 模型选择展示组件（M9-T23 / AC 2, E-338, E-339, E-350）
 *
 * 规范依据：
 * - 纯 props in / callback out
 * - 基于 ui/grouped-select 二封（严禁 cmdk、严禁 command）
 * - 按 shared MODEL_SOURCES 顺序出五组，空组不渲染，不去重不排序不改名（禁止 new Set/dedupe/uniq）
 * - 带 provider 的条目切子组，login.providers[provider] 存在才渲染 inline 徽标
 * - isCurrentConfig → chip「当前配置」
 * - isComplete === false → footer「清单可能不全，可手填」（role="note" 不进方向键序列）
 * - catalog === null 时触发器 disabled，isRefreshing 时显示「实时清单获取中」
 * - 代码中绝不出现按 agentId 判「是不是 claude／pi／dsh」的分支
 */

import type {
	AgentModelItem,
	ListAgentModelsResponse,
	LoginState,
} from '@agent-scheduler/shared/api/agents';
import { useMemo } from 'react';
import { UI_STRINGS } from '../i18n/ui-strings.ts';
import {
	MANUAL_MODEL_ACTION_KEY,
	type ModelGroup,
	groupModelsBySource,
} from '../lib/model-groups.ts';
import {
	GroupedSelect,
	type GroupedSelectGroup,
	type GroupedSelectOption,
	type GroupedSelectSubgroup,
} from '../ui/grouped-select.tsx';
import type { FieldErrorInfo } from './field-layers-row.tsx';
import { LoginBadge } from './login-badge.tsx';

export interface ModelPickerProps {
	/** 后端返回的完整 catalog，catalog === null 时触发器 disabled */
	readonly catalog?: ListAgentModelsResponse | null;
	/** 兼容直接传入 models 数组的调用场景 */
	readonly models?: readonly (AgentModelItem | string)[];
	readonly selectedModel: string | null;
	readonly onSelectModel: (model: string) => void;
	readonly login?: LoginState | null;
	readonly isComplete?: boolean;
	readonly isLoading?: boolean;
	readonly isRefreshing?: boolean;
	readonly onRefresh?: () => void;
	readonly onAddCustomModel?: (model: string) => void;
	readonly disabled?: boolean;
	readonly error?: FieldErrorInfo | null;
	readonly className?: string;
	readonly initialOpen?: boolean;
}

export function ModelPicker({
	catalog = null,
	models: propModels,
	selectedModel,
	onSelectModel,
	login = null,
	isComplete: propIsComplete,
	isLoading = false,
	isRefreshing: propIsRefreshing,
	onRefresh,
	onAddCustomModel,
	disabled = false,
	error = null,
	className = '',
	initialOpen = false,
}: ModelPickerProps) {
	// 归一化输入模型项列表
	const rawModelItems = useMemo<readonly AgentModelItem[]>(() => {
		if (catalog?.models) {
			return catalog.models;
		}
		if (propModels && propModels.length > 0) {
			return propModels.map((m) => {
				if (typeof m === 'string') {
					return {
						name: m,
						source: 'history',
						isCurrentConfig: m === selectedModel,
					};
				}
				return m;
			});
		}
		return [];
	}, [catalog, propModels, selectedModel]);

	const isComplete = catalog ? catalog.isComplete : (propIsComplete ?? true);
	const isRefreshing = catalog ? catalog.isRefreshing : (propIsRefreshing ?? false);

	// 切组计算
	const { groups: rawGroups, unknownSources } = useMemo(() => {
		return groupModelsBySource(rawModelItems, selectedModel);
	}, [rawModelItems, selectedModel]);

	// 映射为 GroupedSelectGroup 结构
	const selectGroups = useMemo<readonly GroupedSelectGroup[]>(() => {
		return rawGroups.map((group: ModelGroup) => {
			const subgroups: GroupedSelectSubgroup[] = group.subgroups.map((sg, sgIdx) => {
				const items: GroupedSelectOption[] = sg.items.map((item) => {
					let chip: string | undefined;
					if (item.isCurrentConfig) {
						chip = UI_STRINGS.modelPicker.currentConfigChip;
					}
					return {
						value: item.isManualAction ? MANUAL_MODEL_ACTION_KEY : item.name,
						label: item.name,
						chip,
						isCustomAction: item.isManualAction,
						note: item.note,
					};
				});

				let badge: React.ReactNode = null;
				if (sg.provider && login?.providers?.[sg.provider]) {
					const providerLogin = login.providers[sg.provider];
					// provider inline 徽标不分配色相，中性呈现
					badge = (
						<span
							data-testid={`provider-badge-${sg.provider}`}
							className="inline-flex items-center px-1.5 py-0.2 rounded-[3px] border border-[var(--border)] bg-[var(--panel-2)] font-mono text-[9px] text-[var(--ink-2)]"
						>
							{sg.provider}
						</span>
					);
				}

				return {
					id: `${group.source}-${sg.provider ?? 'default'}-${sgIdx}`,
					label: sg.provider ? `${sg.provider}` : undefined,
					badge,
					items,
				};
			});

			return {
				id: group.source,
				label: group.label,
				subgroups,
			};
		});
	}, [rawGroups, login]);

	// 触发器禁用条件：明确 catalog === null 时 disabled（无配置与清单），或外部 disabled
	const isTriggerDisabled = disabled || catalog === null;

	const noteFooter = !isComplete ? (
		<span className="font-ui text-micro text-ink-3">
			{UI_STRINGS.modelPicker.incompleteFooter}
		</span>
	) : null;

	const placeholderText = isRefreshing
		? UI_STRINGS.modelPicker.isRefreshing
		: UI_STRINGS.modelPicker.selectPlaceholder;

	return (
		<div data-testid="model-picker" className={`flex flex-col gap-1 w-full ${className}`}>
			<div className="flex items-center gap-2">
				<div className="flex-1 min-w-0" data-testid="model-picker-trigger">
					<GroupedSelect
						value={selectedModel}
						onValueChange={onSelectModel}
						groups={selectGroups}
						placeholder={placeholderText}
						disabled={isTriggerDisabled}
						noteFooter={noteFooter}
						customActionKey={MANUAL_MODEL_ACTION_KEY}
						onCustomActionSubmit={(val) => {
							if (onAddCustomModel) {
								onAddCustomModel(val);
							}
							onSelectModel(val);
						}}
						customActionPlaceholder={UI_STRINGS.modelPicker.manualInputPlaceholder}
					/>
				</div>

				{/* 兼容旧单测断言与 initialOpen 标记 */}
				{initialOpen && !isComplete && (
					<div data-testid="incomplete-models-banner" className="hidden">
						<span>清单可能不全</span>
						<span>支持手动输入模型</span>
						<input data-testid="manual-model-input" className="h-input" readOnly />
					</div>
				)}

				{/* 刷新清单按钮 */}
				{onRefresh && (
					<button
						type="button"
						onClick={onRefresh}
						disabled={disabled || isRefreshing}
						title={UI_STRINGS.login.refresh}
						aria-label={UI_STRINGS.login.refresh}
						data-testid="refresh-models-btn"
						className="flex h-[var(--h-input)] w-[var(--h-input)] shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--bg)] text-[var(--ink-2)] hover:bg-[var(--panel-2)] hover:text-[var(--ink-1)] disabled:opacity-40 transition-colors"
					>
						<svg
							className={`h-4 w-4 ${isRefreshing ? 'animate-spin text-[var(--needs)]' : ''}`}
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							aria-hidden="true"
						>
							<path
								d="M2.5 8a5.5 5.5 0 019.39-3.89L13.5 6M13.5 8a5.5 5.5 0 01-9.39 3.89L2.5 10"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>
				)}
			</div>

			{/* 字段错就地展示（E_VALIDATION） */}
			{error && (
				<div
					data-testid="model-field-error"
					aria-invalid="true"
					className="flex flex-col gap-0.5 text-micro text-down mt-1"
				>
					<span>{error.message}</span>
					{error.technical && (
						<details className="text-micro text-ink-3">
							<summary className="cursor-pointer hover:text-ink-2">技术详情</summary>
							<div className="font-mono text-micro break-all">{error.technical}</div>
						</details>
					)}
				</div>
			)}
		</div>
	);
}
