/**
 * packages/web/src/components/offline-banner.tsx
 *
 * M9-T11: Offline, daemon failure, version mismatch, and optimistic stop rollback banners
 * (07-前端架构 / AC 1-4, E-04, E-12, E-14, E-157).
 *
 * Architecture rules:
 * - Pure presentation component: props in / callback out (07-前端架构).
 * - Strictly prohibited from importing store, api, features, or shell.
 * - All colors must use tokens from tokens.css (var(--down), var(--needs), var(--panel-2), etc.).
 * - AC 1 / E-157: Presents rollback notice when optimistic stop fails.
 * - AC 2 / E-12: Displays 「离线，最后同步于 X」 when disconnected.
 * - AC 3 / E-04: Displays 「电脑上的调度服务未启动」 when daemon is unreachable, NOT "连接超时".
 * - AC 4 / E-14: Displays upgrade prompt on version mismatch without throwing bottom-layer errors.
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

/**
 * Format ISO timestamp, Date, or string into readable time string (AC 2, E-12).
 * Private pure function placed at bottom/near component (07-前端架构).
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

	// Determine active banner priority
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
					w-full min-h-[32px] px-4 py-1.5 flex items-center justify-between gap-3
					bg-[var(--down-soft)] text-[var(--down)] border-b border-[var(--down)]
					text-xs font-[var(--font-ui)] select-none
					${className}
				`}
			>
				<div className="flex items-center gap-2 min-w-0">
					{/* Flat alert square glyph (11 节: 矩形非药丸，状态字形来自几何形状) */}
					<span
						aria-hidden="true"
						className="inline-block w-2.5 h-2.5 bg-current rounded-[1px] flex-shrink-0"
					/>
					<span className="truncate font-medium">
						{rollbackNotice.message || '中止任务失败，已恢复原状态'}
					</span>
				</div>

				<div className="flex items-center gap-2 flex-shrink-0">
					{onRetry && (
						<button
							type="button"
							onClick={handleRetryClick}
							className="
								px-2 py-0.5 rounded-[var(--r-sm)] text-xs font-medium
								bg-[var(--panel-2)] text-[var(--ink-1)] border border-[var(--border)]
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
								px-1.5 py-0.5 rounded-[var(--r-sm)] text-xs font-medium text-[var(--down)]
								hover:bg-[var(--panel-2)] active:brightness-90 cursor-pointer
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
					w-full min-h-[32px] px-4 py-1.5 flex items-center justify-between gap-3
					bg-[var(--down-soft)] text-[var(--down)] border-b border-[var(--down)]
					text-xs font-[var(--font-ui)] select-none
					${className}
				`}
			>
				<div className="flex items-center gap-2 min-w-0">
					<span
						aria-hidden="true"
						className="inline-block w-2.5 h-2.5 bg-current rounded-[1px] flex-shrink-0"
					/>
					<span className="truncate font-medium">电脑上的调度服务未启动</span>
					<span className="hidden sm:inline text-[var(--ink-2)] text-[11px]">
						（请在电脑上启动调度服务后重试）
					</span>
				</div>

				{onRetry && (
					<button
						type="button"
						onClick={handleRetryClick}
						className="
							px-2.5 py-0.5 rounded-[var(--r-sm)] text-xs font-medium
							bg-[var(--panel-2)] text-[var(--ink-1)] border border-[var(--border)]
							hover:brightness-105 active:brightness-95 cursor-pointer flex-shrink-0
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
					w-full min-h-[32px] px-4 py-1.5 flex items-center justify-between gap-3
					bg-[var(--needs-soft)] text-[var(--needs)] border-b border-[var(--needs)]
					text-xs font-[var(--font-ui)] select-none
					${className}
				`}
			>
				<div className="flex items-center gap-2 min-w-0">
					<span
						aria-hidden="true"
						className="inline-block w-2.5 h-2.5 bg-current rounded-[1px] flex-shrink-0"
					/>
					<span className="truncate font-medium">版本不兼容，请升级客户端应用</span>
					{expectedVer && (
						<span className="hidden sm:inline font-[var(--font-mono)] text-[11px] text-[var(--ink-2)]">
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
							px-2.5 py-0.5 rounded-[var(--r-sm)] text-xs font-medium
							bg-[var(--panel-2)] text-[var(--ink-1)] border border-[var(--border)]
							hover:brightness-105 active:brightness-95 cursor-pointer flex-shrink-0
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
					w-full min-h-[32px] px-4 py-1.5 flex items-center justify-between gap-3
					bg-[var(--panel-2)] text-[var(--ink-2)] border-b border-[var(--border-strong)]
					text-xs font-[var(--font-ui)] select-none
					${className}
				`}
			>
				<div className="flex items-center gap-2 min-w-0">
					<span
						aria-hidden="true"
						className="inline-block w-2 h-2 rounded-[1px] bg-[var(--stopped)] flex-shrink-0"
					/>
					<span className="truncate">
						离线，最后同步于{' '}
						<span className="font-[var(--font-mono)] text-[var(--ink-1)]">{timeDisplay}</span>
					</span>
				</div>

				{onRetry && (
					<button
						type="button"
						onClick={handleRetryClick}
						className="
							px-2 py-0.5 rounded-[var(--r-sm)] text-xs font-medium
							bg-[var(--panel-2)] text-[var(--ink-1)] border border-[var(--border)]
							hover:brightness-105 active:brightness-95 cursor-pointer flex-shrink-0
						"
					>
						重试连接
					</button>
				)}
			</div>
		);
	}

	// Priority 5: Reconnecting
	if (status === 'reconnecting') {
		return (
			<div
				aria-live="polite"
				data-component="offline-banner"
				data-banner-kind="reconnecting"
				data-testid="reconnecting-banner"
				className={`
					w-full min-h-[32px] px-4 py-1.5 flex items-center justify-between gap-3
					bg-[var(--panel-2)] text-[var(--needs)] border-b border-[var(--border-strong)]
					text-xs font-[var(--font-ui)] select-none
					${className}
				`}
			>
				<div className="flex items-center gap-2 min-w-0">
					<span
						aria-hidden="true"
						className="inline-block w-2 h-2 rounded-[1px] bg-[var(--needs)] flex-shrink-0 animate-pulse"
					/>
					<span className="truncate">正在重新连接调度服务...</span>
				</div>
			</div>
		);
	}

	// Normal online state: banner is hidden
	return null;
}
