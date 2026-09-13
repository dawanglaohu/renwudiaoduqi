import type { EventKind, EventPayloadMap } from '@agent-scheduler/shared/api/events';

export interface EventEnvelopeInput<K extends EventKind = EventKind> {
	readonly kind: K;
	readonly payload: EventPayloadMap[K];
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
}

export interface GenericAcpMapEventsContext {
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
}

export interface GenericAcpMapEventsResult {
	readonly events: readonly EventEnvelopeInput[];
	readonly unmappedCount: number;
	readonly parseError?: boolean;
	readonly rawLine: string;
}

/**
 * All Generic ACP vendor/protocol strings.
 * Architecture test asserts these strings ONLY appear in adapters/generic-acp/
 * and NEVER leak into service/, jobs/, or http/ layers.
 */
export const GENERIC_ACP_VENDOR_STRINGS = Object.freeze([
	'session/update',
	'session/created',
	'session/terminated',
	'session/prompt',
	'session/cancel',
	'turn/started',
	'turn/completed',
	'turn/failed',
	'session.update',
	'session.created',
	'session.terminated',
] as const);

export function isKnownAcpEventType(type: string): boolean {
	return (GENERIC_ACP_VENDOR_STRINGS as readonly string[]).includes(type);
}

/**
 * Pure function mapping a single ACP v1 line (JSON-RPC 2.0 or NDJSON)
 * into normalized ACP and product event envelope inputs.
 * Never touches fs, db, or clock.
 */
export function mapGenericAcpEvents(
	vendorLine: unknown,
	context?: GenericAcpMapEventsContext,
): readonly EventEnvelopeInput[] {
	if (vendorLine === null || vendorLine === undefined) {
		return Object.freeze([]);
	}

	let parsed: Record<string, unknown>;
	if (typeof vendorLine === 'object') {
		parsed = vendorLine as Record<string, unknown>;
	} else if (typeof vendorLine === 'string') {
		const trimmed = vendorLine.trim();
		if (trimmed.length === 0 || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
			return Object.freeze([]);
		}
		try {
			parsed = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			return Object.freeze([]);
		}
	} else {
		return Object.freeze([]);
	}

	const method = (parsed.method ?? parsed.type ?? parsed.event) as string | undefined;

	// Handle JSON-RPC session/update notification
	if (method === 'session/update' || method === 'session.update') {
		const params = (parsed.params ?? parsed) as Record<string, unknown>;
		const update = (params.update ?? params) as Record<string, unknown>;
		return mapAcpUpdatePayload(update, context);
	}

	// Handle direct update object without outer session/update envelope
	if (method === 'agent_message_chunk' || parsed.kind === 'agent_message_chunk') {
		return mapAcpUpdatePayload({ ...parsed, kind: 'agent_message_chunk' }, context);
	}
	if (method === 'agent_thought_chunk' || parsed.kind === 'agent_thought_chunk') {
		return mapAcpUpdatePayload({ ...parsed, kind: 'agent_thought_chunk' }, context);
	}
	if (method === 'tool_call' || parsed.kind === 'tool_call') {
		return mapAcpUpdatePayload({ ...parsed, kind: 'tool_call' }, context);
	}
	if (method === 'tool_call_update' || parsed.kind === 'tool_call_update') {
		return mapAcpUpdatePayload({ ...parsed, kind: 'tool_call_update' }, context);
	}
	if (method === 'plan' || parsed.kind === 'plan') {
		return mapAcpUpdatePayload({ ...parsed, kind: 'plan' }, context);
	}

	// Lifecycle notifications like turn/started, session/created do not emit content chunks directly
	return Object.freeze([]);
}

function mapAcpUpdatePayload(
	update: Record<string, unknown>,
	context?: GenericAcpMapEventsContext,
): readonly EventEnvelopeInput[] {
	const kind = (update.kind ?? update.type) as string | undefined;

	switch (kind) {
		case 'agent_message_chunk': {
			const content =
				typeof update.content === 'string'
					? update.content
					: typeof update.text === 'string'
						? update.text
						: typeof update.delta === 'string'
							? update.delta
							: '';
			const delta = typeof update.delta === 'string' ? update.delta : content;
			return Object.freeze([
				{
					kind: 'agent_message_chunk',
					payload: { content, delta },
					runId: context?.runId,
					taskId: context?.taskId,
					actorDeviceId: context?.actorDeviceId,
				},
			]);
		}
		case 'agent_thought_chunk': {
			const thought =
				typeof update.thought === 'string'
					? update.thought
					: typeof update.text === 'string'
						? update.text
						: typeof update.delta === 'string'
							? update.delta
							: '';
			const delta = typeof update.delta === 'string' ? update.delta : thought;
			return Object.freeze([
				{
					kind: 'agent_thought_chunk',
					payload: { thought, delta },
					runId: context?.runId,
					taskId: context?.taskId,
					actorDeviceId: context?.actorDeviceId,
				},
			]);
		}
		case 'tool_call': {
			const toolCallId =
				typeof update.toolCallId === 'string'
					? update.toolCallId
					: typeof update.id === 'string'
						? update.id
						: 'unknown-tool-call';
			const name =
				typeof update.name === 'string'
					? update.name
					: typeof update.tool === 'string'
						? update.tool
						: 'tool';
			const rawInput = update.input ?? update.arguments ?? {};
			const input =
				typeof rawInput === 'object' && rawInput !== null
					? (rawInput as Record<string, unknown>)
					: { value: rawInput };

			return Object.freeze([
				{
					kind: 'tool_call',
					payload: { toolCallId, name, input },
					runId: context?.runId,
					taskId: context?.taskId,
					actorDeviceId: context?.actorDeviceId,
				},
			]);
		}
		case 'tool_call_update': {
			const toolCallId =
				typeof update.toolCallId === 'string'
					? update.toolCallId
					: typeof update.id === 'string'
						? update.id
						: 'unknown-tool-call';
			const status =
				update.status === 'completed' || update.status === 'failed' || update.status === 'running'
					? update.status
					: 'completed';
			const rawOutput = update.output ?? update.result;
			const output =
				rawOutput !== undefined
					? typeof rawOutput === 'object' && rawOutput !== null
						? (rawOutput as Record<string, unknown>)
						: { value: rawOutput }
					: undefined;

			return Object.freeze([
				{
					kind: 'tool_call_update',
					payload: { toolCallId, status, output },
					runId: context?.runId,
					taskId: context?.taskId,
					actorDeviceId: context?.actorDeviceId,
				},
			]);
		}
		case 'plan': {
			const rawSteps = Array.isArray(update.steps) ? update.steps : [];
			const steps = rawSteps.map((step, idx) => {
				if (typeof step === 'object' && step !== null) {
					const s = step as Record<string, unknown>;
					return {
						id: typeof s.id === 'string' ? s.id : `step-${idx + 1}`,
						text: typeof s.text === 'string' ? s.text : String(s.title ?? `Step ${idx + 1}`),
						status:
							s.status === 'pending' || s.status === 'in_progress' || s.status === 'completed'
								? (s.status as 'pending' | 'in_progress' | 'completed')
								: ('pending' as const),
					};
				}
				return {
					id: `step-${idx + 1}`,
					text: String(step),
					status: 'pending' as const,
				};
			});

			return Object.freeze([
				{
					kind: 'plan',
					payload: { steps: Object.freeze(steps) },
					runId: context?.runId,
					taskId: context?.taskId,
					actorDeviceId: context?.actorDeviceId,
				},
			]);
		}
		default:
			return Object.freeze([]);
	}
}

/**
 * Parses and maps a line from Generic ACP, tracking unmapped counts and parse errors.
 */
export function parseAndMapGenericAcpLine(
	rawLine: string,
	context?: GenericAcpMapEventsContext,
): GenericAcpMapEventsResult {
	const trimmed = rawLine.trim();
	if (trimmed.length === 0) {
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 0,
			rawLine,
		});
	}

	if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 0,
			parseError: true,
			rawLine,
		});
	}

	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		const method = (parsed.method ?? parsed.type ?? parsed.event) as string | undefined;

		const events = mapGenericAcpEvents(parsed, context);
		if (events.length > 0) {
			return Object.freeze({
				events,
				unmappedCount: 0,
				rawLine,
			});
		}

		// Check if it's a known protocol message that produces no events (e.g. session/created)
		if (method && isKnownAcpEventType(method)) {
			return Object.freeze({
				events: Object.freeze([]),
				unmappedCount: 0,
				rawLine,
			});
		}

		// Unknown event type
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 1,
			rawLine,
		});
	} catch {
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 0,
			parseError: true,
			rawLine,
		});
	}
}

export { mapGenericAcpEvents as mapEvents };
