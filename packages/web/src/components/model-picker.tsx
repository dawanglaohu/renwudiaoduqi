import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface ModelPickerProps {
	readonly models: readonly string[];
	readonly selectedModel: string | null;
	readonly onSelectModel: (model: string) => void;
	readonly isComplete?: boolean;
	readonly isLoading?: boolean;
	readonly isRefreshing?: boolean;
	readonly onRefresh?: () => void;
	readonly onAddCustomModel?: (model: string) => void;
	readonly initialOpen?: boolean;
	readonly disabled?: boolean;
}

/**
 * 模型选择展示组件（AC 2 & AC 3 / E-38 呈现侧）
 * 规范约束（07 节 components 清单与 R7）：
 * - 纯 props in / callback out，不直接发起 API 请求；
 * - 桌面端：下拉菜单选择器；
 * - 手机端：退化为全屏选择器（fixed inset-0），使用 break-all whitespace-normal，不因屏宽裁剪候选项；
 * - 清单不全（isComplete === false）时明示「清单可能不全」并保留手填入口；
 * - 修复 dead token：统一使用 h-input 与既有 token。
 */
export function ModelPicker({
	models,
	selectedModel,
	onSelectModel,
	isComplete = true,
	isLoading = false,
	isRefreshing = false,
	onRefresh,
	onAddCustomModel,
	initialOpen = false,
	disabled = false,
}: ModelPickerProps) {
	const pickerId = useId();
	const [isOpen, setIsOpen] = useState<boolean>(initialOpen);
	const [searchTerm, setSearchTerm] = useState<string>('');
	const [manualInput, setManualInput] = useState<string>('');
	const [isMobile, setIsMobile] = useState<boolean>(false);

	const containerRef = useRef<HTMLDivElement>(null);

	// Detect mobile viewport (<640px)
	useEffect(() => {
		if (typeof window === 'undefined') return;
		const media = window.matchMedia('(max-width: 639px)');
		setIsMobile(media.matches);

		const listener = (e: MediaQueryListEvent) => {
			setIsMobile(e.matches);
		};
		media.addEventListener('change', listener);
		return () => media.removeEventListener('change', listener);
	}, []);

	// Click outside to close on desktop
	useEffect(() => {
		if (!isOpen || isMobile) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setIsOpen(false);
			}
		};
		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [isOpen, isMobile]);

	// Filtered models
	const filteredModels = useMemo(() => {
		const term = searchTerm.trim().toLowerCase();
		if (!term) return models;
		return models.filter((m) => m.toLowerCase().includes(term));
	}, [models, searchTerm]);

	const handleSelect = (model: string) => {
		onSelectModel(model);
		setIsOpen(false);
		setSearchTerm('');
	};

	const handleApplyManual = () => {
		const trimmed = manualInput.trim();
		if (!trimmed) return;
		if (onAddCustomModel) {
			onAddCustomModel(trimmed);
		}
		onSelectModel(trimmed);
		setManualInput('');
		setIsOpen(false);
	};

	return (
		<div ref={containerRef} className="relative w-full">
			{/* 触发器按键 */}
			<div className="flex items-center gap-2">
				<button
					type="button"
					id={`model-picker-trigger-${pickerId}`}
					onClick={() => !disabled && setIsOpen((prev) => !prev)}
					disabled={disabled}
					data-testid="model-picker-trigger"
					aria-expanded={isOpen}
					className={`flex h-input w-full items-center justify-between rounded-sm border border-border bg-bg px-3 font-mono text-dense text-ink-1 transition-colors ${
						disabled
							? 'cursor-not-allowed opacity-50'
							: 'hover:border-border-strong focus:border-needs'
					}`}
				>
					<span className="truncate" title={selectedModel ?? '未设置默认模型'}>
						{selectedModel || <span className="font-ui text-ink-3">选择默认模型...</span>}
					</span>
					<svg
						className={`ml-2 h-4 w-4 shrink-0 text-ink-3 transition-transform ${
							isOpen ? 'rotate-180' : ''
						}`}
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						aria-hidden="true"
					>
						<title>展开选项</title>
						<path d="M4 6l4 4 4-4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</button>

				{/* 刷新清单按钮 */}
				{onRefresh && (
					<button
						type="button"
						onClick={onRefresh}
						disabled={disabled || isRefreshing}
						title="刷新模型清单"
						aria-label="刷新模型清单"
						data-testid="refresh-models-btn"
						className="flex h-input w-input shrink-0 items-center justify-center rounded-sm border border-border bg-bg text-ink-2 hover:bg-panel-2 hover:text-ink-1 disabled:opacity-40"
					>
						<svg
							className={`h-4 w-4 ${isRefreshing ? 'animate-spin text-needs' : ''}`}
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							aria-hidden="true"
						>
							<title>刷新</title>
							<path
								d="M2.5 8a5.5 5.5 0 019.39-3.89L13.5 6M13.5 8a5.5 5.5 0 01-9.39 3.89L2.5 10"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>
				)}
			</div>

			{/* 桌面端下拉列表 */}
			{isOpen && !isMobile && (
				<div
					data-testid="desktop-model-dropdown"
					className="absolute left-0 right-0 top-full z-40 mt-1 flex max-h-80 flex-col rounded-sm border border-border-strong bg-bg p-2 shadow-lg"
				>
					{/* 搜索过滤框 */}
					<input
						type="text"
						value={searchTerm}
						onChange={(e) => setSearchTerm(e.target.value)}
						placeholder="搜索模型..."
						className="h-input w-full rounded-sm border border-border bg-panel-2 px-2.5 font-mono text-dense text-ink-1 placeholder:text-ink-3 focus:border-needs focus:outline-none"
					/>

					{/* AC 3: 清单不全提示与手填入口 (E-38) */}
					{!isComplete && (
						<div
							data-testid="incomplete-models-banner"
							className="mt-2 flex flex-col gap-1.5 rounded-sm border border-needs bg-needs-soft p-2 text-meta text-needs"
						>
							<div className="flex items-center justify-between">
								<span className="font-medium font-ui">清单可能不全</span>
								<span className="text-micro text-ink-2">支持手动输入模型</span>
							</div>
							<div className="flex gap-1">
								{/* 修复：使用既有 h-input token 代替 h-input-sm */}
								<input
									type="text"
									value={manualInput}
									onChange={(e) => setManualInput(e.target.value)}
									onKeyDown={(e) => e.key === 'Enter' && handleApplyManual()}
									placeholder="输入任意模型名..."
									data-testid="manual-model-input"
									className="h-input flex-1 rounded-sm border border-border bg-panel-2 px-2 font-mono text-dense text-ink-1 focus:border-needs focus:outline-none"
								/>
								<button
									type="button"
									onClick={handleApplyManual}
									data-testid="apply-manual-model-btn"
									className="rounded-sm bg-needs px-2 font-ui text-dense font-medium text-on-needs hover:opacity-90"
								>
									确定
								</button>
							</div>
						</div>
					)}

					{/* 候选项列表 */}
					<div aria-label="模型列表" className="mt-2 flex flex-col gap-0.5 overflow-y-auto">
						{isLoading ? (
							<div className="py-4 text-center text-meta text-ink-3">正在拉取模型清单...</div>
						) : filteredModels.length === 0 ? (
							<div className="py-4 text-center text-meta text-ink-3">
								无匹配模型
								{isComplete && (
									<div className="mt-1">
										<button
											type="button"
											onClick={() => {
												if (searchTerm.trim()) {
													handleSelect(searchTerm.trim());
												}
											}}
											className="text-needs underline text-micro"
										>
											使用当前搜索词作为模型名
										</button>
									</div>
								)}
							</div>
						) : (
							filteredModels.map((m) => (
								<button
									key={m}
									type="button"
									aria-selected={m === selectedModel}
									onClick={() => handleSelect(m)}
									className={`flex items-center justify-between rounded-sm px-2.5 py-1.5 text-left font-mono text-dense transition-colors ${
										m === selectedModel
											? 'bg-panel-2 text-needs font-medium'
											: 'text-ink-1 hover:bg-panel-2'
									}`}
								>
									<span className="break-all">{m}</span>
									{m === selectedModel && <span className="text-micro text-needs">✓</span>}
								</button>
							))
						)}
					</div>
				</div>
			)}

			{/* 手机端全屏选择器（AC 2: 手机端退化为全屏选择器，不因屏宽裁剪候选项） */}
			{isOpen && isMobile && (
				<div
					data-testid="mobile-model-sheet"
					aria-label="选择模型"
					className="fixed inset-0 z-50 flex flex-col bg-page p-4 text-ink-1"
				>
					{/* 手机端顶栏：44px 高度关闭按钮 */}
					<div className="flex h-btn-lg items-center justify-between border-b border-border pb-2">
						<h2 className="font-ui text-lead font-semibold text-ink-1">选择模型</h2>
						<button
							type="button"
							onClick={() => setIsOpen(false)}
							data-testid="close-mobile-sheet-btn"
							aria-label="关闭选择器"
							className="flex h-btn-lg w-btn-lg items-center justify-center rounded-sm text-ink-2 hover:bg-panel-2 hover:text-ink-1"
						>
							<svg
								className="h-6 w-6"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								aria-hidden="true"
							>
								<title>关闭</title>
								<path
									d="M6 18L18 6M6 6l12 12"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						</button>
					</div>

					{/* 手机端搜索框 */}
					<div className="mt-3">
						<input
							type="text"
							value={searchTerm}
							onChange={(e) => setSearchTerm(e.target.value)}
							placeholder="搜索模型..."
							className="h-input-touch w-full rounded-sm border border-border bg-panel-2 px-3 font-mono text-dense text-ink-1 placeholder:text-ink-3 focus:border-needs focus:outline-none"
						/>
					</div>

					{/* AC 3: 清单不全提示与手填入口 (E-38) */}
					{!isComplete && (
						<div
							data-testid="mobile-incomplete-models-banner"
							className="mt-3 flex flex-col gap-2 rounded-sm border border-needs bg-needs-soft p-3 text-meta text-needs"
						>
							<div className="flex items-center justify-between">
								<span className="font-semibold font-ui">清单可能不全</span>
								<span className="text-micro text-ink-2">可手填自定义模型</span>
							</div>
							<div className="flex gap-2">
								<input
									type="text"
									value={manualInput}
									onChange={(e) => setManualInput(e.target.value)}
									placeholder="输入完整模型名称..."
									data-testid="mobile-manual-model-input"
									className="h-input-touch flex-1 rounded-sm border border-border bg-panel-2 px-3 font-mono text-dense text-ink-1 focus:border-needs focus:outline-none"
								/>
								<button
									type="button"
									onClick={handleApplyManual}
									data-testid="mobile-apply-manual-btn"
									className="h-input-touch rounded-sm bg-needs px-4 font-ui font-semibold text-on-needs hover:opacity-90"
								>
									使用
								</button>
							</div>
						</div>
					)}

					{/* 候选项列表（AC 2: 换行完整显示，不因屏宽裁剪候选项！） */}
					<div
						aria-label="全部模型候选项"
						className="mt-3 flex flex-1 flex-col gap-1 overflow-y-auto"
					>
						{isLoading ? (
							<div className="py-8 text-center text-body text-ink-3">正在拉取模型清单...</div>
						) : filteredModels.length === 0 ? (
							<div className="py-8 text-center text-body text-ink-3">无匹配候选项</div>
						) : (
							filteredModels.map((m) => (
								<button
									key={m}
									type="button"
									aria-selected={m === selectedModel}
									onClick={() => handleSelect(m)}
									data-testid="mobile-model-option"
									className={`flex min-h-[44px] w-full items-center justify-between rounded-sm px-3 py-2.5 text-left font-mono text-dense transition-colors ${
										m === selectedModel
											? 'border border-needs bg-panel-2 text-needs font-semibold'
											: 'border border-border bg-bg text-ink-1 hover:bg-panel-2'
									}`}
								>
									{/* 不因屏宽裁剪候选项：使用 break-all 和 whitespace-normal，严禁截断 */}
									<span className="break-all whitespace-normal pr-2 text-dense">{m}</span>
									{m === selectedModel && <span className="shrink-0 text-needs font-bold">✓</span>}
								</button>
							))
						)}
					</div>
				</div>
			)}
		</div>
	);
}
