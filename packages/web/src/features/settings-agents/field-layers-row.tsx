import type { ReactNode } from 'react';
import type { FieldLayerValues } from './types.ts';

export interface FieldLayersRowProps {
	readonly layers: FieldLayerValues;
	readonly fieldLabel: string;
	readonly onRestoreDefault: () => void;
	readonly onAdoptDefault?: () => void;
	readonly isRestoring?: boolean;
	readonly isAdopting?: boolean;
	readonly children?: ReactNode;
}

/**
 * 字段三行呈现组件（AC 1 & E-92 呈现侧）
 * 展示「内置默认 / 你的覆盖 / 当前生效」三行并带「恢复默认」按钮。
 * 当内置默认升级时提示「内置默认已更新（旧值 → 新值）」并提供「一键采纳」。
 */
export function FieldLayersRow({
	layers,
	fieldLabel,
	onRestoreDefault,
	onAdoptDefault,
	isRestoring = false,
	isAdopting = false,
	children,
}: FieldLayersRowProps) {
	const hasOverride = layers.override !== null && layers.override !== undefined;

	return (
		<div className="flex flex-col gap-2 rounded-sm border border-border bg-panel-2 p-3 text-body">
			{/* 字段名与顶部动作栏 */}
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<span className="font-ui font-semibold text-ink-1 text-dense">{fieldLabel}</span>
					{/* E-92 内置默认更新提示与一键采纳 */}
					{layers.updateNotice && (
						<div
							data-testid={`default-updated-notice-${layers.key}`}
							className="inline-flex items-center gap-2 rounded-sm border border-needs bg-needs-soft px-2 py-0.5 text-micro text-needs"
						>
							<span>
								内置默认已更新（{layers.updateNotice.oldValue} → {layers.updateNotice.newValue}）
							</span>
							{onAdoptDefault && (
								<button
									type="button"
									onClick={onAdoptDefault}
									disabled={isAdopting}
									className="rounded-sm bg-needs px-1.5 py-0.5 font-ui font-semibold text-on-needs hover:opacity-90 disabled:opacity-50"
								>
									{isAdopting ? '采纳中...' : '一键采纳'}
								</button>
							)}
						</div>
					)}
				</div>

				{/* 恢复默认按钮（AC 1: 无覆盖时置灰不隐藏，title="当前没有覆盖"） */}
				<button
					type="button"
					onClick={onRestoreDefault}
					disabled={!hasOverride || isRestoring}
					title={hasOverride ? '恢复为内置默认值' : '当前没有覆盖'}
					aria-disabled={!hasOverride || isRestoring}
					data-testid={`restore-default-btn-${layers.key}`}
					className={`inline-flex items-center rounded-sm px-2 py-1 font-ui text-micro font-medium transition-colors ${
						hasOverride
							? 'border border-border text-ink-2 hover:bg-bg hover:text-ink-1'
							: 'cursor-not-allowed border border-border opacity-40 text-ink-3'
					}`}
				>
					{isRestoring ? '恢复中...' : '恢复默认'}
				</button>
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

			{/* 可选的内嵌编辑控件 */}
			{children && <div className="mt-1">{children}</div>}
		</div>
	);
}
