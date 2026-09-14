import { SettingsAgentsContainer } from '../features/settings-agents/settings-agents-container.tsx';

/**
 * 设置页：Agent 注册表与模型选择（M9-T14）
 * 规范约束（07 节前端架构）：
 * - pages 仅负责页面装配、骨架与栏位摆放；
 * - 严禁 import src/api 与 src/store，严禁业务状态判定。
 */
export function SettingsAgentsPage() {
	return (
		<div
			data-testid="settings-agents-page"
			className="flex min-h-screen flex-col bg-page text-ink-1 font-ui"
		>
			{/* 顶栏 52px */}
			<header className="h-topbar flex items-center justify-between border-b border-border bg-bg px-4 text-ink-1">
				<div className="flex items-center gap-2">
					<span className="font-mono text-dense text-ink-3">设置</span>
					<span className="text-ink-3">/</span>
					<h1 className="font-ui text-dense font-semibold text-ink-1">Agent 注册表与模型选择</h1>
				</div>
			</header>

			{/* 主内容区域 */}
			<main className="flex-1 p-4 sm:p-6">
				<div className="mx-auto max-w-4xl">
					<SettingsAgentsContainer />
				</div>
			</main>
		</div>
	);
}

export default SettingsAgentsPage;
