/** One complete user turn, including embedded newlines, occupies one NDJSON line. */
export function encodeClaudeInput(text: string): string {
	return `${JSON.stringify({
		type: 'user',
		message: { role: 'user', content: [{ type: 'text', text }] },
	})}\n`;
}

/** Keep input open for replies until the dispatched turn finishes, including failed turns. */
export function isClaudeTurnComplete(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	const frame = value as Record<string, unknown>;
	return frame.type === 'result' && frame.parent_tool_use_id == null;
}
