import { TERMINAL_RUN_STATES } from './run-state-machine.ts';

/**
 * 占位符常量：缺失时统一显示全角破折号，不得拿 0 冒充 (E-26)。
 */
export const TOKEN_MISSING_PLACEHOLDER = '—' as const;

/**
 * dsh 等无流式事件 agent 运行期提示文案 (E-253)。
 */
export const DSH_STREAMING_NOTICE = '该 agent 不提供过程输出，完成后一次性写入' as const;

/**
 * UI 呈现侧实际模型提示前缀 (E-37)。
 */
export const ACTUAL_MODEL_PREFIX = '实际使用：' as const;

/**
 * 规范化 Token 用量数据结构。
 * 遵循 E-26：缺失字段必须严格为 null，绝对不得拿 0 冒充。
 */
export interface TokenUsage {
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly totalTokens: number | null;
}

/**
 * Token 用量在 UI 呈现侧的字符串形式。
 * 遵循 E-26：任何字段缺失时显示「—」，不得拿 0 冒充。
 */
export interface TokenDisplay {
	readonly input: string;
	readonly output: string;
	readonly total: string;
	readonly summary: string;
}

/**
 * 模型提取与呈现信息。
 * 遵循 E-37：从首帧读回 agent 自报的实际模型并在与所选不一致时高亮。
 * 无首帧能力的 agent 保持未知（reportedModel: null, modelMismatch: false），不猜测。
 */
export interface ModelProgressInfo {
	readonly selectedModel: string | null;
	readonly reportedModel: string | null;
	readonly modelMismatch: boolean;
	readonly isMismatchHighlighted: boolean;
	readonly displayActualModel: string | null;
}

/**
 * 完整运行进度信号与通用字段快照。
 * 五家共用一套统一数据结构（codex, claude, pi, grok, dsh 及通用 agent）。
 */
export interface RunProgress {
	readonly runId: string | null;
	readonly agentId: string | null;
	readonly state: string | null;
	readonly isCompleted: boolean;
	readonly hasStreamingEvents: boolean;
	readonly stepDurationDegraded: boolean;
	readonly lastMessage: string | null;
	readonly changedFileCount: number | null;
	readonly durationMs: number | null;
	readonly durationText: string | null;
	readonly startedAt: string | null;
	readonly lastEventAt: string | null;
	readonly endedAt: string | null;
	readonly tokenUsage: TokenUsage | null;
	readonly tokenDisplay: TokenDisplay;
	readonly modelInfo: ModelProgressInfo;
	readonly streamingNotice: string | null;
}

/**
 * 传入进度提取器的输入配置。
 */
export interface ExtractProgressInput {
	readonly runId?: string | null;
	readonly agentId?: string | null;
	readonly state?: string | null;
	readonly selectedModel?: string | null;
	readonly hasStreamingEvents?: boolean;
	readonly startedAt?: string | null;
	readonly endedAt?: string | null;
	readonly now?: string | number | Date | null;
	readonly events?: readonly unknown[];
	readonly diffStat?: {
		readonly changedFileCount?: number | null;
		readonly filesChanged?: number | null;
		readonly files?: readonly unknown[];
	} | null;
	readonly changedFileCount?: number | null;
	readonly finalOutput?: string | null;
}

/**
 * 增量进度提取器接口，支持流式推进。
 */
export interface ProgressExtractor {
	pushEvent(event: unknown): void;
	setDiffStat(
		diff:
			| { readonly changedFileCount?: number | null; readonly filesChanged?: number | null }
			| number
			| null,
	): void;
	setState(state: string): void;
	complete(options?: { endedAt?: string; finalOutput?: string }): void;
	getProgress(now?: string | number | Date | null): RunProgress;
}

/**
 * 判断 agent 是否具备流式事件能力 (E-253)。
 * dsh headless 运行无流式事件（置假），其余内置 agent（codex, claude, pi, grok）默认为 true。
 */
export function hasStreamingCapability(agentId?: string | null, explicit?: boolean): boolean {
	if (explicit !== undefined && explicit !== null) {
		return Boolean(explicit);
	}
	if (!agentId || typeof agentId !== 'string') {
		return true;
	}
	const normalized = agentId.trim().toLowerCase();
	if (normalized === 'dsh' || normalized === 'deepseek-harness') {
		return false;
	}
	return true;
}

/**
 * 规范化整数 Token 计数。
 * 遵循 E-26：若为非法值、负数、NaN、null、undefined 或无法转为整数字符串，严格返回 null。
 */
function parseTokenCount(value: unknown): number | null {
	if (typeof value === 'number') {
		if (Number.isFinite(value) && value >= 0) {
			return Math.floor(value);
		}
		return null;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (/^\d+$/.test(trimmed)) {
			const parsed = Number.parseInt(trimmed, 10);
			return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
		}
		return null;
	}
	return null;
}

/**
 * 五家共用的通用 Token 用量提取纯函数。
 * 提取各家不一致的字段名（prompt_tokens, inputTokens, output_tokens 等）与嵌套层级。
 *
 * 遵循 E-26：
 * - 缺失时必须严格为 null，绝对不得拿 0 冒充。
 * - 若只有输入和输出，无总计，可计算 totalTokens = input + output。
 * - 若任一必要输入缺失，不得以 0 代替进行相加。
 */
export function extractTokenUsage(source: unknown): TokenUsage | null {
	if (!source || typeof source !== 'object') {
		return null;
	}

	const record = source as Record<string, unknown>;

	// 若为标准信封，解出 payload 对象以供探测
	const payload =
		record.payload && typeof record.payload === 'object'
			? (record.payload as Record<string, unknown>)
			: null;

	// 探测可能包含 token 统计的容器层级
	let target: Record<string, unknown> = payload ?? record;
	if (payload?.tokenUsage && typeof payload.tokenUsage === 'object') {
		target = payload.tokenUsage as Record<string, unknown>;
	} else if (payload?.usage && typeof payload.usage === 'object') {
		target = payload.usage as Record<string, unknown>;
	} else if (payload?.tokens && typeof payload.tokens === 'object') {
		target = payload.tokens as Record<string, unknown>;
	} else if (payload?.stats && typeof payload.stats === 'object') {
		target = payload.stats as Record<string, unknown>;
	} else if (record.tokenUsage && typeof record.tokenUsage === 'object') {
		target = record.tokenUsage as Record<string, unknown>;
	} else if (record.usage && typeof record.usage === 'object') {
		target = record.usage as Record<string, unknown>;
	} else if (record.tokens && typeof record.tokens === 'object') {
		target = record.tokens as Record<string, unknown>;
	} else if (record.stats && typeof record.stats === 'object') {
		target = record.stats as Record<string, unknown>;
	} else if (record.vendor && typeof record.vendor === 'object') {
		const vendor = record.vendor as Record<string, unknown>;
		if (vendor.usage && typeof vendor.usage === 'object') {
			target = vendor.usage as Record<string, unknown>;
		} else if (vendor.tokenUsage && typeof vendor.tokenUsage === 'object') {
			target = vendor.tokenUsage as Record<string, unknown>;
		} else if (vendor.tokens && typeof vendor.tokens === 'object') {
			target = vendor.tokens as Record<string, unknown>;
		}
	} else if (record.params && typeof record.params === 'object') {
		const params = record.params as Record<string, unknown>;
		if (params.update && typeof params.update === 'object') {
			const update = params.update as Record<string, unknown>;
			if (update.usage && typeof update.usage === 'object') {
				target = update.usage as Record<string, unknown>;
			} else if (update.tokenUsage && typeof update.tokenUsage === 'object') {
				target = update.tokenUsage as Record<string, unknown>;
			} else {
				target = update;
			}
		}
	}

	// 兼容各家输入字段变体
	const rawInput =
		target.prompt_tokens ??
		target.input_tokens ??
		target.promptTokens ??
		target.inputTokens ??
		target.input_token_count ??
		target.input_count ??
		target.input ??
		record.prompt_tokens ??
		record.input_tokens ??
		record.promptTokens ??
		record.inputTokens ??
		record.input_token_count ??
		record.input_count ??
		record.input;

	// 兼容各家输出字段变体
	const rawOutput =
		target.completion_tokens ??
		target.output_tokens ??
		target.completionTokens ??
		target.outputTokens ??
		target.output_token_count ??
		target.output_count ??
		target.output ??
		record.completion_tokens ??
		record.output_tokens ??
		record.completionTokens ??
		record.outputTokens ??
		record.output_token_count ??
		record.output_count ??
		record.output;

	// 兼容各家总计字段变体
	const rawTotal =
		target.total_tokens ??
		target.totalTokens ??
		target.total_token_count ??
		target.total_count ??
		target.total ??
		record.total_tokens ??
		record.totalTokens ??
		record.total_token_count ??
		record.total_count ??
		record.total;

	const inputTokens = parseTokenCount(rawInput);
	const outputTokens = parseTokenCount(rawOutput);
	let totalTokens = parseTokenCount(rawTotal);

	// 若未显式给出 totalTokens，但 inputTokens 与 outputTokens 均完整，则自然求和
	if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
		totalTokens = inputTokens + outputTokens;
	}

	if (inputTokens !== null || outputTokens !== null || totalTokens !== null) {
		return Object.freeze({
			inputTokens,
			outputTokens,
			totalTokens,
		});
	}

	// 若三者全部缺失，且没有任何 token 相关的已知键，判定为无 token信息
	const hasAnyTokenKey =
		'prompt_tokens' in target ||
		'input_tokens' in target ||
		'promptTokens' in target ||
		'inputTokens' in target ||
		'completion_tokens' in target ||
		'output_tokens' in target ||
		'completionTokens' in target ||
		'outputTokens' in target ||
		'total_tokens' in target ||
		'totalTokens' in target ||
		'tokenUsage' in record ||
		'usage' in record ||
		'tokens' in record ||
		(payload !== null &&
			('tokenUsage' in payload ||
				'usage' in payload ||
				'tokens' in payload ||
				'prompt_tokens' in payload ||
				'total_tokens' in payload));

	if (inputTokens === null && outputTokens === null && totalTokens === null && !hasAnyTokenKey) {
		return null;
	}

	return Object.freeze({
		inputTokens,
		outputTokens,
		totalTokens,
	});
}

/**
 * 格式化数字为千分位格式，保留纯净表示。
 */
function formatIntegerThousands(n: number): string {
	return n.toLocaleString('en-US');
}

/**
 * 格式化概要 token 数量（如 18.2k）。
 */
function formatTokenSummaryNumber(n: number): string {
	if (n < 1000) {
		return String(n);
	}
	const k = n / 1000;
	if (k < 10) {
		return `${k.toFixed(1)}k`;
	}
	return `${Math.round(k)}k`;
}

/**
 * 格式化 TokenDisplay 供呈现层使用。
 * 遵循 E-26：缺失时显示「—」，绝对不得拿 0 冒充。
 */
export function formatTokenDisplay(usage: TokenUsage | null | undefined): TokenDisplay {
	if (!usage) {
		return Object.freeze({
			input: TOKEN_MISSING_PLACEHOLDER,
			output: TOKEN_MISSING_PLACEHOLDER,
			total: TOKEN_MISSING_PLACEHOLDER,
			summary: TOKEN_MISSING_PLACEHOLDER,
		});
	}

	const input =
		usage.inputTokens !== null
			? formatIntegerThousands(usage.inputTokens)
			: TOKEN_MISSING_PLACEHOLDER;
	const output =
		usage.outputTokens !== null
			? formatIntegerThousands(usage.outputTokens)
			: TOKEN_MISSING_PLACEHOLDER;
	const total =
		usage.totalTokens !== null
			? formatIntegerThousands(usage.totalTokens)
			: TOKEN_MISSING_PLACEHOLDER;

	const summary =
		usage.totalTokens !== null
			? formatTokenSummaryNumber(usage.totalTokens)
			: TOKEN_MISSING_PLACEHOLDER;

	return Object.freeze({
		input,
		output,
		total,
		summary,
	});
}

/**
 * 从首帧事件提取 agent 自报的实际模型 (E-37)。
 *
 * 首帧特征：
 * - run.started 事件：payload.actualModel, payload.reportedModel, payload.model
 * - 原生初始化帧（如 claude 的 system/init）：payload.model, vendor.model
 *
 * 遵循 E-37：无首帧能力的 agent 保持未知（返回 null），不猜测。
 */
export function extractReportedModel(firstFrame: unknown): string | null {
	if (!firstFrame || typeof firstFrame !== 'object') {
		return null;
	}

	const obj = firstFrame as Record<string, unknown>;

	// 1. 标准 envelope 或包装事件 payload
	if (obj.payload && typeof obj.payload === 'object') {
		const payload = obj.payload as Record<string, unknown>;
		if (typeof payload.actualModel === 'string' && payload.actualModel.trim()) {
			return payload.actualModel.trim();
		}
		if (typeof payload.reportedModel === 'string' && payload.reportedModel.trim()) {
			return payload.reportedModel.trim();
		}
		if (typeof payload.model === 'string' && payload.model.trim()) {
			return payload.model.trim();
		}
		if (payload.vendor && typeof payload.vendor === 'object') {
			const vendor = payload.vendor as Record<string, unknown>;
			if (typeof vendor.model === 'string' && vendor.model.trim()) {
				return vendor.model.trim();
			}
			if (typeof vendor.actualModel === 'string' && vendor.actualModel.trim()) {
				return vendor.actualModel.trim();
			}
		}
	}

	// 2. 厂商直接事件对象
	if (typeof obj.actualModel === 'string' && obj.actualModel.trim()) {
		return obj.actualModel.trim();
	}
	if (typeof obj.reportedModel === 'string' && obj.reportedModel.trim()) {
		return obj.reportedModel.trim();
	}
	if (typeof obj.model === 'string' && obj.model.trim()) {
		return obj.model.trim();
	}

	// 3. 厂商特定嵌套（如 system/init）
	if (obj.system && typeof obj.system === 'object') {
		const sys = obj.system as Record<string, unknown>;
		if (typeof sys.model === 'string' && sys.model.trim()) {
			return sys.model.trim();
		}
	}
	if (obj.meta && typeof obj.meta === 'object') {
		const meta = obj.meta as Record<string, unknown>;
		if (typeof meta.model === 'string' && meta.model.trim()) {
			return meta.model.trim();
		}
	}

	return null;
}

/**
 * 比较所选模型与自报实际模型是否不一致 (E-37)。
 * 规范化后进行比较。若无自报模型，保持未知，返回 false。
 */
export function checkModelMismatch(
	selectedModel?: string | null,
	reportedModel?: string | null,
): boolean {
	if (!reportedModel || !reportedModel.trim()) {
		return false;
	}
	if (!selectedModel || !selectedModel.trim()) {
		return false;
	}

	const normSelected = selectedModel.trim().toLowerCase();
	const normReported = reportedModel.trim().toLowerCase();
	return normSelected !== normReported;
}

/**
 * 组装 ModelProgressInfo。
 * 遵循 E-37：在不一致时提供高亮与「实际使用：X」文案。
 */
export function resolveModelProgressInfo(
	selectedModel?: string | null,
	reportedModel?: string | null,
): ModelProgressInfo {
	const sel = selectedModel?.trim() ? selectedModel.trim() : null;
	const rep = reportedModel?.trim() ? reportedModel.trim() : null;
	const modelMismatch = checkModelMismatch(sel, rep);
	const isMismatchHighlighted = modelMismatch;
	const displayActualModel = rep ? `${ACTUAL_MODEL_PREFIX}${rep}` : null;

	return Object.freeze({
		selectedModel: sel,
		reportedModel: rep,
		modelMismatch,
		isMismatchHighlighted,
		displayActualModel,
	});
}

/**
 * 解析时间戳，支持 ISO8601 字符串、数字或 Date。
 * 严禁在 domain 内隐式调用 Date.now()，必须从参数注入。
 */
function parseTimestamp(timeVal: unknown): number | null {
	if (timeVal === null || timeVal === undefined) {
		return null;
	}
	if (typeof timeVal === 'number' && Number.isFinite(timeVal)) {
		return timeVal >= 0 ? timeVal : null;
	}
	if (timeVal instanceof Date) {
		const ms = timeVal.getTime();
		return Number.isFinite(ms) ? ms : null;
	}
	if (typeof timeVal === 'string') {
		const trimmed = timeVal.trim();
		if (!trimmed) return null;
		const parsed = Date.parse(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/**
 * 计算耗时毫秒数。
 * - 已结束：endedAt - startedAt
 * - 仍在运行：now - startedAt
 * - 耗时不得为负数。
 */
export function calculateDurationMs(
	startedAt?: string | number | Date | null,
	endedAt?: string | number | Date | null,
	now?: string | number | Date | null,
): number | null {
	const startMs = parseTimestamp(startedAt);
	if (startMs === null) {
		return null;
	}

	const endMs = parseTimestamp(endedAt);
	if (endMs !== null) {
		return Math.max(0, endMs - startMs);
	}

	const nowMs = parseTimestamp(now);
	if (nowMs !== null) {
		return Math.max(0, nowMs - startMs);
	}

	return null;
}

/**
 * 格式化耗时展示字符串。
 * 返回机器友好的标准时间字符串（如 42.6s, 2m 15s），不在 daemon 内拼造中文长句。
 */
export function formatDurationText(durationMs: number | null | undefined): string | null {
	if (durationMs === null || durationMs === undefined || durationMs < 0) {
		return null;
	}

	if (durationMs < 1000) {
		return '<1s';
	}

	const totalSeconds = durationMs / 1000;
	if (totalSeconds < 60) {
		return `${totalSeconds.toFixed(1)}s`;
	}

	const minutes = Math.floor(totalSeconds / 60);
	const remainingSeconds = Math.round(totalSeconds % 60);
	return `${minutes}m ${remainingSeconds}s`;
}

/**
 * 「已退出」及其后继状态：进程已结束，最终字段（最后一条消息／token／耗时）已可用。
 * 复用 run-state-machine.ts 的终态定义，避免两处各写一份状态集合后漂移；
 * exited 之后按迁移图只能走向 reviewing / reworking / awaiting_human 或四个终态。
 * orphaned 是进程失联而非正常退出，刻意不计入。
 */
const EXITED_OR_LATER_RUN_STATES: readonly string[] = [
	'exited',
	'reviewing',
	'reworking',
	'awaiting_human',
	...TERMINAL_RUN_STATES,
];

/**
 * 判断运行状态是否为终态或已退出（进程已结束，最终字段可以补齐）。
 */
export function isTerminalOrExitedState(state?: string | null): boolean {
	if (!state || typeof state !== 'string') return false;
	return EXITED_OR_LATER_RUN_STATES.includes(state.trim().toLowerCase());
}

/**
 * 提取最后一条 assistant 文本消息。
 * 五家共用一套通用提取逻辑，不做深度语义解析 (AC 1)。
 *
 * 遵循 E-253：
 * - 若 hasStreamingEvents 为 false（dsh）：
 *   - 运行中（!isCompleted）严禁伪造中间事件，返回 null；
 *   - 完成后从 finalOutput 或最终事件中补齐最后一条文本。
 * - 流式 agent（codex, claude, pi, grok）：
 *   - 拼接 agent_message_chunk 或提取最近一条助手输出。
 */
export function extractLastMessage(
	events: readonly unknown[],
	options?: {
		readonly isCompleted?: boolean;
		readonly hasStreamingEvents?: boolean;
		readonly finalOutput?: string | null;
	},
): string | null {
	const hasStreaming = options?.hasStreamingEvents ?? true;
	const isCompleted = options?.isCompleted ?? false;

	// E-253: dsh 全程无流式事件，运行期严禁伪造中间事件充数
	if (!hasStreaming) {
		if (!isCompleted) {
			return null;
		}
		// 完成后补最终字段
		if (options?.finalOutput && typeof options.finalOutput === 'string') {
			const trimmed = options.finalOutput.trim();
			if (trimmed) return trimmed;
		}
	}

	// 倒序查找或正序拼接事件流中的文本消息
	let accumulatedChunk = '';
	let foundChunk = false;

	// 倒序扫描最新一条消息块序列
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (!ev || typeof ev !== 'object') continue;

		const record = ev as Record<string, unknown>;
		const kind = typeof record.kind === 'string' ? record.kind : '';
		const payload =
			record.payload && typeof record.payload === 'object'
				? (record.payload as Record<string, unknown>)
				: record;

		// 1. ACP 标准 agent_message_chunk
		if (kind === 'agent_message_chunk') {
			const chunk =
				typeof payload.chunk === 'string'
					? payload.chunk
					: typeof payload.delta === 'string'
						? payload.delta
						: typeof payload.text === 'string'
							? payload.text
							: '';
			if (chunk) {
				accumulatedChunk = chunk + accumulatedChunk;
				foundChunk = true;
			}
			continue;
		}

		// 2. 若已经在收集当前 message chunk 序列，遇到边界（如 tool_call 或 state_changed）则停止回溯
		//    只认归一化后的 ACP kind；厂商原生 kind（如 turn.completed、agent_message）
		//    由各家 adapters/<agent>/map-events.ts 归一化，domain 不得再认一份。
		if (foundChunk) {
			break;
		}
	}

	if (foundChunk && accumulatedChunk.trim().length > 0) {
		return accumulatedChunk.trim();
	}

	// 最终兜底：如果有 finalOutput 且已完成，使用 finalOutput
	if (isCompleted && options?.finalOutput && options.finalOutput.trim()) {
		return options.finalOutput.trim();
	}

	return null;
}

/**
 * 提取改动文件数 (M5-T3 diff 输入)。
 * 严格按照工作区 diff 统计，不解析各家 tool 事件 (AC 1)。
 */
export function extractChangedFileCount(
	diffStat?: {
		readonly changedFileCount?: number | null;
		readonly filesChanged?: number | null;
		readonly files?: readonly unknown[];
	} | null,
	explicitCount?: number | null,
): number | null {
	if (typeof explicitCount === 'number' && Number.isFinite(explicitCount) && explicitCount >= 0) {
		return Math.floor(explicitCount);
	}

	if (!diffStat || typeof diffStat !== 'object') {
		return null;
	}

	if (
		typeof diffStat.changedFileCount === 'number' &&
		Number.isFinite(diffStat.changedFileCount) &&
		diffStat.changedFileCount >= 0
	) {
		return Math.floor(diffStat.changedFileCount);
	}

	if (
		typeof diffStat.filesChanged === 'number' &&
		Number.isFinite(diffStat.filesChanged) &&
		diffStat.filesChanged >= 0
	) {
		return Math.floor(diffStat.filesChanged);
	}

	if (Array.isArray(diffStat.files)) {
		return diffStat.files.length;
	}

	return null;
}

/**
 * 从事件数组中提取最后事件时间戳 (供 M6-T4 停滞检测消费)。
 */
function extractLastEventAt(events: readonly unknown[]): string | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (!ev || typeof ev !== 'object') continue;
		const record = ev as Record<string, unknown>;
		if (typeof record.ts === 'string' && record.ts.trim()) {
			return record.ts.trim();
		}
		if (typeof record.timestamp === 'string' && record.timestamp.trim()) {
			return record.timestamp.trim();
		}
		const payload = record.payload as Record<string, unknown> | undefined;
		if (payload && typeof payload.ts === 'string' && payload.ts.trim()) {
			return payload.ts.trim();
		}
	}
	return null;
}

/**
 * 一次性计算与提取完整运行进度快照。
 *
 * 逐条满足验收标准：
 * 1) 五家共用一套逻辑，不做深度语义解析；dsh 无流式时只在完成后补最终字段 (E-253)
 * 2) token 用量字段名或单位不一致或缺失时显示「—」，不得拿 0 冒充 (E-26)
 * 3) 从首帧读回 agent 自报的实际模型并在与所选不一致时高亮；无首帧能力的 agent 保持未知，不猜测 (E-37)
 */
export function extractProgress(input: ExtractProgressInput): RunProgress {
	const runId = input.runId ?? null;
	const agentId = input.agentId ?? null;
	const state = input.state ?? null;
	const events = input.events ?? [];

	const hasStreaming = hasStreamingCapability(agentId, input.hasStreamingEvents);
	const stepDurationDegraded = !hasStreaming;

	const isCompleted =
		isTerminalOrExitedState(state) || (input.endedAt !== null && input.endedAt !== undefined);

	// 1. 首帧自报模型提取与比对 (AC 3 & E-37)
	const firstFrame = events.length > 0 ? events[0] : null;
	const reportedModel = extractReportedModel(firstFrame);
	const modelInfo = resolveModelProgressInfo(input.selectedModel, reportedModel);

	// 2. 最后一条消息提取 (AC 1 & E-253)
	const lastMessage = extractLastMessage(events, {
		isCompleted,
		hasStreamingEvents: hasStreaming,
		finalOutput: input.finalOutput,
	});

	// 3. 改动文件数提取 (来自 M5-T3 diff 输入)
	const changedFileCount = extractChangedFileCount(input.diffStat, input.changedFileCount);

	// 4. Token 用量提取与格式化 (AC 2 & E-26)
	//    从事件流中最后一个包含 token 的事件或最终输出中提取
	let tokenUsage: TokenUsage | null = null;
	for (let i = events.length - 1; i >= 0; i--) {
		const extracted = extractTokenUsage(events[i]);
		if (extracted !== null) {
			tokenUsage = extracted;
			break;
		}
	}
	if (tokenUsage === null && input.finalOutput) {
		tokenUsage = extractTokenUsage(input.finalOutput);
	}
	const tokenDisplay = formatTokenDisplay(tokenUsage);

	// 5. 耗时与静默计时 (M6-T4 前置输入)
	const lastEventAt = extractLastEventAt(events);
	const durationMs = calculateDurationMs(input.startedAt, input.endedAt, input.now);
	const durationText = formatDurationText(durationMs);

	// 6. dsh 等无流式 agent 运行期提示
	const streamingNotice = !hasStreaming && !isCompleted ? DSH_STREAMING_NOTICE : null;

	return Object.freeze({
		runId,
		agentId,
		state,
		isCompleted,
		hasStreamingEvents: hasStreaming,
		stepDurationDegraded,
		lastMessage,
		changedFileCount,
		durationMs,
		durationText,
		startedAt: input.startedAt ?? null,
		lastEventAt,
		endedAt: input.endedAt ?? null,
		tokenUsage,
		tokenDisplay,
		modelInfo,
		streamingNotice,
	});
}

/**
 * 创建增量进度提取器，支持流式实时推进。
 */
export function createProgressExtractor(
	initialOptions?: Omit<ExtractProgressInput, 'events'>,
): ProgressExtractor {
	const events: unknown[] = [];
	let state = initialOptions?.state ?? 'running';
	let endedAt = initialOptions?.endedAt ?? null;
	let diffStat = initialOptions?.diffStat ?? null;
	let changedFileCount = initialOptions?.changedFileCount ?? null;
	let finalOutput = initialOptions?.finalOutput ?? null;
	let completed = initialOptions?.endedAt ? true : isTerminalOrExitedState(state);

	const agentId = initialOptions?.agentId ?? null;
	const runId = initialOptions?.runId ?? null;
	const selectedModel = initialOptions?.selectedModel ?? null;
	const hasStreaming = hasStreamingCapability(agentId, initialOptions?.hasStreamingEvents);
	const startedAt = initialOptions?.startedAt ?? null;

	return {
		pushEvent(event: unknown) {
			if (event !== null && event !== undefined) {
				events.push(event);
			}
		},

		setDiffStat(
			diff:
				| { readonly changedFileCount?: number | null; readonly filesChanged?: number | null }
				| number
				| null,
		) {
			if (typeof diff === 'number') {
				changedFileCount = diff;
				diffStat = null;
			} else {
				diffStat = diff;
			}
		},

		setState(newState: string) {
			state = newState;
			if (isTerminalOrExitedState(newState)) {
				completed = true;
			}
		},

		complete(options?: { endedAt?: string; finalOutput?: string }) {
			completed = true;
			if (options?.endedAt) {
				endedAt = options.endedAt;
			}
			if (options?.finalOutput) {
				finalOutput = options.finalOutput;
			}
		},

		getProgress(now?: string | number | Date | null): RunProgress {
			return extractProgress({
				runId,
				agentId,
				state,
				selectedModel,
				hasStreamingEvents: hasStreaming,
				startedAt,
				endedAt,
				now: now ?? initialOptions?.now,
				events,
				diffStat,
				changedFileCount,
				finalOutput,
			});
		},
	};
}
