export class NodeVersionError extends Error {
	readonly currentVersion: string;
	readonly requiredMajor: number;

	constructor(currentVersion: string, requiredMajor: number) {
		super(
			`agent-scheduler daemon requires Node.js >= ${requiredMajor}.0.0, current version is ${currentVersion}. Upgrade Node.js and start again.`,
		);
		this.name = 'NodeVersionError';
		this.currentVersion = currentVersion;
		this.requiredMajor = requiredMajor;
	}
}

export const REQUIRED_NODE_MAJOR = 22;

// E-139：低于声明的最低大版本时让调用方打印所需版本并退出，不静默降级或半残运行。
export function checkNodeVersion(
	nodeVersion: string,
	requiredMajor = REQUIRED_NODE_MAJOR,
): NodeVersionError | null {
	const match = /^v?(\d+)/.exec(nodeVersion);
	const major = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
	if (!Number.isInteger(major) || major < requiredMajor) {
		return new NodeVersionError(nodeVersion, requiredMajor);
	}
	return null;
}
