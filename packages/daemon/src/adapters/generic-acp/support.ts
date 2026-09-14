export interface AgentAcpSupportCheck {
	readonly supported: boolean;
	readonly status: 'supported' | 'unsupported';
	readonly statusText?: string;
	readonly reason?: string;
}

export interface AgentAcpSupportCheckInput {
	readonly agentId: string;
	readonly isRegistered?: boolean;
	readonly hasAcpEntry?: boolean;
	readonly launchCommand?: string;
	readonly execPath?: string;
}

/**
 * Checks support for adding an external agent via Generic ACP (AC 7, E-187).
 * If the agent is neither registered nor provided with a valid ACP command / entry point,
 * it is unambiguously marked as "unsupported", with zero semi-available states.
 */
export function checkAgentAcpSupport(input: AgentAcpSupportCheckInput): AgentAcpSupportCheck {
	const hasCommand = Boolean(
		(input.launchCommand && input.launchCommand.trim().length > 0) ||
			(input.execPath && input.execPath.trim().length > 0),
	);
	const hasEntry = Boolean(input.hasAcpEntry || hasCommand);

	if (input.isRegistered || hasEntry) {
		return Object.freeze({
			supported: true,
			status: 'supported',
			statusText: 'supported',
		});
	}

	return Object.freeze({
		supported: false,
		status: 'unsupported', // E-187: explicitly unsupported, no semi-available state
		statusText: 'unsupported',
		reason: `Agent '${input.agentId}' is not registered and provides no ACP launch command or entry point.`,
	});
}
