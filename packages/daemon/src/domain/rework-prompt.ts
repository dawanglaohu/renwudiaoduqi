/**
 * 返工新会话提示词自包含组装（M7-T5 AC 2, E-279）。
 *
 * 核心规则：
 * 1. 提示词必须自包含：
 *    - 返工块原文（审查产出或人工打回意见）
 *    - 快照实施提示词里「收到返工指令时」段（取不到用内置四句）
 *    - 工作区指针（worktreePath、branchName 等）
 *    - 明确声明约束「只改列出条目、不 commit/push」
 * 2. 属于 domain 层纯函数，零外部 IO，顶层零副作用。
 */

/**
 * 快照实施提示词中未能提取到「收到返工指令时」段落时的内置兜底四句（AC 2, E-279）。
 */
export const BUILTIN_REWORK_RULES = [
	'只改指令列出的编号条目，不借机重构；',
	'哪条不成立就在回报里写理由，不默默跳过、也不照改你认为错的方案；',
	'改完新提交（不 amend、不 force）再 gh stack push；回报按编号写改了哪个文件哪一行、加了什么测试。',
	'在你原来的工作树里改，不要再开一个。',
].join('\n');

/**
 * 约束要求常量：只改列出条目、不 commit/push（AC 2, E-279）。
 */
export const REWORK_COMMIT_PUSH_CONSTRAINT = '只改列出条目、不 commit/push';

/**
 * 从实施提示词正文中提取「## 收到返工指令时」章节内容。
 * 若未包含该章节或内容为空，返回 null。
 */
export function extractReworkRules(implPrompt?: string | null): string | null {
	if (!implPrompt || typeof implPrompt !== 'string') {
		return null;
	}

	// 只匹配行内空白，不跨行吞换行
	const headerPattern = /(?:^|\r?\n)##[ \t]*收到返工指令时[ \t]*(?:\r?\n|$)/;
	const match = headerPattern.exec(implPrompt);
	if (!match) {
		return null;
	}

	const startIndex = match.index + match[0].length;
	const rest = implPrompt.slice(startIndex);

	// 查找下一个标题（可能紧接着在下一行，或者在若干行之后）
	const nextHeaderMatch = rest.match(/(?:^|\r?\n)#{1,6}[ \t]+/);
	const content = nextHeaderMatch ? rest.slice(0, nextHeaderMatch.index) : rest;
	const trimmed = content.trim();

	return trimmed.length > 0 ? trimmed : null;
}

/**
 * 组装自包含返工提示词入参。
 */
export interface AssembleReworkPromptInput {
	/**
	 * 返工块原文（审查产出或人工打回意见，必须包含）
	 */
	readonly reworkText: string;

	/**
	 * 被审运行派发快照里的实施提示词（用于提取「收到返工指令时」段）
	 */
	readonly implPrompt?: string | null;

	/**
	 * 工作区路径指针（必须非空）
	 */
	readonly worktreePath: string;

	/**
	 * 分支名（可选）
	 */
	readonly branchName?: string | null;

	/**
	 * 仓库路径（可选）
	 */
	readonly repoPath?: string | null;

	/**
	 * 任务 ID（可选）
	 */
	readonly taskId?: string | null;
}

/**
 * 组装新会话自包含提示词（AC 2, E-279）。
 *
 * 输出格式结构化自包含：
 * 1. 返工要求：返工块原文
 * 2. 收到返工指令时：提取规则或内置四句
 * 3. 工作区指针：工作区路径与分支
 * 4. 约束要求：只改列出条目、不 commit/push
 */
export function assembleReworkPrompt(input: AssembleReworkPromptInput): string {
	const rawRework = input.reworkText.trim();
	const rulesText = extractReworkRules(input.implPrompt) ?? BUILTIN_REWORK_RULES;

	const sections: string[] = [];

	// 标题
	const taskLabel = input.taskId ? `（任务 ${input.taskId}）` : '';
	sections.push(`# 任务返工指令${taskLabel}`);

	// 1. 返工块原文
	sections.push(`## 返工要求\n${rawRework}`);

	// 2. 收到返工指令时
	sections.push(`## 收到返工指令时\n${rulesText}`);

	// 3. 工作区指针
	const workspaceLines: string[] = [`- 工作区目录: ${input.worktreePath}`];
	if (input.branchName) {
		workspaceLines.push(`- 工作分支: ${input.branchName}`);
	}
	if (input.repoPath) {
		workspaceLines.push(`- 仓库路径: ${input.repoPath}`);
	}
	sections.push(`## 工作区指针\n${workspaceLines.join('\n')}`);

	// 4. 约束要求
	sections.push(`## 约束要求\n- ${REWORK_COMMIT_PUSH_CONSTRAINT}`);

	return `${sections.join('\n\n')}\n`;
}
