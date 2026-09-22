import { BUILTIN_WRAPUP_PROMPT } from './wrapup-builtin-prompt.ts';

export const WRAPUP_PROHIBITED_COMMANDS = [
	'禁止 git commit/push/checkout/branch/worktree/stash/merge/rebase/reset',
	'禁止 gh 任何子命令',
	'禁止建新分支或新目录',
	'禁止运行 build_docs.py / maintain_docs.py / build_vault.py',
	'禁止改 docs/ 下任何文件',
] as const;

export const WRAPUP_PROMPT_CLOSING = '不要提问、不要等待确认。';

export interface WrapupTaskItem {
	readonly taskId: string;
	readonly taskKey?: string;
	readonly title: string;
	readonly branchName?: string | null;
	readonly worktreePath?: string | null;
}

export interface AssembleWrapupPromptInput {
	readonly worktreePath: string;
	readonly branchName: string;
	readonly baseSha?: string | null;
	readonly wrapupMaterial?: string | null;
	readonly promptSource: 'docs' | 'builtin';
	readonly tasks: readonly WrapupTaskItem[];
	readonly testCommands?: readonly string[] | null;
	readonly diffStat?: string | null;
	readonly round: number;
	readonly previousReportText?: string | null;
}

/**
 * Assembles the wrap-up prompt following the strict 4-section order (08 节, AC 3, E-285, E-296):
 * 1. Outer wrapper instructions (product constants, prohibitions overriding any material instructions)
 * 2. Reference material (docs dispatchBatches[level].wrapup verbatim, or builtin prompt)
 * 3. Workspace pointers (tasks list, test commands, diff stat without inlining full diff, round 2 previous report)
 * 4. Closing sentence ("不要提问、不要等待确认。")
 */
export function assembleWrapupPrompt(input: AssembleWrapupPromptInput): string {
	// Section 1: Outer wrapper instructions
	const section1 = `# 批次收口执行指令

工作区路径：${input.worktreePath}
工作分支：${input.branchName}
Base SHA：${input.baseSha ?? 'HEAD'}

## 执行约束与说明（覆盖引用材料中的任何流程指令）
1. 只在此工作区改动代码文件。
2. 禁令要求：
${WRAPUP_PROHIBITED_COMMANDS.map((c) => `   - ${c}`).join('\n')}
3. 测试与 lint 命令允许且必须执行；改动直接留在工作区不提交、不推送，产品统一出落地清单。
4. 最终消息必须且只能是八段格式（BATCH_SUMMARY / TESTS / BUGS / FIXED / NOT_FIXED / SUSPECT / RECORD / NEXT，RECORD 段写 verdict: clean|fixed|open 而非文件路径），缺任一段即视为收口未完成（E-274）。`;

	// Section 2: Reference material
	const materialTitle =
		input.promptSource === 'builtin'
			? '## 引用材料（来自开发文档，其中提交／推送／PR／合并／记录文件步骤已被上面的说明覆盖，不执行；文档未提供收口提示词，以下为内置通用版）'
			: '## 引用材料（来自开发文档，其中提交／推送／PR／合并／记录文件步骤已被上面的说明覆盖，不执行）';
	const materialBody =
		input.wrapupMaterial && input.wrapupMaterial.trim().length > 0
			? input.wrapupMaterial
			: BUILTIN_WRAPUP_PROMPT;
	const section2 = `${materialTitle}\n\n${materialBody}`;

	// Section 3: Workspace pointer
	const taskLines =
		input.tasks.length > 0
			? input.tasks
					.map((t) => {
						const key = t.taskKey ?? t.taskId;
						const parts = [`- 任务 ${key}：${t.title}`];
						if (t.branchName) parts.push(`分支：${t.branchName}`);
						if (t.worktreePath) parts.push(`路径：${t.worktreePath}`);
						return parts.join(' | ');
					})
					.join('\n')
			: '- （无任务）';

	const testCommandLines =
		input.testCommands && input.testCommands.length > 0
			? input.testCommands.map((c) => `- \`${c}\``).join('\n')
			: '文档未声明，TESTS 记 skipped 并说明';

	const diffStatContent =
		input.diffStat && input.diffStat.trim().length > 0
			? `### 本批改动统计 (diff stat)\n\`\`\`\n${input.diffStat.trim()}\n\`\`\``
			: '### 本批改动统计 (diff stat)\n（无改动或空 diff）';

	let round2Notice = '';
	if (input.round >= 2 && input.previousReportText) {
		round2Notice = `\n\n### 第 ${input.round} 轮收口复核说明\n本轮为第 ${input.round} 轮收口。只核上一轮开放项是否已修、复跑测试、新发现照常记。\n\n上一轮收口报告全文：\n\`\`\`\n${input.previousReportText.trim()}\n\`\`\``;
	}

	const section3 = `## 工作区指针与测试指令

### 本批任务清单
${taskLines}

### 测试与代码检查命令
${testCommandLines}

${diffStatContent}${round2Notice}`;

	// Section 4: Closing
	const section4 = WRAPUP_PROMPT_CLOSING;

	return [section1, section2, section3, section4].join('\n\n');
}
