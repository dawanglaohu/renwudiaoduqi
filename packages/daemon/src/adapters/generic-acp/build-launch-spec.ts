import {
	ADAPTER_KINDS,
	DEFAULT_HARD_WALL_CLOCK_MS,
	DEFAULT_IDLE_TIMEOUT_MS,
	DEFAULT_STARTUP_TIMEOUT_MS,
} from '../../config/defaults.ts';
import type { LaunchSpec } from '../../proc/spawn.ts';

export interface BuildGenericAcpLaunchSpecOptions {
	readonly runId: string;
	readonly cwd: string;
	readonly command?: string;
	readonly execPath?: string;
	readonly args?: readonly string[];
	readonly customArgs?: readonly string[];
	readonly timeouts?: LaunchSpec['timeouts'];
	readonly envOverrides?: Readonly<Record<string, string | undefined>>;
	readonly envDenylist?: readonly string[];
	readonly label?: string;
	readonly windowsComSpecPath?: string;
}

/**
 * Builds the process launch specification for Generic ACP agents (6th agent and onwards).
 * Accepts an arbitrary startup command or binary and argument list.
 * Sets isAcp = true and uses generic-acp default startup timeout (180s for cold starts/npx).
 */
export function buildGenericAcpLaunchSpec(options: BuildGenericAcpLaunchSpecOptions): LaunchSpec {
	const rawCommand = options.command?.trim() || options.execPath?.trim() || '';
	if (rawCommand.length === 0) {
		throw new Error('Generic ACP launch specification requires a non-empty command or execPath.');
	}

	let file: string;
	const args: string[] = [];

	// If a command string with spaces was provided (e.g., "npx custom-acp-agent")
	// and no explicit args were passed, split the first token as the binary.
	if (options.args && options.args.length > 0) {
		file = rawCommand;
		args.push(...options.args);
	} else {
		const parts = rawCommand.split(/\s+/);
		file = parts[0] as string;
		if (parts.length > 1) {
			args.push(...parts.slice(1));
		}
	}

	if (options.customArgs && options.customArgs.length > 0) {
		for (const customArg of options.customArgs) {
			if (!args.includes(customArg)) {
				args.push(customArg);
			}
		}
	}

	const timeouts = options.timeouts ?? {
		startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS[ADAPTER_KINDS.GENERIC_ACP],
		idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
		hardWallClockMs: DEFAULT_HARD_WALL_CLOCK_MS,
	};

	return Object.freeze({
		runId: options.runId,
		file,
		args: Object.freeze(args),
		cwd: options.cwd,
		envOverrides: options.envOverrides,
		envDenylist: options.envDenylist,
		timeouts: Object.freeze(timeouts),
		label: options.label ?? 'generic-acp',
		isAcp: true,
		windowsComSpecPath: options.windowsComSpecPath,
	});
}

export { buildGenericAcpLaunchSpec as buildLaunchSpec };
