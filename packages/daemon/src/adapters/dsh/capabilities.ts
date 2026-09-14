import type { AdapterKind } from '../../config/defaults.ts';

export interface DshCapabilities {
	readonly canReply: boolean;
	readonly hasStreamingEvents: boolean;
	readonly canResume: boolean;
	readonly sessionHistory: 'current-run-only';
	readonly mode: 'headless';
	readonly outputMode: 'plain-text-final';
	readonly supportsReasoningEffort: boolean;
}

export const DSH_CAPABILITIES: DshCapabilities = Object.freeze({
	canReply: false,
	hasStreamingEvents: false, // AC 2, E-253: strictly false, UI disables step expansion
	canResume: false,
	sessionHistory: 'current-run-only', // AC 6, E-188: dsh has no session list, history from scheduler run records
	mode: 'headless',
	outputMode: 'plain-text-final', // R2 (c): output is terminal plain text, handled via plain-text streaming channel
	supportsReasoningEffort: false,
});

/**
 * Returns capability flags for DeepSeek Harness (dsh).
 * Headless mode has no streaming events (hasStreamingEvents=false) and does not support
 * session resumption or reply injection (canReply=false, canResume=false).
 */
export function getDshCapabilities(_adapterKind?: AdapterKind): DshCapabilities {
	return DSH_CAPABILITIES;
}

export const capabilities: DshCapabilities = DSH_CAPABILITIES;
export { getDshCapabilities as getCapabilities };
