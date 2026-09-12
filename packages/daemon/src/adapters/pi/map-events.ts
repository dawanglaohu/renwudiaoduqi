import type { EventKind, EventPayloadMap, EventScope } from '@agent-scheduler/shared/api/events';

export interface EventEnvelopeInput<K extends EventKind = EventKind> {
	readonly kind: K;
	readonly payload: EventPayloadMap[K];
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
	readonly scope?: EventScope;
}

export const KNOWN_PI_EVENT_TYPES: ReadonlySet<string> = new Set([
	'agent_start',
	'agent_end',
	'agent_settled',
	'turn_start',
	'turn_end',
	'message_start',
	'message_update',
	'message_end',
	'tool_execution_start',
	'tool_execution_update',
	'tool_execution_end',
	'plan',
	'auto_compaction_start',
	'auto_compaction_end',
	'auto_retry_start',
	'auto_retry_end',
	'response',
	'extension_ui_request',
]);

export function isKnownPiEventType(type: string): boolean {
	return KNOWN_PI_EVENT_TYPES.has(type);
}

export interface PiEventMappingTracker {
	readonly unmappedCount: number;
	readonly unmappedTypes: readonly string[];
	recordUnmapped(type: string, raw?: unknown): void;
	reset(): void;
}

export function createPiEventTracker(): PiEventMappingTracker {
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

export interface MapPiEventsOptions {
	readonly tracker?: PiEventMappingTracker;
	readonly onUnmapped?: (type: string, raw: unknown) => void;
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
}

/**
 * Pure function mapping Pi native RPC event lines/objects to normalized ACP / system event envelopes.
 * Adheres strictly to Section 08 rules:
 * - Pure function: (vendorLine: unknown) => EventEnvelopeInput[]
 * - Does not touch fs, db, or clock (id, ts, seq are completed by events/factory.ts)
 * - E-140: Unparseable lines return [] without breaking the stream
 * - E-202: Unknown vendor event types are ignored, counted on the tracker, and never crash or invent kinds
 * - AC 4: `agent_settled` maps to run completed / exited signal
 */
export function mapPiEvents(
	vendorLine: unknown,
	options?: MapPiEventsOptions,
): readonly EventEnvelopeInput[] {
	if (vendorLine === null || vendorLine === undefined) {
		return Object.freeze([]);
	}

	let data: Record<string, unknown>;
	if (typeof vendorLine === 'string') {
		const trimmed = vendorLine.trim();
		if (!trimmed) return Object.freeze([]);
		try {
			data = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			// E-140: Unparseable lines go to raw.log and do not break the stream
			return Object.freeze([]);
		}
	} else if (typeof vendorLine === 'object') {
		data = vendorLine as Record<string, unknown>;
	} else {
		return Object.freeze([]);
	}

	if (!data || typeof data !== 'object') {
		return Object.freeze([]);
	}

	const eventType = typeof data.type === 'string' ? data.type : '';
	if (!eventType) {
		return Object.freeze([]);
	}

	// E-202: Handle unknown event types gracefully without crashing or inventing kinds
	if (!isKnownPiEventType(eventType)) {
		options?.tracker?.recordUnmapped(eventType, data);
		options?.onUnmapped?.(eventType, data);
		return Object.freeze([]);
	}

	const runId = options?.runId ?? null;
	const taskId = options?.taskId ?? null;
	const actorDeviceId = options?.actorDeviceId ?? null;

	const envelopes: EventEnvelopeInput[] = [];

	switch (eventType) {
		// AC 4 & E-202: `agent_settled` mapped to run completion signal (R1, R2)
		case 'agent_settled': {
			envelopes.push({
				kind: 'run.state_changed',
				payload: {
					from: 'running',
					to: 'exited',
					reason: 'agent_settled',
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'agent_start': {
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
			break;
		}

		case 'turn_start':
		case 'turn_end':
			break;

		case 'message_update': {
			// Check for assistantMessageEvent nesting from Pi RPC
			const assistantEvent = data.assistantMessageEvent as Record<string, unknown> | undefined;
			if (assistantEvent && typeof assistantEvent === 'object') {
				const subType = assistantEvent.type;
				if (subType === 'text_delta' && typeof assistantEvent.delta === 'string') {
					envelopes.push({
						kind: 'agent_message_chunk',
						payload: {
							chunk: assistantEvent.delta,
							vendor: data,
						},
						runId,
						taskId,
						actorDeviceId,
						scope: 'run',
					});
				} else if (subType === 'thinking_delta' && typeof assistantEvent.delta === 'string') {
					envelopes.push({
						kind: 'agent_thought_chunk',
						payload: {
							chunk: assistantEvent.delta,
							vendor: data,
						},
						runId,
						taskId,
						actorDeviceId,
						scope: 'run',
					});
				}
			}

			// Direct delta or thinking properties on message_update
			if (typeof data.delta === 'string') {
				envelopes.push({
					kind: 'agent_message_chunk',
					payload: {
						chunk: data.delta,
						vendor: data,
					},
					runId,
					taskId,
					actorDeviceId,
					scope: 'run',
				});
			}
			if (typeof data.thinking === 'string') {
				envelopes.push({
					kind: 'agent_thought_chunk',
					payload: {
						chunk: data.thinking,
						vendor: data,
					},
					runId,
					taskId,
					actorDeviceId,
					scope: 'run',
				});
			}
			break;
		}

		case 'tool_execution_start': {
			const callId = String(data.toolCallId ?? data.id ?? '');
			const tool = String(data.toolName ?? data.name ?? '');
			envelopes.push({
				kind: 'tool_call',
				payload: {
					callId: callId || undefined,
					tool: tool || undefined,
					input: data.args ?? data.input,
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'tool_execution_update': {
			const callId = String(data.toolCallId ?? data.id ?? '');
			envelopes.push({
				kind: 'tool_call_update',
				payload: {
					callId: callId || undefined,
					output: data.partialResult ?? data.output,
					vendor: data,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'tool_execution_end': {
			const callId = String(data.toolCallId ?? data.id ?? '');
			envelopes.push({
				kind: 'tool_call_update',
				payload: {
					callId: callId || undefined,
					output: data.result ?? data.output,
					isError: Boolean(data.isError),
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
			const entries = Array.isArray(data.entries) ? (data.entries as readonly unknown[]) : [];
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

		// Known events that do not produce public envelopes:
		case 'agent_end':
		case 'message_start':
		case 'message_end':
		case 'auto_compaction_start':
		case 'auto_compaction_end':
		case 'auto_retry_start':
		case 'auto_retry_end':
		case 'response':
		case 'extension_ui_request':
			break;
	}

	return Object.freeze(envelopes);
}

export { mapPiEvents as mapEvents };
