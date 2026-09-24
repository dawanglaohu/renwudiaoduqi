import { CONTENT_EVENT_KINDS, type ContentEventKind } from '@agent-scheduler/shared/api/events';

const CONTENT_EVENT_KINDS_SET: ReadonlySet<string> = new Set(CONTENT_EVENT_KINDS);

/**
 * Pure function determining whether an event kind constitutes content production (AC 7, E-348).
 *
 * Rules:
 * 1. Checks strictly against CONTENT_EVENT_KINDS ('agent_message_chunk', 'agent_thought_chunk', 'tool_call').
 * 2. Does not match stderr or stdout text.
 */
export function isContentEventKind(kind: string | null | undefined): kind is ContentEventKind {
	if (!kind) return false;
	return CONTENT_EVENT_KINDS_SET.has(kind);
}
