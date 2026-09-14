import type { DeviceDto } from '../../../../shared/src/api/devices.ts';

export interface DeviceRevokeDialogProps {
	readonly device: DeviceDto | null;
	readonly isRevoking: boolean;
	readonly onConfirm: () => void;
	readonly onCancel: () => void;
}

/**
 * Confirmation dialog for revoking device authorization (M9-T15 / AC 2 / E-127).
 * Whitelisted dialog usage (07-前端架构 / AC 4: 吊销设备).
 */
export function DeviceRevokeDialog({
	device,
	isRevoking,
	onConfirm,
	onCancel,
}: DeviceRevokeDialogProps) {
	if (!device) {
		return null;
	}

	return (
		<dialog
			open
			data-testid="device-revoke-dialog"
			aria-labelledby="revoke-dialog-title"
			className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-page border-0 m-0 w-full h-full max-w-none max-h-none"
		>
			<div className="w-full max-w-md rounded bg-bg border border-border-strong p-6 shadow-lg flex flex-col gap-4">
				<div className="flex flex-col gap-1">
					<h2 id="revoke-dialog-title" className="text-lead font-semibold text-ink-1">
						吊销设备授权
					</h2>
					<p className="text-meta text-ink-3 font-mono break-all">ID: {device.id}</p>
				</div>

				<div className="text-body text-ink-2 leading-relaxed">
					确定要吊销设备
					<strong className="text-ink-1 mx-1">「{device.name}」</strong>
					的访问授权吗？
					<span className="block mt-2 text-down font-medium">
						吊销后该设备的活动连接将立即断开 (E-127)，若需再次访问必须重新完成配对。
					</span>
				</div>

				<div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
					<button
						type="button"
						data-testid="revoke-cancel-button"
						onClick={onCancel}
						disabled={isRevoking}
						className="h-btn px-4 rounded-sm bg-panel-2 border border-border text-ink-1 text-body hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-needs-soft disabled:opacity-50"
					>
						取消
					</button>
					<button
						type="button"
						data-testid="revoke-confirm-button"
						onClick={onConfirm}
						disabled={isRevoking}
						className="h-btn px-4 rounded-sm bg-down text-on-down font-medium text-body hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-down-soft disabled:opacity-50"
					>
						{isRevoking ? '正在吊销...' : '确认吊销'}
					</button>
				</div>
			</div>
		</dialog>
	);
}
