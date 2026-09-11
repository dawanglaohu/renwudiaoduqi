import type { EventKind, EventPayloadMap } from '@agent-scheduler/shared/api/events';

export interface EventEnvelopeInput<K extends EventKind = EventKind> {
	readonly kind: K;
	readonly payload: EventPayloadMap[K];
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
}

export interface CodexMapEventsContext {
	readonly runId?: string | null;
	readonly taskId?: string | null;
	readonly actorDeviceId?: string | null;
}

export interface CodexMapEventsResult {
	readonly events: readonly EventEnvelopeInput[];
	readonly unmappedCount: number;
	readonly parseError?: boolean;
	readonly rawLine: string;
}

/**
 * All Codex vendor-specific event method and type strings.
 * Architecture test asserts these strings ONLY appear in adapters/codex/
 * and NEVER leak into service/, jobs/, or http/ layers (AC 2).
 */
export const CODEX_VENDOR_EVENT_STRINGS = Object.freeze([
	'thread/started',
	'thread.started',
	'turn/started',
	'turn.started',
	'turn/completed',
	'turn.completed',
	'turn/failed',
	'turn.failed',
	'turn/plan/updated',
	'item/started',
	'item.started',
	'item/completed',
	'item.completed',
	'item/agentMessage/delta',
	'item/reasoning/textDelta',
	'item/reasoning/summaryTextDelta',
	'item/commandExecution/outputDelta',
	'item/fileChange/outputDelta',
	'commandExecution',
	'fileChange',
	'mcpToolCall',
	'dynamicToolCall',
] as const);

/**
 * Pure function mapping a single line from Codex (app-server or exec --json)
 * into normalized ACP and product event envelope inputs.
 * Never touches fs, db, or clock.
 */
export function mapCodexEvents(
	vendorLine: string | unknown,
	context?: CodexMapEventsContext,
): readonly EventEnvelopeInput[] {
	return parseAndMapCodexLine(vendorLine, context).events;
}

/**
 * Detailed line parser and event mapper tracking unmapped events and parse errors.
 */
export function parseAndMapCodexLine(
	vendorLine: string | unknown,
	context?: CodexMapEventsContext,
): CodexMapEventsResult {
	const rawLine = typeof vendorLine === 'string' ? vendorLine : JSON.stringify(vendorLine);

	if (typeof vendorLine === 'string') {
		const trimmed = vendorLine.trim();
		if (trimmed.length === 0) {
			return Object.freeze({
				events: Object.freeze([]),
				unmappedCount: 0,
				rawLine,
			});
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// Unparseable lines are preserved in raw log without interrupting the stream
			return Object.freeze({
				events: Object.freeze([]),
				unmappedCount: 0,
				parseError: true,
				rawLine,
			});
		}

		return mapParsedObject(parsed, rawLine, context);
	}

	if (typeof vendorLine === 'object' && vendorLine !== null) {
		return mapParsedObject(vendorLine, rawLine, context);
	}

	return Object.freeze({
		events: Object.freeze([]),
		unmappedCount: 0,
		rawLine,
	});
}

function createInput<K extends EventKind>(
	kind: K,
	payload: EventPayloadMap[K],
	context?: CodexMapEventsContext,
): EventEnvelopeInput<K> {
	return Object.freeze({
		kind,
		payload: Object.freeze(payload),
		runId: context?.runId ?? null,
		taskId: context?.taskId ?? null,
		actorDeviceId: context?.actorDeviceId ?? null,
	}) as EventEnvelopeInput<K>;
}

interface ItemPayload {
	readonly id?: string;
	readonly type?: string;
	readonly command?: string;
	readonly cwd?: string;
	readonly text?: string;
	readonly delta?: string;
	readonly changes?: readonly unknown[];
	readonly server?: string;
	readonly tool?: string;
	readonly arguments?: unknown;
	readonly exitCode?: number | null;
	readonly aggregatedOutput?: string | null;
	readonly status?: string;
	readonly durationMs?: number | null;
	readonly success?: boolean | null;
	readonly result?: unknown;
	readonly error?: unknown;
	readonly contentItems?: readonly unknown[];
	readonly [key: string]: unknown;
}

function mapItemStarted(
	item: ItemPayload,
	parsed: unknown,
	context?: CodexMapEventsContext,
): EventEnvelopeInput | null {
	const itemType = item.type;
	const itemId = item.id;

	switch (itemType) {
		case 'commandExecution': {
			return createInput(
				'tool_call',
				{
					callId: itemId,
					tool: 'commandExecution',
					input: {
						command: item.command,
						cwd: item.cwd,
					},
					vendor: parsed,
				},
				context,
			);
		}
		case 'fileChange': {
			return createInput(
				'tool_call',
				{
					callId: itemId,
					tool: 'fileChange',
					input: {
						changes: item.changes ?? [],
					},
					vendor: parsed,
				},
				context,
			);
		}
		case 'mcpToolCall': {
			const toolName = item.server ? `${item.server}:${item.tool ?? ''}` : (item.tool ?? 'mcp');
			return createInput(
				'tool_call',
				{
					callId: itemId,
					tool: toolName,
					input: item.arguments,
					vendor: parsed,
				},
				context,
			);
		}
		case 'dynamicToolCall': {
			return createInput(
				'tool_call',
				{
					callId: itemId,
					tool: item.tool ?? 'dynamicTool',
					input: item.arguments,
					vendor: parsed,
				},
				context,
			);
		}
		case 'plan': {
			return createInput(
				'plan',
				{
					entries: [{ text: item.text }],
					vendor: parsed,
				},
				context,
			);
		}
		case 'agentMessage': {
			if (typeof item.text === 'string' && item.text.length > 0) {
				return createInput(
					'agent_message_chunk',
					{
						chunk: item.text,
						vendor: parsed,
					},
					context,
				);
			}
			return null;
		}
		default:
			return null;
	}
}

function mapItemCompleted(
	item: ItemPayload,
	parsed: unknown,
	context?: CodexMapEventsContext,
): readonly EventEnvelopeInput[] {
	const itemType = item.type;
	const itemId = item.id;
	const events: EventEnvelopeInput[] = [];

	switch (itemType) {
		case 'commandExecution': {
			events.push(
				createInput(
					'tool_call_update',
					{
						callId: itemId,
						output: {
							exitCode: item.exitCode ?? null,
							aggregatedOutput: item.aggregatedOutput ?? null,
							status: item.status ?? null,
							durationMs: item.durationMs ?? null,
						},
						vendor: parsed,
					},
					context,
				),
			);

			// Detect git push command executions and output
			const command = item.command ?? '';
			const output = item.aggregatedOutput ?? '';
			if (
				command.includes('git push') ||
				output.includes('->') ||
				output.includes('Everything up-to-date')
			) {
				events.push(
					createInput(
						'run.remote_push_detected',
						{
							vendor: parsed,
						},
						context,
					),
				);
			}
			break;
		}
		case 'fileChange': {
			events.push(
				createInput(
					'tool_call_update',
					{
						callId: itemId,
						output: {
							status: item.status ?? null,
							changes: item.changes ?? [],
						},
						vendor: parsed,
					},
					context,
				),
			);
			break;
		}
		case 'mcpToolCall': {
			events.push(
				createInput(
					'tool_call_update',
					{
						callId: itemId,
						output: item.result ?? item.error ?? null,
						vendor: parsed,
					},
					context,
				),
			);
			break;
		}
		case 'dynamicToolCall': {
			events.push(
				createInput(
					'tool_call_update',
					{
						callId: itemId,
						output: {
							success: item.success ?? null,
							contentItems: item.contentItems ?? [],
						},
						vendor: parsed,
					},
					context,
				),
			);
			break;
		}
		default:
			break;
	}

	return events;
}

function mapParsedObject(
	parsed: unknown,
	rawLine: string,
	context?: CodexMapEventsContext,
): CodexMapEventsResult {
	if (typeof parsed !== 'object' || parsed === null) {
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 1,
			rawLine,
		});
	}

	const record = parsed as Record<string, unknown>;
	const events: EventEnvelopeInput[] = [];

	// Channel 1: Codex app-server JSON-RPC format (has "method" or "jsonrpc")
	if ('method' in record && typeof record.method === 'string') {
		const method = record.method;
		const params = (record.params ?? {}) as Record<string, unknown>;

		switch (method) {
			case 'item/agentMessage/delta': {
				const delta = typeof params.delta === 'string' ? params.delta : '';
				if (delta.length > 0) {
					events.push(
						createInput(
							'agent_message_chunk',
							{
								chunk: delta,
								vendor: parsed,
							},
							context,
						),
					);
				}
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'item/reasoning/textDelta':
			case 'item/reasoning/summaryTextDelta': {
				const delta = typeof params.delta === 'string' ? params.delta : '';
				if (delta.length > 0) {
					events.push(
						createInput(
							'agent_thought_chunk',
							{
								chunk: delta,
								vendor: parsed,
							},
							context,
						),
					);
				}
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'item/started': {
				const item = (params.item ?? {}) as ItemPayload;
				const mapped = mapItemStarted(item, parsed, context);
				if (mapped) {
					events.push(mapped);
				}
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'item/completed': {
				const item = (params.item ?? {}) as ItemPayload;
				const mappedEvents = mapItemCompleted(item, parsed, context);
				events.push(...mappedEvents);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'item/commandExecution/outputDelta':
			case 'command/exec/outputDelta':
			case 'process/outputDelta': {
				const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
				const delta = typeof params.delta === 'string' ? params.delta : '';
				events.push(
					createInput(
						'tool_call_update',
						{
							callId: itemId,
							output: delta,
							vendor: parsed,
						},
						context,
					),
				);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'item/fileChange/outputDelta': {
				const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
				const delta = typeof params.delta === 'string' ? params.delta : '';
				events.push(
					createInput(
						'tool_call_update',
						{
							callId: itemId,
							output: delta,
							vendor: parsed,
						},
						context,
					),
				);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'turn/plan/updated':
			case 'item/plan/delta': {
				const plan = Array.isArray(params.plan)
					? params.plan
					: [{ text: params.explanation ?? '' }];
				events.push(
					createInput(
						'plan',
						{
							entries: plan,
							vendor: parsed,
						},
						context,
					),
				);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'thread/started':
			case 'turn/started': {
				events.push(
					createInput(
						'run.started',
						{
							runId: context?.runId ?? undefined,
							vendor: parsed,
						},
						context,
					),
				);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'turn/completed': {
				events.push(
					createInput(
						'run.exited',
						{
							exitCode: 0,
							vendor: parsed,
						},
						context,
					),
				);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'error': {
				const message =
					typeof params.message === 'string' ? params.message : JSON.stringify(params);
				events.push(
					createInput(
						'run.stderr_line',
						{
							line: message,
							vendor: parsed,
						},
						context,
					),
				);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'item/autoApprovalReview/started':
			case 'autoApprovalReview/strictReviewRequired':
			case 'guardianWarning': {
				const reason =
					typeof params.message === 'string'
						? params.message
						: 'Permission review or approval required';
				events.push(
					createInput(
						'run.permission_blocked',
						{
							reason,
							vendor: parsed,
						},
						context,
					),
				);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			default: {
				// Known notifications that are informational and not mapped to ACP events
				// (e.g., thread/status/changed, account/updated, fs/changed)
				// Do not invent fake kinds, count as unmapped without error
				return Object.freeze({
					events: Object.freeze([]),
					unmappedCount: 1,
					rawLine,
				});
			}
		}
	}

	// Channel 2: Codex exec --json JSONL format (has "type" or "event")
	const eventType =
		typeof record.type === 'string'
			? record.type
			: typeof record.event === 'string'
				? record.event
				: null;

	if (eventType !== null) {
		switch (eventType) {
			case 'thread.started':
			case 'thread/started':
			case 'turn.started':
			case 'turn/started': {
				events.push(
					createInput(
						'run.started',
						{
							runId: context?.runId ?? undefined,
							vendor: parsed,
						},
						context,
					),
				);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'item.started':
			case 'item/started': {
				const item = (record.item ?? {}) as ItemPayload;
				const mapped = mapItemStarted(item, parsed, context);
				if (mapped) {
					events.push(mapped);
				}
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'item.completed':
			case 'item/completed': {
				const item = (record.item ?? {}) as ItemPayload;
				const mappedEvents = mapItemCompleted(item, parsed, context);
				events.push(...mappedEvents);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'turn.completed':
			case 'turn/completed': {
				events.push(
					createInput(
						'run.exited',
						{
							exitCode: 0,
							vendor: parsed,
						},
						context,
					),
				);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'turn.failed':
			case 'turn/failed': {
				events.push(
					createInput(
						'run.exited',
						{
							exitCode: 1,
							vendor: parsed,
						},
						context,
					),
				);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'item.agent_message.delta':
			case 'agent_message_delta':
			case 'agent_message_chunk': {
				const chunk =
					typeof record.delta === 'string'
						? record.delta
						: typeof record.text === 'string'
							? record.text
							: '';
				if (chunk.length > 0) {
					events.push(
						createInput(
							'agent_message_chunk',
							{
								chunk,
								vendor: parsed,
							},
							context,
						),
					);
				}
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'item.reasoning.delta':
			case 'reasoning_delta':
			case 'agent_thought_chunk': {
				const chunk =
					typeof record.delta === 'string'
						? record.delta
						: typeof record.text === 'string'
							? record.text
							: '';
				if (chunk.length > 0) {
					events.push(
						createInput(
							'agent_thought_chunk',
							{
								chunk,
								vendor: parsed,
							},
							context,
						),
					);
				}
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'plan':
			case 'turn.plan.updated': {
				const entries = Array.isArray(record.entries)
					? record.entries
					: Array.isArray(record.plan)
						? record.plan
						: [{ text: record.text ?? '' }];
				events.push(
					createInput(
						'plan',
						{
							entries,
							vendor: parsed,
						},
						context,
					),
				);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'error': {
				const message =
					typeof record.message === 'string'
						? record.message
						: typeof record.error === 'string'
							? record.error
							: JSON.stringify(record);
				events.push(
					createInput(
						'run.stderr_line',
						{
							line: message,
							vendor: parsed,
						},
						context,
					),
				);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			default: {
				return Object.freeze({
					events: Object.freeze([]),
					unmappedCount: 1,
					rawLine,
				});
			}
		}
	}

	// Unknown or unmapped JSON object
	return Object.freeze({
		events: Object.freeze([]),
		unmappedCount: 1,
		rawLine,
	});
}

export { mapCodexEvents as mapEvents };
