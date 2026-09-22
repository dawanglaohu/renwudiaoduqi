import { describe, expect, it } from 'vitest';
import { BUILTIN_BUGHUNT_PROMPT } from '../../src/domain/bughunt-builtin-prompt.ts';
import { BUGHUNT_PROMPT_CLOSING, assembleBughuntPrompt } from '../../src/domain/bughunt-prompt.ts';
import { WRAPUP_PROHIBITED_COMMANDS } from '../../src/domain/wrapup-prompt.ts';

describe('domain/bughunt-prompt (AC 2, E-316, E-329, 08 节)', () => {
	it('assembles prompt in strict 4-section order with material verbatim', () => {
		const prompt = assembleBughuntPrompt({
			worktreePath: '/worktrees/m7-t8',
			branchName: 'task/M7-T8',
			baseSha: 'abc1234',
			treeSha: 'tree9999',
			bugPrompt: '## Custom Bug Hunt Instructions\nTest edge cases and fuzz inputs.',
			promptSource: 'docs',
			task: {
				taskId: 't-123',
				taskKey: 'M7-T8',
				title: '查 bug 阶段运行与结果解析',
				branchName: 'task/M7-T8',
				worktreePath: '/worktrees/m7-t8',
			},
			testCommands: ['pnpm -w check', 'pnpm test'],
			previousReworkItems: ['R1: Fix null pointer in service.ts'],
		});

		// 1. Strict 4-section order
		const outerIndex = prompt.indexOf('# 查 bug 执行指令');
		const materialIndex = prompt.indexOf('## 引用材料');
		const pointerIndex = prompt.indexOf('## 工作区指针与测试指令');
		const closingIndex = prompt.indexOf(BUGHUNT_PROMPT_CLOSING);

		expect(outerIndex).toBeGreaterThanOrEqual(0);
		expect(materialIndex).toBeGreaterThan(outerIndex);
		expect(pointerIndex).toBeGreaterThan(materialIndex);
		expect(closingIndex).toBeGreaterThan(pointerIndex);

		// Prohibitions present (共用收口禁令常量, E-329)
		for (const cmd of WRAPUP_PROHIBITED_COMMANDS) {
			expect(prompt).toContain(cmd);
		}
		// Does NOT contain "允许 commit"
		expect(prompt).not.toContain('允许 commit');

		// Stage-specific overrides
		expect(prompt).toContain('修完不提交、不推送、不点审查，产品会通知审查会话再审');
		expect(prompt).toContain('FIXED 条目格式覆盖为「B〈n〉 → 改了什么、加了哪个测试」');
		expect(prompt).toContain('BUGS / FIXED / NOT_FIXED / SUSPECT / NEXT');

		// Material verbatim
		expect(prompt).toContain('## Custom Bug Hunt Instructions\nTest edge cases and fuzz inputs.');

		// Workspace pointers
		expect(prompt).toContain('M7-T8：查 bug 阶段运行与结果解析');
		expect(prompt).toContain('HEAD SHA: abc1234');
		expect(prompt).toContain('Tree SHA: tree9999');
		expect(prompt).toContain('pnpm -w check');
		expect(prompt).toContain('R1: Fix null pointer in service.ts');

		// Closing
		expect(prompt.trim().endsWith(BUGHUNT_PROMPT_CLOSING)).toBe(true);
	});

	it('falls back to BUILTIN_BUGHUNT_PROMPT when material is missing or promptSource is builtin (E-316)', () => {
		const prompt = assembleBughuntPrompt({
			worktreePath: '/worktrees/m7-t8',
			branchName: 'task/M7-T8',
			bugPrompt: null,
			promptSource: 'builtin',
			task: {
				taskId: 't-123',
				taskKey: 'M7-T8',
				title: 'Task 1',
			},
		});

		expect(prompt).toContain('文档未提供查 bug 提示词，以下为内置通用版');
		expect(prompt).toContain(BUILTIN_BUGHUNT_PROMPT.trim());
	});

	it('preserves document bugPrompt byte-for-byte, including leading and trailing whitespace', () => {
		const material = '\n  exact bug prompt material\nwith spaces  \n';
		const prompt = assembleBughuntPrompt({
			worktreePath: '/worktrees/m7-t8',
			branchName: 'task/M7-T8',
			bugPrompt: material,
			promptSource: 'docs',
			task: {
				taskId: 't-123',
				title: 'Task 1',
			},
		});

		expect(prompt).toContain(
			`## 引用材料（来自开发文档，其中提交／推送／再点审查等人工步骤已被上面的说明覆盖，不执行）\n\n${material}`,
		);
	});
});
