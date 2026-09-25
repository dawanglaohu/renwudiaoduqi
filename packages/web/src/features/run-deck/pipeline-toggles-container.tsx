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

import type {
	GetPipelineSettingsResponse,
	PipelineSettings,
	UpdatePipelineSettingsBody,
	UpdatePipelineSettingsResponse,
} from '@agent-scheduler/shared/api/settings';
import { InlineNotice } from '../../components/inline-notice.tsx';
import { PipelineToggles } from '../../components/pipeline-toggles.tsx';
import { UI_STRINGS } from '../../i18n/ui-strings.ts';
import { usePipelineSettings } from './use-pipeline-settings.ts';

export interface PipelineTogglesContainerProps {
	/** 外部注入的初始配置（可选，优先于异步拉取） */
	readonly initialPipeline?: PipelineSettings | null;
	/** 布局方向：topbar 紧凑横排（默认）或 settings 设置卡片 */
	readonly layout?: 'topbar' | 'settings';
	/** 自定义类名 */
	readonly className?: string;
	/** 自定义 fetcher / patcher（用于单元测试与集成测试） */
	readonly fetcher?: () => Promise<GetPipelineSettingsResponse>;
	readonly patcher?: (body: UpdatePipelineSettingsBody) => Promise<UpdatePipelineSettingsResponse>;
}

export function PipelineTogglesContainer({
	initialPipeline = null,
	layout = 'topbar',
	className = '',
	fetcher,
	patcher,
}: PipelineTogglesContainerProps) {
	const { pipeline, isPending, error, updatePipelineToggles } = usePipelineSettings({
		initialPipeline,
		fetcher,
		patcher,
	});

	const isSettings = layout === 'settings';

	return (
		<div
			data-component="pipeline-toggles-container"
			data-layout={layout}
			className={[isSettings ? 'flex flex-col gap-2' : 'flex items-center shrink-0', className]
				.filter(Boolean)
				.join(' ')}
		>
			{/* 设置页顶部常驻声明：当前值来自 daemon（AC 4） */}
			{isSettings && (
				<div data-testid="daemon-managed-notice" className="text-ink-3 font-ui text-xs">
					{UI_STRINGS.pipeline.daemonManagedNotice}
				</div>
			)}

			<PipelineToggles
				value={pipeline ? { bughunt: pipeline.bughunt, wrapupMode: pipeline.wrapupMode } : null}
				isPending={isPending}
				layout={layout}
				onChange={updatePipelineToggles}
			/>

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
	);
}

export default PipelineTogglesContainer;
