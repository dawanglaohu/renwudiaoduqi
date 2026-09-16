import type { RunState } from './run-state-machine.ts';

/**
 * 合法的三态判定值（09 节数据模型与 runs.review_verdict 列契约）。
 * pass: 审查通过
 * rework: 审查未通过，需要返工
 * doc_issue: 文档契约或需求定义问题
 * incomplete: 审查未完成（崩溃、超时、未结构化、输出异常）
 */
export const REVIEW_VERDICTS = ['pass', 'rework', 'doc_issue', 'incomplete'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/**
 * 界面与状态机标签常量（E-62, E-63, E-64, E-278）。
 */
export const REVIEW_INCOMPLETE_TAG = '审查未完成' as const; // E-62, E-63
export const UNSTRUCTURED_REWORK_TAG = '未结构化' as const; // E-278
export const REVIEW_PASSED_TAG = '通过' as const;
export const REVIEW_REWORK_TAG = '返工' as const;
export const REVIEW_DOC_ISSUE_TAG = '文档问题' as const; // E-64

/**
 * 结构化的返工条目（- R<n>）。
 */
export interface ReworkItem {
	/** 编号，例如 "R1" 或 "R2" */
	readonly id: string;
	/** 序号数字，例如 1 或 2 */
	readonly index: number;
	/** 完整条目内容（包含多行细节） */
	readonly text: string;
}

/**
 * 最后一个 VERDICT: 行提取结果。
 */
export interface ExtractedVerdictLine {
	/** 原始行字符串，若未提取到则为 null */
	readonly rawLine: string | null;
	/** VERDICT: 冒号后的原始值 */
	readonly rawValue: string | null;
	/** 归一化后的判定值（仅 pass | rework | doc_issue，否则为 null） */
	readonly normalizedVerdict: ReviewVerdict | null;
}

/**
 * 审查判定解析结果（AC 1-4, E-62, E-63, E-64, E-278）。
 */
export interface ParsedReviewVerdict {
	/**
	 * 归一化判定值：pass | rework | doc_issue | incomplete
	 */
	readonly verdict: ReviewVerdict;

	/**
	 * 是否为结构化裁定（E-278）。
	 * 当 VERDICT 为 rework 但围栏块与 REWORK 段均解析不出 R 条目时为 false（未结构化），此时 verdict 置 incomplete。
	 * pass 却带 R 条目或输出格式非法时也置 false。
	 */
	readonly isStructured: boolean;

	/**
	 * 返工文本（写入 runs.rework_text，不截断）。
	 * - rework 且有围栏：围栏内原文（围栏优先）。
	 * - rework 且无围栏但有 REWORK 条目：条目全文。
	 * - 未结构化（rework 无 R 条目）或解析失败：原文全文（rawText）。
	 * - pass 带 R 条目矛盾：原文全文（rawText）。
	 * - doc-issue 或 pass 无条目：null。
	 */
	readonly reworkText: string | null;

	/**
	 * 最后一个 `rework` 围栏块的内容（若存在）。
	 */
	readonly reworkFence: string | null;

	/**
	 * REWORK 段解析出的 R 条目全文数组。
	 */
	readonly reworkSectionItems: readonly string[];

	/**
	 * 围栏块解析出的 R 条目结构化对象数组。
	 */
	readonly fenceRItems: readonly ReworkItem[];

	/**
	 * REWORK 段解析出的 R 条目结构化对象数组。
	 */
	readonly sectionRItems: readonly ReworkItem[];

	/**
	 * 综合 R 条目清单（若有围栏且围栏有 R 条目则优先取围栏，否则取 REWORK 段）。
	 */
	readonly rItems: readonly ReworkItem[];

	/**
	 * DOC_ISSUE 段提取的内容（若存在）。
	 */
	readonly docIssueText: string | null;

	/**
	 * 原始审查输出文本。
	 */
	readonly rawText: string;

	/**
	 * 最后一个 `VERDICT:` 提取到的原始字符串。
	 */
	readonly rawVerdict: string | null;

	/**
	 * 不一致项列表（例如 ['pass_with_rework_items']）。
	 */
	readonly inconsistencies: readonly string[];

	/**
	 * 机器判定原因标识（如 'verdict_pass', 'verdict_rework', 'doc_issue', 'unstructured_rework', 'unrecognized_verdict', 'missing_verdict', 'pass_with_rework_items', 'agent_crashed', 'agent_timed_out' 等）。
	 */
	readonly reason: string;

	/**
	 * 展示用标签（'通过' | '返工' | '文档问题' | '未结构化' | '审查未完成' 等）。
	 */
	readonly tag: string;

	/**
	 * 是否应触发自动返工（E-64, E-278）。
	 * 仅当 verdict === 'rework' 且 isStructured === true 时为 true。
	 * doc-issue 恒为 false（E-64：停止对该任务的自动 rework，汇总意见给用户）。
	 * incomplete 恒为 false。
	 */
	readonly shouldAutoRework: boolean;

	/**
	 * 建议目标运行状态（'reworking' | 'awaiting_human' | 'landed'）。
	 * doc-issue、incomplete、未结构化均转 'awaiting_human'（转人工）。
	 */
	readonly targetState: Extract<RunState, 'reworking' | 'awaiting_human' | 'landed'>;
}

/**
 * 审查运行评定入参（包含进程级退出状态与原始输出，E-62）。
 */
export interface ReviewEvaluationInput {
	/** 审查 agent 输出的原始文本 */
	readonly outputText?: string | null;
	/** 审查子进程退出码 */
	readonly exitCode?: number | null;
	/** 是否超时（E-62） */
	readonly timedOut?: boolean;
	/** 是否崩溃或异常终止（E-62） */
	readonly crashed?: boolean;
	/** 致命异常标志 */
	readonly hasFatalError?: boolean;
	/** 退出原因 */
	readonly exitReason?: string | null;
	/** 错误对象 */
	readonly error?: unknown;
}

/**
 * 正则表达式定义。
 * 严格禁止按关键词（「不通过」「有问题」等）判定 rework，必须唯一依赖 VERDICT 行与 R 条目解析（E-278）。
 */
const VERDICT_LINE_REGEX = /^\s*(?:#{1,6}\s+)?(?:\*\*)?VERDICT(?:\*\*)?\s*:\s*(.*?)\s*$/gim;
const R_ITEM_START_REGEX = /^\s*(?:[-*]|\d+\.)?\s*R[〈<]?(\d+)[〉>]?(?:[:\s\p{P}]|$)/u;

/**
 * 提取文本中最后一个 VERDICT: 行（AC 4）。
 */
export function extractLastVerdict(text: string): ExtractedVerdictLine {
	if (!text) {
		return Object.freeze({ rawLine: null, rawValue: null, normalizedVerdict: null });
	}

	let lastMatch: RegExpExecArray | null = null;
	const regex = new RegExp(VERDICT_LINE_REGEX.source, VERDICT_LINE_REGEX.flags);
	let m = regex.exec(text);
	while (m !== null) {
		lastMatch = m;
		m = regex.exec(text);
	}

	if (!lastMatch) {
		return Object.freeze({ rawLine: null, rawValue: null, normalizedVerdict: null });
	}

	const rawLine = lastMatch[0].trim();
	const rawMatchedValue = lastMatch[1] ?? '';
	const rawValue = rawMatchedValue.replace(/^[*_`#\s]+|[*_`#\s.,;]+$/g, '').trim();
	const normalizedVerdict = normalizeVerdictToken(rawValue);

	return Object.freeze({
		rawLine,
		rawValue: rawValue.length > 0 ? rawValue : null,
		normalizedVerdict,
	});
}

/**
 * 将 VERDICT 候选值归一化为三态（pass | rework | doc_issue）之一，非法值返回 null（E-63）。
 */
function normalizeVerdictToken(token: string): ReviewVerdict | null {
	if (!token) return null;
	const cleaned = token.toLowerCase().replace(/[-_\s]/g, '');
	if (cleaned === 'pass') return 'pass';
	if (cleaned === 'rework') return 'rework';
	if (cleaned === 'docissue') return 'doc_issue';
	return null;
}

/**
 * 提取文本中最后一个 ```rework 围栏块内容（AC 4）。
 * 围栏语言固定为 rework，支持 3 个或更多反引号/波浪号。
 */
export function extractLastReworkFence(text: string): string | null {
	if (!text) return null;
	const fenceRegex = /(?:^|\n)([`~]{3,})\s*rework\b[^\n]*\n([\s\S]*?)(?:\n\1[`~]*\s*(?=\n|$)|$)/gi;
	let lastContent: string | null = null;
	let m = fenceRegex.exec(text);
	while (m !== null) {
		lastContent = m[2] ?? null;
		m = fenceRegex.exec(text);
	}
	if (lastContent === null) return null;
	return lastContent.replace(/^\n+|\n+$/g, '');
}

/**
 * 提取文本中的 REWORK 报告段（AC 4）。
 * 从 REWORK 标题开始，到下一个已知大段标题、一级/二级标题或围栏块之前。
 */
export function extractReworkSection(text: string): string | null {
	if (!text) return null;
	const lines = text.split(/\r?\n/);
	let inRework = false;
	const sectionLines: string[] = [];

	const reworkHeaderRegex = /^\s*(?:#{1,6}\s+)?(?:\d+\.\s*)?(?:\*\*)?REWORK(?:\*\*)?\s*$/i;
	const nextSectionHeaderRegex =
		/^\s*(?:#{1,6}\s+)?(?:\d+\.\s*)?(?:\*\*)?(?:FIXED_BY_REVIEWER|FOLLOW_UP|NEXT|OUT_OF_SCOPE|DOC_ISSUE|DOC_PATCH|ACCEPTANCE|EDGES|VAULT|ROUND|VERDICT)(?:\*\*)?\s*$/i;

	for (const line of lines) {
		if (!inRework) {
			if (reworkHeaderRegex.test(line)) {
				inRework = true;
			}
			continue;
		}

		if (nextSectionHeaderRegex.test(line) || /^\s*[`~]{3,}\s*rework\b/i.test(line)) {
			break;
		}
		if (/^\s*#{1,2}\s+/.test(line)) {
			break;
		}

		sectionLines.push(line);
	}

	if (!inRework || sectionLines.length === 0) return null;
	const joined = sectionLines.join('\n').trim();
	return joined.length > 0 ? joined : null;
}

/**
 * 提取文本中的 DOC_ISSUE 报告段（AC 3, E-64）。
 */
export function extractDocIssueSection(text: string): string | null {
	if (!text) return null;
	const lines = text.split(/\r?\n/);
	let inDocIssue = false;
	const sectionLines: string[] = [];

	const docIssueHeaderRegex = /^\s*(?:#{1,6}\s+)?(?:\d+\.\s*)?(?:\*\*)?DOC_ISSUE(?:\*\*)?\s*$/i;
	const nextSectionHeaderRegex =
		/^\s*(?:#{1,6}\s+)?(?:\d+\.\s*)?(?:\*\*)?(?:REWORK|FIXED_BY_REVIEWER|FOLLOW_UP|NEXT|OUT_OF_SCOPE|DOC_PATCH|ACCEPTANCE|EDGES|VAULT|ROUND|VERDICT)(?:\*\*)?\s*$/i;

	for (const line of lines) {
		if (!inDocIssue) {
			if (docIssueHeaderRegex.test(line)) {
				inDocIssue = true;
			}
			continue;
		}

		if (nextSectionHeaderRegex.test(line) || /^\s*[`~]{3,}/i.test(line)) {
			break;
		}
		if (/^\s*#{1,2}\s+/.test(line)) {
			break;
		}

		sectionLines.push(line);
	}

	if (!inDocIssue || sectionLines.length === 0) return null;
	const joined = sectionLines.join('\n').trim();
	if (/^(?:[-*]\s*)?(?:none|无|none\.)\s*$/i.test(joined)) {
		return null;
	}
	return joined.length > 0 ? joined : null;
}

/**
 * 解析文本中包含的 - R<n> 条目（包含跨多行的完整条目内容）。
 */
export function parseReworkItems(text: string): readonly ReworkItem[] {
	if (!text) return Object.freeze([]);
	const lines = text.split(/\r?\n/);
	const items: ReworkItem[] = [];
	let currentItem: { id: string; index: number; lines: string[] } | null = null;

	for (const line of lines) {
		const trimmed = line.trim();
		if (/^[-*]?\s*(?:none|无|none\.)\s*$/i.test(trimmed)) {
			continue;
		}

		const match = R_ITEM_START_REGEX.exec(line);
		if (match) {
			if (currentItem) {
				items.push(
					Object.freeze({
						id: currentItem.id,
						index: currentItem.index,
						text: currentItem.lines.join('\n').trimEnd(),
					}),
				);
			}
			const index = Number.parseInt(match[1] ?? '0', 10);
			currentItem = {
				id: `R${index}`,
				index,
				lines: [line],
			};
		} else if (currentItem) {
			currentItem.lines.push(line);
		}
	}

	if (currentItem) {
		items.push(
			Object.freeze({
				id: currentItem.id,
				index: currentItem.index,
				text: currentItem.lines.join('\n').trimEnd(),
			}),
		);
	}

	return Object.freeze(items);
}

/**
 * 解析审查输出文本的核心函数（AC 1, AC 3, AC 4, E-63, E-64, E-278）。
 * 提取最后一个 VERDICT: 行、REWORK 段的 - R<n> 条目、最后一个 rework 围栏块。
 * 遵循三态判定、返工文本围栏优先、未结构化标 incomplete 并保留原文转人工。
 */
export function parseReviewVerdict(rawText: string): ParsedReviewVerdict {
	const text = rawText ?? '';
	const verdictLineInfo = extractLastVerdict(text);
	const reworkFence = extractLastReworkFence(text);
	const reworkSection = extractReworkSection(text);
	const docIssueText = extractDocIssueSection(text);

	const fenceRItems = parseReworkItems(reworkFence ?? '');
	const sectionRItems = parseReworkItems(reworkSection ?? '');
	const reworkSectionItems = Object.freeze(sectionRItems.map((item) => item.text));

	// 1. 输出不符合 pass/rework/doc-issue 三态（AC 1, E-63）
	// 不存在有效 VERDICT 行或值无法识别，按「审查未完成」处理并保留原文，不猜测语义
	if (verdictLineInfo.normalizedVerdict === null) {
		const rItems = fenceRItems.length > 0 ? fenceRItems : sectionRItems;
		return Object.freeze({
			verdict: 'incomplete',
			isStructured: false,
			reworkText: text, // 保留原文全文，不截断
			reworkFence,
			reworkSectionItems,
			fenceRItems,
			sectionRItems,
			rItems,
			docIssueText,
			rawText: text,
			rawVerdict: verdictLineInfo.rawLine,
			inconsistencies: Object.freeze(
				verdictLineInfo.rawLine ? ['unrecognized_verdict'] : ['missing_verdict'],
			),
			reason: verdictLineInfo.rawLine ? 'unrecognized_verdict' : 'missing_verdict',
			tag: REVIEW_INCOMPLETE_TAG,
			shouldAutoRework: false,
			targetState: 'awaiting_human',
		});
	}

	const normalizedVerdict = verdictLineInfo.normalizedVerdict;

	// 2. doc-issue 判定（AC 3, AC 4, E-64）
	// doc-issue 忽略围栏；停止对该任务的自动 rework，汇总意见给用户，不让 agent 反复改代码
	if (normalizedVerdict === 'doc_issue') {
		return Object.freeze({
			verdict: 'doc_issue',
			isStructured: true,
			reworkText: null, // 忽略围栏，不产生自动返工文本
			reworkFence: null, // doc-issue 忽略围栏
			reworkSectionItems,
			fenceRItems: Object.freeze([]),
			sectionRItems,
			rItems: Object.freeze([]),
			docIssueText,
			rawText: text,
			rawVerdict: verdictLineInfo.rawLine,
			inconsistencies: Object.freeze([]),
			reason: 'doc_issue',
			tag: REVIEW_DOC_ISSUE_TAG,
			shouldAutoRework: false, // 停止自动返工
			targetState: 'awaiting_human',
		});
	}

	// 3. pass 判定（AC 4）
	// pass 却带 R 条目 → inconsistencies 按 incomplete 处理
	if (normalizedVerdict === 'pass') {
		const hasRItems = fenceRItems.length > 0 || sectionRItems.length > 0;
		if (hasRItems) {
			const rItems = fenceRItems.length > 0 ? fenceRItems : sectionRItems;
			return Object.freeze({
				verdict: 'incomplete',
				isStructured: false,
				reworkText: text, // 原文全文存 rework_text
				reworkFence,
				reworkSectionItems,
				fenceRItems,
				sectionRItems,
				rItems,
				docIssueText,
				rawText: text,
				rawVerdict: verdictLineInfo.rawLine,
				inconsistencies: Object.freeze(['pass_with_rework_items']),
				reason: 'pass_with_rework_items',
				tag: REVIEW_INCOMPLETE_TAG,
				shouldAutoRework: false,
				targetState: 'awaiting_human',
			});
		}

		return Object.freeze({
			verdict: 'pass',
			isStructured: true,
			reworkText: null,
			reworkFence: null,
			reworkSectionItems: Object.freeze([]),
			fenceRItems: Object.freeze([]),
			sectionRItems: Object.freeze([]),
			rItems: Object.freeze([]),
			docIssueText,
			rawText: text,
			rawVerdict: verdictLineInfo.rawLine,
			inconsistencies: Object.freeze([]),
			reason: 'verdict_pass',
			tag: REVIEW_PASSED_TAG,
			shouldAutoRework: false,
			targetState: 'landed',
		});
	}

	// 4. rework 判定（AC 4, E-278）
	// VERDICT 为 rework 但两处都没有 R 条目 → review_verdict='incomplete' 标「未结构化」、原文全文存 rework_text 转人
	const hasFenceRItems = fenceRItems.length > 0;
	const hasSectionRItems = sectionRItems.length > 0;

	if (!hasFenceRItems && !hasSectionRItems) {
		return Object.freeze({
			verdict: 'incomplete',
			isStructured: false,
			reworkText: text, // 原文全文存 rework_text，不截断
			reworkFence,
			reworkSectionItems,
			fenceRItems,
			sectionRItems,
			rItems: Object.freeze([]),
			docIssueText,
			rawText: text,
			rawVerdict: verdictLineInfo.rawLine,
			inconsistencies: Object.freeze(['rework_without_r_items']),
			reason: 'unstructured_rework',
			tag: UNSTRUCTURED_REWORK_TAG,
			shouldAutoRework: false,
			targetState: 'awaiting_human',
		});
	}

	// 返工文本围栏优先、其次条目全文，落 runs.rework_text 不截断
	let reworkText: string;
	let rItems: readonly ReworkItem[];

	if (hasFenceRItems && reworkFence && reworkFence.trim().length > 0) {
		reworkText = reworkFence;
		rItems = fenceRItems;
	} else if (reworkFence && reworkFence.trim().length > 0) {
		// 围栏存在且有内容，围栏优先
		reworkText = reworkFence;
		rItems = sectionRItems;
	} else {
		// 其次条目全文
		reworkText = sectionRItems.map((item) => item.text).join('\n\n');
		rItems = sectionRItems;
	}

	return Object.freeze({
		verdict: 'rework',
		isStructured: true,
		reworkText,
		reworkFence,
		reworkSectionItems,
		fenceRItems,
		sectionRItems,
		rItems,
		docIssueText,
		rawText: text,
		rawVerdict: verdictLineInfo.rawLine,
		inconsistencies: Object.freeze([]),
		reason: 'verdict_rework',
		tag: REVIEW_REWORK_TAG,
		shouldAutoRework: true,
		targetState: 'reworking',
	});
}

/**
 * 评估审查运行结果（包含进程崩溃、超时及输出解析，AC 1-4, E-62, E-63, E-64, E-278）。
 * 审查 agent 崩溃或超时时既不算 pass 也不算 fail，标「审查未完成」转人工，任何情况下不默认放行（E-62）。
 */
export function evaluateReviewVerdict(input: ReviewEvaluationInput | string): ParsedReviewVerdict {
	if (typeof input === 'string') {
		return parseReviewVerdict(input);
	}

	const outputText = input.outputText ?? '';

	// 1. 检查超时（AC 2, E-62）
	const isTimedOut =
		input.timedOut === true ||
		input.exitReason === 'timeout' ||
		input.exitReason === 'startup-timeout' ||
		input.exitReason === 'idle-timeout';

	if (isTimedOut) {
		return Object.freeze({
			verdict: 'incomplete',
			isStructured: false,
			reworkText: outputText.length > 0 ? outputText : null,
			reworkFence: null,
			reworkSectionItems: Object.freeze([]),
			fenceRItems: Object.freeze([]),
			sectionRItems: Object.freeze([]),
			rItems: Object.freeze([]),
			docIssueText: null,
			rawText: outputText,
			rawVerdict: null,
			inconsistencies: Object.freeze(['agent_timed_out']),
			reason: 'agent_timed_out',
			tag: REVIEW_INCOMPLETE_TAG,
			shouldAutoRework: false,
			targetState: 'awaiting_human',
		});
	}

	// 2. 检查崩溃或异常终止（AC 2, E-62）
	const isCrashed =
		input.crashed === true ||
		input.hasFatalError === true ||
		(input.exitCode !== null && input.exitCode !== undefined && input.exitCode !== 0) ||
		input.exitReason === 'spawn-failed' ||
		input.exitReason === 'crashed' ||
		input.exitReason === 'signal';

	if (isCrashed) {
		return Object.freeze({
			verdict: 'incomplete',
			isStructured: false,
			reworkText: outputText.length > 0 ? outputText : null,
			reworkFence: null,
			reworkSectionItems: Object.freeze([]),
			fenceRItems: Object.freeze([]),
			sectionRItems: Object.freeze([]),
			rItems: Object.freeze([]),
			docIssueText: null,
			rawText: outputText,
			rawVerdict: null,
			inconsistencies: Object.freeze(['agent_crashed']),
			reason: 'agent_crashed',
			tag: REVIEW_INCOMPLETE_TAG,
			shouldAutoRework: false,
			targetState: 'awaiting_human',
		});
	}

	// 3. 正常退出的输出解析（AC 1, AC 3, AC 4）
	return parseReviewVerdict(outputText);
}
