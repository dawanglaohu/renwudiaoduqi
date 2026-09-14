import { useState } from 'react';

export interface AddAgentSectionProps {
	readonly onAddAgent: (params: {
		readonly id: string;
		readonly name: string;
		readonly monogram: string;
		readonly execPath: string;
		readonly defaultModel?: string | null;
		readonly maxConcurrency?: number;
		readonly permissionTier?: 'readOnly' | 'workspaceWrite' | 'unrestricted';
	}) => Promise<boolean>;
	readonly existingAgentIds: readonly string[];
	readonly validateMonogram: (
		agentId: string,
		monogram: string,
	) => { readonly valid: boolean; readonly message?: string };
}

/**
 * 接入新 Agent 区块（AC 7 & E-185 呈现侧）
 * - 接入第 5/6 个 agent 只需填两字符短码，不新增任何资源文件；
 * - 字母组直接使用中性 ink 片在 CSS 中渲染，无外部图片/图标/资源依赖。
 */
export function AddAgentSection({
	onAddAgent,
	existingAgentIds,
	validateMonogram,
}: AddAgentSectionProps) {
	const [isOpen, setIsOpen] = useState<boolean>(false);
	const [id, setId] = useState<string>('');
	const [name, setName] = useState<string>('');
	const [monogram, setMonogram] = useState<string>('');
	const [execPath, setExecPath] = useState<string>('');
	const [defaultModel, setDefaultModel] = useState<string>('');
	const [maxConcurrency, setMaxConcurrency] = useState<number>(1);
	const [permissionTier, setPermissionTier] = useState<
		'readOnly' | 'workspaceWrite' | 'unrestricted'
	>('workspaceWrite');

	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);

		const cleanId = id.trim().toLowerCase();
		if (!cleanId) {
			setError('Agent ID 不能为空');
			return;
		}
		if (existingAgentIds.includes(cleanId)) {
			setError(`Agent ID "${cleanId}" 已存在`);
			return;
		}

		const cleanName = name.trim() || cleanId;
		const cleanMonogram = monogram.trim().toUpperCase();

		// 校验两字符短码与唯一性（AC 5 & E-183）
		const check = validateMonogram(cleanId, cleanMonogram);
		if (!check.valid) {
			setError(check.message || '短码不合法');
			return;
		}

		const cleanPath = execPath.trim();
		if (!cleanPath) {
			setError('可执行路径不能为空');
			return;
		}

		setIsSubmitting(true);
		try {
			const ok = await onAddAgent({
				id: cleanId,
				name: cleanName,
				monogram: cleanMonogram,
				execPath: cleanPath,
				defaultModel: defaultModel.trim() || null,
				maxConcurrency,
				permissionTier,
			});

			if (ok) {
				// 重置表单并收起
				setId('');
				setName('');
				setMonogram('');
				setExecPath('');
				setDefaultModel('');
				setMaxConcurrency(1);
				setPermissionTier('workspaceWrite');
				setIsOpen(false);
			} else {
				setError('保存失败，请检查输入');
			}
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<div
			data-testid="add-agent-section"
			className="flex flex-col gap-3 rounded border border-border bg-bg p-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<h3 className="font-ui text-lead font-semibold text-ink-1">接入新 Agent</h3>
					<p className="text-meta text-ink-2">
						接入第 5、6 个 agent 只需填写两字符短码，无需新增任何图标或资源文件（E-185）
					</p>
				</div>
				<button
					type="button"
					onClick={() => setIsOpen((prev) => !prev)}
					data-testid="toggle-add-agent-btn"
					className="inline-flex h-btn items-center rounded-sm border border-border bg-panel-2 px-3 font-ui text-dense font-medium text-ink-1 hover:bg-bg"
				>
					{isOpen ? '取消' : '+ 接入新 Agent'}
				</button>
			</div>

			{isOpen && (
				<form
					onSubmit={(e) => void handleSubmit(e)}
					data-testid="add-agent-form"
					className="mt-2 flex flex-col gap-3 border-t border-border pt-3"
				>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						{/* ID */}
						<div className="flex flex-col gap-1">
							<label htmlFor="new-agent-id" className="font-ui text-meta text-ink-2">
								Agent 标识符 (ID) *
							</label>
							<input
								id="new-agent-id"
								type="text"
								value={id}
								onChange={(e) => setId(e.target.value)}
								placeholder="例如 custom-agent"
								data-testid="input-new-agent-id"
								className="h-input rounded-sm border border-border bg-panel-2 px-2.5 font-mono text-dense text-ink-1 focus:border-needs focus:outline-none"
							/>
						</div>

						{/* 名称 */}
						<div className="flex flex-col gap-1">
							<label htmlFor="new-agent-name" className="font-ui text-meta text-ink-2">
								显示名称
							</label>
							<input
								id="new-agent-name"
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="例如 Custom Agent"
								data-testid="input-new-agent-name"
								className="h-input rounded-sm border border-border bg-panel-2 px-2.5 font-ui text-dense text-ink-1 focus:border-needs focus:outline-none"
							/>
						</div>

						{/* 两字符短码（AC 7: 仅填两字符短码即可上线） */}
						<div className="flex flex-col gap-1">
							<div className="flex items-center justify-between">
								<label htmlFor="new-agent-monogram" className="font-ui text-meta text-ink-2">
									两字符短码 (Monogram) *
								</label>
								{/* 短码即时预览（无需任何资源文件） */}
								{monogram.trim().length === 2 && (
									<span
										data-testid="new-agent-monogram-preview"
										className="flex h-5 w-5 items-center justify-center rounded-sm border border-border bg-panel-2 font-mono text-micro font-bold text-ink-1"
									>
										{monogram.trim().toUpperCase()}
									</span>
								)}
							</div>
							<input
								id="new-agent-monogram"
								type="text"
								maxLength={2}
								value={monogram}
								onChange={(e) => setMonogram(e.target.value.toUpperCase())}
								placeholder="例如 CA"
								data-testid="input-new-agent-monogram"
								className="h-input w-28 rounded-sm border border-border bg-panel-2 px-2.5 font-mono text-dense text-ink-1 focus:border-needs focus:outline-none"
							/>
							<span className="text-micro text-ink-3">
								以中性文字片直接呈现，不引用任何外部素材
							</span>
						</div>

						{/* 可执行路径 */}
						<div className="flex flex-col gap-1">
							<label htmlFor="new-agent-execpath" className="font-ui text-meta text-ink-2">
								可执行路径 *
							</label>
							<input
								id="new-agent-execpath"
								type="text"
								value={execPath}
								onChange={(e) => setExecPath(e.target.value)}
								placeholder="命令名或绝对路径..."
								data-testid="input-new-agent-execpath"
								className="h-input rounded-sm border border-border bg-panel-2 px-2.5 font-mono text-dense text-ink-1 focus:border-needs focus:outline-none"
							/>
						</div>

						{/* 默认模型 */}
						<div className="flex flex-col gap-1">
							<label htmlFor="new-agent-model" className="font-ui text-meta text-ink-2">
								默认模型（可选）
							</label>
							<input
								id="new-agent-model"
								type="text"
								value={defaultModel}
								onChange={(e) => setDefaultModel(e.target.value)}
								placeholder="例如 default-model"
								data-testid="input-new-agent-model"
								className="h-input rounded-sm border border-border bg-panel-2 px-2.5 font-mono text-dense text-ink-1 focus:border-needs focus:outline-none"
							/>
						</div>

						{/* 最大并发数 */}
						<div className="flex flex-col gap-1">
							<label htmlFor="new-agent-concurrency" className="font-ui text-meta text-ink-2">
								最大并发数
							</label>
							<input
								id="new-agent-concurrency"
								type="number"
								min={1}
								max={32}
								value={maxConcurrency}
								onChange={(e) => setMaxConcurrency(Number(e.target.value))}
								data-testid="input-new-agent-concurrency"
								className="h-input w-24 rounded-sm border border-border bg-panel-2 px-2.5 font-mono text-dense text-ink-1 focus:border-needs focus:outline-none"
							/>
						</div>

						{/* 权限档 */}
						<div className="flex flex-col gap-1">
							<label htmlFor="new-agent-permission" className="font-ui text-meta text-ink-2">
								权限档
							</label>
							<select
								id="new-agent-permission"
								value={permissionTier}
								onChange={(e) =>
									setPermissionTier(
										e.target.value as 'readOnly' | 'workspaceWrite' | 'unrestricted',
									)
								}
								data-testid="select-new-agent-permission"
								className="h-input rounded-sm border border-border bg-panel-2 px-2.5 font-ui text-dense text-ink-1 focus:border-needs focus:outline-none"
							>
								<option value="workspaceWrite">workspaceWrite（工作区写权限）</option>
								<option value="readOnly">readOnly（只读模式）</option>
								<option value="unrestricted">unrestricted（无限制）</option>
							</select>
						</div>
					</div>

					{error && (
						<div data-testid="add-agent-error" className="text-micro text-down">
							{error}
						</div>
					)}

					<div className="flex justify-end gap-2 pt-2">
						<button
							type="button"
							onClick={() => setIsOpen(false)}
							className="h-btn rounded-sm border border-border px-3 font-ui text-dense text-ink-2 hover:bg-panel-2 hover:text-ink-1"
						>
							取消
						</button>
						<button
							type="submit"
							disabled={isSubmitting}
							data-testid="submit-new-agent-btn"
							className="h-btn rounded-sm bg-needs px-4 font-ui text-dense font-semibold text-on-needs hover:opacity-90 disabled:opacity-50"
						>
							{isSubmitting ? '保存中...' : '确认接入'}
						</button>
					</div>
				</form>
			)}
		</div>
	);
}
