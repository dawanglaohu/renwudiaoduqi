import { UI_STRINGS } from '../i18n/ui-strings.ts';
/**
 * packages/web/src/pages/settings-pipeline-page.tsx
 *
 * 流水线设置页（M9-T22 / AC 4）
 *
 * 规范依据（07 节前端架构）：
 * - pages 仅负责页面装配、骨架与栏位摆放
 * - 严禁 import src/api 与 src/store，严禁业务状态判定
 * - 页面只摆同一个容器（layout='settings'），并由容器声明「当前值来自 daemon」（AC 4）
 */

import { PipelineTogglesContainer } from '../features/run-deck/pipeline-toggles-container.tsx';

export function SettingsPipelinePage() {
	return (
		<div
			data-component="settings-pipeline-page"
			data-testid="settings-pipeline-page"
			className="flex min-h-screen flex-col bg-page text-ink-1 font-ui"
		>
			{/* 顶栏 52px */}
			<header className="h-topbar flex items-center justify-between border-b border-border bg-bg px-4 text-ink-1">
				<div className="flex items-center gap-2">
					<span className="font-mono text-dense text-ink-3">{UI_STRINGS.settings.title}</span>
					<span className="text-ink-3">/</span>
					<h1 className="font-ui text-dense font-semibold text-ink-1">
						{UI_STRINGS.settings.pipelineDescription}
					</h1>
				</div>
			</header>

			{/* 主内容区域 */}
			<main className="flex-1 min-w-0 p-[var(--sp-4)]">
				<div className="w-full min-w-0">
					<PipelineTogglesContainer layout="settings" />
				</div>
			</main>
		</div>
	);
}

export default SettingsPipelinePage;
