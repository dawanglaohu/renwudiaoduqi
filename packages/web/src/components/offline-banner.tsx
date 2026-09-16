/**
 * packages/web/src/components/offline-banner.tsx
 *
 * M9-T11: Offline, daemon failure, version mismatch, and optimistic stop rollback banners
 * (07-前端架构 / AC 1-4, E-04, E-12, E-14, E-157).
 *
 * Architecture rules:
 * - Pure presentation component: props in / callback out (07-前端架构).
 * - Strictly prohibited from importing store, api, features, or shell.
 * - All colors and tokens must use token utility classes (bg-down-soft, text-meta, rounded-sm, etc.).
 * - AC 1 / E-157: Presents rollback notice when optimistic stop fails.
 * - AC 2 / E-12: Displays 「离线，最后同步于 X」 when disconnected.
 * - AC 3 / E-04: Displays 「电脑上的调度服务未启动」 when daemon is unreachable, NOT "连接超时".
 * - AC 4 / E-14: Displays upgrade prompt on version mismatch without throwing bottom-layer errors.
 * - 11 节: No continuous animations except run-deck pulse; 4px grid throughout.
 */

import { type MouseEvent, useCallback } from 'react';

export type OfflineBannerKind =
	| 'rollback'
	| 'daemon-down'
	| 'version-incompatible'
	| 'offline'
	| 'reconnecting';

export interface OfflineBannerProps {
	/** Connection status: 'online' | 'reconnecting' | 'offline' (AC 2, E-12) */
	readonly status?: 'online' | 'reconnecting' | 'offline';
	/** Last synced ISO string, number, or Date (AC 2, E-12) */
	readonly lastSyncedAt?: string | number | Date | null;
	/** Whether the daemon process is running (AC 3, E-04) */
	readonly isDaemonRunning?: boolean;
	/** Specific error reason when daemon is offline */
	readonly daemonErrorReason?: string;
	/** Whether the daemon API version matches client (AC 4, E-14) */
	readonly isVersionCompatible?: boolean;
	/** Version information if incompatible (AC 4, E-14) */
	readonly versionInfo?: {
		readonly expected: string;
		readonly actual?: string;
	} | null;
	/** Rollback notice from failed optimistic stop (AC 1, E-157) */
	readonly rollbackNotice?: {
		readonly runId?: string;
		readonly message: string;
		readonly timestamp?: number;
	} | null;
	/** Dismiss rollback notice callback */
	readonly onDismissRollback?: () => void;
	/** Retry connection callback */
	readonly onRetry?: () => void;
	/** Optional class name */
	readonly className?: string;
}

export function OfflineBanner({
	status = 'online',
	lastSyncedAt,
	isDaemonRunning = true,
	daemonErrorReason,
	isVersionCompatible = true,
	versionInfo,
	rollbackNotice,
	onDismissRollback,
	onRetry,
	className = '',
}: OfflineBannerProps) {
	const handleRetryClick = useCallback(
		(e: MouseEvent<HTMLButtonElement>) => {
			e.stopPropagation();
			onRetry?.();
		},
		[onRetry],
	);

	const handleDismissClick = useCallback(
		(e: MouseEvent<HTMLButtonElement>) => {
			e.stopPropagation();
			onDismissRollback?.();
		},
		[onDismissRollback],
	);

	// Priority 1: Optimistic stop failure rollback notice (AC 1, E-157)
	if (rollbackNotice) {
		return (
			<div
				role="alert"
				aria-live="assertive"
				data-component="offline-banner"
				data-banner-kind="rollback"
				data-testid="rollback-banner"
				className={`
					w-full min-h-[32px] px-4 py-2 flex items-center justify-between gap-3
					bg-down-soft text-down border-b border-down
					text-meta font-ui select-none
					${className}
				`}
			>
				<div className="flex items-center gap-2 min-w-0">
					{/* Flat alert square glyph (11 节: 矩形非药丸，状态字形来自几何形状，4px 栅格) */}
					<span
						aria-hidden="true"
						className="inline-block w-2 h-2 bg-current rounded-[1px] shrink-0"
					/>
					<span className="truncate font-medium">
						{rollbackNotice.message || '中止任务失败，已恢复原状态'}
					</span>
				</div>

				<div className="flex items-center gap-2 shrink-0">
					{onRetry && (
						<button
							type="button"
							onClick={handleRetryClick}
							className="
								px-2 py-1 rounded-sm text-meta font-medium
								bg-panel-2 text-ink-1 border border-border
								hover:brightness-105 active:brightness-95 cursor-pointer
							"
						>
							重试
						</button>
					)}
					{onDismissRollback && (
						<button
							type="button"
							onClick={handleDismissClick}
							aria-label="关闭横幅"
							className="
								px-2 py-1 rounded-sm text-meta font-medium text-down
								hover:bg-panel-2 active:brightness-90 cursor-pointer
							"
						>
							✕
						</button>
					)}
				</div>
			</div>
		);
	}

	// Priority 2: Daemon not running (AC 3, E-04)
	if (isDaemonRunning === false || daemonErrorReason === 'daemon_down') {
		return (
			<div
				aria-live="polite"
				data-component="offline-banner"
				data-banner-kind="daemon-down"
				data-testid="daemon-down-banner"
				className={`
					w-full min-h-[32px] px-4 py-2 flex items-center justify-between gap-3
					bg-down-soft text-down border-b border-down
					text-meta font-ui select-none
					${className}
				`}
			>
				<div className="flex items-center gap-2 min-w-0">
					<span
						aria-hidden="true"
						className="inline-block w-2 h-2 bg-current rounded-[1px] shrink-0"
					/>
					<span className="truncate font-medium">电脑上的调度服务未启动</span>
					<span className="hidden sm:inline text-ink-2 text-meta">
						（请在电脑上启动调度服务后重试）
					</span>
				</div>

				{onRetry && (
					<button
						type="button"
						onClick={handleRetryClick}
						className="
							px-2 py-1 rounded-sm text-meta font-medium
							bg-panel-2 text-ink-1 border border-border
							hover:brightness-105 active:brightness-95 cursor-pointer shrink-0
						"
					>
						重试连接
					</button>
				)}
			</div>
		);
	}

	// Priority 3: Version incompatible (AC 4, E-14)
	if (isVersionCompatible === false) {
		const expectedVer = versionInfo?.expected ?? '';
		const actualVer = versionInfo?.actual ?? '';
		return (
			<div
				aria-live="polite"
				data-component="offline-banner"
				data-banner-kind="version-incompatible"
				data-testid="version-incompatible-banner"
				className={`
					w-full min-h-[32px] px-4 py-2 flex items-center justify-between gap-3
					bg-needs-soft text-needs border-b border-needs
					text-meta font-ui select-none
					${className}
				`}
			>
				<div className="flex items-center gap-2 min-w-0">
					<span
						aria-hidden="true"
						className="inline-block w-2 h-2 bg-current rounded-[1px] shrink-0"
					/>
					<span className="truncate font-medium">版本不兼容，请升级客户端应用</span>
					{expectedVer && (
						<span className="hidden sm:inline font-mono text-meta text-ink-2">
							[要求 {expectedVer}
							{actualVer ? ` / 服务端 ${actualVer}` : ''}]
						</span>
					)}
				</div>

				{onRetry && (
					<button
						type="button"
						onClick={handleRetryClick}
						className="
							px-2 py-1 rounded-sm text-meta font-medium
							bg-panel-2 text-ink-1 border border-border
							hover:brightness-105 active:brightness-95 cursor-pointer shrink-0
						"
					>
						重新校验
					</button>
				)}
			</div>
		);
	}

	// Priority 4: Disconnected / Offline (AC 2, E-12)
	if (status === 'offline') {
		const timeDisplay = formatBannerLastSynced(lastSyncedAt);
		return (
			<div
				aria-live="polite"
				data-component="offline-banner"
				data-banner-kind="offline"
				data-testid="offline-banner"
				className={`
					w-full min-h-[32px] px-4 py-2 flex items-center justify-between gap-3
					bg-panel-2 text-ink-2 border-b border-border-strong
					text-meta font-ui select-none
					${className}
				`}
			>
				<div className="flex items-center gap-2 min-w-0">
					<span
						aria-hidden="true"
						className="inline-block w-2 h-2 rounded-[1px] bg-stopped shrink-0"
					/>
					<span className="truncate">
						离线，最后同步于 <span className="font-mono text-ink-1">{timeDisplay}</span>
					</span>
				</div>

				{onRetry && (
					<button
						type="button"
						onClick={handleRetryClick}
						className="
							px-2 py-1 rounded-sm text-meta font-medium
							bg-panel-2 text-ink-1 border border-border
							hover:brightness-105 active:brightness-95 cursor-pointer shrink-0
						"
					>
						重试连接
					</button>
				)}
			</div>
		);
	}

	// Priority 5: Reconnecting (AC 2, E-12; 11 节: 去掉 animate-pulse，全页唯一连续动画是运行轨呼吸环)
	if (status === 'reconnecting') {
		return (
			<div
				aria-live="polite"
				data-component="offline-banner"
				data-banner-kind="reconnecting"
				data-testid="reconnecting-banner"
				className={`
					w-full min-h-[32px] px-4 py-2 flex items-center justify-between gap-3
					bg-panel-2 text-needs border-b border-border-strong
					text-meta font-ui select-none
					${className}
				`}
			>
				<div className="flex items-center gap-2 min-w-0">
					<span
						aria-hidden="true"
						className="inline-block w-2 h-2 rounded-[1px] bg-needs shrink-0"
					/>
					<span className="truncate">正在重新连接调度服务...</span>
				</div>
			</div>
		);
	}

	// Normal online state: banner is hidden
	return null;
}

/**
 * Format ISO timestamp, Date, or string into readable time string (AC 2, E-12).
 * Private pure function placed at bottom of presentation component (07-前端架构).
 */
export function formatBannerLastSynced(
	timestamp: string | number | Date | null | undefined,
): string {
	if (!timestamp) {
		return '—';
	}
	if (typeof timestamp === 'string') {
		const trimmed = timestamp.trim();
		if (/^\d{2}:\d{2}(:\d{2})?$/.test(trimmed) || trimmed === '—') {
			return trimmed;
		}
	}
	try {
		const d =
			typeof timestamp === 'string' || typeof timestamp === 'number'
				? new Date(timestamp)
				: timestamp;
		if (Number.isNaN(d.getTime())) {
			return typeof timestamp === 'string' ? timestamp : '—';
		}
		const hours = String(d.getHours()).padStart(2, '0');
		const minutes = String(d.getMinutes()).padStart(2, '0');
		const seconds = String(d.getSeconds()).padStart(2, '0');
		return `${hours}:${minutes}:${seconds}`;
	} catch {
		return '—';
	}
}

/** Alias for backward compatibility in tests and callers */
export const formatLastSyncedAt = formatBannerLastSynced;
