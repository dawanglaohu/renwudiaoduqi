import type { EventKind } from '@agent-scheduler/shared/api/events';

export interface EventEnvelopeInput {
	readonly kind: EventKind;
	readonly payload: Record<string, unknown>;
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
}

export interface ClaudeEventMapperState {
	selectedModel?: string | null;
	firstFrameProcessed?: boolean;
	actualModel?: string | null;
	modelMismatch?: boolean;
	unmappedEventCount?: number;
	runId?: string | null;
	taskId?: string | null;
}

export interface ClaudeMapEventsResult {
	readonly events: readonly EventEnvelopeInput[];
	readonly unmappedCount: number;
	readonly actualModel: string | null;
	readonly modelMismatch: boolean;
	readonly isFirstFrame: boolean;
}

/**
 * Normalizes model names for comparison (stripping whitespace and lowercasing).
 */
function normalizeModelName(model: string | null | undefined): string {
	if (!model) return '';
	return model.trim().toLowerCase();
}

/**
 * Extracts self-reported actual model from a Claude initialization frame (E-37).
 */
function extractModelFromInitFrame(obj: Record<string, unknown>): string | null {
	if (typeof obj.model === 'string' && obj.model.trim()) {
		return obj.model.trim();
	}
	if (obj.system && typeof obj.system === 'object') {
		const sys = obj.system as Record<string, unknown>;
		if (typeof sys.model === 'string' && sys.model.trim()) {
			return sys.model.trim();
		}
	}
	if (obj.metadata && typeof obj.metadata === 'object') {
		const meta = obj.metadata as Record<string, unknown>;
		if (typeof meta.model === 'string' && meta.model.trim()) {
			return meta.model.trim();
		}
	}
	return null;
}

/**
 * Known lifecycle / system event types in Claude stream-json that should not be counted as unmapped.
 */
const KNOWN_CLAUDE_SYSTEM_TYPES: ReadonlySet<string> = new Set([
	'system',
	'system/init',
	'init',
	'system/api_retry',
	'api_retry',
	'system/status',
	'ping',
	'result',
]);

const KNOWN_STREAM_EVENT_TYPES: ReadonlySet<string> = new Set([
	'message_start',
	'message_stop',
	'message_delta',
	'content_block_start',
	'content_block_stop',
	'content_block_delta',
]);

/**
 * Maps a single Claude vendor output line into normalized ACP / product event inputs.
 * Enforces AC 2 & E-37: Reads self-reported model from first frame and flags mismatch with selected model.
 * Enforces AC 3 & E-202: Unknown vendor events are discarded and counted to unmappedCount; never crashes or invents kinds.
 */
export function mapClaudeEventLine(
	vendorLine: unknown,
	state?: ClaudeEventMapperState,
): ClaudeMapEventsResult {
	if (vendorLine === null || vendorLine === undefined) {
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 0,
			actualModel: state?.actualModel ?? null,
			modelMismatch: state?.modelMismatch ?? false,
			isFirstFrame: false,
		});
	}

	let parsed: Record<string, unknown>;

	if (typeof vendorLine === 'string') {
		const trimmed = vendorLine.trim();
		if (!trimmed) {
			return Object.freeze({
				events: Object.freeze([]),
				unmappedCount: 0,
				actualModel: state?.actualModel ?? null,
				modelMismatch: state?.modelMismatch ?? false,
				isFirstFrame: false,
			});
		}

		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// Unparseable lines belong to raw.log and must not interrupt the stream or crash (08-后端架构).
			return Object.freeze({
				events: Object.freeze([]),
				unmappedCount: 0,
				actualModel: state?.actualModel ?? null,
				modelMismatch: state?.modelMismatch ?? false,
				isFirstFrame: false,
			});
		}
	} else if (typeof vendorLine === 'object') {
		parsed = vendorLine as Record<string, unknown>;
	} else {
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 0,
			actualModel: state?.actualModel ?? null,
			modelMismatch: state?.modelMismatch ?? false,
			isFirstFrame: false,
		});
	}

	const events: EventEnvelopeInput[] = [];
	let unmappedCount = 0;
	let isFirstFrame = false;
	const runId = state?.runId ?? null;
	const taskId = state?.taskId ?? null;

	const rawType = typeof parsed.type === 'string' ? parsed.type.trim() : '';
	const rawSubtype = typeof parsed.subtype === 'string' ? parsed.subtype.trim() : '';

	// --- 1. Check for First Frame / System Init (AC 2 & E-37) ---
	const isInitFrame =
		rawType === 'system/init' ||
		rawType === 'init' ||
		(rawType === 'system' && (rawSubtype === 'init' || typeof parsed.model === 'string')) ||
		(!state?.firstFrameProcessed && typeof parsed.model === 'string');

	if (isInitFrame && !state?.firstFrameProcessed) {
		isFirstFrame = true;
		const reportedModel = extractModelFromInitFrame(parsed);

		if (reportedModel) {
			if (state) {
				state.actualModel = reportedModel;
				state.firstFrameProcessed = true;
			}

			let modelMismatch = false;
			if (state?.selectedModel) {
				const expectedNorm = normalizeModelName(state.selectedModel);
				const actualNorm = normalizeModelName(reportedModel);
				if (expectedNorm && actualNorm && expectedNorm !== actualNorm) {
					modelMismatch = true;
				}
			}

			if (state) {
				state.modelMismatch = modelMismatch;
			}

			events.push(
				Object.freeze({
					kind: 'run.started',
					runId,
					taskId,
					payload: Object.freeze({
						actualModel: reportedModel,
						selectedModel: state?.selectedModel ?? null,
						modelMismatch,
						vendor: Object.freeze({ ...parsed }),
					}),
				}),
			);
		} else if (state) {
			state.firstFrameProcessed = true;
		}
	}

	// --- 2. Map known ACP session/update events ---

	// A. stream_event (Anthropic Claude streaming event wrapper)
	if (rawType === 'stream_event' && parsed.event && typeof parsed.event === 'object') {
		const ev = parsed.event as Record<string, unknown>;
		const evType = typeof ev.type === 'string' ? ev.type.trim() : '';

		if (evType === 'content_block_delta' && ev.delta && typeof ev.delta === 'object') {
			const delta = ev.delta as Record<string, unknown>;
			const deltaType = typeof delta.type === 'string' ? delta.type.trim() : '';

			if (deltaType === 'text_delta' && typeof delta.text === 'string') {
				events.push(
					Object.freeze({
						kind: 'agent_message_chunk',
						runId,
						taskId,
						payload: Object.freeze({
							chunk: delta.text,
							vendor: Object.freeze({ ...parsed }),
						}),
					}),
				);
			} else if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
				events.push(
					Object.freeze({
						kind: 'agent_thought_chunk',
						runId,
						taskId,
						payload: Object.freeze({
							chunk: delta.thinking,
							vendor: Object.freeze({ ...parsed }),
						}),
					}),
				);
			} else {
				// Known sub-event delta with no payload to emit
			}
		} else if (
			evType === 'content_block_start' &&
			ev.content_block &&
			typeof ev.content_block === 'object'
		) {
			const block = ev.content_block as Record<string, unknown>;
			const blockType = typeof block.type === 'string' ? block.type.trim() : '';

			if (blockType === 'tool_use') {
				events.push(
					Object.freeze({
						kind: 'tool_call',
						runId,
						taskId,
						payload: Object.freeze({
							callId: typeof block.id === 'string' ? block.id : undefined,
							tool: typeof block.name === 'string' ? block.name : undefined,
							input: block.input,
							vendor: Object.freeze({ ...parsed }),
						}),
					}),
				);
			}
		} else if (KNOWN_STREAM_EVENT_TYPES.has(evType)) {
			// Other known stream sub-events (e.g. message_start, message_stop)
		} else {
			// Unknown sub-event under stream_event (AC 3 & E-202)
			unmappedCount++;
		}
	}
	// B. Direct text / message chunk
	else if (
		rawType === 'text' ||
		rawType === 'text_delta' ||
		rawType === 'agent_message_chunk' ||
		(rawType === 'content_block_delta' &&
			parsed.delta &&
			typeof (parsed.delta as Record<string, unknown>).text === 'string')
	) {
		const text =
			typeof parsed.text === 'string'
				? parsed.text
				: typeof parsed.chunk === 'string'
					? parsed.chunk
					: typeof (parsed.delta as Record<string, unknown>)?.text === 'string'
						? ((parsed.delta as Record<string, unknown>).text as string)
						: '';

		events.push(
			Object.freeze({
				kind: 'agent_message_chunk',
				runId,
				taskId,
				payload: Object.freeze({
					chunk: text,
					vendor: Object.freeze({ ...parsed }),
				}),
			}),
		);
	}
	// C. Direct thinking / thought chunk
	else if (
		rawType === 'thinking' ||
		rawType === 'thought' ||
		rawType === 'agent_thought_chunk' ||
		rawType === 'thinking_delta'
	) {
		const chunk =
			typeof parsed.thinking === 'string'
				? parsed.thinking
				: typeof parsed.text === 'string'
					? parsed.text
					: typeof parsed.thought === 'string'
						? parsed.thought
						: typeof parsed.chunk === 'string'
							? parsed.chunk
							: '';

		events.push(
			Object.freeze({
				kind: 'agent_thought_chunk',
				runId,
				taskId,
				payload: Object.freeze({
					chunk,
					vendor: Object.freeze({ ...parsed }),
				}),
			}),
		);
	}
	// D. Tool call / Tool use
	else if (rawType === 'tool_use' || rawType === 'tool_call') {
		const callId =
			typeof parsed.id === 'string'
				? parsed.id
				: typeof parsed.callId === 'string'
					? parsed.callId
					: undefined;
		const tool =
			typeof parsed.name === 'string'
				? parsed.name
				: typeof parsed.tool === 'string'
					? parsed.tool
					: undefined;

		events.push(
			Object.freeze({
				kind: 'tool_call',
				runId,
				taskId,
				payload: Object.freeze({
					callId,
					tool,
					input: parsed.input,
					vendor: Object.freeze({ ...parsed }),
				}),
			}),
		);
	}
	// E. Tool call update / Tool result
	else if (rawType === 'tool_result' || rawType === 'tool_call_update') {
		const callId =
			typeof parsed.tool_use_id === 'string'
				? parsed.tool_use_id
				: typeof parsed.callId === 'string'
					? parsed.callId
					: typeof parsed.id === 'string'
						? parsed.id
						: undefined;

		const output = parsed.content !== undefined ? parsed.content : parsed.output;

		events.push(
			Object.freeze({
				kind: 'tool_call_update',
				runId,
				taskId,
				payload: Object.freeze({
					callId,
					output,
					vendor: Object.freeze({ ...parsed }),
				}),
			}),
		);
	}
	// F. Plan / Todo
	else if (rawType === 'plan' || rawType === 'todo') {
		const entries = Array.isArray(parsed.entries)
			? parsed.entries
			: Array.isArray(parsed.items)
				? parsed.items
				: Array.isArray(parsed.todos)
					? parsed.todos
					: undefined;

		events.push(
			Object.freeze({
				kind: 'plan',
				runId,
				taskId,
				payload: Object.freeze({
					entries,
					vendor: Object.freeze({ ...parsed }),
				}),
			}),
		);
	}
	// G. Available commands update
	else if (rawType === 'available_commands' || rawType === 'available_commands_update') {
		const commands = Array.isArray(parsed.commands) ? parsed.commands : undefined;

		events.push(
			Object.freeze({
				kind: 'available_commands_update',
				runId,
				taskId,
				payload: Object.freeze({
					commands,
					vendor: Object.freeze({ ...parsed }),
				}),
			}),
		);
	}
	// H. Known system types with no further output needed
	else if (KNOWN_CLAUDE_SYSTEM_TYPES.has(rawType)) {
		// Handled gracefully without mapping to ACP or counting as unmapped
	}
	// I. Unknown vendor event (AC 3 & E-202)
	else {
		// Discard event; increment unmappedCount; never crash; never invent fake kind.
		unmappedCount++;
	}

	if (state && unmappedCount > 0) {
		state.unmappedEventCount = (state.unmappedEventCount ?? 0) + unmappedCount;
	}

	return Object.freeze({
		events: Object.freeze(events),
		unmappedCount,
		actualModel: state?.actualModel ?? null,
		modelMismatch: state?.modelMismatch ?? false,
		isFirstFrame,
	});
}

/**
 * Standard pure event mapper interface: (vendorLine: unknown) => readonly EventEnvelopeInput[]
 */
export function mapEvents(vendorLine: unknown): readonly EventEnvelopeInput[] {
	return mapClaudeEventLine(vendorLine).events;
}

export interface ClaudeEventMapperOptions {
	readonly selectedModel?: string | null;
	readonly runId?: string | null;
	readonly taskId?: string | null;
}

export interface ClaudeEventMapper {
	readonly mapLine: (line: unknown) => ClaudeMapEventsResult;
	readonly getActualModel: () => string | null;
	readonly isModelMismatch: () => boolean;
	readonly getUnmappedEventCount: () => number;
	readonly reset: () => void;
}

/**
 * Creates a stateful Claude event mapper instance for tracking stream lifecycle across multiple lines.
 */
export function createClaudeEventMapper(options: ClaudeEventMapperOptions = {}): ClaudeEventMapper {
	const state: ClaudeEventMapperState = {
		selectedModel: options.selectedModel ?? null,
		runId: options.runId ?? null,
		taskId: options.taskId ?? null,
		firstFrameProcessed: false,
		actualModel: null,
		modelMismatch: false,
		unmappedEventCount: 0,
	};

	function mapLine(line: unknown): ClaudeMapEventsResult {
		return mapClaudeEventLine(line, state);
	}

	function getActualModel(): string | null {
		return state.actualModel ?? null;
	}

	function isModelMismatch(): boolean {
		return state.modelMismatch ?? false;
	}

	function getUnmappedEventCount(): number {
		return state.unmappedEventCount ?? 0;
	}

	function reset(): void {
		state.firstFrameProcessed = false;
		state.actualModel = null;
		state.modelMismatch = false;
		state.unmappedEventCount = 0;
	}

	return Object.freeze({
		mapLine,
		getActualModel,
		isModelMismatch,
		getUnmappedEventCount,
		reset,
	});
}
