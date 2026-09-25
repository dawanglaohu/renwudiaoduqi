import type { AdapterKind } from '../../config/defaults.ts';

export interface CodexCapabilities {
	readonly canReply: boolean;
	readonly hasStreamingEvents: boolean;
	readonly canResume: boolean;
	readonly sessionHistory: 'full' | 'current-run-only';
	/** True if the adapter emits run.model_rejected from structured vendor error fields (E-36). */
	readonly reportsModelRejection: boolean;
}

export const CODEX_NATIVE_CAPABILITIES: CodexCapabilities = Object.freeze({
	canReply: true,
	hasStreamingEvents: true,
	canResume: true,
	sessionHistory: 'full',
	reportsModelRejection: false,
});

export const CODEX_GENERIC_ACP_CAPABILITIES: CodexCapabilities = Object.freeze({
	canReply: false,
	hasStreamingEvents: true,
	canResume: false,
	sessionHistory: 'current-run-only',
	reportsModelRejection: false,
});

/**
 * Returns capability flags for Codex based on the configured adapterKind.
 * Native adapter (app-server / queue) supports reply injection (codex queue --thread --message).
 * Switching adapterKind to 'generic-acp' narrows capabilities (canReply=false) so UI greys out buttons (E-186).
 */
export function getCodexCapabilities(adapterKind: AdapterKind = 'native'): CodexCapabilities {
	if (adapterKind === 'generic-acp') {
		return CODEX_GENERIC_ACP_CAPABILITIES;
	}
	return CODEX_NATIVE_CAPABILITIES;
}

export const capabilities: CodexCapabilities = CODEX_NATIVE_CAPABILITIES;
export { getCodexCapabilities as getCapabilities };
