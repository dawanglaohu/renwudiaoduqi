import type { ReactNode } from 'react';
import type { FieldLayerValues } from '../features/settings-agents/types.ts';

export interface FieldLayersRowProps {
	readonly layers: FieldLayerValues;
	readonly fieldLabel: string;
	readonly children?: ReactNode;
}

/**
 * 字段三行呈现组件（AC 1 & E-92 呈现侧）
 * 规范约束（R1, R2）：
 * - 展示「内置默认 / 你的覆盖 / 当前生效」三行；
 * - 纯读 daemon 字段，未提供层显示「—」；
 * - 「恢复默认」在 clearOverrides 落地前不渲染写入口，绝不把前端算出的默认值当 PATCH body；
 * - defaultModel 的内置默认非字符串，不渲染恢复默认入口；
 * - 内置默认升级只呈现 daemon 提供的差异（E-92）。
 */
export function FieldLayersRow({ layers, fieldLabel, children }: FieldLayersRowProps) {
	const hasOverride =
		layers.override !== null && layers.override !== undefined && layers.override !== '—';

	return (
		<div className="flex flex-col gap-2 rounded-sm border border-border bg-panel-2 p-3 text-body">
			{/* 字段名与顶部信息栏 */}
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<span className="font-ui font-semibold text-ink-1 text-dense">{fieldLabel}</span>
					{/* E-92 内置默认更新提示（仅呈现 daemon 提供的升级差异） */}
					{layers.updateNotice && (
						<div
							data-testid={`default-updated-notice-${layers.key}`}
							className="inline-flex items-center gap-2 rounded-sm border border-needs bg-needs-soft px-2 py-0.5 text-micro text-needs"
						>
							<span>
								内置默认已更新（{layers.updateNotice.oldValue} → {layers.updateNotice.newValue}）
							</span>
						</div>
					)}
				</div>
			</div>

			{/* 三行表（内置默认 / 你的覆盖 / 当前生效） */}
			<div className="grid grid-cols-1 gap-1 text-meta sm:grid-cols-3">
				<div className="flex flex-col rounded bg-bg px-2 py-1">
					<span className="text-micro text-ink-3">内置默认</span>
					<span
						className="font-mono text-dense text-ink-2 truncate"
						title={layers.builtIn}
						data-testid={`layer-builtin-${layers.key}`}
					>
						{layers.builtIn}
					</span>
				</div>
				<div className="flex flex-col rounded bg-bg px-2 py-1">
					<span className="text-micro text-ink-3">你的覆盖</span>
					<span
						className={`font-mono text-dense truncate ${
							hasOverride ? 'text-needs font-medium' : 'text-ink-3'
						}`}
						title={layers.override ?? '—'}
						data-testid={`layer-override-${layers.key}`}
					>
						{layers.override ?? '—'}
					</span>
				</div>
				<div className="flex flex-col rounded bg-bg px-2 py-1">
					<span className="text-micro text-ink-3">当前生效</span>
					<span
						className="font-mono text-dense text-ink-1 font-medium truncate"
						title={layers.effective}
						data-testid={`layer-effective-${layers.key}`}
					>
						{layers.effective}
					</span>
				</div>
			</div>

			{/* 内嵌编辑控件 */}
			{children && <div className="mt-1">{children}</div>}
		</div>
	);
}
