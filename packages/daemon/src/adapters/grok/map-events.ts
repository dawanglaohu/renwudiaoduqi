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
 * Known ACP session update and Grok vendor event discriminants.
 * Architecture tests assert that vendor event strings only appear in adapters/grok/.
 * R3: Converged strictly to ACP session/update discriminants and permission signals.
 */
export const GROK_VENDOR_EVENT_STRINGS = Object.freeze([
	'session/update',
	'agent_message_chunk',
	'agent_thought_chunk',
	'tool_call',
	'tool_call_update',
	'plan',
	'available_commands_update',
	'permission_request',
	'permission_blocked',
] as const);

export const KNOWN_GROK_EVENT_TYPES: ReadonlySet<string> = new Set(GROK_VENDOR_EVENT_STRINGS);

export function isKnownGrokEventType(type: string): boolean {
	return KNOWN_GROK_EVENT_TYPES.has(type);
}

const NETWORK_DEPENDENCY_COMMAND_REGEX =
	/(?:^|[;&|]\s*)(?:sudo\s+)?(?:npm\s+(?:i|install|add|update)|pnpm\s+(?:i|install|add|update)|yarn(?:\s+add|\s+install)?|bun\s+(?:add|install)|pip3?\s+install|poetry\s+add|cargo\s+(?:add|install)|go\s+(?:get|install)|apt(?:-get)?\s+install|brew\s+install)(?:\s+|$)/i;

function isQuestionTool(toolName?: string): boolean {
	if (!toolName) return false;
	return /^(ask(_user|_followup_question|_human)?|question|prompt_user|request_user_input|user_input)$/i.test(
		toolName.trim(),
	);
}

function isNetworkDependencyCommand(command?: unknown): boolean {
	if (typeof command === 'string') {
		return NETWORK_DEPENDENCY_COMMAND_REGEX.test(command.trim());
	}
	if (command && typeof command === 'object') {
		const c =
			(command as Record<string, unknown>).command ??
			(command as Record<string, unknown>).cmd ??
			(command as Record<string, unknown>).input;
		if (typeof c === 'string') {
			return NETWORK_DEPENDENCY_COMMAND_REGEX.test(c.trim());
		}
	}
	return false;
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
 * Checks the unpacked update object first, then the root container.
 *
 * AC 5 & E-26: If token usage is absent, partial, or unparseable, missing fields
 * are set strictly to `null` so the UI displays "—". It NEVER fills `0`.
 */
export function extractGrokTokenUsage(data: unknown): GrokTokenUsage | null {
	if (!data || typeof data !== 'object') {
		return null;
	}

	const record = data as Record<string, unknown>;
	let target: Record<string, unknown> = record;

	if (record.params && typeof record.params === 'object') {
		const params = record.params as Record<string, unknown>;
		if (params.update && typeof params.update === 'object') {
			target = params.update as Record<string, unknown>;
		} else if (params.sessionUpdate && typeof params.sessionUpdate === 'object') {
			target = params.sessionUpdate as Record<string, unknown>;
		}
	} else if (record.update && typeof record.update === 'object') {
		target = record.update as Record<string, unknown>;
	} else if (record.sessionUpdate && typeof record.sessionUpdate === 'object') {
		target = record.sessionUpdate as Record<string, unknown>;
	}

	const usageObj = (target.usage ??
		target.token_usage ??
		target.tokens ??
		record.usage ??
		record.token_usage ??
		record.tokens) as Record<string, unknown> | undefined;

	const resolvedTarget = usageObj && typeof usageObj === 'object' ? usageObj : target;

	const rawInput =
		resolvedTarget.prompt_tokens ??
		resolvedTarget.input_tokens ??
		resolvedTarget.promptTokens ??
		resolvedTarget.inputTokens;
	const rawOutput =
		resolvedTarget.completion_tokens ??
		resolvedTarget.output_tokens ??
		resolvedTarget.completionTokens ??
		resolvedTarget.outputTokens;
	const rawTotal = resolvedTarget.total_tokens ?? resolvedTarget.totalTokens;

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
 * R2: Primary unpack path reads `params.update.sessionUpdate` and reads standardized ACP payload fields.
 * R3: Only produces ACP group events and `run.permission_blocked`. Never fakes runtime states or exit codes.
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
	// R2: Primary unwrapping path is ACP v1 session/update notification:
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

	// Discriminant field: primary ACP v1 is sessionUpdate on updateObj; flat type/kind as fallback (R2)
	const rawType =
		updateObj.sessionUpdate ??
		updateObj.type ??
		updateObj.kind ??
		data.sessionUpdate ??
		data.type ??
		data.kind;

	const eventType = typeof rawType === 'string' ? rawType.trim() : '';

	// R2: Unrecognized line after unpacking is counted on tracker, never silently dropped
	if (!eventType) {
		context?.tracker?.recordUnmapped('unknown', data);
		context?.onUnmapped?.('unknown', data);
		return Object.freeze({
			events: Object.freeze([]),
			unmappedCount: 1,
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

	// Token usage extracted from unpacked updateObj or data container
	const tokenUsage = extractGrokTokenUsage(updateObj) ?? extractGrokTokenUsage(data);
	const vendorWithToken = Object.freeze({
		...data,
		...(tokenUsage ? { tokenUsage } : {}),
	});

	switch (eventType) {
		// AC 1 & R2: ACP session updates reference implementation
		case 'agent_message_chunk': {
			// R2: read content.text; if content is string use directly
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

			envelopes.push({
				kind: 'agent_message_chunk',
				payload: {
					chunk,
					vendor: vendorWithToken,
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

			envelopes.push({
				kind: 'agent_thought_chunk',
				payload: {
					chunk,
					vendor: vendorWithToken,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'tool_call': {
			// R2: read toolCallId/title/rawInput/status
			const callId = String(
				updateObj.toolCallId ?? updateObj.callId ?? updateObj.tool_call_id ?? updateObj.id ?? '',
			);
			const tool = String(
				updateObj.title ?? updateObj.tool ?? updateObj.toolName ?? updateObj.name ?? '',
			);
			const input = updateObj.rawInput ?? updateObj.input ?? updateObj.args ?? updateObj.arguments;
			const status = updateObj.status;

			// E-134: agent 需要联网装依赖时归一化为阻断事件并带机器可读分类
			if (isNetworkDependencyCommand(input) || updateObj.blockedCategory === 'network_dependency') {
				envelopes.push({
					kind: 'run.permission_blocked',
					payload: {
						tool: tool || undefined,
						reason: 'Network dependency install blocked; human decision required',
						blockedCategory: 'network_dependency',
						vendor: vendorWithToken,
					},
					runId,
					taskId,
					actorDeviceId,
					scope: 'run',
				});
				break;
			}

			// E-115: 提问类工具标归一化字段 requiresReply / isQuestion
			const isQuestion =
				Boolean(updateObj.isQuestion || updateObj.requiresReply || updateObj.requiresHumanInput) ||
				isQuestionTool(tool);

			envelopes.push({
				kind: 'tool_call',
				payload: {
					callId: callId || undefined,
					tool: tool || undefined,
					input,
					status: status !== undefined ? status : undefined,
					...(isQuestion ? { requiresReply: true, isQuestion: true } : {}),
					vendor: vendorWithToken,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'tool_call_update': {
			// R2: read toolCallId/status/rawOutput
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
					vendor: vendorWithToken,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'plan': {
			// R2: read entries[].content/status/priority
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
					vendor: vendorWithToken,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'available_commands_update': {
			// R2: read availableCommands (fallback commands)
			const rawCommands = updateObj.availableCommands ?? updateObj.commands;
			const commands = Array.isArray(rawCommands) ? (rawCommands as readonly string[]) : [];

			envelopes.push({
				kind: 'available_commands_update',
				payload: {
					commands,
					vendor: vendorWithToken,
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
				typeof updateObj.tool === 'string'
					? updateObj.tool
					: typeof updateObj.toolName === 'string'
						? updateObj.toolName
						: typeof updateObj.title === 'string'
							? updateObj.title
							: undefined;
			const reason =
				typeof updateObj.reason === 'string'
					? updateObj.reason
					: typeof updateObj.message === 'string'
						? updateObj.message
						: undefined;
			const blockedCategory =
				typeof updateObj.blockedCategory === 'string'
					? updateObj.blockedCategory
					: typeof updateObj.category === 'string'
						? updateObj.category
						: 'permission_blocked';

			envelopes.push({
				kind: 'run.permission_blocked',
				payload: {
					tool,
					reason,
					blockedCategory,
					vendor: vendorWithToken,
				},
				runId,
				taskId,
				actorDeviceId,
				scope: 'run',
			});
			break;
		}

		case 'session/update':
			// Generic ACP container notification without child event does not emit envelope
			break;
	}

	return Object.freeze({
		events: Object.freeze(envelopes),
		unmappedCount: 0,
		rawLine,
	});
}

export { mapGrokEvents as mapEvents };
