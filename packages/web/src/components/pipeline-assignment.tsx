/**
 * packages/web/src/components/pipeline-assignment.tsx
 *
 * 流水线审查覆盖与收口指派设置展示组件（M9-T23 / AC 8, E-356）
 *
 * 规范依据：
 * - 纯展示层组件：纯 props in / callback out
 * - 审查覆盖与收口指派各常驻一行说明，不弹 dialog
 * - 思考强度支持通用三档及所选 Agent 的原生值
 * - E_VALIDATION 的 details.field 点路径就地渲染在对应控件下方并 aria-invalid
 * - disabled 期间禁用所有子控件
 */

import type {
	AgentEntryDto,
	EffortTier,
	EffortValue,
	ListAgentModelsResponse,
} from '@agent-scheduler/shared/api/agents';
import type { ReviewOverride, WrapupAssignment } from '@agent-scheduler/shared/api/settings';
import { useMemo } from 'react';
import { UI_STRINGS } from '../i18n/ui-strings.ts';
import { EffortPicker } from './effort-picker.tsx';
import { ModelPicker } from './model-picker.tsx';

export interface PipelineAssignmentProps {
	readonly reviewOverride: ReviewOverride | null;
	readonly wrapupAssignment: WrapupAssignment;
	readonly onChangeReviewOverride: (override: ReviewOverride | null) => void;
	readonly onChangeWrapupAssignment: (assignment: WrapupAssignment) => void;
	readonly agents?: readonly AgentEntryDto[];
	readonly catalogs?: Readonly<Record<string, ListAgentModelsResponse | null>>;
	readonly disabled?: boolean;
	readonly errors?: Readonly<Record<string, string>>;
	readonly className?: string;
}

export function PipelineAssignment({
	reviewOverride,
	wrapupAssignment,
	onChangeReviewOverride,
	onChangeWrapupAssignment,
	agents = [],
	catalogs = {},
	disabled = false,
	errors = {},
	className = '',
}: PipelineAssignmentProps) {
	// 查找当前选中的 Agent
	const reviewAgent = useMemo(() => {
		if (!reviewOverride?.agentId) return null;
		return agents.find((a) => a.id === reviewOverride.agentId) ?? null;
	}, [agents, reviewOverride?.agentId]);

	const wrapupAgent = useMemo(() => {
		if (wrapupAssignment.mode !== 'fixed') return null;
		return agents.find((a) => a.id === wrapupAssignment.agentId) ?? null;
	}, [agents, wrapupAssignment]);

	// 审查覆盖切换模式
	const isReviewFollow = reviewOverride === null;
	const handleToggleReviewMode = (follow: boolean) => {
		if (follow) {
			onChangeReviewOverride(null);
		} else {
			const fallbackAgentId = agents[0]?.id;
			if (!fallbackAgentId) return;
			onChangeReviewOverride({
				agentId: fallbackAgentId,
				modelName: null,
				effortTier: null,
			});
		}
	};

	// 收口指派切换模式
	const isWrapupFollow = wrapupAssignment.mode === 'follow';
	const handleToggleWrapupMode = (follow: boolean) => {
		if (follow) {
			onChangeWrapupAssignment({ mode: 'follow' });
		} else {
			const fallbackAgentId = agents[0]?.id;
			if (!fallbackAgentId) return;
			onChangeWrapupAssignment({
				mode: 'fixed',
				agentId: fallbackAgentId,
				modelName: null,
				effortTier: null,
			});
		}
	};

	return (
		<div
			data-testid="pipeline-assignment-container"
			className={`grid grid-cols-1 min-[1000px]:grid-cols-2 items-start gap-[var(--sp-3)] max-[639px]:[&_button]:min-h-[var(--h-btn-lg)] max-[639px]:[&_select]:min-h-[var(--h-input-touch)] ${className}`}
		>
			{/* 1. 审查覆盖设置区 */}
			<div data-testid="review-override-section" className="flex min-w-0 flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2.5">
					<div>
						<h3 className="font-ui text-dense font-semibold text-[var(--ink-1)]">
							{UI_STRINGS.pipelineAssignment.reviewOverrideTitle}
						</h3>
						<p className="font-ui text-meta text-[var(--ink-2)] mt-0.5">
							{UI_STRINGS.pipelineAssignment.reviewOverrideFollowNote}
						</p>
					</div>

					{/* 模式切换按钮 */}
					<div className="flex items-center rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--panel-2)] p-0.5">
						<button
							type="button"
							data-testid="review-override-follow-btn"
							onClick={() => handleToggleReviewMode(true)}
							disabled={disabled}
							className={`h-7 px-3 rounded-[4px] font-ui text-[12px] font-medium transition-colors ${
								isReviewFollow
									? 'bg-[var(--bg)] text-[var(--ink-1)] shadow-sm'
									: 'text-[var(--ink-3)] hover:text-[var(--ink-1)]'
							} disabled:opacity-50`}
						>
							{UI_STRINGS.pipelineAssignment.modeFollow}
						</button>
						<button
							type="button"
							data-testid="review-override-custom-btn"
							onClick={() => handleToggleReviewMode(false)}
							disabled={disabled || agents.length === 0}
							className={`h-7 px-3 rounded-[4px] font-ui text-[12px] font-medium transition-colors ${
								!isReviewFollow
									? 'bg-[var(--bg)] text-[var(--ink-1)] shadow-sm'
									: 'text-[var(--ink-3)] hover:text-[var(--ink-1)]'
							} disabled:opacity-50`}
						>
							{UI_STRINGS.pipelineAssignment.modeCustom}
						</button>
					</div>
				</div>

				{/* 审查覆盖指定表单控件 */}
				{!isReviewFollow && reviewOverride && (
					<div className="grid min-w-0 grid-cols-1 gap-3 min-[600px]:grid-cols-3 pt-1">
						{/* Agent 选择 */}
						<div className="flex min-w-0 flex-col gap-1">
							<label
								htmlFor="review-override-agent-select"
								className="text-meta font-ui text-[var(--ink-2)]"
							>
								{UI_STRINGS.assignment.agentLabel}
							</label>
							<select
								id="review-override-agent-select"
								data-testid="review-override-agent-select"
								value={reviewOverride.agentId}
								onChange={(e) =>
									onChangeReviewOverride({
										...reviewOverride,
										agentId: e.target.value,
										modelName: null,
										effortTier: null,
										effortVendor: null,
									})
								}
								disabled={disabled}
								aria-invalid={Boolean(errors['reviewOverride.agentId'])}
								className="min-w-0 w-full h-[var(--h-input)] px-2.5 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--panel-2)] text-dense font-mono text-[var(--ink-1)] focus:border-[var(--needs)] focus:outline-none disabled:opacity-50"
							>
								<option value="">{UI_STRINGS.pipelineAssignment.agentSelectPlaceholder}</option>
								{agents.map((ag) => (
									<option key={ag.id} value={ag.id}>
										{ag.name} ({ag.monogram})
									</option>
								))}
							</select>
							{errors['reviewOverride.agentId'] && (
								<div
									data-testid="error-reviewOverride-agentId"
									aria-invalid="true"
									className="text-micro text-[var(--down)] font-ui"
								>
									{errors['reviewOverride.agentId']}
								</div>
							)}
						</div>

						{/* 模型选择 */}
						<div className="flex min-w-0 flex-col gap-1">
							<span className="text-meta font-ui text-[var(--ink-2)]">
								{UI_STRINGS.assignment.modelLabel}
							</span>
							<ModelPicker
								catalog={reviewAgent ? catalogs[reviewAgent.id] : null}
								selectedModel={reviewOverride.modelName ?? null}
								onSelectModel={(model) =>
									onChangeReviewOverride({
										...reviewOverride,
										modelName: model || null,
										...(catalogs[reviewOverride.agentId]?.models.find(
											(item) => item.name === (model || reviewAgent?.defaultModel),
										)?.effortOptions?.length === 0
											? { effortTier: null, effortVendor: null }
											: {}),
									})
								}
								login={reviewAgent?.login}
								disabled={disabled}
							/>
							{errors['reviewOverride.modelName'] && (
								<div
									data-testid="error-reviewOverride-modelName"
									aria-invalid="true"
									className="text-micro text-[var(--down)] font-ui"
								>
									{errors['reviewOverride.modelName']}
								</div>
							)}
						</div>

						{/* 思考强度选择 */}
						<div className="flex min-w-0 flex-col gap-1">
							<span className="text-meta font-ui text-[var(--ink-2)]">
								{UI_STRINGS.assignment.effortLabel}
							</span>
							<EffortPicker
								vendorMap={reviewAgent?.effortVendorMap}
								agentEffortOptions={reviewAgent?.effortOptions}
								selectedModelEffortOptions={
									catalogs[reviewOverride.agentId]?.models.find(
										(m) => m.name === (reviewOverride.modelName ?? reviewAgent?.defaultModel),
									)?.effortOptions
								}
								value={
									reviewOverride.effortVendor
										? { vendor: reviewOverride.effortVendor }
										: reviewOverride.effortTier
											? { tier: reviewOverride.effortTier }
											: null
								}
								onChange={(val: EffortValue) => {
									const tier: EffortTier | null = val && 'tier' in val ? val.tier : null;
									onChangeReviewOverride({
										...reviewOverride,
										effortTier: tier,
										effortVendor: val && 'vendor' in val ? val.vendor : null,
									});
								}}
								disabled={disabled}
							/>
							{(errors['reviewOverride.effortTier'] || errors['reviewOverride.effortVendor']) && (
								<div
									data-testid="error-reviewOverride-effortTier"
									aria-invalid="true"
									className="text-micro text-[var(--down)] font-ui"
								>
									{errors['reviewOverride.effortTier'] || errors['reviewOverride.effortVendor']}
								</div>
							)}
						</div>
					</div>
				)}
			</div>

			{/* 2. 收口指派设置区 */}
			<div data-testid="wrapup-assignment-section" className="flex min-w-0 flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2.5">
					<div>
						<h3 className="font-ui text-dense font-semibold text-[var(--ink-1)]">
							{UI_STRINGS.pipelineAssignment.wrapupAssignmentTitle}
						</h3>
						<p className="font-ui text-meta text-[var(--ink-2)] mt-0.5">
							{UI_STRINGS.pipelineAssignment.wrapupAssignmentFollowNote}
						</p>
					</div>

					{/* 模式切换按钮 */}
					<div className="flex items-center rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--panel-2)] p-0.5">
						<button
							type="button"
							data-testid="wrapup-assignment-follow-btn"
							onClick={() => handleToggleWrapupMode(true)}
							disabled={disabled}
							className={`h-7 px-3 rounded-[4px] font-ui text-[12px] font-medium transition-colors ${
								isWrapupFollow
									? 'bg-[var(--bg)] text-[var(--ink-1)] shadow-sm'
									: 'text-[var(--ink-3)] hover:text-[var(--ink-1)]'
							} disabled:opacity-50`}
						>
							{UI_STRINGS.pipelineAssignment.modeFollow}
						</button>
						<button
							type="button"
							data-testid="wrapup-assignment-custom-btn"
							onClick={() => handleToggleWrapupMode(false)}
							disabled={disabled || agents.length === 0}
							className={`h-7 px-3 rounded-[4px] font-ui text-[12px] font-medium transition-colors ${
								!isWrapupFollow
									? 'bg-[var(--bg)] text-[var(--ink-1)] shadow-sm'
									: 'text-[var(--ink-3)] hover:text-[var(--ink-1)]'
							} disabled:opacity-50`}
						>
							{UI_STRINGS.pipelineAssignment.modeCustom}
						</button>
					</div>
				</div>

				{/* 收口固定指派表单控件 */}
				{!isWrapupFollow && wrapupAssignment.mode === 'fixed' && (
					<div className="grid min-w-0 grid-cols-1 gap-3 min-[600px]:grid-cols-3 pt-1">
						{/* Agent 选择 */}
						<div className="flex min-w-0 flex-col gap-1">
							<label
								htmlFor="wrapup-assignment-agent-select"
								className="text-meta font-ui text-[var(--ink-2)]"
							>
								{UI_STRINGS.assignment.agentLabel}
							</label>
							<select
								id="wrapup-assignment-agent-select"
								data-testid="wrapup-assignment-agent-select"
								value={wrapupAssignment.agentId}
								onChange={(e) =>
									onChangeWrapupAssignment({
										mode: 'fixed',
										agentId: e.target.value,
										modelName: null,
										effortTier: null,
									})
								}
								disabled={disabled}
								aria-invalid={Boolean(errors['wrapupAssignment.agentId'])}
								className="min-w-0 w-full h-[var(--h-input)] px-2.5 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--panel-2)] text-dense font-mono text-[var(--ink-1)] focus:border-[var(--needs)] focus:outline-none disabled:opacity-50"
							>
								<option value="">{UI_STRINGS.pipelineAssignment.agentSelectPlaceholder}</option>
								{agents.map((ag) => (
									<option key={ag.id} value={ag.id}>
										{ag.name} ({ag.monogram})
									</option>
								))}
							</select>
							{errors['wrapupAssignment.agentId'] && (
								<div
									data-testid="error-wrapupAssignment-agentId"
									aria-invalid="true"
									className="text-micro text-[var(--down)] font-ui"
								>
									{errors['wrapupAssignment.agentId']}
								</div>
							)}
						</div>

						{/* 模型选择 */}
						<div className="flex min-w-0 flex-col gap-1">
							<span className="text-meta font-ui text-[var(--ink-2)]">
								{UI_STRINGS.assignment.modelLabel}
							</span>
							<ModelPicker
								catalog={wrapupAgent ? catalogs[wrapupAgent.id] : null}
								selectedModel={wrapupAssignment.modelName ?? null}
								onSelectModel={(model) =>
									onChangeWrapupAssignment({
										...wrapupAssignment,
										modelName: model || null,
										...(catalogs[wrapupAssignment.agentId]?.models.find(
											(item) => item.name === (model || wrapupAgent?.defaultModel),
										)?.effortOptions?.length === 0
											? { effortTier: null, effortVendor: null }
											: {}),
									})
								}
								login={wrapupAgent?.login}
								disabled={disabled}
							/>
							{errors['wrapupAssignment.modelName'] && (
								<div
									data-testid="error-wrapupAssignment-modelName"
									aria-invalid="true"
									className="text-micro text-[var(--down)] font-ui"
								>
									{errors['wrapupAssignment.modelName']}
								</div>
							)}
						</div>

						{/* 思考强度选择 */}
						<div className="flex min-w-0 flex-col gap-1">
							<span className="text-meta font-ui text-[var(--ink-2)]">
								{UI_STRINGS.assignment.effortLabel}
							</span>
							<EffortPicker
								vendorMap={wrapupAgent?.effortVendorMap}
								agentEffortOptions={wrapupAgent?.effortOptions}
								selectedModelEffortOptions={
									catalogs[wrapupAssignment.agentId]?.models.find(
										(m) => m.name === (wrapupAssignment.modelName ?? wrapupAgent?.defaultModel),
									)?.effortOptions
								}
								value={
									wrapupAssignment.effortVendor
										? { vendor: wrapupAssignment.effortVendor }
										: wrapupAssignment.effortTier
											? { tier: wrapupAssignment.effortTier }
											: null
								}
								onChange={(val: EffortValue) => {
									const tier: EffortTier | null = val && 'tier' in val ? val.tier : null;
									onChangeWrapupAssignment({
										...wrapupAssignment,
										effortTier: tier,
										effortVendor: val && 'vendor' in val ? val.vendor : null,
									});
								}}
								disabled={disabled}
							/>
							{(errors['wrapupAssignment.effortTier'] ||
								errors['wrapupAssignment.effortVendor']) && (
								<div
									data-testid="error-wrapupAssignment-effortTier"
									aria-invalid="true"
									className="text-micro text-[var(--down)] font-ui"
								>
									{errors['wrapupAssignment.effortTier'] || errors['wrapupAssignment.effortVendor']}
								</div>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
