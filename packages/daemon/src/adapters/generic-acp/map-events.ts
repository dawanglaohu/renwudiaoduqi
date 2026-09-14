import type { EventKind, EventPayloadMap } from '@agent-scheduler/shared/api/events';

export interface EventEnvelopeInput<K extends EventKind = EventKind> {
	readonly kind: K;
	readonly payload: EventPayloadMap[K];
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
	readonly scope?: string;
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
 * All Generic ACP vendor/protocol event strings.
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
	'agent_message_chunk',
	'agent_thought_chunk',
	'tool_call',
	'tool_call_update',
	'plan',
	'available_commands_update',
] as const);

export function isKnownAcpEventType(type: string): boolean {
	return (GENERIC_ACP_VENDOR_STRINGS as readonly string[]).includes(type);
}

/**
 * Pure function mapping a single ACP v1 line (JSON-RPC 2.0 or NDJSON)
 * into normalized ACP event envelope inputs.
 * Never touches fs, db, or clock.
 */
export function mapGenericAcpEvents(
	vendorLine: unknown,
	context?: GenericAcpMapEventsContext,
): readonly EventEnvelopeInput[] {
	return parseAndMapGenericAcpLine(vendorLine, context).events;
}

/**
 * Parses and maps an ACP v1 line, tracking unmapped counts and parse errors.
 */
export function parseAndMapGenericAcpLine(
	vendorLine: unknown,
	context?: GenericAcpMapEventsContext,
): GenericAcpMapEventsResult {
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

	return mapParsedAcpObject(data, rawLine, context);
}

function mapParsedAcpObject(
	data: Record<string, unknown>,
	rawLine: string,
	context?: GenericAcpMapEventsContext,
): GenericAcpMapEventsResult {
	// R1: Primary unwrapping path is ACP v1 session/update notification:
	// {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"agent_message_chunk",...}}}
	let updateObj: Record<string, unknown> = data;

	if (data.params && typeof data.params === 'object') {
		const params = data.params as Record<string, unknown>;
		if (params.update && typeof params.update === 'object') {
			updateObj = params.update as Record<string, unknown>;
		} else if (params.sessionUpdate && typeof params.sessionUpdate === 'object') {
			updateObj = params.sessionUpdate as Record<string, unknown>;
		} else {
			updateObj = params;
		}
	} else if (data.update && typeof data.update === 'object') {
		updateObj = data.update as Record<string, unknown>;
	} else if (data.sessionUpdate && typeof data.sessionUpdate === 'object') {
		updateObj = data.sessionUpdate as Record<string, unknown>;
	}

	// Discriminant field: primary ACP v1 is sessionUpdate on updateObj; flat type/kind as fallback (R1)
	const rawType =
		updateObj.sessionUpdate ??
		updateObj.type ??
		updateObj.kind ??
		data.sessionUpdate ??
		data.type ??
		data.kind;

	const eventType = typeof rawType === 'string' ? rawType.trim() : '';

	if (!eventType) {
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 1,
			rawLine,
		});
	}

	if (!isKnownAcpEventType(eventType)) {
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
		case 'agent_message_chunk': {
			const rawContent = updateObj.content ?? updateObj.text ?? updateObj.chunk ?? updateObj.delta;
			let chunk = '';
			if (typeof rawContent === 'string') {
				chunk = rawContent;
			} else if (rawContent && typeof rawContent === 'object') {
				const contentObj = rawContent as Record<string, unknown>;
				if (typeof contentObj.text === 'string') {
					chunk = contentObj.text;
				} else if (typeof contentObj.content === 'string') {
					chunk = contentObj.content;
				} else if (typeof contentObj.delta === 'string') {
					chunk = contentObj.delta;
				}
			}

			// R1: 取不到文本按未映射/归原始日志处理，不发空 chunk
			if (!chunk) {
				return Object.freeze({
					events: Object.freeze([]),
					unmappedCount: 0,
					rawLine,
				});
			}

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
			const rawContent = updateObj.content ?? updateObj.text ?? updateObj.chunk ?? updateObj.delta;
			let chunk = '';
			if (typeof rawContent === 'string') {
				chunk = rawContent;
			} else if (rawContent && typeof rawContent === 'object') {
				const contentObj = rawContent as Record<string, unknown>;
				if (typeof contentObj.text === 'string') {
					chunk = contentObj.text;
				} else if (typeof contentObj.thought === 'string') {
					chunk = contentObj.thought;
				} else if (typeof contentObj.delta === 'string') {
					chunk = contentObj.delta;
				}
			}

			// R1: 取不到文本不发空 chunk
			if (!chunk) {
				return Object.freeze({
					events: Object.freeze([]),
					unmappedCount: 0,
					rawLine,
				});
			}

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
			// R1: keys callId, tool, input, status, vendor (aligned with shared/api/events.ts)
			const callId = String(
				updateObj.toolCallId ?? updateObj.callId ?? updateObj.tool_call_id ?? updateObj.id ?? '',
			);
			const tool = String(
				updateObj.title ?? updateObj.tool ?? updateObj.toolName ?? updateObj.name ?? '',
			);
			const input = updateObj.rawInput ?? updateObj.input ?? updateObj.args ?? updateObj.arguments;
			const status = updateObj.status;

			envelopes.push({
				kind: 'tool_call',
				payload: {
					callId: callId || undefined,
					tool: tool || undefined,
					input,
					status: status !== undefined ? status : undefined,
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
			// R1: keys callId, output, status (不替厂商断言工具状态), vendor
			const callId = String(
				updateObj.toolCallId ?? updateObj.callId ?? updateObj.tool_call_id ?? updateObj.id ?? '',
			);
			const output = updateObj.rawOutput ?? updateObj.output ?? updateObj.result;
			const status = updateObj.status;
			const isError = status === 'failed' || status === 'error' || Boolean(updateObj.isError);

			envelopes.push({
				kind: 'tool_call_update',
				payload: {
					callId: callId || undefined,
					output,
					status: status !== undefined ? status : undefined,
					isError,
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
			// R1: keys entries, vendor
			const rawEntries = updateObj.entries ?? updateObj.steps ?? updateObj.tasks;
			const entries = Array.isArray(rawEntries)
				? (rawEntries as readonly unknown[]).map((entry) => {
						if (entry && typeof entry === 'object') {
							const item = entry as Record<string, unknown>;
							const rawContent = item.content;
							const content =
								typeof rawContent === 'string'
									? rawContent
									: rawContent &&
											typeof rawContent === 'object' &&
											typeof (rawContent as Record<string, unknown>).text === 'string'
										? (rawContent as Record<string, unknown>).text
										: rawContent;
							return Object.freeze({
								content,
								status: item.status,
								priority: item.priority,
							});
						}
						return entry;
					})
				: [];

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
			// R1: keys commands, vendor
			const rawCommands = updateObj.availableCommands ?? updateObj.commands;
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

		case 'session/created':
		case 'session/terminated':
		case 'turn/started':
		case 'turn/completed':
		case 'turn/failed':
		case 'session/prompt':
		case 'session/cancel':
		case 'session.created':
		case 'session.terminated':
		case 'session/update':
		case 'session.update':
			// Known lifecycle notifications that emit no content chunks
			break;
	}

	return Object.freeze({
		events: Object.freeze(envelopes),
		unmappedCount: 0,
		rawLine,
	});
}

export { mapGenericAcpEvents as mapEvents };
