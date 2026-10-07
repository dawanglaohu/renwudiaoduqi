import { SettingsPageHeader } from '../components/settings-page-header.tsx';
import { SettingsAgentsContainer } from '../features/settings-agents/settings-agents-container.tsx';
import { UI_STRINGS } from '../i18n/ui-strings.ts';

/**
 * 设置页：Agent 注册表与模型选择（M9-T14）
 * 规范约束（07 节前端架构）：
 * - pages 仅负责页面装配、骨架与栏位摆放；
 * - 严禁 import src/api 与 src/store，严禁业务状态判定。
 */
export function SettingsAgentsPage() {
	return (
		<div data-testid="settings-agents-page" className="settings-page">
			<SettingsPageHeader
				title={UI_STRINGS.settings.agentsDescription}
				description={UI_STRINGS.settings.agentsHint}
			/>

			{/* 主内容区域 */}
			<main className="min-w-0">
				<div className="w-full min-w-0">
					<SettingsAgentsContainer />
				</div>
			</main>
		</div>
	);
}

export default SettingsAgentsPage;
