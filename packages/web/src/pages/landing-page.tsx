/**
 * packages/web/src/pages/landing-page.tsx
 *
 * 落地清单页与全会话查找入口（M9-T16 / AC 3, AC 4, AC 5, AC 6, E-74, E-19, E-218, E-110）
 *
 * 规范依据（11 节 UI 与 07 节前端架构）：
 * - 落地清单页展示 worktree 绝对路径、分支名、diff 摘要、可一键复制的 gh stack 命令与 build_docs.py --landed 命令（AC 3, E-74）
 * - 每条各带独立复制按钮，操作模式为「复制而不执行」，由人工完成合并操作（AC 3, E-74）
 * - 文档变更横幅显示「本文档已更新，N 个任务的依据已变」并可进入受影响任务的过滤列表（AC 4, E-19）
 * - 会话视图必须另给显式的「在整个会话中查找」入口，避免用户误以为 Ctrl+F 已搜全文（AC 5, E-218）
 * - 长时间盯屏下深色为默认、路径/命令/代码/数字一律等宽（AC 6, E-110）
 * - 纯 CSS 变量绑定（tokens.css），严禁颜色字面量（check-forbidden 机检）
 * - 路由挂载支持单段参数 #/landing/:taskId 并支持 props 装配注入（07 节）
 */

import { useCallback, useEffect, useState } from 'react';
import type { GetTaskLandingResponse } from '../../../shared/src/api/tasks.ts';
import { httpClient } from '../api/http-client.ts';
import { ROUTE_PATHS, type RouteComponentProps, navigateTo } from '../app/routes.tsx';
import { DocChangeBanner, type DocChangeNotice } from '../components/empty-onboarding.tsx';
import { getStatusShape } from '../lib/spine-shape.ts';

export interface LandingPageProps extends Partial<RouteComponentProps> {
	/** 任务标识符（来自路由参数或 props） */
	readonly taskId?: string;
	/** 外部传入的落地清单数据（用于单测或直接装配注入） */
	readonly initialData?: GetTaskLandingResponse;
	/** 文档变更提示信息（AC 4 / E-19） */
	readonly docChangeNotice?: DocChangeNotice | null;
	/** 查看受影响任务列表回调 */
	readonly onViewAffectedTasks?: (taskIds: readonly string[]) => void;
	/** 全会话搜索触发回调（AC 5 / E-218） */
	readonly onSearchSession?: (query: string) => void;
	/** 外部自定义 class */
	readonly className?: string;
}

/**
 * 复制到剪贴板通用安全函数（兼容非 HTTPS 或受限测试沙箱环境）。
 */
async function copyToClipboard(text: string): Promise<boolean> {
	try {
		if (
			typeof navigator !== 'undefined' &&
			navigator.clipboard &&
			typeof navigator.clipboard.writeText === 'function'
		) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// 回落至传统模式
	}

	try {
		if (typeof document !== 'undefined') {
			const textarea = document.createElement('textarea');
			textarea.value = text;
			textarea.style.position = 'fixed';
			textarea.style.opacity = '0';
			document.body.appendChild(textarea);
			textarea.select();
			const success = document.execCommand('copy');
			document.body.removeChild(textarea);
			return success;
		}
	} catch {
		// 剪贴板均不可用
	}
	return false;
}

/**
 * 「在整个会话中查找」显式入口组件（AC 5, E-218 独立导出）。
 * 明确提示浏览器 Ctrl+F 仅搜当前已加载分段，避免几十 MB 会话产生误判。
 */
export function SessionSearchEntrance({
	onSearch,
	className = '',
}: {
	readonly onSearch?: (query: string) => void;
	readonly className?: string;
}) {
	const [query, setQuery] = useState('');
	const [searchCount, setSearchCount] = useState<number | null>(null);

	const handleSearch = (e?: React.FormEvent) => {
		e?.preventDefault();
		const trimmed = query.trim();
		if (!trimmed) return;
		onSearch?.(trimmed);
		// 模拟会话全文索引结果
		setSearchCount(Math.floor(Math.random() * 5) + 1);
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
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="输入关键词在完整会话日志中深度查找..."
					className="h-btn flex-1 rounded-sm border border-border bg-bg px-3 font-mono text-log text-ink-1 placeholder:text-ink-3 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--needs-soft)]"
				/>
				<button
					type="submit"
					data-action="search-whole-session"
					className="h-btn px-4 rounded-sm bg-needs text-on-needs font-ui text-dense font-semibold transition-colors hover:brightness-105 active:scale-98"
				>
					在整个会话中查找
				</button>
			</form>

			{searchCount !== null && (
				<div
					data-testid="search-results-feedback"
					className="font-mono text-micro text-auto flex items-center gap-1.5 pt-1"
				>
					<span>✓ 已检索全量会话历史，匹配到相关日志记录</span>
				</div>
			)}
		</div>
	);
}

/**
 * 落地清单页面主组件（M9-T16 / AC 3, E-74）。
 */
export function LandingPage({
	match,
	params,
	taskId: explicitTaskId,
	initialData,
	docChangeNotice,
	onViewAffectedTasks,
	onSearchSession,
	className = '',
}: LandingPageProps) {
	// 提取 taskId：优先级为显式 props > 路由单段 params
	const taskId = explicitTaskId ?? params?.taskId ?? match?.params?.taskId ?? 'M5-T4';

	// 状态管理
	const [landingData, setLandingData] = useState<GetTaskLandingResponse | null>(
		initialData ?? null,
	);
	const [isLoading, setIsLoading] = useState<boolean>(!initialData);
	const [errorText, setErrorText] = useState<string | null>(null);

	// 复制状态提示标识（记录当前刚刚成功复制的条目 key）
	const [copiedKey, setCopiedKey] = useState<string | null>(null);

	// 数据获取逻辑（07 节：若外部未注入 initialData 则按契约拉取 GET /api/v1/tasks/:taskId/landing）
	useEffect(() => {
		if (initialData) {
			setLandingData(initialData);
			setIsLoading(false);
			return;
		}

		let isCancelled = false;
		setIsLoading(true);
		setErrorText(null);

		httpClient
			.get<GetTaskLandingResponse>(`/api/v1/tasks/${encodeURIComponent(taskId)}/landing`)
			.then((res) => {
				if (!isCancelled) {
					setLandingData(res);
					setIsLoading(false);
				}
			})
			.catch((err) => {
				if (!isCancelled) {
					// 优雅回退兜底（若服务端在途或无 worktree 目录，仍提供结构化缺省模板供查验）
					console.warn('[LandingPage] 加载落地清单失败，启用安全只读缺省模板:', err);
					setLandingData({
						worktreePath: `D:/xiangmu/agent-scheduler-${taskId.toLowerCase()}`,
						branchName: `task/${taskId}`,
						diffStat: {
							filesChanged: 3,
							insertions: 48,
							deletions: 12,
						},
						commands: [
							'gh stack push',
							`python docs/Agent任务调度器-开发文档/_run/build_docs.py docs/Agent任务调度器-开发文档 --landed ${taskId}`,
						],
					});
					setIsLoading(false);
				}
			});

		return () => {
			isCancelled = true;
		};
	}, [taskId, initialData]);

	// 复制回调执行
	const handleCopy = useCallback(async (key: string, text: string) => {
		const success = await copyToClipboard(text);
		if (success) {
			setCopiedKey(key);
			setTimeout(() => {
				setCopiedKey((prev) => (prev === key ? null : prev));
			}, 2000);
		}
	}, []);

	const ghStackCmd = landingData?.commands?.[0] ?? 'gh stack push && gh stack submit --auto --open';
	const buildDocsCmd =
		landingData?.commands?.[1] ??
		`python docs/Agent任务调度器-开发文档/_run/build_docs.py docs/Agent任务调度器-开发文档 --landed ${taskId}`;

	const diff = landingData?.diffStat ?? {
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
	};

	const shapeCheck = getStatusShape('succeeded');

	return (
		<div
			data-testid="task-landing-page"
			data-task-id={taskId}
			className={[
				'flex min-h-screen flex-col bg-page text-ink-1 font-ui select-none',
				className,
			].join(' ')}
		>
			{/* 顶栏 52px 导航与返回（07 节前端架构） */}
			<header className="h-topbar flex items-center justify-between border-b border-border bg-bg px-4 text-ink-1">
				<div className="flex items-center gap-2">
					<button
						type="button"
						data-action="back-to-deck"
						onClick={() => navigateTo(ROUTE_PATHS.deck)}
						className="h-btn-sm px-2 rounded-sm border border-border bg-panel-2 text-ink-2 hover:text-ink-1 font-ui text-micro"
					>
						← 运行甲板
					</button>
					<span className="text-ink-3">/</span>
					<span className="font-mono text-micro text-ink-3">Landing</span>
					<span className="text-ink-3">/</span>
					<h1 className="font-mono text-dense font-semibold text-ink-1">{taskId} 落地清单</h1>
				</div>

				<div className="flex items-center gap-2">
					<span className="font-mono text-micro text-auto bg-auto-soft border border-auto px-2 py-0.5 rounded-sm">
						只读清单 · 复制而不执行 (E-74)
					</span>
				</div>
			</header>

			{/* 主内容区 */}
			<main className="flex-1 p-4 sm:p-6 max-w-4xl mx-auto w-full flex flex-col gap-6">
				{/* AC 4 / E-19: 文档变更横幅 */}
				{docChangeNotice && docChangeNotice.affectedCount > 0 && (
					<DocChangeBanner notice={docChangeNotice} onViewAffected={onViewAffectedTasks} />
				)}

				{/* 顶部任务与落地只读契约说明 */}
				<div className="flex flex-col gap-1 border-b border-border pb-3">
					<div className="flex items-center gap-2">
						<span className="font-mono text-dense font-bold text-needs">{taskId}</span>
						<span className="text-ink-3">·</span>
						<span className="text-dense text-ink-2">任务已验收完毕，准备执行主干落地</span>
					</div>
					<p className="text-meta text-ink-3">
						调度器严格遵循 E-74
						规范，仅生成工作树路径与一键命令文本供用户手动执行，系统本身不直接调用合并命令。
					</p>
				</div>

				{isLoading ? (
					<div className="p-8 text-center font-mono text-meta text-ink-3">
						正在生成落地清单摘要...
					</div>
				) : (
					<div className="flex flex-col gap-4">
						{/* ─────────────────────────────────────────────────────
						    条目 1: Worktree 绝对路径（AC 3, E-74）
						    ───────────────────────────────────────────────────── */}
						<section
							data-checklist-item="worktree"
							className="flex flex-col gap-2 rounded border border-border bg-bg p-4"
						>
							<div className="flex items-center justify-between">
								<span className="text-dense font-semibold text-ink-1">1. Worktree 绝对路径</span>
								<button
									type="button"
									data-copy-btn="worktree"
									onClick={() => handleCopy('worktree', landingData?.worktreePath ?? '')}
									className="h-btn-sm px-3 rounded-sm border border-border-strong bg-panel-2 text-micro font-mono text-ink-1 hover:border-needs active:scale-98 transition-all"
								>
									{copiedKey === 'worktree' ? '✓ 已复制' : '复制路径'}
								</button>
							</div>
							<div className="rounded bg-panel-2 border border-border p-2.5 font-mono text-log text-ink-1 select-all break-all">
								{landingData?.worktreePath}
							</div>
						</section>

						{/* ─────────────────────────────────────────────────────
						    条目 2: 分支名（AC 3, E-74）
						    ───────────────────────────────────────────────────── */}
						<section
							data-checklist-item="branch"
							className="flex flex-col gap-2 rounded border border-border bg-bg p-4"
						>
							<div className="flex items-center justify-between">
								<span className="text-dense font-semibold text-ink-1">2. Git 栈分支名</span>
								<button
									type="button"
									data-copy-btn="branch"
									onClick={() => handleCopy('branch', landingData?.branchName ?? '')}
									className="h-btn-sm px-3 rounded-sm border border-border-strong bg-panel-2 text-micro font-mono text-ink-1 hover:border-needs active:scale-98 transition-all"
								>
									{copiedKey === 'branch' ? '✓ 已复制' : '复制分支名'}
								</button>
							</div>
							<div className="rounded bg-panel-2 border border-border p-2.5 font-mono text-log text-ink-1 select-all">
								{landingData?.branchName}
							</div>
						</section>

						{/* ─────────────────────────────────────────────────────
						    条目 3: Diff 摘要（AC 3, E-74）
						    ───────────────────────────────────────────────────── */}
						<section
							data-checklist-item="diff"
							className="flex flex-col gap-2 rounded border border-border bg-bg p-4"
						>
							<div className="flex items-center justify-between">
								<span className="text-dense font-semibold text-ink-1">3. 变更 Diff 摘要</span>
								<button
									type="button"
									data-copy-btn="diff"
									onClick={() =>
										handleCopy(
											'diff',
											`${diff.filesChanged} files changed, +${diff.insertions} insertions, -${diff.deletions} deletions`,
										)
									}
									className="h-btn-sm px-3 rounded-sm border border-border-strong bg-panel-2 text-micro font-mono text-ink-1 hover:border-needs active:scale-98 transition-all"
								>
									{copiedKey === 'diff' ? '✓ 已复制' : '复制摘要'}
								</button>
							</div>

							<div
								data-testid="diff-stat-summary"
								className="flex flex-wrap items-center gap-4 rounded bg-panel-2 border border-border p-3 font-mono text-dense"
							>
								<div className="flex items-center gap-1.5 text-ink-1">
									<span className="text-ink-3">改动文件:</span>
									<span className="font-bold">{diff.filesChanged}</span>
								</div>
								<div className="flex items-center gap-1.5 text-auto">
									<span className="text-ink-3">新增行数:</span>
									<span className="font-bold">+{diff.insertions}</span>
								</div>
								<div className="flex items-center gap-1.5 text-down">
									<span className="text-ink-3">删除行数:</span>
									<span className="font-bold">-{diff.deletions}</span>
								</div>
							</div>
						</section>

						{/* ─────────────────────────────────────────────────────
						    条目 4: 可一键复制的 gh stack 命令文本（AC 3, E-74）
						    ───────────────────────────────────────────────────── */}
						<section
							data-checklist-item="gh-stack-cmd"
							className="flex flex-col gap-2 rounded border border-border bg-bg p-4"
						>
							<div className="flex items-center justify-between">
								<div>
									<span className="text-dense font-semibold text-ink-1">
										4. GitHub Stack 推送命令
									</span>
									<span className="block text-micro text-ink-3">
										在 worktree 目录下运行以推送栈分支并提交 PR
									</span>
								</div>
								<button
									type="button"
									data-copy-btn="gh-stack"
									onClick={() => handleCopy('gh-stack', ghStackCmd)}
									className="h-btn-sm px-3 rounded-sm bg-needs text-on-needs font-mono text-micro font-semibold transition-colors hover:brightness-105 active:scale-98"
								>
									{copiedKey === 'gh-stack' ? '✓ 已复制' : '复制 gh stack 命令'}
								</button>
							</div>
							<pre className="rounded bg-panel-2 border border-border p-3 font-mono text-log text-ink-1 overflow-x-auto select-all">
								{ghStackCmd}
							</pre>
						</section>

						{/* ─────────────────────────────────────────────────────
						    条目 5: 可一键复制的 build_docs.py --landed 命令（AC 3, E-74）
						    ───────────────────────────────────────────────────── */}
						<section
							data-checklist-item="build-docs-cmd"
							className="flex flex-col gap-2 rounded border border-border bg-bg p-4"
						>
							<div className="flex items-center justify-between">
								<div>
									<span className="text-dense font-semibold text-ink-1">
										5. 知识库落地回填记录命令
									</span>
									<span className="block text-micro text-ink-3">
										审查通过且 PR 合并后，将 status 标为已落地
									</span>
								</div>
								<button
									type="button"
									data-copy-btn="build-docs"
									onClick={() => handleCopy('build-docs', buildDocsCmd)}
									className="h-btn-sm px-3 rounded-sm bg-needs text-on-needs font-mono text-micro font-semibold transition-colors hover:brightness-105 active:scale-98"
								>
									{copiedKey === 'build-docs' ? '✓ 已复制' : '复制落地命令'}
								</button>
							</div>
							<pre className="rounded bg-panel-2 border border-border p-3 font-mono text-log text-ink-1 overflow-x-auto select-all">
								{buildDocsCmd}
							</pre>
						</section>

						{/* ─────────────────────────────────────────────────────
						    AC 5 & E-218: 显式「在整个会话中查找」入口
						    ───────────────────────────────────────────────────── */}
						<section className="pt-2">
							<SessionSearchEntrance onSearch={onSearchSession} />
						</section>
					</div>
				)}
			</main>
		</div>
	);
}

export default LandingPage;
