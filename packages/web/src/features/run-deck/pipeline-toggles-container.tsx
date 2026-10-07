/**
 * packages/web/src/features/run-deck/pipeline-toggles-container.tsx
 *
 * 顶栏与设置页流水线开关容器组件（M9-T22 / AC 1, AC 2, AC 4, AC 5, E-157, E-318, E-356）
 *
 * 规范依据（07 节前端架构）：
 * - features 容器层：负责调用 api（经 use-pipeline-settings）、订阅事件流
 * - 容器里只许写 grid/flex/gap 布局结构，禁止写颜色字号圆角
 * - layout='settings' 时常驻显示「当前值来自 daemon」（AC 4）
 * - 读取或 PATCH 失败一律就地渲染 InlineNotice，不弹 toast、不弹 alert（AC 5, 07 节错误体系）
 */

import type { AgentEntryDto } from '@agent-scheduler/shared/api/agents';
import type {
	GetPipelineSettingsResponse,
	PipelineSettings,
	UpdatePipelineSettingsBody,
	UpdatePipelineSettingsResponse,
} from '@agent-scheduler/shared/api/settings';
import { useEffect, useState } from 'react';
import { listAgents } from '../../api/agents.ts';
import { peek } from '../../api/resource-cache.ts';
import { InlineNotice } from '../../components/inline-notice.tsx';
import { PipelineAssignment } from '../../components/pipeline-assignment.tsx';
import { PipelineNotes, PipelineToggles } from '../../components/pipeline-toggles.tsx';
import { UI_STRINGS } from '../../i18n/ui-strings.ts';
import { useAgentModelCatalogs } from '../settings-agents/use-agent-models.ts';
import { type PipelineSettingsSource, usePipelineSettings } from './use-pipeline-settings.ts';

export interface PipelineTogglesContainerProps {
	/** 外部注入的初始配置（可选，优先于异步拉取） */
	readonly initialPipeline?: PipelineSettings | null;
	/** 布局方向：topbar 紧凑横排（默认）或 settings 设置卡片 */
	readonly layout?: 'topbar' | 'settings';
	readonly notesHost?: HTMLElement | null;
	/** 自定义类名 */
	readonly className?: string;
	/** 自定义 fetcher / patcher（用于单元测试与集成测试） */
	readonly fetcher?: () => Promise<GetPipelineSettingsResponse>;
	readonly patcher?: (body: UpdatePipelineSettingsBody) => Promise<UpdatePipelineSettingsResponse>;
	readonly source?: PipelineSettingsSource;
	readonly agents?: readonly AgentEntryDto[];
}

export function PipelineTogglesContainer({
	initialPipeline = null,
	layout = 'topbar',
	notesHost = null,
	className = '',
	fetcher,
	patcher,
	source,
	agents: propAgents,
}: PipelineTogglesContainerProps) {
	const { pipeline, isPending, error, fieldErrors, updatePipelineSettings, updatePipelineToggles } =
		usePipelineSettings({
			initialPipeline,
			fetcher,
			patcher,
			source,
		});

	const isSettings = layout === 'settings';
	const canRenderAssignment =
		isSettings && (typeof document === 'undefined' || Boolean(document.body));
	const cachedAgents = peek<{ agents?: readonly AgentEntryDto[] }>('agents')?.agents;
	const [agents, setAgents] = useState<readonly AgentEntryDto[]>(propAgents ?? cachedAgents ?? []);

	useEffect(() => {
		if (propAgents || !canRenderAssignment || source || fetcher || patcher) return;
		let mounted = true;
		void listAgents()
			.then((res) => {
				if (mounted && res?.agents) {
					setAgents(res.agents);
				}
			})
			.catch(() => {});
		return () => {
			mounted = false;
		};
	}, [canRenderAssignment, propAgents, source, fetcher, patcher]);

	const modelCatalogs = useAgentModelCatalogs(
		canRenderAssignment ? agents.map((agent) => agent.id) : [],
	);
	const catalogs = Object.fromEntries(
		Object.entries(modelCatalogs).map(([id, result]) => [id, result.catalog]),
	);
	return (
		<div
			data-component="pipeline-toggles-container"
			data-layout={layout}
			className={[
				isSettings
					? 'grid w-full max-w-[1112px] grid-cols-1 min-[1144px]:grid-cols-[minmax(0,780px)_320px] gap-[var(--sp-3)] items-start'
					: 'flex items-center shrink-0',
				className,
			]
				.filter(Boolean)
				.join(' ')}
		>
			<div className={isSettings ? 'flex flex-col gap-[var(--sp-3)] min-w-0' : 'contents'}>
				<PipelineToggles
					value={pipeline ? { bughunt: pipeline.bughunt, wrapupMode: pipeline.wrapupMode } : null}
					isPending={isPending}
					layout={layout}
					notesHost={notesHost}
					showNotes={!isSettings}
					onChange={updatePipelineToggles}
				/>

				{/* AC 8 / E-356: 设置页在两个开关之下加审查覆盖与收口指派编辑区 */}
				{canRenderAssignment && (
					<div className="min-w-0 border-t border-border pt-3">
						<PipelineAssignment
							reviewOverride={pipeline?.reviewOverride ?? null}
							wrapupAssignment={pipeline?.wrapupAssignment ?? { mode: 'follow' }}
							onChangeReviewOverride={(reviewOverride) =>
								void updatePipelineSettings({ reviewOverride })
							}
							onChangeWrapupAssignment={(wrapupAssignment) =>
								void updatePipelineSettings({ wrapupAssignment })
							}
							agents={agents}
							catalogs={catalogs}
							disabled={isPending || !pipeline}
							errors={fieldErrors}
						/>
					</div>
				)}

				{/* 错误就地提示，E_PIPELINE_STAGE_DISABLED 按 stage 提示不 toast（AC 5） */}
				{error && (
					<InlineNotice
						tone="down"
						testId="pipeline-toggles-error"
						message={error.message}
						technical={error.technical}
					/>
				)}
			</div>
			{/* 设置页顶部常驻声明：当前值来自 daemon（AC 4） */}
			{isSettings && (
				<aside className="flex flex-col gap-[var(--sp-3)] min-w-0 rounded border border-border bg-bg p-3.5">
					<div data-testid="daemon-managed-notice" className="text-ink-3 font-ui text-xs">
						{UI_STRINGS.pipeline.daemonManagedNotice}
					</div>
					<PipelineNotes value={pipeline} />
				</aside>
			)}
		</div>
	);
}

export default PipelineTogglesContainer;
