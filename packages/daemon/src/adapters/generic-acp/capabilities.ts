export interface GenericAcpCapabilities {
	readonly canReply: boolean;
	readonly hasStreamingEvents: boolean;
	readonly canResume: boolean;
	readonly sessionHistory: 'current-run-only';
	readonly isAcp: true;
	readonly supportsReasoningEffort: boolean;
	readonly reportsModelRejection: boolean;
}

export const GENERIC_ACP_CAPABILITIES: GenericAcpCapabilities = Object.freeze({
	canReply: false,
	hasStreamingEvents: true,
	canResume: false,
	sessionHistory: 'current-run-only', // AC 6, E-188: ACP v1 has no session list, history comes from scheduler
	isAcp: true,
	supportsReasoningEffort: false,
	reportsModelRejection: false,
});

/**
 * Returns capability flags for the Generic ACP adapter (E-187, E-188).
 * Generic ACP standardizes on ACP session/update streaming without session resumption or reply injection.
 */
export function getGenericAcpCapabilities(): GenericAcpCapabilities {
	return GENERIC_ACP_CAPABILITIES;
}

export const capabilities: GenericAcpCapabilities = GENERIC_ACP_CAPABILITIES;
export { getGenericAcpCapabilities as getCapabilities };
