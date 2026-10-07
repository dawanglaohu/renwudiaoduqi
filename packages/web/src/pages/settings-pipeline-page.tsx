import { SettingsPageHeader } from '../components/settings-page-header.tsx';
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
			className="settings-page"
		>
			<SettingsPageHeader
				title={UI_STRINGS.settings.pipelineDescription}
				description={UI_STRINGS.settings.pipelineHint}
			/>

			{/* 主内容区域 */}
			<main className="min-w-0">
				<div className="w-full min-w-0">
					<PipelineTogglesContainer layout="settings" />
				</div>
			</main>
		</div>
	);
}

export default SettingsPipelinePage;
