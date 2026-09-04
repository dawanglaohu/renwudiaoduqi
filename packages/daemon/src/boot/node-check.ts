export const REQUIRED_NODE_MAJOR = 22;

export type NodeVersionCheckResult =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly currentVersion: string;
			readonly requiredMajor: number;
			readonly message: string;
	  };

export function checkNodeVersion(
	nodeVersion: string,
	requiredMajor = REQUIRED_NODE_MAJOR,
): NodeVersionCheckResult {
	const match = /^v?(\d+)/.exec(nodeVersion);
	const major = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
	if (Number.isInteger(major) && major >= requiredMajor) return { ok: true };
	return {
		ok: false,
		currentVersion: nodeVersion,
		requiredMajor,
		message: `agent-scheduler daemon requires Node.js >= ${requiredMajor}.0.0, current version is ${nodeVersion}. Upgrade Node.js and start again.`,
	};
}
