import type { FormEvent } from 'react';
import type { UsePairingResult } from './use-pairing.ts';

export interface PairingViewProps {
	readonly pairing: UsePairingResult;
}

export function PairingView({ pairing }: PairingViewProps) {
	const {
		pairingCode,
		setPairingCode,
		deviceName,
		setDeviceName,
		manualHost,
		setManualHostInput,
		showManualHost,
		setShowManualHost,
		isSubmitting,
		error,
		isBrowser,
		submitPairing,
		saveManualAddress,
	} = pairing;

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault();
		void submitPairing();
	};

	// 07 节错误体系：字段错（配对码/设备名称）才给输入框 aria-invalid + aria-describedby（E-06 的网络错是就地 notice）
	const isFieldError = error?.stage === 'validation' || error?.stage === 'code';

	const handleSaveHost = () => {
		if (manualHost.trim()) {
			saveManualAddress(manualHost);
		}
	};

	return (
		<div className="w-full bg-bg border border-border rounded p-6 shadow">
			{/* E-229: 浏览器模式能力缺失顶栏常驻提示 */}
			{isBrowser && (
				<div
					data-testid="browser-mode-alert"
					className="mb-6 p-4 rounded-sm bg-needs-soft border border-needs text-needs text-body"
				>
					<div className="font-semibold text-lead mb-1">浏览器运行模式</div>
					<div className="text-body leading-relaxed">
						当前处于浏览器模式：
						<span className="font-semibold underline">关闭标签后需重新配对</span>
						，且
						<span className="font-semibold underline">本模式下没有系统通知</span>
						。如需持久授权与系统级通知，请使用桌面端或移动端壳应用。
					</div>
				</div>
			)}

			<header className="mb-6">
				<h1 className="text-lead font-semibold text-ink-1 mb-1">设备配对</h1>
				<p className="text-meta text-ink-2">
					请输入调度服务生成的一次性配对码（有效期 ≤ 60 秒），将本设备接入调度器。
				</p>
			</header>

			{/* E-06: 配对失败报到具体环节并给出具体 host:port */}
			{error && (
				<div
					id="pairing-error-notice"
					data-testid="pairing-error-notice"
					role="alert"
					className="mb-6 p-4 rounded-sm border text-body bg-down-soft border-down text-down"
				>
					<div className="font-semibold mb-1">
						{error.stage === 'network'
							? `配对失败：${error.message}`
							: error.stage === 'code'
								? '配对码错误'
								: '配对失败'}
					</div>
					<div className="text-meta">
						{error.stage === 'network' ? (
							<>
								手机与电脑可能未在同一局域网网段，或 WiFi 路由器开启了 AP 隔离。
								请确认电脑端服务正在运行，或在下方手填电脑局域网 IP 与端口进行重试。
							</>
						) : (
							error.message
						)}
					</div>
				</div>
			)}

			<form onSubmit={handleSubmit} className="flex flex-col gap-5">
				{/* 配对码输入 */}
				<div className="flex flex-col gap-1.5">
					<label htmlFor="pairing-code" className="text-meta font-medium text-ink-1">
						配对码 <span className="text-needs">*</span>
					</label>
					<input
						id="pairing-code"
						data-testid="pairing-code-input"
						type="text"
						autoComplete="off"
						spellCheck={false}
						aria-invalid={isFieldError}
						aria-describedby={isFieldError ? 'pairing-error-notice' : undefined}
						value={pairingCode}
						onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
						placeholder="例如：6 位字母数字码"
						className="h-input px-3 rounded-sm bg-panel-2 border border-border text-ink-1 font-mono text-body tracking-wider placeholder:text-ink-3 placeholder:font-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
					/>
					<span className="text-micro text-ink-3">
						配对码在桌面端生成，一次性有效且有效期不超过 60 秒。
					</span>
				</div>

				{/* 设备名称输入 (E-228) */}
				<div className="flex flex-col gap-1.5">
					<label htmlFor="device-name" className="text-meta font-medium text-ink-1">
						设备名称 <span className="text-needs">*</span>
					</label>
					<input
						id="device-name"
						data-testid="device-name-input"
						type="text"
						autoComplete="off"
						aria-invalid={isFieldError}
						aria-describedby={isFieldError ? 'pairing-error-notice' : undefined}
						value={deviceName}
						onChange={(e) => setDeviceName(e.target.value)}
						placeholder="设备识别名称"
						className="h-input px-3 rounded-sm bg-panel-2 border border-border text-ink-1 text-body placeholder:text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
					/>
					<span className="text-micro text-ink-3">
						{isBrowser
							? '在浏览器模式下默认带当前时间，以便在设备管理列表中识别与单独吊销 (E-228)。'
							: '用于在桌面端设备列表中辨认该设备授权。'}
					</span>
				</div>

				{/* 手填地址兜底 (E-06 / E-09) */}
				<div className="pt-2 border-t border-border flex flex-col gap-2">
					<div className="flex items-center justify-between">
						<span className="text-meta text-ink-2">调度服务地址 (host:port)</span>
						<button
							type="button"
							onClick={() => setShowManualHost(!showManualHost)}
							className="text-meta text-needs hover:underline focus-visible:outline-none"
						>
							{showManualHost ? '收起手填地址' : '手填地址兜底 (E-06)'}
						</button>
					</div>

					{showManualHost && (
						<div
							data-testid="manual-host-section"
							className="flex flex-col gap-2 p-3 rounded-sm bg-panel-2 border border-border mt-1"
						>
							<div className="text-micro text-ink-2">
								若自动发现的地址连不上，可在此手填电脑的局域网 IP
								与端口（例如：192.168.1.100:7817）：
							</div>
							<div className="flex gap-2">
								<input
									type="text"
									data-testid="manual-host-input"
									value={manualHost}
									onChange={(e) => setManualHostInput(e.target.value)}
									placeholder="192.168.1.100:7817"
									className="flex-1 h-btn px-3 rounded-sm bg-bg border border-border text-ink-1 font-mono text-meta placeholder:text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
								/>
								<button
									type="button"
									data-testid="save-manual-host-button"
									onClick={handleSaveHost}
									className="h-btn px-3 rounded-sm bg-bg border border-border text-ink-1 text-meta hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
								>
									保存地址
								</button>
							</div>
						</div>
					)}
				</div>

				{/* 提交配对操作 */}
				<div className="pt-3">
					<button
						type="submit"
						data-testid="pairing-submit-button"
						disabled={isSubmitting}
						className="w-full h-btn-lg rounded-sm bg-needs text-on-needs font-medium text-body flex items-center justify-center transition-colors hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft"
					>
						{isSubmitting ? '正在连接配对...' : '确认并完成配对'}
					</button>
				</div>
			</form>

			<footer className="mt-8 pt-4 border-t border-border text-micro text-ink-3">
				首次配对提示：调度服务启动时若无任何已配对设备，会生成一枚启动配对码输出在电脑控制台与数据目录下的
				pairing-code.txt 中（权限 0600，用后即删）。
			</footer>
		</div>
	);
}
