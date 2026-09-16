/**
 * 收口输出解析与有效裁定（M7-T6 / E-274, E-286, E-290, 决策 61）。
 *
 * 核心功能：
 * 1. parseWrapupReport: 独立成行段头匹配、取最后一个 BATCH_SUMMARY 之后找齐八段的那一组，
 *    找不齐返回 ok:false 与精确缺段清单，不做部分解析、不猜（E-274）。
 * 2. parseBugItems / parseFixedItems: 解析 BUGS、FIXED、NOT_FIXED、TESTS 条目。
 * 3. deriveWrapupVerdict: 有效裁定纯内容推导，自报值只存 declaredVerdict，
 *    绝不用自报值放行（E-286）。
 * 4. planWrapupFixes: 把开放项按任务分组、重编号 R1... 而原文逐字保留，未知任务归 unassigned（E-290）。
 *
 * 纯函数零依赖、顶层零副作用。
 */

/**
 * 决策 61 与 08 节规定的八段标准模板名称及其严格顺序。
 */
export const WRAPUP_SECTIONS = [
	'BATCH_SUMMARY',
	'TESTS',
	'BUGS',
	'FIXED',
	'NOT_FIXED',
	'SUSPECT',
	'RECORD',
	'NEXT',
] as const;

export type WrapupSectionName = (typeof WRAPUP_SECTIONS)[number];

/**
 * 有效裁定与自报裁定三态枚举（09 节数据模型 batch_wrapups.verdict）。
 */
export const WRAPUP_VERDICTS = ['clean', 'fixed', 'open'] as const;
export type WrapupVerdict = (typeof WRAPUP_VERDICTS)[number];

/**
 * 测试总体状态枚举（09 节数据模型 batch_wrapups.tests_json.status）。
 */
export const TESTS_STATUSES = ['pass', 'fail', 'skipped', 'unknown'] as const;
export type TestsStatus = (typeof TESTS_STATUSES)[number];

/**
 * 问题条目种类（09 节数据模型 batch_wrapups.findings_json.kind）。
 */
export type FindingKind = 'bug' | 'not_fixed' | 'test_failure';

/**
 * 严重级别。
 */
export type SeverityLevel = 'S1' | 'S2' | 'S3';

/**
 * 结构化的收口问题条目（BUGS / NOT_FIXED / TESTS 失败项）。
 */
export interface WrapupFinding {
	/** 条目编号，如 "B1", "B2", "B3" 或测试失败项的 "T1" */
	readonly id: string;
	/** 条目种类 */
	readonly kind: FindingKind;
	/** 严重级别（"S1" | "S2" | "S3" 或括号内原串，解析不到为 null） */
	readonly severity: SeverityLevel | string | null;
	/** 归属的任务 ID，如 "M4-T7"；匹配不到或无主时为 null */
	readonly taskKey: string | null;
	/** 是否跨批（带"（跨批）"或"(跨批)"时为 true） */
	readonly crossBatch: boolean;
	/** 是否在 FIXED 段已修复（BUGS 专有，NOT_FIXED 恒为 false） */
	readonly isFixed: boolean;
	/** 是否格式完好（箭头切分少于四段时为 false） */
	readonly isWellFormed: boolean;
	/** 条目原始文本，逐字保留 */
	readonly raw: string;
	/** 现象描述 */
	readonly symptom?: string;
	/** 复现步骤/条件 */
	readonly reproduction?: string;
	/** 根本原因 */
	readonly rootCause?: string;
	/** 代码位置（文件:行） */
	readonly location?: string;
}

/**
 * FIXED 段已修复条目。
 */
export interface WrapupFixedItem {
	/** 对应的 Bug 编号，如 "B1" */
	readonly id: string;
	/** 条目原始文本 */
	readonly raw: string;
	/** 提取到的 commit hash（若有） */
	readonly commit: string | null;
}

/**
 * TESTS 段解析结果。
 */
export interface WrapupTestsSummary {
	/** 总体测试状态 */
	readonly status: TestsStatus;
	/** 提取的测试行（不含纯状态标记） */
	readonly items: readonly string[];
	/** TESTS 段原文 */
	readonly rawText: string;
}

/**
 * 单个修复项（由 planWrapupFixes 重编号产生）。
 */
export interface WrapupFixItem {
	/** 重编号后的标识符，如 "R1", "R2" */
	readonly id: string;
	/** 1 起始的组内序号 */
	readonly index: number;
	/** 原始条目 ID（如 "B3" 或 "T1"） */
	readonly originalId: string;
	/** 原始文本，逐字保留 */
	readonly raw: string;
	/** 是否跨批 */
	readonly crossBatch: boolean;
	/** 原始 Finding 引用 */
	readonly finding: WrapupFinding;
}

/**
 * 按任务归组的修复计划组。
 */
export interface WrapupFixGroup {
	/** 目标任务 ID */
	readonly taskKey: string;
	/** 组内是否有任何条目标记为跨批 */
	readonly crossBatch: boolean;
	/** 组内修复条目列表（已重编号为 R1...） */
	readonly items: readonly WrapupFixItem[];
}

/**
 * planWrapupFixes 产出的完整修复计划。
 */
export interface PlannedWrapupFixes {
	/** 按任务分组的修复清单 */
	readonly groups: readonly WrapupFixGroup[];
	/** 无法分配给已知合法任务的条目原文数组（逐字保留） */
	readonly unassigned: readonly string[];
	/** 开放项总数（分组内条目数 + unassigned 条目数） */
	readonly totalOpenCount: number;
}

/**
 * 收口报告解析成功结果。
 */
export interface ParsedWrapupReportSuccess {
	readonly ok: true;
	/** 各段纯文本内容映射表 */
	readonly sections: Readonly<Record<WrapupSectionName, string>>;
	/** BATCH_SUMMARY 段原文 */
	readonly summaryText: string;
	/** TESTS 段结构化解析 */
	readonly tests: WrapupTestsSummary;
	/** BUGS 段解析条目列表（已打上 isFixed 标记） */
	readonly bugs: readonly WrapupFinding[];
	/** FIXED 段解析已修复列表 */
	readonly fixed: readonly WrapupFixedItem[];
	/** NOT_FIXED 段解析条目列表 */
	readonly notFixed: readonly WrapupFinding[];
	/** SUSPECT 段原文 */
	readonly suspectText: string;
	/** RECORD 段原文 */
	readonly recordText: string;
	/** NEXT 段原文 */
	readonly nextText: string;
	/** RECORD 段自报裁定值，未能提取则为 null（E-286） */
	readonly declaredVerdict: WrapupVerdict | null;
	/** 内容计算出的有效裁定（clean | fixed | open）（E-286） */
	readonly verdict: WrapupVerdict;
	/** 匹配不到 B 号或任务 ID 的条目原文数组（逐字保留，E-290） */
	readonly unassigned: readonly string[];
	/** 原始报告文本 */
	readonly rawText: string;
	/** 全部 findings 列表（含 bugs、notFixed 以及测试失败项） */
	readonly findings: readonly WrapupFinding[];
}

/**
 * 收口报告解析失败结果（找不齐八段，不做部分解析，E-274）。
 */
export interface ParsedWrapupReportFailure {
	readonly ok: false;
	/** 精确缺失的段名列表（保持模板顺序） */
	readonly missingSections: readonly WrapupSectionName[];
	/** 原始输入文本 */
	readonly rawText: string;
	/** 错误原因摘要 */
	readonly error: string;
}

export type ParsedWrapupReport = ParsedWrapupReportSuccess | ParsedWrapupReportFailure;

/**
 * 段头正则生成工厂：匹配独立成行的指定段名。
 * 支持：
 * - 纯段名：BATCH_SUMMARY
 * - Markdown 标题：# BATCH_SUMMARY, ## BATCH_SUMMARY, ### BATCH_SUMMARY 等
 * - 编号前缀：1. BATCH_SUMMARY, 1、BATCH_SUMMARY
 * - 加粗包装：**BATCH_SUMMARY**
 * - 冒号结尾：BATCH_SUMMARY:, BATCH_SUMMARY：
 * - 前后空白忽略
 */
function createSectionHeaderRegex(name: WrapupSectionName): RegExp {
	return new RegExp(
		`^\\s*(?:#{1,6}\\s+)?(?:\\d+[.、]\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*[:：]?\\s*$`,
		'i',
	);
}

const SECTION_REGEX_MAP: Record<WrapupSectionName, RegExp> = {
	BATCH_SUMMARY: createSectionHeaderRegex('BATCH_SUMMARY'),
	TESTS: createSectionHeaderRegex('TESTS'),
	BUGS: createSectionHeaderRegex('BUGS'),
	FIXED: createSectionHeaderRegex('FIXED'),
	NOT_FIXED: createSectionHeaderRegex('NOT_FIXED'),
	SUSPECT: createSectionHeaderRegex('SUSPECT'),
	RECORD: createSectionHeaderRegex('RECORD'),
	NEXT: createSectionHeaderRegex('NEXT'),
};

interface MatchedHeaderLine {
	readonly lineIndex: number;
	readonly section: WrapupSectionName;
	readonly rawLine: string;
}

/**
 * 剥除文本最外层代码块围栏（若存在）。
 * 处理整篇输出被 ``` 或 ```markdown 包裹的情况。
 */
function unwrapOuterFences(text: string): string {
	const trimmed = text.trim();
	const fenceMatch = /^(`{3,}|~{3,})[^\n]*\r?\n([\s\S]*?)\r?\n\1\s*$/.exec(trimmed);
	if (fenceMatch?.[2]) {
		return fenceMatch[2];
	}
	return text;
}

/**
 * 在给定的行列表中查找所有符合独立段头的行。
 */
function findHeaderLines(lines: readonly string[]): MatchedHeaderLine[] {
	const result: MatchedHeaderLine[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		for (const section of WRAPUP_SECTIONS) {
			if (SECTION_REGEX_MAP[section].test(line)) {
				result.push({
					lineIndex: i,
					section,
					rawLine: line,
				});
				break;
			}
		}
	}
	return result;
}

/**
 * 寻找能按模板顺序找齐八段的全部可能组，并取最后一个 BATCH_SUMMARY 开始的那一组（AC 1）。
 */
function findCompleteSectionGroups(headers: readonly MatchedHeaderLine[]): MatchedHeaderLine[][] {
	const completeGroups: MatchedHeaderLine[][] = [];

	// 找出所有 BATCH_SUMMARY 的位置
	const summaryIndices: number[] = [];
	for (let i = 0; i < headers.length; i++) {
		const item = headers[i];
		if (item && item.section === 'BATCH_SUMMARY') {
			summaryIndices.push(i);
		}
	}

	for (const startIndex of summaryIndices) {
		const startHeader = headers[startIndex];
		if (!startHeader) continue;

		const group: MatchedHeaderLine[] = [startHeader];
		let expectedSectionIdx = 1;
		let currentLineIdx = startHeader.lineIndex;

		for (
			let i = startIndex + 1;
			i < headers.length && expectedSectionIdx < WRAPUP_SECTIONS.length;
			i++
		) {
			const candidate = headers[i];
			const expectedSection = WRAPUP_SECTIONS[expectedSectionIdx];
			if (
				candidate &&
				expectedSection &&
				candidate.lineIndex > currentLineIdx &&
				candidate.section === expectedSection
			) {
				group.push(candidate);
				currentLineIdx = candidate.lineIndex;
				expectedSectionIdx++;
			}
		}

		if (group.length === WRAPUP_SECTIONS.length) {
			completeGroups.push(group);
		}
	}

	return completeGroups;
}

/**
 * 当找不齐八段时，计算精确缺失的段名清单（保持 WRAPUP_SECTIONS 模板顺序）。
 * 若存在 BATCH_SUMMARY，优先以最后一个 BATCH_SUMMARY 之后的内容比对模板后续段；
 * 若没有 BATCH_SUMMARY，则全篇比对，缺什么段就精确报什么段（八例参数化支持）。
 */
function computeMissingSections(headers: readonly MatchedHeaderLine[]): WrapupSectionName[] {
	// 如果没有任何段头，八段全缺
	if (headers.length === 0) {
		return [...WRAPUP_SECTIONS];
	}

	// 找最后一个 BATCH_SUMMARY
	let lastSummaryPos = -1;
	for (let i = headers.length - 1; i >= 0; i--) {
		const item = headers[i];
		if (item && item.section === 'BATCH_SUMMARY') {
			lastSummaryPos = i;
			break;
		}
	}

	if (lastSummaryPos !== -1) {
		const summaryItem = headers[lastSummaryPos];
		if (!summaryItem) return [...WRAPUP_SECTIONS];

		// 我们采用动态规划/贪心求与剩余 7 段的最长匹配子序列
		const remainingExpected = WRAPUP_SECTIONS.slice(1);
		const candidatesAfterSummary = headers.filter((h) => h.lineIndex > summaryItem.lineIndex);
		const lcsMatched = computeLcsSections(remainingExpected, candidatesAfterSummary);
		const totalMatched = new Set<WrapupSectionName>(['BATCH_SUMMARY', ...lcsMatched]);

		return WRAPUP_SECTIONS.filter((sec) => !totalMatched.has(sec));
	}

	// 没有 BATCH_SUMMARY，全篇匹配
	const lcsMatched = computeLcsSections(WRAPUP_SECTIONS, headers);
	const matchedSet = new Set<WrapupSectionName>(lcsMatched);
	return WRAPUP_SECTIONS.filter((sec) => !matchedSet.has(sec));
}

/**
 * 求目标段名数组在候选段头行列表中的最长按序匹配集合。
 */
function computeLcsSections(
	targets: readonly WrapupSectionName[],
	candidates: readonly MatchedHeaderLine[],
): Set<WrapupSectionName> {
	const n = targets.length;
	const m = candidates.length;
	if (n === 0 || m === 0) return new Set();

	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

	for (let i = 1; i <= n; i++) {
		const rowPrev = dp[i - 1];
		const rowCurr = dp[i];
		if (!rowPrev || !rowCurr) continue;
		const targetSec = targets[i - 1];

		for (let j = 1; j <= m; j++) {
			const candidate = candidates[j - 1];
			if (candidate && targetSec === candidate.section) {
				rowCurr[j] = (rowPrev[j - 1] ?? 0) + 1;
			} else {
				const left = rowCurr[j - 1] ?? 0;
				const up = rowPrev[j] ?? 0;
				rowCurr[j] = Math.max(left, up);
			}
		}
	}

	// 回溯找出被匹配的段名
	const matched = new Set<WrapupSectionName>();
	let i = n;
	let j = m;
	while (i > 0 && j > 0) {
		const targetSec = targets[i - 1];
		const candidate = candidates[j - 1];
		const rowCurr = dp[i];
		const rowPrev = dp[i - 1];
		if (!targetSec || !candidate || !rowCurr || !rowPrev) break;

		if (targetSec === candidate.section) {
			matched.add(targetSec);
			i--;
			j--;
		} else {
			const up = rowPrev[j] ?? 0;
			const left = rowCurr[j - 1] ?? 0;
			if (up >= left) {
				i--;
			} else {
				j--;
			}
		}
	}

	return matched;
}

/**
 * 判断一行是否为 `- none` / `无` / `none.` 等空条目标识。
 */
export function isNoneIndicator(text: string): boolean {
	if (!text) return true;
	const trimmed = text.trim();
	if (trimmed.length === 0) return true;
	return /^[-*•]?\s*(?:none|无|none\.|无\.|null)\s*$/i.test(trimmed);
}

/**
 * 解析单个 BUGS 或 NOT_FIXED 条目（AC 2 / E-290）。
 * 格式要求：`B〈n〉 [S1／S2／S3] 涉及 〈任务ID〉（跨批）：现象 → 复现 → 根因 → 文件:行`
 * 接受：半角括号、全角括号、`->`、`→`、全角冒号`：`与半角冒号`:`。
 * 少于四段保留条目但 `isWellFormed: false`。
 * 匹配不到 B 号或任务 ID 的条目进 `unassigned` 保留原文。
 */
export function parseBugItem(
	rawLine: string,
	kind: 'bug' | 'not_fixed' = 'bug',
): { finding: WrapupFinding | null; unassignedRaw: string | null } {
	const trimmed = rawLine.trim();
	if (isNoneIndicator(trimmed)) {
		return { finding: null, unassignedRaw: null };
	}

	// 剥除行首列表符号（-, *, 1., • 等）
	const withoutBullet = trimmed.replace(/^[-*•]\s+/, '').replace(/^\d+[.、]\s+/, '');

	// 1. 提取 B 编号：B<n> / B〈n〉 / B[n] / B(n) / Bn
	const bMatch = /^B(?:[〈<(\[]?(\d+)[〉>)\]]?)/iu.exec(withoutBullet);
	const bugNumberStr = bMatch?.[1];
	if (!bMatch || !bugNumberStr) {
		// 匹配不到 B 号，进 unassigned（E-290）
		return { finding: null, unassignedRaw: rawLine };
	}

	const bugNumber = Number.parseInt(bugNumberStr, 10);
	const bugId = `B${bugNumber}`;
	const afterB = withoutBullet.slice(bMatch[0].length).trim();

	// 2. 提取严重度：[S1/S2/S3] 或 ［S2 功能错］ 等
	let severity: SeverityLevel | string | null = null;
	let afterSeverity = afterB;
	const sevMatch = /^[[［]([^\]］]+)[\]］]/.exec(afterB);
	if (sevMatch) {
		const sevInner = (sevMatch[1] ?? '').trim();
		const sMatch = /(S[1-3])/i.exec(sevInner);
		if (sMatch?.[1]) {
			severity = sMatch[1].toUpperCase() as SeverityLevel;
		} else {
			severity = sevInner;
		}
		afterSeverity = afterB.slice(sevMatch[0].length).trim();
	}

	// 3. 提取任务 ID 与跨批标记：涉及 〈任务ID〉（跨批）：...
	// 查找冒号位置
	const colonMatch = /[:：]/.exec(afterSeverity);
	if (!colonMatch) {
		// 没有冒号，无法切分前导信息与正文内容
		return { finding: null, unassignedRaw: rawLine };
	}

	const prefixBeforeColon = afterSeverity.slice(0, colonMatch.index).trim();
	const contentAfterColon = afterSeverity.slice(colonMatch.index + 1).trim();

	// 在冒号前查找 "涉及 <任务ID>"
	const taskMatch = /涉及\s*[〈<\[(]?([A-Za-z0-9_/-]+)[〉>\])]?/iu.exec(prefixBeforeColon);
	const matchedTaskKey = taskMatch?.[1];
	if (!taskMatch || !matchedTaskKey) {
		// 匹配不到任务 ID，进 unassigned（E-290）
		return { finding: null, unassignedRaw: rawLine };
	}

	const taskKey = matchedTaskKey.trim();
	const crossBatch = /（跨批）|\(跨批\)|\[跨批\]|［跨批］|跨批/u.test(prefixBeforeColon);

	// 4. 切分四段式：现象 → 复现 → 根因 → 文件:行
	// 分隔符：全角箭头 → 或半角箭头 ->
	const parts = contentAfterColon.split(/\s*(?:→|->)\s*/);

	let symptom = '';
	let reproduction = '';
	let rootCause = '';
	let location = '';
	let isWellFormed = false;

	if (parts.length >= 4) {
		symptom = (parts[0] ?? '').trim();
		reproduction = (parts[1] ?? '').trim();
		rootCause = (parts[2] ?? '').trim();
		location = parts.slice(3).join(' → ').trim();
		isWellFormed = true;
	} else {
		symptom = (parts[0] ?? '').trim();
		reproduction = (parts[1] ?? '').trim();
		rootCause = (parts[2] ?? '').trim();
		location = (parts[3] ?? '').trim();
		isWellFormed = false;
	}

	const finding: WrapupFinding = {
		id: bugId,
		kind,
		severity,
		taskKey,
		crossBatch,
		isFixed: false,
		isWellFormed,
		raw: rawLine,
		symptom,
		reproduction,
		rootCause,
		location,
	};

	return { finding, unassignedRaw: null };
}

/**
 * 解析 BUGS 或 NOT_FIXED 段中的全部条目。
 */
export function parseBugSection(
	text: string,
	kind: 'bug' | 'not_fixed',
): {
	findings: readonly WrapupFinding[];
	unassigned: readonly string[];
} {
	if (!text || isNoneIndicator(text)) {
		return { findings: Object.freeze([]), unassigned: Object.freeze([]) };
	}

	const lines = text.split(/\r?\n/);
	const findings: WrapupFinding[] = [];
	const unassigned: string[] = [];

	for (const line of lines) {
		if (!line.trim() || isNoneIndicator(line)) {
			continue;
		}

		const parsed = parseBugItem(line, kind);
		if (parsed.finding) {
			findings.push(parsed.finding);
		} else if (parsed.unassignedRaw) {
			unassigned.push(parsed.unassignedRaw);
		}
	}

	return {
		findings: Object.freeze(findings),
		unassigned: Object.freeze(unassigned),
	};
}

/**
 * 解析 FIXED 段中修复记录条目（提取 B 号与可选 commit）。
 */
export function parseFixedSection(text: string): readonly WrapupFixedItem[] {
	if (!text || isNoneIndicator(text)) {
		return Object.freeze([]);
	}

	const lines = text.split(/\r?\n/);
	const items: WrapupFixedItem[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || isNoneIndicator(trimmed)) {
			continue;
		}

		// 匹配 B<n> 编号
		const bMatch = /B(?:[〈<(\[]?(\d+)[〉>)\]]?)/iu.exec(trimmed);
		const bNumStr = bMatch?.[1];
		if (!bMatch || !bNumStr) {
			continue;
		}

		const id = `B${bNumStr}`;
		// 匹配 commit sha：7 到 40 位十六进制串
		let commit: string | null = null;
		const commitMatch = /(?:commit\s*[:：]?\s*|[([#\s])([0-9a-f]{7,40})\b/i.exec(trimmed);
		if (commitMatch?.[1]) {
			commit = commitMatch[1];
		} else {
			// 直接查找连续 7-40 位十六进制
			const directSha = /\b([0-9a-f]{7,40})\b/i.exec(trimmed);
			if (directSha?.[1]) {
				commit = directSha[1];
			}
		}

		items.push(
			Object.freeze({
				id,
				raw: line,
				commit,
			}),
		);
	}

	return Object.freeze(items);
}

/**
 * 解析 TESTS 段（状态识别与失败条目提取，E-290）。
 */
export function parseTestsSection(text: string): {
	tests: WrapupTestsSummary;
	testFailures: readonly WrapupFinding[];
	unassigned: readonly string[];
} {
	if (!text) {
		return {
			tests: Object.freeze({ status: 'unknown', items: Object.freeze([]), rawText: '' }),
			testFailures: Object.freeze([]),
			unassigned: Object.freeze([]),
		};
	}

	const lines = text.split(/\r?\n/);
	let status: TestsStatus = 'unknown';

	// 1. 判断总体 status
	const lower = text.toLowerCase();
	if (/(?:^|\s|\b)(?:fail|failed|failure|错误|失败)(?:\s|\b|$|[:：])/i.test(lower)) {
		status = 'fail';
	} else if (/(?:^|\s|\b)(?:skipped|skip|跳过)(?:\s|\b|$|[:：])/i.test(lower)) {
		status = 'skipped';
	} else if (/(?:^|\s|\b)(?:pass|passed|通过)(?:\s|\b|$|[:：])/i.test(lower)) {
		status = 'pass';
	}

	const items: string[] = [];
	const testFailures: WrapupFinding[] = [];
	const unassigned: string[] = [];

	let failureIdx = 1;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || isNoneIndicator(trimmed)) {
			continue;
		}

		// 跳过单独的 status 声明行，如 "fail" / "status: fail" / "pass"
		if (/^(?:status\s*[:：]\s*)?(?:pass|fail|skipped|unknown)$/i.test(trimmed)) {
			continue;
		}

		items.push(line);

		// 若 TESTS 为 fail，检查行是否为失败用例
		if (status === 'fail') {
			const taskMatch = /涉及\s*[〈<\[(]?([A-Za-z0-9_/-]+)[〉>\])]?/iu.exec(trimmed);
			const crossBatch = /（跨批）|\(跨批\)|\[跨批\]|［跨批］|跨批/u.test(trimmed);

			if (taskMatch?.[1]) {
				testFailures.push(
					Object.freeze({
						id: `T${failureIdx++}`,
						kind: 'test_failure',
						severity: 'S1',
						taskKey: taskMatch[1].trim(),
						crossBatch,
						isFixed: false,
						isWellFormed: true,
						raw: line,
					}),
				);
			} else {
				// 失败项无「涉及 〈任务ID〉」，进 unassigned（E-290）
				unassigned.push(line);
			}
		}
	}

	return {
		tests: Object.freeze({
			status,
			items: Object.freeze(items),
			rawText: text,
		}),
		testFailures: Object.freeze(testFailures),
		unassigned: Object.freeze(unassigned),
	};
}

/**
 * 从 RECORD 段中解析自报裁定值（declaredVerdict）。
 */
export function extractDeclaredVerdict(recordText: string): WrapupVerdict | null {
	if (!recordText) return null;
	const match = /(?:verdict\s*[:：]\s*|\b)(clean|fixed|open)\b/i.exec(recordText);
	if (match?.[1]) {
		const val = match[1].toLowerCase();
		if (val === 'clean') return 'clean';
		if (val === 'fixed') return 'fixed';
		if (val === 'open') return 'open';
	}
	return null;
}

/**
 * 根据内容严格推导有效裁定（AC 3 / E-286）。
 * TESTS 为 fail、NOT_FIXED 非空、BUGS 有未出现在 FIXED 的、unassigned 非空——任一成立即 open；
 * 否则有 BUGS 即 fixed；
 * 否则 clean。
 * RECORD 自报值只存 declaredVerdict，绝不按自报放行（E-286）。
 */
export function deriveWrapupVerdict(input: {
	readonly testsStatus: TestsStatus;
	readonly bugs: readonly { readonly id: string; readonly isFixed?: boolean }[];
	readonly fixedIds: ReadonlySet<string>;
	readonly notFixed: readonly unknown[];
	readonly unassigned: readonly unknown[];
}): WrapupVerdict {
	const isTestsFail = input.testsStatus === 'fail';
	const hasNotFixed = input.notFixed.length > 0;
	const hasUnfixedBugs = input.bugs.some((b) => {
		if (typeof b.isFixed === 'boolean') {
			return !b.isFixed;
		}
		return !input.fixedIds.has(b.id);
	});
	const hasUnassigned = input.unassigned.length > 0;

	// 任一成立即 open
	if (isTestsFail || hasNotFixed || hasUnfixedBugs || hasUnassigned) {
		return 'open';
	}

	// 否则有 BUGS 即 fixed
	if (input.bugs.length > 0) {
		return 'fixed';
	}

	// 否则 clean
	return 'clean';
}

/**
 * 解析收口运行输出（AC 1-5, E-274, E-286, E-290）。
 * 段头须独立成行，取最后一个 BATCH_SUMMARY 之后能按模板顺序找齐八段的那一组。
 * 找不齐返回 ok:false 与精确缺段清单，不做部分解析、不猜（E-274）。
 */
export function parseWrapupReport(rawText: string): ParsedWrapupReport {
	const text = rawText ?? '';
	const unwrapped = unwrapOuterFences(text);

	// 优先在去围栏后的文本上切行找段头；若失败则在原文本上尝试
	let workingText = unwrapped;
	let lines = workingText.split(/\r?\n/);
	let headers = findHeaderLines(lines);
	let completeGroups = findCompleteSectionGroups(headers);

	if (completeGroups.length === 0 && workingText !== text) {
		workingText = text;
		lines = workingText.split(/\r?\n/);
		headers = findHeaderLines(lines);
		completeGroups = findCompleteSectionGroups(headers);
	}

	// 找不齐八段（E-274）：返回 ok:false 与精确缺段清单
	if (completeGroups.length === 0) {
		const missingSections = computeMissingSections(headers);
		return Object.freeze({
			ok: false,
			missingSections: Object.freeze(missingSections),
			rawText: text,
			error: `Missing required wrapup report sections: ${missingSections.join(', ')}`,
		});
	}

	// 取最后一个 BATCH_SUMMARY 之后能找齐八段的那一组（最后一组）
	const group = completeGroups[completeGroups.length - 1];
	if (!group) {
		const missingSections = computeMissingSections(headers);
		return Object.freeze({
			ok: false,
			missingSections: Object.freeze(missingSections),
			rawText: text,
			error: `Missing required wrapup report sections: ${missingSections.join(', ')}`,
		});
	}

	// 提取八段正文
	const sections: Record<WrapupSectionName, string> = {
		BATCH_SUMMARY: '',
		TESTS: '',
		BUGS: '',
		FIXED: '',
		NOT_FIXED: '',
		SUSPECT: '',
		RECORD: '',
		NEXT: '',
	};

	for (let i = 0; i < WRAPUP_SECTIONS.length; i++) {
		const secName = WRAPUP_SECTIONS[i];
		const currHeader = group[i];
		if (!secName || !currHeader) continue;

		const startLine = currHeader.lineIndex + 1;
		const nextHeader = i + 1 < WRAPUP_SECTIONS.length ? group[i + 1] : undefined;
		const endLine = nextHeader ? nextHeader.lineIndex : lines.length;

		let secLines = lines.slice(startLine, endLine);
		// 若为 NEXT 段且最后一行是外层代码围栏结尾，剥除
		if (secName === 'NEXT' && secLines.length > 0) {
			const last = (secLines[secLines.length - 1] ?? '').trim();
			if (/^`{3,}|~{3,}$/.test(last)) {
				secLines = secLines.slice(0, -1);
			}
		}

		sections[secName] = secLines.join('\n').trim();
	}

	// 结构化解析各段
	const { tests, testFailures, unassigned: testsUnassigned } = parseTestsSection(sections.TESTS);
	const { findings: rawBugs, unassigned: bugsUnassigned } = parseBugSection(sections.BUGS, 'bug');
	const fixedItems = parseFixedSection(sections.FIXED);
	const { findings: notFixed, unassigned: notFixedUnassigned } = parseBugSection(
		sections.NOT_FIXED,
		'not_fixed',
	);

	// 关联 FIXED：根据 FIXED 中出现的 id，给 BUGS 打上 isFixed 标记
	const fixedIds = new Set(fixedItems.map((f) => f.id));
	const bugs: WrapupFinding[] = rawBugs.map((bug) =>
		Object.freeze({
			...bug,
			isFixed: fixedIds.has(bug.id),
		}),
	);

	// 汇总所有 unassigned
	const unassigned = Object.freeze([...testsUnassigned, ...bugsUnassigned, ...notFixedUnassigned]);

	// 自报裁定（RECORD）
	const declaredVerdict = extractDeclaredVerdict(sections.RECORD);

	// 有效裁定纯内容算出（E-286）
	const verdict = deriveWrapupVerdict({
		testsStatus: tests.status,
		bugs,
		fixedIds,
		notFixed,
		unassigned,
	});

	// 汇总所有 findings（包括 bugs, notFixed 以及测试失败项）
	const findings = Object.freeze([...testFailures, ...bugs, ...notFixed]);

	return Object.freeze({
		ok: true,
		sections: Object.freeze(sections),
		summaryText: sections.BATCH_SUMMARY,
		tests,
		bugs: Object.freeze(bugs),
		fixed: fixedItems,
		notFixed,
		suspectText: sections.SUSPECT,
		recordText: sections.RECORD,
		nextText: sections.NEXT,
		declaredVerdict,
		verdict,
		unassigned,
		rawText: text,
		findings,
	});
}

/**
 * 把开放项（TESTS 失败 ∪ BUGS∖FIXED ∪ NOT_FIXED）按任务分组、重编号 R1... 而原文逐字保留，未知任务归 unassigned（AC 4 / E-290）。
 */
export function planWrapupFixes(
	input:
		| ParsedWrapupReportSuccess
		| {
				readonly findings: readonly WrapupFinding[];
				readonly unassigned: readonly string[];
		  },
	options?: {
		readonly knownTaskKeys?: Iterable<string>;
	},
): PlannedWrapupFixes {
	const knownSet = options?.knownTaskKeys ? new Set(options.knownTaskKeys) : null;

	// 1. 过滤开放项：TESTS 失败 ∪ BUGS∖FIXED ∪ NOT_FIXED
	let openCandidates: WrapupFinding[] = [];
	let baseUnassigned: readonly string[] = [];

	if ('ok' in input && input.ok) {
		const testFailures = input.findings.filter((f) => f.kind === 'test_failure');
		const unfixedBugs = input.bugs.filter((b) => !b.isFixed);
		const notFixed = input.notFixed;
		openCandidates = [...testFailures, ...unfixedBugs, ...notFixed];
		baseUnassigned = input.unassigned;
	} else {
		openCandidates = input.findings.filter((f) => {
			if (f.kind === 'test_failure') return true;
			if (f.kind === 'bug') return !f.isFixed;
			if (f.kind === 'not_fixed') return true;
			return false;
		});
		baseUnassigned = input.unassigned;
	}

	const unassigned: string[] = [...baseUnassigned];
	const groupsMap = new Map<string, WrapupFinding[]>();

	// 2. 按任务分组，未知任务归 unassigned（E-290）
	for (const item of openCandidates) {
		const taskKey = item.taskKey;
		if (!taskKey || (knownSet !== null && !knownSet.has(taskKey))) {
			// 未知任务归 unassigned，原文逐字保留
			unassigned.push(item.raw);
		} else {
			const existing = groupsMap.get(taskKey) ?? [];
			existing.push(item);
			groupsMap.set(taskKey, existing);
		}
	}

	// 3. 各组内重编号 R1...，原文逐字保留
	const groups: WrapupFixGroup[] = [];
	for (const [taskKey, findings] of groupsMap.entries()) {
		const crossBatch = findings.some((f) => f.crossBatch);
		const items: WrapupFixItem[] = findings.map((finding, idx) =>
			Object.freeze({
				id: `R${idx + 1}`,
				index: idx + 1,
				originalId: finding.id,
				raw: finding.raw,
				crossBatch: finding.crossBatch,
				finding,
			}),
		);

		groups.push(
			Object.freeze({
				taskKey,
				crossBatch,
				items: Object.freeze(items),
			}),
		);
	}

	const totalOpenCount = groups.reduce((acc, g) => acc + g.items.length, 0) + unassigned.length;

	return Object.freeze({
		groups: Object.freeze(groups),
		unassigned: Object.freeze(unassigned),
		totalOpenCount,
	});
}
