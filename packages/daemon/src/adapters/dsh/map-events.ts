import type { EventKind, EventPayloadMap } from '@agent-scheduler/shared/api/events';

export interface EventEnvelopeInput<K extends EventKind = EventKind> {
	readonly kind: K;
	readonly payload: EventPayloadMap[K];
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
}

export interface DshMapEventsContext {
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
}

export interface DshMapEventsResult {
	readonly events: readonly EventEnvelopeInput[];
	readonly unmappedCount: number;
	readonly parseError?: boolean;
	readonly rawLine: string;
}

/**
 * All dsh vendor-specific event method and type strings.
 * Architecture test asserts these strings ONLY appear in adapters/dsh/
 * and NEVER leak into service/, jobs/, or http/ layers.
 */
export const DSH_VENDOR_EVENT_STRINGS = Object.freeze([
	'turn/end',
	'turn.end',
	'turn/started',
	'turn.started',
	'turn/completed',
	'turn.completed',
	'turn/failed',
	'turn.failed',
	'headless/completed',
	'headless.completed',
	'headless/done',
	'session/end',
	'session.end',
] as const);

export function isKnownDshEventType(type: string): boolean {
	return (DSH_VENDOR_EVENT_STRINGS as readonly string[]).includes(type);
}

/**
 * Pure function mapping a single output line from dsh (--profile headless)
 * into normalized ACP event envelope inputs.
 *
 * AC 2 & E-253: dsh headless does not provide streaming intermediate events.
 * Only the terminal assistant text is delivered on stdout upon completion.
 * NEVER fabricates intermediate events (no fake tool_call, no fake plan, no fake thought chunks).
 */
export function mapDshEvents(
	rawLine: unknown,
	context?: DshMapEventsContext,
): readonly EventEnvelopeInput[] {
	if (rawLine === null || rawLine === undefined) {
		return Object.freeze([]);
	}

	const line = typeof rawLine === 'string' ? rawLine.trim() : String(rawLine).trim();
	if (line.length === 0) {
		return Object.freeze([]);
	}

	// If line is JSON, check if it contains structured dsh status/turn information
	if (line.startsWith('{') && line.endsWith('}')) {
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			const methodOrType = (parsed.method ?? parsed.type ?? parsed.event) as string | undefined;

			if (methodOrType) {
				switch (methodOrType) {
					case 'turn/end':
					case 'turn.end':
					case 'turn/completed':
					case 'turn.completed':
					case 'headless/completed':
					case 'headless.completed':
					case 'headless/done':
					case 'session/end':
					case 'session.end': {
						const text =
							typeof parsed.text === 'string'
								? parsed.text
								: typeof parsed.content === 'string'
									? parsed.content
									: typeof parsed.message === 'string'
										? parsed.message
										: '';
						if (text.length > 0) {
							return Object.freeze([
								{
									kind: 'agent_message_chunk',
									payload: {
										content: text,
										delta: text,
									},
									runId: context?.runId,
									taskId: context?.taskId,
									actorDeviceId: context?.actorDeviceId,
								},
							]);
						}
						return Object.freeze([]);
					}
					case 'turn/started':
					case 'turn.started':
						return Object.freeze([]);
					case 'turn/failed':
					case 'turn.failed':
						return Object.freeze([]);
					default:
						// Unknown JSON structure
						return Object.freeze([]);
				}
			}

			// If JSON contains text or content directly
			if (typeof parsed.text === 'string' && parsed.text.length > 0) {
				return Object.freeze([
					{
						kind: 'agent_message_chunk',
						payload: {
							content: parsed.text,
							delta: parsed.text,
						},
						runId: context?.runId,
						taskId: context?.taskId,
						actorDeviceId: context?.actorDeviceId,
					},
				]);
			}
		} catch {
			// Not valid JSON, fall through to raw text processing
		}
	}

	// Raw stdout text from dsh headless assistant output
	return Object.freeze([
		{
			kind: 'agent_message_chunk',
			payload: {
				content: line,
				delta: line,
			},
			runId: context?.runId,
			taskId: context?.taskId,
			actorDeviceId: context?.actorDeviceId,
		},
	]);
}

/**
 * Parses and maps a line from dsh, tracking whether the line was recognized or unmapped.
 */
export function parseAndMapDshLine(
	rawLine: string,
	context?: DshMapEventsContext,
): DshMapEventsResult {
	const trimmed = rawLine.trim();
	if (trimmed.length === 0) {
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 0,
			rawLine,
		});
	}

	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			const methodOrType = (parsed.method ?? parsed.type ?? parsed.event) as string | undefined;
			if (methodOrType && !isKnownDshEventType(methodOrType)) {
				return Object.freeze({
					events: Object.freeze([]),
					unmappedCount: 1,
					rawLine,
				});
			}
		} catch {
			return Object.freeze({
				events: Object.freeze([]),
				unmappedCount: 0,
				parseError: true,
				rawLine,
			});
		}
	}

	const events = mapDshEvents(rawLine, context);
	return Object.freeze({
		events,
		unmappedCount: 0,
		rawLine,
	});
}

export { mapDshEvents as mapEvents };
