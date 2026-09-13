export interface AgentAcpSupportCheck {
	readonly supported: boolean;
	readonly statusText: '支持' | '暂不支持';
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
 * it is unambiguously marked as "暂不支持" (not supported), with zero semi-available states.
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
			statusText: '支持',
		});
	}

	return Object.freeze({
		supported: false,
		statusText: '暂不支持', // E-187: 既不在注册表也无 ACP 入口的明确标「暂不支持」，不提供半可用状态
		reason: `Agent '${input.agentId}' is not registered and provides no ACP launch command or entry point.`,
	});
}
