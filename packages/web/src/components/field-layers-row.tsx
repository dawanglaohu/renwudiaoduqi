import type { ReactNode } from 'react';
import { UI_STRINGS } from '../i18n/ui-strings.ts';

// 这三个类型是展示层自己的 props 契约（07 节：components 不得反向 import features），
// features 的 hook/容器按需要从本文件引类型。
export type AgentFieldKey =
	| 'monogram'
	| 'execPath'
	| 'defaultModel'
	| 'maxConcurrency'
	| 'permissionTier';

export interface FieldLayerValues {
	readonly key: AgentFieldKey;
	readonly label: string;
	readonly builtIn: string;
	readonly override: string | null;
	readonly effective: string;
	readonly updateNotice?: {
		readonly oldValue: string;
		readonly newValue: string;
	} | null;
}

export interface FieldErrorInfo {
	readonly message: string;
	readonly technical?: string;
	readonly requestId?: string;
}

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
		<div className="settings-field">
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
								{UI_STRINGS.fieldLayers.defaultUpdatedPrefix}
								{layers.updateNotice.oldValue} → {layers.updateNotice.newValue}）
							</span>
						</div>
					)}
				</div>
			</div>

			{children && <div className="settings-field-editor">{children}</div>}

			{/* 三层配置来源 */}
			<div className="settings-field-layers">
				<div className="flex min-w-0 flex-col">
					<span className="text-micro text-ink-3">{UI_STRINGS.agentCard.builtinLabel}</span>
					<span
						className="font-mono text-dense text-ink-2"
						title={layers.builtIn}
						data-testid={`layer-builtin-${layers.key}`}
					>
						{layers.builtIn}
					</span>
				</div>
				<div className="flex min-w-0 flex-col">
					<span className="text-micro text-ink-3">{UI_STRINGS.agentCard.overrideLabel}</span>
					<span
						className={`font-mono text-dense ${
							hasOverride ? 'text-needs font-medium' : 'text-ink-3'
						}`}
						title={layers.override ?? '—'}
						data-testid={`layer-override-${layers.key}`}
					>
						{layers.override ?? '—'}
					</span>
				</div>
				<div className="flex min-w-0 flex-col">
					<span className="text-micro text-ink-3">{UI_STRINGS.agentCard.effectiveLabel}</span>
					<span
						className="font-mono text-dense text-ink-1 font-medium"
						title={layers.effective}
						data-testid={`layer-effective-${layers.key}`}
					>
						{layers.effective}
					</span>
				</div>
			</div>
		</div>
	);
}
