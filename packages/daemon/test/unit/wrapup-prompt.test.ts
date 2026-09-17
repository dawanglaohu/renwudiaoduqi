import { describe, expect, it } from 'vitest';
import { BUILTIN_WRAPUP_PROMPT } from '../../src/domain/wrapup-builtin-prompt.ts';
import {
	WRAPUP_PROHIBITED_COMMANDS,
	WRAPUP_PROMPT_CLOSING,
	assembleWrapupPrompt,
} from '../../src/domain/wrapup-prompt.ts';

describe('domain/wrapup-prompt (AC 3, E-285, E-296)', () => {
	it('assembles prompt in strict 4-section order with material verbatim', () => {
		const prompt = assembleWrapupPrompt({
			worktreePath: '/worktrees/batch-1',
			branchName: 'wrapup/b1-r1',
			baseSha: 'abc1234',
			wrapupMaterial: '## Custom Doc Wrapup Prompt\nCheck everything carefully.',
			promptSource: 'docs',
			tasks: [
				{ taskId: 't1', taskKey: 'M1-T1', title: 'Task 1', branchName: 'task/m1-t1' },
				{ taskId: 't2', taskKey: 'M1-T2', title: 'Task 2', branchName: 'task/m1-t2' },
			],
			testCommands: ['pnpm -w check', 'pnpm test'],
			diffStat: ' 2 files changed, 10 insertions(+)',
			round: 1,
		});

		// 1. Outer wrapper is first (before material)
		const outerIndex = prompt.indexOf('# 批次收口执行指令');
		const materialIndex = prompt.indexOf('## 引用材料');
		const pointerIndex = prompt.indexOf('## 工作区指针与测试指令');
		const closingIndex = prompt.indexOf(WRAPUP_PROMPT_CLOSING);

		expect(outerIndex).toBeGreaterThanOrEqual(0);
		expect(materialIndex).toBeGreaterThan(outerIndex);
		expect(pointerIndex).toBeGreaterThan(materialIndex);
		expect(closingIndex).toBeGreaterThan(pointerIndex);

		// Prohibitions present
		for (const cmd of WRAPUP_PROHIBITED_COMMANDS) {
			expect(prompt).toContain(cmd);
		}

		// Material verbatim
		expect(prompt).toContain('## Custom Doc Wrapup Prompt\nCheck everything carefully.');

		// Pointers & diff stat
		expect(prompt).toContain('M1-T1：Task 1');
		expect(prompt).toContain('M1-T2：Task 2');
		expect(prompt).toContain('pnpm -w check');
		expect(prompt).toContain('2 files changed, 10 insertions(+)');

		// Closing
		expect(prompt.trim().endsWith(WRAPUP_PROMPT_CLOSING)).toBe(true);
	});

	it('falls back to BUILTIN_WRAPUP_PROMPT when material is missing or promptSource is builtin (E-296)', () => {
		const prompt = assembleWrapupPrompt({
			worktreePath: '/worktrees/batch-1',
			branchName: 'wrapup/b1-r1',
			wrapupMaterial: null,
			promptSource: 'builtin',
			tasks: [],
			round: 1,
		});

		expect(prompt).toContain('文档未提供收口提示词，以下为内置通用版');
		expect(prompt).toContain(BUILTIN_WRAPUP_PROMPT.trim());
	});

	it('preserves document wrapup material byte-for-byte, including leading and trailing whitespace', () => {
		const material = '\n  exact material\nwith trailing spaces  \n';
		const prompt = assembleWrapupPrompt({
			worktreePath: '/worktrees/batch-1',
			branchName: 'wrapup/b1-r1',
			wrapupMaterial: material,
			promptSource: 'docs',
			tasks: [],
			round: 1,
		});

		expect(prompt).toContain(
			`## 引用材料（来自开发文档，其中提交／推送／PR／合并／记录文件步骤已被上面的说明覆盖，不执行）\n\n${material}`,
		);
	});

	it('includes round 2 review notice and previous report in section 3 when round >= 2', () => {
		const prompt = assembleWrapupPrompt({
			worktreePath: '/worktrees/batch-1',
			branchName: 'wrapup/b1-r2',
			promptSource: 'docs',
			tasks: [{ taskId: 't1', title: 'Task 1' }],
			round: 2,
			previousReportText: 'BATCH_SUMMARY\nRound 1 summary\nRECORD\nverdict: open\nNEXT\nFix B1',
		});

		expect(prompt).toContain('### 第 2 轮收口复核说明');
		expect(prompt).toContain('只核上一轮开放项');
		expect(prompt).toContain('Round 1 summary');
	});
});
