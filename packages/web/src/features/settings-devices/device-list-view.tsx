import type { DeviceDto } from '../../../../shared/src/api/devices.ts';
import { BrowserModeBanner } from './browser-mode-banner.tsx';
import { DeviceRevokeDialog } from './device-revoke-dialog.tsx';
import { type UseSettingsDevicesResult, formatIsoDateTime } from './use-settings-devices.ts';

export interface DeviceListViewProps {
	readonly devicesState: UseSettingsDevicesResult;
}

export function DeviceListView({ devicesState }: DeviceListViewProps) {
	const {
		devices,
		isLoading,
		error,
		clearError,
		refreshDevices,
		newPairingCode,
		codeCountdownSec,
		isGeneratingCode,
		generatePairingCode,
		dismissPairingCode,
		revokingDevice,
		isRevoking,
		openRevokeDialog,
		closeRevokeDialog,
		confirmRevoke,
		currentBaseUrl,
		manualHost,
		setManualHostInput,
		saveManualHostAddress,
		resetManualHostAddress,
		isBrowser,
		currentDeviceId,
	} = devicesState;

	return (
		<div className="flex flex-col gap-6 w-full">
			{/* E-229: 浏览器模式常驻通知 */}
			<BrowserModeBanner />

			{/* 错误提示 */}
			{error && (
				<div
					data-testid="devices-error-notice"
					role="alert"
					className="p-3 rounded-sm bg-down-soft border border-down text-down flex items-center justify-between text-body"
				>
					<span>{error}</span>
					<button
						type="button"
						onClick={clearError}
						className="text-meta underline hover:brightness-110 focus-visible:outline-none"
					>
						关闭
					</button>
				</div>
			)}

			{/* 顶栏操作区：标题 + 生成配对码 (E-125) */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-border">
				<div>
					<h1 className="text-lead font-semibold text-ink-1">设备与配对管理</h1>
					<p className="text-meta text-ink-2 mt-1">
						管理所有已授权访问调度服务的终端设备与会话令牌。
					</p>
				</div>
				<div className="flex items-center gap-3">
					<button
						type="button"
						data-testid="refresh-devices-button"
						onClick={() => void refreshDevices()}
						disabled={isLoading}
						className="h-btn px-3 rounded-sm bg-panel-2 border border-border text-ink-1 text-meta hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft disabled:opacity-50"
					>
						刷新列表
					</button>
					<button
						type="button"
						data-testid="generate-code-button"
						onClick={() => void generatePairingCode()}
						disabled={isGeneratingCode}
						className="h-btn px-4 rounded-sm bg-needs text-on-needs font-medium text-meta hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft disabled:opacity-50"
					>
						{isGeneratingCode ? '正在生成...' : '生成新配对码 (E-125)'}
					</button>
				</div>
			</div>

			{/* 临时配对码卡片 (AC 4 / E-125) */}
			{newPairingCode && (
				<div
					data-testid="new-pairing-code-card"
					className="p-5 rounded-DEFAULT bg-panel-2 border border-needs text-ink-1 flex flex-col gap-3"
				>
					<div className="flex items-center justify-between">
						<span className="text-meta font-medium text-needs">新设备配对码（一次性）</span>
						<span className="text-micro font-mono text-ink-3">
							有效时间还剩：
							<strong className="text-needs text-body ml-1">{codeCountdownSec}</strong> 秒
						</span>
					</div>

					<div className="flex items-center gap-4">
						<div
							data-testid="display-pairing-code"
							className="font-mono text-num-lg font-bold text-needs tracking-widest px-4 py-2 rounded-sm bg-bg border border-border inline-block select-all"
						>
							{newPairingCode.code}
						</div>
						<p className="text-meta text-ink-2 leading-relaxed max-w-md">
							在新设备的浏览器或客户端打开配对页面，输入此配对码即可授权接入。
							配对码单次使用后立即作废，60 秒后自动超时。
						</p>
					</div>

					<div className="flex justify-end pt-2">
						<button
							type="button"
							onClick={dismissPairingCode}
							className="text-meta text-ink-3 hover:text-ink-1 underline"
						>
							关闭配对码
						</button>
					</div>
				</div>
			)}

			{/* 已授权设备列表 (AC 2 / E-127 / E-228) */}
			<div className="bg-bg border border-border rounded-DEFAULT overflow-hidden">
				<div className="px-4 py-3 bg-panel-2 border-b border-border flex items-center justify-between">
					<span className="text-meta font-semibold text-ink-1">已配对设备列表</span>
					<span className="text-micro font-mono text-ink-3">共 {devices.length} 台设备</span>
				</div>

				{isLoading && devices.length === 0 ? (
					<div className="p-8 text-center text-meta text-ink-3">正在加载设备列表...</div>
				) : devices.length === 0 ? (
					<div className="p-8 text-center text-meta text-ink-3">
						暂无已配对设备。请点击上方「生成新配对码」以授权新设备。
					</div>
				) : (
					<div className="divide-y divide-border">
						{devices.map((device: DeviceDto) => {
							const isRevoked = Boolean(device.revokedAt);
							const isCurrent = currentDeviceId !== null && device.id === currentDeviceId;
							const isBrowserTab = device.name.includes('浏览器 ·');

							return (
								<div
									key={device.id}
									data-testid={`device-row-${device.id}`}
									className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-panel-2/50 transition-colors"
								>
									<div className="flex flex-col gap-1 min-w-0">
										<div className="flex items-center gap-2 flex-wrap">
											<span className="font-medium text-body text-ink-1 break-words">
												{device.name}
											</span>
											{isCurrent && (
												<span
													data-testid="current-device-badge"
													className="text-micro px-1.5 py-0.5 rounded-sm bg-auto-soft text-auto border border-auto font-mono"
												>
													当前设备
												</span>
											)}
											{isBrowserTab && (
												<span className="text-micro px-1.5 py-0.5 rounded-sm bg-panel-2 text-ink-3 border border-border font-mono">
													浏览器标签
												</span>
											)}
											{isRevoked ? (
												<span
													data-testid={`device-revoked-badge-${device.id}`}
													className="text-micro px-1.5 py-0.5 rounded-sm bg-down-soft text-down border border-down"
												>
													已吊销
												</span>
											) : (
												<span className="text-micro px-1.5 py-0.5 rounded-sm bg-auto-soft text-auto">
													正常
												</span>
											)}
										</div>
										<div className="flex items-center gap-4 text-micro text-ink-3 font-mono flex-wrap">
											<span>ID: {device.id}</span>
											<span>配对: {formatIsoDateTime(device.pairedAt)}</span>
											<span>活跃: {formatIsoDateTime(device.lastSeenAt)}</span>
											{isRevoked && (
												<span className="text-down">
													吊销于: {formatIsoDateTime(device.revokedAt)}
												</span>
											)}
										</div>
									</div>

									{/* 吊销操作 (AC 2 / E-127) */}
									<div className="flex items-center gap-2 shrink-0">
										{!isRevoked ? (
											<button
												type="button"
												data-testid={`revoke-device-button-${device.id}`}
												onClick={() => openRevokeDialog(device)}
												className="h-btn px-3 rounded-sm bg-down-soft text-down border border-down text-meta font-medium hover:bg-down hover:text-on-down transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-down-soft"
											>
												吊销
											</button>
										) : (
											<span className="text-micro text-ink-3">已失效</span>
										)}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>

			{/* PC 局域网 IP 变化与手填地址说明 (AC 3 / E-09 / E-06) */}
			<div className="p-5 rounded-DEFAULT bg-bg border border-border flex flex-col gap-4">
				<div className="flex flex-col gap-1">
					<h2 className="text-body font-semibold text-ink-1">
						调度服务网络与局域网 IP 设置 (E-09)
					</h2>
					<p className="text-meta text-ink-2 leading-relaxed">
						客户端保存的是独立发放的设备令牌而非 IP 地址。PC 局域网 IP 发生变动（例如路由器 DHCP
						租约更新或切换网络）时，已授权设备
						<strong className="text-ink-1 mx-1">不需要重新配对</strong>
						，只需更新连接地址即可重连。
					</p>
				</div>

				<div className="grid gap-3 sm:grid-cols-2 text-meta">
					<div className="p-3 rounded-sm bg-panel-2 border border-border flex flex-col gap-1">
						<span className="text-micro text-ink-3">当前生效的调度服务地址</span>
						<span className="font-mono text-ink-1 break-all">
							{currentBaseUrl || '正在解析...'}
						</span>
					</div>
					<div className="p-3 rounded-sm bg-panel-2 border border-border flex flex-col gap-1">
						<span className="text-micro text-ink-3">运行环境平台</span>
						<span className="text-ink-1 font-medium">
							{isBrowser ? '浏览器独立模式 (无壳)' : '原生壳应用环境 (Tauri / Capacitor)'}
						</span>
					</div>
				</div>

				<div className="flex flex-col gap-2 pt-2 border-t border-border">
					<span className="text-meta font-medium text-ink-1">手填调度服务地址 (host:port)</span>
					<div className="flex gap-2">
						<input
							type="text"
							data-testid="settings-manual-host-input"
							value={manualHost}
							onChange={(e) => setManualHostInput(e.target.value)}
							placeholder="例如 192.168.1.100:7817"
							className="flex-1 h-btn px-3 rounded-sm bg-panel-2 border border-border text-ink-1 font-mono text-meta placeholder:text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
						/>
						<button
							type="button"
							data-testid="settings-save-host-button"
							onClick={() => void saveManualHostAddress(manualHost)}
							className="h-btn px-3 rounded-sm bg-panel-2 border border-border text-ink-1 text-meta hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
						>
							保存地址
						</button>
						<button
							type="button"
							data-testid="settings-reset-host-button"
							onClick={() => void resetManualHostAddress()}
							className="h-btn px-3 rounded-sm bg-panel-2 border border-border text-ink-3 text-meta hover:text-ink-1 hover:brightness-105 focus-visible:outline-none"
						>
							恢复自动
						</button>
					</div>
				</div>
			</div>

			{/* 吊销二次确认弹窗 (AC 2 / E-127) */}
			<DeviceRevokeDialog
				device={revokingDevice}
				isRevoking={isRevoking}
				onConfirm={() => void confirmRevoke()}
				onCancel={closeRevokeDialog}
			/>
		</div>
	);
}
