import { BUILTIN_BUGHUNT_PROMPT, type BughuntPromptSource } from './bughunt-builtin-prompt.ts';
import { WRAPUP_PROHIBITED_COMMANDS } from './wrapup-prompt.ts';

export const BUGHUNT_PROMPT_CLOSING = '不要提问、不要等待确认。';

export interface BughuntTaskItem {
	readonly taskId: string;
	readonly taskKey?: string;
	readonly title: string;
	readonly branchName?: string | null;
	readonly worktreePath?: string | null;
}

export interface AssembleBughuntPromptInput {
	readonly worktreePath: string;
	readonly branchName: string;
	readonly baseSha?: string | null;
	readonly treeSha?: string | null;
	readonly bugPrompt?: string | null;
	readonly promptSource: BughuntPromptSource;
	readonly task: BughuntTaskItem;
	readonly testCommands?: readonly string[] | null;
	readonly previousReworkItems?: readonly string[] | null;
}

/**
 * 组装查 bug 提示词（AC 2, E-316, E-329, 08 节）。
 *
 * 严格四段顺序自包含组装：
 * 1. 外层包装说明（产品常量，覆盖引用材料中的人工指令，共用收口禁令常量，阶段专属覆盖，不含「允许 commit」）
 * 2. 引用材料（来自开发文档派发快照的 bugPrompt 逐字，或内置通用版）
 * 3. 工作区指针（任务信息、起点树基线、上一轮 R 条目、测试命令）
 * 4. 结束语（"不要提问、不要等待确认。"）
 */
export function assembleBughuntPrompt(input: AssembleBughuntPromptInput): string {
	// Section 1: Outer wrapper instructions
	const section1 = `# 查 bug 执行指令

工作区路径：${input.worktreePath}
工作分支：${input.branchName}
Base SHA：${input.baseSha ?? 'HEAD'}
起点树 SHA：${input.treeSha ?? input.baseSha ?? 'HEAD'}

## 执行约束与说明（覆盖引用材料中的任何流程指令）
1. 只在此工作区改动代码文件，与被审实施运行同一工作树。
2. 禁令要求：
${WRAPUP_PROHIBITED_COMMANDS.map((c) => `   - ${c}`).join('\n')}
3. 阶段专属覆盖：
   - 修完不提交、不推送、不点审查，产品会通知审查会话再审。
   - FIXED 条目格式覆盖为「B〈n〉 → 改了什么、加了哪个测试」。
4. 测试与 lint 命令允许执行。
5. 最终消息必须且只能是五段格式（BUGS / FIXED / NOT_FIXED / SUSPECT / NEXT，条目格式沿用收口的 B〈n〉 [S1|S2|S3] … 文件:行，FIXED 条目覆盖为「B〈n〉 → 改了什么、加了哪个测试」），缺任一段即视为查 bug 未完成（E-320）。`;

	// Section 2: Reference material
	const materialTitle =
		input.promptSource === 'builtin'
			? '## 引用材料（来自开发文档，其中提交／推送／再点审查等人工步骤已被上面的说明覆盖，不执行；文档未提供查 bug 提示词，以下为内置通用版）'
			: '## 引用材料（来自开发文档，其中提交／推送／再点审查等人工步骤已被上面的说明覆盖，不执行）';

	const materialBody =
		input.bugPrompt && input.bugPrompt.trim().length > 0 ? input.bugPrompt : BUILTIN_BUGHUNT_PROMPT;

	const section2 = `${materialTitle}\n\n${materialBody}`;

	// Section 3: Workspace pointer
	const taskKey = input.task.taskKey ?? input.task.taskId;
	const taskLine = `- 任务 ${taskKey}：${input.task.title} | 分支：${input.task.branchName ?? input.branchName} | 路径：${input.task.worktreePath ?? input.worktreePath}`;

	const baselineInfo = `### 起点树基线
HEAD SHA: ${input.baseSha ?? 'HEAD'}
Tree SHA: ${input.treeSha ?? input.baseSha ?? 'HEAD'}`;

	const testCommandLines =
		input.testCommands && input.testCommands.length > 0
			? input.testCommands.map((c) => `- \`${c}\``).join('\n')
			: '文档未声明，测试段记 skipped 并说明';

	let previousReworkNotice = '';
	if (input.previousReworkItems && input.previousReworkItems.length > 0) {
		previousReworkNotice = `\n\n### 审查 pass 轮次的 R 条目\n${input.previousReworkItems.map((item) => `- ${item}`).join('\n')}`;
	}

	const section3 = `## 工作区指针与测试指令

### 目标任务
${taskLine}

${baselineInfo}

### 测试与代码检查命令
${testCommandLines}${previousReworkNotice}`;

	// Section 4: Closing
	const section4 = BUGHUNT_PROMPT_CLOSING;

	return [section1, section2, section3, section4].join('\n\n');
}
