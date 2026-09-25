export interface GrokCapabilities {
	readonly canReply: boolean;
	readonly supportsReply: boolean;
	readonly hasStreamingEvents: boolean;
	readonly supportsStreaming: boolean;
	readonly canResume: boolean;
	readonly supportsResume: boolean;
	readonly sessionHistory: 'external-cli';
	readonly outputFormat: 'streaming-json';
	readonly nativeAcp: boolean;
	readonly supportsReasoningEffort: boolean;
	readonly supportsWorktree: boolean;
	readonly permissionModes: readonly ['plan', 'acceptEdits', 'bypassPermissions'];
	readonly reportsModelRejection: boolean;
}

export const GROK_CAPABILITIES: GrokCapabilities = Object.freeze({
	canReply: false,
	supportsReply: false,
	hasStreamingEvents: true,
	supportsStreaming: true,
	canResume: true,
	supportsResume: true,
	sessionHistory: 'external-cli',
	outputFormat: 'streaming-json',
	nativeAcp: true,
	supportsReasoningEffort: true,
	supportsWorktree: true,
	permissionModes: Object.freeze(['plan', 'acceptEdits', 'bypassPermissions'] as const),
	reportsModelRejection: false,
});

export function getGrokCapabilities(): GrokCapabilities {
	return GROK_CAPABILITIES;
}

export const capabilities: GrokCapabilities = GROK_CAPABILITIES;
export { getGrokCapabilities as getCapabilities };
