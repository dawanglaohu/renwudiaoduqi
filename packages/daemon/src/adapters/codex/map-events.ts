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
 * Excludes generic names: 'plan', 'agent_message_chunk', 'agent_thought_chunk', 'error'.
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
	'turn.plan.updated',
	'item/started',
	'item.started',
	'item/completed',
	'item.completed',
	'item/updated',
	'item.updated',
	'item/agentMessage/delta',
	'item.agent_message.delta',
	'agent_message_delta',
	'item/reasoning/textDelta',
	'item/reasoning/summaryTextDelta',
	'item.reasoning.delta',
	'reasoning_delta',
	'item/commandExecution/outputDelta',
	'command/exec/outputDelta',
	'process/outputDelta',
	'item/fileChange/outputDelta',
	'item/plan/delta',
	'item/autoApprovalReview/started',
	'autoApprovalReview/strictReviewRequired',
	'guardianWarning',
	'agentMessage',
	'agent_message',
	'commandExecution',
	'command_execution',
	'fileChange',
	'file_change',
	'mcpToolCall',
	'mcp_tool_call',
	'dynamicToolCall',
	'dynamic_tool_call',
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
	readonly message?: string;
	readonly changes?: readonly unknown[];
	readonly server?: string;
	readonly tool?: string;
	readonly arguments?: unknown;
	readonly exitCode?: number | null;
	readonly exit_code?: number | null;
	readonly aggregatedOutput?: string | null;
	readonly aggregated_output?: string | null;
	readonly status?: string;
	readonly durationMs?: number | null;
	readonly duration_ms?: number | null;
	readonly success?: boolean | null;
	readonly result?: unknown;
	readonly error?: unknown;
	readonly contentItems?: readonly unknown[];
	readonly content_items?: readonly unknown[];
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
		case 'commandExecution':
		case 'command_execution': {
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
		case 'fileChange':
		case 'file_change': {
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
		case 'mcpToolCall':
		case 'mcp_tool_call': {
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
		case 'dynamicToolCall':
		case 'dynamic_tool_call': {
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
		case 'agentMessage':
		case 'agent_message': {
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
		case 'error': {
			const msg =
				typeof item.message === 'string'
					? item.message
					: typeof item.text === 'string'
						? item.text
						: JSON.stringify(item);
			return createInput(
				'run.stderr_line',
				{
					line: msg,
					vendor: parsed,
				},
				context,
			);
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
		case 'commandExecution':
		case 'command_execution': {
			const exitCode = item.exit_code !== undefined ? item.exit_code : (item.exitCode ?? null);
			const aggregatedOutput =
				item.aggregated_output !== undefined
					? item.aggregated_output
					: (item.aggregatedOutput ?? null);
			const durationMs =
				item.duration_ms !== undefined ? item.duration_ms : (item.durationMs ?? null);

			events.push(
				createInput(
					'tool_call_update',
					{
						callId: itemId,
						output: {
							exitCode,
							aggregatedOutput,
							status: item.status ?? null,
							durationMs,
						},
						vendor: parsed,
					},
					context,
				),
			);

			// Detect git push command executions and output
			const command = item.command ?? '';
			const output = aggregatedOutput ?? '';
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
		case 'fileChange':
		case 'file_change': {
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
		case 'mcpToolCall':
		case 'mcp_tool_call': {
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
		case 'dynamicToolCall':
		case 'dynamic_tool_call': {
			const contentItems = item.content_items ?? item.contentItems ?? [];
			events.push(
				createInput(
					'tool_call_update',
					{
						callId: itemId,
						output: {
							success: item.success ?? null,
							contentItems,
						},
						vendor: parsed,
					},
					context,
				),
			);
			break;
		}
		case 'error': {
			const msg =
				typeof item.message === 'string'
					? item.message
					: typeof item.text === 'string'
						? item.text
						: JSON.stringify(item);
			events.push(
				createInput(
					'run.stderr_line',
					{
						line: msg,
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

function mapItemUpdated(
	item: ItemPayload,
	parsed: unknown,
	context?: CodexMapEventsContext,
): readonly EventEnvelopeInput[] {
	const itemType = item.type;
	const itemId = item.id;
	const events: EventEnvelopeInput[] = [];

	switch (itemType) {
		case 'commandExecution':
		case 'command_execution': {
			const exitCode = item.exit_code !== undefined ? item.exit_code : (item.exitCode ?? null);
			const aggregatedOutput =
				item.aggregated_output !== undefined
					? item.aggregated_output
					: (item.aggregatedOutput ?? (typeof item.delta === 'string' ? item.delta : null));
			const durationMs =
				item.duration_ms !== undefined ? item.duration_ms : (item.durationMs ?? null);

			events.push(
				createInput(
					'tool_call_update',
					{
						callId: itemId,
						output: {
							exitCode,
							aggregatedOutput,
							status: item.status ?? null,
							durationMs,
						},
						vendor: parsed,
					},
					context,
				),
			);
			break;
		}
		case 'error': {
			const msg =
				typeof item.message === 'string'
					? item.message
					: typeof item.text === 'string'
						? item.text
						: JSON.stringify(item);
			events.push(
				createInput(
					'run.stderr_line',
					{
						line: msg,
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

function mapTurnResolution(
	status: string,
	errorMessage: string | null,
	parsed: unknown,
	context?: CodexMapEventsContext,
): readonly EventEnvelopeInput[] {
	const events: EventEnvelopeInput[] = [];

	if (status === 'failed') {
		if (errorMessage) {
			events.push(
				createInput(
					'run.stderr_line',
					{
						line: errorMessage,
						vendor: parsed,
					},
					context,
				),
			);
		}
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
	} else if (status === 'interrupted') {
		events.push(
			createInput(
				'run.exited',
				{
					exitCode: 130,
					signal: 'SIGINT',
					vendor: parsed,
				},
				context,
			),
		);
	} else {
		// 'completed' or normal exit
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
					return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
				}
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 1, rawLine });
			}

			case 'item/completed': {
				const item = (params.item ?? {}) as ItemPayload;
				const mappedEvents = mapItemCompleted(item, parsed, context);
				events.push(...mappedEvents);
				return Object.freeze({
					events: Object.freeze(events),
					unmappedCount: events.length > 0 ? 0 : 1,
					rawLine,
				});
			}

			case 'item/updated': {
				const item = (params.item ?? {}) as ItemPayload;
				const mappedEvents = mapItemUpdated(item, parsed, context);
				events.push(...mappedEvents);
				return Object.freeze({
					events: Object.freeze(events),
					unmappedCount: events.length > 0 ? 0 : 1,
					rawLine,
				});
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
				const turn = (
					typeof params.turn === 'object' && params.turn !== null ? params.turn : params
				) as Record<string, unknown>;
				const status =
					typeof turn.status === 'string'
						? turn.status
						: typeof params.status === 'string'
							? params.status
							: 'completed';
				const turnError = (
					typeof turn.error === 'object' && turn.error !== null ? turn.error : null
				) as Record<string, unknown> | null;
				const errorMessage =
					typeof turnError?.message === 'string'
						? turnError.message
						: typeof turn.error === 'string'
							? turn.error
							: null;

				const resolutionEvents = mapTurnResolution(status, errorMessage, parsed, context);
				events.push(...resolutionEvents);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'turn/failed': {
				const turn = (
					typeof params.turn === 'object' && params.turn !== null ? params.turn : params
				) as Record<string, unknown>;
				const turnError = (
					typeof turn.error === 'object' && turn.error !== null ? turn.error : null
				) as Record<string, unknown> | null;
				const errorMessage =
					typeof turnError?.message === 'string'
						? turnError.message
						: typeof turn.error === 'string'
							? turn.error
							: typeof params.message === 'string'
								? params.message
								: null;

				const resolutionEvents = mapTurnResolution('failed', errorMessage, parsed, context);
				events.push(...resolutionEvents);
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
					return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
				}
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 1, rawLine });
			}

			case 'item.completed':
			case 'item/completed': {
				const item = (record.item ?? {}) as ItemPayload;
				const mappedEvents = mapItemCompleted(item, parsed, context);
				events.push(...mappedEvents);
				return Object.freeze({
					events: Object.freeze(events),
					unmappedCount: events.length > 0 ? 0 : 1,
					rawLine,
				});
			}

			case 'item.updated':
			case 'item/updated': {
				const item = (record.item ?? {}) as ItemPayload;
				const mappedEvents = mapItemUpdated(item, parsed, context);
				events.push(...mappedEvents);
				return Object.freeze({
					events: Object.freeze(events),
					unmappedCount: events.length > 0 ? 0 : 1,
					rawLine,
				});
			}

			case 'turn.completed':
			case 'turn/completed': {
				const turn = (
					typeof record.turn === 'object' && record.turn !== null ? record.turn : record
				) as Record<string, unknown>;
				const status =
					typeof turn.status === 'string'
						? turn.status
						: typeof record.status === 'string'
							? record.status
							: 'completed';
				const turnError = (
					typeof turn.error === 'object' && turn.error !== null ? turn.error : null
				) as Record<string, unknown> | null;
				const errorMessage =
					typeof turnError?.message === 'string'
						? turnError.message
						: typeof turn.error === 'string'
							? turn.error
							: typeof record.error === 'string'
								? record.error
								: null;

				const resolutionEvents = mapTurnResolution(status, errorMessage, parsed, context);
				events.push(...resolutionEvents);
				return Object.freeze({ events: Object.freeze(events), unmappedCount: 0, rawLine });
			}

			case 'turn.failed':
			case 'turn/failed': {
				const errorMessage =
					typeof record.error === 'string'
						? record.error
						: typeof record.message === 'string'
							? record.message
							: null;
				const resolutionEvents = mapTurnResolution('failed', errorMessage, parsed, context);
				events.push(...resolutionEvents);
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
