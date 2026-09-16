/**
 * packages/web/src/features/landing/landing-container.tsx
 *
 * 落地清单容器组件（M9-T16 / 07 节前端架构）
 *
 * 规范依据（07 节前端架构与 R1 / R2）：
 * - features 层承担数据获取与展示拼装
 * - 失败渲染就地 inline notice（带 requestId + 技术详情复制），无数据字段显示「—」
 * - 严禁伪造 mock 数据或缺省命令
 * - 复制而不执行，提供单项复制按钮
 */

import { useCallback, useState } from 'react';
import type { GetTaskLandingResponse } from '../../../../shared/src/api/tasks.ts';
import { DocChangeBanner, type DocChangeNotice } from '../../components/empty-onboarding.tsx';
import { InlineNotice } from '../../components/inline-notice.tsx';
import { type LandingFetcher, type UseLandingResult, useLanding } from './use-landing.ts';

export interface LandingContainerProps {
	/** 任务编号 */
	readonly taskId?: string;
	/** 预填数据（单测或静态装配） */
	readonly initialData?: GetTaskLandingResponse;
	/** 初始错误状态（单测用） */
	readonly initialError?: Error | null;
	/** 初始请求标识（单测用） */
	readonly initialRequestId?: string;
	/** 文档变更通知 */
	readonly docChangeNotice?: DocChangeNotice | null;
	/** 查看受影响任务回调 */
	readonly onViewAffectedTasks?: (taskIds: readonly string[]) => void;
	/** 可注入的 fetcher（单测用） */
	readonly fetcher?: LandingFetcher;
	/** 状态回调（供容器测试捕获 hook 实例与触发状态验证） */
	readonly onResult?: (result: UseLandingResult) => void;
	/** 容器自定义 class */
	readonly className?: string;
}

export async function copyToClipboard(text: string): Promise<boolean> {
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
		// 回落至传统复制模式
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

export function LandingContainer({
	taskId,
	initialData,
	initialError,
	initialRequestId,
	docChangeNotice,
	onViewAffectedTasks,
	fetcher,
	onResult,
	className = '',
}: LandingContainerProps) {
	const landingResult = useLanding({
		taskId,
		initialData,
		initialError,
		initialRequestId,
		fetcher,
	});
	onResult?.(landingResult);

	const { data, isLoading, error, requestId } = landingResult;

	const [copiedKey, setCopiedKey] = useState<string | null>(null);

	const handleCopy = useCallback(async (key: string, text: string) => {
		if (!text || text === '—') return;
		const success = await copyToClipboard(text);
		if (success) {
			setCopiedKey(key);
			setTimeout(() => {
				setCopiedKey((prev) => (prev === key ? null : prev));
			}, 2000);
		}
	}, []);

	const worktreePath = data?.worktreePath ?? '—';
	const branchName = data?.branchName ?? '—';
	const ghStackCmd = data?.commands?.[0] ?? '—';
	const buildDocsCmd = data?.commands?.[1] ?? '—';

	const diffFiles = data?.diffStat !== undefined ? String(data.diffStat.filesChanged) : '—';
	const diffInsertions = data?.diffStat !== undefined ? `+${data.diffStat.insertions}` : '—';
	const diffDeletions = data?.diffStat !== undefined ? `-${data.diffStat.deletions}` : '—';

	return (
		<div className={['flex flex-col gap-6', className].join(' ')}>
			{/* AC 4 / E-19: 文档变更横幅 */}
			{docChangeNotice && docChangeNotice.affectedCount > 0 && (
				<DocChangeBanner notice={docChangeNotice} onViewAffected={onViewAffectedTasks} />
			)}

			{/* 顶部任务与落地只读契约说明 */}
			<div className="flex flex-col gap-1 border-b border-border pb-3">
				<div className="flex items-center gap-2">
					<span className="font-mono text-dense font-bold text-needs">{taskId ?? '—'}</span>
					<span className="text-ink-3">·</span>
					<span className="text-dense text-ink-2">任务已验收完毕，准备执行主干落地</span>
				</div>
				<p className="text-meta text-ink-3">
					调度器严格遵循 E-74
					规范，仅生成工作树路径与一键命令文本供用户手动执行，系统本身不直接调用合并命令。
				</p>
			</div>

			{/* 失败路径就地 inline notice（带 requestId + 技术详情复制，R2） */}
			{error && (
				<div data-testid="landing-inline-error" className="flex flex-col gap-2">
					<InlineNotice
						tone="down"
						message="加载落地清单失败，请检查网络或服务端工作树状态"
						technical={`requestId: ${requestId ?? 'unknown'}\n${error.message}`}
						testId="landing-error-notice"
					/>
					<div className="flex items-center justify-between text-micro font-mono text-ink-3 px-1">
						<span>requestId: {requestId ?? 'unknown'}</span>
						<button
							type="button"
							data-action="copy-error-tech-details"
							onClick={() =>
								handleCopy('tech-details', `requestId: ${requestId ?? 'unknown'}\n${error.message}`)
							}
							className="h-btn-sm px-2 rounded-sm border border-border bg-panel-2 text-ink-2 hover:text-ink-1"
						>
							{copiedKey === 'tech-details' ? '✓ 已复制技术详情' : '复制技术详情'}
						</button>
					</div>
				</div>
			)}

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
								disabled={worktreePath === '—'}
								onClick={() => handleCopy('worktree', worktreePath)}
								className="h-btn-sm px-3 rounded-sm border border-border-strong bg-panel-2 text-micro font-mono text-ink-1 hover:border-needs active:scale-98 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{copiedKey === 'worktree' ? '✓ 已复制' : '复制路径'}
							</button>
						</div>
						<div className="rounded bg-panel-2 border border-border p-2.5 font-mono text-log text-ink-1 select-all break-all">
							{worktreePath}
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
								disabled={branchName === '—'}
								onClick={() => handleCopy('branch', branchName)}
								className="h-btn-sm px-3 rounded-sm border border-border-strong bg-panel-2 text-micro font-mono text-ink-1 hover:border-needs active:scale-98 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{copiedKey === 'branch' ? '✓ 已复制' : '复制分支名'}
							</button>
						</div>
						<div className="rounded bg-panel-2 border border-border p-2.5 font-mono text-log text-ink-1 select-all">
							{branchName}
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
								disabled={data?.diffStat === undefined}
								onClick={() =>
									handleCopy(
										'diff',
										`${diffFiles} files changed, ${diffInsertions} insertions, ${diffDeletions} deletions`,
									)
								}
								className="h-btn-sm px-3 rounded-sm border border-border-strong bg-panel-2 text-micro font-mono text-ink-1 hover:border-needs active:scale-98 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
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
								<span className="font-bold">{diffFiles}</span>
							</div>
							<div className="flex items-center gap-1.5 text-auto">
								<span className="text-ink-3">新增行数:</span>
								<span className="font-bold">{diffInsertions}</span>
							</div>
							<div className="flex items-center gap-1.5 text-down">
								<span className="text-ink-3">删除行数:</span>
								<span className="font-bold">{diffDeletions}</span>
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
								disabled={ghStackCmd === '—'}
								onClick={() => handleCopy('gh-stack', ghStackCmd)}
								className="h-btn-sm px-3 rounded-sm bg-needs text-on-needs font-mono text-micro font-semibold transition-colors hover:brightness-105 active:scale-98 disabled:opacity-50 disabled:cursor-not-allowed"
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
								disabled={buildDocsCmd === '—'}
								onClick={() => handleCopy('build-docs', buildDocsCmd)}
								className="h-btn-sm px-3 rounded-sm bg-needs text-on-needs font-mono text-micro font-semibold transition-colors hover:brightness-105 active:scale-98 disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{copiedKey === 'build-docs' ? '✓ 已复制' : '复制落地命令'}
							</button>
						</div>
						<pre className="rounded bg-panel-2 border border-border p-3 font-mono text-log text-ink-1 overflow-x-auto select-all">
							{buildDocsCmd}
						</pre>
					</section>
				</div>
			)}
		</div>
	);
}
