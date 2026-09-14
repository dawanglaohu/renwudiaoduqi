import { isBrowserMode } from '../../shell/shell-bridge.ts';

export interface BrowserModeBannerProps {
	readonly className?: string;
}

/**
 * Persistent banner for browser mode capability deficits (AC 5 / E-229).
 * Explicitly states BOTH:
 *   1. 「关闭标签后需重新配对」
 *   2. 「本模式下没有系统通知」
 */
export function BrowserModeBanner({ className = '' }: BrowserModeBannerProps) {
	if (!isBrowserMode()) {
		return null;
	}

	return (
		<aside
			data-testid="browser-mode-banner"
			role="note"
			className={`p-3 rounded-sm bg-needs-soft border border-needs text-needs flex items-start gap-3 ${className}`}
		>
			<span className="font-mono font-semibold text-meta px-1.5 py-0.5 rounded-sm bg-needs text-on-needs shrink-0">
				浏览器模式
			</span>
			<div className="text-body leading-snug">
				当前运行于免壳浏览器模式：
				<span className="font-semibold underline">关闭标签后需重新配对</span>
				，且
				<span className="font-semibold underline">本模式下没有系统通知</span>
				。如需会话持久化与系统级后台提醒，请使用桌面端 (Tauri) 或手机端 (Capacitor) 壳应用。
			</div>
		</aside>
	);
}
