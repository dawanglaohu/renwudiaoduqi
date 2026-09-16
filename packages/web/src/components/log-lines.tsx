/**
 * packages/web/src/components/log-lines.tsx
 *
 * 日志行展示与处理组件（M9-T8 / AC 3, AC 4, AC 5, E-100, E-101, E-102, E-98）
 *
 * 规范依据（07 节前端架构与 11 节 UI）：
 * - 纯展示层组件：纯 props in / callback out，禁止 import api/store/features/shell，禁止内部 useEffect（07 节）
 * - ANSI 转义与重复刷新行折叠，控制字符不破坏布局（AC 4, E-101）
 * - 单行超长按宽度截断并可展开，绝不把整行塞进 DOM（AC 5, E-102）
 * - 浮动底栏在滚到中部时提示「回到底部（有 N 行新增）」，仅贴底才自动跟随（AC 3, E-100）
 * - 大会话超限时提供顶部「向上加载更多」与「用系统默认程序打开原始文件」（E-98）
 * - 字体与尺寸：Commit Mono 等宽字体（var(--font-mono)），字号 12.5px（var(--fs-log)）
 * - 严禁出现十六进制与 rgb 颜色字面量，一律使用 tokens.css 变量（07 节 / check-forbidden.ts）
 */

import type { HTMLAttributes, MouseEvent } from 'react';

/**
 * 单行默认最大展示字符数（未展开时截断边界）。
 */
export const LINE_COLLAPSED_MAX_CHARS = 300;

/**
 * 单行展开时最大挂载字符数（AC 5 / E-102: 绝不把整行塞进 DOM）。
 */
export const LINE_EXPANDED_MAX_CHARS = 2000;

/**
 * 解析后的 ANSI 样式片段。
 */
export interface AnsiSpan {
	readonly text: string;
	readonly bold?: boolean;
	readonly dim?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly colorVar?: string;
}

/**
 * 单行文本截断判定结果。
 */
export interface TruncateResult {
	/** 是否发生了截断 */
	readonly isTruncated: boolean;
	/** 原始完整字符数 */
	readonly totalChars: number;
	/** 实际挂载进 DOM 的文本片段 */
	readonly visibleText: string;
	/** 是否因为超长（>2000）在展开态也被封顶截断 */
	readonly isCappedAtMax: boolean;
}

/**
 * 处理终端回退字符（\r）（AC 4 / E-101）。
 * 终端中的 \r 将光标重置回行首并覆写已有字符。
 * 纯函数：返回覆写后的最终文本。
 */
export function resolveCarriageReturns(text: string): string {
	if (!text.includes('\r')) {
		return text;
	}
	const parts = text.split('\r');
	let result = '';
	for (const part of parts) {
		if (part.length >= result.length) {
			result = part;
		} else {
			result = part + result.slice(part.length);
		}
	}
	return result;
}

/**
 * 剥除 ASCII 控制字符（ASCII 0-8, 11-12, 14-31, 127）（AC 4 / E-101）。
 * 保留 \t（制表符）、\n（换行）、\r（回车）、ESC（27，用于后续 ANSI 处理）与可打印字符，
 * 防止控制字符破坏排版布局。
 */
export function sanitizeControlCharacters(text: string): string {
	let result = '';
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 9 || code === 10 || code === 13 || code === 27 || (code >= 32 && code !== 127)) {
			result += text[i];
		}
	}
	return result;
}

/**
 * 探测某一行是否属于终端进度条或高频刷新行（AC 4 / E-101）。
 */
export function isProgressLine(line: string): boolean {
	if (line.includes('\r')) {
		return true;
	}
	return /(?:\[[=#>\-\s]{3,}\]|\d{1,3}%|\bprogress\b|\bdownloading\b|\bdownloaded\b|\bextracting\b)/i.test(
		line,
	);
}

/**
 * 解析带有 ANSI 转义序列的文本片段（AC 4 / E-101）。
 * 采用字符扫描器解析 SGR 样式，过滤非 SGR 游标移动与 OSC 指令。
 * 映射为安全 CSS 变量样式，不引入任意颜色字面量。
 */
export function parseAnsiCodes(rawText: string): AnsiSpan[] {
	const cleaned = sanitizeControlCharacters(rawText);
	// 如果不含 ESC 字符（27），直接返回纯文本
	if (!cleaned.includes(String.fromCharCode(27))) {
		return [{ text: cleaned }];
	}

	const spans: AnsiSpan[] = [];
	let currentText = '';
	let currentBold = false;
	let currentDim = false;
	let currentItalic = false;
	let currentUnderline = false;
	let currentColorVar: string | undefined = undefined;

	const flush = () => {
		if (currentText.length > 0) {
			spans.push({
				text: currentText,
				bold: currentBold || undefined,
				dim: currentDim || undefined,
				italic: currentItalic || undefined,
				underline: currentUnderline || undefined,
				colorVar: currentColorVar,
			});
			currentText = '';
		}
	};

	let i = 0;
	while (i < cleaned.length) {
		const code = cleaned.charCodeAt(i);
		if (code === 27) {
			// ESC [ -> CSI 指令
			if (i + 1 < cleaned.length && cleaned[i + 1] === '[') {
				let j = i + 2;
				while (
					j < cleaned.length &&
					!(cleaned.charCodeAt(j) >= 64 && cleaned.charCodeAt(j) <= 126)
				) {
					j++;
				}
				if (j < cleaned.length) {
					const command = cleaned[j];
					const paramStr = cleaned.slice(i + 2, j);
					if (command === 'm') {
						// SGR 色彩与样式指令
						flush();
						const codes = paramStr.length > 0 ? paramStr.split(';').map(Number) : [0];
						for (const c of codes) {
							if (c === 0) {
								currentBold = false;
								currentDim = false;
								currentItalic = false;
								currentUnderline = false;
								currentColorVar = undefined;
							} else if (c === 1) {
								currentBold = true;
							} else if (c === 2) {
								currentDim = true;
							} else if (c === 3) {
								currentItalic = true;
							} else if (c === 4) {
								currentUnderline = true;
							} else if (c === 22) {
								currentBold = false;
								currentDim = false;
							} else if (c === 23) {
								currentItalic = false;
							} else if (c === 24) {
								currentUnderline = false;
							} else if (c === 31 || c === 91) {
								currentColorVar = 'var(--down)'; // 失败红
							} else if (c === 32 || c === 92) {
								currentColorVar = 'var(--auto)'; // 推进绿
							} else if (c === 33 || c === 93) {
								currentColorVar = 'var(--needs)'; // 警告黄
							} else if (c === 30 || c === 90) {
								currentColorVar = 'var(--ink-3)'; // 弱化灰
							} else if (c === 34 || c === 94 || c === 37 || c === 97 || c === 39) {
								currentColorVar = 'var(--ink-1)'; // 正文白
							} else if (c === 35 || c === 95) {
								currentColorVar = 'var(--needs)';
							} else if (c === 36 || c === 96) {
								currentColorVar = 'var(--auto)';
							}
						}
					}
					// 略过非 m 命令（如 2K 擦除或光标移动）
					i = j + 1;
					continue;
				}
			} else if (i + 1 < cleaned.length && cleaned[i + 1] === ']') {
				// ESC ] -> OSC 指令，寻找到 BEL(7) 或 ESC \ 结束
				let j = i + 2;
				while (
					j < cleaned.length &&
					cleaned.charCodeAt(j) !== 7 &&
					!(cleaned.charCodeAt(j) === 27 && j + 1 < cleaned.length && cleaned[j + 1] === '\\')
				) {
					j++;
				}
				if (j < cleaned.length) {
					i = cleaned.charCodeAt(j) === 27 ? j + 2 : j + 1;
					continue;
				}
			}
		}

		currentText += cleaned[i];
		i++;
	}

	flush();

	return spans.length > 0 ? spans : [{ text: '' }];
}

/**
 * 单行超长截断处理（AC 5 / E-102）。
 * 默认显示前 300 字符；展开时最多截取至 2000 字符，绝不把整行塞进 DOM。
 */
export function truncateLongLine(rawText: string, isExpanded: boolean): TruncateResult {
	const totalChars = rawText.length;
	if (totalChars <= LINE_COLLAPSED_MAX_CHARS) {
		return {
			isTruncated: false,
			totalChars,
			visibleText: rawText,
			isCappedAtMax: false,
		};
	}

	if (!isExpanded) {
		return {
			isTruncated: true,
			totalChars,
			visibleText: rawText.slice(0, LINE_COLLAPSED_MAX_CHARS),
			isCappedAtMax: false,
		};
	}

	// 展开态：绝不把整行塞进 DOM，封顶 2000 字符
	const isCappedAtMax = totalChars > LINE_EXPANDED_MAX_CHARS;
	const visibleText = isCappedAtMax ? rawText.slice(0, LINE_EXPANDED_MAX_CHARS) : rawText;

	return {
		isTruncated: true,
		totalChars,
		visibleText,
		isCappedAtMax,
	};
}

/**
 * 单条日志行组件属性。
 */
export interface LogLineProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
	/** 行索引序号（0-based） */
	readonly index: number;
	/** 原始文本内容 */
	readonly text: string;
	/** 显示的行号（默认 index + 1） */
	readonly lineNumber?: number;
	/** 是否展示行号侧栏（默认 true） */
	readonly showLineNumber?: boolean;
	/** 外部受控是否展开超长行 */
	readonly isExpanded?: boolean;
	/** 切换展开状态回调 */
	readonly onToggleExpand?: (index: number) => void;
	/** 是否为已折叠的高频进度刷新行 */
	readonly isProgressCollapsed?: boolean;
	/** 折叠的刷新次数（>1 时展示折叠徽标） */
	readonly refreshCount?: number;
	/** 切换进度刷新行折叠展开回调 */
	readonly onToggleProgressCollapse?: (index: number) => void;
	/** 折叠的全部原始行内容列表 */
	readonly collapsedLines?: readonly string[];
}

/**
 * 单个日志行渲染组件（AC 4, AC 5）。
 */
export function LogLine({
	index,
	text,
	lineNumber,
	showLineNumber = true,
	isExpanded = false,
	onToggleExpand,
	isProgressCollapsed = false,
	refreshCount,
	onToggleProgressCollapse,
	collapsedLines,
	className,
	style,
	...rest
}: LogLineProps) {
	// 1. 处理 \r 覆盖（E-101）
	const resolvedText = resolveCarriageReturns(text);

	// 2. 超长截断处理（E-102）
	const truncateInfo = truncateLongLine(resolvedText, isExpanded);

	// 3. ANSI 颜色与控制码解析（E-101）
	const spans = parseAnsiCodes(truncateInfo.visibleText);

	const displayLineNo = lineNumber ?? index + 1;

	const handleExpandClick = (e: MouseEvent) => {
		e.stopPropagation();
		onToggleExpand?.(index);
	};

	const handleProgressToggle = (e: MouseEvent) => {
		e.stopPropagation();
		onToggleProgressCollapse?.(index);
	};

	return (
		<div
			className={`group flex items-start w-full hover:bg-[var(--panel-2)] transition-colors ${className ?? ''}`}
			style={{
				fontFamily: 'var(--font-mono)',
				fontSize: 'var(--fs-log)',
				lineHeight: '1.5',
				minHeight: '22px',
				...style,
			}}
			data-log-line={index}
			{...rest}
		>
			{showLineNumber && (
				<span
					className="shrink-0 w-12 pr-3 select-none text-right font-mono"
					style={{ color: 'var(--ink-3)' }}
					aria-hidden="true"
				>
					{displayLineNo}
				</span>
			)}

			<div
				className="flex-1 min-w-0 break-all whitespace-pre-wrap font-mono"
				style={{ color: 'var(--ink-1)' }}
			>
				{spans.map((span, spanIdx) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: 纯展示文本切片索引稳定
						key={spanIdx}
						style={{
							color: span.colorVar,
							fontWeight: span.bold ? 600 : undefined,
							fontStyle: span.italic ? 'italic' : undefined,
							textDecoration: span.underline ? 'underline' : undefined,
							opacity: span.dim ? 0.65 : undefined,
						}}
					>
						{span.text}
					</span>
				))}

				{/* 超长截断提示与展开/折叠按钮（AC 5 / E-102） */}
				{truncateInfo.isTruncated && !isExpanded && (
					<span className="inline-flex items-center gap-1 ml-1 select-none">
						<span style={{ color: 'var(--ink-3)' }}>… (共 {truncateInfo.totalChars} 字符)</span>
						<button
							type="button"
							onClick={handleExpandClick}
							className="px-1 py-0.5 rounded text-xs transition-opacity hover:opacity-80"
							style={{
								color: 'var(--needs)',
								backgroundColor: 'var(--needs-soft)',
							}}
						>
							展开 (+{truncateInfo.totalChars - LINE_COLLAPSED_MAX_CHARS} 字符)
						</button>
					</span>
				)}

				{truncateInfo.isTruncated && isExpanded && (
					<span className="inline-flex items-center gap-1 ml-1 select-none">
						{truncateInfo.isCappedAtMax && (
							<span
								className="text-xs px-1 py-0.5 rounded"
								style={{
									color: 'var(--needs)',
									backgroundColor: 'var(--needs-soft)',
								}}
							>
								[已截取前 {LINE_EXPANDED_MAX_CHARS} 字符以保护 DOM 性能 (E-102)]
							</span>
						)}
						<button
							type="button"
							onClick={handleExpandClick}
							className="px-1 py-0.5 rounded text-xs transition-opacity hover:opacity-80"
							style={{
								color: 'var(--ink-2)',
								backgroundColor: 'var(--panel-2)',
							}}
						>
							收起
						</button>
					</span>
				)}

				{/* 进度刷新折叠标签（AC 4 / E-101） */}
				{refreshCount && refreshCount > 1 && (
					<button
						type="button"
						onClick={handleProgressToggle}
						className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.2 rounded text-xs select-none transition-opacity hover:opacity-80"
						style={{
							color: 'var(--auto)',
							backgroundColor: 'var(--auto-soft)',
						}}
					>
						{isProgressCollapsed
							? `[已折叠 ${refreshCount} 次进度刷新]`
							: `[展开中 / 共 ${refreshCount} 次刷新]`}
					</button>
				)}

				{/* 展开后的进度刷新历史行明细 */}
				{!isProgressCollapsed && collapsedLines && collapsedLines.length > 1 && (
					<div
						className="mt-1 pl-2 flex flex-col gap-0.5"
						style={{
							borderLeft: '1px solid var(--border)',
							opacity: 0.85,
						}}
					>
						{collapsedLines.map((colLine, colIdx) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: 历史刷新行切片稳定
								key={colIdx}
								className="text-xs font-mono whitespace-pre-wrap"
								style={{ color: 'var(--ink-2)' }}
							>
								{resolveCarriageReturns(colLine)}
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * 贴底未跟随时的浮动新增提示条属性（AC 3 / E-100）。
 */
export interface LogBottomNoticeProps {
	/** 新增未读事件/行数 */
	readonly unreadCount: number;
	/** 点击回到底部的回调 */
	readonly onClick: () => void;
	/** 自定义类名 */
	readonly className?: string;
}

/**
 * 贴底未跟随提示按钮（AC 3 / E-100）。
 * 用户滚到中部时新事件到达不自动跳底，呈现「回到底部（有 N 行新增）」。
 */
export function LogBottomNotice({ unreadCount, onClick, className }: LogBottomNoticeProps) {
	if (unreadCount <= 0) {
		return null;
	}

	return (
		<div className={`absolute bottom-3 right-6 z-20 pointer-events-auto ${className ?? ''}`}>
			<button
				type="button"
				onClick={onClick}
				className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-full shadow-lg transition-[filter] hover:brightness-[1.04] active:brightness-95"
				style={{
					backgroundColor: 'var(--panel-2)',
					border: '1px solid var(--needs)',
					color: 'var(--needs)',
					boxShadow: 'var(--shadow-lg)',
				}}
				data-log-bottom-notice="true"
			>
				<span aria-hidden="true">↓</span>
				<span>回到底部（有 {unreadCount} 行新增）</span>
			</button>
		</div>
	);
}

/**
 * 超大体积与向上加载提示横条属性（E-98）。
 */
export interface LogThresholdBannerProps {
	/** 是否存在更早的历史片段 */
	readonly hasOlder: boolean;
	/** 是否单会话体积超过阈值（20MB 或 50 万字） */
	readonly isExceedsThreshold?: boolean;
	/** 原始文件路径（供系统默认程序打开） */
	readonly originalFilePath?: string | null;
	/** 向上加载更多回调 */
	readonly onLoadOlder: () => void;
	/** 正在向上加载中 */
	readonly isLoadingOlder?: boolean;
	/** 用系统程序打开原始文件的回调 */
	readonly onOpenOriginal?: () => void;
	/** 自定义类名 */
	readonly className?: string;
}

/**
 * 向下重新拉取较新日志片段按钮栏属性（AC 2 滚出重拉 / R5 e）。
 */
export interface LogLoadNewerBarProps {
	/** 是否正在向下拉取中 */
	readonly isLoading?: boolean;
	/** 点击加载回调 */
	readonly onClick: () => void;
	/** 自定义类名 */
	readonly className?: string;
}

/**
 * 底部向下重新加载较新分段按钮栏（AC 2 / R5 e）。
 */
export function LogLoadNewerBar({ isLoading = false, onClick, className }: LogLoadNewerBarProps) {
	return (
		<div className={`flex justify-center py-1 shrink-0 ${className ?? ''}`}>
			<button
				type="button"
				disabled={isLoading}
				onClick={onClick}
				className="px-3 py-1 text-xs rounded border transition-opacity hover:opacity-90 disabled:opacity-50"
				style={{
					backgroundColor: 'var(--panel-2)',
					borderColor: 'var(--border-strong)',
					color: 'var(--ink-1)',
				}}
				data-load-newer="true"
			>
				{isLoading ? '加载较新分段中…' : '向下重新加载较新日志'}
			</button>
		</div>
	);
}

export function LogThresholdBanner({
	hasOlder,
	isExceedsThreshold = false,
	originalFilePath,
	onLoadOlder,
	isLoadingOlder = false,
	onOpenOriginal,
	className,
}: LogThresholdBannerProps) {
	if (!hasOlder && !isExceedsThreshold) {
		return null;
	}

	return (
		<div
			className={`flex items-center justify-between px-3 py-2 text-xs border-b ${className ?? ''}`}
			style={{
				backgroundColor: 'var(--panel-2)',
				borderColor: 'var(--border)',
				color: 'var(--ink-2)',
			}}
			data-log-threshold-banner="true"
		>
			<div className="flex items-center gap-2 min-w-0 truncate">
				{isExceedsThreshold && (
					<span
						className="px-1.5 py-0.5 rounded font-medium shrink-0"
						style={{
							backgroundColor: 'var(--needs-soft)',
							color: 'var(--needs)',
						}}
					>
						体积超限 (E-98)
					</span>
				)}
				<span className="truncate">
					{isExceedsThreshold
						? '会话体积已超 20MB 或 50 万字，默认加载尾部片段。'
						: '已加载当前片段，顶部仍有历史日志。'}
				</span>
			</div>

			<div className="flex items-center gap-2 shrink-0 ml-3">
				{hasOlder && (
					<button
						type="button"
						disabled={isLoadingOlder}
						onClick={onLoadOlder}
						className="px-2.5 py-1 rounded transition-opacity hover:opacity-90 disabled:opacity-50"
						style={{
							backgroundColor: 'var(--needs)',
							color: 'var(--on-needs)',
							fontWeight: 500,
						}}
					>
						{isLoadingOlder ? '加载中…' : '向上加载更多'}
					</button>
				)}

				{originalFilePath && (
					<button
						type="button"
						onClick={onOpenOriginal}
						className="px-2.5 py-1 rounded border transition-colors hover:bg-[var(--bg)]"
						style={{
							borderColor: 'var(--border-strong)',
							color: 'var(--ink-1)',
						}}
						title={originalFilePath}
					>
						用系统默认程序打开原始文件
					</button>
				)}
			</div>
		</div>
	);
}
