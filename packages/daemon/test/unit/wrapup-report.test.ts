import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	WRAPUP_SECTIONS,
	type WrapupSectionName,
	deriveWrapupVerdict,
	parseBugItem,
	parseFixedSection,
	parseTestsSection,
	parseWrapupReport,
	planWrapupFixes,
} from '../../src/domain/wrapup-report.ts';

const FIXTURES_DIR = resolve(__dirname, '../fixtures/wrapup');

function readFixture(name: string): string {
	return readFileSync(resolve(FIXTURES_DIR, name), 'utf-8');
}

describe('M7-T6 收口输出解析与有效裁定 (E-274, E-286, E-290, 决策 61)', () => {
	// =========================================================================
	// AC 1 & E-274: 段头匹配、模板复述取最后一组、缺段参数化与围栏解析
	// =========================================================================
	describe('AC 1 & E-274: 段头须独立成行，找齐八段与缺段处理', () => {
		it('完整八段报告解析成功，返回 ok:true 与八段完整结构', () => {
			const text = readFixture('clean-report.md');
			const result = parseWrapupReport(text);

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.summaryText).toContain('全部 4 个任务均已落地并通过验收');
			expect(result.tests.status).toBe('pass');
			expect(result.bugs).toHaveLength(0);
			expect(result.fixed).toHaveLength(0);
			expect(result.notFixed).toHaveLength(0);
			expect(result.declaredVerdict).toBe('clean');
			expect(result.verdict).toBe('clean');
			expect(result.unassigned).toHaveLength(0);
			expect(result.nextText).toContain('建议在下一批次开始前');
		});

		it('模板被复述两次取最后一组（取实际收口输出而非前导模板）', () => {
			const text = readFixture('duplicate-template.md');
			const result = parseWrapupReport(text);

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			// 验证取到的是实际输出中的 summaryText，而不是模板的 [概览说明]
			expect(result.summaryText).toContain('本次收口验证完成，所有用例通过');
			expect(result.summaryText).not.toContain('[概览说明]');
			expect(result.nextText).toBe('全部就绪。');
			expect(result.verdict).toBe('clean');
		});

		it('整段包在围栏里能正确解析，且 NEXT 段末尾不残留围栏闭合标记', () => {
			const text = readFixture('fenced-report.md');
			const result = parseWrapupReport(text);

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.summaryText).toBe('收口全部完成，代码整洁。');
			expect(result.tests.status).toBe('pass');
			expect(result.verdict).toBe('clean');
			expect(result.nextText).toBe('无遗留，可进入下一批次。');
			expect(result.nextText).not.toContain('```');
		});

		it('- none 为空列表，不解析出伪条目也不进 unassigned', () => {
			const text = `
BATCH_SUMMARY
说明
TESTS
pass
- none
BUGS
- none
FIXED
- none
NOT_FIXED
- none
SUSPECT
- none
RECORD
verdict: clean
NEXT
下批说明
`;
			const result = parseWrapupReport(text);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.bugs).toHaveLength(0);
			expect(result.fixed).toHaveLength(0);
			expect(result.notFixed).toHaveLength(0);
			expect(result.unassigned).toHaveLength(0);
			expect(result.verdict).toBe('clean');
		});

		// 八例参数化测试：缺任一段返回精确缺段清单且不做部分解析、不猜（E-274）
		const standardSections: Record<WrapupSectionName, string> = {
			BATCH_SUMMARY: 'BATCH_SUMMARY\n概述说明',
			TESTS: 'TESTS\npass',
			BUGS: 'BUGS\n- none',
			FIXED: 'FIXED\n- none',
			NOT_FIXED: 'NOT_FIXED\n- none',
			SUSPECT: 'SUSPECT\n- none',
			RECORD: 'RECORD\nverdict: clean',
			NEXT: 'NEXT\n后续规划',
		};

		describe.each(WRAPUP_SECTIONS)(
			'八例参数化缺段检测 (E-274): 缺失 %s 段时返回 ok:false 与精确缺段清单',
			(missingSection) => {
				it(`缺失 [${missingSection}] 时准确返回 missingSections: ['${missingSection}']`, () => {
					// 组装缺失指定段的输入文本
					const text = WRAPUP_SECTIONS.filter((s) => s !== missingSection)
						.map((s) => standardSections[s])
						.join('\n\n');

					const result = parseWrapupReport(text);
					expect(result.ok).toBe(false);
					if (result.ok) return;

					expect(result.missingSections).toEqual([missingSection]);
					expect(result.error).toContain(missingSection);
					// 确保不做部分解析（没有暴露部分 sections 字段）
					expect('sections' in result).toBe(false);
				});
			},
		);

		it('八段全缺（空文本或无关文本）返回包含全部八段的缺段清单', () => {
			const result = parseWrapupReport('这是一段没有任何八段段头的无关文本');
			expect(result.ok).toBe(false);
			if (result.ok) return;

			expect(result.missingSections).toEqual([...WRAPUP_SECTIONS]);
		});
	});

	// =========================================================================
	// AC 2 & E-290: BUGS/NOT_FIXED 条目规范解析与容错
	// =========================================================================
	describe('AC 2 & E-290: BUGS/NOT_FIXED 条目与五字段解析', () => {
		it('B3 [S2 功能错] 涉及 M4-T7（跨批）：a → b → c → x.ts:12 五字段全解析', () => {
			const line =
				'B3 [S2 功能错] 涉及 M4-T7（跨批）：令牌签名失效 → 传入过期密钥 → 签名算法未更新 → packages/daemon/src/auth/token.ts:12';
			const { finding, unassignedRaw } = parseBugItem(line, 'bug');

			expect(unassignedRaw).toBeNull();
			expect(finding).not.toBeNull();
			if (!finding) return;

			expect(finding.id).toBe('B3');
			expect(finding.severity).toBe('S2');
			expect(finding.taskKey).toBe('M4-T7');
			expect(finding.crossBatch).toBe(true);
			expect(finding.symptom).toBe('令牌签名失效');
			expect(finding.reproduction).toBe('传入过期密钥');
			expect(finding.rootCause).toBe('签名算法未更新');
			expect(finding.location).toBe('packages/daemon/src/auth/token.ts:12');
			expect(finding.isWellFormed).toBe(true);
			expect(finding.isFixed).toBe(false);
			expect(finding.raw).toBe(line);
		});

		it('半角括号、-> 与英文冒号同样正确解析', () => {
			const line =
				'- B1 [S1] 涉及 M2-T1 (跨批): 内存泄漏 -> 高并发压测 -> 句柄未释放 -> handle.ts:99';
			const { finding, unassignedRaw } = parseBugItem(line, 'bug');

			expect(unassignedRaw).toBeNull();
			expect(finding).not.toBeNull();
			if (!finding) return;

			expect(finding.id).toBe('B1');
			expect(finding.severity).toBe('S1');
			expect(finding.taskKey).toBe('M2-T1');
			expect(finding.crossBatch).toBe(true);
			expect(finding.symptom).toBe('内存泄漏');
			expect(finding.reproduction).toBe('高并发压测');
			expect(finding.rootCause).toBe('句柄未释放');
			expect(finding.location).toBe('handle.ts:99');
			expect(finding.isWellFormed).toBe(true);
		});

		it('少于四段箭头保留条目但 isWellFormed:false', () => {
			const line = 'B2 [S3] 涉及 M1-T5: 界面轻微闪烁 → 连续点击刷新 → 渲染重入';
			const { finding, unassignedRaw } = parseBugItem(line, 'bug');

			expect(unassignedRaw).toBeNull();
			expect(finding).not.toBeNull();
			if (!finding) return;

			expect(finding.id).toBe('B2');
			expect(finding.severity).toBe('S3');
			expect(finding.taskKey).toBe('M1-T5');
			expect(finding.crossBatch).toBe(false);
			expect(finding.symptom).toBe('界面轻微闪烁');
			expect(finding.reproduction).toBe('连续点击刷新');
			expect(finding.rootCause).toBe('渲染重入');
			expect(finding.location).toBe('');
			expect(finding.isWellFormed).toBe(false); // 少于四段置 false
			expect(finding.raw).toBe(line);
		});

		it('匹配不到 B 号的条目进 unassigned 保留原文（E-290）', () => {
			const line = '- [S1] 涉及 M1-T2: 缺少B编号 → 操作复现 → 根因 → file.ts:1';
			const { finding, unassignedRaw } = parseBugItem(line, 'bug');

			expect(finding).toBeNull();
			expect(unassignedRaw).toBe(line);
		});

		it('匹配不到任务 ID 的条目进 unassigned 保留原文（E-290）', () => {
			const line = 'B5 [S2]: 未提及任何任务编号 → 触发场景 → 原因说明 → file.ts:10';
			const { finding, unassignedRaw } = parseBugItem(line, 'bug');

			expect(finding).toBeNull();
			expect(unassignedRaw).toBe(line);
		});

		it('FIXED 段解析提取 B 号并提取 commit sha', () => {
			const text = `
- B1 [commit 7f3a2b1]: 修复了令牌过期未刷新问题
- B2 (commit: 9a8b7c6d5e): 修复跨批配置丢失
- B3: a1b2c3d
`;
			const fixedItems = parseFixedSection(text);
			expect(fixedItems).toHaveLength(3);
			expect(fixedItems[0]?.id).toBe('B1');
			expect(fixedItems[0]?.commit).toBe('7f3a2b1');
			expect(fixedItems[1]?.id).toBe('B2');
			expect(fixedItems[1]?.commit).toBe('9a8b7c6d5e');
			expect(fixedItems[2]?.id).toBe('B3');
			expect(fixedItems[2]?.commit).toBe('a1b2c3d');
		});

		it('BUGS 中的条目在 FIXED 中出现时标记 isFixed:true，未出现时为 false', () => {
			const text = readFixture('fixed-report.md');
			const result = parseWrapupReport(text);

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.bugs).toHaveLength(1);
			expect(result.bugs[0]?.id).toBe('B1');
			expect(result.bugs[0]?.isFixed).toBe(true);
			expect(result.fixed).toHaveLength(1);
			expect(result.fixed[0]?.id).toBe('B1');
			expect(result.fixed[0]?.commit).toBe('7f3a2b1');
			expect(result.verdict).toBe('fixed');
		});
	});

	// =========================================================================
	// AC 3 & E-286: 有效裁定六种组合与自报值严格解耦
	// =========================================================================
	describe('AC 3 & E-286: 有效裁定六种组合与自报裁定解耦', () => {
		it('组合 1: clean (无 bug、无 not_fixed、tests 通过、unassigned 为空)', () => {
			const verdict = deriveWrapupVerdict({
				testsStatus: 'pass',
				bugs: [],
				fixedIds: new Set(),
				notFixed: [],
				unassigned: [],
			});
			expect(verdict).toBe('clean');
		});

		it('组合 2: fixed (有 BUGS 但全部在 FIXED 中修齐、无遗留)', () => {
			const verdict = deriveWrapupVerdict({
				testsStatus: 'pass',
				bugs: [
					{ id: 'B1', isFixed: true },
					{ id: 'B2', isFixed: true },
				],
				fixedIds: new Set(['B1', 'B2']),
				notFixed: [],
				unassigned: [],
			});
			expect(verdict).toBe('fixed');
		});

		it('组合 3: not_fixed→open (NOT_FIXED 非空)', () => {
			const verdict = deriveWrapupVerdict({
				testsStatus: 'pass',
				bugs: [{ id: 'B1', isFixed: true }],
				fixedIds: new Set(['B1']),
				notFixed: [{ id: 'B2' }],
				unassigned: [],
			});
			expect(verdict).toBe('open');
		});

		it('组合 4: tests fail→open (TESTS 为 fail)', () => {
			const verdict = deriveWrapupVerdict({
				testsStatus: 'fail',
				bugs: [],
				fixedIds: new Set(),
				notFixed: [],
				unassigned: [],
			});
			expect(verdict).toBe('open');
		});

		it('组合 5: 未修 bug→open (BUGS 有未在 FIXED 中出现的条目)', () => {
			const verdict = deriveWrapupVerdict({
				testsStatus: 'pass',
				bugs: [
					{ id: 'B1', isFixed: true },
					{ id: 'B2', isFixed: false },
				],
				fixedIds: new Set(['B1']),
				notFixed: [],
				unassigned: [],
			});
			expect(verdict).toBe('open');
		});

		it('组合 6: unassigned→open (unassigned 非空)', () => {
			const verdict = deriveWrapupVerdict({
				testsStatus: 'pass',
				bugs: [],
				fixedIds: new Set(),
				notFixed: [],
				unassigned: ['未结构化测试失败项'],
			});
			expect(verdict).toBe('open');
		});

		it('E-286: RECORD 自报 clean 但实际有未修 bug 时，有效裁定恒为 open，自报值存 declaredVerdict', () => {
			const text = readFixture('open-unfixed-bug.md');
			const result = parseWrapupReport(text);

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			// 自报值为 clean
			expect(result.declaredVerdict).toBe('clean');
			// 但内容算出有效裁定必须为 open，绝不按自报放行！
			expect(result.verdict).toBe('open');
			expect(result.bugs).toHaveLength(2);
			expect(result.bugs[0]?.isFixed).toBe(true);
			expect(result.bugs[1]?.isFixed).toBe(false);
		});

		it('E-290: TESTS 失败项无「涉及 〈任务ID〉」时进入 unassigned，有效裁定为 open', () => {
			const text = readFixture('open-tests-fail.md');
			const result = parseWrapupReport(text);

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.tests.status).toBe('fail');
			// 有任务号的失败行进入 findings
			const testFindings = result.findings.filter((f) => f.kind === 'test_failure');
			expect(testFindings).toHaveLength(1);
			expect(testFindings[0]?.taskKey).toBe('M1-T10');

			// 无任务号的失败行进入 unassigned
			expect(result.unassigned).toHaveLength(1);
			expect(result.unassigned[0]).toContain('test_suite_db.test.ts failed');

			// 有效裁定为 open
			expect(result.verdict).toBe('open');
		});
	});

	// =========================================================================
	// AC 4 & E-290: planWrapupFixes 开放项分组、重编号 R1... 与未知任务处理
	// =========================================================================
	describe('AC 4 & E-290: planWrapupFixes 开放项分组与重编号', () => {
		it('开放项（TESTS 失败 ∪ BUGS∖FIXED ∪ NOT_FIXED）按任务分组并重编号为 R1...', () => {
			const text = `
BATCH_SUMMARY
收口运行综合发现多个问题

TESTS
fail
- test_auth failed 涉及 M1-T1: 鉴权失败
- test_perf failed 涉及 M1-T1: 性能不达标

BUGS
- B1 [S2] 涉及 M1-T1: B1已修 → a → b → c.ts:1
- B2 [S1] 涉及 M2-T3（跨批）：B2未修 → a → b → c.ts:2
- B3 [S2] 涉及 M2-T3: B3未修 → a → b → c.ts:3

FIXED
- B1: commit 1111111

NOT_FIXED
- B4 [S2] 涉及 M1-T1: M1T1未修项 → a → b → c.ts:4

SUSPECT
- none

RECORD
verdict: open

NEXT
派发修复运行
`;
			const report = parseWrapupReport(text);
			expect(report.ok).toBe(true);
			if (!report.ok) return;

			const planned = planWrapupFixes(report);

			// M1-T1 包含：2 个测试失败项 + 1 个 NOT_FIXED 项 = 3 项
			// M2-T3 包含：B2(未修) + B3(未修) = 2 项
			expect(planned.groups).toHaveLength(2);

			const m1Group = planned.groups.find((g) => g.taskKey === 'M1-T1');
			expect(m1Group).toBeDefined();
			expect(m1Group?.items).toHaveLength(3);
			expect(m1Group?.items[0]?.id).toBe('R1');
			expect(m1Group?.items[0]?.index).toBe(1);
			expect(m1Group?.items[0]?.raw).toContain('test_auth failed');
			expect(m1Group?.items[1]?.id).toBe('R2');
			expect(m1Group?.items[1]?.index).toBe(2);
			expect(m1Group?.items[2]?.id).toBe('R3');
			expect(m1Group?.items[2]?.index).toBe(3);
			expect(m1Group?.items[2]?.raw).toContain('M1T1未修项');

			const m2Group = planned.groups.find((g) => g.taskKey === 'M2-T3');
			expect(m2Group).toBeDefined();
			expect(m2Group?.items).toHaveLength(2);
			expect(m2Group?.crossBatch).toBe(true); // 包含跨批项
			expect(m2Group?.items[0]?.id).toBe('R1'); // 组内重新从 R1 开始编号
			expect(m2Group?.items[0]?.index).toBe(1);
			expect(m2Group?.items[0]?.crossBatch).toBe(true);
			expect(m2Group?.items[1]?.id).toBe('R2');
			expect(m2Group?.items[1]?.index).toBe(2);

			expect(planned.totalOpenCount).toBe(5);
		});

		it('未知任务归 unassigned，已知任务保留分组（E-290）', () => {
			const text = `
BATCH_SUMMARY
说明
TESTS
pass
BUGS
- B1 [S1] 涉及 M1-T1: 合法任务问题 → a → b → c.ts:1
- B2 [S2] 涉及 UNKNOWN-TASK-99: 未知任务问题 → a → b → c.ts:2
FIXED
- none
NOT_FIXED
- none
SUSPECT
- none
RECORD
verdict: open
NEXT
说明
`;
			const report = parseWrapupReport(text);
			expect(report.ok).toBe(true);
			if (!report.ok) return;

			// 限制已知任务只有 M1-T1
			const planned = planWrapupFixes(report, {
				knownTaskKeys: ['M1-T1'],
			});

			expect(planned.groups).toHaveLength(1);
			expect(planned.groups[0]?.taskKey).toBe('M1-T1');
			expect(planned.groups[0]?.items).toHaveLength(1);
			expect(planned.groups[0]?.items[0]?.id).toBe('R1');

			// UNKNOWN-TASK-99 归入 unassigned，原文逐字保留
			expect(planned.unassigned).toHaveLength(1);
			expect(planned.unassigned[0]).toContain('UNKNOWN-TASK-99');
			expect(planned.totalOpenCount).toBe(2);
		});
	});

	// =========================================================================
	// AC 5: 纯函数零依赖、顶层零副作用
	// =========================================================================
	describe('AC 5: 纯函数零依赖、顶层零副作用', () => {
		it('多次调用相同输入产出结果完全确定，不产生外部副作用', () => {
			const text = readFixture('clean-report.md');
			const res1 = parseWrapupReport(text);
			const res2 = parseWrapupReport(text);

			expect(res1).toEqual(res2);
		});

		it('parseTestsSection 能准确识别 pass / fail / skipped / unknown 状态', () => {
			expect(parseTestsSection('status: pass\n- all passed').tests.status).toBe('pass');
			expect(parseTestsSection('status: fail\n- 1 failed').tests.status).toBe('fail');
			expect(parseTestsSection('文档未声明测试命令，TESTS 记 skipped 并说明').tests.status).toBe(
				'skipped',
			);
			expect(parseTestsSection('没有任何状态关键词').tests.status).toBe('unknown');
		});
	});
});
