export interface ClaudeCapabilities {
	readonly canReply: boolean;
	readonly supportsReply: boolean;
	readonly hasStreamingEvents: boolean;
	readonly supportsStreaming: boolean;
	readonly supportsBackground: boolean;
	readonly inputFormat: 'stream-json';
	readonly outputFormat: 'stream-json';
	readonly sessionReadback: 'agents-json';
	readonly supportsReasoningEffort: boolean;
	readonly permissionModes: readonly ['plan', 'acceptEdits', 'bypassPermissions'];
	/**
	 * True if the adapter emits run.model_rejected from structured vendor error fields (E-36).
	 * Recorded with Claude Code 2.1.238 and 2.1.283: an unknown model yields a stream-json
	 * `assistant` frame whose top-level `error` is 'model_not_found' (HTTP 404), while an
	 * authentication failure yields 'authentication_failed' and an upstream 503 'server_error'.
	 * The '[claude-code:unrecognized_model]' stderr warning is text and is never read.
	 */
	readonly reportsModelRejection: boolean;
}

export const CLAUDE_CAPABILITIES: ClaudeCapabilities = Object.freeze({
	canReply: true,
	supportsReply: true,
	hasStreamingEvents: true,
	supportsStreaming: true,
	supportsBackground: true,
	inputFormat: 'stream-json',
	outputFormat: 'stream-json',
	sessionReadback: 'agents-json',
	supportsReasoningEffort: true,
	permissionModes: Object.freeze(['plan', 'acceptEdits', 'bypassPermissions'] as const),
	reportsModelRejection: true,
});

export function getClaudeCapabilities(): ClaudeCapabilities {
	return CLAUDE_CAPABILITIES;
}

export { CLAUDE_CAPABILITIES as capabilities };
