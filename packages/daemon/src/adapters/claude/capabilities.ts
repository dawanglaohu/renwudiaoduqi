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
	/** True if the adapter emits run.model_rejected from structured vendor error fields (E-36). */
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
	reportsModelRejection: false,
});

export function getClaudeCapabilities(): ClaudeCapabilities {
	return CLAUDE_CAPABILITIES;
}

export { CLAUDE_CAPABILITIES as capabilities };
