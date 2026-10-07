import { useEffect, useState } from 'react';

export const DEFAULT_LANE_COUNT = 2;
export const MIN_LANE_COUNT = 1;
export const MAX_LANE_COUNT = 6;

export interface LaneCountSettingProps {
	readonly laneCount: number;
	readonly onChangeLaneCount?: (count: number) => void;
	readonly hasTargetDoc?: boolean;
	readonly targetDocName?: string | null;
	readonly targetDocId?: string | null;
	readonly documents?: readonly { readonly id: string; readonly projectName: string }[];
	readonly documentsError?: string | null;
	readonly onRetryDocuments?: () => void;
	readonly onChangeTargetDoc?: (docId: string) => void;
	readonly error?: string | null;
	readonly disabled?: boolean;
}

/**
 * 任务并行窗口数设置组件（AC 8 & E-248 呈现侧）
 * 规范约束（R5, R7）：
 * - 默认 2，值域 1–6；
 * - 设置项旁注明「此值只属于调度器，与阅读器互不影响」；
 * - 窗口数的目标文档由明确来源决定（快照/当前文档），不能取 documents[0]；定位不到不渲染写入口。
 */
export function LaneCountSetting({
	laneCount,
	onChangeLaneCount,
	hasTargetDoc = true,
	targetDocName,
	targetDocId,
	documents = [],
	documentsError,
	onRetryDocuments,
	onChangeTargetDoc,
	error,
	disabled = false,
}: LaneCountSettingProps) {
	const canWrite = hasTargetDoc && typeof onChangeLaneCount === 'function';
	const [draftCount, setDraftCount] = useState(String(laneCount));
	const [inputError, setInputError] = useState<string | null>(null);

	useEffect(() => {
		setDraftCount(String(laneCount));
		setInputError(null);
	}, [laneCount]);

	const saveDraftCount = () => {
		if (!canWrite || disabled) return;
		const count = Number(draftCount);
		if (!draftCount.trim()) {
			setDraftCount(String(laneCount));
			return;
		}
		if (!Number.isInteger(count) || count < MIN_LANE_COUNT || count > MAX_LANE_COUNT) {
			setInputError('请输入 1–6 之间的整数');
			setDraftCount(String(laneCount));
			return;
		}
		setInputError(null);
		setDraftCount(String(laneCount));
		if (count !== laneCount) onChangeLaneCount?.(count);
	};

	return (
		<div
			data-testid="lane-count-setting-card"
			className="flex flex-col gap-3 border-b border-border pb-3"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<h3 className="font-ui text-lead font-semibold text-ink-1">任务并行窗口数</h3>
						{targetDocName && (
							<span className="rounded bg-panel-2 px-1.5 py-0.5 text-micro text-ink-3">
								文档：{targetDocName}
							</span>
						)}
					</div>
					{/* AC 8 & E-248: 注明文案 */}
					<p data-testid="lane-count-notice" className="mt-0.5 text-meta text-ink-2">
						此值只属于调度器，与阅读器互不影响
					</p>
				</div>

				<div className="flex min-w-0 flex-wrap items-center gap-3">
					{onChangeTargetDoc && (
						<select
							aria-label="窗口设置所属文档"
							value={targetDocId ?? ''}
							onChange={(event) => onChangeTargetDoc(event.target.value)}
							disabled={disabled || documents.length === 0}
							className="h-input max-w-full rounded-sm border border-border bg-bg px-2.5 font-ui text-dense text-ink-1 focus:border-needs focus:outline-none disabled:opacity-50"
						>
							<option value="" disabled>
								{documentsError && documents.length === 0
									? '文档列表读取失败'
									: documents.length === 0
										? '请先导入开发文档'
										: '请选择文档'}
							</option>
							{documents.map((doc) => (
								<option key={doc.id} value={doc.id}>
									{doc.projectName}
								</option>
							))}
						</select>
					)}
					{/* R5: 定位不到目标文档时不渲染写入口 */}
					{canWrite ? (
						<div className="flex items-center rounded-sm border border-border bg-panel-2">
							<button
								type="button"
								onClick={() => onChangeLaneCount(Math.max(MIN_LANE_COUNT, laneCount - 1))}
								disabled={disabled || laneCount <= MIN_LANE_COUNT}
								aria-label="减少窗口数"
								data-testid="lane-count-decrease-btn"
								className="flex h-btn w-btn items-center justify-center font-mono text-lead text-ink-2 hover:text-ink-1 disabled:opacity-30"
							>
								-
							</button>
							<input
								type="number"
								inputMode="numeric"
								min={MIN_LANE_COUNT}
								max={MAX_LANE_COUNT}
								step={1}
								value={draftCount}
								disabled={disabled}
								aria-label="任务并行窗口数"
								aria-invalid={Boolean(inputError || error)}
								onChange={(event) => {
									setDraftCount(event.target.value);
									setInputError(null);
								}}
								onFocus={(event) => event.currentTarget.select()}
								onBlur={saveDraftCount}
								onKeyDown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault();
										event.currentTarget.blur();
									}
								}}
								data-testid="lane-count-value"
								className="h-btn w-16 border-x border-border bg-bg px-1 text-center font-mono text-lead font-semibold text-ink-1 focus:outline-none focus:ring-1 focus:ring-needs disabled:opacity-50"
							/>
							<button
								type="button"
								onClick={() => onChangeLaneCount(Math.min(MAX_LANE_COUNT, laneCount + 1))}
								disabled={disabled || laneCount >= MAX_LANE_COUNT}
								aria-label="增加窗口数"
								data-testid="lane-count-increase-btn"
								className="flex h-btn w-btn items-center justify-center font-mono text-lead text-ink-2 hover:text-ink-1 disabled:opacity-30"
							>
								+
							</button>
						</div>
					) : (
						<div className="flex items-center gap-2">
							<span
								data-testid="lane-count-value"
								className="flex h-btn w-12 items-center justify-center rounded-sm border border-border bg-panel-2 font-mono text-lead font-semibold text-ink-1 select-none"
							>
								{laneCount}
							</span>
							<span data-testid="lane-count-readonly-notice" className="text-meta text-ink-3">
								未定位到目标文档，仅显示当前值
							</span>
						</div>
					)}

					<span className="text-dense text-ink-3">（范围 1–6，默认 2）</span>
				</div>
			</div>

			{canWrite && <p className="text-meta text-ink-3">输入后按 Enter 或移开焦点保存</p>}

			{documentsError && (
				<div
					data-testid="lane-count-documents-error"
					role="alert"
					className="flex flex-wrap items-center gap-2 text-micro text-down"
				>
					<span>{documentsError}</span>
					{onRetryDocuments && (
						<button
							type="button"
							onClick={onRetryDocuments}
							disabled={disabled}
							data-testid="lane-count-documents-retry"
							className="rounded-sm border border-border px-2 py-1 font-ui text-dense text-ink-1 hover:bg-panel-2 disabled:opacity-50"
						>
							重新加载文档
						</button>
					)}
				</div>
			)}

			{(inputError || error) && (
				<div data-testid="lane-count-error" className="text-micro text-down">
					{inputError || error}
				</div>
			)}
		</div>
	);
}
