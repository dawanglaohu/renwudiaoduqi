export interface PiCapabilities {
	readonly canReply: boolean;
	readonly supportsReply: boolean;
	readonly hasStreamingEvents: boolean;
	readonly supportsStreaming: boolean;
	readonly mode: 'rpc';
	readonly inputFormat: 'rpc';
	readonly outputFormat: 'rpc';
	readonly supportedCommands: readonly ['prompt', 'steer', 'abort', 'get_state'];
	readonly completionEvent: 'agent_settled';
	readonly supportsReasoningEffort: boolean;
	readonly permissionModes: readonly ['readOnly', 'unrestricted'];
	readonly reportsModelRejection: boolean;
}

export const PI_CAPABILITIES: PiCapabilities = Object.freeze({
	canReply: true,
	supportsReply: true,
	hasStreamingEvents: true,
	supportsStreaming: true,
	mode: 'rpc',
	inputFormat: 'rpc',
	outputFormat: 'rpc',
	supportedCommands: Object.freeze(['prompt', 'steer', 'abort', 'get_state'] as const),
	completionEvent: 'agent_settled',
	supportsReasoningEffort: true,
	permissionModes: Object.freeze(['readOnly', 'unrestricted'] as const),
	reportsModelRejection: false,
});

export function getPiCapabilities(): PiCapabilities {
	return PI_CAPABILITIES;
}

export { PI_CAPABILITIES as capabilities };
