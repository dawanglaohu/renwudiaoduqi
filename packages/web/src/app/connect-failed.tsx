/**
 * packages/web/src/app/connect-failed.tsx
 *
 * 首屏快照拉不到时的单屏（07 节错误体系「整页失败只有两种」里的第二种，M10-T6）。
 *
 * 规范依据：
 * - 文案按 E-04 写「电脑上的调度服务未启动」，而不是「连接超时」：用户要的是能修的动作，
 *   不是一句网络术语
 * - 错误文案唯一来源是 `src/i18n/error-messages.ts`，组件内不写错误字符串
 * - 「启动调度服务」是 `shellBridge.launchService()` 的唯一调用点（07 节壳边界 / 决策 135），
 *   按 `capabilities.canLaunchService` 隐藏；浏览器与手机壳下不渲染
 * - 壳只 spawn 一次并返回 pid，**重试快照仍由 Web UI 自己做**（E-146：壳内不嵌重试与调度策略）
 */

import type { LaunchServiceResult } from '@agent-scheduler/shared/shell/bridge-contract';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { setManualHost } from '../api/base-url.ts';
import {
	SERVICE_NOT_RUNNING_TITLE,
	getErrorMessage,
	getLaunchErrorMessage,
} from '../i18n/error-messages.ts';
import { shellBridge } from '../shell/shell-bridge.ts';
import {
	type FirstScreenFailure,
	getFirstScreenFailure,
	subscribeFirstScreenFailure,
} from './bootstrap.ts';

// 重新导出，保持向后兼容（E-04 要求的文案：说清「什么没启动」，而不是「连接超时」）。
export { SERVICE_NOT_RUNNING_TITLE };

export type LaunchServiceUiState = 'idle' | 'launching' | 'launched' | 'failed';

export interface ConnectFailedScreenProps {
	/** 首屏快照失败的错误码（一般是 `E_NETWORK` / `E_TIMEOUT`） */
	readonly code: string;
	/** daemon 回的原始 requestId，可直接复制去查日志 */
	readonly requestId?: string | null;
	/** 三级发现解析出来的 baseUrl，照实显示，不猜 */
	readonly baseUrl?: string | null;
	/** 重拉首屏快照。由取数方提供，壳不代劳 */
	readonly onRetry: () => void | Promise<void>;
	/** 注入点：默认走 `shellBridge.launchService()` */
	readonly launchService?: () => Promise<LaunchServiceResult>;
}

/**
 * 订阅首屏失败记录。取数方（首屏快照）调 `reportFirstScreenFailure()`，
 * 这一屏就在 `app.tsx` 的闸门处接管整页。
 */
export function useFirstScreenFailure(): FirstScreenFailure | null {
	return useSyncExternalStore(subscribeFirstScreenFailure, getFirstScreenFailure, () => null);
}

/**
 * 首屏失败单屏：显示 baseUrl 与 requestId，给三个动作（重试 / 改地址 / 启动调度服务）。
 */
export function ConnectFailedScreen({
	code,
	requestId = null,
	baseUrl = null,
	onRetry,
	launchService,
}: ConnectFailedScreenProps) {
	const canLaunchService = shellBridge.capabilities.canLaunchService;
	const launch = launchService ?? (() => shellBridge.launchService());
	const [launchState, setLaunchState] = useState<LaunchServiceUiState>('idle');
	const [launchError, setLaunchError] = useState<string | null>(null);
	const [launchedPid, setLaunchedPid] = useState<number | null>(null);
	const [hostDraft, setHostDraft] = useState('');
	const [isEditingHost, setIsEditingHost] = useState(false);
	const inFlightRef = useRef(false);

	const handleLaunch = useCallback(async () => {
		// 一次点击只许产生一次 `invoke`：壳内不重试，重复 spawn 会撞上 daemon 自己的单实例锁
		if (inFlightRef.current) {
			return;
		}
		inFlightRef.current = true;
		setLaunchState('launching');
		setLaunchError(null);
		try {
			const result = await launch();
			setLaunchedPid(result.pid);
			setLaunchState('launched');
			// The native spawn returns before the daemon starts listening. Keep snapshot retries in
			// the Web UI and stop as soon as the failure record is cleared by a successful fetch.
			await onRetry();
			for (let attempt = 1; attempt < 30 && getFirstScreenFailure(); attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				await onRetry();
			}
		} catch (error: unknown) {
			setLaunchState('failed');
			setLaunchError(getLaunchErrorMessage(error));
		} finally {
			inFlightRef.current = false;
		}
	}, [launch, onRetry]);

	const handleSubmitHost = useCallback(() => {
		const trimmed = hostDraft.trim();
		if (!trimmed) {
			return;
		}
		setManualHost(trimmed);
		setIsEditingHost(false);
		onRetry();
	}, [hostDraft, onRetry]);

	// 地址示例优先使用运行时 baseUrl（07 节运行时发现 / R2，不在源码硬编码 7817）
	const displayExampleHost = baseUrl && baseUrl.trim().length > 0 ? baseUrl : 'http://127.0.0.1';

	return (
		<div
			data-testid="connect-failed-screen"
			className="flex min-h-screen flex-col bg-page text-ink-1 font-ui"
		>
			<main className="flex flex-1 items-center justify-center p-6">
				<div className="w-full max-w-[520px] flex flex-col gap-4 rounded-[var(--r)] border border-border bg-bg p-6">
					<h1 className="m-0 text-lead font-semibold text-needs">{SERVICE_NOT_RUNNING_TITLE}</h1>
					<p className="m-0 text-body text-ink-2">{getErrorMessage(code)}</p>

					<dl className="m-0 flex flex-col gap-1 text-meta">
						<div className="flex gap-2">
							<dt className="text-ink-3">服务地址</dt>
							<dd className="m-0 font-mono text-ink-2 break-all">{baseUrl || '—'}</dd>
						</div>
						<div className="flex gap-2">
							<dt className="text-ink-3">requestId</dt>
							<dd className="m-0 font-mono text-ink-2 break-all">{requestId || '—'}</dd>
						</div>
					</dl>

					{requestId ? (
						<button
							type="button"
							data-testid="copy-request-id"
							onClick={() => {
								void navigator.clipboard?.writeText(requestId).catch(() => {
									// 剪贴板不可用时复制失败无妨，requestId 本身已在页面上可读
								});
							}}
							className="self-start text-meta text-ink-3 underline decoration-dotted hover:text-ink-2"
						>
							复制 requestId
						</button>
					) : null}

					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							data-testid="retry-snapshot"
							onClick={onRetry}
							className="h-btn px-4 rounded-sm bg-needs text-on-needs font-medium text-body inline-flex items-center justify-center hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
						>
							重试
						</button>
						<button
							type="button"
							data-testid="edit-host"
							aria-expanded={isEditingHost}
							onClick={() => setIsEditingHost((previous) => !previous)}
							className="h-btn px-4 rounded-sm border border-border text-ink-2 font-medium text-body inline-flex items-center justify-center hover:text-ink-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
						>
							改地址
						</button>
						{/* 只在壳真的能拉起服务时渲染：隐藏的能力位不该给出点了没用的按钮（E-200） */}
						{canLaunchService ? (
							<button
								type="button"
								data-testid="launch-service"
								data-launch-state={launchState}
								// One spawn per screen: once the shell reported a pid the action is
								// spent, and re-running it would only hit the daemon's instance lock.
								disabled={launchState === 'launching' || launchState === 'launched'}
								onClick={() => {
									void handleLaunch();
								}}
								className="h-btn px-4 rounded-sm bg-needs text-on-needs font-medium text-body inline-flex items-center justify-center hover:brightness-105 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
							>
								{launchState === 'launching' ? '正在启动…' : '启动调度服务'}
							</button>
						) : null}
					</div>

					{isEditingHost ? (
						<div className="flex flex-col gap-2">
							<label className="text-meta text-ink-3" htmlFor="connect-failed-host">
								调度服务地址（例如 {displayExampleHost}）
							</label>
							<div className="flex gap-2">
								<input
									id="connect-failed-host"
									data-testid="host-input"
									value={hostDraft}
									onChange={(event) => setHostDraft(event.target.value)}
									placeholder={displayExampleHost}
									className="h-input flex-1 rounded-sm border border-border bg-panel-2 px-3 font-mono text-body text-ink-1 placeholder:text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
								/>
								<button
									type="button"
									data-testid="submit-host"
									onClick={handleSubmitHost}
									className="h-btn px-4 rounded-sm border border-border text-ink-1 font-medium text-body hover:text-ink-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
								>
									使用这个地址
								</button>
							</div>
						</div>
					) : null}

					{/* 启动失败就地 inline notice，不弹 toast、不升级成整页（07 节业务错） */}
					{launchState === 'failed' && launchError ? (
						<p
							data-testid="launch-error"
							role="alert"
							className="m-0 rounded-sm bg-down-soft px-3 py-2 text-meta text-ink-1"
						>
							{launchError}
						</p>
					) : null}
					{launchState === 'launched' && launchedPid !== null ? (
						<p data-testid="launch-pid" className="m-0 font-mono text-meta text-ink-3">
							已启动进程 pid {launchedPid}，正在重新加载首屏
						</p>
					) : null}
				</div>
			</main>
		</div>
	);
}

export default ConnectFailedScreen;
