import {
	type SeverityLevel,
	type WrapupFinding,
	type WrapupFixedItem,
	isNoneIndicator,
	parseBugSection,
	parseFixedSection,
} from './wrapup-report.ts';

/**
 * 查 bug 报告标准五段模板名称及其严格顺序（08 节, AC 3, E-320）。
 */
export const BUGHUNT_SECTIONS = ['BUGS', 'FIXED', 'NOT_FIXED', 'SUSPECT', 'NEXT'] as const;

export type BughuntSectionName = (typeof BUGHUNT_SECTIONS)[number];

export interface ParsedBughuntReportSuccess {
	readonly ok: true;
	readonly sections: Readonly<Record<BughuntSectionName, string>>;
	readonly bugs: readonly WrapupFinding[];
	readonly fixed: readonly WrapupFixedItem[];
	readonly notFixed: readonly WrapupFinding[];
	readonly suspect: readonly string[];
	readonly next: readonly string[];
	readonly maxOpenSeverity: SeverityLevel | null;
	readonly rawText: string;
}

export interface ParsedBughuntReportFailure {
	readonly ok: false;
	readonly missingSections: readonly BughuntSectionName[];
	readonly rawText: string;
	readonly error: string;
}

export type ParsedBughuntReport = ParsedBughuntReportSuccess | ParsedBughuntReportFailure;

export interface DecideBughuntOutcomeInput {
	readonly report: ParsedBughuntReportSuccess;
	readonly hasWorkspaceDiff: boolean;
	readonly reworkCount: number;
}

export type BughuntOutcome =
	| {
			readonly outcome: 'rereview';
			readonly fixedItems: readonly string[];
			readonly newReworkCount: number;
	  }
	| {
			readonly outcome: 'awaiting_human';
			readonly reason: 'bughunt_open_findings' | 'bughunt_fixed_over_limit';
			readonly comment: string;
			readonly fixedItems?: readonly string[];
			readonly notFixedItems?: readonly string[];
			readonly selfReportedFixedNoDiff?: boolean;
	  }
	| {
			readonly outcome: 'gate';
	  };

function createSectionHeaderRegex(name: BughuntSectionName): RegExp {
	return new RegExp(
		`^\\s*(?:#{1,6}\\s+)?(?:\\d+[.、]\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*[:：]?\\s*$`,
		'i',
	);
}

const SECTION_REGEX_MAP: Record<BughuntSectionName, RegExp> = {
	BUGS: createSectionHeaderRegex('BUGS'),
	FIXED: createSectionHeaderRegex('FIXED'),
	NOT_FIXED: createSectionHeaderRegex('NOT_FIXED'),
	SUSPECT: createSectionHeaderRegex('SUSPECT'),
	NEXT: createSectionHeaderRegex('NEXT'),
};

interface MatchedHeaderLine {
	readonly lineIndex: number;
	readonly section: BughuntSectionName;
	readonly rawLine: string;
}

function unwrapOuterFences(text: string): string {
	const trimmed = text.trim();
	const fenceMatch = /^(`{3,}|~{3,})[^\n]*\r?\n([\s\S]*?)\r?\n\1\s*$/.exec(trimmed);
	if (fenceMatch?.[2]) {
		return fenceMatch[2];
	}
	return text;
}

function findHeaderLines(lines: readonly string[]): MatchedHeaderLine[] {
	const result: MatchedHeaderLine[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		for (const section of BUGHUNT_SECTIONS) {
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

function findCompleteSectionGroups(headers: readonly MatchedHeaderLine[]): MatchedHeaderLine[][] {
	const completeGroups: MatchedHeaderLine[][] = [];

	const bugsIndices: number[] = [];
	for (let i = 0; i < headers.length; i++) {
		const item = headers[i];
		if (item && item.section === 'BUGS') {
			bugsIndices.push(i);
		}
	}

	for (const startIndex of bugsIndices) {
		const startHeader = headers[startIndex];
		if (!startHeader) continue;

		const group: MatchedHeaderLine[] = [startHeader];
		let expectedSectionIdx = 1;
		let currentLineIdx = startHeader.lineIndex;

		for (
			let i = startIndex + 1;
			i < headers.length && expectedSectionIdx < BUGHUNT_SECTIONS.length;
			i++
		) {
			const candidate = headers[i];
			const expectedSection = BUGHUNT_SECTIONS[expectedSectionIdx];
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

		if (group.length === BUGHUNT_SECTIONS.length) {
			completeGroups.push(group);
		}
	}

	return completeGroups;
}

function computeMissingSections(headers: readonly MatchedHeaderLine[]): BughuntSectionName[] {
	let lastBugsIndex = -1;
	for (let i = 0; i < headers.length; i++) {
		if (headers[i]?.section === 'BUGS') {
			lastBugsIndex = i;
		}
	}

	if (lastBugsIndex === -1) {
		const present = new Set(headers.map((h) => h.section));
		return BUGHUNT_SECTIONS.filter((s) => !present.has(s));
	}

	const headersAfterBugs = headers.slice(lastBugsIndex);
	const missing: BughuntSectionName[] = [];
	let currentLineIdx = headers[lastBugsIndex]?.lineIndex ?? -1;

	for (let i = 1; i < BUGHUNT_SECTIONS.length; i++) {
		const targetSec = BUGHUNT_SECTIONS[i];
		if (!targetSec) continue;

		const found = headersAfterBugs.find(
			(h) => h.section === targetSec && h.lineIndex > currentLineIdx,
		);
		if (found) {
			currentLineIdx = found.lineIndex;
		} else {
			missing.push(targetSec);
		}
	}

	return missing;
}

/**
 * 解析查 bug 运行输出的五段报告（AC 5, E-320, 08 节）。
 *
 * 段头须独立成行，取最后一个 BUGS 之后能按严格模板顺序找齐五段的那一组。
 * 找不齐返回 ok:false 与精确缺段清单，不做部分解析、不猜（E-320）。
 */
export function parseBughuntReport(rawText: string): ParsedBughuntReport {
	const text = rawText ?? '';
	const unwrapped = unwrapOuterFences(text);

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

	if (completeGroups.length === 0) {
		const missingSections = computeMissingSections(headers);
		return Object.freeze({
			ok: false,
			missingSections: Object.freeze(missingSections),
			rawText: text,
			error: `Missing required bughunt report sections: ${missingSections.join(', ')}`,
		});
	}

	const group = completeGroups[completeGroups.length - 1];
	if (!group) {
		const missingSections = computeMissingSections(headers);
		return Object.freeze({
			ok: false,
			missingSections: Object.freeze(missingSections),
			rawText: text,
			error: `Missing required bughunt report sections: ${missingSections.join(', ')}`,
		});
	}

	const sections: Record<BughuntSectionName, string> = {
		BUGS: '',
		FIXED: '',
		NOT_FIXED: '',
		SUSPECT: '',
		NEXT: '',
	};

	for (let i = 0; i < BUGHUNT_SECTIONS.length; i++) {
		const secName = BUGHUNT_SECTIONS[i];
		const currHeader = group[i];
		if (!secName || !currHeader) continue;

		const startLine = currHeader.lineIndex + 1;
		const nextHeader = i + 1 < BUGHUNT_SECTIONS.length ? group[i + 1] : undefined;
		const endLine = nextHeader ? nextHeader.lineIndex : lines.length;

		let secLines = lines.slice(startLine, endLine);
		if (secName === 'NEXT' && secLines.length > 0) {
			const last = (secLines[secLines.length - 1] ?? '').trim();
			if (/^`{3,}|~{3,}$/.test(last)) {
				secLines = secLines.slice(0, -1);
			}
		}

		sections[secName] = secLines.join('\n').trim();
	}

	const { findings: rawBugs } = parseBugSection(sections.BUGS, 'bug');
	const fixed = parseFixedSection(sections.FIXED);
	const { findings: rawNotFixed } = parseBugSection(sections.NOT_FIXED, 'not_fixed');

	const fixedIds = new Set(fixed.map((f) => f.id));
	const bugs: WrapupFinding[] = rawBugs.map((b) =>
		Object.freeze({
			...b,
			isFixed: fixedIds.has(b.id),
		}),
	);

	// 解析 SUSPECT 与 NEXT 为行列表（过滤 none / 空行）
	const suspect = sections.SUSPECT.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !isNoneIndicator(l));

	const next = sections.NEXT.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !isNoneIndicator(l));

	// 计算 maxOpenSeverity
	// 开放项：notFixed 全部 + bugs 中未在 FIXED 修复的
	const openFindings: WrapupFinding[] = [...rawNotFixed, ...bugs.filter((b) => !b.isFixed)];

	let maxOpenSeverity: SeverityLevel | null = null;
	for (const f of openFindings) {
		const sev = f.severity?.toUpperCase();
		if (sev === 'S1') {
			maxOpenSeverity = 'S1';
			break;
		}
		if (sev === 'S2') {
			maxOpenSeverity = 'S2';
		} else if (sev === 'S3' && !maxOpenSeverity) {
			maxOpenSeverity = 'S3';
		}
	}

	return Object.freeze({
		ok: true,
		sections: Object.freeze(sections),
		bugs: Object.freeze(bugs),
		fixed: Object.freeze(fixed),
		notFixed: Object.freeze(rawNotFixed),
		suspect: Object.freeze(suspect),
		next: Object.freeze(next),
		maxOpenSeverity,
		rawText: text,
	});
}

/**
 * 根据五段解析结果与工作区状态推导查 bug 结果（AC 4, E-307, E-308, E-321）。
 *
 * 六种判定组合（17 节）：
 * 1. FIXED 非空且相对起点树 diff 非空（且 NOT_FIXED 无 S1/S2、reworkCount < 2）→ rereview
 * 2. FIXED 非空但 diff 为空 → 按 NOT_FIXED 处理（缺严重度按 S2），走 E-308（自报已修但无改动）
 * 3. NOT_FIXED 含 S1/S2 → open_findings
 * 4. 只剩 S3（且 FIXED 为空）→ gate
 * 5. 全空（干净）→ gate
 * 6. rereview 且 reworkCount >= 2 → rework_limit (bughunt_fixed_over_limit)
 */
export function decideBughuntOutcome(input: DecideBughuntOutcomeInput): BughuntOutcome {
	const { report, hasWorkspaceDiff, reworkCount } = input;

	const fixedCount = report.fixed.length;

	// 1. FIXED 非空但工作区无改动：按 NOT_FIXED 处理（沿用自报严重度，缺严重度按 S2，E-321）
	if (fixedCount > 0 && !hasWorkspaceDiff) {
		const notFixedItems: string[] = [
			...report.notFixed.map((n) => n.raw),
			...report.fixed.map((f) => `${f.raw} (自报已修但无改动)`),
		];
		return Object.freeze({
			outcome: 'awaiting_human',
			reason: 'bughunt_open_findings',
			comment: 'bughunt_open_findings: 自报已修但无改动',
			selfReportedFixedNoDiff: true,
			fixedItems: report.fixed.map((f) => f.raw),
			notFixedItems: Object.freeze(notFixedItems),
		});
	}

	// 2. 检查 NOT_FIXED 或未修 BUGS 是否含 S1/S2
	// E-307: FIXED 非空且 NOT_FIXED 含 S1/S2：直接转人、不先再审
	const hasHighSeverityOpen = report.maxOpenSeverity === 'S1' || report.maxOpenSeverity === 'S2';

	if (hasHighSeverityOpen) {
		return Object.freeze({
			outcome: 'awaiting_human',
			reason: 'bughunt_open_findings',
			comment: 'bughunt_open_findings',
			fixedItems: fixedCount > 0 ? report.fixed.map((f) => f.raw) : undefined,
			notFixedItems: report.notFixed.map((n) => n.raw),
		});
	}

	// 3. FIXED 非空且工作区 diff 非空
	if (fixedCount > 0 && hasWorkspaceDiff) {
		if (reworkCount < 2) {
			return Object.freeze({
				outcome: 'rereview',
				fixedItems: report.fixed.map((f) => f.raw),
				newReworkCount: reworkCount + 1,
			});
		}

		// reworkCount 已达 2: 转 awaiting_human，闸门 comment bughunt_fixed_over_limit (AC 4, E-307)
		return Object.freeze({
			outcome: 'awaiting_human',
			reason: 'bughunt_fixed_over_limit',
			comment: 'bughunt_fixed_over_limit',
			fixedItems: report.fixed.map((f) => f.raw),
		});
	}

	// 4. 其余：BUGS 为空或只剩 S3 且 FIXED 为空 → 干净，直接走落地闸门（E-308, E-321）
	return Object.freeze({
		outcome: 'gate',
	});
}

/** 别名导出（与 08 节文档命名兼容） */
export const deriveBughuntOutcome = decideBughuntOutcome;
