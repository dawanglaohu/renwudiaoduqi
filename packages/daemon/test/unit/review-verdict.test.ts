import { describe, expect, it } from 'vitest';
import {
	REVIEW_DOC_ISSUE_TAG,
	REVIEW_INCOMPLETE_TAG,
	REVIEW_PASSED_TAG,
	REVIEW_REWORK_TAG,
	UNSTRUCTURED_REWORK_TAG,
	evaluateReviewVerdict,
	extractDocIssueSection,
	extractLastReworkFence,
	extractLastVerdict,
	extractReworkSection,
	parseReviewVerdict,
	parseReworkItems,
} from '../../src/domain/review-verdict.ts';

describe('extractLastVerdict', () => {
	it('extracts the last VERDICT: line when multiple exist', () => {
		const text = `
Earlier discussion:
VERDICT: rework

After further inspection:
VERDICT: pass
`;
		const result = extractLastVerdict(text);
		expect(result.rawLine).toBe('VERDICT: pass');
		expect(result.rawValue).toBe('pass');
		expect(result.normalizedVerdict).toBe('pass');
	});

	it('handles case-insensitivity, markdown bold and header prefixes', () => {
		expect(extractLastVerdict('**VERDICT:** rework').normalizedVerdict).toBe('rework');
		expect(extractLastVerdict('## VERDICT: doc-issue').normalizedVerdict).toBe('doc_issue');
		expect(extractLastVerdict('verdict: PASS').normalizedVerdict).toBe('pass');
		expect(extractLastVerdict('VERDICT: DOC_ISSUE').normalizedVerdict).toBe('doc_issue');
	});

	it('returns null normalizedVerdict for template echoes or invalid values (E-63)', () => {
		expect(extractLastVerdict('VERDICT: pass | rework | doc-issue').normalizedVerdict).toBe(null);
		expect(extractLastVerdict('VERDICT: fail').normalizedVerdict).toBe(null);
		expect(extractLastVerdict('VERDICT: maybe rework').normalizedVerdict).toBe(null);
		expect(extractLastVerdict('VERDICT:').normalizedVerdict).toBe(null);
		expect(extractLastVerdict('').normalizedVerdict).toBe(null);
	});
});

describe('extractLastReworkFence', () => {
	it('extracts the last rework code fence block (AC 4)', () => {
		const text = `
First fence:
\`\`\`rework
R1 first attempt
\`\`\`

Later final fence:
\`\`\`rework
# 返工指令
R1 second attempt
R2 additional fix
\`\`\`
`;
		const fence = extractLastReworkFence(text);
		expect(fence).toBe('# 返工指令\nR1 second attempt\nR2 additional fix');
	});

	it('supports 4 backticks or tildes and ignores other language fences', () => {
		const text = `
\`\`\`typescript
const a = 1;
\`\`\`

~~~~rework
R1 tilde fence
~~~~
`;
		expect(extractLastReworkFence(text)).toBe('R1 tilde fence');
	});

	it('returns null when no rework fence exists', () => {
		expect(extractLastReworkFence('No fence here')).toBeNull();
		expect(extractLastReworkFence('```ts\ncode\n```')).toBeNull();
	});
});

describe('extractReworkSection and parseReworkItems', () => {
	it('extracts multiline R items from REWORK section', () => {
		const text = `
## ACCEPTANCE
- 1) 满足

REWORK
- R1 空指针异常
  文件: packages/daemon/src/index.ts:42
  修复: 补充非空校验
- R2 超时未转人工
  文件: packages/daemon/src/timeout.ts:80
  修复: 处理 E-62 超时

FIXED_BY_REVIEWER
- none
`;
		const section = extractReworkSection(text);
		expect(section).toContain('- R1 空指针异常');
		expect(section).toContain('- R2 超时未转人工');
		expect(section).not.toContain('FIXED_BY_REVIEWER');

		const items = parseReworkItems(section ?? '');
		expect(items).toHaveLength(2);
		expect(items[0]).toEqual({
			id: 'R1',
			index: 1,
			text: '- R1 空指针异常\n  文件: packages/daemon/src/index.ts:42\n  修复: 补充非空校验',
		});
		expect(items[1]).toEqual({
			id: 'R2',
			index: 2,
			text: '- R2 超时未转人工\n  文件: packages/daemon/src/timeout.ts:80\n  修复: 处理 E-62 超时',
		});
	});

	it('handles various R-item notation shapes: R1, R<1>, R〈1〉, * R1, 1. R1', () => {
		const text = `
- R1 first item
- R<2> second item
- R〈3〉 third item
* R4 fourth item
1. R5 fifth item
`;
		const items = parseReworkItems(text);
		expect(items.map((i) => i.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
	});

	it('ignores none, 无, and non-R items in REWORK section', () => {
		const text = `
REWORK
- none
`;
		const section = extractReworkSection(text);
		const items = parseReworkItems(section ?? '');
		expect(items).toHaveLength(0);
	});
});

describe('extractDocIssueSection', () => {
	it('extracts DOC_ISSUE section text and ignores none', () => {
		const textWithIssue = `
DOC_ISSUE
- 06 节与 08 节缓存约定矛盾，缺少失效通知定义

REWORK
- none
`;
		expect(extractDocIssueSection(textWithIssue)).toBe(
			'- 06 节与 08 节缓存约定矛盾，缺少失效通知定义',
		);

		const textWithNone = `
DOC_ISSUE
- none

REWORK
- none
`;
		expect(extractDocIssueSection(textWithNone)).toBeNull();
	});
});

describe('AC 1 & E-63: 输出不符合 pass/rework/doc-issue 三态时按审查未完成处理并保留原文', () => {
	it('treats missing VERDICT line as review incomplete and preserves rawText without truncation', () => {
		const text = '审查报告正文，但是审查者忘了写 VERDICT 结论行。';
		const result = parseReviewVerdict(text);

		expect(result.verdict).toBe('incomplete');
		expect(result.isStructured).toBe(false);
		expect(result.tag).toBe(REVIEW_INCOMPLETE_TAG);
		expect(result.targetState).toBe('awaiting_human');
		expect(result.shouldAutoRework).toBe(false);
		expect(result.reworkText).toBe(text);
		expect(result.reason).toBe('missing_verdict');
	});

	it('treats unrecognized verdict as review incomplete and preserves rawText', () => {
		const text = 'VERDICT: fail\n原因：测试失败。';
		const result = parseReviewVerdict(text);

		expect(result.verdict).toBe('incomplete');
		expect(result.isStructured).toBe(false);
		expect(result.tag).toBe(REVIEW_INCOMPLETE_TAG);
		expect(result.targetState).toBe('awaiting_human');
		expect(result.reworkText).toBe(text);
		expect(result.reason).toBe('unrecognized_verdict');
	});

	it('does NOT guess rework based on keywords like 不通过 or 有问题 (AC 4, E-278)', () => {
		const text = `
我认为本次实现不通过，代码存在严重问题，有很多 bug！
`;
		const result = parseReviewVerdict(text);

		expect(result.verdict).toBe('incomplete');
		expect(result.isStructured).toBe(false);
		expect(result.shouldAutoRework).toBe(false);
		expect(result.tag).toBe(REVIEW_INCOMPLETE_TAG);
		expect(result.reason).toBe('missing_verdict');
		expect(result.reworkText).toBe(text);
	});
});

describe('AC 2 & E-62: 审查 agent 崩溃或超时时标「审查未完成」转人工，任何情况下不默认放行', () => {
	it('marks incomplete and transitions to awaiting_human on timeout', () => {
		const result = evaluateReviewVerdict({
			outputText: '审查子进程执行超时...',
			timedOut: true,
		});

		expect(result.verdict).toBe('incomplete');
		expect(result.isStructured).toBe(false);
		expect(result.tag).toBe(REVIEW_INCOMPLETE_TAG);
		expect(result.targetState).toBe('awaiting_human');
		expect(result.shouldAutoRework).toBe(false);
		expect(result.reason).toBe('agent_timed_out');
		expect(result.reworkText).toBe('审查子进程执行超时...');
	});

	it('marks incomplete on exitReason=startup-timeout or check-timeout', () => {
		const result = evaluateReviewVerdict({
			outputText: '',
			exitReason: 'startup-timeout',
		});
		expect(result.verdict).toBe('incomplete');
		expect(result.targetState).toBe('awaiting_human');
		expect(result.reason).toBe('agent_timed_out');
	});

	it('marks incomplete on exitReason=wall-clock-timeout even when output has VERDICT: pass (AC 2 / E-62)', () => {
		const result = evaluateReviewVerdict({
			outputText: 'VERDICT: pass',
			exitReason: 'wall-clock-timeout',
		});
		expect(result.verdict).toBe('incomplete');
		expect(result.isStructured).toBe(false);
		expect(result.tag).toBe(REVIEW_INCOMPLETE_TAG);
		expect(result.targetState).toBe('awaiting_human');
		expect(result.shouldAutoRework).toBe(false);
		expect(result.reworkText).toBe('VERDICT: pass');
		expect(result.reason).toBe('agent_timed_out');
	});

	it('marks incomplete when killed by signal even if exitReason is exited (AC 2 / E-62)', () => {
		const result = evaluateReviewVerdict({
			outputText: 'VERDICT: pass',
			exitCode: null,
			exitReason: 'exited',
			signal: 'SIGKILL',
		});
		expect(result.verdict).toBe('incomplete');
		expect(result.isStructured).toBe(false);
		expect(result.tag).toBe(REVIEW_INCOMPLETE_TAG);
		expect(result.targetState).toBe('awaiting_human');
		expect(result.shouldAutoRework).toBe(false);
		expect(result.reworkText).toBe('VERDICT: pass');
		expect(result.reason).toBe('agent_crashed');
	});

	it('marks incomplete on process crash / non-zero exit code', () => {
		const result = evaluateReviewVerdict({
			outputText: '进程异常退出',
			exitCode: 137,
			crashed: true,
		});

		expect(result.verdict).toBe('incomplete');
		expect(result.isStructured).toBe(false);
		expect(result.tag).toBe(REVIEW_INCOMPLETE_TAG);
		expect(result.targetState).toBe('awaiting_human');
		expect(result.shouldAutoRework).toBe(false);
		expect(result.reason).toBe('agent_crashed');
	});

	it('never defaults to pass even if output coincidentally contained VERDICT: pass before crashing', () => {
		const deceptiveOutput = 'VERDICT: pass\nAgent unexpectedly killed by SIGKILL';
		const result = evaluateReviewVerdict({
			outputText: deceptiveOutput,
			exitCode: 1,
			hasFatalError: true,
		});

		expect(result.verdict).toBe('incomplete');
		expect(result.targetState).toBe('awaiting_human');
		expect(result.tag).toBe(REVIEW_INCOMPLETE_TAG);
		expect(result.shouldAutoRework).toBe(false);
		expect(result.reworkText).toBe(deceptiveOutput);
	});
});

describe('AC 3 & E-64: 判定 doc-issue 时停止对该任务的自动 rework，汇总意见给用户', () => {
	it('handles doc-issue, ignores rework fence, and stops auto rework', () => {
		const text = `
VERDICT: doc-issue

DOC_ISSUE
- 接口约定第 10 节字段类型与数据库第 09 节定义矛盾，需调整文档规范。

\`\`\`rework
R1 假条目（应该被忽略）
\`\`\`
`;
		const result = parseReviewVerdict(text);

		expect(result.verdict).toBe('doc_issue');
		expect(result.isStructured).toBe(true);
		expect(result.tag).toBe(REVIEW_DOC_ISSUE_TAG);
		expect(result.shouldAutoRework).toBe(false);
		expect(result.targetState).toBe('awaiting_human');
		expect(result.reworkText).toBeNull();
		expect(result.reworkFence).toBeNull(); // doc-issue 忽略围栏
		expect(result.docIssueText).toBe(
			'- 接口约定第 10 节字段类型与数据库第 09 节定义矛盾，需调整文档规范。',
		);
	});
});

describe('AC 4 & E-278: 结构化与返工块提取规则', () => {
	it('extracts rework with fence preferred when fence contains R items', () => {
		const text = `
VERDICT: rework

REWORK
- R1 现象：空指针 → packages/foo.ts:42 → 判空处理

\`\`\`rework
# 返工指令
分支 task/M7-T3
R1 修复 packages/foo.ts:42 判空
\`\`\`
`;
		const result = parseReviewVerdict(text);

		expect(result.verdict).toBe('rework');
		expect(result.isStructured).toBe(true);
		expect(result.tag).toBe(REVIEW_REWORK_TAG);
		expect(result.targetState).toBe('reworking');
		expect(result.shouldAutoRework).toBe(true);
		// 围栏优先
		expect(result.reworkText).toBe('# 返工指令\n分支 task/M7-T3\nR1 修复 packages/foo.ts:42 判空');
		expect(result.rItems[0]?.id).toBe('R1');
	});

	it('extracts rework with section items full text when fence is missing', () => {
		const text = `
VERDICT: rework

REWORK
- R1 现象：测试红了 → packages/test.ts:10 → 修复断言
- R2 边界未处理：E-62 超时 → packages/review.ts:80 → 增加超时状态
`;
		const result = parseReviewVerdict(text);

		expect(result.verdict).toBe('rework');
		expect(result.isStructured).toBe(true);
		expect(result.tag).toBe(REVIEW_REWORK_TAG);
		expect(result.targetState).toBe('reworking');
		expect(result.shouldAutoRework).toBe(true);
		// 其次条目全文
		expect(result.reworkText).toBe(
			'- R1 现象：测试红了 → packages/test.ts:10 → 修复断言\n\n- R2 边界未处理：E-62 超时 → packages/review.ts:80 → 增加超时状态',
		);
		expect(result.rItems).toHaveLength(2);
	});

	it('marks unstructured (review_verdict=incomplete, tag=未结构化) when rework has no R items in either place (E-278)', () => {
		const text = `
VERDICT: rework

REWORK
审查未通过，但没有任何 R 编号条目。
`;
		const result = parseReviewVerdict(text);

		expect(result.verdict).toBe('incomplete');
		expect(result.isStructured).toBe(false);
		expect(result.tag).toBe(UNSTRUCTURED_REWORK_TAG);
		expect(result.targetState).toBe('awaiting_human');
		expect(result.shouldAutoRework).toBe(false);
		expect(result.reason).toBe('unstructured_rework');
		// 原文全文存 rework_text，不截断
		expect(result.reworkText).toBe(text);
	});

	it('handles inconsistency: pass with R items treated as incomplete', () => {
		const text = `
VERDICT: pass

REWORK
- R1 顺便把这行格式改一下
`;
		const result = parseReviewVerdict(text);

		expect(result.verdict).toBe('incomplete');
		expect(result.isStructured).toBe(false);
		expect(result.tag).toBe(REVIEW_INCOMPLETE_TAG);
		expect(result.targetState).toBe('awaiting_human');
		expect(result.shouldAutoRework).toBe(false);
		expect(result.inconsistencies).toContain('pass_with_rework_items');
		expect(result.reason).toBe('pass_with_rework_items');
		expect(result.reworkText).toBe(text);
	});

	it('parses successful pass with no R items', () => {
		const text = `
VERDICT: pass

REWORK
- none

DOC_ISSUE
- none
`;
		const result = parseReviewVerdict(text);

		expect(result.verdict).toBe('pass');
		expect(result.isStructured).toBe(true);
		expect(result.tag).toBe(REVIEW_PASSED_TAG);
		expect(result.targetState).toBe('landed');
		expect(result.reworkText).toBeNull();
		expect(result.shouldAutoRework).toBe(false);
		expect(result.inconsistencies).toHaveLength(0);
	});
});
