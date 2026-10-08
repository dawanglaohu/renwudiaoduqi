import { useState } from 'react';
import type { OnboardingDocOption } from './empty-onboarding.tsx';
import { InlineNotice } from './inline-notice.tsx';

export interface ProjectDocumentControlsProps {
	readonly documents: readonly OnboardingDocOption[];
	readonly selectedDocId: string | null;
	readonly isSaving: boolean;
	readonly isTouch?: boolean;
	readonly error?: { readonly message: string; readonly technical: string } | null;
	readonly onSelectDoc: (docId: string) => void;
	readonly onImportDocument: (docsPath: string, repoPath?: string) => void;
	readonly onRebindDocument: (docsPath?: string, repoPath?: string) => void;
}

export function ProjectDocumentControls(props: ProjectDocumentControlsProps) {
	const [expanded, setExpanded] = useState(false);
	const [docsPath, setDocsPath] = useState('');
	const [repoPath, setRepoPath] = useState('');
	const controlHeight = props.isTouch ? 'h-[44px]' : 'h-btn';
	return (
		<section
			data-testid="project-document-controls"
			aria-label="项目文档"
			className="flex shrink-0 flex-col gap-2 border-b border-border bg-bg px-3 py-2"
		>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<label htmlFor="project-doc-select" className="text-meta text-ink-2">
					当前项目
				</label>
				<select
					id="project-doc-select"
					data-testid="project-doc-select"
					value={props.selectedDocId ?? ''}
					onChange={(event) => props.onSelectDoc(event.target.value)}
					disabled={props.isSaving || props.documents.length === 0}
					className={`${controlHeight} min-w-0 flex-1 rounded-sm border border-border bg-panel-2 px-2 text-meta text-ink-1`}
				>
					<option value="" disabled>
						请选择项目文档
					</option>
					{props.documents.map((document) => (
						<option key={document.id} value={document.id}>
							{document.title}
						</option>
					))}
				</select>
				<button
					type="button"
					data-action="manage-project-documents"
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
					className={`${controlHeight} shrink-0 rounded-sm border border-border px-3 text-meta text-ink-1`}
				>
					{expanded ? '收起导入' : '导入 / 更新'}
				</button>
			</div>
			{expanded && (
				<div className="flex min-w-0 flex-col gap-2">
					<input
						aria-label="导入文档路径"
						data-testid="project-import-doc-path"
						value={docsPath}
						onChange={(event) => setDocsPath(event.target.value)}
						placeholder="本机 docs-data.js 绝对路径"
						className={`${controlHeight} w-full min-w-0 rounded-sm border border-border bg-panel-2 px-2 text-meta text-ink-1`}
					/>
					<input
						aria-label="导入仓库目录"
						value={repoPath}
						onChange={(event) => setRepoPath(event.target.value)}
						placeholder="仓库绝对路径（留空自动识别）"
						className={`${controlHeight} w-full min-w-0 rounded-sm border border-border bg-panel-2 px-2 text-meta text-ink-1`}
					/>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							data-action="import-project-document"
							disabled={props.isSaving || !docsPath.trim()}
							onClick={() => props.onImportDocument(docsPath.trim(), repoPath.trim() || undefined)}
							className={`${controlHeight} rounded-sm bg-needs px-3 text-meta text-on-needs disabled:opacity-50`}
						>
							导入新项目
						</button>
						<button
							type="button"
							data-action="update-project-document"
							disabled={
								props.isSaving || !props.selectedDocId || (!docsPath.trim() && !repoPath.trim())
							}
							onClick={() =>
								props.onRebindDocument(docsPath.trim() || undefined, repoPath.trim() || undefined)
							}
							className={`${controlHeight} rounded-sm border border-border px-3 text-meta text-ink-1 disabled:opacity-50`}
						>
							更新当前项目
						</button>
					</div>
					{props.error && (
						<InlineNotice
							tone="down"
							message={props.error.message}
							technical={props.error.technical}
						/>
					)}
				</div>
			)}
		</section>
	);
}
