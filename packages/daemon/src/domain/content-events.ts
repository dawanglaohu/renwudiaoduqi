/**
 * Content event kinds that represent substantive agent output (E-348).
 * Only agent_message_chunk, agent_thought_chunk, and tool_call count as content output.
 */
export const CONTENT_EVENT_KINDS = Object.freeze(
	new Set<string>(['agent_message_chunk', 'agent_thought_chunk', 'tool_call']),
);

export function isContentEventKind(kind: string): boolean {
	return CONTENT_EVENT_KINDS.has(kind);
}
