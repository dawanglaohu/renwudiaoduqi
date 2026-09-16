/**
 * packages/web/src/components/session-search-entrance.tsx
 *
 * 全会话深度查找显式入口组件（M9-T16 / AC 5, E-218）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - components 纯展示组件（纯 props in / callback out）
 * - 针对虚拟滚动和分段加载导致浏览器 Ctrl+F 搜不全的问题，在会话视图提供显式入口（E-218）
 * - 结果由服务端真实接口返回，禁止伪造随机数或无条件宣称已检索全量
 */

import { type FormEvent, useState } from 'react';
import type { SearchRunLogResponse } from '../../../shared/src/api/runs.ts';

export interface SessionSearchEntranceProps {
	/** 当前搜索关键词（可控） */
	readonly query?: string;
	/** 关键词变更回调 */
	readonly onQueryChange?: (query: string) => void;
	/** 执行搜索触发回调 */
	readonly onSearch?: (query: string) => void;
	/** 是否正在搜索中 */
	readonly isSearching?: boolean;
	/** 服务端真实返回的检索结果（AC 5, E-218, M6-T9） */
	readonly searchResult?: SearchRunLogResponse | null;
	/** 错误信息 */
	readonly error?: string | null;
	/** 样式自定义类名 */
	readonly className?: string;
}

/**
 * 「在整个会话中查找」显式入口组件（AC 5, E-218）。
 * 明确提示浏览器 Ctrl+F 仅搜当前已加载分段，避免几十 MB 会话产生漏搜误判。
 */
export function SessionSearchEntrance({
	query: controlledQuery,
	onQueryChange,
	onSearch,
	isSearching = false,
	searchResult = null,
	error = null,
	className = '',
}: SessionSearchEntranceProps) {
	const [internalQuery, setInternalQuery] = useState('');
	const currentQuery = controlledQuery !== undefined ? controlledQuery : internalQuery;

	const handleSearch = (e?: FormEvent) => {
		e?.preventDefault();
		const trimmed = currentQuery.trim();
		if (!trimmed) return;
		onSearch?.(trimmed);
	};

	return (
		<div
			data-testid="session-search-entrance"
			className={[
				'flex flex-col gap-2 rounded border border-border bg-panel-2 p-3 text-ink-1 font-ui select-none',
				className,
			].join(' ')}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<span className="font-mono text-micro font-bold text-needs uppercase px-1.5 py-0.5 rounded bg-bg border border-border">
						Search
					</span>
					<span className="font-ui text-dense font-semibold text-ink-1">在整个会话中查找</span>
				</div>
				{/* E-218 明确解释入口背景 */}
				<span className="font-mono text-micro text-ink-3">
					(浏览器 Ctrl+F 仅搜已加载日志；此入口索引数十 MB 全会话)
				</span>
			</div>

			<form onSubmit={handleSearch} className="flex items-center gap-2 mt-1">
				<input
					type="text"
					data-testid="whole-session-search-input"
					value={currentQuery}
					onChange={(e) => {
						setInternalQuery(e.target.value);
						onQueryChange?.(e.target.value);
					}}
					placeholder="输入关键词在完整会话日志中深度查找..."
					className="h-btn flex-1 rounded-sm border border-border bg-bg px-3 font-mono text-log text-ink-1 placeholder:text-ink-3 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--needs-soft)]"
				/>
				<button
					type="submit"
					data-action="search-whole-session"
					disabled={isSearching}
					className="h-btn px-4 rounded-sm bg-needs text-on-needs font-ui text-dense font-semibold transition-colors hover:brightness-105 active:scale-98 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{isSearching ? '正在查找...' : '在整个会话中查找'}
				</button>
			</form>

			{searchResult !== null && searchResult !== undefined && (
				<div
					data-testid="search-results-feedback"
					className="font-mono text-micro flex flex-wrap items-center gap-2 pt-1"
				>
					<span data-testid="search-hits-count" className="font-bold text-auto">
						{searchResult.hits.length} 命中
					</span>
					<span className="text-ink-3">(已扫描至序号 {searchResult.scannedUntilSeq})</span>
					{searchResult.truncated && <span className="text-needs font-medium">[已达上限截断]</span>}
					{searchResult.canceled && <span className="text-down font-medium">[查询已取消]</span>}
				</div>
			)}

			{error && (
				<div data-testid="search-error-feedback" className="font-mono text-micro text-down pt-1">
					搜索异常: {error}
				</div>
			)}
		</div>
	);
}

export default SessionSearchEntrance;
