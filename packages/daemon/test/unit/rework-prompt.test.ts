import { describe, expect, it } from 'vitest';
import {
	BUILTIN_REWORK_RULES,
	REWORK_COMMIT_PUSH_CONSTRAINT,
	assembleReworkPrompt,
	extractReworkRules,
} from '../../src/domain/rework-prompt.ts';

describe('M7-T5 AC 2 & E-279: assembleReworkPrompt and extractReworkRules', () => {
	const sampleReworkText = `
### R1: 修复边界处理
在 packages/daemon/src/service/rework.ts:120 处理空字符串输入

### R2: 补充单测用例
在 packages/daemon/test/unit/rework.test.ts 补充 3 个用例
`.trim();

	it('extracts "## 收到返工指令时" section correctly from implPrompt', () => {
		const implPrompt = `
# 实现任务 M1-T1

一些说明...

## 收到返工指令时
只改指令列出的编号条目，不借机重构；
哪条不成立就在回报里写理由，不默默跳过；
改完新提交再 push；
在你原来的工作树里改（../agent-scheduler-m1-t1）。

## 本项目约定
一些全局约束...
`;

		const extracted = extractReworkRules(implPrompt);
		expect(extracted).not.toBeNull();
		expect(extracted).toContain('只改指令列出的编号条目');
		expect(extracted).toContain('在你原来的工作树里改（../agent-scheduler-m1-t1）');
		expect(extracted).not.toContain('## 本项目约定');
	});

	it('returns null when implPrompt does not have the section or is empty', () => {
		expect(extractReworkRules(null)).toBeNull();
		expect(extractReworkRules('')).toBeNull();
		expect(extractReworkRules('# Title only\nNo rework section')).toBeNull();
		expect(extractReworkRules('## 收到返工指令时\n\n## 下一节')).toBeNull();
	});

	it('assembles self-contained prompt with extracted rules (AC 2, E-279)', () => {
		const implPrompt = `
# Prompt
## 收到返工指令时
1. 自定义规则第一条
2. 自定义规则第二条
## 下一节
`;

		const result = assembleReworkPrompt({
			reworkText: sampleReworkText,
			implPrompt,
			worktreePath: 'D:/xiangmu/agent-scheduler-m7-t5',
			branchName: 'task/M7-T5',
			taskId: 'M7-T5',
		});

		// 1. 返工块原文
		expect(result).toContain(sampleReworkText);
		expect(result).toContain('## 返工要求');

		// 2. 快照提取段落
		expect(result).toContain('1. 自定义规则第一条');
		expect(result).toContain('2. 自定义规则第二条');
		expect(result).not.toContain(BUILTIN_REWORK_RULES);

		// 3. 工作区指针
		expect(result).toContain('D:/xiangmu/agent-scheduler-m7-t5');
		expect(result).toContain('task/M7-T5');
		expect(result).toContain('## 工作区指针');

		// 4. 「只改列出条目、不 commit/push」约束
		expect(result).toContain(REWORK_COMMIT_PUSH_CONSTRAINT);
		expect(result).toContain('只改列出条目、不 commit/push');
	});

	it('assembles self-contained prompt with built-in four rules fallback when section is missing (AC 2, E-279)', () => {
		const result = assembleReworkPrompt({
			reworkText: sampleReworkText,
			implPrompt: null,
			worktreePath: '/var/worktrees/task-1',
			branchName: 'task/M1-T1',
		});

		// 1. 返工块原文
		expect(result).toContain(sampleReworkText);

		// 2. 内置四句回落
		expect(result).toContain('只改指令列出的编号条目，不借机重构；');
		expect(result).toContain('哪条不成立就在回报里写理由，不默默跳过、也不照改你认为错的方案；');
		expect(result).toContain('回报按编号写改了哪个文件哪一行、加了什么测试。');
		// 08 节：内置四句 = 只改列出条目、不重构、哪条不成立写理由、不 commit/push——不能反过来要求推送
		expect(BUILTIN_REWORK_RULES).not.toMatch(/push|提交/);
		expect(result).toContain('在你原来的工作树里改，不要再开一个。');

		// 3. 工作区指针
		expect(result).toContain('/var/worktrees/task-1');
		expect(result).toContain('task/M1-T1');

		// 4. 「只改列出条目、不 commit/push」约束
		expect(result).toContain(REWORK_COMMIT_PUSH_CONSTRAINT);
	});
});
