import type { EventKind, EventPayloadMap, EventScope } from '@agent-scheduler/shared/api/events';

export interface EventEnvelopeInput<K extends EventKind = EventKind> {
	readonly kind: K;
	readonly payload: EventPayloadMap[K];
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
	readonly scope?: EventScope;
}

export interface GrokMapEventsContext {
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
	readonly tracker?: GrokEventTracker;
	readonly onUnmapped?: (type: string, raw: unknown) => void;
}

export interface GrokMapEventsResult {
	readonly events: readonly EventEnvelopeInput[];
	readonly unmappedCount: number;
	readonly parseError?: boolean;
	readonly rawLine: string;
}

/**
 * Token usage parsed from Grok / ACP events.
 * AC 5 & E-26: When token usage is missing or unavailable, fields MUST be null, NEVER filled with 0.
 */
export interface GrokTokenUsage {
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly totalTokens: number | null;
}

/**
 * Known ACP session update and Grok vendor event types.
 * Architecture tests assert that vendor event strings only appear in adapters/grok/
 */
export const GROK_VENDOR_EVENT_STRINGS = Object.freeze([
	'session/update',
	'agent_message_chunk',
	'agent_thought_chunk',
	'tool_call',
	'tool_call_update',
	'plan',
	'available_commands_update',
	'session_start',
	'session_complete',
	'agent_start',
	'agent_settled',
	'turn_start',
	'turn_end',
	'turn_complete',
	'turn_failed',
	'permission_request',
	'permission_blocked',
] as const);

export const KNOWN_GROK_EVENT_TYPES: ReadonlySet<string> = new Set(GROK_VENDOR_EVENT_STRINGS);

export function isKnownGrokEventType(type: string): boolean {
	return KNOWN_GROK_EVENT_TYPES.has(type);
}

export interface GrokEventTracker {
	readonly unmappedCount: number;
	readonly unmappedTypes: readonly string[];
	recordUnmapped(type: string, raw?: unknown): void;
	reset(): void;
}

export function createGrokEventTracker(): GrokEventTracker {
	let count = 0;
	const types: string[] = [];

	return {
		get unmappedCount() {
			return count;
		},
		get unmappedTypes() {
			return Object.freeze([...types]);
		},
		recordUnmapped(type: string) {
			count++;
			if (!types.includes(type)) {
				types.push(type);
			}
		},
		reset() {
			count = 0;
			types.length = 0;
		},
	};
}

/**
 * Extracts token usage from Grok / ACP event data.
 *
 * AC 5 & E-26: If token usage is absent, partial, or unparseable, missing fields
 * are set strictly to `null` so the UI displays "—". It NEVER fills `0`.
 */
export function extractGrokTokenUsage(data: unknown): GrokTokenUsage | null {
	if (!data || typeof data !== 'object') {
		return null;
	}

	const record = data as Record<string, unknown>;
	const usageObj = (record.usage ?? record.token_usage ?? record.tokens) as
		| Record<string, unknown>
		| undefined;

	// Check wrapper usage object if present, otherwise check top-level record
	const target = usageObj && typeof usageObj === 'object' ? usageObj : record;

	const rawInput =
		target.prompt_tokens ?? target.input_tokens ?? target.promptTokens ?? target.inputTokens;
	const rawOutput =
		target.completion_tokens ??
		target.output_tokens ??
		target.completionTokens ??
		target.outputTokens;
	const rawTotal = target.total_tokens ?? target.totalTokens;

	const parseCount = (val: unknown): number | null => {
		if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
			return Math.floor(val);
		}
		if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
			return Number.parseInt(val.trim(), 10);
		}
		return null;
	};

	const inputTokens = parseCount(rawInput);
	const outputTokens = parseCount(rawOutput);
	let totalTokens = parseCount(rawTotal);

	if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
		totalTokens = inputTokens + outputTokens;
	}

	// E-26: Return explicit null for missing fields, never 0
	return Object.freeze({
		inputTokens,
		outputTokens,
		totalTokens,
	});
}

/**
 * Pure function mapping a Grok ACP streaming-json line into normalized ACP / product event envelope inputs.
 *
 * AC 1: Directly consumes its ACP session updates as the reference implementation.
 * AC 5 & E-26: Sets token usage fields to null (not 0) when missing.
 * E-140: Unparseable lines return [] without interrupting the stream.
 * E-202: Unknown vendor event types are ignored, counted on the tracker, and never crash or invent kinds.
 */
export function mapGrokEvents(
	vendorLine: unknown,
	context?: GrokMapEventsContext,
): readonly EventEnvelopeInput[] {
	return parseAndMapGrokLine(vendorLine, context).events;
}

/**
 * Detailed line parser and event mapper tracking unmapped events and parse errors.
 */
export function parseAndMapGrokLine(
	vendorLine: unknown,
	context?: GrokMapEventsContext,
): GrokMapEventsResult {
	const rawLine = typeof vendorLine === 'string' ? vendorLine : JSON.stringify(vendorLine);

	if (vendorLine === null || vendorLine === undefined) {
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 0,
			rawLine: '',
		});
	}

	let data: Record<string, unknown>;
	if (typeof vendorLine === 'string') {
		const trimmed = vendorLine.trim();
		if (trimmed.length === 0) {
			return Object.freeze({
				events: Object.freeze([]),
				unmappedCount: 0,
				rawLine,
			});
		}

		try {
			data = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			// E-140: Unparseable lines go to raw.log and do not break the stream
			return Object.freeze({
				events: Object.freeze([]),
				unmappedCount: 0,
				parseError: true,
				rawLine,
			});
		}
	} else if (typeof vendorLine === 'object') {
		data = vendorLine as Record<string, unknown>;
	} else {
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 0,
			rawLine,
		});
	}

	if (!data || typeof data !== 'object') {
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 0,
			rawLine,
		});
	}

	return mapParsedGrokObject(data, rawLine, context);
}

function mapParsedGrokObject(
	data: Record<string, unknown>,
	rawLine: string,
	context?: GrokMapEventsContext,
): GrokMapEventsResult {
	// Support JSON-RPC notification wrapper: { jsonrpc: "2.0", method: "session/update", params: { update: ... } }
	let payloadObj: Record<string, unknown> = data;
	let eventType = '';

	if (data.method === 'session/update' && data.params && typeof data.params === 'object') {
		const params = data.params as Record<string, unknown>;
		const innerUpdate = (params.update ?? params.sessionUpdate ?? params) as Record<
			string,
			unknown
		>;
		if (innerUpdate && typeof innerUpdate === 'object') {
			payloadObj = innerUpdate;
		}
	} else if (data.sessionUpdate && typeof data.sessionUpdate === 'object') {
		payloadObj = data.sessionUpdate as Record<string, unknown>;
	} else if (data.update && typeof data.update === 'object') {
		payloadObj = data.update as Record<string, unknown>;
	}

	if (typeof payloadObj.type === 'string') {
		eventType = payloadObj.type;
	} else if (typeof payloadObj.kind === 'string') {
		eventType = payloadObj.kind;
	} else if (typeof data.type === 'string') {
		eventType = data.type;
	}

	if (!eventType) {
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 0,
			rawLine,
		});
	}

	// E-202: Unknown vendor event types are ignored, counted on tracker, and never crash or invent kinds
	if (!isKnownGrokEventType(eventType)) {
		context?.tracker?.recordUnmapped(eventType, data);
		context?.onUnmapped?.(eventType, data);
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 1,
			rawLine,
		});
	}

	const runId = context?.runId ?? null;
	const taskId = context?.taskId ?? null;
	const actorDeviceId = context?.actorDeviceId ?? null;
	const envelopes: EventEnvelopeInput[] = [];

	switch (eventType) {
		// AC 1: ACP session updates reference implementation
		case 'agent_message_chunk': {
			const chunk =
				typeof payloadObj.text === 'string'
					? payloadObj.text
					: typeof payloadObj.chunk === 'string'
						? payloadObj.chunk
						: typeof payloadObj.delta === 'string'
							? payloadObj.delta
							: typeof payloadObj.content === 'string'
								? payloadObj.content
								: '';

			envelopes.push({
				kind: 'agent_message_chunk',
				payload: {
					chunk,
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'agent_thought_chunk': {
			const chunk =
				typeof payloadObj.text === 'string'
					? payloadObj.text
					: typeof payloadObj.chunk === 'string'
						? payloadObj.chunk
						: typeof payloadObj.delta === 'string'
							? payloadObj.delta
							: typeof payloadObj.thought === 'string'
								? payloadObj.thought
								: '';

			envelopes.push({
				kind: 'agent_thought_chunk',
				payload: {
					chunk,
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'tool_call': {
			const callId = String(
				payloadObj.callId ?? payloadObj.call_id ?? payloadObj.toolCallId ?? payloadObj.id ?? '',
			);
			const tool = String(payloadObj.tool ?? payloadObj.toolName ?? payloadObj.name ?? '');
			const input = payloadObj.input ?? payloadObj.args ?? payloadObj.arguments;

			envelopes.push({
				kind: 'tool_call',
				payload: {
					callId: callId || undefined,
					tool: tool || undefined,
					input,
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'tool_call_update': {
			const callId = String(
				payloadObj.callId ?? payloadObj.call_id ?? payloadObj.toolCallId ?? payloadObj.id ?? '',
			);
			const output = payloadObj.output ?? payloadObj.result;

			envelopes.push({
				kind: 'tool_call_update',
				payload: {
					callId: callId || undefined,
					output,
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'plan': {
			const rawEntries = payloadObj.entries ?? payloadObj.steps ?? payloadObj.tasks;
			const entries = Array.isArray(rawEntries) ? (rawEntries as readonly unknown[]) : [];

			envelopes.push({
				kind: 'plan',
				payload: {
					entries,
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'available_commands_update': {
			const rawCommands = payloadObj.commands;
			const commands = Array.isArray(rawCommands) ? (rawCommands as readonly string[]) : [];

			envelopes.push({
				kind: 'available_commands_update',
				payload: {
					commands,
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		// Lifecycle / state transitions
		case 'agent_start':
		case 'session_start': {
			envelopes.push({
				kind: 'run.started',
				payload: {
					runId: runId ?? undefined,
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			envelopes.push({
				kind: 'run.state_changed',
				payload: {
					from: 'pending',
					to: 'running',
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'turn_start': {
			envelopes.push({
				kind: 'run.state_changed',
				payload: {
					from: 'idle',
					to: 'running',
					reason: 'turn_start',
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'turn_end':
		case 'turn_complete':
		case 'agent_settled':
		case 'session_complete': {
			// AC 5 & E-26: Parse token usage, if absent fields are strictly null, never 0
			const tokenUsage = extractGrokTokenUsage(data);

			envelopes.push({
				kind: 'run.state_changed',
				payload: {
					from: 'running',
					to: 'completed',
					reason: eventType,
					vendor: {
						...data,
						tokenUsage,
					},
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			envelopes.push({
				kind: 'run.exited',
				payload: {
					exitCode: 0,
					signal: null,
					vendor: {
						...data,
						tokenUsage,
					},
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'turn_failed': {
			const reason =
				typeof payloadObj.error === 'string'
					? payloadObj.error
					: typeof payloadObj.message === 'string'
						? payloadObj.message
						: 'turn_failed';

			envelopes.push({
				kind: 'run.state_changed',
				payload: {
					from: 'running',
					to: 'failed',
					reason,
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'permission_request':
		case 'permission_blocked': {
			const tool =
				typeof payloadObj.tool === 'string'
					? payloadObj.tool
					: typeof payloadObj.toolName === 'string'
						? payloadObj.toolName
						: undefined;
			const reason =
				typeof payloadObj.reason === 'string'
					? payloadObj.reason
					: typeof payloadObj.message === 'string'
						? payloadObj.message
						: undefined;

			envelopes.push({
				kind: 'run.permission_blocked',
				payload: {
					tool,
					reason,
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}
	}

	return Object.freeze({
		events: Object.freeze(envelopes),
		unmappedCount: 0,
		rawLine,
	});
}

export { mapGrokEvents as mapEvents };
